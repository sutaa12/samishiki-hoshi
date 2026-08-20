import { describe, expect, it, vi } from "vitest";
import type {
  FeatureInitContext,
  JourneyRenderSnapshot,
  RenderHistoryInvalidation,
  RenderOperationClock,
  RenderPass,
  RenderPassRecorder,
  RenderQualityProfile,
  RenderViewport,
} from "../../src/gfx/v2/contracts";
import type {
  ChunkManagerLike,
  ChunkRuntimeSnapshot,
} from "../../src/gfx/v2/chunks/contracts";
import { WorldChunkRenderFeature } from "../../src/gfx/v2/chunks/world-chunk-feature";

const PROFILE: Readonly<RenderQualityProfile> = Object.freeze({
  tier: "high",
  pixelRatio: 1,
  uploadBudgetMs: 4,
  features: Object.freeze({ volumetrics: true }),
});

const CLOCK: Readonly<RenderOperationClock> = Object.freeze({
  frame: 1,
  nowMs: 16,
  deltaSeconds: 1 / 60,
  elapsedSeconds: 1 / 60,
  storyTime: 48,
});

function frame(shotId: string, storyTime = 48): JourneyRenderSnapshot {
  return {
    seed: 20_260_818,
    storyTime,
    phase: "EARTH",
    shotId,
    position: { x: 0.2, y: -0.4 },
    velocity: { x: 0.1, y: 0 },
    pulses: [],
    answerAt: null,
    finished: false,
  };
}

function emptyRuntimeSnapshot(): Readonly<ChunkRuntimeSnapshot> {
  return Object.freeze({
    initialized: true,
    disposed: false,
    planDigest: "world-plan-v1:test",
    focusChunkId: null,
    desiredChunkIds: Object.freeze([]),
    activeChunkIds: Object.freeze([]),
    placeholderChunkIds: Object.freeze([]),
    gpuOwnedCount: 0,
    generatingCount: 0,
    workerInboxCount: 0,
    uploadQueue: Object.freeze({
      initialized: true,
      disposed: false,
      pending: 0,
      activeJobId: null,
      completed: 0,
      cancelled: 0,
      failed: 0,
      totalUploadedBytes: 0,
      orphanLeaseCount: 0,
      orphanJobCount: 0,
      orphanOwnerIds: Object.freeze([]),
      cleanupFailureCount: 0,
      events: Object.freeze([]),
    }),
    chunks: Object.freeze([]),
    events: Object.freeze([]),
  });
}

function fakeManager() {
  return {
    initialize: vi.fn<ChunkManagerLike["initialize"]>(() => Promise.resolve()),
    setFocus: vi.fn<ChunkManagerLike["setFocus"]>(),
    update: vi.fn<ChunkManagerLike["update"]>(),
    quality: vi.fn<ChunkManagerLike["quality"]>(),
    snapshot: vi.fn<ChunkManagerLike["snapshot"]>(() => emptyRuntimeSnapshot()),
    dispose: vi.fn<ChunkManagerLike["dispose"]>(() => Promise.resolve()),
  } satisfies ChunkManagerLike;
}

function recorder(): RenderPassRecorder & { readonly recorded: RenderPass[] } {
  const recorded: RenderPass[] = [];
  return {
    recorded,
    get passes() {
      return recorded;
    },
    record(pass) {
      recorded.push(pass);
    },
    draw(name, scene, camera, kind = "scene") {
      recorded.push({ name, scene, camera, kind });
    },
  };
}

describe("GFX-004 persistent world-chunk render feature", () => {
  it("records one stable pass and scene/camera identity across focus changes", async () => {
    const manager = fakeManager();
    const scene = Object.freeze({ id: "persistent-world-scene" });
    const camera = Object.freeze({ id: "persistent-world-camera" });
    const feature = new WorldChunkRenderFeature(manager, {
      name: "world-color",
      kind: "linear-hdr-scene",
      variant: "photoreal",
      scene,
      camera,
    });
    const target = recorder();

    feature.update(frame("S08"), CLOCK);
    feature.render(target);
    expect(manager.setFocus).not.toHaveBeenCalled();
    expect(target.recorded).toEqual([]);

    await feature.initialize({} as FeatureInitContext);
    const warmup = feature.warmupPasses([PROFILE]);
    feature.update(frame("S08"), CLOCK);
    feature.render(target);
    feature.update(frame("S09", 54), { ...CLOCK, frame: 2, nowMs: 32, storyTime: 54 });
    feature.render(target);
    feature.update(frame("S24", 178), { ...CLOCK, frame: 3, nowMs: 48, storyTime: 178 });
    feature.render(target);

    expect(manager.setFocus.mock.calls.map(([chunkId]) => chunkId)).toEqual(["S08", "S09", "S24"]);
    expect(manager.update).toHaveBeenCalledTimes(3);
    expect(warmup).toHaveLength(1);
    expect(target.recorded).toHaveLength(3);
    for (const pass of [...warmup, ...target.recorded]) {
      expect(pass).toBe(warmup[0]);
      expect(pass).toMatchObject({
        name: "world-color",
        kind: "linear-hdr-scene",
        variant: "photoreal",
      });
      expect(pass.scene).toBe(scene);
      expect(pass.camera).toBe(camera);
      expect(Reflect.has(pass, "payload")).toBe(false);
    }
  });

  it("forwards quality while resize and history invalidation preserve chunk state", async () => {
    const manager = fakeManager();
    const feature = new WorldChunkRenderFeature(manager, {
      name: "world-color",
      kind: "linear-hdr-scene",
      scene: {},
      camera: {},
    });
    await feature.initialize({} as FeatureInitContext);
    const before = manager.snapshot();
    const viewport: Readonly<RenderViewport> = Object.freeze({
      width: 390,
      height: 844,
      pixelRatio: 2,
    });
    const invalidation: Readonly<RenderHistoryInvalidation> = Object.freeze({
      reason: "restart-or-qa-seek",
      previousShotId: "S20",
      nextShotId: "S03",
      storyTime: 20,
    });

    feature.quality(PROFILE);
    feature.resize(viewport);
    feature.invalidateHistory(invalidation);

    expect(manager.quality).toHaveBeenCalledOnce();
    expect(manager.quality).toHaveBeenCalledWith(PROFILE);
    expect(manager.setFocus).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.snapshot()).toEqual(before);

    await feature.dispose();
    feature.quality(PROFILE);
    feature.update(frame("S08"), CLOCK);
    feature.render(recorder());
    expect(manager.dispose).toHaveBeenCalledOnce();
    expect(manager.quality).toHaveBeenCalledOnce();
    expect(manager.setFocus).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown story shot and mutable payload-bearing passes", async () => {
    const manager = fakeManager();
    expect(() => new WorldChunkRenderFeature(manager, {
      name: "world-color",
      kind: "linear-hdr-scene",
      payload: { chunk: "mutable" },
    })).toThrow(/cannot carry mutable per-frame payload/);

    const feature = new WorldChunkRenderFeature(manager, {
      name: "world-color",
      kind: "linear-hdr-scene",
    });
    await feature.initialize({} as FeatureInitContext);
    expect(() => feature.update(frame("S25"), CLOCK)).toThrow(/unknown chunk id/);
    expect(manager.setFocus).not.toHaveBeenCalled();

    expect(() => feature.update(frame("S08", 90), CLOCK)).toThrow(/must match the journey snapshot/);
    expect(manager.setFocus).not.toHaveBeenCalled();
  });

  it("captures persistent pass own data without ordinary reads or accessor execution", async () => {
    const manager = fakeManager();
    const scene = {};
    const camera = {};
    let ordinaryReads = 0;
    const pass = new Proxy({
      name: "world-color",
      kind: "linear-hdr-scene",
      scene,
      camera,
    }, {
      get() {
        ordinaryReads += 1;
        return "torn";
      },
    });
    const feature = new WorldChunkRenderFeature(manager, pass);
    await feature.initialize({} as FeatureInitContext);
    const target = recorder();
    feature.render(target);
    expect(ordinaryReads).toBe(0);
    expect(target.recorded[0]?.scene).toBe(scene);
    expect(target.recorded[0]?.camera).toBe(camera);

    let getterCalls = 0;
    const accessor = { kind: "linear-hdr-scene" } as Record<string, unknown>;
    Object.defineProperty(accessor, "name", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "world-color";
      },
    });
    expect(() => new WorldChunkRenderFeature(manager, accessor as unknown as RenderPass)).toThrow(/data property/);
    expect(getterCalls).toBe(0);
    await feature.dispose();
  });

  it("latches initialize and dispose identities across an initialization race", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = fakeManager();
    manager.initialize.mockImplementation(() => gate);
    const feature = new WorldChunkRenderFeature(manager, {
      name: "world-color",
      kind: "linear-hdr-scene",
    });
    const initialize = feature.initialize({} as FeatureInitContext);
    expect(feature.initialize({} as FeatureInitContext)).toBe(initialize);
    const dispose = feature.dispose();
    expect(feature.dispose()).toBe(dispose);
    release();
    await expect(initialize).rejects.toThrow(/disposed during initialization/);
    await expect(dispose).resolves.toBeUndefined();
    expect(manager.initialize).toHaveBeenCalledOnce();
    expect(manager.dispose).toHaveBeenCalledOnce();
  });
});
