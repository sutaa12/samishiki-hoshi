import { describe, expect, it } from "vitest";
import type {
  JourneyRenderSnapshot,
  RenderBackendAdapter,
  RenderFeature,
  RenderFrameLoop,
  RenderHostDependencies,
  RenderOperationClock,
  RenderPassRecorder,
  RenderPrecompileReceipt,
  RenderQualityProfile,
  RendererApi,
} from "../../src/gfx/v2/contracts";
import { RenderHost } from "../../src/gfx/v2/render-host";
import { RollingGfxPerformanceTelemetry } from "../../src/gfx/v2/telemetry";

const HIGH = Object.freeze({
  tier: "high",
  pixelRatio: 1,
  uploadBudgetMs: 4,
  features: Object.freeze({ temporal: true }),
}) satisfies Readonly<RenderQualityProfile>;

const LOW = Object.freeze({
  tier: "low",
  pixelRatio: 0.75,
  uploadBudgetMs: 2,
  features: Object.freeze({ temporal: false }),
}) satisfies Readonly<RenderQualityProfile>;

const JOURNEY = Object.freeze({
  seed: 20_260_818,
  storyTime: 12,
  phase: "LIFE",
  shotId: "S03",
  position: Object.freeze({ x: 0, y: 0 }),
  velocity: Object.freeze({ x: 0, y: 0 }),
  pulses: Object.freeze([]),
  answerAt: null,
  finished: false,
}) satisfies Readonly<JourneyRenderSnapshot>;

const ONE_RUNTIME_PRECOMPILE_RECEIPT = Object.freeze({
  plannedSteps: 1,
  completedSteps: 1,
  phaseCounts: Object.freeze({
    "runtime-object": 1,
    "material-isolated": 0,
    "material-runtime-topology": 0,
    "output-first-use": 0,
  }),
}) satisfies Readonly<RenderPrecompileReceipt>;

class TestFrameLoop implements RenderFrameLoop {
  running = false;
  #callback: ((nowMs: number) => void) | null = null;

  start(callback: (nowMs: number) => void): void {
    this.running = true;
    this.#callback = callback;
  }

  stop(): void {
    this.running = false;
    this.#callback = null;
  }

  tick(nowMs: number): void {
    this.#callback?.(nowMs);
  }
}

function dependencies(
  frameLoop: TestFrameLoop,
  renderGate?: Promise<void>,
): RenderHostDependencies {
  const resources = Object.freeze({
    geometries: 2,
    textures: 3,
    renderTargets: 4,
    programs: 5,
    nodes: 6,
    objects: 7,
    subscribers: 1,
    pendingUploads: 0,
  });
  const backend: RenderBackendAdapter = {
    facts: Object.freeze({
      requestedApi: "WebGPU",
      actualApi: "WebGPU",
      adapter: "telemetry-test",
      device: "telemetry-test",
      fallback: false,
    }),
    async initialize(): Promise<void> {},
    resize(): void {},
    async precompile(_passes, runner): Promise<Readonly<RenderPrecompileReceipt>> {
      await runner.run(Object.freeze({
        id: "telemetry:p0:o0",
        phase: "runtime-object",
        profileId: null,
      }), async () => undefined);
      return ONE_RUNTIME_PRECOMPILE_RECEIPT;
    },
    async render(): Promise<void> {
      await renderGate;
    },
    subscribeEvents: () => () => undefined,
    snapshotResources: () => resources,
    snapshotFrameTelemetry: () => Object.freeze({
      available: true,
      drawCalls: 8,
      triangles: 144,
      lines: 2,
      points: 1,
      pixelRatio: 1,
      drawingBufferWidth: 1280,
      drawingBufferHeight: 720,
      gpuTimeMs: null,
    }),
    async dispose(): Promise<void> {},
  };
  const feature: RenderFeature = {
    id: "telemetry-feature",
    async initialize(): Promise<void> {},
    update(): void {},
    render(recorder: RenderPassRecorder): void {
      recorder.record({ name: "world", kind: "transparent-scene" });
      recorder.record({ name: "composite", kind: "fullscreen-post" });
    },
    quality(): void {},
    invalidateHistory(): void {},
    async dispose(): Promise<void> {},
  };
  return {
    backend,
    frameLoop,
    warmupScheduler: { yieldToMain: async () => undefined },
    features: [feature],
    materials: {
      initialize(): void {},
      warmupPasses: () => [],
      quality(): void {},
      dispose(): void {},
    },
    uploads: {
      initialize(): void {},
      quality(): void {},
      flush(): void {},
      pendingCount: () => 0,
      dispose(): void {},
    },
    resources: {
      initialize(): void {},
      snapshot: () => resources,
      dispose(): void {},
    },
    qualityProvider: {
      getProfile: () => HIGH,
      subscribe: () => () => undefined,
    },
    observer: { observe(): void {} },
  };
}

function operationClockDependencies(
  frameLoop: TestFrameLoop,
  actualApi: RendererApi,
  initialQuality: Readonly<RenderQualityProfile>,
  captures: {
    readonly uploads: Readonly<RenderOperationClock>[];
    readonly features: Array<Readonly<{
      frameStoryTime: number;
      clock: Readonly<RenderOperationClock>;
    }>>;
  },
): RenderHostDependencies {
  const base = dependencies(frameLoop);
  const baseFeature = base.features[0]!;
  return {
    ...base,
    backend: {
      ...base.backend,
      facts: Object.freeze({
        requestedApi: actualApi,
        actualApi,
        adapter: `telemetry-${actualApi.toLowerCase()}`,
        device: `telemetry-${actualApi.toLowerCase()}`,
        fallback: false,
      }),
    },
    features: [
      {
        ...baseFeature,
        update(frame, clock): void {
          captures.features.push(Object.freeze({
            frameStoryTime: frame.storyTime,
            clock,
          }));
        },
      },
    ],
    uploads: {
      ...base.uploads,
      flush(clock): void {
        captures.uploads.push(clock);
      },
    },
    qualityProvider: {
      ...base.qualityProvider,
      getProfile: () => initialQuality,
    },
  };
}

describe("GFX-006 RenderHost telemetry integration", () => {
  it("records initialization, compile, history, quality, and exact frame diagnostics", async () => {
    const frameLoop = new TestFrameLoop();
    const telemetry = new RollingGfxPerformanceTelemetry();
    let nowMs = 100;
    const host = new RenderHost(
      dependencies(frameLoop),
      Object.freeze({ telemetry, now: () => ++nowMs }),
    );

    await host.initialize(JOURNEY, { width: 1280, height: 720, pixelRatio: 1 });
    frameLoop.tick(16);
    await host.whenIdle();
    frameLoop.tick(32);
    await host.whenIdle();
    await host.setQuality(LOW);

    const snapshot = telemetry.snapshot();
    expect(snapshot.eventTotals).toMatchObject({
      initialization: 1,
      compile: 1,
      "quality-change": 1,
      "history-reset": 2,
    });
    expect(snapshot.historyResetCounts).toMatchObject({
      initialization: 1,
      "quality-change": 1,
    });
    expect(snapshot.latestFrame).toMatchObject({
      frameId: 1,
      rafTimestampMs: 32,
      frameIntervalMs: 16,
      storyTime: 12,
      qualityTier: "high",
      backendApi: "WebGPU",
      submitted: true,
      steadyState: true,
      passCount: 2,
      transparentPasses: 1,
      fullscreenPasses: 1,
      renderer: {
        available: true,
        drawCalls: 8,
        triangles: 144,
        gpuTimeMs: null,
      },
      resources: {
        geometries: 2,
        programs: 5,
        objects: 7,
        pendingUploads: 0,
      },
    });
    expect(snapshot.window).toMatchObject({
      totalFramesObserved: 2,
      steadyFrames: 2,
      excludedOperationalFrames: 0,
    });
    expect(snapshot.gpuTimingSupported).toBe(false);
    expect(snapshot.runtimeSpikesOver50Ms).toBe(0);

    await host.dispose();
    telemetry.dispose();
    expect(telemetry.snapshot().state).toBe("disposed");
  });

  it.each([
    { actualApi: "WebGPU" as const, initialQuality: HIGH, nextQuality: LOW },
    { actualApi: "WebGL2" as const, initialQuality: LOW, nextQuality: HIGH },
  ])("latches canonical story time through nonzero start, seek, restart, and pause on $actualApi", async ({
    actualApi,
    initialQuality,
    nextQuality,
  }) => {
    const frameLoop = new TestFrameLoop();
    const telemetry = new RollingGfxPerformanceTelemetry();
    const captures: {
      uploads: Readonly<RenderOperationClock>[];
      features: Array<Readonly<{
        frameStoryTime: number;
        clock: Readonly<RenderOperationClock>;
      }>>;
    } = { uploads: [], features: [] };
    let nowMs = 1_000;
    const host = new RenderHost(
      operationClockDependencies(frameLoop, actualApi, initialQuality, captures),
      Object.freeze({ telemetry, now: () => ++nowMs }),
    );
    const initial = Object.freeze({ ...JOURNEY, storyTime: 73.25 });
    await host.initialize(initial, { width: 1280, height: 720, pixelRatio: 1 });

    frameLoop.tick(100);
    await host.whenIdle();
    host.setSnapshot(
      Object.freeze({ ...JOURNEY, storyTime: 142.5, shotId: "S20", phase: "SOLITUDE" }),
      "restart-or-qa-seek",
    );
    await host.setQuality(nextQuality);
    frameLoop.tick(200);
    await host.whenIdle();
    host.setSnapshot(
      Object.freeze({ ...JOURNEY, storyTime: 0, shotId: "S01", phase: "LIFE" }),
      "restart-or-qa-seek",
    );
    frameLoop.tick(300);
    await host.whenIdle();
    frameLoop.tick(400);
    await host.whenIdle();

    expect(captures.uploads).toHaveLength(4);
    expect(captures.features).toHaveLength(4);
    expect(captures.uploads.map((clock) => clock.storyTime)).toEqual([73.25, 142.5, 0, 0]);
    expect(captures.uploads.map((clock) => clock.elapsedSeconds)).toEqual([0, 0.1, 0.2, 0.3]);
    for (let index = 0; index < captures.uploads.length; index += 1) {
      const uploadClock = captures.uploads[index]!;
      const featureCapture = captures.features[index]!;
      expect(featureCapture.clock).toBe(uploadClock);
      expect(featureCapture.frameStoryTime).toBe(uploadClock.storyTime);
      expect(Object.isFrozen(uploadClock)).toBe(true);
    }
    expect(telemetry.snapshot().latestFrame).toMatchObject({
      frameId: 3,
      storyTime: 0,
      qualityTier: nextQuality.tier,
      backendApi: actualApi,
    });
    await host.dispose();
  });

  it("contains telemetry failures without changing frame submission or lifecycle", async () => {
    const frameLoop = new TestFrameLoop();
    const hostileTelemetry = {
      recordFrame(): void {
        throw new Error("telemetry frame failure");
      },
      recordOperation(): void {
        throw new Error("telemetry operation failure");
      },
    };
    const host = new RenderHost(
      dependencies(frameLoop),
      Object.freeze({ telemetry: hostileTelemetry, now: () => 1 }),
    );

    await host.initialize(JOURNEY, { width: 1280, height: 720, pixelRatio: 1 });
    frameLoop.tick(16);
    await host.whenIdle();
    expect(host.state).toBe("ready");
    expect(host.getSnapshot().counters.submittedFrames).toBe(1);
    await host.dispose();
    expect(host.state).toBe("disposed");
  });

  it("retains a dropped RAF interval in callback order while an earlier frame drains", async () => {
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => { releaseRender = resolve; });
    const frameLoop = new TestFrameLoop();
    const telemetry = new RollingGfxPerformanceTelemetry();
    let nowMs = 0;
    const host = new RenderHost(
      dependencies(frameLoop, renderGate),
      Object.freeze({ telemetry, now: () => ++nowMs }),
    );

    await host.initialize(JOURNEY, { width: 1280, height: 720, pixelRatio: 1 });
    frameLoop.tick(16);
    await Promise.resolve();
    await Promise.resolve();
    host.setSnapshot(Object.freeze({ ...JOURNEY, storyTime: 20 }));
    frameLoop.tick(32);
    host.setSnapshot(Object.freeze({ ...JOURNEY, storyTime: 30 }));
    releaseRender();
    await host.whenIdle();
    expect(telemetry.snapshot().latestFrame).toMatchObject({
      frameId: 1,
      rafTimestampMs: 32,
      storyTime: 20,
      submitted: false,
    });
    frameLoop.tick(48);
    await host.whenIdle();

    const snapshot = telemetry.snapshot();
    expect(snapshot.window).toMatchObject({
      retainedFrames: 3,
      steadyFrames: 3,
      excludedOperationalFrames: 0,
      totalFramesObserved: 3,
    });
    expect(snapshot.frameIntervalMs.sampleCount).toBe(2);
    expect(snapshot.mainThreadWorkMs.sampleCount).toBe(2);
    expect(snapshot.latestFrame).toMatchObject({
      frameId: 2,
      rafTimestampMs: 48,
      frameIntervalMs: 16,
      storyTime: 30,
      submitted: true,
    });
    expect(host.getSnapshot().counters).toMatchObject({
      submittedFrames: 2,
      droppedFrames: 1,
    });
    await host.dispose();
  });

  it("rejects accessor-backed instrumentation without invoking its getter", () => {
    const frameLoop = new TestFrameLoop();
    let getterCalls = 0;
    const hostile = Object.defineProperty({ now: () => 0 }, "telemetry", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return new RollingGfxPerformanceTelemetry();
      },
    });
    expect(() => new RenderHost(
      dependencies(frameLoop),
      hostile as never,
    )).toThrow(/own data property/);
    expect(getterCalls).toBe(0);
  });
});
