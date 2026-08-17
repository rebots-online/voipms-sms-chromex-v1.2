import { readFileSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";

function requireValue(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Missing required configuration value: ${name}`);
  return normalized;
}

export function stateDirectory() {
  return path.resolve(process.env.VOICEISH_STATE_DIR || path.join(process.cwd(), ".voiceish"));
}

export function storedConfigPath(directory = stateDirectory()) {
  return path.join(directory, "config.json");
}

export function storedConfigExists(directory = stateDirectory()) {
  try {
    readFileSync(storedConfigPath(directory));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function normalizeConfig(raw) {
  const port = Number(raw.port || 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("VOICEISH_PORT must be a valid TCP port.");
  const allowedOrigins = Array.isArray(raw.allowedOrigins)
    ? raw.allowedOrigins
    : String(raw.allowedOrigins || "").split(",");
  return {
    schemaVersion: Number(raw.schemaVersion || 1),
    databaseUrl: requireValue(raw.databaseUrl, "databaseUrl"),
    host: String(raw.host || "127.0.0.1"),
    port,
    publicUrl: String(raw.publicUrl || `http://127.0.0.1:${port}`).replace(/\/+$/, ""),
    allowedOrigins: new Set(allowedOrigins.map((value) => String(value).trim().replace(/\/+$/, "")).filter(Boolean)),
    adminToken: requireValue(raw.adminToken, "adminToken"),
    voipMs: {
      username: requireValue(raw.voipMs?.username, "voipMs.username"),
      password: requireValue(raw.voipMs?.password, "voipMs.password"),
      baseUrl: String(raw.voipMs?.baseUrl || "https://voip.ms/api/v1/rest.php"),
    },
  };
}

function environmentConfig() {
  if (!process.env.DATABASE_URL) return null;
  return {
    schemaVersion: 1,
    databaseUrl: process.env.DATABASE_URL,
    host: process.env.VOICEISH_HOST || "127.0.0.1",
    port: Number(process.env.VOICEISH_PORT || 8790),
    publicUrl: process.env.VOICEISH_PUBLIC_URL || "http://127.0.0.1:8790",
    allowedOrigins: String(process.env.VOICEISH_ALLOWED_ORIGINS || "").split(","),
    adminToken: process.env.VOICEISH_ADMIN_TOKEN,
    voipMs: {
      username: process.env.VOIPMS_API_USERNAME,
      password: process.env.VOIPMS_API_PASSWORD,
      baseUrl: process.env.VOIPMS_API_URL || "https://voip.ms/api/v1/rest.php",
    },
  };
}

export function loadConfig({ directory = stateDirectory() } = {}) {
  const fromEnvironment = environmentConfig();
  if (fromEnvironment) return normalizeConfig(fromEnvironment);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(storedConfigPath(directory), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Voice-ish has not been initialized. Run the installer first.");
    }
    throw error;
  }
  return normalizeConfig(parsed);
}

export async function writeStoredConfig(raw, directory = stateDirectory()) {
  const normalized = normalizeConfig(raw);
  const serializable = {
    ...normalized,
    allowedOrigins: [...normalized.allowedOrigins],
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = storedConfigPath(directory);
  const temporary = `${destination}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(serializable, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  return normalized;
}
