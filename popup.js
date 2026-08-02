// VoIP.ms currently publishes 1,300 KB for MMS in general, while its API
// documentation describes a 1.2 MB per-file ceiling. 1,200,000 bytes stays
// beneath both interpretations and leaves a little transport headroom.
const MAX_ATTACHMENT_BYTES = 1_200_000;

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  "loadingView", "setupView", "messengerView", "publicIp", "retryIpButton", "connectForm", "usernameInput",
  "passwordInput", "connectButton", "setupError", "syncButton", "settingsButton", "newMessageButton", "threadList",
  "syncStatus", "emptyConversation", "conversationView", "contactHeading", "didHeading", "messageList", "composerForm",
  "attachmentTray", "attachmentInput", "messageInput", "sendButton", "messageMode", "sendKeyHint", "characterCount", "composerStatus", "newMessageModal",
  "newMessageForm", "newDidSelect", "newContactInput", "settingsModal", "settingsForm", "accountLabel", "didChecklist",
  "defaultDidSelect", "historyRangeSelect", "enterBehaviorSelect", "pollingCheckbox", "notificationsCheckbox", "disconnectButton", "settingsError", "toast"
].map((id) => [id, $(id)]));

let state = null;
let activeThread = "";
let activeRoute = null;
let draftAttachments = [];
let popupPoll = null;
let sending = false;

function sendRuntime(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("VoIP.ms did not answer within 45 seconds.")), 45_000);
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || "Extension request failed."));
      resolve(response.data);
    });
  });
}

function cleanNumber(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  return raw.startsWith("+") ? `+${digits}` : digits;
}

function canonicalNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}
function makeThreadKey(did, contact) { return `${canonicalNumber(did)}|${canonicalNumber(contact)}`; }

function formatPhone(value) {
  const raw = String(value || "");
  const digits = canonicalNumber(raw);
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return raw || "Unknown";
}

function initials(value) {
  const digits = canonicalNumber(value);
  return digits.slice(-2) || "?";
}

function showOnly(view) {
  for (const item of [ui.loadingView, ui.setupView, ui.messengerView]) item.classList.add("hidden");
  view.classList.remove("hidden");
}

function showError(element, message = "") {
  element.textContent = message;
  element.classList.toggle("hidden", !message);
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => ui.toast.classList.add("hidden"), 3200);
}

function showComposerStatus(message = "", { error = false } = {}) {
  ui.composerStatus.textContent = message;
  ui.composerStatus.classList.toggle("hidden", !message);
  ui.composerStatus.classList.toggle("error", Boolean(message) && error);
}

function makeDraftMessage(did, contact) {
  const thread = makeThreadKey(did, contact);
  return {
    key: `draft:${thread}`,
    serviceId: "",
    kind: "draft",
    did,
    contact,
    thread,
    direction: "out",
    text: "",
    date: new Date().toISOString(),
    carrierStatus: "",
    media: [],
    draftOnly: true,
  };
}

function ensureActiveConversation() {
  if (!state || !activeRoute || !activeThread) return;
  const exists = state.messages.some((message) =>
    (message.thread || makeThreadKey(message.did, message.contact)) === activeThread
  );
  if (!exists) state.messages.push(makeDraftMessage(activeRoute.did, activeRoute.contact));
}

function parseDate(value) {
  const raw = String(value || "");
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? raw.replace(" ", "T") : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function shortDate(value) {
  const date = parseDate(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function conversations() {
  const map = new Map();
  for (const message of state?.messages || []) {
    const thread = message.thread || makeThreadKey(message.did, message.contact);
    const current = map.get(thread) || { thread, did: message.did, contact: message.contact, messages: [] };
    current.messages.push(message);
    map.set(thread, current);
  }
  return [...map.values()].sort((a, b) => {
    const aDate = a.messages.at(-1)?.date || "";
    const bDate = b.messages.at(-1)?.date || "";
    return String(bDate).localeCompare(String(aDate));
  });
}

function renderThreads() {
  ui.threadList.replaceChildren();
  const rows = conversations();
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "sync-status";
    empty.textContent = "No messages in the selected history window.";
    ui.threadList.append(empty);
  }
  for (const conversation of rows) {
    const latest = conversation.messages.at(-1);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `thread-item${conversation.thread === activeThread ? " active" : ""}`;
    button.addEventListener("click", () => openThread(conversation.thread));

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = initials(conversation.contact);
    const copy = document.createElement("span");
    copy.className = "thread-copy";
    const contact = document.createElement("span");
    contact.className = "thread-contact";
    contact.textContent = formatPhone(conversation.contact);
    const preview = document.createElement("span");
    preview.className = "thread-preview";
    preview.textContent = latest.text || (latest.media?.length ? "MMS attachment" : "Message");
    const route = document.createElement("span");
    route.className = "thread-route";
    route.textContent = `via ${formatPhone(conversation.did)}`;
    copy.append(contact, preview, route);
    button.append(avatar, copy);

    const unread = Number(state.unreadByThread?.[conversation.thread] || 0);
    if (unread) {
      const pill = document.createElement("span");
      pill.className = "unread-pill";
      pill.textContent = unread > 99 ? "99+" : String(unread);
      button.append(pill);
    }
    ui.threadList.append(button);
  }
}

function safeMediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || (url.protocol === "data:" && /^(image|audio|video)\//.test(url.pathname))) return value;
  } catch {}
  return "";
}

function appendMedia(container, urls) {
  const wrapper = document.createElement("div");
  wrapper.className = "message-media";
  for (const rawUrl of urls || []) {
    const url = safeMediaUrl(rawUrl);
    if (!url) continue;
    const lower = url.toLowerCase();
    let element;
    if (/^data:image\//.test(lower) || /\.(png|jpe?g|gif|webp)(\?|$)/.test(lower)) {
      element = document.createElement("img");
      element.alt = "MMS image";
    } else if (/^data:audio\//.test(lower) || /\.(mp3|wav|m4a|ogg)(\?|$)/.test(lower)) {
      element = document.createElement("audio");
      element.controls = true;
    } else if (/^data:video\//.test(lower) || /\.(mp4|3gp|webm)(\?|$)/.test(lower)) {
      element = document.createElement("video");
      element.controls = true;
    } else {
      element = document.createElement("a");
      element.href = url;
      element.target = "_blank";
      element.rel = "noreferrer";
      element.textContent = "Open MMS attachment";
      wrapper.append(element);
      continue;
    }
    element.src = url;
    element.referrerPolicy = "no-referrer";
    wrapper.append(element);
  }
  if (wrapper.childElementCount) container.append(wrapper);
}

function renderMessages(conversation) {
  ui.messageList.replaceChildren();
  let previousDay = "";
  for (const message of conversation.messages) {
    if (message.draftOnly) continue;
    const date = parseDate(message.date);
    const day = date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    if (day !== previousDay) {
      const divider = document.createElement("div");
      divider.className = "day-divider";
      divider.textContent = day;
      ui.messageList.append(divider);
      previousDay = day;
    }
    const row = document.createElement("div");
    row.className = `message-row ${message.direction}`;
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    appendMedia(bubble, message.media);
    if (message.text) bubble.append(document.createTextNode(message.text));
    const time = document.createElement("span");
    time.className = "message-time";
    const status = message.direction === "out" && message.carrierStatus ? ` · ${message.carrierStatus}` : "";
    time.textContent = `${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${status}`;
    bubble.append(time);
    row.append(bubble);
    ui.messageList.append(row);
  }
  requestAnimationFrame(() => { ui.messageList.scrollTop = ui.messageList.scrollHeight; });
}

async function openThread(key) {
  activeThread = key;
  const conversation = conversations().find((item) => item.thread === key);
  if (!conversation) {
    showComposerStatus("That conversation route was lost. Reopen the conversation and try again.", { error: true });
    return false;
  }
  activeRoute = { did: conversation.did, contact: conversation.contact };
  ui.emptyConversation.classList.add("hidden");
  ui.conversationView.classList.remove("hidden");
  ui.contactHeading.textContent = formatPhone(conversation.contact);
  ui.didHeading.textContent = `FROM ${formatPhone(conversation.did)}`;
  renderThreads();
  renderMessages(conversation);
  state.unreadByThread[key] = 0;
  sendRuntime({ type: "MARK_READ", thread: key }).catch(() => {});
  updateComposerMode();
  ui.messageInput.focus();
  return true;
}

function renderStatus() {
  if (state.lastSyncError) {
    ui.syncStatus.textContent = state.lastSyncError;
    ui.syncStatus.style.color = "#a13c37";
    return;
  }
  ui.syncStatus.style.color = "";
  ui.syncStatus.textContent = state.lastSyncAt ? `Updated ${shortDate(state.lastSyncAt)}` : "Not synced yet";
}

function renderMessenger() {
  showOnly(ui.messengerView);
  ensureActiveConversation();
  renderThreads();
  renderStatus();
  populateDidSelects();
  if (activeThread && conversations().some((item) => item.thread === activeThread)) {
    openThread(activeThread);
  } else if (!activeThread) {
    activeRoute = null;
    ui.conversationView.classList.add("hidden");
    ui.emptyConversation.classList.remove("hidden");
  }
}

function didLabel(did) {
  const record = state.config.dids.find((item) => canonicalNumber(item.did) === canonicalNumber(did));
  return `${formatPhone(did)}${record?.description ? ` — ${record.description}` : ""}`;
}

function populateDidSelects() {
  for (const select of [ui.newDidSelect, ui.defaultDidSelect]) select.replaceChildren();
  for (const did of state.config.selectedDids) {
    for (const select of [ui.newDidSelect, ui.defaultDidSelect]) {
      const option = document.createElement("option");
      option.value = did;
      option.textContent = didLabel(did);
      select.append(option);
    }
  }
  ui.newDidSelect.value = state.config.defaultDid;
  ui.defaultDidSelect.value = state.config.defaultDid;
}

function renderSettings() {
  ui.accountLabel.textContent = state.config.username;
  ui.didChecklist.replaceChildren();
  for (const entry of state.config.dids) {
    const label = document.createElement("label");
    label.className = "did-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = entry.did;
    checkbox.checked = state.config.selectedDids.some((did) => canonicalNumber(did) === canonicalNumber(entry.did));
    checkbox.addEventListener("change", rebuildDefaultDidOptions);
    const number = document.createElement("span");
    number.textContent = formatPhone(entry.did);
    const description = document.createElement("small");
    description.textContent = entry.description || (entry.sms === null ? "" : `SMS ${String(entry.sms) === "1" ? "enabled" : entry.sms}`);
    label.append(checkbox, number, description);
    ui.didChecklist.append(label);
  }
  ui.historyRangeSelect.value = state.config.historyRange;
  ui.enterBehaviorSelect.value = state.config.sendOnEnter === false ? "newline" : "send";
  ui.pollingCheckbox.checked = state.config.pollingEnabled;
  ui.notificationsCheckbox.checked = state.config.notificationsEnabled;
  rebuildDefaultDidOptions();
  ui.defaultDidSelect.value = state.config.defaultDid;
  showError(ui.settingsError);
}

function rebuildDefaultDidOptions() {
  const checked = [...ui.didChecklist.querySelectorAll("input:checked")].map((item) => item.value);
  const previous = ui.defaultDidSelect.value;
  ui.defaultDidSelect.replaceChildren();
  for (const did of checked) {
    const option = document.createElement("option");
    option.value = did;
    option.textContent = didLabel(did);
    ui.defaultDidSelect.append(option);
  }
  if (checked.includes(previous)) ui.defaultDidSelect.value = previous;
}

function updateComposerMode() {
  const length = ui.messageInput.value.length;
  const isMms = draftAttachments.length > 0 || length > 160;
  ui.messageMode.textContent = isMms ? "MMS" : "SMS";
  ui.characterCount.textContent = `${length} / ${isMms ? "2048" : "160"}`;
  ui.sendKeyHint.textContent = state?.config?.sendOnEnter === false ? "Ctrl/⌘+Enter to send" : "Enter to send";
  ui.messageInput.style.height = "auto";
  ui.messageInput.style.height = `${Math.min(ui.messageInput.scrollHeight, 96)}px`;
}

function renderAttachments() {
  ui.attachmentTray.replaceChildren();
  for (const [index, file] of draftAttachments.entries()) {
    const item = document.createElement("div");
    item.className = "attachment-item";
    const name = document.createElement("span");
    name.textContent = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      draftAttachments.splice(index, 1);
      renderAttachments();
      updateComposerMode();
    });
    item.append(name, remove);
    ui.attachmentTray.append(item);
  }
  ui.attachmentTray.classList.toggle("hidden", !draftAttachments.length);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read attachment."));
    reader.readAsDataURL(file);
  });
}

function fileExtension(file) {
  return String(file.name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
}

function isDirectlyAllowedMedia(file) {
  return ["jpg", "jpeg", "gif", "png", "mp3", "wav", "mid", "midi", "mp4", "3gp"].includes(fileExtension(file));
}

function looksLikeUnsupportedVideo(file) {
  return file.type.startsWith("video/") || ["mov", "m4v", "webm", "mkv", "avi", "mpeg", "mpg"].includes(fileExtension(file));
}

async function addAttachments(files) {
  for (const file of [...files]) {
    if (draftAttachments.length >= 3) { toast("VoIP.ms supports up to 3 MMS attachments."); break; }
    if (!isDirectlyAllowedMedia(file)) {
      const guidance = looksLikeUnsupportedVideo(file)
        ? "This build does not convert video; pre-encode it as MP4 or 3GP under 1,200,000 bytes."
        : "VoIP.ms accepts JPG, GIF, PNG, MP3, WAV, MIDI, MP4, or 3GP attachments.";
      toast(`${file.name}: ${guidance}`);
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      const guidance = ["mp4", "3gp"].includes(fileExtension(file))
        ? "Pre-compress or trim it before attaching; this build intentionally contains no transcoder."
        : "Compress it below 1,200,000 bytes before attaching.";
      toast(`${file.name} is too large. ${guidance}`);
      continue;
    }
    draftAttachments.push({ name: file.name, type: file.type, size: file.size, dataUrl: await fileToDataUrl(file) });
  }
  ui.attachmentInput.value = "";
  renderAttachments();
  updateComposerMode();
}

async function refresh({ quiet = false } = {}) {
  if (!quiet) ui.syncButton.classList.add("syncing");
  try {
    const localDrafts = (state?.messages || []).filter((message) => message.draftOnly);
    const nextState = await sendRuntime({ type: "SYNC" });
    for (const draft of localDrafts) {
      const thread = draft.thread || makeThreadKey(draft.did, draft.contact);
      if (!nextState.messages.some((message) => (message.thread || makeThreadKey(message.did, message.contact)) === thread)) {
        nextState.messages.push(draft);
      }
    }
    state = nextState;
    renderMessenger();
  } catch (error) {
    if (!quiet) toast(error.message);
  } finally {
    ui.syncButton.classList.remove("syncing");
  }
}

async function lookupIp() {
  ui.publicIp.textContent = "Checking…";
  try {
    const result = await sendRuntime({ type: "GET_PUBLIC_IP" });
    ui.publicIp.textContent = result.ip;
  } catch {
    ui.publicIp.textContent = "Could not detect";
  }
}

ui.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(ui.setupError);
  ui.connectButton.disabled = true;
  ui.connectButton.textContent = "Connecting…";
  try {
    state = await sendRuntime({
      type: "CONNECT",
      username: ui.usernameInput.value,
      apiPassword: ui.passwordInput.value,
    });
    ui.passwordInput.value = "";
    renderMessenger();
  } catch (error) {
    showError(ui.setupError, `${error.message}. Confirm API access is enabled and ${ui.publicIp.textContent} is allow-listed.`);
  } finally {
    ui.connectButton.disabled = false;
    ui.connectButton.textContent = "Connect to VoIP.ms";
  }
});

ui.retryIpButton.addEventListener("click", lookupIp);
ui.syncButton.addEventListener("click", () => refresh());
ui.settingsButton.addEventListener("click", () => { renderSettings(); ui.settingsModal.classList.remove("hidden"); });
ui.newMessageButton.addEventListener("click", () => {
  populateDidSelects();
  ui.newContactInput.value = "";
  ui.newMessageModal.classList.remove("hidden");
  ui.newContactInput.focus();
});

document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => {
  ui[button.dataset.close === "new" ? "newMessageModal" : "settingsModal"].classList.add("hidden");
}));

ui.newMessageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const did = cleanNumber(ui.newDidSelect.value);
  const contact = cleanNumber(ui.newContactInput.value);
  if (!contact) return;
  const key = makeThreadKey(did, contact);
  if (!state.messages.some((message) => (message.thread || makeThreadKey(message.did, message.contact)) === key)) {
    state.messages.push(makeDraftMessage(did, contact));
  }
  activeRoute = { did, contact };
  ui.newMessageModal.classList.add("hidden");
  await openThread(key);
});

ui.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(ui.settingsError);
  const selectedDids = [...ui.didChecklist.querySelectorAll("input:checked")].map((item) => item.value);
  try {
    state = await sendRuntime({
      type: "SAVE_SETTINGS",
      selectedDids,
      defaultDid: ui.defaultDidSelect.value,
      historyRange: ui.historyRangeSelect.value,
      sendOnEnter: ui.enterBehaviorSelect.value !== "newline",
      pollingEnabled: ui.pollingCheckbox.checked,
      notificationsEnabled: ui.notificationsCheckbox.checked,
    });
    ui.settingsModal.classList.add("hidden");
    if (!state.messages.some((message) => message.thread === activeThread) && !activeRoute) activeThread = "";
    renderMessenger();
    toast("Settings saved.");
  } catch (error) {
    showError(ui.settingsError, error.message);
  }
});

ui.disconnectButton.addEventListener("click", async () => {
  if (!confirm("Erase the stored API credentials and local message cache?")) return;
  await sendRuntime({ type: "DISCONNECT" });
  state = null;
  activeThread = "";
  activeRoute = null;
  ui.settingsModal.classList.add("hidden");
  showOnly(ui.setupView);
  lookupIp();
});

ui.messageInput.addEventListener("input", updateComposerMode);
ui.messageInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  const sendOnEnter = state?.config?.sendOnEnter !== false;
  const shouldSend = sendOnEnter
    ? !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    : (event.ctrlKey || event.metaKey) && !event.shiftKey;
  if (shouldSend) {
    event.preventDefault();
    ui.composerForm.requestSubmit();
  }
});
ui.attachmentInput.addEventListener("change", () => addAttachments(ui.attachmentInput.files).catch((error) => toast(error.message)));

async function submitActiveMessage() {
  if (sending) return;
  showComposerStatus();
  ensureActiveConversation();
  const conversation = conversations().find((item) => item.thread === activeThread);
  const route = activeRoute || (conversation ? { did: conversation.did, contact: conversation.contact } : null);
  if (!route) {
    showComposerStatus("No sending route is selected. Reopen the conversation and try again.", { error: true });
    return;
  }
  const text = ui.messageInput.value.trim();
  if (!text && !draftAttachments.length) {
    showComposerStatus("Write a message or attach media before sending.", { error: true });
    return;
  }
  sending = true;
  ui.sendButton.disabled = true;
  ui.sendButton.textContent = "…";
  showComposerStatus(`Sending from ${formatPhone(route.did)}…`);
  try {
    const result = await sendRuntime({
      type: "SEND",
      did: route.did,
      contact: route.contact,
      text,
      attachments: draftAttachments,
    });
    state.messages = state.messages.filter((message) => !(message.draftOnly && message.thread === activeThread));
    state.messages.push(result.message);
    ui.messageInput.value = "";
    draftAttachments = [];
    renderAttachments();
    updateComposerMode();
    renderMessenger();
    await openThread(activeThread);
    showComposerStatus("Sent.");
  } catch (error) {
    showComposerStatus(error.message, { error: true });
    toast(error.message);
  } finally {
    sending = false;
    ui.sendButton.disabled = false;
    ui.sendButton.textContent = "➤";
  }
}

ui.composerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitActiveMessage();
});

async function init() {
  try {
    state = await sendRuntime({ type: "GET_STATE" });
    if (state.config.configured) {
      renderMessenger();
      popupPoll = setInterval(() => refresh({ quiet: true }), 15000);
    } else {
      showOnly(ui.setupView);
      lookupIp();
    }
  } catch (error) {
    showOnly(ui.setupView);
    showError(ui.setupError, error.message);
    lookupIp();
  }
}

window.addEventListener("unload", () => { if (popupPoll) clearInterval(popupPoll); });
init();
