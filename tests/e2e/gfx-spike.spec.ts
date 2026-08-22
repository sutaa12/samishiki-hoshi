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
  scope: string;
  requestedBackend: string;
  actualBackend: string;
  actualBackendAuthority: string;
  fallbackUsed: boolean;
  capabilityTier: string;
  webgpuApiExposed: boolean;
  webgpuAdapterProbeAvailable: boolean;
  navigatorAdapterProbe: {
    source: string;
    available: boolean;
    vendor: string | null;
    architecture: string | null;
  };
  webgl2ApiAvailable: boolean;
  sceneEvidence: {
    uniqueMaterialCount: number;
    nodeMaterialCount: number;
    nodeMaterialsWithAssignedNodes: number;
    nodeMaterialTypes: string[];
  };
  precompile: {
    method: string;
    completed: boolean;
    completedBeforeFirstRender: boolean;
    durationMs: number;
  };
  drawCalls: number;
  triangles: number;
  resources: {
    geometries: number;
    attributes: number;
    programs: number;
    trackedBytes: number;
  };
  backendIdentity: { source: string; version: string | null };
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
  await expect(spike).toHaveAttribute("data-lab-scope", "experimental-webgpu-lab-only");
  await expect(spike).toHaveAttribute("data-node-material-count", /^[1-9]\d*$/);
  await expect(spike).toHaveAttribute("data-precompile-completed", "true");

  const sample = await telemetry(page);
  expect(sample.scope).toBe("experimental-webgpu-lab-only");
  expect(sample.requestedBackend).toBe("forced-webgl2");
  expect(sample.actualBackend).toBe("webgl2");
  expect(sample.actualBackendAuthority).toBe("renderer.backend flags observed after init");
  expect(sample.fallbackUsed).toBe(false);
  expect(sample.webgl2ApiAvailable).toBe(true);
  expect(typeof sample.webgpuApiExposed).toBe("boolean");
  expect(typeof sample.webgpuAdapterProbeAvailable).toBe("boolean");
  expect(sample.navigatorAdapterProbe.source).toContain("not renderer adapter identity");
  expect(sample.sceneEvidence.nodeMaterialCount).toBeGreaterThan(0);
  expect(sample.sceneEvidence.nodeMaterialsWithAssignedNodes).toBe(sample.sceneEvidence.nodeMaterialCount);
  expect(sample.sceneEvidence.uniqueMaterialCount).toBeGreaterThanOrEqual(sample.sceneEvidence.nodeMaterialCount);
  expect(sample.sceneEvidence.nodeMaterialTypes.length).toBeGreaterThan(0);
  expect(sample.precompile.method).toBe("renderer.compileAsync(scene, camera)");
  expect(sample.precompile.completed).toBe(true);
  expect(sample.precompile.completedBeforeFirstRender).toBe(true);
  expect(sample.precompile.durationMs).toBeGreaterThanOrEqual(0);
  expect(sample.capabilityTier).toMatch(/^capability-tier-[012]$/);
  expect(sample.backendIdentity.source).toBe("renderer WebGL2 context");
  expect(sample.backendIdentity.version).toContain("WebGL 2");
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
  expect(sample.sceneEvidence.nodeMaterialCount).toBeGreaterThan(0);
  expect(sample.sceneEvidence.nodeMaterialsWithAssignedNodes).toBeGreaterThan(0);
  expect(sample.precompile.completed).toBe(true);
  expect(sample.precompile.completedBeforeFirstRender).toBe(true);
  expect(sample.drawCalls).toBeGreaterThan(0);
  expect(sample.triangles).toBeGreaterThan(0);
  expect(sample.resources.programs).toBeGreaterThan(0);
  expect(sample.resources.trackedBytes).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("GFX-001 WebGPU backend stays healthy under the host Metal lab gate", async ({ browserName }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop backend acceptance");
  expect(browserName).toBe("chromium");
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("The gfx spike WebGPU gate requires a configured baseURL.");

  const browser = await chromium.launch({
    headless: true,
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=metal"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = captureRuntimeErrors(page);
    await page.goto(new URL("/gfx-spike?qa=1", baseURL).toString());

    const spike = page.getByTestId("gfx-spike");
    await expect(spike).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
    await expect(spike).toHaveAttribute("data-requested-backend", "webgpu-preferred");
    await expect(spike).toHaveAttribute("data-actual-backend", "webgpu");

    const sample = await telemetry(page);
    expect(sample.actualBackend).toBe("webgpu");
    expect(sample.actualBackendAuthority).toBe("renderer.backend flags observed after init");
    expect(sample.fallbackUsed).toBe(false);
    expect(sample.webgpuApiExposed).toBe(true);
    expect(sample.webgpuAdapterProbeAvailable).toBe(true);
    expect(sample.navigatorAdapterProbe.available).toBe(true);
    expect(sample.navigatorAdapterProbe.source).toContain("not renderer adapter identity");
    expect(sample.navigatorAdapterProbe.vendor).toBe("apple");
    expect(sample.navigatorAdapterProbe.architecture).toMatch(/metal/i);
    expect(sample.sceneEvidence.nodeMaterialCount).toBeGreaterThan(0);
    expect(sample.sceneEvidence.nodeMaterialsWithAssignedNodes).toBeGreaterThan(0);
    expect(sample.precompile.completed).toBe(true);
    expect(sample.precompile.completedBeforeFirstRender).toBe(true);
    expect(sample.drawCalls).toBeGreaterThan(0);
    expect(sample.triangles).toBeGreaterThan(0);
    expect(sample.resources.programs).toBeGreaterThan(0);
    expect(sample.resources.trackedBytes).toBeGreaterThan(0);
    await page.waitForTimeout(2_500);
    await expect(spike).toHaveAttribute("data-status", "ready");
    expect(JSON.parse(await page.getByTestId("gfx-runtime-events").innerText())).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("GFX-001 publishes structured renderer errors emitted after initial telemetry", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop runtime diagnostics");
  const errors = captureRuntimeErrors(page);
  await page.goto("/gfx-spike?backend=webgl2&qa=1");
  const spike = page.getByTestId("gfx-spike");
  await expect(spike).toHaveAttribute("data-status", "ready", { timeout: 15_000 });

  const eventOutput = page.getByTestId("gfx-runtime-events");
  expect(JSON.parse(await eventOutput.innerText())).toEqual([]);
  await page.getByRole("button", { name: "Inject renderer diagnostic" }).click();
  await expect(eventOutput).toContainText("GFX-001 live renderer diagnostic");
  await expect(spike).toHaveAttribute("data-status", "error");

  const events = JSON.parse(await eventOutput.innerText()) as Array<{
    kind: string;
    error: {
      api: string;
      type: string;
      message: string;
      reason: string;
      details: { diagnostic: boolean };
    };
  }>;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "renderer-error",
    error: {
      api: "WebGL2",
      type: "GFXSyntheticDiagnostic",
      message: "GFX-001 live renderer diagnostic",
      reason: "qa-injected",
      details: { diagnostic: true },
    },
  });
  expect(errors).toEqual([]);
});

test("GFX-001 dispose snapshot proves stopped callbacks, zero counters, and idempotency", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop lifecycle diagnostics");
  const errors = captureRuntimeErrors(page);
  await page.goto("/gfx-spike?backend=webgl2&qa=1");
  const spike = page.getByTestId("gfx-spike");
  await expect(spike).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await page.waitForTimeout(150);

  await page.getByRole("button", { name: "Dispose runtime" }).click();
  await expect(spike).toHaveAttribute("data-status", "disposed");
  const disposeOutput = page.getByTestId("gfx-dispose-snapshot");
  await expect(disposeOutput).toContainText('"disposeCallCount": 1');
  const first = JSON.parse(await disposeOutput.innerText()) as {
    disposeCallCount: number;
    idempotentReplay: boolean;
    firstDisposedAtMs: number;
    animationLoopActive: boolean;
    resizeListenerActive: boolean;
    runtimeEventBridgeActive: boolean;
    runtimeSubscriberCountAfter: number;
    animationFrameCountAtStop: number;
    resizeHandlerInvocationCountAtStop: number;
    resourcesBefore: Record<string, number>;
    resourcesAfter: Record<string, number>;
    sceneObjectsBefore: number;
    sceneObjectsAfter: number;
    rendererDisposeInvoked: boolean;
  };
  expect(first.disposeCallCount).toBe(1);
  expect(first.idempotentReplay).toBe(false);
  expect(first.animationLoopActive).toBe(false);
  expect(first.resizeListenerActive).toBe(false);
  expect(first.runtimeEventBridgeActive).toBe(false);
  expect(first.runtimeSubscriberCountAfter).toBe(0);
  expect(first.animationFrameCountAtStop).toBeGreaterThan(0);
  expect(Object.values(first.resourcesBefore).some((value) => value > 0)).toBe(true);
  expect(Object.values(first.resourcesAfter).every((value) => value === 0)).toBe(true);
  expect(first.sceneObjectsBefore).toBeGreaterThan(0);
  expect(first.sceneObjectsAfter).toBe(0);
  expect(first.rendererDisposeInvoked).toBe(true);

  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Probe lifecycle" }).click();
  const probe = JSON.parse(await page.getByTestId("gfx-lifecycle-probe").innerText()) as {
    state: string;
    animationLoopActive: boolean;
    resizeListenerActive: boolean;
    runtimeEventBridgeActive: boolean;
    runtimeSubscriberCount: number;
    animationFrameCount: number;
    resizeHandlerInvocationCount: number;
    resources: Record<string, number>;
  };
  expect(probe.state).toBe("disposed");
  expect(probe.animationLoopActive).toBe(false);
  expect(probe.resizeListenerActive).toBe(false);
  expect(probe.runtimeEventBridgeActive).toBe(false);
  expect(probe.runtimeSubscriberCount).toBe(0);
  expect(probe.animationFrameCount).toBe(first.animationFrameCountAtStop);
  expect(probe.resizeHandlerInvocationCount).toBe(first.resizeHandlerInvocationCountAtStop);
  expect(Object.values(probe.resources).every((value) => value === 0)).toBe(true);

  await page.getByRole("button", { name: "Dispose runtime" }).click();
  await expect(disposeOutput).toContainText('"disposeCallCount": 2');
  const second = JSON.parse(await disposeOutput.innerText()) as typeof first;
  expect(second.disposeCallCount).toBe(2);
  expect(second.idempotentReplay).toBe(true);
  expect(second.firstDisposedAtMs).toBe(first.firstDisposedAtMs);
  expect(Object.values(second.resourcesAfter).every((value) => value === 0)).toBe(true);
  expect(errors).toEqual([]);
});
