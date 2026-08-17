import assert from "node:assert/strict";
import test from "node:test";
import { scopeVoipMsRequest } from "../src/scope.mjs";
import { buildUpstreamFields } from "../src/voipms.mjs";

test("read calls are scoped to the signed-in reseller client", () => {
  const result = scopeVoipMsRequest({
    method: "getSMS", params: { from: "2026-08-01" },
    resellerClientId: "client-17", ownedDids: ["6135550100"],
  });
  assert.deepEqual(result.params, { from: "2026-08-01", client: "client-17" });
});

test("arbitrary VoIP.ms methods are rejected", () => {
  assert.throws(
    () => scopeVoipMsRequest({ method: "getBalance", resellerClientId: "client-17" }),
    /not available/
  );
});

test("a caller cannot replace the reseller client id", () => {
  assert.throws(
    () => scopeVoipMsRequest({
      method: "getSMS", params: { client: "someone-else" }, resellerClientId: "client-17",
    }),
    /reserved field: client/
  );
});

test("a caller cannot supply master API credentials", () => {
  assert.throws(
    () => scopeVoipMsRequest({
      method: "getSMS", params: { api_password: "stolen" }, resellerClientId: "client-17",
    }),
    /reserved field: api_password/
  );
});

test("a message cannot be sent from a DID outside the account", () => {
  assert.throws(
    () => scopeVoipMsRequest({
      method: "sendSMS", params: { did: "4165550199", dst: "6135550101", message: "hello" },
      resellerClientId: "client-17", ownedDids: ["6135550100"],
    }),
    /does not belong/
  );
});

test("an owned sending DID is accepted and still client-scoped", () => {
  const result = scopeVoipMsRequest({
    method: "sendMMS", params: { did: "+1 613 555 0100", dst: "6135550101", message: "hello" },
    resellerClientId: "client-17", ownedDids: ["6135550100"],
  });
  assert.equal(result.params.client, "client-17");
  assert.equal(result.usePost, true);
});

test("balance calls target the reseller client while master credentials are injected server-side", () => {
  const scoped = scopeVoipMsRequest({
    method: "getResellerBalance", params: {}, resellerClientId: "client-17",
  });
  const fields = buildUpstreamFields({
    username: "master@example.com", password: "master-secret",
    method: scoped.upstreamMethod, params: scoped.params,
  });
  assert.deepEqual(fields, {
    api_username: "master@example.com",
    api_password: "master-secret",
    method: "getResellerBalance",
    content_type: "json",
    client: "client-17",
  });
});
