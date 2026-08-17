import { defineConfig, devices } from "@playwright/test";

function gfxSpikePort(value: string | undefined): number {
  if (value === undefined) return 3000;
  if (!/^\d+$/.test(value)) throw new Error("GFX_SPIKE_PORT must contain decimal digits only.");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("GFX_SPIKE_PORT must be an integer from 1024 through 65535.");
  }
  return port;
}

const devPort = gfxSpikePort(process.env.GFX_SPIKE_PORT);
const devUrl = `http://localhost:${devPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["line"], ["json", { outputFile: ".quality-gates/playwright-report.json" }]],
  outputDir: ".quality-gates/playwright-output",
  use: {
    baseURL: devUrl,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader"] },
  },
  webServer: {
    command: `npm run dev -- --port ${devPort}`,
    url: devUrl,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } },
    },
  ],
});
