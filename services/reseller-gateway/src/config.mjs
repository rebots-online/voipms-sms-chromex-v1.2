function requireEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig() {
  return {
    databaseUrl: requireEnvironment("DATABASE_URL"),
    host: process.env.VOICEISH_HOST || "127.0.0.1",
    port: Number(process.env.VOICEISH_PORT || 8790),
    publicUrl: process.env.VOICEISH_PUBLIC_URL || "http://127.0.0.1:8790",
    allowedOrigins: new Set(
      String(process.env.VOICEISH_ALLOWED_ORIGINS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
    adminToken: requireEnvironment("VOICEISH_ADMIN_TOKEN"),
    voipMs: {
      username: requireEnvironment("VOIPMS_API_USERNAME"),
      password: requireEnvironment("VOIPMS_API_PASSWORD"),
      baseUrl: process.env.VOIPMS_API_URL || "https://voip.ms/api/v1/rest.php",
    },
  };
}
