import { chromium, expect, test, type Page } from "@playwright/test";

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

type Telemetry = {
  requestedBackend: string;
  actualBackend: string;
  fallbackUsed: boolean;
  capabilityTier: string;
  webgl2ApiAvailable: boolean;
  tslMaterial: boolean;
  compileAsync: boolean;
  drawCalls: number;
  triangles: number;
  resources: {
    geometries: number;
    attributes: number;
    programs: number;
    trackedBytes: number;
  };
  adapter: { version: string | null };
};

async function telemetry(page: Page): Promise<Telemetry> {
  return JSON.parse(await page.getByTestId("gfx-telemetry").innerText()) as Telemetry;
}

test("GFX-001 forced WebGL2 backend initializes and renders the TSL scene", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop backend acceptance");
  const errors = captureRuntimeErrors(page);
  await page.goto("/gfx-spike?backend=webgl2");

  const spike = page.getByTestId("gfx-spike");
  await expect(spike).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await expect(spike).toHaveAttribute("data-requested-backend", "forced-webgl2");
  await expect(spike).toHaveAttribute("data-actual-backend", "webgl2");
  await expect(spike).toHaveAttribute("data-tsl-material", "true");
  await expect(spike).toHaveAttribute("data-compile-async", "true");

  const sample = await telemetry(page);
  expect(sample.requestedBackend).toBe("forced-webgl2");
  expect(sample.actualBackend).toBe("webgl2");
  expect(sample.fallbackUsed).toBe(false);
  expect(sample.webgl2ApiAvailable).toBe(true);
  expect(sample.tslMaterial).toBe(true);
  expect(sample.compileAsync).toBe(true);
  expect(sample.capabilityTier).toMatch(/^capability-tier-[012]$/);
  expect(sample.adapter.version).toContain("WebGL 2");
  expect(sample.drawCalls).toBeGreaterThan(0);
  expect(sample.triangles).toBeGreaterThan(0);
  expect(sample.resources.geometries).toBeGreaterThan(0);
  expect(sample.resources.attributes).toBeGreaterThan(0);
  expect(sample.resources.programs).toBeGreaterThan(0);
  expect(sample.resources.trackedBytes).toBeGreaterThan(0);
  await expect(page.getByTestId("gfx-canvas")).toBeVisible();
  expect(errors).toEqual([]);
});

test("GFX-001 preferred path reports WebGPU or an explicit WebGL2 fallback", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop backend acceptance");
  const errors = captureRuntimeErrors(page);
  await page.goto("/gfx-spike");

  const spike = page.getByTestId("gfx-spike");
  await expect(spike).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await expect(spike).toHaveAttribute("data-requested-backend", "webgpu-preferred");
  await expect(spike).toHaveAttribute("data-actual-backend", /^(webgpu|webgl2)$/);

  const sample = await telemetry(page);
  expect(sample.requestedBackend).toBe("webgpu-preferred");
  expect(["webgpu", "webgl2"]).toContain(sample.actualBackend);
  expect(sample.fallbackUsed).toBe(sample.actualBackend === "webgl2");
  expect(sample.tslMaterial).toBe(true);
  expect(sample.compileAsync).toBe(true);
  expect(sample.drawCalls).toBeGreaterThan(0);
  expect(sample.triangles).toBeGreaterThan(0);
  expect(sample.resources.programs).toBeGreaterThan(0);
  expect(sample.resources.trackedBytes).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("GFX-001 WebGPU backend is required under the reproducible SwiftShader gate", async ({ browserName }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop backend acceptance");
  expect(browserName).toBe("chromium");
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("The gfx spike WebGPU gate requires a configured baseURL.");

  const browser = await chromium.launch({
    headless: true,
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = captureRuntimeErrors(page);
    await page.goto(new URL("/gfx-spike", baseURL).toString());

    const spike = page.getByTestId("gfx-spike");
    await expect(spike).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
    await expect(spike).toHaveAttribute("data-requested-backend", "webgpu-preferred");
    await expect(spike).toHaveAttribute("data-actual-backend", "webgpu");

    const sample = await telemetry(page);
    expect(sample.actualBackend).toBe("webgpu");
    expect(sample.fallbackUsed).toBe(false);
    expect(sample.tslMaterial).toBe(true);
    expect(sample.compileAsync).toBe(true);
    expect(sample.drawCalls).toBeGreaterThan(0);
    expect(sample.triangles).toBeGreaterThan(0);
    expect(sample.resources.programs).toBeGreaterThan(0);
    expect(sample.resources.trackedBytes).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
