import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: false,
    forbidOnly: true,
    retries: 0,
    reporter: [["list"], ["json", { outputFile: "../.codex-task-logs/browser-qa/results.json" }]],
    use: {
        baseURL: "http://127.0.0.1:5183",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        ...devices["Desktop Chrome"],
    },
    webServer: {
        command: "VITE_GOOGLE_CLIENT_ID=synthetic-local.apps.example bun run dev -- --host 127.0.0.1 --port 5183",
        url: "http://127.0.0.1:5183",
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
