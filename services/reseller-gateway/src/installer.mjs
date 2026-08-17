import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "./auth.mjs";
import { stateDirectory, storedConfigExists, writeStoredConfig } from "./config.mjs";
import { VoipMsApi } from "./voipms.mjs";

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIRECTORY = path.resolve(SOURCE_DIRECTORY, "../setup");
const MIGRATION_DIRECTORY = path.resolve(SOURCE_DIRECTORY, "../db/migrations");
const MAX_BODY_BYTES = 256 * 1024;

function clean(value) {
  return String(value || "").trim();
}

function normalizedEmail(value) {
  const email = clean(value).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid operator email address.");
  return email;
}

function secureUrl(value, label, protocols = ["https:"]) {
  let url;
  try {
    url = new URL(clean(value));
  } catch {
    throw new Error(`${label} must be a complete URL.`);
  }
  if (!protocols.includes(url.protocol)) throw new Error(`${label} must use ${protocols.join(" or ")}.`);
  url.hash = "";
  url.search = "";
  return url;
}

function voipMsApiUrl(value) {
  const url = secureUrl(value || "https://voip.ms/api/v1/rest.php", "VoIP.ms API address");
  if (url.hostname !== "voip.ms" || !url.pathname.startsWith("/api/")) {
    throw new Error("VoIP.ms credentials may be sent only to the official voip.ms API host.");
  }
  return url;
}

export function parseOrigins(value) {
  const origins = String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const url = secureUrl(item, "Every application origin", ["https:", "http:"]);
      if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        throw new Error("Non-local application origins must use HTTPS.");
      }
      return url.origin;
    });
  return [...new Set(origins)];
}

function parseLines(value) {
  return [...new Set(String(value || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

export function normalizeSetupInput(body) {
  let database;
  try {
    database = new URL(clean(body.databaseUrl));
  } catch {
    throw new Error("Database address must be a complete PostgreSQL URL.");
  }
  if (!["postgres:", "postgresql:"].includes(database.protocol)) {
    throw new Error("Database address must use postgres:// or postgresql://.");
  }

  const listenPort = Number(body.listenPort || 8790);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error("Listen port must be between 1 and 65535.");
  }
  const publicUrl = secureUrl(body.publicUrl, "Public service address", ["https:", "http:"]);
  if (publicUrl.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(publicUrl.hostname)) {
    throw new Error("A non-local public service address must use HTTPS.");
  }
  const apiUrl = voipMsApiUrl(body.voipMsApiUrl);
  const operatorPassword = String(body.operatorPassword || "");
  if (operatorPassword.length < 12) throw new Error("Operator password must contain at least 12 characters.");
  const username = clean(body.voipMsUsername);
  const password = String(body.voipMsPassword || "");
  if (!username || !password) throw new Error("VoIP.ms API username and password are required.");

  const resellerClientId = clean(body.resellerClientId);
  const dids = parseLines(body.dids).map((value) => value.replace(/\D/g, "")).filter(Boolean);
  const subaccounts = parseLines(body.subaccounts).map((account) => ({ account, label: "" }));
  if ((dids.length || subaccounts.length) && !resellerClientId) {
    throw new Error("Enter the reseller-client ID before assigning numbers or phones.");
  }

  const allowedOrigins = parseOrigins(body.allowedOrigins);
  if (!allowedOrigins.includes(publicUrl.origin)) allowedOrigins.push(publicUrl.origin);
  return {
    databaseUrl: database.toString(),
    host: body.bindRemotely ? "0.0.0.0" : "127.0.0.1",
    port: listenPort,
    publicUrl: publicUrl.origin,
    allowedOrigins,
    operator: {
      email: normalizedEmail(body.operatorEmail),
      password: operatorPassword,
      displayName: clean(body.operatorName).slice(0, 120) || "Voice-ish operator",
    },
    voipMs: { username, password, baseUrl: apiUrl.toString() },
    firstClient: { resellerClientId, dids, subaccounts },
  };
}

export async function applyMigrations(pool, directory = MIGRATION_DIRECTORY) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  const { readdir } = await import("node:fs/promises");
  const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const sql = await readFile(path.join(directory, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const prior = await pool.query("SELECT checksum FROM schema_migrations WHERE name = $1", [name]);
    if (prior.rowCount) {
      if (prior.rows[0].checksum !== checksum) throw new Error(`Applied migration ${name} has changed.`);
      continue;
    }

    const existingSchema = name === "001_initial.sql"
      ? await pool.query("SELECT to_regclass('public.app_users') AS table_name")
      : { rows: [{ table_name: null }] };
    if (!existingSchema.rows[0]?.table_name) await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
  }
  return names;
}

async function testDatabase(databaseUrl) {
  const { default: pg } = await import("pg");
  const { Pool } = pg;
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 8000, max: 1 });
  try {
    const result = await pool.query("SELECT current_database() AS database, version() AS version");
    return { database: result.rows[0].database, version: String(result.rows[0].version).split(",")[0] };
  } finally {
    await pool.end();
  }
}

async function testVoipMs(voipMs) {
  const api = new VoipMsApi(voipMs);
  const result = await api.call({ method: "getBalance" });
  return { status: result.status, balance_available: result.balance !== undefined };
}

export async function completeInstallation(body, { directory = stateDirectory() } = {}) {
  if (storedConfigExists(directory)) {
    const error = new Error("Voice-ish has already been initialized.");
    error.statusCode = 409;
    throw error;
  }
  const setup = normalizeSetupInput(body);
  const [{ default: pg }, { provisionTenant }] = await Promise.all([import("pg"), import("./server.mjs")]);
  const { Pool } = pg;
  const pool = new Pool({ connectionString: setup.databaseUrl, connectionTimeoutMillis: 10000 });
  try {
    await pool.query("SELECT 1");
    await applyMigrations(pool);
    await testVoipMs(setup.voipMs);
    const registration = await register(pool, {
      email: setup.operator.email,
      password: setup.operator.password,
      displayName: setup.operator.displayName,
    });
    await pool.query("UPDATE app_users SET is_platform_admin = true WHERE id = $1", [registration.user_id]);
    if (setup.firstClient.resellerClientId) {
      await provisionTenant(pool, registration.tenant_id, {
        reseller_client_id: setup.firstClient.resellerClientId,
        dids: setup.firstClient.dids,
        subaccounts: setup.firstClient.subaccounts,
      });
    }
    const config = await writeStoredConfig({
      schemaVersion: 1,
      databaseUrl: setup.databaseUrl,
      host: setup.host,
      port: setup.port,
      publicUrl: setup.publicUrl,
      allowedOrigins: setup.allowedOrigins,
      adminToken: randomBytes(32).toString("base64url"),
      voipMs: setup.voipMs,
    }, directory);
    return {
      config,
      result: {
        service_url: config.publicUrl,
        operator_email: setup.operator.email,
        tenant_id: registration.tenant_id,
        phone_service_status: setup.firstClient.resellerClientId ? "active" : "pending",
      },
    };
  } finally {
    await pool.end();
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}

function securityHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(body));
}

function requireSetupToken(request, token) {
  if (request.headers["x-voiceish-setup-token"] !== token) {
    throw Object.assign(new Error("The installer authorization is missing or expired."), { statusCode: 401 });
  }
}

async function sendAsset(response, filename, contentType) {
  const content = await readFile(path.join(ASSET_DIRECTORY, filename));
  response.writeHead(200, securityHeaders(contentType));
  response.end(content);
}

export function createInstallerServer({ token, directory = stateDirectory(), onComplete = async () => {} }) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/setup") {
        response.writeHead(302, { Location: "/setup/", "Cache-Control": "no-store" });
        return response.end();
      }
      if (request.method === "GET" && url.pathname === "/setup/") return sendAsset(response, "index.html", "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/setup/app.js") return sendAsset(response, "app.js", "text/javascript; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/setup/style.css") return sendAsset(response, "style.css", "text/css; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/v1/setup/status") {
        return sendJson(response, 200, { initialized: storedConfigExists(directory), version: "0.5.0" });
      }

      if (request.method === "POST") requireSetupToken(request, token);
      if (request.method === "POST" && url.pathname === "/v1/setup/test-database") {
        const body = await readJson(request);
        const setup = normalizeSetupInput({
          ...body,
          publicUrl: body.publicUrl || "http://127.0.0.1:8790",
          operatorEmail: body.operatorEmail || "operator@example.invalid",
          operatorPassword: body.operatorPassword || "test-only-password",
          voipMsUsername: body.voipMsUsername || "test",
          voipMsPassword: body.voipMsPassword || "test",
        });
        return sendJson(response, 200, { ok: true, ...(await testDatabase(setup.databaseUrl)) });
      }
      if (request.method === "POST" && url.pathname === "/v1/setup/test-voipms") {
        const body = await readJson(request);
        const apiUrl = voipMsApiUrl(body.voipMsApiUrl);
        const voipMs = { username: clean(body.voipMsUsername), password: String(body.voipMsPassword || ""), baseUrl: apiUrl.toString() };
        if (!voipMs.username || !voipMs.password) throw new Error("Enter the VoIP.ms API username and password first.");
        return sendJson(response, 200, { ok: true, ...(await testVoipMs(voipMs)) });
      }
      if (request.method === "POST" && url.pathname === "/v1/setup/complete") {
        const completed = await completeInstallation(await readJson(request), { directory });
        sendJson(response, 201, { ok: true, ...completed.result });
        setTimeout(() => onComplete(completed.config), 400);
        return;
      }
      return sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      const status = Number(error.statusCode) || 400;
      if (status >= 500) console.error(error);
      return sendJson(response, status, { error: status >= 500 ? "The installer could not complete that operation." : error.message });
    }
  });
}

function openBrowser(url) {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export async function startInstaller({ directory = stateDirectory(), onComplete, open = true } = {}) {
  const token = randomBytes(32).toString("base64url");
  const port = Number(process.env.VOICEISH_SETUP_PORT || process.env.VOICEISH_PORT || 8790);
  let server;
  const transition = async (config) => {
    await new Promise((resolve) => server.close(resolve));
    await onComplete?.(config);
  };
  server = createInstallerServer({ token, directory, onComplete: transition });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${port}/setup/#token=${encodeURIComponent(token)}`;
  console.log(`Voice-ish initializer is ready at ${url}`);
  if (open) openBrowser(url);
  return { server, token, url };
}
