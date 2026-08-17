const EMPTY_STATUSES = new Set(["no_sms", "no_mms", "no_dids", "no_records", "no_results"]);

export function buildUpstreamFields({ username, password, method, params = {} }) {
  return {
    api_username: username,
    api_password: password,
    method,
    content_type: "json",
    ...params,
  };
}

function addFields(target, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "") target.append(key, String(value));
  }
}

export class VoipMsApi {
  constructor({ username, password, baseUrl = "https://voip.ms/api/v1/rest.php", fetchImpl = fetch }) {
    if (!username || !password) throw new Error("VoIP.ms master API credentials are required.");
    this.username = username;
    this.password = password;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
  }

  async call({ method, params = {}, usePost = false }) {
    const fields = buildUpstreamFields({
      username: this.username,
      password: this.password,
      method,
      params,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40_000);
    let response;
    try {
      if (usePost) {
        const body = new FormData();
        addFields(body, fields);
        response = await this.fetch(this.baseUrl, {
          method: "POST",
          body,
          redirect: "error",
          signal: controller.signal,
        });
      } else {
        const url = new URL(this.baseUrl);
        addFields(url.searchParams, fields);
        response = await this.fetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
      }
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`VoIP.ms timed out while processing ${method}.`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`VoIP.ms returned HTTP ${response.status} with a non-JSON body.`);
    }
    if (!response.ok) throw new Error(`VoIP.ms HTTP ${response.status}: ${data.status || "request failed"}`);
    if (data.status !== "success" && !EMPTY_STATUSES.has(String(data.status || ""))) {
      throw new Error(`VoIP.ms: ${String(data.status || "unknown_error").replaceAll("_", " ")}`);
    }
    return data;
  }
}
