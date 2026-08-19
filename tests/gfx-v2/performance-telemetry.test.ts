import { describe, expect, it } from "vitest";
import type { GfxFrameTelemetryInput } from "../../src/gfx/v2/telemetry";
import {
  EMPTY_BACKEND_FRAME,
  GFX_TELEMETRY_EVENT_CAPACITY,
  RollingGfxPerformanceTelemetry,
} from "../../src/gfx/v2/telemetry";

const resources = Object.freeze({
  geometries: 1,
  textures: 2,
  renderTargets: 3,
  programs: 4,
  nodes: 5,
  objects: 6,
  subscribers: 1,
  pendingUploads: 0,
});

function frame(
  frameId: number,
  value: number,
  gpuTimeMs: number | null = null,
): Readonly<GfxFrameTelemetryInput> {
  return Object.freeze({
    frameId,
    rafTimestampMs: value,
    storyTime: value / 1_000,
    qualityTier: "high",
    backendApi: "WebGPU",
    mainThreadWorkMs: value,
    submitted: true,
    passCount: 2,
    transparentPasses: 1,
    fullscreenPasses: 1,
    renderer: Object.freeze({ ...EMPTY_BACKEND_FRAME, gpuTimeMs }),
    resources,
  });
}

describe("GFX-006 rolling performance telemetry", () => {
  it("uses nearest-rank P50/P95/P99 over the unfiltered last 600 steady frames", () => {
    const telemetry = new RollingGfxPerformanceTelemetry();
    for (let index = 1; index <= 601; index += 1) telemetry.recordFrame(frame(index, index));

    const snapshot = telemetry.snapshot();
    expect(snapshot.window).toEqual({
      capacity: 600,
      minimumPercentileSamples: 120,
      retainedFrames: 600,
      steadyFrames: 600,
      excludedOperationalFrames: 0,
      totalFramesObserved: 601,
    });
    expect(snapshot.mainThreadWorkMs).toEqual({
      sampleCount: 600,
      p50: 301,
      p95: 571,
      p99: 595,
    });
    expect(snapshot.frameIntervalMs).toEqual({
      sampleCount: 600,
      p50: 1,
      p95: 1,
      p99: 1,
    });
  });

  it("publishes null percentiles below 120 samples and keeps unsupported GPU timing null", () => {
    const telemetry = new RollingGfxPerformanceTelemetry();
    for (let index = 0; index < 119; index += 1) telemetry.recordFrame(frame(index, index * 16));
    expect(telemetry.snapshot()).toMatchObject({
      frameIntervalMs: { sampleCount: 118, p50: null, p95: null, p99: null },
      mainThreadWorkMs: { sampleCount: 119, p50: null, p95: null, p99: null },
      gpuTimeMs: { sampleCount: 0, p50: null, p95: null, p99: null },
      gpuTimingSupported: false,
    });
    telemetry.recordFrame(frame(119, 119 * 16));
    expect(telemetry.snapshot().mainThreadWorkMs).toMatchObject({ sampleCount: 120, p50: 944 });
    expect(telemetry.snapshot().gpuTimeMs.p50).toBeNull();
  });

  it("keeps dropped RAF intervals unfiltered without inventing main-thread samples", () => {
    const telemetry = new RollingGfxPerformanceTelemetry();
    for (let index = 0; index < 121; index += 1) {
      telemetry.recordFrame(Object.freeze({
        ...frame(index, index * 16),
        submitted: index % 2 === 0,
      }));
    }
    const snapshot = telemetry.snapshot();
    expect(snapshot.window).toMatchObject({
      retainedFrames: 121,
      steadyFrames: 121,
      excludedOperationalFrames: 0,
    });
    expect(snapshot.frameIntervalMs).toEqual({
      sampleCount: 120,
      p50: 16,
      p95: 16,
      p99: 16,
    });
    expect(snapshot.mainThreadWorkMs).toEqual({
      sampleCount: 61,
      p50: null,
      p95: null,
      p99: null,
    });
  });

  it("excludes upload and activation frames without filtering other slow steady samples", () => {
    const telemetry = new RollingGfxPerformanceTelemetry();
    for (let index = 0; index < 130; index += 1) {
      telemetry.recordFrame(frame(index, index * 16));
    }
    telemetry.recordOperation(Object.freeze({
      kind: "upload",
      name: "chunk-s08-slice",
      startedAtMs: 0,
      durationMs: 2,
      frameId: 5,
      storyTime: 1,
      success: true,
      affectsStoryTime: true,
    }));
    telemetry.recordOperation(Object.freeze({
      kind: "activation",
      name: "chunk-s08-active",
      startedAtMs: 0,
      durationMs: 55,
      frameId: 131,
      storyTime: 1,
      success: true,
      affectsStoryTime: true,
    }));
    telemetry.recordFrame(frame(131, 10_000));
    telemetry.recordFrame(frame(132, 20_000));
    telemetry.recordFrame(frame(133, 30_000));

    const snapshot = telemetry.snapshot();
    expect(snapshot.window).toMatchObject({
      retainedFrames: 133,
      steadyFrames: 131,
      excludedOperationalFrames: 2,
    });
    expect(snapshot.runtimeSpikesOver50Ms).toBe(1);
    expect(snapshot.latestFrame).toMatchObject({
      frameId: 133,
      frameIntervalMs: 10_000,
      steadyState: true,
    });
    expect(snapshot.frameIntervalMs.p99).toBe(10_000);
  });

  it("records quality and exact history reset reasons separately from frame percentiles", () => {
    const telemetry = new RollingGfxPerformanceTelemetry();
    telemetry.recordOperation(Object.freeze({
      kind: "quality-change",
      name: "high-to-low",
      startedAtMs: 10,
      durationMs: 1,
      frameId: null,
      storyTime: 5,
      success: true,
      affectsStoryTime: true,
    }));
    telemetry.recordOperation(Object.freeze({
      kind: "history-reset",
      name: "story-cut-s21",
      startedAtMs: 11,
      durationMs: 0,
      frameId: null,
      storyTime: 161,
      success: true,
      affectsStoryTime: true,
      historyReason: "story-cut-s21",
    }));

    const snapshot = telemetry.snapshot();
    expect(snapshot.eventTotals).toMatchObject({
      "quality-change": 1,
      "history-reset": 1,
    });
    expect(snapshot.historyResetCounts["story-cut-s21"]).toBe(1);
    expect(snapshot.runtimeSpikesOver50Ms).toBe(0);
    expect(Object.isFrozen(snapshot.events)).toBe(true);
    expect(Object.isFrozen(snapshot.events[0])).toBe(true);
  });

  it("bounds retained operation events and preserves final evidence after dispose", () => {
    const telemetry = new RollingGfxPerformanceTelemetry();
    for (let index = 0; index < GFX_TELEMETRY_EVENT_CAPACITY + 3; index += 1) {
      telemetry.recordOperation(Object.freeze({
        kind: "compile",
        name: `compile-${index}`,
        startedAtMs: index,
        durationMs: 100,
        frameId: null,
        storyTime: null,
        success: true,
        affectsStoryTime: false,
      }));
    }
    telemetry.dispose();
    telemetry.recordFrame(frame(1, 16));
    const snapshot = telemetry.snapshot();
    expect(snapshot.state).toBe("disposed");
    expect(snapshot.events).toHaveLength(GFX_TELEMETRY_EVENT_CAPACITY);
    expect(snapshot.events[0]?.sequence).toBe(4);
    expect(snapshot.runtimeSpikesOver50Ms).toBe(0);
    expect(snapshot.window.totalFramesObserved).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("rejects accessor-backed inputs without invoking getters", () => {
    const telemetry = new RollingGfxPerformanceTelemetry();
    let getterCalls = 0;
    const hostile = { ...frame(1, 16) } as Record<string, unknown>;
    Object.defineProperty(hostile, "frameId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    expect(() => telemetry.recordFrame(
      hostile as unknown as Readonly<GfxFrameTelemetryInput>,
    )).toThrow(/own data property/);
    expect(getterCalls).toBe(0);
    expect(telemetry.snapshot().window.totalFramesObserved).toBe(0);
  });

  it("reserves ingress before descriptor traps and keeps disposal terminal", () => {
    const telemetry = new RollingGfxPerformanceTelemetry();
    let nestedFailure: unknown;
    let nestedGetterCalls = 0;
    const nested = { ...frame(2, 32) } as Record<string, unknown>;
    Object.defineProperty(nested, "frameId", {
      enumerable: true,
      get() {
        nestedGetterCalls += 1;
        return 2;
      },
    });
    let trapCalls = 0;
    const hostile = new Proxy(frame(1, 16), {
      getOwnPropertyDescriptor(target, key) {
        trapCalls += 1;
        if (key === "frameId") {
          try {
            telemetry.recordFrame(nested as unknown as Readonly<GfxFrameTelemetryInput>);
          } catch (error: unknown) {
            nestedFailure = error;
          }
          telemetry.dispose();
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    telemetry.recordFrame(hostile);
    expect(trapCalls).toBeGreaterThan(0);
    expect(nestedFailure).toMatchObject({ message: "Telemetry ingress cannot reenter." });
    expect(nestedGetterCalls).toBe(0);
    expect(telemetry.snapshot()).toMatchObject({
      state: "disposed",
      window: { retainedFrames: 0, totalFramesObserved: 0 },
      latestFrame: null,
    });
  });

  it("rejects signed-zero counters and non-monotonic frame identity atomically", () => {
    const telemetry = new RollingGfxPerformanceTelemetry();
    expect(() => telemetry.recordFrame(Object.freeze({
      ...frame(0, 0),
      frameId: -0,
    }))).toThrow(/non-negative safe integer/);
    expect(telemetry.snapshot().window.totalFramesObserved).toBe(0);

    telemetry.recordFrame(frame(1, 16));
    expect(() => telemetry.recordFrame(frame(1, 32))).toThrow(/increase strictly/);
    expect(() => telemetry.recordFrame(frame(2, 15))).toThrow(/must not move backwards/);
    expect(telemetry.snapshot()).toMatchObject({
      window: { totalFramesObserved: 1 },
      latestFrame: { frameId: 1, rafTimestampMs: 16 },
    });
  });
});
