import { loadConfig, stateDirectory, storedConfigExists } from "./config.mjs";
import { startInstaller } from "./installer.mjs";
import { startRuntime } from "./server.mjs";

async function launch() {
  const directory = stateDirectory();
  const hasEnvironmentConfig = Boolean(process.env.DATABASE_URL);
  const forceInstaller = process.argv.includes("--setup");
  if (forceInstaller && (storedConfigExists(directory) || hasEnvironmentConfig)) {
    throw new Error("Voice-ish is already initialized. Remove --setup to start the service.");
  }
  if (!storedConfigExists(directory) && !hasEnvironmentConfig) {
    return startInstaller({ directory, onComplete: (config) => startRuntime(config) });
  }
  return startRuntime(loadConfig({ directory }));
}

launch().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
