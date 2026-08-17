import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, storedConfigExists, writeStoredConfig } from "../src/config.mjs";
import { createInstallerServer, normalizeSetupInput, parseOrigins } from "../src/installer.mjs";

const validSetup = {
  databaseUrl: "postgres://voiceish:secret@127.0.0.1:5432/voiceish",
  publicUrl: "http://127.0.0.1:8790",
  listenPort: 8790,
  allowedOrigins: "http://127.0.0.1:8787\nhttps://voice.example",
  voipMsUsername: "reseller@example.com",
  voipMsPassword: "api-secret",
  voipMsApiUrl: "https://voip.ms/api/v1/rest.php",
  operatorName: "Operator",
  operatorEmail: "operator@example.com",
  operatorPassword: "long-test-password",
};

test("initializer normalizes the complete runtime boundary", () => {
  const result = normalizeSetupInput(validSetup);
  assert.equal(result.host, "127.0.0.1");
  assert.equal(result.publicUrl, "http://127.0.0.1:8790");
  assert.deepEqual(result.allowedOrigins, ["http://127.0.0.1:8787", "https://voice.example", "http://127.0.0.1:8790"]);
  assert.equal(result.operator.email, "operator@example.com");
});

test("remote browser origins and service addresses require HTTPS", () => {
  assert.throws(() => parseOrigins("http://voice.example"), /must use HTTPS/);
  assert.throws(() => normalizeSetupInput({ ...validSetup, publicUrl: "http://voice.example" }), /must use HTTPS/);
});

test("initializer will not transmit master credentials to a lookalike API host", () => {
  assert.throws(
    () => normalizeSetupInput({ ...validSetup, voipMsApiUrl: "https://voipms.example/api/v1/rest.php" }),
    /official voip\.ms API host/
  );
});

test("stored configuration is owner-readable and loads without exposing a mutable origin array", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voiceish-config-"));
  try {
    const raw = {
      schemaVersion: 1,
      databaseUrl: validSetup.databaseUrl,
      host: "127.0.0.1",
      port: 8790,
      publicUrl: validSetup.publicUrl,
      allowedOrigins: ["http://127.0.0.1:8787"],
      adminToken: "generated-internal-token-value",
      voipMs: { username: "reseller@example.com", password: "api-secret", baseUrl: validSetup.voipMsApiUrl },
    };
    await writeStoredConfig(raw, directory);
    assert.equal(storedConfigExists(directory), true);
    const stored = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8"));
    assert.equal(stored.adminToken, raw.adminToken);
    assert.deepEqual([...loadConfig({ directory }).allowedOrigins], raw.allowedOrigins);
    if (process.platform !== "win32") assert.equal((await stat(path.join(directory, "config.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer mutation endpoints reject requests without the one-time token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voiceish-installer-"));
  const server = createInstallerServer({ token: "one-time-token", directory });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/setup/test-database`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ databaseUrl: validSetup.databaseUrl }),
    });
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /authorization/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
