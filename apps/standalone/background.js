/* Voice-ish Web for VoIP.ms — shared extension logic, dependency-free. */

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8790";
const MESSAGE_LIMIT = 2000;
const API_FETCH_LIMIT = "1000";
const DEFAULT_CONFIG = {
  email: "",
  serviceUrl: DEFAULT_SERVICE_URL,
  accessToken: "",
  dids: [],
  selectedDids: [],
  defaultDid: "",
  historyRange: "30",
  sendOnEnter: true,
  pollingEnabled: true,
  notificationsEnabled: true,
  toastEnabled: true,
  flashEnabled: true,
  soundEnabled: false,
  theme: "classic",
  configured: false,
};

const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
const storageSet = (value) => new Promise((resolve) => chrome.storage.local.set(value, resolve));
const storageRemove = (keys) => new Promise((resolve) => chrome.storage.local.remove(keys, resolve));

function cleanNumber(value) {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  return raw.startsWith("+") ? `+${digits}` : digits;
}

function canonicalNumber(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function apiPhoneNumber(value) {
  return canonicalNumber(value);
}

function threadKey(did, contact) {
  return `${canonicalNumber(did)}|${canonicalNumber(contact)}`;
}

function collection(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function statusIsEmpty(status) {
  return ["no_sms", "no_mms", "no_dids", "no_records", "no_results"].includes(String(status || ""));
}

function dateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function historyStart(range) {
  if (range === "all") return "2000-01-01";
  const days = Math.max(1, Number(range) || 30);
  const start = new Date();
  start.setDate(start.getDate() - days);
  return dateOnly(start);
}

async function getConfig() {
  const stored = await storageGet(["config"]);
  const config = { ...DEFAULT_CONFIG, ...(stored.config || {}) };
  if (config.username || config.apiPassword) {
    delete config.username;
    delete config.apiPassword;
    config.configured = false;
    config.dids = [];
    config.selectedDids = [];
    await storageSet({ config });
  }
  return config;
}

function normalizedServiceUrl(value) {
  const url = new URL(String(value || DEFAULT_SERVICE_URL).trim());
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Use an HTTPS Voice-ish service address (HTTP is allowed only for localhost).");
  }
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

async function serviceJson(serviceUrl, path, { accessToken = "", body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40_000);
  try {
    const response = await fetch(normalizedServiceUrl(serviceUrl) + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(accessToken ? { Authorization: "Bearer " + accessToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new Error("Voice-ish returned HTTP " + response.status + " with a non-JSON body."); }
    if (!response.ok) throw new Error(data.error || "Voice-ish request failed.");
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Voice-ish timed out while contacting the service.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function apiRequest(method, params = {}, sessionConfig = null) {
  const config = sessionConfig || (await getConfig());
  if (!config.accessToken) throw new Error("Sign in to Voice-ish first.");
  const data = await serviceJson(config.serviceUrl, "/v1/voipms", {
    accessToken: config.accessToken,
    body: { method, params },
  });
  if (data.status !== "success" && !statusIsEmpty(data.status)) {
    throw new Error(`VoIP.ms: ${String(data.status || "unknown_error").replaceAll("_", " ")}`);
  }
  return data;
}

async function discoverService(serviceUrl) {
  return serviceJson(serviceUrl, "/v1/status");
}

function normalizeDid(raw) {
  const did = cleanNumber(raw.did || raw.number || raw.phone_number || raw.phone || "");
  return {
    did,
    description: raw.description || raw.note || raw.label || raw.city || "",
    sms: raw.sms ?? raw.sms_enabled ?? raw.sms_available ?? raw.sms_service ?? null,
    raw,
  };
}

async function fetchDids(sessionConfig) {
  const data = await apiRequest("getDIDsInfo", {}, sessionConfig);
  const rawDids = collection(data.dids || data.did || data.numbers);
  return rawDids.map(normalizeDid).filter((entry) => entry.did);
}

function directionOf(value) {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "1" || normalized === "in" || normalized === "incoming" || normalized === "received"
    ? "in"
    : "out";
}

function mediaUrls(raw) {
  const candidates = [];
  if (Array.isArray(raw.media)) candidates.push(...raw.media);
  else if (raw.media && typeof raw.media === "object") candidates.push(...Object.values(raw.media));
  else if (typeof raw.media === "string") candidates.push(...raw.media.split(","));
  for (const key of ["media1", "media2", "media3", "col_media1", "col_media2", "col_media3"]) {
    if (raw[key]) candidates.push(raw[key]);
  }
  return [...new Set(candidates.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeMessage(raw, kind) {
  const id = String(raw.id ?? raw.sms ?? raw.mms ?? `${Date.now()}-${Math.random()}`);
  const did = cleanNumber(raw.did || raw.to || "");
  const contact = cleanNumber(raw.contact || raw.from || raw.dst || "");
  const direction = directionOf(raw.type ?? raw.direction);
  return {
    key: `${kind}:${id}`,
    serviceId: id,
    kind,
    did,
    contact,
    thread: threadKey(did, contact),
    direction,
    text: String(raw.message ?? raw.text ?? ""),
    date: String(raw.date ?? raw.datetime ?? new Date().toISOString()),
    carrierStatus: String(raw.carrier_status ?? raw.status_message ?? ""),
    media: mediaUrls(raw),
  };
}

async function fetchMmsMedia(message) {
  if (message.media.length || !message.serviceId) return message;
  try {
    const data = await apiRequest("getMediaMMS", { id: message.serviceId, media_as_array: 1 });
    return { ...message, media: mediaUrls(data) };
  } catch {
    return message;
  }
}

async function updateBadge(unreadByThread) {
  const total = Object.values(unreadByThread || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  await chrome.action.setBadgeBackgroundColor({ color: "#d1493f" });
  await chrome.action.setBadgeText({ text: total ? String(Math.min(total, 99)) : "" });
}

async function syncMessages({ notify = true } = {}) {
  const config = await getConfig();
  if (!config.configured || !config.selectedDids.length) return { ok: false, skipped: true };

  const now = new Date();
  const params = {
    from: historyStart(config.historyRange),
    to: dateOnly(now),
    limit: API_FETCH_LIMIT,
  };

  const [smsResult, mmsResult] = await Promise.allSettled([
    apiRequest("getSMS", params),
    apiRequest("getMMS", params),
  ]);

  if (smsResult.status === "rejected" && mmsResult.status === "rejected") {
    throw smsResult.reason;
  }

  const incoming = [];
  if (smsResult.status === "fulfilled") {
    const rows = collection(smsResult.value.sms || smsResult.value.messages);
    incoming.push(...rows.map((row) => normalizeMessage(row, "sms")));
  }
  if (mmsResult.status === "fulfilled") {
    const rows = collection(mmsResult.value.mms || mmsResult.value.sms || mmsResult.value.messages);
    incoming.push(...rows.map((row) => normalizeMessage(row, "mms")));
  }

  const selected = new Set(config.selectedDids.map(canonicalNumber));
  const filtered = incoming.filter((message) => selected.has(canonicalNumber(message.did)));
  const stored = await storageGet(["messages", "unreadByThread"]);
  const existing = collection(stored.messages);
  const existingByKey = new Map(existing.map((message) => [message.key, message]));
  const newMms = filtered
    .filter((message) => message.kind === "mms" && !message.media.length && !existingByKey.get(message.key)?.media?.length)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 24);
  const mediaByKey = new Map((await Promise.all(newMms.map(fetchMmsMedia))).map((message) => [message.key, message.media]));

  const unreadByThread = { ...(stored.unreadByThread || {}) };
  const genuinelyNew = [];
  for (const message of filtered) {
    const prior = existingByKey.get(message.key);
    if (prior?.media?.length && !message.media.length) message.media = prior.media;
    if (mediaByKey.has(message.key)) message.media = mediaByKey.get(message.key);
    if (!prior && message.direction === "in") {
      genuinelyNew.push(message);
      unreadByThread[message.thread] = (Number(unreadByThread[message.thread]) || 0) + 1;
    }
    existingByKey.set(message.key, { ...prior, ...message });
  }

  const messages = [...existingByKey.values()]
    .filter((message) => selected.has(canonicalNumber(message.did)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-MESSAGE_LIMIT);

  await storageSet({ messages, unreadByThread, lastSyncAt: new Date().toISOString(), lastSyncError: "" });
  await updateBadge(unreadByThread);

  if (notify && config.notificationsEnabled && genuinelyNew.length) {
    const newest = genuinelyNew.at(-1);
    const extra = genuinelyNew.length > 1 ? ` (+${genuinelyNew.length - 1} more)` : "";
    await chrome.notifications.create(`voipms-${newest.key}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `${newest.contact || "New message"} → ${newest.did}`,
      message: `${newest.text || "MMS attachment"}${extra}`.slice(0, 240),
    });
  }
  return { ok: true, count: messages.length, newCount: genuinelyNew.length };
}

async function addSentMessage({ did, contact, text, kind, serviceId, media }) {
  const stored = await storageGet(["messages"]);
  const key = `${kind}:${serviceId || `local-${Date.now()}`}`;
  const message = {
    key,
    serviceId: String(serviceId || ""),
    kind,
    did: cleanNumber(did),
    contact: cleanNumber(contact),
    thread: threadKey(did, contact),
    direction: "out",
    text,
    date: new Date().toISOString(),
    carrierStatus: "submitted",
    media: media || [],
  };
  const messages = [...collection(stored.messages).filter((item) => item.key !== key), message]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-MESSAGE_LIMIT);
  await storageSet({ messages });
  return message;
}

async function sendMessage(payload) {
  const config = await getConfig();
  const did = cleanNumber(payload.did);
  const contact = cleanNumber(payload.contact);
  const apiDid = apiPhoneNumber(did);
  const apiContact = apiPhoneNumber(contact);
  const text = String(payload.text || "").trim();
  const attachments = collection(payload.attachments).slice(0, 3);
  if (!config.selectedDids.map(canonicalNumber).includes(canonicalNumber(did))) {
    throw new Error("That sending DID is not enabled in this extension.");
  }
  if (!contact) throw new Error("Enter a destination number.");
  if (apiDid.length !== 10) throw new Error("The sending DID must be a 10-digit Canadian or US number.");
  if (apiContact.length !== 10) throw new Error("The destination must be a 10-digit Canadian or US number.");
  if (!text && !attachments.length) throw new Error("Write a message or attach media.");
  if (text.length > 2048) throw new Error("VoIP.ms MMS messages are limited to 2,048 characters.");

  const kind = attachments.length || text.length > 160 ? "mms" : "sms";
  let result;
  if (kind === "mms") {
    const params = { did: apiDid, dst: apiContact, message: text || " " };
    attachments.forEach((attachment, index) => {
      params[`media${index + 1}`] = attachment.dataUrl;
    });
    result = await apiRequest("sendMMS", params, null, true);
  } else {
    result = await apiRequest("sendSMS", { did: apiDid, dst: apiContact, message: text });
  }
  const serviceId = result[kind] || result.sms || result.mms || `local-${Date.now()}`;
  const message = await addSentMessage({
    did,
    contact,
    text,
    kind,
    serviceId,
    media: attachments.map((item) => item.dataUrl),
  });
  setTimeout(() => syncMessages({ notify: false }).catch(() => {}), 1500);
  return message;
}

async function publicState() {
  const stored = await storageGet(["messages", "unreadByThread", "lastSyncAt", "lastSyncError"]);
  const config = await getConfig();
  return {
    config: { ...config, accessToken: config.accessToken ? "••••••••" : "" },
    messages: collection(stored.messages),
    unreadByThread: stored.unreadByThread || {},
    lastSyncAt: stored.lastSyncAt || "",
    lastSyncError: stored.lastSyncError || "",
  };
}

async function markRead(key) {
  const stored = await storageGet(["unreadByThread"]);
  const unreadByThread = { ...(stored.unreadByThread || {}), [key]: 0 };
  await storageSet({ unreadByThread });
  await updateBadge(unreadByThread);
  return unreadByThread;
}

async function handleMessage(request) {
  switch (request.type) {
    case "GET_STATE":
      return publicState();
    case "GET_PUBLIC_IP": {
      const status = await discoverService(request.serviceUrl || (await getConfig()).serviceUrl);
      return { ip: status.status === "ok" ? "Online" : "Unavailable" };
    }
    case "CONNECT": {
      const email = String(request.email || "").trim().toLowerCase();
      const password = String(request.password || "");
      const serviceUrl = normalizedServiceUrl(request.serviceUrl);
      const mode = request.mode === "register" ? "register" : "login";
      if (!email || !password) throw new Error("Enter your Voice-ish email and password.");
      const auth = await serviceJson(serviceUrl, "/v1/auth/" + mode, { body: { email, password } });
      const sessionConfig = { ...DEFAULT_CONFIG, email, serviceUrl, accessToken: auth.access_token };
      const dids = await fetchDids(sessionConfig);
      if (!dids.length) throw new Error("Connected, but no DIDs were returned by the account.");
      const selectedDids = dids.map((entry) => entry.did);
      const config = {
        ...sessionConfig,
        dids,
        selectedDids,
        defaultDid: selectedDids[0],
        configured: true,
      };
      await storageSet({ config, messages: [], unreadByThread: {} });
      await syncMessages({ notify: false });
      return publicState();
    }
    case "SAVE_SETTINGS": {
      const config = await getConfig();
      const selectedDids = collection(request.selectedDids).map(cleanNumber).filter(Boolean);
      if (!selectedDids.length) throw new Error("Select at least one DID.");
      const defaultDid = selectedDids.includes(cleanNumber(request.defaultDid)) ? cleanNumber(request.defaultDid) : selectedDids[0];
      await storageSet({
        config: {
          ...config,
          selectedDids,
          defaultDid,
          historyRange: request.historyRange || "30",
          sendOnEnter: request.sendOnEnter !== false,
          pollingEnabled: request.pollingEnabled !== false,
          notificationsEnabled: request.notificationsEnabled !== false,
          toastEnabled: request.toastEnabled !== false,
          flashEnabled: request.flashEnabled !== false,
          soundEnabled: request.soundEnabled === true,
          theme: ["classic", "night", "contrast", "hyssopopotamus"].includes(request.theme) ? request.theme : "classic",
        },
      });
      await syncMessages({ notify: false });
      return publicState();
    }
    case "SYNC":
      await syncMessages({ notify: false });
      return publicState();
    case "SEND":
      return { message: await sendMessage(request) };
    case "MARK_READ":
      return { unreadByThread: await markRead(request.thread) };
    case "DISCONNECT":
      await storageRemove(["config", "messages", "unreadByThread", "lastSyncAt", "lastSyncError"]);
      await updateBadge({});
      return { ok: true };
    default:
      throw new Error("Unknown app request.");
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  handleMessage(request)
    .then((data) => sendResponse({ ok: true, data }))
    .catch(async (error) => {
      if (request.type === "SYNC") await storageSet({ lastSyncError: error.message || String(error) });
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create("voipms-poll", { periodInMinutes: 1 });
  const config = await getConfig();
  if (config.configured) syncMessages({ notify: false }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("voipms-poll", { periodInMinutes: 1 });
  syncMessages({ notify: false }).catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "voipms-poll") return;
  const config = await getConfig();
  if (config.configured && config.pollingEnabled) syncMessages({ notify: true }).catch(() => {});
});

chrome.notifications.onClicked.addListener(() => chrome.action.openPopup().catch(() => {}));
