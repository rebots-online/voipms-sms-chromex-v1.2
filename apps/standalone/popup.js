// VoIP.ms currently publishes 1,300 KB for MMS in general, while its API
// documentation describes a 1.2 MB per-file ceiling. 1,200,000 bytes stays
// beneath both interpretations and leaves a little transport headroom.
const MAX_ATTACHMENT_BYTES = 1_200_000;
const VOXVOLLEY_MAX_SECONDS = 20;
const VOXVOLLEY_SAMPLE_RATE = 16_000;

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  "loadingView", "setupView", "messengerView", "publicIp", "retryIpButton", "connectForm", "serviceUrlInput", "usernameInput",
  "passwordInput", "connectButton", "createAccountButton", "setupError", "notificationBell", "bellBadge", "syncButton", "settingsButton", "newMessageButton", "threadList",
  "syncStatus", "emptyConversation", "conversationView", "contactHeading", "didHeading", "messageList", "composerForm",
  "attachmentTray", "attachmentInput", "voiceRecordingStatus", "voiceRecordingTime", "voiceRecordingProgress", "voiceRecordButton", "cancelVoiceButton",
  "messageInput", "sendButton", "messageMode", "sendKeyHint", "characterCount", "composerStatus", "newMessageModal",
  "newMessageForm", "newDidSelect", "newContactInput", "settingsModal", "settingsForm", "accountLabel", "didChecklist",
  "defaultDidSelect", "historyRangeSelect", "enterBehaviorSelect", "themeSelect", "pollingCheckbox", "notificationsCheckbox",
  "toastCheckbox", "flashCheckbox", "soundCheckbox", "disconnectButton", "settingsError", "toast"
].map((id) => [id, $(id)]));

let state = null;
let activeThread = "";
let activeRoute = null;
let draftAttachments = [];
let popupPoll = null;
let sending = false;
let voiceRecorder = null;
let voiceTimer = null;
let speakingButton = null;

function sendRuntime(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("VoIP.ms did not answer within 45 seconds.")), 45_000);
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || "Application request failed."));
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

function applyTheme(theme = "classic") {
  const allowed = ["classic", "night", "contrast", "hyssopopotamus"];
  document.documentElement.dataset.theme = allowed.includes(theme) ? theme : "classic";
}

function unreadTotal() {
  return Object.values(state?.unreadByThread || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function renderBell() {
  const total = unreadTotal();
  ui.bellBadge.textContent = total > 99 ? "99+" : String(total);
  ui.bellBadge.classList.toggle("hidden", !total);
  ui.notificationBell.classList.toggle("has-unread", Boolean(total));
  ui.notificationBell.setAttribute("aria-label", total ? `${total} unread message${total === 1 ? "" : "s"}` : "No unread messages");
}

function playNotificationChime() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, context.currentTime);
    oscillator.frequency.setValueAtTime(880, context.currentTime + 0.1);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.23);
    oscillator.addEventListener("ended", () => context.close().catch(() => {}), { once: true });
  } catch {}
}

function announceNewMessages(messages) {
  if (!messages.length) return;
  const newest = messages.at(-1);
  if (state.config.toastEnabled !== false) {
    const extra = messages.length > 1 ? ` (+${messages.length - 1} more)` : "";
    toast(`New from ${formatPhone(newest.contact)}: ${newest.text || "MMS attachment"}${extra}`);
  }
  if (state.config.flashEnabled !== false) {
    ui.notificationBell.classList.remove("arrival-flash");
    requestAnimationFrame(() => ui.notificationBell.classList.add("arrival-flash"));
    setTimeout(() => ui.notificationBell.classList.remove("arrival-flash"), 2400);
  }
  if (state.config.soundEnabled === true) playNotificationChime();
}

function showComposerStatus(message = "", { error = false } = {}) {
  ui.composerStatus.textContent = message;
  ui.composerStatus.classList.toggle("hidden", !message);
  ui.composerStatus.classList.toggle("error", Boolean(message) && error);
}

function stopSpeaking() {
  window.speechSynthesis?.cancel();
  speakingButton?.classList.remove("speaking");
  speakingButton = null;
}

function speakText(text, button) {
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    showComposerStatus("This browser does not expose a system text-to-speech voice.", { error: true });
    return;
  }
  const wasSpeaking = speakingButton === button;
  stopSpeaking();
  if (wasSpeaking) return;
  const utterance = new SpeechSynthesisUtterance(String(text || ""));
  utterance.onstart = () => {
    speakingButton = button;
    button.classList.add("speaking");
  };
  const finish = () => {
    button.classList.remove("speaking");
    if (speakingButton === button) speakingButton = null;
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  window.speechSynthesis.speak(utterance);
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
    let isAudio = false;
    if (/^data:image\//.test(lower) || /\.(png|jpe?g|gif|webp)(\?|$)/.test(lower)) {
      element = document.createElement("img");
      element.alt = "MMS image";
    } else if (/^data:audio\//.test(lower) || /\.(mp3|wav|m4a|ogg)(\?|$)/.test(lower)) {
      element = document.createElement("audio");
      element.controls = true;
      element.preload = "metadata";
      isAudio = true;
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
    if (isAudio) {
      const note = document.createElement("small");
      note.className = "transcript-roadmap-note";
      note.textContent = "Transcription: on the VoxVolley roadmap";
      wrapper.append(note);
    }
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
    if (message.text) {
      const speak = document.createElement("button");
      speak.type = "button";
      speak.className = "speak-message-button";
      speak.title = "Read this message aloud with the system voice";
      speak.setAttribute("aria-label", "Read message aloud");
      speak.textContent = "🔊";
      speak.addEventListener("click", () => speakText(message.text, speak));
      bubble.append(speak, document.createTextNode(message.text));
    }
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
  renderBell();
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
  applyTheme(state?.config?.theme);
  showOnly(ui.messengerView);
  ensureActiveConversation();
  renderThreads();
  renderBell();
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
  ui.accountLabel.textContent = state.config.email;
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
  ui.toastCheckbox.checked = state.config.toastEnabled !== false;
  ui.flashCheckbox.checked = state.config.flashEnabled !== false;
  ui.soundCheckbox.checked = state.config.soundEnabled === true;
  ui.themeSelect.value = state.config.theme || "classic";
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
    item.className = `attachment-item${file.voiceClip ? " voice-clip" : ""}`;
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
    if (file.voiceClip && file.dataUrl) {
      const preview = document.createElement("audio");
      preview.controls = true;
      preview.preload = "metadata";
      preview.src = file.dataUrl;
      item.append(preview);
    }
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

function mergeFloat32(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function downsamplePcm(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  if (outputRate > inputRate) throw new Error("The microphone sample rate is unexpectedly below 16 kHz.");
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.floor((index + 1) * ratio));
    let total = 0;
    for (let source = start; source < end && source < input.length; source += 1) total += input[source];
    output[index] = total / Math.max(1, end - start);
  }
  return output;
}

function encodePcmWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function voiceDurationLabel(seconds) {
  const whole = Math.max(0, Math.min(VOXVOLLEY_MAX_SECONDS, Math.floor(seconds)));
  return `0:${String(whole).padStart(2, "0")} / 0:${VOXVOLLEY_MAX_SECONDS}`;
}

function updateRecordingUi(active, seconds = 0) {
  ui.voiceRecordingStatus.classList.toggle("hidden", !active);
  ui.voiceRecordButton.classList.toggle("recording", active);
  ui.voiceRecordButton.setAttribute("aria-pressed", String(active));
  ui.voiceRecordButton.setAttribute("aria-label", active ? "Stop and attach voice message" : "Record a short voice message");
  ui.voiceRecordingTime.textContent = voiceDurationLabel(seconds);
  ui.voiceRecordingProgress.value = Math.max(0, Math.min(VOXVOLLEY_MAX_SECONDS, seconds));
}

function releaseVoiceCapture(capture) {
  try { capture.source?.disconnect(); } catch {}
  try { capture.node?.disconnect(); } catch {}
  try { capture.mute?.disconnect(); } catch {}
  for (const track of capture.stream?.getTracks?.() || []) track.stop();
  capture.context?.close?.().catch?.(() => {});
}

async function stopVoiceRecording({ attach = true } = {}) {
  const capture = voiceRecorder;
  if (!capture) return false;
  voiceRecorder = null;
  clearInterval(voiceTimer);
  voiceTimer = null;
  const elapsedMs = Math.min(VOXVOLLEY_MAX_SECONDS * 1000, performance.now() - capture.startedAt);
  releaseVoiceCapture(capture);
  updateRecordingUi(false);
  if (!attach) {
    showComposerStatus("Voice clip discarded.");
    return false;
  }
  const sourcePcm = mergeFloat32(capture.chunks);
  if (!sourcePcm.length || elapsedMs < 250) {
    showComposerStatus("The voice clip was too short to attach.", { error: true });
    return false;
  }
  const pcm = downsamplePcm(sourcePcm, capture.sampleRate, VOXVOLLEY_SAMPLE_RATE);
  const blob = encodePcmWav(pcm, VOXVOLLEY_SAMPLE_RATE);
  if (blob.size > MAX_ATTACHMENT_BYTES) {
    showComposerStatus("The recorded clip exceeded the VoIP.ms attachment ceiling. Record a shorter clip.", { error: true });
    return false;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  draftAttachments.push({
    name: `VoxVolley-${stamp}.wav`,
    type: "audio/wav",
    size: blob.size,
    dataUrl: await fileToDataUrl(blob),
    voiceClip: true,
    durationMs: elapsedMs,
  });
  renderAttachments();
  updateComposerMode();
  showComposerStatus(`VoxVolley attached · ${(elapsedMs / 1000).toFixed(1)} seconds · ${Math.ceil(blob.size / 1024)} KB`);
  return true;
}

async function startVoiceRecording() {
  if (voiceRecorder) return stopVoiceRecording({ attach: true });
  if (draftAttachments.length >= 3) {
    showComposerStatus("Remove an attachment before recording; VoIP.ms allows up to three.", { error: true });
    return false;
  }
  if (!navigator.mediaDevices?.getUserMedia || !("AudioWorkletNode" in window)) {
    showComposerStatus("This browser cannot capture a VoxVolley clip.", { error: true });
    return false;
  }
  let capture = { stream: null, context: null, source: null, node: null, mute: null };
  try {
    capture.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    capture.context = new AudioContext({ latencyHint: "interactive" });
    await capture.context.audioWorklet.addModule(chrome.runtime.getURL("audio-recorder-worklet.js"));
    await capture.context.resume();
    capture.source = capture.context.createMediaStreamSource(capture.stream);
    capture.node = new AudioWorkletNode(capture.context, "voxvolley-pcm-capture");
    capture.mute = capture.context.createGain();
    capture.mute.gain.value = 0;
    const chunks = [];
    capture.node.port.onmessage = (event) => chunks.push(new Float32Array(event.data));
    capture.source.connect(capture.node);
    capture.node.connect(capture.mute);
    capture.mute.connect(capture.context.destination);
    Object.assign(capture, { chunks, sampleRate: capture.context.sampleRate, startedAt: performance.now() });
    voiceRecorder = capture;
    updateRecordingUi(true);
    showComposerStatus("Recording VoxVolley… tap the red microphone to stop and attach.");
    voiceTimer = setInterval(() => {
      if (!voiceRecorder) return;
      const elapsed = (performance.now() - voiceRecorder.startedAt) / 1000;
      updateRecordingUi(true, elapsed);
      if (elapsed >= VOXVOLLEY_MAX_SECONDS) void stopVoiceRecording({ attach: true });
    }, 200);
    return true;
  } catch (error) {
    if (capture) releaseVoiceCapture(capture);
    const denied = error?.name === "NotAllowedError";
    showComposerStatus(denied ? "Microphone permission was not granted." : `Could not start VoxVolley: ${error.message || error}`, { error: true });
    return false;
  }
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
    const priorKeys = new Set((state?.messages || []).map((message) => message.key));
    const nextState = await sendRuntime({ type: "SYNC" });
    const newIncoming = nextState.messages.filter((message) => message.direction === "in" && !priorKeys.has(message.key));
    for (const draft of localDrafts) {
      const thread = draft.thread || makeThreadKey(draft.did, draft.contact);
      if (!nextState.messages.some((message) => (message.thread || makeThreadKey(message.did, message.contact)) === thread)) {
        nextState.messages.push(draft);
      }
    }
    state = nextState;
    renderMessenger();
    announceNewMessages(newIncoming);
  } catch (error) {
    if (!quiet) toast(error.message);
  } finally {
    ui.syncButton.classList.remove("syncing");
  }
}

async function lookupIp() {
  ui.publicIp.textContent = "Checking…";
  try {
    const result = await sendRuntime({ type: "GET_PUBLIC_IP", serviceUrl: ui.serviceUrlInput.value });
    ui.publicIp.textContent = result.ip;
  } catch {
    ui.publicIp.textContent = "Could not reach";
  }
}

async function ensureServicePermission(serviceUrl) {
  if (!chrome.permissions?.request) return;
  const url = new URL(serviceUrl);
  const granted = await chrome.permissions.request({ origins: [url.origin + "/*"] });
  if (!granted) throw new Error("Voice-ish needs permission to contact that service address.");
}

ui.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(ui.setupError);
  const mode = event.submitter?.value === "register" ? "register" : "login";
  ui.connectButton.disabled = true;
  ui.createAccountButton.disabled = true;
  ui.connectButton.textContent = mode === "register" ? "Creating…" : "Signing in…";
  try {
    await ensureServicePermission(ui.serviceUrlInput.value);
    state = await sendRuntime({
      type: "CONNECT",
      mode,
      serviceUrl: ui.serviceUrlInput.value,
      email: ui.usernameInput.value,
      password: ui.passwordInput.value,
    });
    ui.passwordInput.value = "";
    renderMessenger();
  } catch (error) {
    showError(ui.setupError, error.message);
  } finally {
    ui.connectButton.disabled = false;
    ui.createAccountButton.disabled = false;
    ui.connectButton.textContent = "Sign in";
  }
});

ui.retryIpButton.addEventListener("click", async () => {
  try {
    await ensureServicePermission(ui.serviceUrlInput.value);
    await lookupIp();
  } catch (error) {
    showError(ui.setupError, error.message);
  }
});
ui.syncButton.addEventListener("click", () => refresh());
ui.notificationBell.addEventListener("click", () => {
  const unread = conversations()
    .filter((item) => Number(state.unreadByThread?.[item.thread] || 0) > 0)
    .sort((a, b) => String(b.messages.at(-1)?.date || "").localeCompare(String(a.messages.at(-1)?.date || "")));
  if (unread.length) void openThread(unread[0].thread);
  else toast("No unread messages.");
});
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
      toastEnabled: ui.toastCheckbox.checked,
      flashEnabled: ui.flashCheckbox.checked,
      soundEnabled: ui.soundCheckbox.checked,
      theme: ui.themeSelect.value,
    });
    ui.settingsModal.classList.add("hidden");
    applyTheme(state.config.theme);
    if (!state.messages.some((message) => message.thread === activeThread) && !activeRoute) activeThread = "";
    renderMessenger();
    toast("Settings saved.");
  } catch (error) {
    showError(ui.settingsError, error.message);
  }
});

ui.disconnectButton.addEventListener("click", async () => {
  if (!confirm("Sign out and erase the local message cache?")) return;
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
ui.voiceRecordButton.addEventListener("click", () => void startVoiceRecording());
ui.cancelVoiceButton.addEventListener("click", () => void stopVoiceRecording({ attach: false }));

async function submitActiveMessage() {
  if (sending) return;
  showComposerStatus();
  if (voiceRecorder) await stopVoiceRecording({ attach: true });
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
    ui.serviceUrlInput.value = state.config.serviceUrl || ui.serviceUrlInput.value;
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

window.addEventListener("unload", () => {
  if (popupPoll) clearInterval(popupPoll);
  stopSpeaking();
  if (voiceRecorder) {
    const capture = voiceRecorder;
    voiceRecorder = null;
    clearInterval(voiceTimer);
    releaseVoiceCapture(capture);
  }
});
init();
