const RESERVED_FIELDS = new Set([
  "api_username",
  "api_password",
  "client",
  "reseller_client",
  "reseller_client_id",
  "method",
  "content_type",
]);

const METHOD_POLICY = Object.freeze({
  getDIDsInfo: {},
  getSMS: {},
  getMMS: {},
  getMediaMMS: {},
  sendSMS: { requiresOwnedDid: true },
  sendMMS: { requiresOwnedDid: true, usePost: true },
  getSubAccounts: {},
  getResellerBalance: {},
  getResellerCDR: {},
  getCDR: { upstreamMethod: "getResellerCDR" },
});

export class ScopeError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "ScopeError";
    this.statusCode = statusCode;
  }
}

export function canonicalDid(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function ownedDidSet(values) {
  return new Set((values || []).map(canonicalDid).filter(Boolean));
}

export function scopeVoipMsRequest({ method, params = {}, resellerClientId, ownedDids = [] }) {
  const policy = METHOD_POLICY[method];
  if (!policy) throw new ScopeError("That VoIP.ms operation is not available to reseller clients.", 403);
  if (!resellerClientId) throw new ScopeError("Phone service has not been provisioned for this account.", 409);
  if (!params || Array.isArray(params) || typeof params !== "object") {
    throw new ScopeError("Request parameters must be an object.");
  }

  for (const key of Object.keys(params)) {
    if (RESERVED_FIELDS.has(key)) {
      throw new ScopeError(`The caller cannot supply reserved field: ${key}.`, 403);
    }
  }

  if (policy.requiresOwnedDid) {
    const requestedDid = canonicalDid(params.did);
    if (!requestedDid || !ownedDidSet(ownedDids).has(requestedDid)) {
      throw new ScopeError("That sending phone number does not belong to this account.", 403);
    }
  }

  return {
    upstreamMethod: policy.upstreamMethod || method,
    params: { ...params, client: String(resellerClientId) },
    usePost: policy.usePost === true,
  };
}

function filterCollection(value, allowed) {
  if (Array.isArray(value)) return value.filter((row) => allowed.has(canonicalDid(row?.did || row?.number)));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, row]) => allowed.has(canonicalDid(row?.did || row?.number)))
  );
}

export function filterScopedResponse(method, payload, ownedDids = []) {
  if (!payload || typeof payload !== "object") return payload;
  const allowed = ownedDidSet(ownedDids);

  const keysByMethod = {
    getDIDsInfo: ["dids", "did", "numbers"],
    getSMS: ["sms", "messages"],
    getMMS: ["mms", "sms", "messages"],
    getResellerCDR: ["cdr", "calls", "records"],
    getCDR: ["cdr", "calls", "records"],
  };
  const keys = keysByMethod[method] || [];
  const filtered = { ...payload };
  for (const key of keys) {
    if (key in filtered) filtered[key] = filterCollection(filtered[key], allowed);
  }
  return filtered;
}

export const allowedVoipMsMethods = Object.freeze(Object.keys(METHOD_POLICY));
