import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: ".ralph/reviews/qa-results.json" }]
  ],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  // Auto-start the frontend dev server + backend before running tests
  webServer: [
    {
      command: "cd frontend && npm run dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: true,
      timeout: 15_000
    },
    {
      command: "npx tsx src/cli-server.ts",
      url: "http://127.0.0.1:3741/api/status",
      reuseExistingServer: true,
      timeout: 15_000
    }
  ]
})
