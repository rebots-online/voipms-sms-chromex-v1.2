import { randomUUID } from "node:crypto";
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "./passwords.mjs";

const SESSION_DAYS = 30;

function normalizedEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  return email;
}

async function issueSession(client, userId) {
  const token = createSessionToken();
  await client.query(
    `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [randomUUID(), userId, hashSessionToken(token), SESSION_DAYS]
  );
  return token;
}

export async function register(pool, { email: rawEmail, password, displayName }) {
  const email = normalizedEmail(rawEmail);
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT 1 FROM app_users WHERE email = $1", [email]);
    if (existing.rowCount) {
      const error = new Error("An account already exists for that email address.");
      error.statusCode = 409;
      throw error;
    }
    const userId = randomUUID();
    const tenantId = randomUUID();
    const name = String(displayName || email.split("@")[0]).trim().slice(0, 120) || "Voice-ish account";
    await client.query(
      "INSERT INTO app_users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)",
      [userId, email, passwordHash, name]
    );
    await client.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [tenantId, name]);
    await client.query(
      "INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
      [tenantId, userId]
    );
    await client.query(
      "INSERT INTO voipms_reseller_clients (tenant_id, provisioning_status) VALUES ($1, 'pending')",
      [tenantId]
    );
    const token = await issueSession(client, userId);
    await client.query("COMMIT");
    return { access_token: token, token_type: "Bearer", expires_in: SESSION_DAYS * 86400, user_id: userId, tenant_id: tenantId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function login(pool, { email: rawEmail, password }) {
  const email = normalizedEmail(rawEmail);
  const result = await pool.query(
    "SELECT id, password_hash, disabled_at FROM app_users WHERE email = $1",
    [email]
  );
  const user = result.rows[0];
  if (!user || user.disabled_at || !(await verifyPassword(password, user.password_hash))) {
    const error = new Error("Email or password is incorrect.");
    error.statusCode = 401;
    throw error;
  }
  const client = await pool.connect();
  try {
    const token = await issueSession(client, user.id);
    return { access_token: token, token_type: "Bearer", expires_in: SESSION_DAYS * 86400 };
  } finally {
    client.release();
  }
}

export async function authenticate(pool, authorization) {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || ""));
  if (!match) {
    const error = new Error("Sign in is required.");
    error.statusCode = 401;
    throw error;
  }
  const result = await pool.query(
    `SELECT u.id AS user_id, u.email, u.display_name, u.is_platform_admin,
            m.tenant_id, m.role,
            t.name AS tenant_name, r.reseller_client_id, r.provisioning_status
       FROM auth_sessions s
       JOIN app_users u ON u.id = s.user_id
       JOIN LATERAL (
         SELECT tenant_id, role FROM tenant_memberships
          WHERE user_id = u.id ORDER BY created_at ASC LIMIT 1
       ) m ON true
       JOIN tenants t ON t.id = m.tenant_id
       LEFT JOIN voipms_reseller_clients r ON r.tenant_id = m.tenant_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.disabled_at IS NULL`,
    [hashSessionToken(match[1])]
  );
  if (!result.rowCount) {
    const error = new Error("The session is invalid or expired.");
    error.statusCode = 401;
    throw error;
  }
  return result.rows[0];
}
