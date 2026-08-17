import http from "node:http";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadConfig } from "./config.mjs";
import { authenticate, login, register } from "./auth.mjs";
import { filterScopedResponse, scopeVoipMsRequest } from "./scope.mjs";
import { VoipMsApi } from "./voipms.mjs";

const { Pool } = pg;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function sendJson(response, statusCode, body, origin, config) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  };
  if (origin && config.allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function requireProvisioned(identity) {
  if (identity.provisioning_status !== "active" || !identity.reseller_client_id) {
    const error = new Error("Your phone service account is awaiting provisioning.");
    error.statusCode = 409;
    throw error;
  }
}

async function ownedDids(pool, tenantId) {
  const result = await pool.query(
    "SELECT did FROM voipms_dids WHERE tenant_id = $1 AND status = 'active' ORDER BY did",
    [tenantId]
  );
  return result.rows.map((row) => row.did);
}

async function runScopedCall({ pool, voipMs, identity, method, params }) {
  requireProvisioned(identity);
  const dids = await ownedDids(pool, identity.tenant_id);
  const scoped = scopeVoipMsRequest({
    method,
    params,
    resellerClientId: identity.reseller_client_id,
    ownedDids: dids,
  });
  const payload = await voipMs.call({
    method: scoped.upstreamMethod,
    params: scoped.params,
    usePost: scoped.usePost,
  });
  return filterScopedResponse(method, payload, dids);
}

async function provisionTenant(pool, tenantId, body) {
  const resellerClientId = String(body.reseller_client_id || "").trim();
  if (!resellerClientId) {
    const error = new Error("reseller_client_id is required.");
    error.statusCode = 400;
    throw error;
  }
  const dids = [...new Set((body.dids || []).map((value) => String(value).replace(/\D/g, "")).filter(Boolean))];
  const subaccounts = Array.isArray(body.subaccounts) ? body.subaccounts : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = await client.query("SELECT 1 FROM tenants WHERE id = $1", [tenantId]);
    if (!tenant.rowCount) {
      const error = new Error("Tenant not found.");
      error.statusCode = 404;
      throw error;
    }
    await client.query(
      `INSERT INTO voipms_reseller_clients (tenant_id, reseller_client_id, provisioning_status, provisioned_at)
       VALUES ($1, $2, 'active', now())
       ON CONFLICT (tenant_id) DO UPDATE
         SET reseller_client_id = excluded.reseller_client_id,
             provisioning_status = 'active', provisioned_at = now(), updated_at = now()`,
      [tenantId, resellerClientId]
    );
    await client.query("DELETE FROM voipms_dids WHERE tenant_id = $1", [tenantId]);
    for (const did of dids) {
      await client.query(
        "INSERT INTO voipms_dids (tenant_id, did, status) VALUES ($1, $2, 'active')",
        [tenantId, did]
      );
    }
    await client.query("DELETE FROM voipms_subaccounts WHERE tenant_id = $1", [tenantId]);
    for (const item of subaccounts) {
      const name = String(item.account || item.subaccount || "").trim();
      if (name) {
        await client.query(
          "INSERT INTO voipms_subaccounts (tenant_id, subaccount, label, status) VALUES ($1, $2, $3, 'active')",
          [tenantId, name, String(item.label || "").trim()]
        );
      }
    }
    await client.query("COMMIT");
    return { tenant_id: tenantId, reseller_client_id: resellerClientId, dids, subaccounts };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createServer({ pool, voipMs, config }) {
  return http.createServer(async (request, response) => {
    const origin = String(request.headers.origin || "");
    try {
      if (request.method === "OPTIONS") {
        if (!origin || !config.allowedOrigins.has(origin)) return sendJson(response, 403, { error: "Origin rejected." }, origin, config);
        response.writeHead(204, {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
          "Access-Control-Max-Age": "600",
          Vary: "Origin",
        });
        return response.end();
      }
      if (origin && !config.allowedOrigins.has(origin)) {
        const error = new Error("Origin rejected.");
        error.statusCode = 403;
        throw error;
      }

      const url = new URL(request.url, config.publicUrl);
      if (request.method === "GET" && url.pathname === "/v1/status") {
        return sendJson(response, 200, { status: "ok", service: "voiceish-reseller-gateway", version: "0.4.0" }, origin, config);
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/register") {
        const result = await register(pool, await readJson(request));
        return sendJson(response, 201, result, origin, config);
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/login") {
        const result = await login(pool, await readJson(request));
        return sendJson(response, 200, result, origin, config);
      }
      if (request.method === "PUT" && /^\/v1\/admin\/tenants\/[^/]+\/voipms$/.test(url.pathname)) {
        if (request.headers.authorization !== `Bearer ${config.adminToken}`) {
          const error = new Error("Administrator authorization is required.");
          error.statusCode = 401;
          throw error;
        }
        const tenantId = url.pathname.split("/")[4];
        const result = await provisionTenant(pool, tenantId, await readJson(request));
        return sendJson(response, 200, result, origin, config);
      }

      const identity = await authenticate(pool, request.headers.authorization);
      if (request.method === "GET" && url.pathname === "/v1/me") {
        return sendJson(response, 200, {
          user: { id: identity.user_id, email: identity.email, display_name: identity.display_name },
          account: {
            id: identity.tenant_id,
            name: identity.tenant_name,
            role: identity.role,
            phone_service_status: identity.provisioning_status || "pending",
          },
        }, origin, config);
      }
      if (request.method === "POST" && url.pathname === "/v1/voipms") {
        const body = await readJson(request);
        const result = await runScopedCall({
          pool, voipMs, identity,
          method: String(body.method || ""),
          params: body.params || {},
        });
        return sendJson(response, 200, result, origin, config);
      }
      if (request.method === "GET" && url.pathname === "/v1/balance") {
        const result = await runScopedCall({ pool, voipMs, identity, method: "getResellerBalance", params: {} });
        return sendJson(response, 200, result, origin, config);
      }
      if (request.method === "GET" && url.pathname === "/v1/cdr") {
        const params = Object.fromEntries(url.searchParams);
        const result = await runScopedCall({ pool, voipMs, identity, method: "getResellerCDR", params });
        return sendJson(response, 200, result, origin, config);
      }
      return sendJson(response, 404, { error: "Not found." }, origin, config);
    } catch (error) {
      const statusCode = Number(error.statusCode) || 500;
      const message = statusCode >= 500 ? "The service could not complete the request." : error.message;
      if (statusCode >= 500) console.error(error);
      return sendJson(response, statusCode, { error: message }, origin, config);
    }
  });
}

async function main() {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const voipMs = new VoipMsApi(config.voipMs);
  await pool.query("SELECT 1");
  const server = createServer({ pool, voipMs, config });
  server.listen(config.port, config.host, () => {
    console.log(`Voice-ish reseller gateway listening at ${config.publicUrl}`);
  });
  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
