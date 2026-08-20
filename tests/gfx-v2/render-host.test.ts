import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import type {
  BackendRuntimeEvent,
  JourneyRenderSnapshot,
  RenderBackendAdapter,
  RenderBackendFacts,
  RenderCompileStepRunner,
  RenderEventObserver,
  RenderFeature,
  RenderFrameLoop,
  RenderHostDependencies,
  RenderMaterialLibrary,
  RenderPass,
  RenderPassRecorder,
  RenderPrecompileReceipt,
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
import {
  attachRenderHostCleanupFailures,
  replaceRenderHostErrorCause,
  RenderHostError,
} from "../../src/gfx/v2/errors";
import {
  ThreeRenderBackendAdapter,
  type ThreeRendererPort,
} from "../../src/gfx/v2/backend/backend-adapter";

const VIEWPORT: RenderViewport = { width: 1280, height: 720, pixelRatio: 1 };
const HIGH: RenderQualityProfile = {
  tier: "high",
  pixelRatio: 1,
  uploadBudgetMs: 2,
  features: { temporal: true },
};
const EMPTY_PRECOMPILE_RECEIPT = Object.freeze({
  plannedSteps: 0,
  completedSteps: 0,
  phaseCounts: Object.freeze({
    "runtime-object": 0,
    "material-isolated": 0,
    "material-runtime-topology": 0,
    "output-first-use": 0,
  }),
}) satisfies Readonly<RenderPrecompileReceipt>;

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
  stopFailuresRemaining = 0;
  silentStopFailuresRemaining = 0;
  synchronousStartTickMs: number | null = null;
  #callback: ((nowMs: number) => void) | null = null;
  #retainedCallback: ((nowMs: number) => void) | null = null;

  start(callback: (nowMs: number) => void): void {
    if (this.running) throw new Error("loop already running");
    this.running = true;
    this.starts += 1;
    this.#callback = callback;
    this.#retainedCallback = callback;
    if (this.synchronousStartTickMs !== null) callback(this.synchronousStartTickMs);
  }

  stop(): void {
    this.stops += 1;
    if (this.stopFailuresRemaining > 0) {
      this.stopFailuresRemaining -= 1;
      throw new Error("loop stop failed");
    }
    if (this.silentStopFailuresRemaining > 0) {
      this.silentStopFailuresRemaining -= 1;
      return;
    }
    this.running = false;
    this.#callback = null;
  }

  tick(nowMs: number): void {
    this.#callback?.(nowMs);
  }

  tickRetained(nowMs: number): void {
    this.#retainedCallback?.(nowMs);
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
  resizeGate: Promise<void> | null = null;
  disposed = false;
  disposeError: unknown = null;
  disposeGate: Promise<void> | null = null;

  constructor(log: string[]) {
    this.log = log;
  }

  async initialize(): Promise<void> {
    this.log.push("backend.initialize");
    await this.initializeGate;
  }

  async resize(viewport: RenderViewport): Promise<void> {
    this.log.push(`backend.resize:${viewport.width}x${viewport.height}`);
    await this.resizeGate;
  }

  async precompile(
    passes: readonly RenderPass[],
    runner: RenderCompileStepRunner,
  ): Promise<Readonly<RenderPrecompileReceipt>> {
    void runner;
    this.log.push(`backend.precompile:${passes.map((pass) => pass.name).join(",")}`);
    return EMPTY_PRECOMPILE_RECEIPT;
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
    await this.disposeGate;
    if (this.disposeError) throw this.disposeError;
    this.listeners.clear();
  }

  emit(kind: BackendRuntimeEvent["kind"], error: unknown): void {
    for (const listener of this.listeners) {
      listener({ kind, error, occurredAtMs: 42 });
    }
  }
}

class FakeQualityProvider implements RenderQualityProvider {
  readonly log: string[];
  emitOnSubscribe: RenderQualityProfile | null = null;
  subscribeErrorAfterAdd: unknown = null;
  unsubscribeFailuresRemaining = 0;
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
    if (this.emitOnSubscribe) listener(this.emitOnSubscribe);
    if (this.subscribeErrorAfterAdd) throw this.subscribeErrorAfterAdd;
    return () => {
      this.log.push("quality.unsubscribe");
      if (this.unsubscribeFailuresRemaining > 0) {
        this.unsubscribeFailuresRemaining -= 1;
        throw new Error("quality unsubscribe failed");
      }
      this.#listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  emit(profile: RenderQualityProfile): void {
    this.#profile = profile;
    for (const listener of this.#listeners) listener(profile);
  }
}

type FeatureOptions = {
  failInitialize?: boolean;
  failDispose?: boolean;
  initializeGate?: Promise<void>;
  inspect?: (snapshot: JourneyRenderSnapshot, clock: VisualClock) => void;
};

function fakeFeature(id: string, log: string[], options: FeatureOptions = {}): RenderFeature {
  return {
    id,
    async initialize() {
      log.push(`${id}.initialize`);
      await options.initializeGate;
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
      if (options.failDispose) throw new Error(`${id} dispose failed`);
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
    warmupScheduler: {
      settleBeforeWarmup: async () => undefined,
      yieldToMain: async () => undefined,
    },
    features,
    materials,
    uploads,
    resources,
    qualityProvider: new FakeQualityProvider(log),
    observer,
    observed,
  };
}

function inspectTerminalFailureEvidence(root: unknown): {
  readonly messages: readonly string[];
  readonly nodes: number;
  readonly retained: ReadonlySet<object>;
  readonly terminalMarkers: readonly Error[];
} {
  let nodes = 0;
  const activePath = new Set<object>();
  const messages: string[] = [];
  const retained = new Set<object>();
  const terminalMarkers: Error[] = [];
  const visit = (value: unknown): void => {
    nodes += 1;
    if (
      (typeof value !== "object" || value === null)
      && typeof value !== "function"
    ) return;
    const identity = value as object;
    expect(activePath.has(identity)).toBe(false);
    activePath.add(identity);
    retained.add(identity);
    if (value instanceof Error) {
      messages.push(value.message);
      if (value.message.includes("Terminal failure evidence composition")) {
        terminalMarkers.push(value);
      }
      const causeDescriptor = Object.getOwnPropertyDescriptor(value, "cause");
      if (causeDescriptor && "value" in causeDescriptor) visit(causeDescriptor.value);
    }
    if (value instanceof AggregateError) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.errors)).toBe(true);
      for (const entry of value.errors) visit(entry);
    }
    activePath.delete(identity);
  };
  visit(root);
  return {
    messages: Object.freeze(messages),
    nodes,
    retained,
    terminalMarkers: Object.freeze(terminalMarkers),
  };
}

describe("GFX-002 RenderHost", () => {
  it("captures each authored render-pass field exactly once", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    let nameReads = 0;
    let kindReads = 0;
    let sceneReads = 0;
    let cameraReads = 0;
    let payloadReads = 0;
    const scene = { stable: "scene" };
    const camera = { stable: "camera" };
    const payload = { stable: "payload" };
    feature.render = (recorder) => recorder.record({
      get name() {
        nameReads += 1;
        return nameReads === 1 ? "stable-pass" : "";
      },
      get kind() {
        kindReads += 1;
        return kindReads === 1 ? "scene" : "";
      },
      get scene() {
        sceneReads += 1;
        return sceneReads === 1 ? scene : null;
      },
      get camera() {
        cameraReads += 1;
        return cameraReads === 1 ? camera : null;
      },
      get payload() {
        payloadReads += 1;
        return payloadReads === 1 ? payload : null;
      },
    });
    const deps = dependencies(log, [feature]);
    let capturedPass: RenderPass | null = null;
    deps.backend.precompile = async (passes) => {
      capturedPass = passes.find((pass) => pass.name === "stable-pass") ?? null;
      return EMPTY_PRECOMPILE_RECEIPT;
    };
    const host = new RenderHost(deps);

    await host.initialize(journeySnapshot(), VIEWPORT);

    expect(nameReads).toBe(1);
    expect(kindReads).toBe(1);
    expect(sceneReads).toBe(1);
    expect(cameraReads).toBe(1);
    expect(payloadReads).toBe(1);
    expect(capturedPass).toEqual({ name: "stable-pass", kind: "scene", scene, camera, payload });
    await host.dispose();
  });

  it("keeps colon-containing warmup identities distinct and preserves payloads", async () => {
    const log: string[] = [];
    const featurePayload = { source: "feature" };
    const materialPayload = { source: "material" };
    const feature = fakeFeature("feature", log);
    feature.render = (recorder) => recorder.record({
      name: "c",
      kind: "a:b",
      payload: featurePayload,
    });
    const deps = dependencies(log, [feature]);
    deps.materials.warmupPasses = () => [{
      name: "b:c",
      kind: "a",
      payload: materialPayload,
    }];
    let captured: readonly RenderPass[] = [];
    deps.backend.precompile = async (passes) => {
      captured = passes;
      return EMPTY_PRECOMPILE_RECEIPT;
    };
    const host = new RenderHost(deps);

    await host.initialize(journeySnapshot(), VIEWPORT);

    expect(captured).toEqual([
      { name: "b:c", kind: "a", scene: undefined, camera: undefined, payload: materialPayload },
      { name: "c", kind: "a:b", scene: undefined, camera: undefined, payload: featurePayload },
    ]);
    await host.dispose();
  });

  it("rejects malformed material warmup passes before backend precompile", async () => {
    const log: string[] = [];
    const deps = dependencies(log, []);
    deps.materials.warmupPasses = () => [{ name: " ", kind: "warmup" }];
    const host = new RenderHost(deps);

    const rejection = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error);

    expect(rejection).toMatchObject({ code: "INITIALIZATION_FAILED" });
    expect((rejection as RenderHostError).cause).toBeInstanceOf(TypeError);
    expect((rejection as RenderHostError).cause).toMatchObject({
      message: "A render pass requires non-empty name and kind fields.",
    });
    expect(log.some((entry) => entry.startsWith("backend.precompile:"))).toBe(false);
    expect(deps.backend.disposed).toBe(true);
  });

  it("snapshots dependency handles and the feature list at construction", async () => {
    const log: string[] = [];
    const original = fakeFeature("original", log);
    const replacement = fakeFeature("replacement", log);
    const mutableFeatures: RenderFeature[] = [original];
    const deps = dependencies(log, mutableFeatures);
    const host = new RenderHost(deps);

    await host.initialize(journeySnapshot(), VIEWPORT);
    mutableFeatures[0] = replacement;
    deps.frameLoop.tick(16);
    await host.whenIdle();
    await host.dispose();

    expect(log).toContain("original.update:0");
    expect(log).toContain("original.dispose");
    expect(log.some((entry) => entry.startsWith("replacement."))).toBe(false);
  });

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
      retainedIntermediateFailureSnapshots: 0,
    });
  });

  it("applies a profile published synchronously by quality subscription before ready", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const low = { ...HIGH, tier: "low" as const };
    deps.qualityProvider.emitOnSubscribe = low;
    const host = new RenderHost(deps);

    await host.initialize(journeySnapshot(), VIEWPORT);
    expect(host.getSnapshot().qualityTier).toBe("low");
    expect(log.filter((entry) => entry.endsWith("quality:low"))).toEqual([
      "materials.quality:low",
      "feature.quality:low",
    ]);
    await host.dispose();
  });

  it("drains a quality emission caused by a synchronous loop-start callback", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const low = { ...HIGH, tier: "low" as const };
    deps.frameLoop.synchronousStartTickMs = 1;
    let emitted = false;
    const host = new RenderHost(deps);
    host.subscribe(() => {
      if (emitted || host.getSnapshot().counters.droppedFrames === 0) return;
      emitted = true;
      deps.qualityProvider.emit(low);
    });

    await host.initialize(journeySnapshot(), VIEWPORT);
    expect(emitted).toBe(true);
    expect(host.getSnapshot().qualityTier).toBe("low");
    expect(log).toContain("feature.quality:low");
    await host.dispose();
  });

  it("does not apply initial quality after its getter emits a terminal backend event", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.qualityProvider.getProfile = () => {
      deps.backend.emit("device-lost", new Error("lost in initial quality getter"));
      return HIGH;
    };
    const host = new RenderHost(deps);

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "BACKEND_RUNTIME_FAILED",
    });
    expect(log).not.toContain("materials.quality:high");
    expect(log).not.toContain("feature.quality:high");
    expect(deps.backend.disposed).toBe(true);
  });

  it("stops warmup callbacks immediately after a feature emits a terminal event", async () => {
    const log: string[] = [];
    const first = fakeFeature("first", log);
    const second = fakeFeature("second", log);
    const deps = dependencies(log, [first, second]);
    first.render = () => {
      log.push("first.render");
      deps.backend.emit("device-lost", new Error("lost during warmup render"));
    };
    const host = new RenderHost(deps);

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "BACKEND_RUNTIME_FAILED",
    });
    expect(log).not.toContain("second.render");
    expect(log).not.toContain("materials.warmupPasses");
    expect(log.some((entry) => entry.startsWith("backend.precompile:"))).toBe(false);
    expect(deps.backend.disposed).toBe(true);
  });

  it("disposes backend ownership when event subscription adds then throws", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.backend.subscribeEvents = (listener) => {
      deps.backend.listeners.add(listener);
      throw new Error("backend subscribe failed after add");
    };
    const host = new RenderHost(deps);

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "INITIALIZATION_FAILED",
    });
    expect(deps.backend.disposed).toBe(true);
    expect(deps.backend.listeners.size).toBe(0);
    expect(log.filter((entry) => entry === "backend.dispose")).toHaveLength(1);
  });

  it("revokes a backend relay when partial subscription and backend disposal both fail", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.backend.subscribeEvents = (listener) => {
      deps.backend.listeners.add(listener);
      throw new Error("backend subscribe failed after retaining listener");
    };
    deps.backend.disposeError = new Error("backend dispose failed before listener clear");
    const host = new RenderHost(deps);

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "INITIALIZATION_FAILED",
    });
    expect(deps.backend.listeners.size).toBe(1);
    const terminal = host.getSnapshot();
    deps.backend.emit("device-lost", new Error("late retained emission"));
    expect(host.getSnapshot().counters).toEqual(terminal.counters);
    expect(host.getSnapshot().events).toEqual(terminal.events);
    expect(host.state).toBe("failed");
  });

  it("revokes a quality relay when provider subscription adds then throws", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.qualityProvider.subscribeErrorAfterAdd = new Error("quality subscribe failed after add");
    const host = new RenderHost(deps);

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "INITIALIZATION_FAILED",
    });
    expect(deps.qualityProvider.listenerCount).toBe(1);
    const lowCalls = log.filter((entry) => entry.includes("quality:low")).length;
    deps.qualityProvider.emit({ ...HIGH, tier: "low" });
    await Promise.resolve();
    expect(log.filter((entry) => entry.includes("quality:low"))).toHaveLength(lowCalls);
    expect(deps.backend.disposed).toBe(true);
    expect(host.state).toBe("failed");
  });

  it("publishes the frame latch before upload work can enqueue a quality change", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const low = { ...HIGH, tier: "low" as const };
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    deps.uploads.flush = async () => {
      log.push("flush.begin");
      await flushGate;
      log.push("flush.end");
    };
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.frameLoop.tick(16);
    await vi.waitFor(() => expect(log).toContain("flush.begin"));
    const quality = host.setQuality(low).then(() => {
      log.push("quality.done");
    });
    expect(log).not.toContain("materials.quality:low");
    releaseFlush();
    await quality;
    expect(log.indexOf("flush.end")).toBeLessThan(log.indexOf("materials.quality:low"));
    expect(log.indexOf("materials.quality:low")).toBeLessThan(log.indexOf("quality.done"));
    await host.dispose();
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

  it("captures snapshot object-valued getters once to avoid torn projections", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const source = journeySnapshot();
    let positionReads = 0;
    Object.defineProperty(source, "position", {
      configurable: true,
      get() {
        positionReads += 1;
        return positionReads === 1 ? { x: 0.4, y: -0.2 } : { x: 99, y: 99 };
      },
    });
    const host = new RenderHost(deps);

    await host.initialize(source, VIEWPORT);
    expect(positionReads).toBe(1);
    expect(host.journeySnapshot?.position).toEqual({ x: 0.4, y: -0.2 });
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

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "INVALID_LIFECYCLE",
      lifecycle: "disposed",
    });

    expect(deps.frameLoop.starts).toBe(1);
    expect(deps.frameLoop.stops).toBe(1);
    expect(log.filter((entry) => entry === "backend.initialize")).toHaveLength(1);
    expect(log.filter((entry) => entry === "backend.dispose")).toHaveLength(1);
  });

  it("keeps whenIdle pending until explicit disposal cleanup settles", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    let releaseDispose!: () => void;
    deps.backend.disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    const disposal = host.dispose();
    let idleSettled = false;
    const idle = host.whenIdle().then(() => {
      idleSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(idleSettled).toBe(false);
    releaseDispose();
    await disposal;
    await idle;
    expect(idleSettled).toBe(true);
    expect(host.state).toBe("disposed");
  });

  it("retries a throwing quality unsubscribe and removes terminal ownership", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    deps.qualityProvider.unsubscribeFailuresRemaining = 1;

    await expect(host.dispose()).rejects.toMatchObject({ code: "DISPOSAL_FAILED" });
    expect(deps.qualityProvider.listenerCount).toBe(0);
    expect(log.filter((entry) => entry === "quality.unsubscribe")).toHaveLength(2);
    const qualityCalls = log.filter((entry) => entry.includes("quality:low")).length;
    deps.qualityProvider.emit({ ...HIGH, tier: "low" });
    await Promise.resolve();
    expect(log.filter((entry) => entry.includes("quality:low"))).toHaveLength(qualityCalls);
    expect(host.state).toBe("failed");
  });

  it("keeps explicit-disposal failure evidence immutable during probe publication", async () => {
    const log: string[] = [];
    const cleanup = new Error("explicit feature cleanup failed");
    const feature = fakeFeature("feature", log);
    feature.dispose = () => {
      log.push("feature.dispose");
      throw cleanup;
    };
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    let mutationBlocked = false;
    host.subscribe(() => {
      const cause = host.error?.cause;
      if (!(cause instanceof AggregateError)) return;
      try {
        cause.errors.splice(0);
      } catch {
        mutationBlocked = true;
      }
    });
    await host.initialize(journeySnapshot(), VIEWPORT);

    const failure = await host.dispose().catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure).toMatchObject({ code: "DISPOSAL_FAILED" });
    expect(mutationBlocked).toBe(true);
    expect(Object.isFrozen(failure.cause)).toBe(true);
    expect(Object.isFrozen((failure.cause as AggregateError).errors)).toBe(true);
    expect((failure.cause as AggregateError).errors).toEqual([cleanup]);
  });

  it("preserves own primitive cleanup causes with SameValue semantics", async () => {
    const log: string[] = [];
    let ordinaryCausePresenceInspections = 0;
    const ordinaryCauseSource = new Proxy(new Error("ordinary primitive cause", { cause: 42 }), {
      getOwnPropertyDescriptor(target, property) {
        if (property === "cause") ordinaryCausePresenceInspections += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const absentCauseSource = new Error("absent cause");
    const ownUndefinedSource = new Error("own undefined cause", { cause: undefined });
    const nanCauseSource = new TypeError("NaN cause", { cause: Number.NaN });
    const negativeZeroSource = new RangeError("negative zero cause", { cause: -0 });
    const positiveZeroSource = new Error("positive zero cause", { cause: +0 });
    const sources = [
      ordinaryCauseSource,
      positiveZeroSource,
      negativeZeroSource,
      nanCauseSource,
      ownUndefinedSource,
      absentCauseSource,
    ];
    const features = sources.map((source, index) => {
      const feature = fakeFeature(`feature-${index}`, log);
      feature.dispose = () => {
        log.push(`feature-${index}.dispose`);
        throw source;
      };
      return feature;
    });
    const host = new RenderHost(dependencies(log, features));
    await host.initialize(journeySnapshot(), VIEWPORT);

    const failure = await host.dispose().catch((error: unknown) => error) as RenderHostError;
    const evidence = (failure.cause as AggregateError).errors as Error[];
    const evidenceByMessage = new Map(evidence.map((error) => [error.message, error]));
    const absentCause = evidenceByMessage.get("absent cause")!;
    const ownUndefined = evidenceByMessage.get("own undefined cause")!;
    const nanCause = evidenceByMessage.get("NaN cause")!;
    const negativeZero = evidenceByMessage.get("negative zero cause")!;
    const positiveZero = evidenceByMessage.get("positive zero cause")!;
    const ordinaryCause = evidenceByMessage.get("ordinary primitive cause")!;

    expect(Object.prototype.hasOwnProperty.call(absentCause, "cause")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ownUndefined, "cause")).toBe(true);
    expect(Object.is(ownUndefined.cause, undefined)).toBe(true);
    expect(Object.is(nanCause.cause, Number.NaN)).toBe(true);
    expect(Object.is(negativeZero.cause, -0)).toBe(true);
    expect(Object.is(positiveZero.cause, +0)).toBe(true);
    expect(Object.is(ordinaryCause.cause, 42)).toBe(true);
    expect(nanCause).toBeInstanceOf(TypeError);
    expect(negativeZero).toBeInstanceOf(RangeError);
    expect(ordinaryCausePresenceInspections).toBe(1);
    expect(evidence.every(Object.isFrozen)).toBe(true);
  });

  it("does not retain an object-valued own cleanup cause", async () => {
    const log: string[] = [];
    const cyclicCause = new Error("cyclic cleanup cause");
    Object.defineProperty(cyclicCause, "cause", {
      configurable: true,
      value: cyclicCause,
      writable: true,
    });
    const feature = fakeFeature("feature", log);
    feature.dispose = () => {
      log.push("feature.dispose");
      throw cyclicCause;
    };
    const host = new RenderHost(dependencies(log, [feature]));
    await host.initialize(journeySnapshot(), VIEWPORT);

    const failure = await host.dispose().catch((error: unknown) => error) as RenderHostError;
    const evidence = (failure.cause as AggregateError).errors[0] as Error;

    expect(evidence).not.toBe(cyclicCause);
    expect(evidence.message).toBe("Cyclic failure evidence was sanitized.");
    expect(Object.prototype.hasOwnProperty.call(evidence, "cause")).toBe(false);
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it("preserves only own data primitive causes on cleanup aggregates", async () => {
    const log: string[] = [];
    const absent = new AggregateError([], "aggregate absent cause");
    const ownUndefined = new AggregateError(
      [],
      "aggregate own undefined cause",
      { cause: undefined },
    );
    const nullCause = new AggregateError([], "aggregate null cause", { cause: null });
    const nanCause = new AggregateError([], "aggregate NaN cause", { cause: Number.NaN });
    const negativeZero = new AggregateError([], "aggregate negative zero cause", { cause: -0 });
    const positiveLeaf = new Error("positive zero nested leaf");
    const positiveZero = new AggregateError(
      [positiveLeaf],
      "aggregate positive zero cause",
      { cause: +0 },
    );
    const ordinaryLeaf = new Error("ordinary nested leaf");
    let ordinaryCausePresenceInspections = 0;
    const ordinary = new Proxy(new AggregateError(
      [ordinaryLeaf, ordinaryLeaf],
      "aggregate ordinary cause",
      { cause: 42 },
    ), {
      getOwnPropertyDescriptor(target, property) {
        if (property === "cause") ordinaryCausePresenceInspections += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const objectCauseValue = { retained: "must not survive" };
    const objectCause = new AggregateError(
      [],
      "aggregate object cause",
      { cause: objectCauseValue },
    );
    const functionCauseValue = () => undefined;
    const functionCause = new AggregateError(
      [],
      "aggregate function cause",
      { cause: functionCauseValue },
    );
    const cyclicCause = new AggregateError([], "aggregate cyclic cause");
    Object.defineProperty(cyclicCause, "cause", {
      configurable: true,
      value: cyclicCause,
      writable: true,
    });
    let accessorReads = 0;
    const accessorCause = new AggregateError([], "aggregate accessor cause");
    Object.defineProperty(accessorCause, "cause", {
      configurable: true,
      get() {
        accessorReads += 1;
        return 42;
      },
    });
    const sources = [
      accessorCause,
      cyclicCause,
      functionCause,
      objectCause,
      ordinary,
      positiveZero,
      negativeZero,
      nanCause,
      nullCause,
      ownUndefined,
      absent,
    ];
    const features = sources.map((source, index) => {
      const feature = fakeFeature(`aggregate-feature-${index}`, log);
      feature.dispose = () => {
        log.push(`aggregate-feature-${index}.dispose`);
        throw source;
      };
      return feature;
    });
    const host = new RenderHost(dependencies(log, features));
    await host.initialize(journeySnapshot(), VIEWPORT);

    const failure = await host.dispose().catch((error: unknown) => error) as RenderHostError;
    const evidence = (failure.cause as AggregateError).errors as AggregateError[];
    const evidenceByMessage = new Map(evidence.map((error) => [error.message, error]));
    const absentEvidence = evidenceByMessage.get("aggregate absent cause")!;
    const undefinedEvidence = evidenceByMessage.get("aggregate own undefined cause")!;
    const nullEvidence = evidenceByMessage.get("aggregate null cause")!;
    const nanEvidence = evidenceByMessage.get("aggregate NaN cause")!;
    const negativeEvidence = evidenceByMessage.get("aggregate negative zero cause")!;
    const positiveEvidence = evidenceByMessage.get("aggregate positive zero cause")!;
    const ordinaryEvidence = evidenceByMessage.get("aggregate ordinary cause")!;
    const objectEvidence = evidenceByMessage.get("aggregate object cause")!;
    const functionEvidence = evidenceByMessage.get("aggregate function cause")!;
    const cyclicEvidence = evidenceByMessage.get("aggregate cyclic cause")!;
    const accessorEvidence = evidenceByMessage.get("aggregate accessor cause")!;
    const hasOwnCause = (error: Error) => Object.prototype.hasOwnProperty.call(error, "cause");

    expect(hasOwnCause(absentEvidence)).toBe(false);
    expect(hasOwnCause(undefinedEvidence)).toBe(true);
    expect(Object.is(undefinedEvidence.cause, undefined)).toBe(true);
    expect(Object.is(nullEvidence.cause, null)).toBe(true);
    expect(Object.is(nanEvidence.cause, Number.NaN)).toBe(true);
    expect(Object.is(negativeEvidence.cause, -0)).toBe(true);
    expect(Object.is(positiveEvidence.cause, +0)).toBe(true);
    expect(Object.is(ordinaryEvidence.cause, 42)).toBe(true);
    expect(positiveEvidence.errors).toEqual([
      expect.objectContaining({ message: positiveLeaf.message }),
    ]);
    expect(ordinaryEvidence.errors).toEqual([
      expect.objectContaining({ message: ordinaryLeaf.message }),
      expect.objectContaining({ message: ordinaryLeaf.message }),
    ]);
    expect(hasOwnCause(objectEvidence)).toBe(false);
    expect(hasOwnCause(functionEvidence)).toBe(false);
    expect(hasOwnCause(cyclicEvidence)).toBe(false);
    expect(hasOwnCause(accessorEvidence)).toBe(false);
    expect(ordinaryCausePresenceInspections).toBe(1);
    expect(accessorReads).toBe(0);
    expect(evidence).not.toContain(cyclicCause);
    expect(evidence).not.toContain(objectCauseValue);
    expect(evidence).not.toContain(functionCauseValue);
    expect(evidence.every((error) => (
      Object.isFrozen(error) && Object.isFrozen(error.errors)
    ))).toBe(true);
    expect(positiveEvidence.errors.every(Object.isFrozen)).toBe(true);
    expect(ordinaryEvidence.errors.every(Object.isFrozen)).toBe(true);
  });

  it("bounds cause-bearing aggregate snapshots without losing their primitive cause", async () => {
    const log: string[] = [];
    const overWidth = new AggregateError(
      Array.from({ length: 300 }, (_, index) => index),
      "aggregate immutable width bound",
      { cause: -0 },
    );
    const invalidLength = new AggregateError(
      [],
      "aggregate invalid source length",
      { cause: Number.NaN },
    );
    const invalidEntries = new Proxy([] as unknown[], {
      get(target, property, receiver) {
        if (property === "length") return Number.POSITIVE_INFINITY;
        return Reflect.get(target, property, receiver);
      },
    });
    Object.defineProperty(invalidLength, "errors", { value: invalidEntries });
    const sources = [invalidLength, overWidth];
    const features = sources.map((source, index) => {
      const feature = fakeFeature(`bounded-aggregate-feature-${index}`, log);
      feature.dispose = () => {
        log.push(`bounded-aggregate-feature-${index}.dispose`);
        throw source;
      };
      return feature;
    });
    const host = new RenderHost(dependencies(log, features));
    await host.initialize(journeySnapshot(), VIEWPORT);

    const failure = await host.dispose().catch((error: unknown) => error) as RenderHostError;
    const evidence = (failure.cause as AggregateError).errors as AggregateError[];
    const evidenceByMessage = new Map(evidence.map((error) => [error.message, error]));
    const widthEvidence = evidenceByMessage.get("aggregate immutable width bound")!;
    const invalidLengthEvidence = evidenceByMessage.get("aggregate invalid source length")!;

    expect(Object.is(widthEvidence.cause, -0)).toBe(true);
    expect(widthEvidence.errors).toHaveLength(256);
    expect(widthEvidence.errors.at(-1)).toMatchObject({
      message: "Aggregate failure snapshot exceeded 256 entries.",
    });
    expect(Object.is(invalidLengthEvidence.cause, Number.NaN)).toBe(true);
    expect(invalidLengthEvidence.errors).toEqual([
      expect.objectContaining({
        message: "Aggregate failure detail count must be a safe integer between 0 and 4096.",
      }),
    ]);
    expect(evidence.every((error) => (
      Object.isFrozen(error) && Object.isFrozen(error.errors)
    ))).toBe(true);
  });

  it("charges source fanout, immutable wrappers, primitive causes, and truncation to one node budget", async () => {
    const log: string[] = [];
    const sourceObjects = new Set<object>();
    const sourceChildren = Array.from({ length: 4_095 }, (_, index) => {
      const leafCause = index % 3 === 0
        ? +0
        : index % 3 === 1
          ? Number.NaN
          : -0;
      const aggregateCause = index % 3 === 0
        ? -0
        : index % 3 === 1
          ? Number.NaN
          : +0;
      const leaf = new Error(`budget leaf ${index}`, { cause: leafCause });
      const aggregate = new AggregateError(
        [leaf],
        `budget aggregate ${index}`,
        { cause: aggregateCause },
      );
      sourceObjects.add(leaf);
      sourceObjects.add(aggregate);
      return aggregate;
    });
    const sourceRoot = new AggregateError(sourceChildren, "budget root fanout");
    sourceObjects.add(sourceRoot);
    const feature = fakeFeature("budget-feature", log);
    feature.dispose = () => {
      log.push("budget-feature.dispose");
      throw sourceRoot;
    };
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const primary = new Error("budget primary loss");

    deps.backend.emit("device-lost", primary);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBeInstanceOf(AggregateError);
    const finalCause = published.cause as AggregateError;
    expect(finalCause.errors[0]).toBe(primary);

    let evidenceNodes = 0;
    let truncationOccurrences = 0;
    const retainedObjects = new Set<object>();
    const activePath = new Set<object>();
    const walkEvidence = (value: unknown): void => {
      evidenceNodes += 1;
      if (
        (typeof value !== "object" || value === null)
        && typeof value !== "function"
      ) return;
      const identity = value as object;
      expect(activePath.has(identity)).toBe(false);
      activePath.add(identity);
      retainedObjects.add(identity);
      if (value instanceof Error) {
        if (value.message.includes("8192-node ingress budget")) {
          truncationOccurrences += 1;
          expect(value).toBeInstanceOf(RangeError);
          expect(Object.isFrozen(value)).toBe(true);
        }
        const causeDescriptor = Object.getOwnPropertyDescriptor(value, "cause");
        if (causeDescriptor && "value" in causeDescriptor) {
          walkEvidence(causeDescriptor.value);
        }
      }
      if (value instanceof AggregateError) {
        expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(value.errors)).toBe(true);
        for (const entry of value.errors) walkEvidence(entry);
      }
      activePath.delete(identity);
    };
    walkEvidence(finalCause);

    expect(evidenceNodes).toBeLessThanOrEqual(8_192);
    expect(truncationOccurrences).toBe(1);
    expect([...sourceObjects].some((source) => retainedObjects.has(source))).toBe(false);
    const cleanupBoundary = finalCause.errors.find((value): value is AggregateError => (
      value instanceof AggregateError && value.message === "budget root fanout"
    ))!;
    const firstAggregate = cleanupBoundary.errors[0] as AggregateError;
    const secondAggregate = cleanupBoundary.errors[1] as AggregateError;
    expect(firstAggregate).toBeInstanceOf(AggregateError);
    expect(Object.is(firstAggregate.cause, -0)).toBe(true);
    expect(Object.is((firstAggregate.errors[0] as Error).cause, +0)).toBe(true);
    expect(Object.is(secondAggregate.cause, Number.NaN)).toBe(true);
    expect(Object.is((secondAggregate.errors[0] as Error).cause, Number.NaN)).toBe(true);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("uses the full ingress budget when a huge primary has no cleanup failure", async () => {
    const log: string[] = [];
    const sourceObjects = new Set<object>();
    const children = Array.from({ length: 4_095 }, (_, index) => {
      const leafCause = index % 3 === 0
        ? +0
        : index % 3 === 1
          ? Number.NaN
          : -0;
      const aggregateCause = index % 3 === 0
        ? -0
        : index % 3 === 1
          ? Number.NaN
          : +0;
      const leaf = new Error(`full primary leaf ${index}`, { cause: leafCause });
      const aggregate = new AggregateError(
        [leaf],
        `full primary aggregate ${index}`,
        { cause: aggregateCause },
      );
      sourceObjects.add(leaf);
      sourceObjects.add(aggregate);
      return aggregate;
    });
    const sourceRoot = new AggregateError(children, "full primary root");
    sourceObjects.add(sourceRoot);
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", sourceRoot);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBeInstanceOf(AggregateError);
    let evidenceNodes = 0;
    let ingressMarkers = 0;
    let compositionMarkers = 0;
    const retainedObjects = new Set<object>();
    const activePath = new Set<object>();
    const walkEvidence = (value: unknown): void => {
      evidenceNodes += 1;
      if (
        (typeof value !== "object" || value === null)
        && typeof value !== "function"
      ) return;
      const identity = value as object;
      expect(activePath.has(identity)).toBe(false);
      activePath.add(identity);
      retainedObjects.add(identity);
      if (value instanceof Error) {
        if (value.message.includes("8192-node ingress budget")) ingressMarkers += 1;
        if (value.message.includes("Terminal failure evidence composition")) {
          compositionMarkers += 1;
        }
        const causeDescriptor = Object.getOwnPropertyDescriptor(value, "cause");
        if (causeDescriptor && "value" in causeDescriptor) {
          walkEvidence(causeDescriptor.value);
        }
      }
      if (value instanceof AggregateError) {
        expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(value.errors)).toBe(true);
        for (const entry of value.errors) walkEvidence(entry);
      }
      activePath.delete(identity);
    };
    walkEvidence(published.cause);

    expect(evidenceNodes).toBeGreaterThan(3_510);
    expect(evidenceNodes).toBeLessThanOrEqual(8_192);
    expect(ingressMarkers).toBe(1);
    expect(compositionMarkers).toBe(0);
    expect([...sourceObjects].some((source) => retainedObjects.has(source))).toBe(false);
    const firstAggregate = [...retainedObjects].find((value) => (
      value instanceof AggregateError && value.message === "full primary aggregate 0"
    )) as AggregateError;
    expect(Object.is(firstAggregate.cause, -0)).toBe(true);
    expect(Object.is((firstAggregate.errors[0] as Error).cause, +0)).toBe(true);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("detaches every plain Error leaf in a huge primary ingress snapshot", async () => {
    const log: string[] = [];
    const sourceLeaves = Array.from(
      { length: 4_095 },
      (_, index) => new Error(`plain primary leaf ${index}`),
    );
    const sourceRoot = new AggregateError(sourceLeaves, "plain primary root");
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", sourceRoot);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBeInstanceOf(AggregateError);
    const retained = new Set<object>();
    let ingressMarkers = 0;
    const walk = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      retained.add(value);
      if (value instanceof Error) {
        expect(Object.isFrozen(value)).toBe(true);
        if (value.message.includes("8192-node ingress budget")) ingressMarkers += 1;
      }
      if (value instanceof AggregateError) {
        expect(Object.isFrozen(value.errors)).toBe(true);
        for (const entry of value.errors) walk(entry);
      }
    };
    walk(published.cause);

    expect(ingressMarkers).toBe(1);
    expect(sourceLeaves.some((source) => retained.has(source))).toBe(false);
    expect(retained.has(sourceRoot)).toBe(false);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("composes huge primary and cleanup graphs inside one final evidence budget", async () => {
    const log: string[] = [];
    const sourceObjects = new Set<object>();
    const fanout = (prefix: string): AggregateError => {
      const children = Array.from({ length: 4_095 }, (_, index) => {
        const leafCause = index % 3 === 0
          ? +0
          : index % 3 === 1
            ? Number.NaN
            : -0;
        const aggregateCause = index % 3 === 0
          ? -0
          : index % 3 === 1
            ? Number.NaN
            : +0;
        const leaf = new Error(`${prefix} leaf ${index}`, { cause: leafCause });
        const aggregate = new AggregateError(
          [leaf],
          `${prefix} aggregate ${index}`,
          { cause: aggregateCause },
        );
        sourceObjects.add(leaf);
        sourceObjects.add(aggregate);
        return aggregate;
      });
      const root = new AggregateError(children, `${prefix} root`);
      sourceObjects.add(root);
      return root;
    };
    const primaryRoot = fanout("huge primary");
    const cleanupRoot = fanout("huge cleanup");
    const feature = fakeFeature("dual-budget-feature", log);
    feature.dispose = () => {
      log.push("dual-budget-feature.dispose");
      throw cleanupRoot;
    };
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", primaryRoot);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBeInstanceOf(AggregateError);
    const finalCause = published.cause as AggregateError;
    let evidenceNodes = 0;
    let truncationOccurrences = 0;
    const retainedObjects = new Set<object>();
    const activePath = new Set<object>();
    const messages: string[] = [];
    const walkEvidence = (value: unknown): void => {
      evidenceNodes += 1;
      if (
        (typeof value !== "object" || value === null)
        && typeof value !== "function"
      ) return;
      const identity = value as object;
      expect(activePath.has(identity)).toBe(false);
      activePath.add(identity);
      retainedObjects.add(identity);
      if (value instanceof Error) {
        messages.push(value.message);
        if (value.message.includes("shared 8192-node output budget")) {
          truncationOccurrences += 1;
          expect(value).toBeInstanceOf(RangeError);
          expect(Object.isFrozen(value)).toBe(true);
        }
        const causeDescriptor = Object.getOwnPropertyDescriptor(value, "cause");
        if (causeDescriptor && "value" in causeDescriptor) {
          walkEvidence(causeDescriptor.value);
        }
      }
      if (value instanceof AggregateError) {
        expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(value.errors)).toBe(true);
        for (const entry of value.errors) walkEvidence(entry);
      }
      activePath.delete(identity);
    };
    walkEvidence(finalCause);

    expect(evidenceNodes).toBeLessThanOrEqual(8_192);
    expect(truncationOccurrences).toBe(1);
    expect(messages).toContain("huge primary aggregate 0");
    expect(messages).toContain("huge cleanup aggregate 0");
    expect([...sourceObjects].some((source) => retainedObjects.has(source))).toBe(false);
    const primaryAggregate = [...retainedObjects].find((value) => (
      value instanceof AggregateError && value.message === "huge primary aggregate 0"
    )) as AggregateError;
    const cleanupAggregate = [...retainedObjects].find((value) => (
      value instanceof AggregateError && value.message === "huge cleanup aggregate 0"
    )) as AggregateError;
    expect(Object.is(primaryAggregate.cause, -0)).toBe(true);
    expect(Object.is((primaryAggregate.errors[0] as Error).cause, +0)).toBe(true);
    expect(Object.is(cleanupAggregate.cause, -0)).toBe(true);
    expect(Object.is((cleanupAggregate.errors[0] as Error).cause, +0)).toBe(true);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("always recomposes a medium primary and two huge cleanup channels inside one final budget", async () => {
    const log: string[] = [];
    const sourceObjects = new Set<object>();
    const fanout = (prefix: string, length: number): AggregateError => {
      const leaves = Array.from({ length }, (_, index) => {
        const leaf = new Error(`${prefix} leaf ${index}`);
        sourceObjects.add(leaf);
        return leaf;
      });
      const root = new AggregateError(leaves, `${prefix} root`);
      sourceObjects.add(root);
      return root;
    };
    const primaryRoot = fanout("medium primary", 4_092);
    const cleanupA = fanout("huge cleanup A", 4_096);
    const cleanupB = fanout("huge cleanup B", 4_096);
    const featureA = fakeFeature("budget-channel-a", log);
    const featureB = fakeFeature("budget-channel-b", log);
    featureA.dispose = () => {
      log.push("budget-channel-a.dispose");
      throw cleanupA;
    };
    featureB.dispose = () => {
      log.push("budget-channel-b.dispose");
      throw cleanupB;
    };
    const deps = dependencies(log, [featureA, featureB]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", primaryRoot);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBeInstanceOf(AggregateError);
    const inspected = inspectTerminalFailureEvidence(published.cause);
    expect(inspected.nodes).toBeLessThanOrEqual(8_192);
    expect(inspected.terminalMarkers).toHaveLength(1);
    expect(inspected.terminalMarkers[0]).toBeInstanceOf(RangeError);
    expect(Object.isFrozen(inspected.terminalMarkers[0])).toBe(true);
    expect(inspected.terminalMarkers[0].message).toContain(
      "shared 8192-node output budget",
    );
    expect(inspected.terminalMarkers[0].message).not.toContain("safe-snapshot depth");
    expect(inspected.terminalMarkers[0].message).toContain("8192-node ingress budget");
    expect(inspected.terminalMarkers[0].message).not.toContain("hostile inspection");
    expect(inspected.messages).toContain("medium primary leaf 0");
    expect(inspected.messages).toContain("huge cleanup A leaf 0");
    expect(inspected.messages).toContain("huge cleanup B leaf 0");
    expect([...sourceObjects].some((source) => inspected.retained.has(source))).toBe(false);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("releases every intermediate cleanup snapshot after bounded terminal composition", async () => {
    const log: string[] = [];
    const sourceObjects = new Set<object>();
    const cleanupRoots = Array.from({ length: 4 }, (_, operationIndex) => {
      const leaves = Array.from({ length: 4_096 }, (_, leafIndex) => {
        const leaf = new Error(`retention cleanup ${operationIndex} leaf ${leafIndex}`);
        sourceObjects.add(leaf);
        return leaf;
      });
      const root = new AggregateError(
        leaves,
        `retention cleanup ${operationIndex} root`,
      );
      sourceObjects.add(root);
      return root;
    });
    let releasePausedCleanup!: () => void;
    const pausedCleanupGate = new Promise<void>((resolve) => {
      releasePausedCleanup = resolve;
    });
    let markPausedCleanupStarted!: () => void;
    const pausedCleanupStarted = new Promise<void>((resolve) => {
      markPausedCleanupStarted = resolve;
    });
    const features = cleanupRoots.map((root, index) => {
      const feature = fakeFeature(`retention-feature-${index}`, log);
      feature.dispose = index === 2
        ? async () => {
            log.push(`retention-feature-${index}.dispose`);
            markPausedCleanupStarted();
            await pausedCleanupGate;
            throw root;
          }
        : () => {
            log.push(`retention-feature-${index}.dispose`);
            throw root;
          };
      return feature;
    });
    const deps = dependencies(log, features);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const primary = new Error("retention primary");

    deps.backend.emit("device-lost", primary);
    const published = host.error!;
    await pausedCleanupStarted;
    expect(host.getSnapshot().counters.retainedIntermediateFailureSnapshots)
      .toBeGreaterThan(0);
    releasePausedCleanup();
    await host.whenIdle();

    expect(host.error).toBe(published);
    const inspected = inspectTerminalFailureEvidence(published.cause);
    expect(inspected.nodes).toBeLessThanOrEqual(8_192);
    expect(inspected.terminalMarkers).toHaveLength(1);
    expect(inspected.terminalMarkers[0].message).toContain("output budget");
    expect([...sourceObjects].some((source) => inspected.retained.has(source))).toBe(false);
    expect(host.getSnapshot().counters).toMatchObject({
      retainedIntermediateFailureSnapshots: 0,
      retainedRawFailureCauses: 0,
    });
    await expect(host.dispose()).rejects.toBe(published);
    expect(host.getSnapshot().counters.retainedIntermediateFailureSnapshots).toBe(0);
  });

  it("reports depth-only loss truthfully when a deep primary gains ordinary cleanup", async () => {
    const log: string[] = [];
    const sourceObjects = new Set<object>();
    let deepPrimary: Error = new Error("depth-only primary leaf");
    sourceObjects.add(deepPrimary);
    for (let index = 0; index < 258; index += 1) {
      deepPrimary = new Error(`depth-only primary layer ${index}`, { cause: deepPrimary });
      sourceObjects.add(deepPrimary);
    }
    const cleanup = new Error("ordinary depth cleanup");
    sourceObjects.add(cleanup);
    const feature = fakeFeature("depth-only-feature", log);
    feature.dispose = () => {
      log.push("depth-only-feature.dispose");
      throw cleanup;
    };
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", deepPrimary);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    const inspected = inspectTerminalFailureEvidence(published.cause);
    expect(inspected.nodes).toBe(3);
    expect(inspected.terminalMarkers).toHaveLength(1);
    expect(inspected.terminalMarkers[0].message).toContain("safe-snapshot depth 256");
    expect(inspected.terminalMarkers[0].message).not.toContain("output budget");
    expect(inspected.terminalMarkers[0].message).not.toContain("ingress budget");
    expect(inspected.messages).toContain(cleanup.message);
    expect([...sourceObjects].some((source) => inspected.retained.has(source))).toBe(false);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("combines depth and final-output provenance in one terminal marker", async () => {
    const log: string[] = [];
    const sourceObjects = new Set<object>();
    let deepPrimary: Error = new Error("combined primary leaf");
    sourceObjects.add(deepPrimary);
    for (let index = 0; index < 258; index += 1) {
      deepPrimary = new Error(`combined primary layer ${index}`, { cause: deepPrimary });
      sourceObjects.add(deepPrimary);
    }
    const cleanupFanout = (prefix: string): AggregateError => {
      const leaves = Array.from({ length: 3_000 }, (_, index) => {
        const leaf = new Error(`${prefix} leaf ${index}`);
        sourceObjects.add(leaf);
        return leaf;
      });
      const root = new AggregateError(leaves, `${prefix} root`);
      sourceObjects.add(root);
      return root;
    };
    const cleanupA = cleanupFanout("combined cleanup A");
    const cleanupB = cleanupFanout("combined cleanup B");
    const cleanupC = cleanupFanout("combined cleanup C");
    const featureA = fakeFeature("combined-feature-a", log);
    const featureB = fakeFeature("combined-feature-b", log);
    const featureC = fakeFeature("combined-feature-c", log);
    featureA.dispose = () => {
      log.push("combined-feature-a.dispose");
      throw cleanupA;
    };
    featureB.dispose = () => {
      log.push("combined-feature-b.dispose");
      throw cleanupB;
    };
    featureC.dispose = () => {
      log.push("combined-feature-c.dispose");
      throw cleanupC;
    };
    const deps = dependencies(log, [featureA, featureB, featureC]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", deepPrimary);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    const inspected = inspectTerminalFailureEvidence(published.cause);
    expect(inspected.nodes).toBeLessThanOrEqual(8_192);
    expect(inspected.terminalMarkers).toHaveLength(1);
    expect(inspected.terminalMarkers[0].message).toContain("safe-snapshot depth 256");
    expect(inspected.terminalMarkers[0].message).toContain(
      "shared 8192-node output budget",
    );
    expect(inspected.terminalMarkers[0].message).not.toContain("ingress budget");
    expect(inspected.terminalMarkers[0].message).not.toContain("hostile inspection");
    expect(inspected.messages).toContain("combined cleanup A leaf 0");
    expect(inspected.messages).toContain("combined cleanup B leaf 0");
    expect(inspected.messages).toContain("combined cleanup C leaf 0");
    expect([...sourceObjects].some((source) => inspected.retained.has(source))).toBe(false);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("reserves every cleanup aggregate root before distributing details fairly", async () => {
    const log: string[] = [];
    const channelCount = 40;
    const sourceObjects = new Set<object>();
    const roots = Array.from({ length: channelCount }, (_, index) => {
      const leaves = Array.from(
        { length: index % 2 === 0 ? 256 : 257 },
        (_unused, leafIndex) => {
          const leaf = new Error(`fair cleanup ${index} leaf ${leafIndex}`);
          sourceObjects.add(leaf);
          return leaf;
        },
      );
      const root = new AggregateError(
        leaves,
        `fair cleanup root ${index}`,
        { cause: index % 2 === 0 ? +0 : -0 },
      );
      sourceObjects.add(root);
      return root;
    });
    const features = roots.map((root, index) => {
      const feature = fakeFeature(`fair-channel-${index}`, log);
      feature.dispose = () => {
        log.push(`fair-channel-${index}.dispose`);
        throw root;
      };
      return feature;
    });
    const deps = dependencies(log, features);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const primary = new Error("fair channel primary");

    deps.backend.emit("device-lost", primary);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    const finalCause = published.cause as AggregateError;
    expect(finalCause.errors[0]).toBe(primary);
    const inspected = inspectTerminalFailureEvidence(finalCause);
    expect(inspected.nodes).toBeLessThanOrEqual(8_192);
    expect(inspected.terminalMarkers).toHaveLength(1);
    expect(inspected.terminalMarkers[0].message).toContain(
      "shared 8192-node output budget",
    );
    expect(inspected.terminalMarkers[0].message).not.toContain("Omitted");
    const retainedRoots = finalCause.errors.filter((value): value is AggregateError => (
      value instanceof AggregateError && value.message.startsWith("fair cleanup root ")
    ));
    expect(retainedRoots).toHaveLength(channelCount);
    expect(retainedRoots.map((root) => root.message)).toEqual(
      Array.from(
        { length: channelCount },
        (_unused, index) => `fair cleanup root ${channelCount - index - 1}`,
      ),
    );
    for (const root of retainedRoots) {
      const index = Number(root.message.slice("fair cleanup root ".length));
      expect(Object.is(root.cause, index % 2 === 0 ? +0 : -0)).toBe(true);
      expect(Object.isFrozen(root)).toBe(true);
      expect(Object.isFrozen(root.errors)).toBe(true);
    }
    const detailCounts = retainedRoots.map((root) => root.errors.length);
    expect(Math.min(...detailCounts)).toBeGreaterThan(0);
    expect(Math.max(...detailCounts) - Math.min(...detailCounts)).toBeLessThanOrEqual(1);
    expect([...sourceObjects].some((source) => inspected.retained.has(source))).toBe(false);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("reports the exact cleanup channel count omitted when root summaries exceed the budget", async () => {
    const log: string[] = [];
    const channelCount = 2_800;
    const sourceRoots = new Set<AggregateError>();
    const roots = Array.from({ length: channelCount }, (_, index) => {
      const root = new AggregateError(
        [],
        `overflow cleanup root ${index}`,
        { cause: index % 2 === 0 ? +0 : -0 },
      );
      sourceRoots.add(root);
      return root;
    });
    const features = roots.map((root, index) => {
      const feature = fakeFeature(`overflow-channel-${index}`, log);
      feature.dispose = () => {
        log.push(`overflow-channel-${index}.dispose`);
        throw root;
      };
      return feature;
    });
    const deps = dependencies(log, features);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const primary = new Error("overflow channel primary");

    deps.backend.emit("device-lost", primary);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    const finalCause = published.cause as AggregateError;
    expect(finalCause.errors[0]).toBe(primary);
    const inspected = inspectTerminalFailureEvidence(finalCause);
    expect(inspected.nodes).toBeLessThanOrEqual(8_192);
    expect(inspected.terminalMarkers).toHaveLength(1);
    expect(inspected.terminalMarkers[0].message).toContain(
      "shared 8192-node output budget",
    );
    const retainedRoots = finalCause.errors.filter((value): value is AggregateError => (
      value instanceof AggregateError && value.message.startsWith("overflow cleanup root ")
    ));
    const omittedChannels = channelCount - retainedRoots.length;
    expect(omittedChannels).toBeGreaterThan(0);
    expect(inspected.terminalMarkers[0].message).toContain(
      `Omitted ${omittedChannels} cleanup operation channel(s)`,
    );
    expect(retainedRoots[0]?.message).toBe(`overflow cleanup root ${channelCount - 1}`);
    expect(retainedRoots.every((root) => (
      Object.isFrozen(root)
      && Object.isFrozen(root.errors)
      && root.errors.length === 0
    ))).toBe(true);
    for (const root of retainedRoots) {
      const index = Number(root.message.slice("overflow cleanup root ".length));
      expect(Object.is(root.cause, index % 2 === 0 ? +0 : -0)).toBe(true);
    }
    expect([...sourceRoots].some((source) => inspected.retained.has(source))).toBe(false);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it.each([2_729, 2_730])(
    "reserves a trailing atomic cleanup head before details with %i aggregate channels",
    async (aggregateCount) => {
      const log: string[] = [];
      const sourceObjects = new Set<object>();
      const aggregateFailures = Array.from({ length: aggregateCount }, (_, index) => {
        const detail = new Error(`mixed head detail ${index}`);
        const root = new AggregateError(
          [detail],
          `mixed head root ${index}`,
          { cause: index % 2 === 0 ? +0 : -0 },
        );
        sourceObjects.add(detail);
        sourceObjects.add(root);
        return root;
      });
      const atomic = new Error(`trailing atomic head ${aggregateCount}`);
      sourceObjects.add(atomic);
      const operationFailures: unknown[] = [...aggregateFailures, atomic];
      const features = operationFailures.slice().reverse().map((failure, index) => {
        const feature = fakeFeature(`mixed-head-feature-${index}`, log);
        feature.dispose = () => {
          log.push(`mixed-head-feature-${index}.dispose`);
          throw failure;
        };
        return feature;
      });
      const deps = dependencies(log, features);
      const host = new RenderHost(deps);
      await host.initialize(journeySnapshot(), VIEWPORT);
      const primary = new Error(`mixed head primary ${aggregateCount}`);

      deps.backend.emit("device-lost", primary);
      const published = host.error!;
      await host.whenIdle();

      expect(host.error).toBe(published);
      const finalCause = published.cause as AggregateError;
      expect(finalCause.errors[0]).toBe(primary);
      const inspected = inspectTerminalFailureEvidence(finalCause);
      expect(inspected.nodes).toBeLessThanOrEqual(8_192);
      expect(inspected.terminalMarkers).toHaveLength(1);
      const atomicEvidence = finalCause.errors.find((value) => (
        value instanceof Error && value.message === atomic.message
      ));
      expect(atomicEvidence).toBeInstanceOf(Error);
      expect(atomicEvidence).not.toBe(atomic);
      const retainedRoots = finalCause.errors.filter((value): value is AggregateError => (
        value instanceof AggregateError && value.message.startsWith("mixed head root ")
      ));
      const omittedChannels = aggregateCount - retainedRoots.length;
      expect(omittedChannels).toBe(aggregateCount === 2_729 ? 0 : 1);
      if (omittedChannels === 0) {
        expect(inspected.terminalMarkers[0].message).not.toContain("Omitted");
      } else {
        expect(inspected.terminalMarkers[0].message).toContain(
          `Omitted ${omittedChannels} cleanup operation channel(s)`,
        );
      }
      expect(retainedRoots.reduce(
        (total, root) => total + root.errors.length,
        0,
      )).toBe(1);
      expect([...sourceObjects].some((source) => inspected.retained.has(source))).toBe(false);
      expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
      await expect(host.dispose()).rejects.toBe(published);
    },
  );

  it("reserves mixed cross-realm aggregate, Error, primitive, and hostile cleanup heads", async () => {
    const log: string[] = [];
    const { aggregateDetail, causeLess } = runInNewContext(`(() => {
      const aggregateDetail = new Error("mixed cause-less detail");
      return {
        aggregateDetail,
        causeLess: new AggregateError([aggregateDetail], "mixed cause-less root"),
      };
    })()`) as { aggregateDetail: Error; causeLess: AggregateError };
    const plainError = new Error("mixed plain Error head");
    const primitive = -0;
    const hostile = new Error("mixed hostile Error");
    Object.defineProperty(hostile, "cause", {
      configurable: true,
      get() { throw new Error("mixed hostile cause getter"); },
    });
    const uninspectable = new Proxy({}, {
      getPrototypeOf() { throw new Error("mixed prototype inspection trap"); },
    });
    const sourceObjects = new Set<object>([
      aggregateDetail,
      causeLess,
      plainError,
      hostile,
      uninspectable,
    ]);
    const operationFailures: unknown[] = [
      causeLess,
      plainError,
      primitive,
      hostile,
      uninspectable,
    ];
    const features = operationFailures.slice().reverse().map((failure, index) => {
      const feature = fakeFeature(`mixed-kind-feature-${index}`, log);
      feature.dispose = () => {
        log.push(`mixed-kind-feature-${index}.dispose`);
        throw failure;
      };
      return feature;
    });
    const deps = dependencies(log, features);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const primary = new Error("mixed kind primary");

    deps.backend.emit("device-lost", primary);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    const finalCause = published.cause as AggregateError;
    expect(finalCause.errors[0]).toBe(primary);
    const inspected = inspectTerminalFailureEvidence(finalCause);
    expect(inspected.nodes).toBeLessThanOrEqual(8_192);
    expect(inspected.terminalMarkers).toHaveLength(1);
    expect(inspected.terminalMarkers[0].message).toContain("hostile inspection");
    expect(inspected.terminalMarkers[0].message).not.toContain("output budget");
    expect(inspected.terminalMarkers[0].message).not.toContain("Omitted");
    const aggregateEvidence = finalCause.errors.find((value): value is AggregateError => (
      value instanceof AggregateError && value.message === causeLess.message
    ));
    expect(aggregateEvidence).toBeInstanceOf(AggregateError);
    expect(Object.prototype.hasOwnProperty.call(aggregateEvidence, "cause")).toBe(false);
    expect(aggregateEvidence?.errors).toEqual([
      expect.objectContaining({ message: aggregateDetail.message }),
    ]);
    expect(finalCause.errors).toContainEqual(
      expect.objectContaining({ message: plainError.message }),
    );
    expect(finalCause.errors.some((value) => Object.is(value, -0))).toBe(true);
    expect(finalCause.errors).toContainEqual(expect.objectContaining({
      message: "Sanitized cleanup operation head retained after evidence loss.",
    }));
    const hostileEnvelope = finalCause.errors.find((value): value is AggregateError => (
      value instanceof AggregateError
      && value.message === "Sanitized cleanup operation with an uninspectable failure root."
    ));
    expect(hostileEnvelope).toBeInstanceOf(AggregateError);
    expect(hostileEnvelope?.errors).toEqual([]);
    expect(Object.isFrozen(hostileEnvelope)).toBe(true);
    expect([...sourceObjects].some((source) => inspected.retained.has(source))).toBe(false);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("publishes hostile provenance discovered only during final recomposition", async () => {
    const log: string[] = [];
    const primary = new Error("mutable primary before final composition");
    const cleanup = new Error("ordinary cleanup after primary mutation");
    const feature = fakeFeature("final-hostile-feature", log);
    feature.dispose = () => {
      log.push("final-hostile-feature.dispose");
      Object.defineProperty(primary, "cause", {
        configurable: true,
        get() { throw new Error("late primary cause getter"); },
      });
      throw cleanup;
    };
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", primary);
    const published = host.error!;
    expect(published.cause).toBe(primary);
    await host.whenIdle();

    expect(host.error).toBe(published);
    const inspected = inspectTerminalFailureEvidence(published.cause);
    expect(inspected.nodes).toBe(4);
    expect(inspected.terminalMarkers).toHaveLength(1);
    expect(inspected.terminalMarkers[0].message).toContain("hostile inspection");
    expect(inspected.terminalMarkers[0].message).not.toContain("safe-snapshot depth");
    expect(inspected.terminalMarkers[0].message).not.toContain("ingress budget");
    expect(inspected.terminalMarkers[0].message).not.toContain("output budget");
    expect(inspected.messages).toContain("Error failure cause could not be inspected.");
    expect(inspected.messages).toContain(cleanup.message);
    expect(inspected.retained.has(primary)).toBe(false);
    expect(inspected.retained.has(cleanup)).toBe(false);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("totally recomposes a primary proxy that becomes prototype-hostile during cleanup", async () => {
    const log: string[] = [];
    const primaryTarget = new Error("primary before delayed prototype trap");
    let prototypeInspectionThrows = false;
    const primary = new Proxy(primaryTarget, {
      getPrototypeOf(target) {
        if (prototypeInspectionThrows) {
          throw new Error("delayed primary prototype inspection trap");
        }
        return Reflect.getPrototypeOf(target);
      },
    });
    const cleanup = new Error("cleanup after delayed primary prototype trap");
    const feature = fakeFeature("delayed-prototype-feature", log);
    feature.dispose = () => {
      log.push("delayed-prototype-feature.dispose");
      prototypeInspectionThrows = true;
      throw cleanup;
    };
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", primary);
    const published = host.error!;
    expect(published.cause).toBe(primary);
    await host.whenIdle();

    expect(host.error).toBe(published);
    const inspected = inspectTerminalFailureEvidence(published.cause);
    expect(inspected.nodes).toBeLessThanOrEqual(8_192);
    expect(inspected.terminalMarkers).toHaveLength(1);
    expect(inspected.terminalMarkers[0].message).toContain("hostile inspection");
    expect(inspected.terminalMarkers[0].message).not.toContain("safe-snapshot depth");
    expect(inspected.terminalMarkers[0].message).not.toContain("ingress budget");
    expect(inspected.terminalMarkers[0].message).not.toContain("output budget");
    expect(inspected.messages).toContain("Failure value type could not be inspected.");
    expect(inspected.messages).toContain(cleanup.message);
    expect(inspected.retained.has(primary)).toBe(false);
    expect(inspected.retained.has(cleanup)).toBe(false);
    for (const value of inspected.retained) expect(Object.isFrozen(value)).toBe(true);
    expect(host.getSnapshot().counters).toMatchObject({
      retainedIntermediateFailureSnapshots: 0,
      retainedRawFailureCauses: 0,
    });
    await expect(host.dispose()).rejects.toBe(published);
    expect(host.getSnapshot().counters.retainedIntermediateFailureSnapshots).toBe(0);
  });

  it("sanitizes nested AggregateError evidence during explicit disposal", async () => {
    const log: string[] = [];
    const cleanup = new Error("nested explicit cleanup leaf");
    const nested = new AggregateError([cleanup], "mutable nested cleanup");
    const feature = fakeFeature("feature", log);
    feature.dispose = () => {
      log.push("feature.dispose");
      throw nested;
    };
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    const failure = await host.dispose().catch((error: unknown) => error) as RenderHostError;
    const evidence = (failure.cause as AggregateError).errors;
    expect(evidence).toEqual([cleanup]);
    expect(evidence).not.toContain(nested);

    nested.errors.splice(0);
    expect((failure.cause as AggregateError).errors).toEqual([cleanup]);
  });

  it("snapshots a mutable AggregateError used as the primary initialization rejection", async () => {
    const log: string[] = [];
    const first = new Error("primary initialization leaf");
    const second = new Error("secondary initialization leaf");
    const mutable = new AggregateError([first, second], "mutable initialization aggregate");
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      throw mutable;
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    const evidence = failure.cause as AggregateError;
    expect(evidence).not.toBe(mutable);
    expect(evidence.errors).toEqual([first, second]);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.errors)).toBe(true);

    mutable.errors.splice(0);
    mutable.errors.push(failure);
    expect((failure.cause as AggregateError).errors).toEqual([first, second]);
  });

  it("snapshots a mutable AggregateError used as a primary backend fault", async () => {
    const log: string[] = [];
    const first = new Error("backend fault leaf");
    const second = new Error("backend context leaf");
    const mutable = new AggregateError([first, second], "mutable backend aggregate");
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", mutable);
    const published = host.error!;
    await host.whenIdle();
    const evidence = published.cause as AggregateError;
    expect(evidence).not.toBe(mutable);
    expect(evidence.errors).toEqual([first, second]);

    mutable.errors.splice(0);
    mutable.errors.push(published);
    expect((published.cause as AggregateError).errors).toEqual([first, second]);
  });

  it("consumes one raw Aggregate primary propagated by both event and initialization rejection", async () => {
    const log: string[] = [];
    const first = new Error("shared aggregate first leaf");
    const second = new Error("shared aggregate second leaf");
    const shared = new AggregateError([first, second], "shared event and rejection");
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      deps.backend.emit("device-lost", shared);
      throw shared;
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;

    expect(failure).toBe(host.error);
    expect((failure.cause as AggregateError).errors).toEqual([first, second]);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    expect(host.getSnapshot().events.filter((event) => event.kind === "disposal-error"))
      .toHaveLength(0);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("uses SameValue semantics for a propagated NaN primary sentinel", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      deps.backend.emit("device-lost", Number.NaN);
      throw Number.NaN;
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;

    expect(Number.isNaN(failure.cause)).toBe(true);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    expect(host.getSnapshot().events.filter((event) => event.kind === "disposal-error"))
      .toHaveLength(0);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("consumes an empty Aggregate cause that only propagates a primitive primary", async () => {
    const cases = [
      { label: "NaN", primary: Number.NaN },
      { label: "negative-zero", primary: -0 },
    ];
    for (const { label, primary } of cases) {
      const log: string[] = [];
      const deps = dependencies(log, [fakeFeature(`feature-${label}`, log)]);
      const propagated = new AggregateError(
        [],
        `empty propagated ${label} wrapper`,
        { cause: primary },
      );
      let published: RenderHostError | null = null;
      deps.backend.initialize = async () => {
        log.push("backend.initialize");
        deps.backend.emit("device-lost", primary);
        published = host.error;
        throw propagated;
      };
      const host = new RenderHost(deps);

      const firstInitialization = host.initialize(journeySnapshot(), VIEWPORT);
      const secondInitialization = host.initialize(journeySnapshot(), VIEWPORT);
      expect(secondInitialization).toBe(firstInitialization);
      const [firstFailure, secondFailure] = await Promise.all([
        firstInitialization.catch((error: unknown) => error),
        secondInitialization.catch((error: unknown) => error),
      ]) as [RenderHostError, RenderHostError];

      expect(firstFailure).toBe(published);
      expect(secondFailure).toBe(published);
      expect(Object.is(firstFailure.cause, primary)).toBe(true);
      expect(firstFailure.cause).not.toBeInstanceOf(AggregateError);
      expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
      expect(host.getSnapshot().events.filter((event) => event.kind === "disposal-error"))
        .toHaveLength(0);
      await expect(host.dispose()).resolves.toBeUndefined();
    }
  });

  it("reserves a propagated Aggregate cause before retaining same-value entries", async () => {
    const cases = [
      { label: "NaN", primary: Number.NaN, entries: [Number.NaN, Number.NaN] },
      { label: "signed-zero", primary: -0, entries: [-0, +0, -0] },
    ];
    for (const { label, primary, entries } of cases) {
      const log: string[] = [];
      const deps = dependencies(log, [fakeFeature(`feature-${label}`, log)]);
      const propagated = new AggregateError(
        [],
        `nonempty propagated ${label} wrapper`,
        { cause: primary },
      );
      let errorEntryReads = 0;
      Object.defineProperty(propagated, "errors", {
        configurable: true,
        get() {
          errorEntryReads += 1;
          if (label === "signed-zero") {
            Object.defineProperty(propagated, "cause", { value: +0 });
          }
          return entries;
        },
      });
      let published: RenderHostError | null = null;
      deps.backend.initialize = async () => {
        log.push("backend.initialize");
        deps.backend.emit("device-lost", primary);
        published = host.error;
        throw propagated;
      };
      const host = new RenderHost(deps);

      const failure = await host.initialize(journeySnapshot(), VIEWPORT)
        .catch((error: unknown) => error) as RenderHostError;
      const evidence = (failure.cause as AggregateError).errors;

      expect(failure).toBe(published);
      expect(errorEntryReads).toBe(1);
      expect(evidence).toHaveLength(2);
      expect(Object.is(evidence[0], primary)).toBe(true);
      expect(evidence[1]).toBeInstanceOf(AggregateError);
      const operation = evidence[1] as AggregateError;
      expect(operation.message).toBe(`nonempty propagated ${label} wrapper`);
      entries.forEach((entry, index) => {
        expect(Object.is(operation.errors[index], entry)).toBe(true);
      });
      expect(Object.prototype.hasOwnProperty.call(operation, "cause")).toBe(false);
      expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
      const firstDisposal = host.dispose();
      const secondDisposal = host.dispose();
      expect(secondDisposal).toBe(firstDisposal);
      await expect(firstDisposal).rejects.toBe(published);
    }
  });

  it("does not consume +0 Aggregate cause as a propagated -0 primary", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const propagated = new AggregateError([], "distinct signed-zero wrapper", { cause: +0 });
    let published: RenderHostError | null = null;
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      deps.backend.emit("device-lost", -0);
      published = host.error;
      throw propagated;
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    const evidence = (failure.cause as AggregateError).errors;
    const supplemental = evidence[1] as AggregateError;

    expect(failure).toBe(published);
    expect(evidence).toHaveLength(2);
    expect(Object.is(evidence[0], -0)).toBe(true);
    expect(supplemental).toBeInstanceOf(AggregateError);
    expect(supplemental).not.toBe(propagated);
    expect(supplemental.errors).toEqual([]);
    expect(Object.is(supplemental.cause, +0)).toBe(true);
    expect(Object.isFrozen(supplemental)).toBe(true);
    expect(Object.isFrozen(supplemental.errors)).toBe(true);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("keeps a +0 secondary occurrence distinct from a -0 primary sentinel", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      deps.backend.emit("device-lost", -0);
      throw +0;
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    const evidence = (failure.cause as AggregateError).errors;

    expect(evidence).toHaveLength(2);
    expect(Object.is(evidence[0], -0)).toBe(true);
    expect(Object.is(evidence[1], +0)).toBe(true);
    await expect(host.dispose()).rejects.toBe(failure);
  });

  it("claims a backend fault before hostile primary evidence can reenter failure ownership", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const primaryLeaf = new Error("outer primary leaf");
    const nestedLoss = new Error("nested getter loss");
    let getterReads = 0;
    let reentrantDispose: Promise<unknown> | null = null;
    const hostile = new AggregateError([], "hostile primary aggregate");
    Object.defineProperty(hostile, "errors", {
      configurable: true,
      get() {
        getterReads += 1;
        deps.backend.emit("renderer-error", nestedLoss);
        reentrantDispose = host.dispose().catch((error: unknown) => error);
        return [primaryLeaf];
      },
    });

    deps.backend.emit("device-lost", hostile);
    const firstJoin = host.dispose();
    const secondJoin = host.dispose();
    expect(firstJoin).toBe(secondJoin);
    await host.whenIdle();

    expect(getterReads).toBe(1);
    await expect(reentrantDispose).resolves.toMatchObject({ code: "INVALID_LIFECYCLE" });
    expect(host.getSnapshot().counters).toMatchObject({ failures: 1, backendEvents: 2 });
    expect(host.error?.cause).toBe(primaryLeaf);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    expect(host.getSnapshot().events.filter((event) => event.detail === "ready->failed"))
      .toHaveLength(1);
    await expect(firstJoin).resolves.toBeUndefined();
  });

  it("sanitizes pre-terminal cleanup aggregates before final attachment", async () => {
    const log: string[] = [];
    const stopFailure = new Error("pre-terminal loop stop leaf");
    const mutable = new AggregateError([stopFailure], "mutable pre-terminal cleanup");
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    let stopCalls = 0;
    deps.frameLoop.stop = () => {
      stopCalls += 1;
      if (stopCalls === 1) throw mutable;
      deps.frameLoop.running = false;
    };
    const host = new RenderHost(deps);
    feature.dispose = async () => {
      log.push("feature.dispose");
      deps.backend.emit("device-lost", new Error("loss during disposal cleanup"));
    };
    await host.initialize(journeySnapshot(), VIEWPORT);

    const failure = await host.dispose().catch((error: unknown) => error) as RenderHostError;
    const evidence = failure.cause as AggregateError;
    expect(evidence.errors[0]).toMatchObject({ message: "loss during disposal cleanup" });
    expect(evidence.errors[1]).toBeInstanceOf(AggregateError);
    expect((evidence.errors[1] as AggregateError).message).toBe(
      "mutable pre-terminal cleanup",
    );
    expect((evidence.errors[1] as AggregateError).errors).toEqual([
      expect.objectContaining({ message: stopFailure.message }),
    ]);
    expect(evidence.errors).not.toContain(mutable);

    mutable.errors.splice(0);
    mutable.errors.push(failure);
    const retained = (failure.cause as AggregateError).errors;
    expect(retained[0]).toMatchObject({ message: "loss during disposal cleanup" });
    expect((retained[1] as AggregateError).errors).toEqual([
      expect.objectContaining({ message: stopFailure.message }),
    ]);
  });

  it("snapshots cleanup evidence before awaiting later disposal stages", async () => {
    const log: string[] = [];
    const original = new Error("original loop-stop evidence");
    const replacement = new Error("mutated loop-stop evidence");
    const mutable = new AggregateError([original], "mutable loop-stop aggregate");
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    let stopCalls = 0;
    deps.frameLoop.stop = () => {
      stopCalls += 1;
      if (stopCalls === 1) throw mutable;
      deps.frameLoop.running = false;
    };
    let releaseFeature!: () => void;
    const featureGate = new Promise<void>((resolve) => { releaseFeature = resolve; });
    let featureStarted!: () => void;
    const featureStartedPromise = new Promise<void>((resolve) => { featureStarted = resolve; });
    feature.dispose = async () => {
      log.push("feature.dispose");
      featureStarted();
      await featureGate;
    };
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    const disposal = host.dispose().catch((error: unknown) => error) as Promise<RenderHostError>;
    await featureStartedPromise;
    expect(host.getSnapshot().counters.retainedIntermediateFailureSnapshots)
      .toBeGreaterThan(0);
    mutable.errors[0] = replacement;
    releaseFeature();
    const failure = await disposal;
    const messages = (failure.cause as AggregateError).errors
      .map((error) => (error as Error).message);

    expect(messages).toContain(original.message);
    expect(messages).not.toContain(replacement.message);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(0);
    expect(host.getSnapshot().counters.retainedIntermediateFailureSnapshots).toBe(0);
  });

  it("fails closed instead of deadlocking when initialization awaits its own idle barrier", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    let waitForIdle = () => Promise.resolve();
    feature.initialize = async () => {
      log.push("feature.initialize");
      await waitForIdle();
    };
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    waitForIdle = () => host.whenIdle();

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "INVALID_LIFECYCLE",
    });
    expect(host.state).toBe("failed");
    expect(deps.backend.disposed).toBe(true);
  });

  it("fails a nested control instead of letting it deadlock the control queue", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    deps.materials.quality = async (profile) => {
      log.push(`materials.quality:${profile.tier}`);
      if (profile.tier === "balanced") {
        await host.resize({ width: 900, height: 600, pixelRatio: 1 });
      }
    };
    await host.initialize(journeySnapshot(), VIEWPORT);

    const failure = await host.setQuality({ ...HIGH, tier: "balanced" })
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure).toMatchObject({ code: "INVALID_LIFECYCLE" });
    expect(log).not.toContain("backend.resize:900x600");
    expect(host.getSnapshot().counters.pendingControlOperations).toBe(0);
    expect(host.state).toBe("failed");
  });

  it("fails a control reentered synchronously by backend resize instead of deadlocking", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    deps.backend.resize = async (viewport) => {
      log.push(`backend.resize:${viewport.width}x${viewport.height}`);
      await host.setQuality({ ...HIGH, tier: "low" });
    };
    await host.initialize(journeySnapshot(), VIEWPORT);

    const failure = await host.resize({ width: 900, height: 600, pixelRatio: 1 })
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure).toMatchObject({ code: "INVALID_LIFECYCLE" });
    expect(log).not.toContain("materials.quality:low");
    expect(host.getSnapshot().counters.pendingControlOperations).toBe(0);
    expect(host.state).toBe("failed");
  });

  it.each([
    {
      label: "primitive signed-zero",
      primary: () => -0,
    },
    {
      label: "weak object",
      primary: () => new Error("weakly tracked object primary"),
    },
  ])("counts a pending $label terminal provenance occurrence", async ({ primary: makePrimary }) => {
    const log: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    const feature = fakeFeature("raw-counter-feature", log);
    feature.dispose = async () => {
      log.push("raw-counter-feature.dispose");
      markCleanupStarted();
      await cleanupGate;
    };
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const primary = makePrimary();

    deps.backend.emit("device-lost", primary);
    const published = host.error!;
    await cleanupStarted;

    expect(host.state).toBe("failed");
    expect(Object.is(published.cause, primary)).toBe(true);
    expect(host.getSnapshot().counters).toMatchObject({
      retainedIntermediateFailureSnapshots: 0,
      retainedRawFailureCauses: 1,
    });

    releaseCleanup();
    await host.whenIdle();
    expect(host.getSnapshot().counters).toMatchObject({
      retainedIntermediateFailureSnapshots: 0,
      retainedRawFailureCauses: 0,
    });
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("deduplicates one raw occurrence tracked by both control-tail and terminal provenance", async () => {
    const log: string[] = [];
    const shared = new Error("shared control and terminal raw occurrence");
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve; });
    const feature = fakeFeature("dual-raw-counter-feature", log);
    feature.dispose = async () => {
      log.push("dual-raw-counter-feature.dispose");
      markCleanupStarted();
      await cleanupGate;
    };
    const deps = dependencies(log, [feature]);
    deps.backend.resize = async () => { throw shared; };
    const host = new RenderHost(deps);
    let countWhileBothTrackersWerePresent: number | null = null;
    host.subscribe(() => {
      if (host.state !== "failed" || countWhileBothTrackersWerePresent !== null) return;
      countWhileBothTrackersWerePresent = host.getSnapshot().counters.retainedRawFailureCauses;
    });
    await host.initialize(journeySnapshot(), VIEWPORT);

    const resizeFailure = host.resize({ width: 900, height: 600, pixelRatio: 1 })
      .catch((error: unknown) => error) as Promise<RenderHostError>;
    await cleanupStarted;

    expect(countWhileBothTrackersWerePresent).toBe(1);
    expect(host.getSnapshot().counters.retainedRawFailureCauses).toBe(1);
    releaseCleanup();
    const terminal = await resizeFailure;
    await host.whenIdle();

    expect(terminal).toBe(host.error);
    expect(terminal.cause).toBe(shared);
    expect(host.getSnapshot().counters).toMatchObject({
      retainedIntermediateFailureSnapshots: 0,
      retainedRawFailureCauses: 0,
    });
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("releases the raw rejected control-tail promise after terminal evidence capture", async () => {
    const log: string[] = [];
    const original = new Error("original resize failure");
    const replacement = new Error("mutated resize failure");
    const mutable = new AggregateError([original], "mutable resize aggregate");
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.backend.resize = async () => { throw mutable; };
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    const failure = await host.resize({ width: 900, height: 600, pixelRatio: 1 })
      .catch((error: unknown) => error) as RenderHostError;
    mutable.errors[0] = replacement;

    expect(failure).toBe(host.error);
    expect((failure.cause as Error).message).toBe(original.message);
    expect(host.getSnapshot().counters).toMatchObject({
      pendingControlOperations: 0,
      retainedRawFailureCauses: 0,
    });
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("delivers a probe event to the original listener snapshot", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    const later = vi.fn();
    let unsubscribeLater: () => void = () => undefined;
    host.subscribe(() => unsubscribeLater());
    unsubscribeLater = host.subscribe(later);

    await host.initialize(journeySnapshot(), VIEWPORT);
    expect(later).toHaveBeenCalled();
    const callsAfterFirstPublication = later.mock.calls.length;
    host.setSnapshot({ ...journeySnapshot(), storyTime: 13 });
    expect(later).toHaveBeenCalledTimes(callsAfterFirstPublication);
    await host.dispose();
  });

  it("publishes the initialize latch before snapshot accessors can reenter", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    const source = journeySnapshot();
    let reentrantInitialize: Promise<void> | null = null;
    Object.defineProperty(source, "seed", {
      configurable: true,
      get() {
        reentrantInitialize = host.initialize(source, VIEWPORT);
        return 20260818;
      },
    });

    const initialization = host.initialize(source, VIEWPORT);
    expect(reentrantInitialize).toBe(initialization);
    await initialization;
    expect(log.filter((entry) => entry === "backend.initialize")).toHaveLength(1);
    expect(deps.frameLoop.starts).toBe(1);
    await host.dispose();
  });

  it("does not overwrite a newer snapshot published from an initialization accessor", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    const source = journeySnapshot();
    const newer = { ...journeySnapshot(), storyTime: 99, shotId: "S14" };
    let published = false;
    Object.defineProperty(source, "seed", {
      configurable: true,
      get() {
        if (!published) {
          published = true;
          host.setSnapshot(newer);
        }
        return 20260818;
      },
    });

    await host.initialize(source, VIEWPORT);
    expect(host.journeySnapshot).toMatchObject({ storyTime: 99, shotId: "S14" });
    await host.dispose();
  });

  it("does not let a reentrant outer setSnapshot overwrite the newer publication", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const outer = journeySnapshot();
    const newer = { ...journeySnapshot(), storyTime: 121, shotId: "S17" };
    let published = false;
    Object.defineProperty(outer, "seed", {
      configurable: true,
      get() {
        if (!published) {
          published = true;
          host.setSnapshot(newer);
        }
        return 20260818;
      },
    });

    host.setSnapshot(outer);
    expect(host.journeySnapshot).toMatchObject({ storyTime: 121, shotId: "S17" });
    await host.dispose();
  });

  it("does not resurrect ownership when a snapshot accessor requests disposal", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    const source = journeySnapshot();
    let disposal: Promise<void> | null = null;
    Object.defineProperty(source, "seed", {
      configurable: true,
      get() {
        disposal ??= host.dispose();
        return 20260818;
      },
    });

    await host.initialize(source, VIEWPORT);
    expect(disposal).not.toBeNull();
    await disposal;
    expect(host.state).toBe("disposed");
    expect(deps.frameLoop).toMatchObject({ running: false, starts: 1, stops: 1 });
    expect(log.filter((entry) => entry === "backend.initialize")).toHaveLength(1);
    expect(log.filter((entry) => entry === "backend.dispose")).toHaveLength(1);
  });

  it("rejects synchronous Host reentry from its one-way lifecycle observer", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    let reentrantInitialize: Promise<void> | null = null;
    let reentrantDispose: Promise<void> | null = null;
    deps.observed.mockImplementation((event) => {
      if (event.kind !== "lifecycle") return;
      if (event.to === "initializing") {
        reentrantInitialize = host.initialize(journeySnapshot(), VIEWPORT);
        void reentrantInitialize.catch(() => undefined);
      }
      if (event.to === "disposing") {
        reentrantDispose = host.dispose();
        void reentrantDispose.catch(() => undefined);
      }
    });
    const initialization = host.initialize(journeySnapshot(), VIEWPORT);
    await initialization;
    await expect(reentrantInitialize).rejects.toMatchObject({ code: "INVALID_LIFECYCLE" });
    const disposal = host.dispose();
    await disposal;
    await expect(reentrantDispose).rejects.toMatchObject({ code: "INVALID_LIFECYCLE" });
    expect(deps.frameLoop).toMatchObject({ running: false, starts: 1, stops: 1 });
  });

  it("delivers a complete disposed snapshot before releasing probe subscribers", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    const delivered: ReturnType<RenderHost["getSnapshot"]>[] = [];
    host.subscribe(() => delivered.push(host.getSnapshot()));

    await host.initialize(journeySnapshot(), VIEWPORT);
    await host.dispose();

    expect(delivered.at(-1)).toMatchObject({
      lifecycle: "disposed",
      loopRunning: false,
      counters: { probeSubscribers: 0 },
      error: null,
    });
    expect(deps.backend.disposed).toBe(true);
    expect(host.getSnapshot().counters.probeSubscribers).toBe(0);
  });

  it("delivers the complete initialization failure after cleanup before releasing subscribers", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("partial-feature", log, { failInitialize: true })]);
    const host = new RenderHost(deps);
    const delivered: ReturnType<RenderHost["getSnapshot"]>[] = [];
    host.subscribe(() => delivered.push(host.getSnapshot()));

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "INITIALIZATION_FAILED",
    });

    expect(delivered.at(-1)).toMatchObject({
      lifecycle: "failed",
      loopRunning: false,
      counters: { probeSubscribers: 0 },
      error: { code: "INITIALIZATION_FAILED" },
    });
    expect(deps.backend.disposed).toBe(true);
  });

  it("cannot resurrect the frame loop when a ready subscriber disposes synchronously", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    let disposal: Promise<void> | null = null;
    host.subscribe(() => {
      if (host.state === "ready" && disposal === null) disposal = host.dispose();
    });

    await host.initialize(journeySnapshot(), VIEWPORT);
    expect(disposal).not.toBeNull();
    await disposal;
    expect(host.state).toBe("disposed");
    expect(deps.frameLoop).toMatchObject({ running: false, starts: 1, stops: 1 });
  });

  it("fails and stops the pre-owned loop when ready publication receives a backend failure", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    let injected = false;
    host.subscribe(() => {
      if (host.state !== "ready" || injected) return;
      injected = true;
      deps.backend.emit("device-lost", new Error("lost during ready publication"));
    });

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "BACKEND_RUNTIME_FAILED",
    });
    await host.whenIdle();
    expect(host.state).toBe("failed");
    expect(deps.backend.disposed).toBe(true);
    expect(deps.frameLoop).toMatchObject({ running: false, starts: 1, stops: 1 });
  });

  it("cannot overwrite a synchronous loop-start failure with ready", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.frameLoop.synchronousStartTickMs = 1;
    const host = new RenderHost(deps);
    let injected = false;
    host.subscribe(() => {
      if (injected || host.getSnapshot().counters.droppedFrames === 0) return;
      injected = true;
      deps.backend.emit("device-lost", new Error("lost during synchronous start"));
    });

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "BACKEND_RUNTIME_FAILED",
    });
    await host.whenIdle();
    expect(host.state).toBe("failed");
    expect(deps.frameLoop).toMatchObject({ running: false, starts: 1, stops: 1 });
    expect(host.getSnapshot().events).not.toContainEqual(expect.objectContaining({
      detail: "initializing->ready",
    }));
  });

  it("keeps one terminal error identity when ready publication and cleanup both fail", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log, { failDispose: true })]);
    const host = new RenderHost(deps);
    const deviceLoss = new Error("lost during ready publication");
    let injected = false;
    host.subscribe(() => {
      if (host.state !== "ready" || injected) return;
      injected = true;
      deps.backend.emit("device-lost", deviceLoss);
    });

    const initializationFailure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(initializationFailure).toBe(host.error);
    expect(initializationFailure).toMatchObject({ code: "BACKEND_RUNTIME_FAILED" });
    expect(initializationFailure.cause).toBeInstanceOf(AggregateError);
    expect((initializationFailure.cause as AggregateError).errors).toEqual([
      deviceLoss,
      expect.objectContaining({ message: "feature dispose failed" }),
    ]);
    await expect(host.dispose()).rejects.toBe(initializationFailure);
    expect(log.filter((entry) => entry === "feature.dispose")).toHaveLength(1);
    expect(log.filter((entry) => entry === "backend.dispose")).toHaveLength(1);
  });

  it("keeps one error identity when disposal and a backend fault race during ready publication", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log, { failDispose: true })]);
    const host = new RenderHost(deps);
    const deviceLoss = new Error("lost after ready disposal request");
    let disposal: Promise<void> | null = null;
    let injected = false;
    host.subscribe(() => {
      if (host.state !== "ready" || injected) return;
      injected = true;
      disposal = host.dispose();
      deps.backend.emit("device-lost", deviceLoss);
    });

    const initializationFailure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(disposal).not.toBeNull();
    const disposalFailure = await disposal!.catch((error: unknown) => error) as RenderHostError;
    expect(initializationFailure).toBe(disposalFailure);
    expect(initializationFailure).toBe(host.error);
    expect((initializationFailure.cause as AggregateError).errors).toEqual([
      deviceLoss,
      expect.objectContaining({ message: "feature dispose failed" }),
    ]);
    expect(log.filter((entry) => entry === "feature.dispose")).toHaveLength(1);
  });

  it("retains an early loop-stop failure in the shared terminal error and publishes it once", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    const deviceLoss = new Error("lost after stop request");
    let disposal: Promise<void> | null = null;
    let injected = false;
    host.subscribe(() => {
      if (host.state !== "ready" || injected) return;
      injected = true;
      deps.frameLoop.stopFailuresRemaining = 1;
      disposal = host.dispose();
      deps.backend.emit("device-lost", deviceLoss);
    });

    const initializationFailure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    const disposalFailure = await disposal!.catch((error: unknown) => error) as RenderHostError;
    expect(initializationFailure).toBe(disposalFailure);
    expect(initializationFailure).toBe(host.error);
    expect((initializationFailure.cause as AggregateError).errors).toEqual([
      deviceLoss,
      expect.objectContaining({ message: "loop stop failed" }),
    ]);
    expect(host.getSnapshot().events.filter((event) => event.kind === "disposal-error"))
      .toHaveLength(1);
    expect(deps.frameLoop).toMatchObject({ running: false, stops: 2 });
  });

  it("does not initialize a backend that emits a terminal event while subscribing", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.backend.subscribeEvents = (listener) => {
      log.push("backend.subscribe");
      deps.backend.listeners.add(listener);
      listener({ kind: "device-lost", error: new Error("early loss"), occurredAtMs: 1 });
      return () => {
        log.push("backend.unsubscribe");
        deps.backend.listeners.delete(listener);
      };
    };
    const host = new RenderHost(deps);

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "BACKEND_RUNTIME_FAILED",
    });
    expect(log).not.toContain("backend.initialize");
    expect(log).toContain("backend.unsubscribe");
    expect(log.filter((entry) => entry === "backend.dispose")).toHaveLength(1);
    expect(host.state).toBe("failed");
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
      "partial-feature.dispose",
      "ready-feature.dispose",
      "materials.dispose",
      "uploads.dispose",
      "resources.dispose",
      "backend.unsubscribe",
      "backend.dispose",
    ]);
    expect(deps.backend.listeners.size).toBe(0);
    expect(deps.frameLoop.starts).toBe(0);
    expect(deps.frameLoop.stops).toBe(1);

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "INVALID_LIFECYCLE",
      lifecycle: "failed",
    });
  });

  it("publishes a pending failure latch before synchronous failed-state disposal", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("partial-feature", log, { failInitialize: true })]);
    const host = new RenderHost(deps);
    let reentrantDispose: Promise<void> | null = null;
    host.subscribe(() => {
      if (host.state === "failed" && reentrantDispose === null) reentrantDispose = host.dispose();
    });

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "INITIALIZATION_FAILED",
    });
    expect(reentrantDispose).not.toBeNull();
    await expect(reentrantDispose).resolves.toBeUndefined();
    expect(deps.backend.disposed).toBe(true);
    expect(host.state).toBe("failed");
  });

  it("preserves initialization and cleanup failures and replays them through dispose", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [
      fakeFeature("ready-feature", log, { failDispose: true }),
      fakeFeature("partial-feature", log, { failInitialize: true }),
    ]);
    deps.backend.disposeError = new Error("backend dispose failed");
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toMatchObject({ code: "INITIALIZATION_FAILED" });
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual([
        "partial-feature init failed",
        "ready-feature dispose failed",
        "backend dispose failed",
      ]);
    await expect(host.dispose()).rejects.toBe(failure);
    expect(host.state).toBe("failed");
    expect(log.filter((entry) => entry === "backend.dispose")).toHaveLength(1);
  });

  it("lets a host subscriber join the failure latch when backend subscription emits inline", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const subscribe = deps.backend.subscribeEvents.bind(deps.backend);
    deps.backend.subscribeEvents = (listener) => {
      const unsubscribe = subscribe(listener);
      listener({
        kind: "device-lost",
        error: new Error("inline subscription loss"),
        occurredAtMs: 1,
      });
      return unsubscribe;
    };
    const host = new RenderHost(deps);
    let reentrantDispose: Promise<void> | null = null;
    host.subscribe(() => {
      if (host.state === "failed" && reentrantDispose === null) {
        reentrantDispose = host.dispose();
      }
    });

    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "BACKEND_RUNTIME_FAILED",
    });
    expect(reentrantDispose).not.toBeNull();
    await expect(reentrantDispose).resolves.toBeUndefined();
    expect(reentrantDispose).toBe(host.dispose());
    expect(host.state).toBe("failed");
    expect(deps.backend.listeners.size).toBe(0);
  });

  it("composes a real adapter failure without counting its cleanup error twice", async () => {
    const log: string[] = [];
    const base = dependencies(log, [fakeFeature("feature", log)]);
    const initializationError = new Error("adapter init failed");
    const cleanupError = new Error("adapter cleanup failed");
    const renderer: ThreeRendererPort = {
      backend: { isWebGLBackend: true, compatibilityMode: false, dispose: () => undefined },
      info: { memory: { geometries: 1, textures: 1, renderTargets: 0, programs: 1 } },
      onError: () => undefined,
      onDeviceLost: () => undefined,
      init: async () => { throw initializationError; },
      setPixelRatio: () => undefined,
      setSize: () => undefined,
      compileAsync: async () => undefined,
      render: () => undefined,
      dispose: () => { throw cleanupError; },
    };
    const backend = new ThreeRenderBackendAdapter({
      request: "forced-webgl2",
      lab: true,
      diagnosticsEnabled: true,
      threeRevision: "185",
      webgpuApiExposed: true,
      webgl2ApiAvailable: true,
      navigatorProbe: {
        source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)",
        attempted: false,
        available: false,
        vendor: null,
        architecture: null,
        device: null,
        description: null,
        error: null,
      },
      createRenderer: () => renderer,
    });
    const host = new RenderHost({ ...base, backend });

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([
      initializationError,
      cleanupError,
    ]);
    await expect(host.dispose()).resolves.toBeUndefined();
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      disposeCalls: 1,
      rendererDisposeInvoked: true,
    });
  });

  it("publishes an out-of-band adapter clock failure into Host terminal evidence", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const drawable = {
      isMesh: true,
      visible: true,
      frustumCulled: true,
      layers: { mask: 1 },
      material: { visible: true },
      geometry: { groups: [] },
      children: [],
    };
    const targetScene = { isScene: true, children: [drawable] };
    const camera = { layers: { mask: 1 } };
    feature.render = (recorder: RenderPassRecorder) => {
      log.push("feature.render");
      recorder.draw("feature-pass", targetScene, camera);
    };
    const base = dependencies(log, [feature]);
    base.materials.warmupPasses = () => [];
    const backendDispose = vi.fn();
    const renderer: ThreeRendererPort = {
      backend: { isWebGLBackend: true, compatibilityMode: false, dispose: backendDispose },
      info: {
        memory: {
          attributes: 4,
          geometries: 2,
          indexAttributes: 2,
          indirectStorageAttributes: 0,
          programs: 2,
          readbackBuffers: 0,
          renderTargets: 1,
          storageAttributes: 0,
          textures: 1,
          total: 4_096,
          uniformBuffers: 2,
        },
      },
      onError: () => undefined,
      onDeviceLost: () => undefined,
      init: async () => undefined,
      setPixelRatio: () => undefined,
      setSize: () => undefined,
      compileAsync: async () => undefined,
      render: () => undefined,
      dispose() {
        this.info = {
          memory: {
            attributes: 0,
            geometries: 0,
            indexAttributes: 0,
            indirectStorageAttributes: 0,
            programs: 0,
            readbackBuffers: 0,
            renderTargets: 0,
            storageAttributes: 0,
            textures: 0,
            total: 0,
            uniformBuffers: 0,
          },
        };
        this.backend?.dispose?.();
      },
    };
    const clockFailure = new Error("adapter event clock failed");
    const backend = new ThreeRenderBackendAdapter({
      request: "forced-webgl2",
      lab: true,
      diagnosticsEnabled: true,
      threeRevision: "185",
      webgpuApiExposed: true,
      webgl2ApiAvailable: true,
      navigatorProbe: {
        source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)",
        attempted: false,
        available: false,
        vendor: null,
        architecture: null,
        device: null,
        description: null,
        error: null,
      },
      createRenderer: () => renderer,
      now: () => { throw clockFailure; },
    });
    const host = new RenderHost({ ...base, backend });
    await host.initialize(journeySnapshot(), VIEWPORT);
    const deviceLoss = new Error("out-of-band device loss");

    renderer.onDeviceLost(deviceLoss);
    await host.whenIdle();

    expect(host.error).toMatchObject({ code: "BACKEND_RUNTIME_FAILED" });
    const publishedClockEvidence = host.error?.cause as AggregateError;
    expect(publishedClockEvidence).toBeInstanceOf(AggregateError);
    expect(publishedClockEvidence.errors).toEqual([deviceLoss, clockFailure]);
    expect(backendDispose).toHaveBeenCalledOnce();
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("serializes an initialization-time backend failure before reverse cleanup", async () => {
    const log: string[] = [];
    let releaseFeature!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFeature = resolve;
    });
    const deps = dependencies(log, [fakeFeature("gated-feature", log, { initializeGate: gate })]);
    const host = new RenderHost(deps);
    const initialization = host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error);

    await vi.waitFor(() => expect(log).toContain("gated-feature.initialize"));
    deps.backend.emit("device-lost", new Error("lost during feature init"));
    await Promise.resolve();
    expect(log).not.toContain("gated-feature.dispose");
    expect(deps.backend.disposed).toBe(false);

    releaseFeature();
    const failure = await initialization as RenderHostError;
    expect(failure).toMatchObject({ code: "BACKEND_RUNTIME_FAILED" });
    expect(host.state).toBe("failed");
    expect(log.filter((entry) => entry === "gated-feature.dispose")).toHaveLength(1);
    expect(log.filter((entry) => entry === "backend.dispose")).toHaveLength(1);
  });

  it("serializes quality updates and drains them before disposal", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    let releaseBalanced!: () => void;
    const balancedGate = new Promise<void>((resolve) => {
      releaseBalanced = resolve;
    });
    deps.materials.quality = async (profile) => {
      log.push(`materials.quality.start:${profile.tier}`);
      if (profile.tier === "balanced") await balancedGate;
      log.push(`materials.quality.end:${profile.tier}`);
    };
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    const balanced = host.setQuality({ ...HIGH, tier: "balanced" });
    const low = host.setQuality({ ...HIGH, tier: "low" });
    await vi.waitFor(() => expect(log).toContain("materials.quality.start:balanced"));
    expect(log).not.toContain("materials.quality.start:low");

    const disposal = host.dispose();
    expect(deps.frameLoop.running).toBe(false);
    expect(deps.backend.disposed).toBe(false);
    releaseBalanced();
    await balanced;
    await low;
    await disposal;

    expect(log.indexOf("materials.quality.end:balanced"))
      .toBeLessThan(log.indexOf("materials.quality.start:low"));
    expect(log.indexOf("feature.quality:low")).toBeLessThan(log.indexOf("feature.dispose"));
    expect(host.getSnapshot().counters.pendingControlOperations).toBe(0);
    expect(host.state).toBe("disposed");
  });

  it("rejects queued controls with the first failure instead of running them after failed", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const qualityError = new Error("balanced quality failed");
    deps.materials.quality = async (profile) => {
      log.push(`materials.quality:${profile.tier}`);
      if (profile.tier === "balanced") throw qualityError;
    };
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    const quality = host.setQuality({ ...HIGH, tier: "balanced" })
      .catch((error: unknown) => error);
    const resize = host.resize({ width: 900, height: 600, pixelRatio: 1 })
      .catch((error: unknown) => error);
    const qualityFailure = await quality as RenderHostError;
    const resizeFailure = await resize as RenderHostError;
    await host.whenIdle();

    expect(qualityFailure).toBe(host.error);
    expect(resizeFailure).toBe(host.error);
    expect(host.error).toMatchObject({ code: "FRAME_FAILED", cause: qualityError });
    expect(log).not.toContain("backend.resize:900x600");
    expect(host.getSnapshot().counters.pendingControlOperations).toBe(0);
    expect(host.state).toBe("failed");
  });

  it("returns the final cleanup-wrapped identity to the failing control caller", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log, { failDispose: true })]);
    const qualityError = new Error("quality operation failed");
    deps.materials.quality = async (profile) => {
      log.push(`materials.quality:${profile.tier}`);
      if (profile.tier === "balanced") throw qualityError;
    };
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    const callerFailure = await host.setQuality({ ...HIGH, tier: "balanced" })
      .catch((error: unknown) => error) as RenderHostError;
    expect(callerFailure).toBe(host.error);
    expect(callerFailure.cause).toBeInstanceOf(AggregateError);
    expect((callerFailure.cause as AggregateError).errors).toEqual([
      qualityError,
      expect.objectContaining({ message: "feature dispose failed" }),
    ]);
    await expect(host.dispose()).rejects.toBe(callerFailure);
  });

  it("does not apply quality after a profile accessor emits a terminal backend event", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const profile = { ...HIGH } as RenderQualityProfile;
    Object.defineProperty(profile, "tier", {
      configurable: true,
      get() {
        deps.backend.emit("device-lost", new Error("lost in tier getter"));
        return "balanced";
      },
    });

    const failure = await host.setQuality(profile).catch((error: unknown) => error);
    expect(failure).toBe(host.error);
    expect(log).not.toContain("materials.quality:balanced");
    expect(log).not.toContain("feature.quality:balanced");
    expect(host.state).toBe("failed");
  });

  it("does not resize the backend after a viewport accessor emits a terminal event", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const viewport = { height: 600, pixelRatio: 1 } as RenderViewport;
    Object.defineProperty(viewport, "width", {
      configurable: true,
      get() {
        deps.backend.emit("device-lost", new Error("lost in width getter"));
        return 900;
      },
    });

    const failure = await host.resize(viewport).catch((error: unknown) => error);
    expect(failure).toBe(host.error);
    expect(log).not.toContain("backend.resize:900x600");
    expect(host.state).toBe("failed");
  });

  it("captures viewport accessors once and validates the captured values", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    let widthReads = 0;
    const viewport = { height: 600, pixelRatio: 1 } as RenderViewport;
    Object.defineProperty(viewport, "width", {
      configurable: true,
      get() {
        widthReads += 1;
        return widthReads === 1 ? 900 : Number.NaN;
      },
    });

    await host.resize(viewport);
    expect(widthReads).toBe(1);
    expect(log).toContain("backend.resize:900x600");
    await host.dispose();
  });

  it("waits for a frame before resize and drains resize before backend disposal", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    let releaseRender!: () => void;
    let releaseResize!: () => void;
    deps.backend.renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    deps.backend.resizeGate = new Promise<void>((resolve) => {
      releaseResize = resolve;
    });
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    deps.frameLoop.tick(20);
    await vi.waitFor(() => expect(log).toContain("backend.render:feature-pass"));

    const resize = host.resize({ width: 900, height: 600, pixelRatio: 1 });
    const disposal = host.dispose();
    expect(log).not.toContain("backend.resize:900x600");
    releaseRender();
    await vi.waitFor(() => expect(log).toContain("backend.resize:900x600"));
    expect(deps.backend.disposed).toBe(false);
    releaseResize();
    await resize;
    await disposal;

    expect(log.indexOf("backend.resize:900x600")).toBeLessThan(log.indexOf("backend.dispose"));
    expect(host.state).toBe("disposed");
  });

  it("publishes resize control ownership before viewport accessors can request disposal", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    let disposal: Promise<void> | null = null;
    const viewport = { height: 600, pixelRatio: 1 } as RenderViewport;
    Object.defineProperty(viewport, "width", {
      configurable: true,
      get() {
        disposal ??= host.dispose();
        return 900;
      },
    });

    await host.resize(viewport);
    await disposal;
    expect(log.indexOf("backend.resize:900x600")).toBeLessThan(log.indexOf("feature.dispose"));
    expect(host.state).toBe("disposed");
    expect(deps.backend.disposed).toBe(true);
  });

  it("retries a failed loop stop before reporting disposal failure", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    deps.frameLoop.stopFailuresRemaining = 1;

    await expect(host.dispose()).rejects.toMatchObject({ code: "DISPOSAL_FAILED" });
    expect(host.state).toBe("failed");
    expect(deps.frameLoop).toMatchObject({ running: false, stops: 2 });
    expect(deps.backend.disposed).toBe(true);
  });

  it("fails honestly when loop stop returns without stopping the loop", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    deps.frameLoop.silentStopFailuresRemaining = 3;

    await expect(host.dispose()).rejects.toMatchObject({ code: "DISPOSAL_FAILED" });
    expect(host.state).toBe("failed");
    expect(host.getSnapshot().loopRunning).toBe(true);
    expect(deps.frameLoop.stops).toBe(3);
    expect(deps.backend.disposed).toBe(true);
  });

  it("fails disposal when the upload queue silently retains pending work", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.uploads.pendingCount = () => 3;
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    const failure = await host.dispose().catch((error: unknown) => error) as RenderHostError;
    expect(failure).toMatchObject({ code: "DISPOSAL_FAILED" });
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining("retained 3 pending item(s)") }),
    ]);
    expect(host.state).toBe("failed");
    expect(host.getSnapshot().resources.pendingUploads).toBe(3);
    expect(deps.backend.disposed).toBe(true);
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
    expect(probe.counters.probeSubscribers).toBe(0);
    expect(deps.backend.listeners.size).toBe(0);
    expect(deps.backend.disposed).toBe(true);
    expect(subscriber).toHaveBeenCalled();

    const disposalCount = log.filter((entry) => entry.endsWith(".dispose")).length;
    await host.dispose();
    expect(log.filter((entry) => entry.endsWith(".dispose"))).toHaveLength(disposalCount);
    unsubscribe();
  });

  it("stops a frame immediately when upload work emits a terminal backend event", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const warmupRenders = log.filter((entry) => entry === "feature.render").length;
    deps.uploads.flush = () => {
      log.push("uploads.flush:fault");
      deps.backend.emit("device-lost", new Error("lost during uploads"));
    };

    deps.frameLoop.tick(20);
    await host.whenIdle();

    expect(host.state).toBe("failed");
    expect(log.filter((entry) => entry === "feature.render")).toHaveLength(warmupRenders);
    expect(log).not.toContain("feature.update:0");
    expect(log.some((entry) => entry.startsWith("backend.render:"))).toBe(false);
    expect(host.getSnapshot().counters.submittedFrames).toBe(0);
    expect(deps.backend.disposed).toBe(true);
  });

  it("latches the first backend fault before diagnostic callbacks can emit another", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    const first = new Error("first device loss");
    const nested = new Error("nested renderer error");
    let emittedNested = false;
    deps.observed.mockImplementation((event) => {
      if (event.kind !== "backend-event" || emittedNested) return;
      emittedNested = true;
      deps.backend.emit("renderer-error", nested);
    });
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", first);
    await host.whenIdle();

    expect(emittedNested).toBe(true);
    expect(host.error).toMatchObject({ code: "BACKEND_RUNTIME_FAILED" });
    expect(host.error?.cause).toBe(first);
    expect(host.getSnapshot().counters).toMatchObject({ backendEvents: 2, failures: 1 });
  });

  it("does not retain probe subscribers added after a terminal failure", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    deps.backend.emit("device-lost", new Error("terminal"));
    await host.whenIdle();

    const unsubscribe = host.subscribe(() => undefined);
    expect(host.getSnapshot().counters.probeSubscribers).toBe(0);
    unsubscribe();
    expect(host.getSnapshot().counters.probeSubscribers).toBe(0);
  });

  it("keeps runtime failure and cleanup failure jointly observable", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log, { failDispose: true })]);
    deps.backend.disposeError = new Error("backend cleanup failed");
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", new Error("runtime device lost"));
    await host.whenIdle();

    expect(host.state).toBe("failed");
    expect(host.error).toMatchObject({ code: "BACKEND_RUNTIME_FAILED" });
    expect(host.error?.cause).toBeInstanceOf(AggregateError);
    expect((host.error?.cause as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual(["runtime device lost", "feature dispose failed", "backend cleanup failed"]);
    expect(host.getSnapshot().events.map((event) => event.kind)).toContain("disposal-error");
    await expect(host.dispose()).rejects.toBe(host.error);
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

  it("preserves a distinct in-flight render rejection after a backend terminal event", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    let rejectRender!: (error: unknown) => void;
    deps.backend.renderGate = new Promise<void>((_resolve, reject) => {
      rejectRender = reject;
    });
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    deps.frameLoop.tick(20);
    await vi.waitFor(() => expect(log).toContain("backend.render:feature-pass"));
    const loss = new Error("device lost during render");
    const renderError = new Error("render promise rejected after loss");

    deps.backend.emit("device-lost", loss);
    const published = host.error!;
    rejectRender(renderError);
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBeInstanceOf(AggregateError);
    expect((published.cause as AggregateError).errors).toEqual([loss, renderError]);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("preserves an empty AggregateError from a distinct in-flight operation", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    let rejectRender!: (error: unknown) => void;
    deps.backend.renderGate = new Promise<void>((_resolve, reject) => {
      rejectRender = reject;
    });
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    deps.frameLoop.tick(20);
    await vi.waitFor(() => expect(log).toContain("backend.render:feature-pass"));
    const loss = new Error("device lost before empty aggregate");
    const emptyAggregate = new AggregateError([], "separate empty aggregate");

    deps.backend.emit("device-lost", loss);
    rejectRender(emptyAggregate);
    await host.whenIdle();

    expect(host.error?.cause).toBeInstanceOf(AggregateError);
    const causes = (host.error?.cause as AggregateError).errors;
    expect(causes).toHaveLength(2);
    expect(causes[0]).toBe(loss);
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect(causes[1]).not.toBe(emptyAggregate);
    expect((causes[1] as AggregateError).message).toBe("separate empty aggregate");
    expect((causes[1] as AggregateError).errors).toEqual([]);
    await expect(host.dispose()).rejects.toBe(host.error);
  });

  it("stops the loop immediately and keeps a late frame rejection terminal during disposal", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    let rejectRender!: (error: unknown) => void;
    deps.backend.renderGate = new Promise<void>((_resolve, reject) => {
      rejectRender = reject;
    });
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    deps.frameLoop.tick(20);
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toContain("backend.render:feature-pass");

    const disposal = host.dispose().catch((error: unknown) => error);
    expect(deps.frameLoop.running).toBe(false);
    const callbacksAtStop = host.getSnapshot().counters.frameCallbacks;
    deps.frameLoop.tick(21);
    expect(host.getSnapshot().counters.frameCallbacks).toBe(callbacksAtStop);

    rejectRender(new Error("late frame rejected"));
    const failure = await disposal as RenderHostError;
    expect(failure).toMatchObject({ code: "FRAME_FAILED" });
    expect(host.state).toBe("failed");
    expect(deps.backend.disposed).toBe(true);
    expect(deps.frameLoop.stops).toBe(1);
    await expect(host.dispose()).rejects.toBe(failure);
  });

  it("revokes a frame callback retained by an otherwise stopped loop", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    await host.dispose();
    const counters = host.getSnapshot().counters;

    deps.frameLoop.tickRetained(99);

    expect(host.getSnapshot().counters).toEqual(counters);
    expect(host.state).toBe("disposed");
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

  it("does not start queued frame work after a backend fault wins the race", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const flushCallsBefore = log.filter((entry) => entry.startsWith("uploads.flush:")).length;

    deps.frameLoop.tick(33);
    deps.backend.emit("device-lost", new Error("lost before queued frame starts"));
    await host.whenIdle();

    expect(log.filter((entry) => entry.startsWith("uploads.flush:"))).toHaveLength(flushCallsBefore);
    expect(host.getSnapshot().counters.submittedFrames).toBe(0);
    expect(host.state).toBe("failed");
  });

  it("keeps backend events attached until an in-flight resize drains during disposal", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    let releaseResize!: () => void;
    deps.backend.resizeGate = new Promise<void>((resolve) => {
      releaseResize = resolve;
    });
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const resize = host.resize({ width: 900, height: 500, pixelRatio: 1 })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(log).toContain("backend.resize:900x500"));

    const disposal = host.dispose().catch((error: unknown) => error);
    deps.backend.emit("device-lost", new Error("lost during resize drain"));
    releaseResize();
    const resizeFailure = await resize;
    const disposalFailure = await disposal;

    expect(resizeFailure).toBe(host.error);
    expect(disposalFailure).toBe(host.error);
    expect(host.error).toMatchObject({ code: "BACKEND_RUNTIME_FAILED" });
    expect(host.getSnapshot().counters.backendEvents).toBe(1);
    expect(deps.backend.disposed).toBe(true);
  });

  it("captures quality and viewport inputs at public call time", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const profile: {
      tier: RenderQualityProfile["tier"];
      pixelRatio: number;
      uploadBudgetMs: number;
      features: RenderQualityProfile["features"];
    } = { ...HIGH, tier: "balanced" };
    const viewport: { width: number; height: number; pixelRatio: number } = {
      width: 900,
      height: 500,
      pixelRatio: 1,
    };

    const quality = host.setQuality(profile);
    profile.tier = "low";
    const resize = host.resize(viewport);
    viewport.width = 320;
    await Promise.all([quality, resize]);

    expect(log).toContain("materials.quality:balanced");
    expect(log).not.toContain("materials.quality:low");
    expect(log).toContain("backend.resize:900x500");
    expect(log).not.toContain("backend.resize:320x500");
    await host.dispose();
  });

  it("keeps the newest nested quality emission during initialization and at runtime", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const low: RenderQualityProfile = { ...HIGH, tier: "low" };
    const nestedDuringInit = { ...HIGH, tier: "balanced" } as RenderQualityProfile;
    Object.defineProperty(nestedDuringInit, "tier", {
      configurable: true,
      get() {
        deps.qualityProvider.emit(low);
        return "balanced";
      },
    });
    deps.qualityProvider.emitOnSubscribe = nestedDuringInit;
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    expect(host.getSnapshot().qualityTier).toBe("low");

    const high: RenderQualityProfile = { ...HIGH, tier: "high" };
    const nestedAtRuntime = { ...HIGH, tier: "balanced" } as RenderQualityProfile;
    Object.defineProperty(nestedAtRuntime, "tier", {
      configurable: true,
      get() {
        deps.qualityProvider.emit(high);
        return "balanced";
      },
    });
    deps.qualityProvider.emit(nestedAtRuntime);
    await host.whenIdle();
    expect(host.getSnapshot().qualityTier).toBe("high");
    expect(log.at(-1)).not.toBe("feature.quality:balanced");
    await host.dispose();
  });

  it("does not let an older deferred provider profile overwrite a later direct control", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.qualityProvider.emit({ ...HIGH, tier: "low" });
    await host.setQuality({ ...HIGH, tier: "balanced" });
    await host.whenIdle();

    expect(host.getSnapshot().qualityTier).toBe("balanced");
    expect(log.filter((entry) => entry === "materials.quality:low")).toHaveLength(1);
    expect(log.indexOf("materials.quality:low"))
      .toBeLessThan(log.lastIndexOf("materials.quality:balanced"));
    expect(log.at(-1)).not.toBe("feature.quality:low");
    await host.dispose();
  });

  it("reserves a provider quality slot before a later resize control", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.qualityProvider.emit({ ...HIGH, tier: "low" });
    await host.resize({ width: 910, height: 510, pixelRatio: 1 });
    await host.whenIdle();

    expect(log.indexOf("materials.quality:low"))
      .toBeLessThan(log.indexOf("backend.resize:910x510"));
    expect(host.getSnapshot().qualityTier).toBe("low");
    await host.dispose();
  });

  it("resamples quality after subscribing so pre-subscription changes are not lost", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const low: RenderQualityProfile = { ...HIGH, tier: "low" };
    let releaseInitialQuality!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseInitialQuality = resolve;
    });
    let firstQuality = true;
    deps.materials.quality = async (profile) => {
      log.push(`materials.quality:${profile.tier}`);
      if (firstQuality) {
        firstQuality = false;
        await gate;
      }
    };
    const host = new RenderHost(deps);
    const initialization = host.initialize(journeySnapshot(), VIEWPORT);
    void initialization.catch(() => undefined);
    await vi.waitFor(() => expect(log).toContain("materials.quality:high"));

    deps.qualityProvider.emit(low);
    releaseInitialQuality();
    await initialization;

    expect(host.getSnapshot().qualityTier).toBe("low");
    expect(log).toContain("materials.quality:low");
    await host.dispose();
  });

  it("reuses the active initialize promise while failure cleanup is still pending", async () => {
    const log: string[] = [];
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const feature = fakeFeature("partial", log, { failInitialize: true });
    feature.dispose = async () => {
      log.push("partial.dispose");
      await disposeGate;
    };
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    const first = host.initialize(journeySnapshot(), VIEWPORT);
    void first.catch(() => undefined);
    await vi.waitFor(() => expect(log).toContain("partial.dispose"));
    expect(host.state).toBe("failed");

    const concurrent = host.initialize(journeySnapshot(), VIEWPORT);
    expect(concurrent).toBe(first);
    releaseDispose();
    await expect(first).rejects.toMatchObject({ code: "INITIALIZATION_FAILED" });
    await expect(host.initialize(journeySnapshot(), VIEWPORT)).rejects.toMatchObject({
      code: "INVALID_LIFECYCLE",
    });
  });

  it("keeps the published terminal error object stable when cleanup adds failures", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log, { failDispose: true })]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", new Error("primary loss"));
    const published = host.error;
    expect(published).toMatchObject({ code: "BACKEND_RUNTIME_FAILED" });
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published?.cause).toBeInstanceOf(AggregateError);
    expect((published?.cause as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual(["primary loss", "feature dispose failed"]);
  });

  it("requires the owning Host capability before cleanup evidence can be attached", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("owner-scoped terminal loss");
    deps.backend.emit("device-lost", loss);
    const published = host.error!;
    await host.whenIdle();
    const originalCause = published.cause;

    attachRenderHostCleanupFailures(published, [published], {});
    const unscopedAttach = attachRenderHostCleanupFailures as unknown as (
      error: RenderHostError,
      failures: readonly unknown[],
    ) => RenderHostError;
    unscopedAttach(published, [published]);
    replaceRenderHostErrorCause(published, new Error("foreign replacement"), {});
    const unscopedReplace = replaceRenderHostErrorCause as unknown as (
      error: RenderHostError,
      cause: unknown,
    ) => RenderHostError;
    unscopedReplace(published, new Error("unscoped replacement"));

    expect(published.cause).toBe(originalCause);
    expect(published.cause).toBe(loss);
  });

  it("does not attach the published terminal error to its own cause graph", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    feature.dispose = () => {
      log.push("feature.dispose");
      throw host.error;
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss without recursive cleanup");

    deps.backend.emit("device-lost", loss);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBe(loss);
    expect(published.cause).not.toBe(published);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("removes indirect terminal references while retaining sibling cleanup failures", async () => {
    const log: string[] = [];
    const cleanup = new Error("real sibling cleanup failure");
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    feature.dispose = () => {
      log.push("feature.dispose");
      throw new AggregateError([host.error, cleanup], "wrapped terminal plus cleanup");
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBeInstanceOf(AggregateError);
    const causes = (published.cause as AggregateError).errors;
    expect(causes[0]).toBe(loss);
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect((causes[1] as AggregateError).message).toBe("wrapped terminal plus cleanup");
    expect((causes[1] as AggregateError).errors).toEqual([cleanup]);
    expect(causes).not.toContain(published);
    expect((causes[1] as AggregateError).errors).not.toContain(published);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("does not reattach an aggregate containing the terminal error when a sibling is opaque", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    const prototypeTrap = new Error("opaque cleanup prototype trap");
    const opaqueCleanup = new Proxy({}, {
      getPrototypeOf() { throw prototypeTrap; },
    });
    feature.dispose = () => {
      log.push("feature.dispose");
      throw new AggregateError(
        [host.error, opaqueCleanup],
        "terminal plus opaque cleanup",
      );
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBeInstanceOf(AggregateError);
    const causes = (published.cause as AggregateError).errors;
    expect(causes).toHaveLength(3);
    expect(causes[0]).toBe(loss);
    expect(causes[1]).toBeInstanceOf(Error);
    expect(causes[1] === opaqueCleanup).toBe(false);
    expect((causes[1] as Error).message).toContain("hostile inspection");
    expect(causes[2]).toBeInstanceOf(AggregateError);
    expect((causes[2] as AggregateError).message).toBe("terminal plus opaque cleanup");
    expect((causes[2] as AggregateError).errors).toEqual([]);
    expect(causes).not.toContain(published);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("walks aggregate entries defensively when array helper access is hostile", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    const cleanup = new Error("cleanup beside terminal reference");
    feature.dispose = () => {
      log.push("feature.dispose");
      const wrapped = new AggregateError([], "proxied aggregate entries");
      const entries = new Proxy([host.error, cleanup], {
        get(target, property, receiver) {
          if (property === "slice") throw new Error("slice access denied");
          return Reflect.get(target, property, receiver);
        },
      });
      Object.defineProperty(wrapped, "errors", { value: entries });
      throw wrapped;
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBeInstanceOf(AggregateError);
    const causes = (published.cause as AggregateError).errors;
    expect(causes[0]).toBe(loss);
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect((causes[1] as AggregateError).message).toBe("proxied aggregate entries");
    expect((causes[1] as AggregateError).errors).toEqual([cleanup]);
    expect((causes[1] as AggregateError).errors).not.toContain(published);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("rejects hostile aggregate lengths without inventing missing failures or looping", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    const cleanup = new Error("real cleanup entry");
    feature.dispose = () => {
      log.push("feature.dispose");
      const wrapped = new AggregateError([], "overreported aggregate entries");
      const entries = new Proxy([host.error, cleanup], {
        get(target, property, receiver) {
          if (property === "length") return 3;
          return Reflect.get(target, property, receiver);
        },
      });
      Object.defineProperty(wrapped, "errors", { value: entries });
      throw wrapped;
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBeInstanceOf(AggregateError);
    const causes = (published.cause as AggregateError).errors;
    expect(causes[0]).toBe(loss);
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect((causes[1] as AggregateError).message).toBe("overreported aggregate entries");
    expect((causes[1] as AggregateError).errors).toEqual([cleanup]);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("bounds non-finite aggregate lengths during terminal cleanup", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    feature.dispose = () => {
      log.push("feature.dispose");
      const wrapped = new AggregateError([], "unbounded aggregate entries");
      const entries = new Proxy([] as unknown[], {
        get(target, property, receiver) {
          if (property === "length") return Number.POSITIVE_INFINITY;
          return Reflect.get(target, property, receiver);
        },
      });
      Object.defineProperty(wrapped, "errors", { value: entries });
      throw wrapped;
    };
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", new Error("primary loss"));
    await host.whenIdle();

    const causes = (host.error!.cause as AggregateError).errors;
    expect(causes).toHaveLength(2);
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect((causes[1] as AggregateError).message).toBe("unbounded aggregate entries");
    expect((causes[1] as AggregateError).errors[0]).toBeInstanceOf(RangeError);
    await expect(host.dispose()).rejects.toBe(host.error);
  });

  it("bounds deeply nested cause traversal and retains non-empty cleanup evidence", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    let deepFailure: Error = new Error("deep cleanup leaf");
    for (let index = 0; index < 20_000; index += 1) {
      deepFailure = new Error(`deep cleanup layer ${index}`, { cause: deepFailure });
    }
    feature.dispose = () => {
      log.push("feature.dispose");
      throw deepFailure;
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBeInstanceOf(AggregateError);
    const causes = (published.cause as AggregateError).errors;
    expect(causes[0]).toBe(loss);
    expect(causes[1]).toBeInstanceOf(RangeError);
    expect((causes[1] as Error).message).toContain("safe-snapshot depth 256");
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("never reattaches an aggregate that hides terminal entries behind a false zero length", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    let sourceAggregate: AggregateError | null = null;
    feature.dispose = () => {
      log.push("feature.dispose");
      const wrapped = new AggregateError([], "hidden terminal entry");
      sourceAggregate = wrapped;
      const entries = new Proxy([host.error], {
        get(target, property, receiver) {
          if (property === "length") return 0;
          return Reflect.get(target, property, receiver);
        },
      });
      Object.defineProperty(wrapped, "errors", { value: entries });
      throw wrapped;
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    const published = host.error!;
    await host.whenIdle();

    const causes = (published.cause as AggregateError).errors;
    expect(causes).toHaveLength(2);
    expect(causes[0]).toBe(loss);
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect(causes[1]).not.toBe(sourceAggregate);
    expect((causes[1] as AggregateError).errors).toEqual([]);
    expect((causes[1] as AggregateError).message).toBe("hidden terminal entry");
    expect(causes).not.toContain(published);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("does not restore an outer Error after sanitizing its hidden aggregate cause", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    let outerFailure: Error | null = null;
    feature.dispose = () => {
      log.push("feature.dispose");
      const hiddenAggregate = new AggregateError([], "hidden terminal aggregate");
      const entries = new Proxy([host.error], {
        get(target, property, receiver) {
          if (property === "length") return 0;
          return Reflect.get(target, property, receiver);
        },
      });
      Object.defineProperty(hiddenAggregate, "errors", { value: entries });
      outerFailure = new Error("outer cleanup wrapper", { cause: hiddenAggregate });
      throw outerFailure;
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    const published = host.error!;
    await host.whenIdle();

    const causes = (published.cause as AggregateError).errors;
    expect(causes[0]).toBe(loss);
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect(causes[1]).not.toBe(outerFailure);
    expect((causes[1] as AggregateError).errors).toEqual([]);
    expect(causes).not.toContain(published);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("classifies a nested aggregate once before stripping its terminal reference", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    let classificationCalls = 0;
    feature.dispose = () => {
      log.push("feature.dispose");
      const aggregate = new AggregateError([host.error], "one-shot aggregate prototype");
      const oneShotAggregate = new Proxy(aggregate, {
        getPrototypeOf(target) {
          classificationCalls += 1;
          if (classificationCalls > 1) throw new Error("aggregate prototype read twice");
          return Reflect.getPrototypeOf(target);
        },
      });
      throw new Error("outer cleanup wrapper", { cause: oneShotAggregate });
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    await host.whenIdle();

    expect(classificationCalls).toBe(1);
    expect(host.error?.cause).toBe(loss);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("keeps Host-owned cleanup evidence immutable during probe publication", async () => {
    const log: string[] = [];
    const cleanup = new Error("immutable cleanup evidence");
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    feature.dispose = () => {
      log.push("feature.dispose");
      throw cleanup;
    };
    let mutationBlocked = false;
    host.subscribe(() => {
      const cause = host.error?.cause;
      if (!(cause instanceof AggregateError)) return;
      try {
        cause.errors.length = 0;
      } catch {
        mutationBlocked = true;
      }
    });
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    const published = host.error!;
    await host.whenIdle();

    expect(mutationBlocked).toBe(true);
    expect(Object.isFrozen(published.cause)).toBe(true);
    expect(Object.isFrozen((published.cause as AggregateError).errors)).toBe(true);
    expect((published.cause as AggregateError).errors).toEqual([loss, cleanup]);
    await expect(host.dispose()).rejects.toBe(published);
  });

  it("drops a cleanup wrapper whose only cause is the terminal error", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    feature.dispose = () => {
      log.push("feature.dispose");
      throw new Error("terminal wrapper", { cause: host.error });
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    await host.whenIdle();

    expect(host.error?.cause).toBe(loss);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("strips an inherited cleanup cause that references the terminal error", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    class InheritedCauseError extends Error {}
    Object.defineProperty(InheritedCauseError.prototype, "cause", {
      configurable: true,
      get: () => host.error,
    });
    feature.dispose = () => {
      log.push("feature.dispose");
      throw new InheritedCauseError("inherited terminal wrapper");
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    await host.whenIdle();

    expect(host.error?.cause).toBe(loss);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("strips a cross-realm Error cause that references the terminal error", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    const foreignError = runInNewContext("new Error('foreign terminal wrapper')") as Error;
    Object.defineProperty(foreignError, "cause", {
      configurable: true,
      value: host.error,
      writable: true,
    });
    feature.dispose = () => {
      log.push("feature.dispose");
      Object.defineProperty(foreignError, "cause", { value: host.error });
      throw foreignError;
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    await host.whenIdle();

    expect(host.error?.cause).toBe(loss);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("sanitizes cross-realm AggregateError entries without losing siblings", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    const cleanup = new Error("foreign aggregate sibling");
    let sourceAggregate: AggregateError | null = null;
    feature.dispose = () => {
      log.push("feature.dispose");
      const foreignAggregate = runInNewContext(
        "new AggregateError([], 'foreign terminal aggregate')",
      ) as AggregateError;
      sourceAggregate = foreignAggregate;
      Object.defineProperty(foreignAggregate, "errors", {
        configurable: true,
        value: [host.error, cleanup],
      });
      throw foreignAggregate;
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    await host.whenIdle();

    const causes = (host.error?.cause as AggregateError).errors;
    expect(causes[0]).toBe(loss);
    expect(causes[1]).toBeInstanceOf(AggregateError);
    const boundary = causes[1] as AggregateError;
    expect(boundary).not.toBe(sourceAggregate);
    expect(boundary.message).toBe("foreign terminal aggregate");
    expect(boundary.errors).toEqual([cleanup]);
    expect(boundary.errors[0]).not.toBe(cleanup);
    expect(Object.isFrozen(boundary)).toBe(true);
    expect(Object.isFrozen(boundary.errors)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(boundary, "cause")).toBe(false);
    await expect(host.dispose()).rejects.toBe(host.error);
  });

  it("strips a terminal cause even when an Error Proxy lies about property presence", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    feature.dispose = () => {
      log.push("feature.dispose");
      const wrapper = new Proxy(new Error("lying terminal wrapper"), {
        has(target, property) {
          if (property === "cause") return false;
          return Reflect.has(target, property);
        },
        get(target, property, receiver) {
          if (property === "cause") return host.error;
          return Reflect.get(target, property, receiver);
        },
      });
      throw wrapper;
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    await host.whenIdle();

    expect(host.error?.cause).toBe(loss);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("preserves repeated non-primary Error occurrences inside one cleanup aggregate", async () => {
    const log: string[] = [];
    const cleanup = new Error("repeated cleanup occurrence");
    const feature = fakeFeature("feature", log);
    const deps = dependencies(log, [feature]);
    const host = new RenderHost(deps);
    feature.dispose = () => {
      log.push("feature.dispose");
      throw new AggregateError([cleanup, cleanup], "two cleanup occurrences");
    };
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("primary loss");

    deps.backend.emit("device-lost", loss);
    await host.whenIdle();

    const causes = (host.error?.cause as AggregateError).errors;
    expect(causes[0]).toBe(loss);
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect((causes[1] as AggregateError).message).toBe("two cleanup occurrences");
    expect((causes[1] as AggregateError).errors).toEqual([cleanup, cleanup]);
    await expect(host.dispose()).rejects.toBe(host.error);
  });

  it("preserves an undefined primary fault without creating a terminal-error cycle", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log, { failDispose: true })]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    deps.backend.emit("device-lost", undefined);
    const published = host.error!;
    await host.whenIdle();

    expect(host.error).toBe(published);
    expect(published.cause).toBeInstanceOf(AggregateError);
    expect((published.cause as AggregateError).errors[0]).toBeUndefined();
    expect((published.cause as AggregateError).errors[1]).toMatchObject({
      message: "feature dispose failed",
    });
    expect((published.cause as AggregateError).errors).not.toContain(published);
  });

  it("rejects probe subscription and recursive snapshots from owned dependency callbacks", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    const ownedErrors: RenderHostError[] = [];
    deps.observed.mockImplementation((event) => {
      if (event.kind !== "lifecycle" || event.to !== "initializing") return;
      try {
        host.subscribe(() => undefined);
      } catch (error: unknown) {
        ownedErrors.push(error as RenderHostError);
      }
      try {
        host.getSnapshot();
      } catch (error: unknown) {
        ownedErrors.push(error as RenderHostError);
      }
    });
    await host.initialize(journeySnapshot(), VIEWPORT);
    expect(ownedErrors).toHaveLength(2);
    expect(ownedErrors.every((error) => error.code === "INVALID_LIFECYCLE")).toBe(true);

    deps.backend.snapshotResources = () => host.getSnapshot().resources;
    expect(() => host.getSnapshot()).toThrow(expect.objectContaining({
      code: "INVALID_LIFECYCLE",
    }));
    expect(host.state).toBe("ready");
    deps.backend.snapshotResources = () => ({
      geometries: 0,
      textures: 0,
      renderTargets: 0,
      programs: 0,
      nodes: 0,
      objects: 0,
      subscribers: 0,
      pendingUploads: 0,
    });
    await host.dispose();
  });

  it("captures backend event fields once under the one-way dependency guard", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const loss = new Error("captured loss");
    const reads = { kind: 0, error: 0, time: 0 };
    let reentrantDispose: Promise<void> | null = null;
    const event = {
      get kind() {
        reads.kind += 1;
        reentrantDispose = host.dispose();
        void reentrantDispose.catch(() => undefined);
        return "device-lost" as const;
      },
      get error() {
        reads.error += 1;
        return loss;
      },
      get occurredAtMs() {
        reads.time += 1;
        return 42;
      },
    };

    for (const listener of deps.backend.listeners) listener(event);
    await expect(reentrantDispose).rejects.toMatchObject({ code: "INVALID_LIFECYCLE" });
    await host.whenIdle();
    expect(reads).toEqual({ kind: 1, error: 1, time: 1 });
    expect(host.error).toMatchObject({ code: "BACKEND_RUNTIME_FAILED", cause: loss });
    expect(deps.backend.disposed).toBe(true);
  });

  it("fails closed and still cleans up when a backend event accessor throws", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);
    const captureError = new Error("backend event getter failed");
    const event = {
      get kind(): BackendRuntimeEvent["kind"] { throw captureError; },
      error: null,
      occurredAtMs: 42,
    };

    for (const listener of deps.backend.listeners) listener(event);
    await host.whenIdle();
    expect(host.error).toMatchObject({
      code: "BACKEND_RUNTIME_FAILED",
      cause: captureError,
    });
    expect(host.getSnapshot().counters.backendEvents).toBe(1);
    expect(deps.backend.disposed).toBe(true);
  });

  it("preserves the first backend fault identity when a real adapter faults during init", async () => {
    const log: string[] = [];
    const base = dependencies(log, [fakeFeature("feature", log)]);
    const loss = new Error("real adapter init loss");
    const renderer: ThreeRendererPort = {
      backend: { isWebGLBackend: true, compatibilityMode: false, dispose: () => undefined },
      info: { memory: { geometries: 1, textures: 1, renderTargets: 0, programs: 1 } },
      onError: () => undefined,
      onDeviceLost: () => undefined,
      async init() { this.onDeviceLost(loss); },
      setPixelRatio: () => undefined,
      setSize: () => undefined,
      compileAsync: async () => undefined,
      render: () => undefined,
      dispose() { this.backend?.dispose?.(); },
    };
    const backend = new ThreeRenderBackendAdapter({
      request: "forced-webgl2",
      lab: true,
      diagnosticsEnabled: true,
      threeRevision: "185",
      webgpuApiExposed: true,
      webgl2ApiAvailable: true,
      navigatorProbe: {
        source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)",
        attempted: false,
        available: false,
        vendor: null,
        architecture: null,
        device: null,
        description: null,
        error: null,
      },
      createRenderer: () => renderer,
    });
    const host = new RenderHost({ ...base, backend });

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure).toMatchObject({ code: "BACKEND_RUNTIME_FAILED", cause: loss });
    expect(host.getSnapshot().counters.backendEvents).toBe(1);
  });

  it("preserves real-adapter cleanup failure after an init-time device loss", async () => {
    const log: string[] = [];
    const base = dependencies(log, [fakeFeature("feature", log)]);
    const loss = new Error("adapter init device loss");
    const cleanup = new Error("adapter init cleanup failed");
    const renderer: ThreeRendererPort = {
      backend: { isWebGLBackend: true, compatibilityMode: false, dispose: () => undefined },
      info: { memory: { geometries: 1, textures: 1, renderTargets: 0, programs: 1 } },
      onError: () => undefined,
      onDeviceLost: () => undefined,
      async init() { this.onDeviceLost(loss); },
      setPixelRatio: () => undefined,
      setSize: () => undefined,
      compileAsync: async () => undefined,
      render: () => undefined,
      dispose() { throw cleanup; },
    };
    const backend = new ThreeRenderBackendAdapter({
      request: "forced-webgl2",
      lab: true,
      diagnosticsEnabled: true,
      threeRevision: "185",
      webgpuApiExposed: true,
      webgl2ApiAvailable: true,
      navigatorProbe: {
        source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)",
        attempted: false,
        available: false,
        vendor: null,
        architecture: null,
        device: null,
        description: null,
        error: null,
      },
      createRenderer: () => renderer,
    });
    const host = new RenderHost({ ...base, backend });

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure).toMatchObject({ code: "BACKEND_RUNTIME_FAILED" });
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const causes = (failure.cause as AggregateError).errors;
    expect(causes[0]).toBe(loss);
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect((causes[1] as AggregateError).message).toBe(
      "Three backend initialization failed and renderer cleanup also failed.",
    );
    expect((causes[1] as AggregateError).errors).toEqual([cleanup]);
    expect(host.getSnapshot().events.map((event) => event.kind)).toContain("disposal-error");
    await expect(host.dispose()).rejects.toBe(failure);
  });

  it("preserves a cleanup throw matching an undefined init-fault sentinel", async () => {
    const log: string[] = [];
    const base = dependencies(log, [fakeFeature("feature", log)]);
    const renderer: ThreeRendererPort = {
      backend: { isWebGLBackend: true, compatibilityMode: false, dispose: () => undefined },
      info: { memory: { geometries: 1, textures: 1, renderTargets: 0, programs: 1 } },
      onError: () => undefined,
      onDeviceLost: () => undefined,
      async init() { this.onDeviceLost(undefined); },
      setPixelRatio: () => undefined,
      setSize: () => undefined,
      compileAsync: async () => undefined,
      render: () => undefined,
      dispose() { throw undefined; },
    };
    const backend = new ThreeRenderBackendAdapter({
      request: "forced-webgl2",
      lab: true,
      diagnosticsEnabled: true,
      threeRevision: "185",
      webgpuApiExposed: true,
      webgl2ApiAvailable: true,
      navigatorProbe: {
        source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)",
        attempted: false,
        available: false,
        vendor: null,
        architecture: null,
        device: null,
        description: null,
        error: null,
      },
      createRenderer: () => renderer,
    });
    const host = new RenderHost({ ...base, backend });

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const causes = (failure.cause as AggregateError).errors;
    expect(causes[0]).toBeUndefined();
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect((causes[1] as AggregateError).errors).toEqual([undefined]);
    await expect(host.dispose()).rejects.toBe(failure);
  });

  it("cannot bypass cleanup with a throwing rejection-cause accessor", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const primary = new Error("init-time device loss");
    const opaqueRejection = new Error("opaque backend rejection");
    Object.defineProperty(opaqueRejection, "cause", {
      configurable: true,
      get() { throw new Error("cause accessor exploded"); },
    });
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      deps.backend.emit("device-lost", primary);
      throw opaqueRejection;
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const causes = (failure.cause as AggregateError).errors;
    expect(causes[0]).toBe(primary);
    expect(causes[1]).toBeInstanceOf(Error);
    expect(causes[1] === opaqueRejection).toBe(false);
    expect((causes[1] as Error).message).toContain("hostile inspection");
    expect(deps.backend.disposed).toBe(true);
    await expect(host.dispose()).rejects.toBe(failure);
  });

  it("does not adopt an external RenderHostError with a poisoned cause accessor", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const externalValue = new RenderHostError(
      "FRAME_FAILED",
      "external error",
      "initializing",
      null,
    );
    const external = new Proxy(externalValue, {
      get(target, property, receiver) {
        if (property === "cause") throw new Error("external cause getter exploded");
        return Reflect.get(target, property, receiver);
      },
    });
    const secondary = new Error("backend rejected after external event");
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      deps.backend.emit("device-lost", external);
      throw secondary;
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure === external).toBe(false);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const causes = (failure.cause as AggregateError).errors;
    expect(causes).toHaveLength(2);
    expect(causes[0] === external).toBe(false);
    expect(causes[0]).toMatchObject({
      message: expect.stringContaining("hostile inspection"),
    });
    expect(causes[1] === secondary).toBe(false);
    expect(causes[1]).toMatchObject({ message: secondary.message });
    expect(Object.isFrozen(causes[1])).toBe(true);
    expect(deps.backend.disposed).toBe(true);
    await expect(host.dispose()).rejects.toBe(failure);
  });

  it("keeps terminal error ownership isolated between two RenderHost instances", async () => {
    const logA: string[] = [];
    const depsA = dependencies(logA, [fakeFeature("feature-a", logA)]);
    const hostA = new RenderHost(depsA);
    await hostA.initialize(journeySnapshot(), VIEWPORT);
    const lossA = new Error("host A device loss");
    depsA.backend.emit("device-lost", lossA);
    await hostA.whenIdle();
    const terminalA = hostA.error!;
    expect(terminalA.cause).toBe(lossA);

    const logB: string[] = [];
    const featureB = fakeFeature("feature-b", logB);
    const depsB = dependencies(logB, [featureB]);
    const cleanupB = new Error("host B cleanup failed");
    featureB.dispose = () => {
      logB.push("feature-b.dispose");
      throw cleanupB;
    };
    depsB.backend.precompile = async () => {
      logB.push("backend.precompile");
      throw terminalA;
    };
    const hostB = new RenderHost(depsB);

    const terminalB = await hostB.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(terminalB).toBe(hostB.error);
    expect(terminalB).not.toBe(terminalA);
    expect(terminalB.cause).toBeInstanceOf(AggregateError);
    expect((terminalB.cause as AggregateError).errors).toEqual([lossA, cleanupB]);
    expect(hostA.error).toBe(terminalA);
    expect(terminalA.cause).toBe(lossA);
    await expect(hostB.dispose()).rejects.toBe(terminalB);
  });

  it("keeps the terminal latch settling when a probe subscriber tries to poison the error", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const primary = new Error("init-time device loss");
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      deps.backend.emit("device-lost", primary);
      throw primary;
    };
    const host = new RenderHost(deps);
    let mutationBlocked = false;
    host.subscribe(() => {
      if (host.state !== "failed" || !host.error) return;
      try {
        Object.defineProperty(host.error, "message", {
          configurable: true,
          get() { throw new Error("poisoned terminal message"); },
        });
      } catch {
        mutationBlocked = true;
      }
    });

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure.message).toBe("Graphics backend reported device-lost.");
    expect(Object.isFrozen(failure)).toBe(true);
    expect("attachCleanupFailures" in failure).toBe(false);
    expect(mutationBlocked).toBe(true);
    expect(deps.backend.disposed).toBe(true);
    expect(host.getSnapshot().counters.probeSubscribers).toBe(0);
    await expect(host.dispose()).resolves.toBeUndefined();
    await host.whenIdle();
  });

  it("treats a prototype-trapping backend rejection as opaque and still cleans up", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const trapError = new Error("getPrototypeOf trap fired");
    const opaque = new Proxy({}, {
      getPrototypeOf() { throw trapError; },
    });
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      throw opaque;
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure).toMatchObject({ code: "INITIALIZATION_FAILED" });
    expect(failure.cause === opaque).toBe(false);
    expect(failure.cause).toMatchObject({
      message: "Failure value type could not be inspected.",
    });
    expect(deps.backend.disposed).toBe(true);
    await expect(host.dispose()).resolves.toBeUndefined();
  });

  it("preserves a repeated primitive secondary occurrence from a generic backend", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      deps.backend.emit("device-lost", undefined);
      throw new AggregateError([undefined, undefined], "primary plus secondary sentinel");
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const causes = (failure.cause as AggregateError).errors;
    expect(causes[0]).toBeUndefined();
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect((causes[1] as AggregateError).message).toBe("primary plus secondary sentinel");
    expect((causes[1] as AggregateError).errors).toEqual([undefined]);
    expect(deps.backend.disposed).toBe(true);
    await expect(host.dispose()).rejects.toBe(failure);
  });

  it("preserves two same-identity secondary occurrences after consuming the primary", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const shared = new Error("shared primary and secondary occurrence");
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      deps.backend.emit("device-lost", shared);
      throw new AggregateError([shared, shared, shared], "three shared occurrences");
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const causes = (failure.cause as AggregateError).errors;
    expect(causes[0]).toBe(shared);
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect((causes[1] as AggregateError).message).toBe("three shared occurrences");
    expect((causes[1] as AggregateError).errors).toEqual([shared, shared]);
    await expect(host.dispose()).rejects.toBe(failure);
  });

  it("does not mistake an absent Error cause for an undefined primary fault", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const secondary = new Error("secondary rejection without cause");
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      deps.backend.emit("device-lost", undefined);
      throw secondary;
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([undefined, secondary]);
    expect(deps.backend.disposed).toBe(true);
    await expect(host.dispose()).rejects.toBe(failure);
  });

  it("retains a safe marker when aggregate inspection throws the primary sentinel", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const opaqueAggregate = new AggregateError([], "opaque aggregate details");
    Object.defineProperty(opaqueAggregate, "errors", {
      configurable: true,
      get() { throw undefined; },
    });
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      deps.backend.emit("device-lost", undefined);
      throw opaqueAggregate;
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(host.error);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const causes = (failure.cause as AggregateError).errors;
    expect(causes[0]).toBeUndefined();
    expect(causes[1]).toBeInstanceOf(Error);
    expect((causes[1] as Error).message).toContain("hostile inspection");
    await expect(host.dispose()).rejects.toBe(failure);
  });

  it("preserves a repeated Error identity when one occurrence is secondary", async () => {
    const log: string[] = [];
    const deps = dependencies(log, [fakeFeature("feature", log)]);
    const shared = new Error("same identity in two phases");
    deps.backend.initialize = async () => {
      log.push("backend.initialize");
      deps.backend.emit("device-lost", shared);
      throw new AggregateError([shared, shared], "primary plus secondary identity");
    };
    const host = new RenderHost(deps);

    const failure = await host.initialize(journeySnapshot(), VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const causes = (failure.cause as AggregateError).errors;
    expect(causes[0]).toBe(shared);
    expect(causes[1]).toBeInstanceOf(AggregateError);
    expect((causes[1] as AggregateError).message).toBe("primary plus secondary identity");
    expect((causes[1] as AggregateError).errors).toEqual([shared]);
    await expect(host.dispose()).rejects.toBe(failure);
  });

  it("preserves primitive cleanup throws from separate disposal stages", async () => {
    const log: string[] = [];
    const feature = fakeFeature("feature", log);
    feature.dispose = () => {
      log.push("feature.dispose");
      throw undefined;
    };
    const deps = dependencies(log, [feature]);
    deps.backend.dispose = async () => {
      log.push("backend.dispose");
      deps.backend.disposed = true;
      deps.backend.listeners.clear();
      throw undefined;
    };
    const host = new RenderHost(deps);
    await host.initialize(journeySnapshot(), VIEWPORT);

    const failure = await host.dispose().catch((error: unknown) => error) as RenderHostError;
    expect(failure).toMatchObject({ code: "DISPOSAL_FAILED" });
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([undefined, undefined]);
  });
});
