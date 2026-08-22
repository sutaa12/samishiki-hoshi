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

const explicitDevPort = process.env.GFX_SPIKE_PORT !== undefined;
const devPort = gfxSpikePort(process.env.GFX_SPIKE_PORT);
const devUrl = `http://localhost:${devPort}`;
const jsonReportPath = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME
  ?? ".quality-gates/playwright-report.json";
const angleBackend = process.env.GFX_PLAYWRIGHT_ANGLE
  ?? (process.platform === "darwin" ? "metal" : "swiftshader");
if (angleBackend !== "metal" && angleBackend !== "swiftshader") {
  throw new Error("GFX_PLAYWRIGHT_ANGLE must be metal or swiftshader.");
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["line"], ["json", { outputFile: jsonReportPath }]],
  outputDir: ".quality-gates/playwright-output",
  use: {
    baseURL: devUrl,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        "--enable-unsafe-webgpu",
        "--ignore-gpu-blocklist",
        "--use-gl=angle",
        `--use-angle=${angleBackend}`,
      ],
    },
  },
  webServer: {
    command: `npm run dev -- --port ${devPort}`,
    url: devUrl,
    reuseExistingServer: !explicitDevPort,
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
