const loginPanel = document.querySelector("#login-panel");
const operatorPanel = document.querySelector("#operator-panel");
const loginForm = document.querySelector("#login-form");
const provisionForm = document.querySelector("#provision-form");
const signOut = document.querySelector("#sign-out");
const accountContainer = document.querySelector("#accounts");
const filter = document.querySelector("#filter");
let accessToken = sessionStorage.getItem("voiceishOperatorToken") || "";
let accounts = [];
let selectedId = "";

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw Object.assign(new Error(result.error || "Request failed."), { status: response.status });
  return result;
}

function setOutput(element, text, type = "") {
  element.textContent = text;
  element.className = type;
}

function selectedAccount() {
  return accounts.find((account) => account.id === selectedId);
}

function selectAccount(id) {
  selectedId = id;
  const account = selectedAccount();
  document.querySelector("#selected-name").textContent = account?.name || "Choose an account";
  document.querySelector("#selected-email").textContent = account?.owner_email || "Pending accounts appear first.";
  provisionForm.elements.tenantId.value = account?.id || "";
  provisionForm.elements.resellerClientId.value = account?.reseller_client_id || "";
  provisionForm.elements.dids.value = (account?.dids || []).join("\n");
  provisionForm.elements.subaccounts.value = (account?.subaccounts || []).join("\n");
  [...provisionForm.querySelectorAll("input, textarea, button")].forEach((control) => {
    if (control.name !== "tenantId") control.disabled = !account;
  });
  renderAccounts();
}

function renderAccounts() {
  const query = filter.value.trim().toLowerCase();
  const visible = accounts.filter((account) => `${account.name} ${account.owner_email} ${account.reseller_client_id || ""}`.toLowerCase().includes(query));
  document.querySelector("#account-count").textContent = `${visible.length} account${visible.length === 1 ? "" : "s"}`;
  accountContainer.replaceChildren(...visible.map((account) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `account ${account.id === selectedId ? "active" : ""}`;
    const name = document.createElement("strong");
    const email = document.createElement("small");
    const status = document.createElement("span");
    name.textContent = account.name;
    email.textContent = account.owner_email;
    status.textContent = account.provisioning_status;
    status.className = `status ${account.provisioning_status}`;
    button.append(name, email, status);
    button.addEventListener("click", () => selectAccount(account.id));
    return button;
  }));
}

async function loadAccounts() {
  const result = await api("/v1/admin/tenants");
  accounts = result.accounts || [];
  renderAccounts();
  if (selectedId) selectAccount(selectedId);
}

async function enterConsole() {
  loginPanel.hidden = true;
  operatorPanel.hidden = false;
  signOut.hidden = false;
  try {
    await loadAccounts();
  } catch (error) {
    if (error.status === 401 || error.status === 403) leaveConsole();
    else throw error;
  }
}

function leaveConsole() {
  accessToken = "";
  sessionStorage.removeItem("voiceishOperatorToken");
  loginPanel.hidden = false;
  operatorPanel.hidden = true;
  signOut.hidden = true;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.querySelector("#login-result");
  setOutput(output, "Signing in…");
  try {
    const body = Object.fromEntries(new FormData(loginForm));
    const result = await api("/v1/auth/login", { method: "POST", body });
    accessToken = result.access_token;
    sessionStorage.setItem("voiceishOperatorToken", accessToken);
    setOutput(output, "");
    await enterConsole();
  } catch (error) {
    setOutput(output, error.message, "error");
  }
});

provisionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.querySelector("#provision-result");
  const tenantId = provisionForm.elements.tenantId.value;
  const lines = (value) => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  setOutput(output, "Saving mapping…");
  try {
    await api(`/v1/admin/tenants/${encodeURIComponent(tenantId)}/voipms`, {
      method: "PUT",
      body: {
        reseller_client_id: provisionForm.elements.resellerClientId.value,
        dids: lines(provisionForm.elements.dids.value),
        subaccounts: lines(provisionForm.elements.subaccounts.value).map((account) => ({ account, label: "" })),
      },
    });
    setOutput(output, "Phone-service mapping saved.", "success");
    await loadAccounts();
  } catch (error) {
    setOutput(output, error.message, "error");
  }
});

filter.addEventListener("input", renderAccounts);
document.querySelector("#refresh").addEventListener("click", () => loadAccounts().catch((error) => alert(error.message)));
signOut.addEventListener("click", leaveConsole);
if (accessToken) enterConsole().catch(leaveConsole);
