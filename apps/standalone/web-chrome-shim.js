/* Minimal browser implementation of the Chrome APIs used by the shared app. */
(function createWebRuntime() {
  "use strict";

  const STORAGE_KEY = "voiceish-web-storage-v1";
  const DB_NAME = "voiceish-web";
  const DB_STORE = "state";
  const messageListeners = [];
  const alarmListeners = [];
  const alarmTimers = new Map();

  function readLocalFallback() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch { return {}; }
  }

  function writeLocalFallback(value) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }

  let databasePromise;
  let storageQueue = Promise.resolve();

  function openDatabase() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open browser storage."));
    });
    return databasePromise;
  }

  async function readStore() {
    const database = await openDatabase();
    if (!database) return readLocalFallback();
    const stored = await new Promise((resolve, reject) => {
      const request = database.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get("all");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read browser storage."));
    });
    if (stored) return stored;
    const legacy = readLocalFallback();
    if (Object.keys(legacy).length) await writeStore(legacy);
    return legacy;
  }

  async function writeStore(value) {
    const database = await openDatabase();
    if (!database) return writeLocalFallback(value);
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(DB_STORE, "readwrite");
      transaction.objectStore(DB_STORE).put(value, "all");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not write browser storage."));
    });
  }

  function selectStored(store, keys) {
    if (keys == null) return { ...store };
    if (typeof keys === "string") return { [keys]: store[keys] };
    if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
    return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, store[key] ?? fallback]));
  }

  const chrome = {
    runtime: {
      lastError: null,
      getURL(path) { return new URL(path, location.href).href; },
      onMessage: { addListener(listener) { messageListeners.push(listener); } },
      onInstalled: { addListener() {} },
      onStartup: {
        addListener(listener) { setTimeout(() => Promise.resolve(listener()).catch(() => {}), 0); }
      },
      sendMessage(request, callback) {
        let answered = false;
        const respond = (response) => {
          if (answered) return;
          answered = true;
          queueMicrotask(() => callback?.(response));
        };
        for (const listener of messageListeners) {
          try {
            const pending = listener(request, { url: location.href }, respond);
            if (pending === true) return;
            if (pending !== undefined && !answered) respond(pending);
          } catch (error) {
            respond({ ok: false, error: error.message || String(error) });
            return;
          }
        }
        if (!answered) respond({ ok: false, error: "The local message service is unavailable." });
      }
    },
    permissions: {
      async request() { return true; },
      async contains() { return true; }
    },
    storage: {
      local: {
        get(keys, callback) {
          storageQueue.then(readStore).then((store) => callback(selectStored(store, keys)));
        },
        set(values, callback) {
          storageQueue = storageQueue.then(async () => writeStore({ ...(await readStore()), ...values }));
          storageQueue.then(() => callback?.());
        },
        remove(keys, callback) {
          storageQueue = storageQueue.then(async () => {
            const store = await readStore();
            for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
            await writeStore(store);
          });
          storageQueue.then(() => callback?.());
        }
      }
    },
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText({ text }) {
        document.title = text ? `(${text}) Voice-ish Web` : "Voice-ish Web";
      },
      async openPopup() { window.focus(); }
    },
    alarms: {
      async create(name, options = {}) {
        clearInterval(alarmTimers.get(name));
        const milliseconds = Math.max(10_000, Number(options.periodInMinutes || 1) * 60_000);
        alarmTimers.set(name, setInterval(() => {
          for (const listener of alarmListeners) Promise.resolve(listener({ name })).catch(() => {});
        }, milliseconds));
      },
      onAlarm: { addListener(listener) { alarmListeners.push(listener); } }
    },
    notifications: {
      async create(id, options) {
        if (!("Notification" in window) || Notification.permission !== "granted") return id;
        const notification = new Notification(options.title || "Voice-ish", {
          body: options.message || "",
          icon: options.iconUrl || "icons/icon128.png",
          tag: id
        });
        notification.onclick = () => window.focus();
        return id;
      },
      onClicked: { addListener() {} }
    }
  };

  window.chrome = chrome;
})();
