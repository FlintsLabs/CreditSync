import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e", testMatch: "payment-cancellation-local.spec.ts", fullyParallel: false, forbidOnly: true, retries: 0,
    reporter: "list",
    outputDir: "../.codex-task-logs/cancellation-browser",
    use: {
        baseURL: "http://127.0.0.1:5197", timezoneId: "America/Los_Angeles", locale: "en-US",
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
        trace: "retain-on-failure", screenshot: "only-on-failure",
    },
    webServer: {
        command: "VITE_GOOGLE_CLIENT_ID=synthetic-local.apps.example bun run dev -- --host 127.0.0.1 --port 5197",
        url: "http://127.0.0.1:5197", reuseExistingServer: false, timeout: 120_000,
    },
});
