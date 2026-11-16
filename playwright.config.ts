import { defineConfig, devices } from "@playwright/test";

// Browser smoke suite (plan 5.1): the built app under `vite preview`, with every
// /data/ request answered from e2e/fixtures (real files copied from the live site), at
// phone and desktop widths. Run with `npm run e2e`, which builds first.

const PORT = 4317;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${PORT}/`, trace: "retain-on-failure" },
  projects: [
    { name: "phone-360", use: { ...devices["Desktop Chrome"], viewport: { width: 360, height: 740 }, hasTouch: true } },
    { name: "desktop-1280", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
});
