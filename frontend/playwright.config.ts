import path from "node:path";
import { pathToFileURL } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const backendDir = path.resolve(__dirname, "../backend");
const dataDir = path.join(backendDir, "data", "e2e");
const python = process.platform === "win32"
  ? path.join(backendDir, ".venv", "Scripts", "python.exe")
  : path.join(backendDir, ".venv", "bin", "python");
const apiUrl = "http://127.0.0.1:8010/api";
const webUrl = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 240_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: webUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `"${python}" -m uvicorn app.main:app --host 127.0.0.1 --port 8010`,
      cwd: backendDir,
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ENVIRONMENT: "development",
        DEBUG: "false",
        SECRET_KEY: "e2e-only-secret-key-0123456789abcdef",
        DATA_DIR: dataDir,
        DATABASE_URL: `sqlite:///${path.join(dataDir, "mlops.db").replaceAll("\\", "/")}`,
        AUTO_CREATE_TABLES: "true",
        MLFLOW_ENABLED: "true",
        MLFLOW_TRACKING_URI: `sqlite:///${path.join(dataDir, "mlflow.db").replaceAll("\\", "/")}`,
        MLFLOW_ARTIFACT_ROOT: pathToFileURL(path.join(dataDir, "mlflow-artifacts")).href,
        MLFLOW_DISABLE_AGENT_HINT: "1",
        ARTIFACT_DIR: path.join(dataDir, "artifacts"),
        STORAGE_BACKEND: "local",
        JOB_RUNNER: "thread",
        DEMO_MODE: "true",
        CORS_ORIGINS: `${webUrl},http://localhost:3100`,
        ALLOWED_HOSTS: "127.0.0.1,localhost",
        RATE_LIMIT_AUTH_PER_MINUTE: "1000",
        RATE_LIMIT_API_PER_MINUTE: "10000",
        RATE_LIMIT_PREDICT_PER_MINUTE: "10000",
        PYTHONPATH: ".",
      },
    },
    {
      command: "npm run dev -- --port 3100",
      cwd: __dirname,
      url: `${webUrl}/login`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_API_URL: apiUrl,
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
