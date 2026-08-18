import { describe, expect, it, vi } from "vitest";
import type {
  BackendRuntimeEvent,
  JourneyRenderSnapshot,
  RenderBackendAdapter,
  RenderBackendFacts,
  RenderEventObserver,
  RenderFeature,
  RenderFrameLoop,
  RenderHostDependencies,
  RenderMaterialLibrary,
  RenderPass,
  RenderPassRecorder,
  RenderQualityProfile,
  RenderQualityProvider,
  RenderResourceRegistry,
  RenderResourceSnapshot,
  RenderUploadQueue,
  RenderViewport,
  Unsubscribe,
  VisualClock,
} from "../../src/gfx/v2/contracts";
import { RenderHost } from "../../src/gfx/v2/render-host";
import { RenderHostError } from "../../src/gfx/v2/errors";

const VIEWPORT: RenderViewport = { width: 1280, height: 720, pixelRatio: 1 };
const HIGH: RenderQualityProfile = {
  tier: "high",
  pixelRatio: 1,
  uploadBudgetMs: 2,
  features: { temporal: true },
};

function journeySnapshot(): JourneyRenderSnapshot {
  return {
    seed: 20260818,
    storyTime: 12,
    phase: "LIFE",
    shotId: "S03",
    position: { x: 0.25, y: -0.5 },
    velocity: { x: 0.1, y: 0.2 },
    pulses: [{
      id: 1,
      journeyTime: 8,
      x: 0.2,
      y: -0.4,
      phase: "LIFE",
      source: "player",
      value: 1,
    }],
    answerAt: null,
    finished: false,
  };
}

class FakeFrameLoop implements RenderFrameLoop {
  running = false;
  starts = 0;
  stops = 0;
  #callback: ((nowMs: number) => void) | null = null;

  start(callback: (nowMs: number) => void): void {
    if (this.running) throw new Error("loop already running");
    this.running = true;
    this.starts += 1;
    this.#callback = callback;
  }

  stop(): void {
    this.stops += 1;
    this.running = false;
    this.#callback = null;
  }

  tick(nowMs: number): void {
    this.#callback?.(nowMs);
  }
}

class FakeBackend implements RenderBackendAdapter {
  readonly facts: Readonly<RenderBackendFacts> = {
    requestedApi: "WebGPU",
    actualApi: "WebGPU",
    adapter: "fake-adapter",
    device: "fake-device",
    fallback: false,
  };
  readonly listeners = new Set<(event: BackendRuntimeEvent) => void>();
  readonly log: string[];
  renderError: unknown = null;
  renderGate: Promise<void> | null = null;
  initializeGate: Promise<void> | null = null;
  disposed = false;

  constructor(log: string[]) {
    this.log = log;
  }

  async initialize(): Promise<void> {
    this.log.push("backend.initialize");
    await this.initializeGate;
  }

  resize(viewport: RenderViewport): void {
    this.log.push(`backend.resize:${viewport.width}x${viewport.height}`);
  }

  precompile(passes: readonly RenderPass[]): void {
    this.log.push(`backend.precompile:${passes.map((pass) => pass.name).join(",")}`);
  }

  render(passes: readonly RenderPass[]): void | Promise<void> {
    this.log.push(`backend.render:${passes.map((pass) => pass.name).join(",")}`);
    if (this.renderError) throw this.renderError;
    return this.renderGate ?? undefined;
  }

  subscribeEvents(listener: (event: BackendRuntimeEvent) => void): Unsubscribe {
    this.log.push("backend.subscribe");
    this.listeners.add(listener);
    return () => {
      this.log.push("backend.unsubscribe");
      this.listeners.delete(listener);
    };
  }

  snapshotResources(): Readonly<RenderResourceSnapshot> {
    return {
      geometries: 0,
      textures: 0,
      renderTargets: 0,
      programs: 0,
      nodes: 0,
      objects: 0,
      subscribers: this.listeners.size,
      pendingUploads: 0,
    };
  }

  async dispose(): Promise<void> {
    this.log.push("backend.dispose");
    this.disposed = true;
  }

  emit(kind: BackendRuntimeEvent["kind"], error: unknown): void {
    for (const listener of this.listeners) {
      listener({ kind, error, occurredAtMs: 42 });
    }
  }
}

class FakeQualityProvider implements RenderQualityProvider {
  readonly log: string[];
  #profile: RenderQualityProfile;
  #listeners = new Set<(profile: Readonly<RenderQualityProfile>) => void>();

  constructor(log: string[], profile = HIGH) {
    this.log = log;
    this.#profile = profile;
  }

  getProfile(): Readonly<RenderQualityProfile> {
    return this.#profile;
  }

  subscribe(listener: (profile: Readonly<RenderQualityProfile>) => void): Unsubscribe {
    this.log.push("quality.subscribe");
    this.#listeners.add(listener);
    return () => {
      this.log.push("quality.unsubscribe");
      this.#listeners.delete(listener);
    };
  }

  emit(profile: RenderQualityProfile): void {
    this.#profile = profile;
    for (const listener of this.#listeners) listener(profile);
  }
}

type FeatureOptions = {
  failInitialize?: boolean;
  inspect?: (snapshot: JourneyRenderSnapshot, clock: VisualClock) => void;
};

function fakeFeature(id: string, log: string[], options: FeatureOptions = {}): RenderFeature {
  return {
    id,
    async initialize() {
      log.push(`${id}.initialize`);
      if (options.failInitialize) throw new Error(`${id} init failed`);
    },
    update(snapshot, clock) {
      log.push(`${id}.update:${clock.frame}`);
      options.inspect?.(snapshot, clock);
    },
    render(recorder: RenderPassRecorder) {
      log.push(`${id}.render`);
      recorder.draw(`${id}-pass`, { feature: id }, { feature: id });
    },
    quality(profile) {
      log.push(`${id}.quality:${profile.tier}`);
    },
    async dispose() {
      log.push(`${id}.dispose`);
    },
  };
}

function dependencies(
  log: string[],
  features: readonly RenderFeature[],
): RenderHostDependencies & {
  backend: FakeBackend;
  frameLoop: FakeFrameLoop;
  qualityProvider: FakeQualityProvider;
  observed: ReturnType<typeof vi.fn<RenderEventObserver["observe"]>>;
} {
  const backend = new FakeBackend(log);
  const frameLoop = new FakeFrameLoop();
  const observed = vi.fn<RenderEventObserver["observe"]>();
  const observer: RenderEventObserver = { observe: observed };

  const resources: RenderResourceRegistry = {
    initialize() {
      log.push("resources.initialize");
    },
    snapshot: () => backend.snapshotResources(),
    dispose() {
      log.push("resources.dispose");
    },
  };
  const uploads: RenderUploadQueue = {
    initialize() {
      log.push("uploads.initialize");
    },
    flush(clock) {
      log.push(`uploads.flush:${clock.frame}`);
    },
    pendingCount: () => 0,
    dispose() {
      log.push("uploads.dispose");
    },
  };
  const materials: RenderMaterialLibrary = {
    initialize() {
      log.push("materials.initialize");
    },
    warmupPasses() {
      log.push("materials.warmupPasses");
      return [{ name: "warmup", kind: "warmup" }];
    },
    quality(profile) {
      log.push(`materials.quality:${profile.tier}`);
    },
    dispose() {
      log.push("materials.dispose");
    },
  };

  return {
    backend,
    frameLoop,
    features,
    materials,
    uploads,
    resources,
    qualityProvider: new FakeQualityProvider(log),
    observer,
    observed,
  };
}

describe("GFX-002 RenderHost", () => {
  it("runs features in deterministic order and disposes them in reverse order", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("ocean", log), fakeFeature("sky", log)]);
    const host = new RenderHost(deps);

    await host.initialize(journeySnapshot(), VIEWPORT);
    deps.frameLoop.tick(1_000);
    await host.whenIdle();
    await host.setQuality({ ...HIGH, tier: "balanced" });
    await host.dispose();

    expect(log.filter((entry) => /^(ocean|sky)\./.test(entry))).toEqual([
      "ocean.initialize",
      "sky.initialize",
      "ocean.quality:high",
      "sky.quality:high",
      "ocean.render",
      "sky.render",
      "ocean.update:0",
      "sky.update:0",
      "ocean.render",
      "sky.render",
      "ocean.quality:balanced",
      "sky.quality:balanced",
      "sky.dispose",
      "ocean.dispose",
    ]);
    expect(log).toContain("backend.precompile:warmup,ocean-pass,sky-pass");
    expect(log).toContain("backend.render:ocean-pass,sky-pass");
    expect(log.indexOf("backend.precompile:warmup,ocean-pass,sky-pass"))
      .toBeLessThan(log.indexOf("backend.render:ocean-pass,sky-pass"));
    expect(deps.frameLoop.starts).toBe(1);
    expect(deps.frameLoop.stops).toBe(1);
    expect(host.state).toBe("disposed");
    expect(host.getSnapshot().counters).toMatchObject({
      frameCallbacks: 1,
      submittedFrames: 1,
      droppedFrames: 0,
    });
  });

  it("copies and recursively freezes journey snapshots before features observe them", async () => {
    const log: string[] = [];
    const observations: Array<{ x: number; pulseX: number; frozen: boolean }> = [];
    const feature = fakeFeature("inspector", log, {
      inspect(snapshot) {
        observations.push({
          x: snapshot.position.x,
          pulseX: snapshot.pulses[0].x,
          frozen: Object.isFrozen(snapshot)
            && Object.isFrozen(snapshot.position)
            && Object.isFrozen(snapshot.pulses)
            && Object.isFrozen(snapshot.pulses[0]),
        });
      },
    });
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    const source = journeySnapshot();

    await host.initialize(source, VIEWPORT);
    (source.position as { x: number }).x = 99;
    (source.pulses[0] as { x: number }).x = 88;
    expect(() => {
      (host.journeySnapshot!.position as { x: number }).x = 77;
    }).toThrow(TypeError);

    deps.frameLoop.tick(100);
    await host.whenIdle();

    expect(observations).toEqual([{ x: 0.25, pulseX: 0.2, frozen: true }]);
    await host.dispose();
  });

  it("makes initialize and dispose idempotent while retaining a single loop owner", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    let releaseInitialize!: () => void;
    deps.backend.initializeGate = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const host = new RenderHost(deps);

    const firstInitialize = host.initialize(journeySnapshot(), VIEWPORT);
    const secondInitialize = host.initialize(journeySnapshot(), VIEWPORT);
    expect(firstInitialize).toBe(secondInitialize);
    releaseInitialize();
    await firstInitialize;
    await host.initialize(journeySnapshot(), VIEWPORT);

    const firstDispose = host.dispose();
    const secondDispose = host.dispose();
    expect(firstDispose).toBe(secondDispose);
    await firstDispose;
    await host.dispose();

    expect(deps.frameLoop.starts).toBe(1);
    expect(deps.frameLoop.stops).toBe(1);
    expect(log.filter((entry) => entry === "backend.initialize")).toHaveLength(1);
    expect(log.filter((entry) => entry === "backend.dispose")).toHaveLength(1);
  });

  it("cleans a partially initialized feature and every prior dependency", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [
      fakeFeature("ready-feature", log),
      fakeFeature("partial-feature", log, { failInitialize: true }),
    ]);
    const host = new RenderHost(deps);

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "INITIALIZATION_FAILED",
    });

    expect(host.state).toBe("failed");
    expect(host.error).toBeInstanceOf(RenderHostError);
    expect(log.slice(log.indexOf("partial-feature.initialize") + 1)).toEqual([
      "backend.unsubscribe",
      "partial-feature.dispose",
      "ready-feature.dispose",
      "materials.dispose",
      "uploads.dispose",
      "resources.dispose",
      "backend.dispose",
    ]);
    expect(deps.backend.listeners.size).toBe(0);
    expect(deps.frameLoop.starts).toBe(0);
    expect(deps.frameLoop.stops).toBe(1);
  });

  it("turns a late device event or frame error into observable terminal cleanup", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    const subscriber = vi.fn();
    const unsubscribe = host.subscribe(subscriber);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", new Error("adapter removed"));
    await host.whenIdle();

    const probe = host.getSnapshot();
    expect(host.state).toBe("failed");
    expect(probe).toMatchObject({
      lifecycle: "failed",
      loopRunning: false,
      counters: { backendEvents: 1, failures: 1 },
      error: { code: "BACKEND_RUNTIME_FAILED" },
    });
    expect(probe.events.map((event) => event.kind)).toContain("backend-event");
    expect(deps.backend.listeners.size).toBe(0);
    expect(deps.backend.disposed).toBe(true);
    expect(subscriber).toHaveBeenCalled();

    const disposalCount = log.filter((entry) => entry.endsWith(".dispose")).length;
    await host.dispose();
    expect(log.filter((entry) => entry.endsWith(".dispose"))).toHaveLength(disposalCount);
    unsubscribe();
  });

  it("waits for an in-flight asynchronous render before runtime-failure cleanup", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    let releaseRender!: () => void;
    deps.backend.renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.frameLoop.tick(20);
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toContain("backend.render:feature-pass");
    deps.backend.emit("device-lost", new Error("lost while submitting"));
    await Promise.resolve();
    expect(deps.backend.disposed).toBe(false);

    releaseRender();
    await host.whenIdle();
    expect(deps.backend.disposed).toBe(true);
    expect(host.state).toBe("failed");
  });

  it("fails closed when a backend frame submission throws", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.backend.renderError = new Error("submission rejected");
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.frameLoop.tick(16.67);
    await host.whenIdle();

    expect(host.state).toBe("failed");
    expect(host.error?.code).toBe("FRAME_FAILED");
    expect(deps.backend.listeners.size).toBe(0);
    expect(deps.backend.disposed).toBe(true);
  });
});
