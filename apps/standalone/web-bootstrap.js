(function bootstrapVoiceishWeb() {
  "use strict";
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }
  document.getElementById("settingsForm")?.addEventListener("submit", () => {
    const enabled = document.getElementById("notificationsCheckbox")?.checked;
    if (enabled && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, { capture: true });
})();
