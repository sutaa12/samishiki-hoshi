import { chromium, expect, test, type Page } from "@playwright/test";

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

type ContractSnapshot = {
  generation: number;
  replayHash: string;
  host: {
    lifecycle: string;
    loopRunning: boolean;
    backend: { requestedApi: string; actualApi: string; fallback: boolean };
    resources: Record<string, number>;
    counters: {
      frameCallbacks: number;
      submittedFrames: number;
      backendEvents: number;
      failures: number;
      probeSubscribers: number;
      pendingControlOperations: number;
      retainedRawFailureCauses: number;
      retainedIntermediateFailureSnapshots: number;
    };
    events: Array<{ kind: string; detail: string }>;
    error: { code: string; message: string } | null;
  };
  backendFacts: {
    requestedPolicy: string;
    actualAuthority: string | null;
    webgpuApiExposed: boolean;
    webgl2ApiAvailable: boolean;
    navigatorProbe: {
      source: string;
      attempted: boolean;
      available: boolean;
      vendor: string | null;
      architecture: string | null;
    };
    compatibilityMode: boolean | null;
    lab: { enabled: boolean; diagnosticsEnabled: boolean; performanceAccepted: boolean };
  };
  backendLifecycle: {
    state: string;
    eventBridgeActive: boolean;
    initializeCalls: number;
    precompileCalls: number;
    renderCalls: number;
    resizeCalls: number;
    disposeCalls: number;
    rendererDisposeInvoked: boolean;
    rendererDisposeCompleted: boolean;
    backendDisposeInstrumented: boolean;
    backendDisposeInvoked: boolean;
    backendDisposeCompleted: boolean;
    retainedFailureReferences: number;
    resourceCounterProvenance: string;
    threeInfoResetObserved: boolean;
    lastLiveResources: Record<string, number> | null;
    resourcesBeforeRendererDispose: Record<string, number> | null;
    rendererMemory: Record<string, number | null>;
    rendererMemoryComplete: boolean;
    appOwnership: {
      renderPasses: number;
      sceneObjects: number;
      eventSubscribers: number;
    };
    aggregateCounterAvailability: { nodes: false; pendingUploads: false };
    resources: Record<string, number>;
  };
  frameLoop: { running: boolean; starts: number; stops: number; ticks: number };
  scene: {
    disposeStarted: boolean;
    disposeCompleted: boolean;
    createdGeometries: number;
    disposedGeometries: number;
    createdMaterials: number;
    disposedMaterials: number;
    objects: number;
    materials: number;
    nodeMaterials: number;
    nodeMaterialsWithAssignedNodes: number;
  };
  runtime: {
    resizeListenerActive: boolean;
    resizeCalls: number;
    subscribers: number;
    disposeCalls: number;
  };
};

async function snapshot(page: Page): Promise<ContractSnapshot> {
  return JSON.parse(await page.getByTestId("gfx-contract-snapshot").innerText()) as ContractSnapshot;
}

async function waitForSubmittedFrame(page: Page): Promise<void> {
  await expect.poll(async () => (await snapshot(page)).host.counters.submittedFrames).toBeGreaterThan(0);
}

test("GFX-002 forced WebGL2 initializes, precompiles, renders, and preserves replay identity", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop backend acceptance");
  const errors = captureRuntimeErrors(page);
  await page.goto("/gfx-contract?backend=webgl2&qa=1");

  const contract = page.getByTestId("gfx-contract");
  await expect(contract).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await expect(contract).toHaveAttribute("data-requested-policy", "forced-webgl2");
  await expect(contract).toHaveAttribute("data-actual-backend", "webgl2");
  await expect(contract).toHaveAttribute("data-replay-hash", "09780631");
  await waitForSubmittedFrame(page);

  const sample = await snapshot(page);
  expect(sample.replayHash).toBe("09780631");
  expect(sample.host).toMatchObject({
    lifecycle: "ready",
    loopRunning: true,
    backend: { requestedApi: "WebGL2", actualApi: "WebGL2", fallback: false },
  });
  expect(sample.backendFacts).toMatchObject({
    requestedPolicy: "forced-webgl2",
    actualAuthority: "renderer.backend flags observed after init",
    webgl2ApiAvailable: true,
    navigatorProbe: { source: expect.stringContaining("not renderer identity") },
    lab: { enabled: true, diagnosticsEnabled: true, performanceAccepted: false },
  });
  expect(typeof sample.backendFacts.webgpuApiExposed).toBe("boolean");
  expect(sample.backendLifecycle.initializeCalls).toBe(1);
  expect(sample.backendLifecycle.precompileCalls).toBe(1);
  expect(sample.backendLifecycle.renderCalls).toBeGreaterThan(0);
  expect(sample.backendLifecycle.resourceCounterProvenance).toBe("live-renderer-info");
  expect(sample.backendLifecycle.rendererMemory.geometries).toBeGreaterThan(0);
  expect(sample.backendLifecycle.rendererMemory.programs).toBeGreaterThan(0);
  expect(sample.backendLifecycle.rendererMemory.totalBytes).toBeGreaterThan(0);
  expect(sample.backendLifecycle.rendererMemoryComplete).toBe(true);
  expect(sample.backendLifecycle.appOwnership.renderPasses).toBeGreaterThan(0);
  expect(sample.backendLifecycle.appOwnership.sceneObjects).toBeGreaterThan(0);
  expect(sample.frameLoop).toMatchObject({ running: true, starts: 1, stops: 0 });
  expect(sample.scene.nodeMaterials).toBeGreaterThan(0);
  expect(sample.scene.nodeMaterialsWithAssignedNodes).toBe(sample.scene.nodeMaterials);
  expect(errors).toEqual([]);
});

test("GFX-002 dispose releases app ownership, records provenance, and recreates", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop lifecycle acceptance");
  const errors = captureRuntimeErrors(page);
  await page.goto("/gfx-contract?backend=webgl2&qa=1");
  const contract = page.getByTestId("gfx-contract");
  await expect(contract).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await waitForSubmittedFrame(page);
  const originalCanvas = await page.getByTestId("gfx-contract-canvas").elementHandle();
  const live = await snapshot(page);
  expect(live.backendLifecycle.rendererMemory.geometries).toBeGreaterThan(0);
  expect(live.backendLifecycle.rendererMemory.programs).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Dispose runtime" }).click();
  await expect(contract).toHaveAttribute("data-status", "disposed");
  const first = await snapshot(page);
  expect(first.backendLifecycle).toMatchObject({
    state: "disposed",
    eventBridgeActive: false,
    disposeCalls: 1,
    rendererDisposeInvoked: true,
    rendererDisposeCompleted: true,
    backendDisposeInstrumented: true,
    backendDisposeInvoked: true,
    backendDisposeCompleted: true,
    retainedFailureReferences: 0,
    resourceCounterProvenance: "post-renderer-dispose-observation",
    threeInfoResetObserved: true,
    rendererMemoryComplete: true,
    appOwnership: { renderPasses: 0, sceneObjects: 0, eventSubscribers: 0 },
  });
  expect(first.backendLifecycle.lastLiveResources).toMatchObject({
    geometries: expect.any(Number),
    programs: expect.any(Number),
  });
  expect(first.backendLifecycle.lastLiveResources!.geometries).toBeGreaterThan(0);
  expect(first.backendLifecycle.lastLiveResources!.programs).toBeGreaterThan(0);
  expect(first.backendLifecycle.resourcesBeforeRendererDispose).not.toBeNull();
  expect(first.frameLoop.running).toBe(false);
  expect(first.host.counters.probeSubscribers).toBe(0);
  expect(first.host.counters.pendingControlOperations).toBe(0);
  expect(first.host.counters.retainedRawFailureCauses).toBe(0);
  expect(first.host.counters.retainedIntermediateFailureSnapshots).toBe(0);
  expect(first.frameLoop.stops).toBe(1);
  expect(first.runtime).toMatchObject({ resizeListenerActive: false, subscribers: 0, disposeCalls: 1 });
  expect(first.scene).toMatchObject({
    disposeStarted: true,
    disposeCompleted: true,
    createdGeometries: 2,
    disposedGeometries: 2,
    createdMaterials: 2,
    disposedMaterials: 2,
    objects: 0,
    materials: 0,
    nodeMaterials: 0,
  });
  expect(first.backendLifecycle.resources).toMatchObject({ objects: 0, subscribers: 0 });
  expect(first.backendLifecycle.aggregateCounterAvailability)
    .toEqual({ nodes: false, pendingUploads: false });
  expect(first.host.resources.pendingUploads).toBe(0);
  const stoppedTicks = first.frameLoop.ticks;
  const stoppedResizeCalls = first.runtime.resizeCalls;

  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Dispose runtime" }).click();
  const second = await snapshot(page);
  expect(second.runtime.disposeCalls).toBe(1);
  expect(second.frameLoop.ticks).toBe(stoppedTicks);
  expect(second.runtime.resizeCalls).toBe(stoppedResizeCalls);
  expect(second.backendLifecycle).toMatchObject({
    rendererDisposeCompleted: true,
    backendDisposeCompleted: true,
    resourceCounterProvenance: "post-renderer-dispose-observation",
    threeInfoResetObserved: true,
    rendererMemoryComplete: true,
    appOwnership: { renderPasses: 0, sceneObjects: 0, eventSubscribers: 0 },
    resources: { objects: 0, subscribers: 0 },
  });
  expect(second.host.resources.pendingUploads).toBe(0);

  await page.getByRole("button", { name: "Recreate runtime" }).click();
  await expect(contract).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
  await expect(contract).toHaveAttribute("data-generation", "2");
  await expect(contract).toHaveAttribute("data-actual-backend", "webgl2");
  expect(await originalCanvas?.evaluate((canvas) => canvas.isConnected)).toBe(false);
  await waitForSubmittedFrame(page);
  const recreated = await snapshot(page);
  expect(recreated.generation).toBe(2);
  expect(recreated.replayHash).toBe("09780631");
  expect(recreated.backendLifecycle.initializeCalls).toBe(1);
  expect(recreated.frameLoop.starts).toBe(1);
  expect(errors).toEqual([]);
});

test("GFX-002 synthetic late device-loss event path fails closed and releases ownership", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop failure acceptance");
  const errors = captureRuntimeErrors(page);
  await page.goto("/gfx-contract?backend=webgl2&qa=1");
  const contract = page.getByTestId("gfx-contract");
  await expect(contract).toHaveAttribute("data-status", "ready", { timeout: 15_000 });

  await page.getByRole("button", { name: "Inject device loss" }).click();
  await expect(contract).toHaveAttribute("data-status", "error");
  await expect(page.getByTestId("gfx-contract-failure")).toContainText("device-lost");
  await expect.poll(async () => (await snapshot(page)).backendLifecycle.state).toBe("disposed");

  const failed = await snapshot(page);
  expect(failed.host).toMatchObject({
    lifecycle: "failed",
    loopRunning: false,
    counters: { backendEvents: 1, failures: 1 },
    error: { code: "BACKEND_RUNTIME_FAILED" },
  });
  expect(failed.host.events.map((event) => event.kind)).toContain("backend-event");
  expect(failed.runtime).toMatchObject({ resizeListenerActive: false, subscribers: 0 });
  expect(failed.host.counters.probeSubscribers).toBe(0);
  expect(failed.host.counters.pendingControlOperations).toBe(0);
  expect(failed.host.counters.retainedRawFailureCauses).toBe(0);
  expect(failed.host.counters.retainedIntermediateFailureSnapshots).toBe(0);
  expect(failed.backendLifecycle.eventBridgeActive).toBe(false);
  expect(failed.backendLifecycle.rendererDisposeInvoked).toBe(true);
  expect(failed.backendLifecycle.rendererDisposeCompleted).toBe(true);
  expect(failed.backendLifecycle.backendDisposeCompleted).toBe(true);
  expect(failed.backendLifecycle.retainedFailureReferences).toBe(0);
  expect(failed.backendLifecycle.resourceCounterProvenance)
    .toBe("post-renderer-dispose-observation");
  expect(failed.backendLifecycle.threeInfoResetObserved).toBe(true);
  expect(failed.backendLifecycle.rendererMemoryComplete).toBe(true);
  expect(failed.backendLifecycle.appOwnership).toEqual({
    renderPasses: 0,
    sceneObjects: 0,
    eventSubscribers: 0,
  });
  expect(failed.backendLifecycle.resources).toMatchObject({
    objects: 0,
    subscribers: 0,
  });
  expect(failed.host.resources.pendingUploads).toBe(0);
  expect(failed.scene).toMatchObject({
    disposeStarted: true,
    disposeCompleted: true,
    createdGeometries: 2,
    disposedGeometries: 2,
    createdMaterials: 2,
    disposedMaterials: 2,
    objects: 0,
    materials: 0,
  });
  expect(errors).toEqual([]);
});

test("GFX-002 host Metal WebGPU remains healthy and recreates", async ({ browserName }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop backend acceptance");
  expect(browserName).toBe("chromium");
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("GFX-002 requires a configured baseURL.");

  const browser = await chromium.launch({
    headless: true,
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=metal"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = captureRuntimeErrors(page);
    await page.goto(new URL("/gfx-contract?qa=1", baseURL).toString());
    const contract = page.getByTestId("gfx-contract");
    await expect(contract).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
    await expect(contract).toHaveAttribute("data-actual-backend", "webgpu");
    await waitForSubmittedFrame(page);
    const originalCanvas = await page.getByTestId("gfx-contract-canvas").elementHandle();

    let sample = await snapshot(page);
    expect(sample.backendFacts).toMatchObject({
      requestedPolicy: "webgpu-preferred",
      actualAuthority: "renderer.backend flags observed after init",
      navigatorProbe: {
        available: true,
        vendor: "apple",
        architecture: expect.stringMatching(/metal/i),
      },
    });
    expect(sample.backendLifecycle.rendererMemory.geometries).toBeGreaterThan(0);
    expect(sample.backendLifecycle.rendererMemory.programs).toBeGreaterThan(0);
    expect(sample.backendLifecycle.rendererMemory.totalBytes).toBeGreaterThan(0);
    await page.waitForTimeout(2_500);
    await expect(contract).toHaveAttribute("data-status", "ready");
    sample = await snapshot(page);
    expect(sample.host.events.some((event) => event.kind === "backend-event")).toBe(false);
    expect(sample.host.error).toBeNull();

    await page.getByRole("button", { name: "Dispose runtime" }).click();
    await expect(contract).toHaveAttribute("data-status", "disposed");
    const disposed = await snapshot(page);
    expect(disposed.backendLifecycle).toMatchObject({
      state: "disposed",
      rendererDisposeInvoked: true,
      rendererDisposeCompleted: true,
      backendDisposeInstrumented: true,
      backendDisposeInvoked: true,
      backendDisposeCompleted: true,
      resourceCounterProvenance: "post-renderer-dispose-observation",
      threeInfoResetObserved: true,
      rendererMemoryComplete: true,
      appOwnership: { renderPasses: 0, sceneObjects: 0, eventSubscribers: 0 },
      resources: { objects: 0, subscribers: 0 },
    });
    expect(disposed.backendLifecycle.lastLiveResources!.geometries).toBeGreaterThan(0);
    expect(disposed.backendLifecycle.lastLiveResources!.programs).toBeGreaterThan(0);
    expect(disposed.backendLifecycle.resourcesBeforeRendererDispose).not.toBeNull();
    expect(disposed.scene).toMatchObject({
      disposeCompleted: true,
      createdGeometries: 2,
      disposedGeometries: 2,
      createdMaterials: 2,
      disposedMaterials: 2,
      objects: 0,
    });
    expect(disposed.frameLoop.running).toBe(false);
    expect(disposed.runtime).toMatchObject({
      resizeListenerActive: false,
      subscribers: 0,
    });
    expect(disposed.host.counters).toMatchObject({
      probeSubscribers: 0,
      pendingControlOperations: 0,
    });
    expect(disposed.host.resources.pendingUploads).toBe(0);
    const stoppedTicks = disposed.frameLoop.ticks;
    const stoppedResizeCalls = disposed.runtime.resizeCalls;
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await page.waitForTimeout(200);
    const stillDisposed = await snapshot(page);
    expect(stillDisposed.frameLoop.ticks).toBe(stoppedTicks);
    expect(stillDisposed.runtime.resizeCalls).toBe(stoppedResizeCalls);
    await page.getByRole("button", { name: "Recreate runtime" }).click();
    await expect(contract).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
    await expect(contract).toHaveAttribute("data-generation", "2");
    await expect(contract).toHaveAttribute("data-actual-backend", "webgpu");
    expect(await originalCanvas?.evaluate((canvas) => canvas.isConnected)).toBe(false);
    await waitForSubmittedFrame(page);
    const recreated = await snapshot(page);
    expect(recreated.backendLifecycle.rendererMemory.geometries).toBeGreaterThan(0);
    expect(recreated.backendLifecycle.rendererMemory.programs).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);
    await expect(contract).toHaveAttribute("data-status", "ready");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
