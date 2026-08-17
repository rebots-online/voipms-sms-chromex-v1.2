const form = document.querySelector("#setup-form");
const panels = [...document.querySelectorAll("[data-step]")];
const indicators = [...document.querySelectorAll("[data-step-indicator]")];
const backButton = document.querySelector('[data-action="back"]');
const nextButton = document.querySelector('[data-action="next"]');
const completeButton = document.querySelector('[data-action="complete"]');
const completion = document.querySelector("#complete-result");
let step = 0;

const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.get("token")) sessionStorage.setItem("voiceishSetupToken", fragment.get("token"));
history.replaceState(null, "", location.pathname);
const setupToken = sessionStorage.getItem("voiceishSetupToken") || "";

function data() {
  return Object.fromEntries(new FormData(form).entries());
}

function payload() {
  const values = data();
  return { ...values, bindRemotely: form.elements.bindRemotely.checked };
}

async function request(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Voiceish-Setup-Token": setupToken },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(result.error || "The initializer could not complete that operation.");
  return result;
}

function visibleFieldsValid() {
  const controls = [...panels[step].querySelectorAll("input, textarea")];
  for (const control of controls) {
    if (!control.checkValidity()) {
      control.reportValidity();
      return false;
    }
  }
  return true;
}

function renderReview() {
  const values = payload();
  const rows = [
    ["Service", values.publicUrl],
    ["Listening", `${values.bindRemotely ? "All interfaces" : "This machine only"} · port ${values.listenPort}`],
    ["Applications", values.allowedOrigins || "No browser origins configured"],
    ["Database", values.databaseUrl.replace(/\/\/([^:]+):[^@]+@/, "//$1:••••@")],
    ["VoIP.ms account", values.voipMsUsername],
    ["Operator", `${values.operatorName} · ${values.operatorEmail}`],
    ["First phone account", values.resellerClientId || "Create as pending"],
  ];
  document.querySelector("#review").replaceChildren(...rows.flatMap(([term, description]) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = description;
    return [dt, dd];
  }));
}

function showStep(next) {
  step = Math.max(0, Math.min(panels.length - 1, next));
  panels.forEach((panel, index) => {
    panel.hidden = index !== step;
    panel.classList.toggle("active", index === step);
  });
  indicators.forEach((indicator, index) => {
    indicator.classList.toggle("active", index === step);
    indicator.classList.toggle("done", index < step);
  });
  backButton.disabled = step === 0;
  nextButton.hidden = step === panels.length - 1;
  completeButton.hidden = step !== panels.length - 1;
  if (step === panels.length - 1) renderReview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setResult(element, message, state = "") {
  element.textContent = message;
  element.className = `result ${state}`.trim();
}

nextButton.addEventListener("click", () => {
  if (visibleFieldsValid()) showStep(step + 1);
});
backButton.addEventListener("click", () => showStep(step - 1));

document.querySelector('[data-action="test-database"]').addEventListener("click", async (event) => {
  const output = document.querySelector("#database-result");
  event.currentTarget.disabled = true;
  setResult(output, "Connecting…");
  try {
    const result = await request("/v1/setup/test-database", payload());
    setResult(output, `Connected to ${result.database} · ${result.version}`, "success");
  } catch (error) {
    setResult(output, error.message, "error");
  } finally {
    event.currentTarget.disabled = false;
  }
});

document.querySelector('[data-action="test-voipms"]').addEventListener("click", async (event) => {
  const output = document.querySelector("#voipms-result");
  event.currentTarget.disabled = true;
  setResult(output, "Contacting VoIP.ms…");
  try {
    await request("/v1/setup/test-voipms", payload());
    setResult(output, "Authenticated successfully. Master credentials will remain server-side.", "success");
  } catch (error) {
    setResult(output, error.message, "error");
  } finally {
    event.currentTarget.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!visibleFieldsValid()) return;
  completeButton.disabled = true;
  completion.className = "completion";
  completion.textContent = "Applying migrations and initializing Voice-ish…";
  try {
    const result = await request("/v1/setup/complete", payload());
    completion.className = "completion success";
    completion.textContent = `Voice-ish is initialized for ${result.operator_email}. The service is starting at ${result.service_url}.`;
    backButton.hidden = true;
    completeButton.hidden = true;
  } catch (error) {
    completion.className = "completion error";
    completion.textContent = error.message;
    completeButton.disabled = false;
  }
});

if (!setupToken) {
  completion.className = "completion error";
  completion.textContent = "Open the initializer from the Voice-ish launcher so it can supply the one-time setup authorization.";
  nextButton.disabled = true;
}

showStep(0);
