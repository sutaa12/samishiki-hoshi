import { chromium, expect, test, type Page, type Worker } from "@playwright/test";
import type { StoryChunkId } from "../../src/world/v2";

const FOUNDATION_PLAN_DIGEST = "world-plan-v1:75d93cbb8e0580cd";
const INITIAL_CHUNK_IDS = Object.freeze(["S07", "S08", "S09", "S10"] as const);
const INITIAL_CHUNK_DIGESTS = Object.freeze({
  S07: "chunk-payload-v1:e7837c38fc5babe8",
  S08: "chunk-payload-v1:93460b22f054e880",
  S09: "chunk-payload-v1:954d37f91ff79283",
  S10: "chunk-payload-v1:9ba7999780ef5119",
}) satisfies Readonly<Record<(typeof INITIAL_CHUNK_IDS)[number], string>>;

interface FoundationSnapshot {
  readonly generation: number;
  readonly planDigest: string;
  readonly host: {
    readonly lifecycle: string;
    readonly counters: {
      readonly submittedFrames: number;
      readonly retainedRawFailureCauses: number;
      readonly retainedIntermediateFailureSnapshots: number;
    };
  };
  readonly backendLifecycle: {
    readonly state: string;
    readonly resources: {
      readonly geometries: number;
      readonly programs: number;
      readonly objects: number;
    };
    readonly retainedFailureReferences: number;
    readonly eventBridgeActive: boolean;
  };
  readonly pipeline: {
    readonly state: string;
    readonly graphCount: number;
    readonly warmedProfileIds: readonly string[];
    readonly programCountAtReady: number | null;
    readonly programGrowthAfterReady: number;
    readonly cleanupPendingGraphs: number;
  };
  readonly materials: {
    readonly state: string;
    readonly createdMaterials: number;
    readonly disposedMaterials: number;
    readonly ownedMaterials: number;
    readonly ownedGeometry: number;
    readonly variants: readonly string[];
  };
  readonly chunks: {
    readonly initialized: boolean;
    readonly disposed: boolean;
    readonly focusChunkId: string | null;
    readonly desiredChunkIds: readonly string[];
    readonly activeChunkIds: readonly string[];
    readonly gpuOwnedCount: number;
    readonly workerInboxCount: number;
    readonly uploadQueue: {
      readonly disposed: boolean;
      readonly pending: number;
      readonly completed: number;
      readonly cancelled: number;
      readonly failed: number;
      readonly totalUploadedBytes: number;
      readonly orphanLeaseCount: number;
      readonly orphanJobCount: number;
      readonly cleanupFailureCount: number;
    };
    readonly events: readonly {
      readonly kind: string;
      readonly name: string;
      readonly chunkId: string | null;
      readonly value: number | string | boolean | null;
    }[];
  };
  readonly uploader: {
    readonly disposed: boolean;
    readonly poolSlots: number;
    readonly freeSlots: number;
    readonly activeLeases: number;
    readonly ownedGeometries: number;
    readonly ownedObjects: number;
  };
  readonly logicalResources: {
    readonly disposed: boolean;
    readonly owners: number;
    readonly bytes: number;
    readonly resources: { readonly objects: number };
  };
  readonly telemetry: {
    readonly state: "active" | "disposed";
    readonly window: {
      readonly retainedFrames: number;
      readonly steadyFrames: number;
      readonly excludedOperationalFrames: number;
      readonly totalFramesObserved: number;
    };
    readonly frameIntervalMs: {
      readonly sampleCount: number;
      readonly p50: number | null;
      readonly p95: number | null;
      readonly p99: number | null;
    };
    readonly mainThreadWorkMs: {
      readonly sampleCount: number;
      readonly p50: number | null;
      readonly p95: number | null;
      readonly p99: number | null;
    };
    readonly gpuTimeMs: {
      readonly sampleCount: number;
      readonly p50: number | null;
      readonly p95: number | null;
      readonly p99: number | null;
    };
    readonly gpuTimingSupported: boolean;
    readonly latestFrame: {
      readonly submitted: boolean;
      readonly passCount: number;
      readonly transparentPasses: number;
      readonly fullscreenPasses: number;
      readonly renderer: {
        readonly available: boolean;
        readonly drawCalls: number | null;
        readonly triangles: number | null;
        readonly drawingBufferWidth: number | null;
        readonly drawingBufferHeight: number | null;
        readonly gpuTimeMs: number | null;
      };
      readonly resources: {
        readonly geometries: number;
        readonly textures: number;
        readonly renderTargets: number;
        readonly programs: number;
        readonly nodes: number;
        readonly objects: number;
        readonly pendingUploads: number;
      };
    } | null;
    readonly events: readonly {
      readonly kind: string;
      readonly durationMs: number;
      readonly success: boolean;
      readonly affectsStoryTime: boolean;
    }[];
    readonly eventTotals: Readonly<Record<string, number>>;
    readonly runtimeSpikesOver50Ms: number;
    readonly historyResetCounts: Readonly<Record<string, number>>;
  };
  readonly quality: { readonly id: string; readonly subscribers: number };
  readonly frameLoop: { readonly running: boolean; readonly stops: number; readonly ticks: number };
  readonly scene: { readonly objects: number; readonly meshes: number; readonly children: number };
  readonly runtime: {
    readonly resizeListenerActive: boolean;
    readonly subscribers: number;
    readonly disposeCalls: number;
  };
}

async function snapshot(page: Page): Promise<FoundationSnapshot> {
  const value = await page.getByTestId("gfx-foundation-snapshot").textContent();
  if (!value || value === "initializing") throw new Error("Foundation snapshot is not available.");
  return JSON.parse(value) as FoundationSnapshot;
}

async function waitForSnapshot(
  page: Page,
  predicate: (value: FoundationSnapshot) => boolean,
): Promise<FoundationSnapshot> {
  await expect.poll(async () => predicate(await snapshot(page))).toBe(true);
  return snapshot(page);
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

function generatedChunkDigests(
  value: FoundationSnapshot,
  chunkIds: readonly StoryChunkId[],
): Readonly<Record<string, string>> {
  const expected = new Set<string>(chunkIds);
  const result: Record<string, string> = {};
  for (const event of value.chunks.events) {
    if (
      event.kind !== "worker"
      || event.name !== "generated"
      || event.chunkId === null
      || !expected.has(event.chunkId)
      || typeof event.value !== "string"
    ) continue;
    result[event.chunkId] = event.value;
  }
  return Object.freeze(result);
}

function expectNoSteadyOperationalSpike(value: FoundationSnapshot): void {
  for (const event of value.telemetry.events) {
    if (event.kind !== "upload" && event.kind !== "activation") continue;
    expect(event.durationMs, `${event.kind} event duration`).toBeLessThanOrEqual(50);
  }
  expect(value.telemetry.runtimeSpikesOver50Ms).toBe(0);
}

test.describe("GFX-004/GFX-005/GFX-006 real browser foundation", () => {
  test.skip(({ isMobile }) => isMobile, "The deterministic ownership gate runs once on desktop Chromium.");

  test("streams through a real worker without post-ready GPU growth and releases every owner", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const openedWorkers: Worker[] = [];
    const closedWorkerUrls: string[] = [];
    const lifecycleEvidence: Array<Readonly<Record<string, unknown>>> = [];
    page.on("worker", (worker) => {
      openedWorkers.push(worker);
      worker.on("close", () => closedWorkerUrls.push(worker.url()));
    });

    await page.goto("/gfx-foundation?backend=webgl2&qa=1");
    await expect(page.getByTestId("gfx-foundation")).toHaveAttribute("data-status", "ready");
    await expect(page.getByTestId("gfx-foundation")).toHaveAttribute("data-actual-backend", "webgl2");

    const initial = await waitForSnapshot(page, (value) => (
      value.host.lifecycle === "ready"
      && value.chunks.focusChunkId === "S08"
      && value.chunks.activeChunkIds.length === 4
      && value.chunks.gpuOwnedCount === 4
      && value.chunks.uploadQueue.pending === 0
    ));

    expect(openedWorkers).toHaveLength(1);
    expect(new URL(openedWorkers[0]!.url()).origin).toBe(new URL(page.url()).origin);
    expect(openedWorkers[0]!.url()).toContain("world-chunk-worker");
    expect(initial.planDigest).toBe(FOUNDATION_PLAN_DIGEST);
    expect(sorted(initial.chunks.desiredChunkIds)).toEqual(sorted(["S07", "S08", "S09", "S10"]));
    expect(sorted(initial.chunks.activeChunkIds)).toEqual(sorted(initial.chunks.desiredChunkIds));
    expect(generatedChunkDigests(initial, INITIAL_CHUNK_IDS)).toEqual(INITIAL_CHUNK_DIGESTS);
    expect(initial.chunks.workerInboxCount).toBe(0);
    expect(initial.chunks.uploadQueue).toMatchObject({
      completed: 4,
      failed: 0,
      totalUploadedBytes: 3_584,
      orphanLeaseCount: 0,
      orphanJobCount: 0,
      cleanupFailureCount: 0,
    });
    expect(initial.uploader).toMatchObject({
      poolSlots: 4,
      freeSlots: 0,
      activeLeases: 4,
      ownedGeometries: 1,
      ownedObjects: 32,
    });
    expect(initial.logicalResources).toMatchObject({ owners: 4, bytes: 0 });
    expect(initial.logicalResources.resources.objects).toBe(32);
    expect(initial.materials).toMatchObject({
      state: "ready",
      createdMaterials: 14,
      disposedMaterials: 0,
      ownedMaterials: 14,
      ownedGeometry: 1,
    });
    expect(sorted(initial.materials.variants)).toEqual(sorted(["webgl2-full", "webgl2-lean"]));
    expect(initial.pipeline).toMatchObject({
      state: "ready",
      graphCount: 3,
      programGrowthAfterReady: 0,
      cleanupPendingGraphs: 0,
    });
    expect(initial.pipeline.warmedProfileIds).toHaveLength(3);
    expect(initial.pipeline.programCountAtReady).not.toBeNull();
    expect(initial.backendLifecycle.resources.geometries).toBeGreaterThanOrEqual(1);
    expect(initial.scene).toMatchObject({ meshes: 28, children: 5 });
    expect(initial.frameLoop.running).toBe(true);

    const steady = await waitForSnapshot(page, (value) => (
      value.telemetry.window.steadyFrames >= 120
    ));
    expect(steady.telemetry).toMatchObject({
      state: "active",
      gpuTimingSupported: false,
      runtimeSpikesOver50Ms: 0,
    });
    expect(steady.telemetry.frameIntervalMs.sampleCount).toBeGreaterThanOrEqual(120);
    expect(steady.telemetry.frameIntervalMs.p50).not.toBeNull();
    expect(steady.telemetry.frameIntervalMs.p95).not.toBeNull();
    expect(steady.telemetry.frameIntervalMs.p99).not.toBeNull();
    expect(steady.telemetry.mainThreadWorkMs.sampleCount).toBeGreaterThanOrEqual(120);
    expect(steady.telemetry.mainThreadWorkMs.p95).not.toBeNull();
    expect(steady.telemetry.gpuTimeMs).toMatchObject({
      sampleCount: 0,
      p50: null,
      p95: null,
      p99: null,
    });
    expect(steady.telemetry.eventTotals).toMatchObject({
      initialization: 1,
      compile: 1,
      upload: 32,
      activation: 4,
    });
    expect(steady.telemetry.latestFrame).toMatchObject({
      submitted: true,
      passCount: 1,
      transparentPasses: 0,
      fullscreenPasses: 0,
      renderer: {
        available: true,
        gpuTimeMs: null,
      },
      resources: { pendingUploads: 0 },
    });
    expect(steady.telemetry.latestFrame?.renderer.drawCalls).not.toBeNull();
    expect(steady.telemetry.latestFrame?.renderer.triangles).not.toBeNull();
    expect(steady.telemetry.latestFrame?.renderer.drawingBufferWidth).toBeGreaterThan(0);
    expect(steady.telemetry.latestFrame?.renderer.drawingBufferHeight).toBeGreaterThan(0);
    expectNoSteadyOperationalSpike(steady);
    await testInfo.attach("webgl2-steady-telemetry", {
      body: Buffer.from(JSON.stringify(steady.telemetry)),
      contentType: "application/json",
    });

    const baselinePrograms = initial.pipeline.programCountAtReady;
    const baselineGeometries = initial.backendLifecycle.resources.geometries;

    await page.getByRole("button", { name: "Seek S21" }).click();
    const afterSeek = await waitForSnapshot(page, (value) => (
      value.chunks.focusChunkId === "S21"
      && sorted(value.chunks.activeChunkIds).join(",") === "S20,S21,S22,S23"
      && value.chunks.uploadQueue.pending === 0
    ));
    expect(afterSeek.chunks.gpuOwnedCount).toBe(4);
    expect(afterSeek.logicalResources.owners).toBe(4);
    expect(afterSeek.uploader.activeLeases).toBe(4);
    expect(afterSeek.pipeline.programGrowthAfterReady).toBe(0);
    expect(afterSeek.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(afterSeek.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    const generatedBeforeQuality = afterSeek.chunks.events.filter(
      (event) => event.kind === "worker" && event.name === "generated",
    ).length;

    for (const [button, quality] of [
      ["Low", "low-static"],
      ["Balanced", "balanced-static"],
      ["High", "high-temporal"],
    ] as const) {
      await page.getByRole("button", { name: button, exact: true }).click();
      const changed = await waitForSnapshot(page, (value) => value.quality.id === quality);
      expect(changed.pipeline.programGrowthAfterReady).toBe(0);
      expect(changed.pipeline.programCountAtReady).toBe(baselinePrograms);
      expect(changed.backendLifecycle.resources.geometries).toBe(baselineGeometries);
      expect(changed.chunks.gpuOwnedCount).toBeLessThanOrEqual(4);
    }
    const afterQuality = await snapshot(page);
    expect(afterQuality.chunks.events.filter(
      (event) => event.kind === "worker" && event.name === "generated",
    )).toHaveLength(generatedBeforeQuality);
    expect(afterQuality.telemetry.eventTotals.compile).toBe(1);

    await page.getByRole("button", { name: "Seek S08" }).click();
    await page.getByRole("button", { name: "Seek S24" }).click();
    await page.getByRole("button", { name: "Seek S08" }).click();
    const afterRapidSeek = await waitForSnapshot(page, (value) => (
      value.chunks.focusChunkId === "S08"
      && sorted(value.chunks.activeChunkIds).join(",") === "S07,S08,S09,S10"
      && value.chunks.uploadQueue.pending === 0
      && value.chunks.workerInboxCount === 0
    ));
    expect(afterRapidSeek.chunks.gpuOwnedCount).toBe(4);
    expect(afterRapidSeek.chunks.uploadQueue.failed).toBe(0);
    expect(afterRapidSeek.chunks.uploadQueue.orphanJobCount).toBe(0);
    expect(afterRapidSeek.chunks.uploadQueue.orphanLeaseCount).toBe(0);
    expect(afterRapidSeek.pipeline.programGrowthAfterReady).toBe(0);
    expect(afterRapidSeek.backendLifecycle.resources.geometries).toBe(baselineGeometries);

    const cdp = await page.context().newCDPSession(page);
    const restartEvidence: Array<Readonly<Record<string, number>>> = [];
    try {
      for (let cycle = 1; cycle <= 10; cycle += 1) {
        await page.getByRole("button", { name: "Seek S24" }).click();
        await waitForSnapshot(page, (value) => (
          value.chunks.focusChunkId === "S24"
          && sorted(value.chunks.activeChunkIds).join(",") === "S23,S24"
          && value.chunks.uploadQueue.pending === 0
          && value.chunks.workerInboxCount === 0
        ));
        await page.getByRole("button", { name: "Seek S08" }).click();
        const restarted = await waitForSnapshot(page, (value) => (
          value.chunks.focusChunkId === "S08"
          && sorted(value.chunks.activeChunkIds).join(",") === "S07,S08,S09,S10"
          && value.chunks.uploadQueue.pending === 0
          && value.chunks.workerInboxCount === 0
        ));
        await cdp.send("HeapProfiler.collectGarbage");
        const heap = await cdp.send("Runtime.getHeapUsage") as {
          readonly usedSize: number;
          readonly totalSize: number;
        };
        expect(restarted.pipeline.programCountAtReady).toBe(baselinePrograms);
        expect(restarted.pipeline.programGrowthAfterReady).toBe(0);
        expect(restarted.backendLifecycle.resources.geometries).toBe(baselineGeometries);
        expect(restarted.chunks.gpuOwnedCount).toBe(4);
        expect(restarted.logicalResources).toMatchObject({ owners: 4 });
        expect(restarted.uploader).toMatchObject({
          poolSlots: 4,
          activeLeases: 4,
          ownedGeometries: 1,
          ownedObjects: 32,
        });
        restartEvidence.push(Object.freeze({
          cycle,
          heapUsedBytes: heap.usedSize,
          heapTotalBytes: heap.totalSize,
          programs: restarted.backendLifecycle.resources.programs,
          geometries: restarted.backendLifecycle.resources.geometries,
          gpuOwnedCount: restarted.chunks.gpuOwnedCount,
          logicalOwners: restarted.logicalResources.owners,
          poolSlots: restarted.uploader.poolSlots,
        }));
      }
    } finally {
      await cdp.detach();
    }
    const plateauTail = restartEvidence.slice(-5).map((entry) => entry.heapUsedBytes);
    expect(Math.max(...plateauTail) - Math.min(...plateauTail)).toBeLessThanOrEqual(
      16 * 1_024 * 1_024,
    );
    const afterRestarts = await snapshot(page);
    expect(afterRestarts.telemetry.eventTotals.compile).toBe(1);
    expectNoSteadyOperationalSpike(afterRestarts);
    await testInfo.attach("webgl2-ten-restart-plateau", {
      body: Buffer.from(JSON.stringify(restartEvidence)),
      contentType: "application/json",
    });

    await page.getByRole("button", { name: "Dispose runtime" }).click();
    await expect(page.getByTestId("gfx-foundation")).toHaveAttribute("data-status", "disposed");
    const disposed = await waitForSnapshot(page, (value) => (
      value.host.lifecycle === "disposed"
      && value.backendLifecycle.state === "disposed"
      && value.pipeline.state === "disposed"
      && value.materials.state === "disposed"
      && value.chunks.disposed
      && value.uploader.disposed
      && value.logicalResources.disposed
    ));
    expect(disposed.host.counters).toMatchObject({
      retainedRawFailureCauses: 0,
      retainedIntermediateFailureSnapshots: 0,
    });
    expect(disposed.backendLifecycle).toMatchObject({
      retainedFailureReferences: 0,
      eventBridgeActive: false,
    });
    expect(disposed.pipeline).toMatchObject({ graphCount: 0, cleanupPendingGraphs: 0 });
    expect(disposed.materials).toMatchObject({
      disposedMaterials: 14,
      ownedMaterials: 0,
      ownedGeometry: 0,
    });
    expect(disposed.chunks).toMatchObject({
      gpuOwnedCount: 0,
      workerInboxCount: 0,
    });
    expect(disposed.chunks.activeChunkIds).toEqual([]);
    expect(disposed.chunks.uploadQueue).toMatchObject({
      disposed: true,
      pending: 0,
      orphanLeaseCount: 0,
      orphanJobCount: 0,
      cleanupFailureCount: 0,
    });
    expect(disposed.uploader).toMatchObject({
      poolSlots: 0,
      activeLeases: 0,
      ownedGeometries: 0,
      ownedObjects: 0,
    });
    expect(disposed.logicalResources).toMatchObject({ owners: 0, bytes: 0 });
    expect(disposed.logicalResources.resources.objects).toBe(0);
    expect(disposed.frameLoop.running).toBe(false);
    expect(disposed.scene).toMatchObject({ objects: 0, meshes: 0, children: 0 });
    expect(disposed.runtime).toMatchObject({
      resizeListenerActive: false,
      subscribers: 0,
      disposeCalls: 1,
    });
    expect(disposed.telemetry).toMatchObject({
      state: "disposed",
      runtimeSpikesOver50Ms: 0,
    });
    lifecycleEvidence.push(Object.freeze({
      generation: disposed.generation,
      submittedFrames: disposed.host.counters.submittedFrames,
      gpuOwnedCount: disposed.chunks.gpuOwnedCount,
      logicalOwners: disposed.logicalResources.owners,
      poolSlots: disposed.uploader.poolSlots,
      backendRetainedFailureReferences: disposed.backendLifecycle.retainedFailureReferences,
      telemetryState: disposed.telemetry.state,
      runtimeSpikesOver50Ms: disposed.telemetry.runtimeSpikesOver50Ms,
    }));
    await expect.poll(() => page.workers().length).toBe(0);
    expect(closedWorkerUrls).toContain(openedWorkers[0]!.url());

    await page.getByRole("button", { name: "Recreate runtime" }).evaluate((button) => {
      const control = button as HTMLButtonElement;
      control.click();
      control.click();
    });
    await expect(page.getByTestId("gfx-foundation")).toHaveAttribute("data-generation", "2");
    const recreated = await waitForSnapshot(page, (value) => (
      value.generation === 2
      && value.host.lifecycle === "ready"
      && value.chunks.activeChunkIds.length === 4
      && value.chunks.gpuOwnedCount === 4
    ));
    expect(recreated.pipeline.programGrowthAfterReady).toBe(0);
    expect(recreated.chunks.uploadQueue.failed).toBe(0);
    expect(openedWorkers).toHaveLength(2);
    expect(page.workers()).toHaveLength(1);

    let live = recreated;
    for (let generation = 2; generation <= 10; generation += 1) {
      expect(live.generation).toBe(generation);
      expect(live.host.counters.submittedFrames).toBeGreaterThan(0);
      expect(live.chunks.activeChunkIds).toHaveLength(4);
      expect(live.chunks.gpuOwnedCount).toBe(4);
      expect(live.pipeline.programGrowthAfterReady).toBe(0);

      await page.getByRole("button", { name: "Dispose runtime" }).click();
      const terminal = await waitForSnapshot(page, (value) => (
        value.generation === generation
        && value.host.lifecycle === "disposed"
        && value.backendLifecycle.state === "disposed"
        && value.pipeline.state === "disposed"
        && value.materials.state === "disposed"
        && value.chunks.disposed
        && value.uploader.disposed
        && value.logicalResources.disposed
      ));
      expect(terminal.host.counters).toMatchObject({
        retainedRawFailureCauses: 0,
        retainedIntermediateFailureSnapshots: 0,
      });
      expect(terminal.backendLifecycle.retainedFailureReferences).toBe(0);
      expect(terminal.chunks).toMatchObject({ gpuOwnedCount: 0, workerInboxCount: 0 });
      expect(terminal.chunks.uploadQueue).toMatchObject({
        pending: 0,
        orphanLeaseCount: 0,
        orphanJobCount: 0,
        cleanupFailureCount: 0,
      });
      expect(terminal.uploader).toMatchObject({
        poolSlots: 0,
        activeLeases: 0,
        ownedGeometries: 0,
        ownedObjects: 0,
      });
      expect(terminal.logicalResources).toMatchObject({ owners: 0, bytes: 0 });
      expect(terminal.telemetry).toMatchObject({
        state: "disposed",
        runtimeSpikesOver50Ms: 0,
      });
      lifecycleEvidence.push(Object.freeze({
        generation: terminal.generation,
        submittedFrames: terminal.host.counters.submittedFrames,
        gpuOwnedCount: terminal.chunks.gpuOwnedCount,
        logicalOwners: terminal.logicalResources.owners,
        poolSlots: terminal.uploader.poolSlots,
        backendRetainedFailureReferences: terminal.backendLifecycle.retainedFailureReferences,
        telemetryState: terminal.telemetry.state,
        runtimeSpikesOver50Ms: terminal.telemetry.runtimeSpikesOver50Ms,
      }));
      await expect.poll(() => page.workers().length).toBe(0);

      if (generation === 10) break;
      await page.getByRole("button", { name: "Recreate runtime" }).click();
      live = await waitForSnapshot(page, (value) => (
        value.generation === generation + 1
        && value.host.lifecycle === "ready"
        && value.host.counters.submittedFrames > 0
        && value.chunks.activeChunkIds.length === 4
        && value.chunks.gpuOwnedCount === 4
        && value.chunks.uploadQueue.pending === 0
      ));
    }
    expect(openedWorkers).toHaveLength(10);
    expect(closedWorkerUrls).toHaveLength(10);
    await testInfo.attach("webgl2-ten-cycle-lifecycle", {
      body: Buffer.from(JSON.stringify(lifecycleEvidence)),
      contentType: "application/json",
    });
  });

  test("keeps the host Metal WebGPU quality graph warm and releases every owner", async ({ browserName }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "single desktop WebGPU acceptance");
    test.setTimeout(60_000);
    expect(browserName).toBe("chromium");
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error("The foundation WebGPU gate requires a configured baseURL.");
    }

    const browser = await chromium.launch({
      headless: true,
      args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=metal"],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const runtimeErrors: string[] = [];
      page.on("pageerror", (error) => runtimeErrors.push(error.message));
      page.on("console", (entry) => {
        if (entry.type() === "error") runtimeErrors.push(entry.text());
      });
      await page.goto(new URL("/gfx-foundation?backend=webgpu&qa=1", baseURL).toString());
      await expect(page.getByTestId("gfx-foundation")).toHaveAttribute(
        "data-status",
        "ready",
        { timeout: 30_000 },
      );
      await expect(page.getByTestId("gfx-foundation")).toHaveAttribute(
        "data-actual-backend",
        "webgpu",
      );

      const initial = await waitForSnapshot(page, (value) => (
        value.host.lifecycle === "ready"
        && value.chunks.activeChunkIds.length === 4
        && value.chunks.gpuOwnedCount === 4
        && value.chunks.uploadQueue.pending === 0
      ));
      expect(initial.planDigest).toBe(FOUNDATION_PLAN_DIGEST);
      expect(generatedChunkDigests(initial, INITIAL_CHUNK_IDS)).toEqual(INITIAL_CHUNK_DIGESTS);
      expect(initial.pipeline).toMatchObject({
        state: "ready",
        graphCount: 5,
        programGrowthAfterReady: 0,
        cleanupPendingGraphs: 0,
      });
      expect(initial.pipeline.warmedProfileIds).toHaveLength(5);
      expect(sorted(initial.materials.variants)).toEqual(
        sorted(["webgpu-full", "webgpu-lean"]),
      );
      expect(page.workers()).toHaveLength(1);
      const baselinePrograms = initial.pipeline.programCountAtReady;
      const baselineGeometries = initial.backendLifecycle.resources.geometries;

      const steady = await waitForSnapshot(page, (value) => (
        value.telemetry.window.steadyFrames >= 120
      ));
      expect(steady.telemetry.frameIntervalMs.p95).not.toBeNull();
      expect(steady.telemetry.mainThreadWorkMs.p95).not.toBeNull();
      expect(steady.telemetry.gpuTimeMs.p95).toBeNull();
      expect(steady.telemetry.runtimeSpikesOver50Ms).toBe(0);
      expect(steady.telemetry.latestFrame).toMatchObject({
        submitted: true,
        passCount: 1,
        renderer: { available: true, gpuTimeMs: null },
      });
      expect(steady.telemetry.latestFrame?.renderer.drawCalls).not.toBeNull();
      expect(steady.telemetry.latestFrame?.renderer.triangles).not.toBeNull();
      expectNoSteadyOperationalSpike(steady);
      await testInfo.attach("webgpu-steady-telemetry", {
        body: Buffer.from(JSON.stringify(steady.telemetry)),
        contentType: "application/json",
      });

      const generatedBeforeQuality = steady.chunks.events.filter(
        (event) => event.kind === "worker" && event.name === "generated",
      ).length;
      for (const [button, quality] of [
        ["Low", "low-static"],
        ["Balanced", "balanced-static"],
        ["High", "high-temporal"],
      ] as const) {
        await page.getByRole("button", { name: button, exact: true }).click();
        const changed = await waitForSnapshot(page, (value) => value.quality.id === quality);
        expect(changed.pipeline.programGrowthAfterReady).toBe(0);
        expect(changed.pipeline.programCountAtReady).toBe(baselinePrograms);
        expect(changed.backendLifecycle.resources.geometries).toBe(baselineGeometries);
        expect(changed.chunks.gpuOwnedCount).toBeLessThanOrEqual(4);
      }
      const afterQuality = await snapshot(page);
      expect(afterQuality.chunks.events.filter(
        (event) => event.kind === "worker" && event.name === "generated",
      )).toHaveLength(generatedBeforeQuality);
      expect(afterQuality.telemetry.eventTotals.compile).toBe(1);
      await page.waitForTimeout(2_500);
      await expect(page.getByTestId("gfx-foundation")).toHaveAttribute("data-status", "ready");
      expect(runtimeErrors).toEqual([]);

      await page.getByRole("button", { name: "Dispose runtime" }).click();
      const disposed = await waitForSnapshot(page, (value) => (
        value.host.lifecycle === "disposed"
        && value.backendLifecycle.state === "disposed"
        && value.pipeline.state === "disposed"
        && value.materials.state === "disposed"
        && value.chunks.disposed
      ));
      expect(disposed.host.counters).toMatchObject({
        retainedRawFailureCauses: 0,
        retainedIntermediateFailureSnapshots: 0,
      });
      expect(disposed.backendLifecycle).toMatchObject({
        retainedFailureReferences: 0,
        eventBridgeActive: false,
      });
      expect(disposed.pipeline).toMatchObject({
        graphCount: 0,
        programGrowthAfterReady: 0,
        cleanupPendingGraphs: 0,
      });
      expect(disposed.materials).toMatchObject({
        disposedMaterials: 14,
        ownedMaterials: 0,
        ownedGeometry: 0,
      });
      expect(disposed.chunks).toMatchObject({ gpuOwnedCount: 0, workerInboxCount: 0 });
      expect(disposed.uploader).toMatchObject({
        poolSlots: 0,
        activeLeases: 0,
        ownedGeometries: 0,
        ownedObjects: 0,
      });
      expect(disposed.logicalResources).toMatchObject({ owners: 0, bytes: 0 });
      expect(disposed.scene).toMatchObject({ objects: 0, meshes: 0, children: 0 });
      expect(disposed.telemetry).toMatchObject({ state: "disposed", runtimeSpikesOver50Ms: 0 });
      await expect.poll(() => page.workers().length).toBe(0);
      expect(runtimeErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
