import { describe, expect, it } from "vitest";
import {
  RENDER_HISTORY_INVALIDATION_REASONS,
  type BackendRuntimeEvent,
  type FeatureInitContext,
  type JourneyRenderSnapshot,
  type RenderBackendAdapter,
  type RenderBackendFacts,
  type RenderEventObserver,
  type RenderFeature,
  type RenderFrameLoop,
  type RenderHistoryInvalidation,
  type RenderHostDependencies,
  type RenderMaterialLibrary,
  type RenderPass,
  type RenderPassRecorder,
  type RenderPrecompileReceipt,
  type RenderQualityProfile,
  type RenderQualityProvider,
  type RenderResourceRegistry,
  type RenderResourceSnapshot,
  type RenderServiceInitializationContext,
  type RenderUploadQueue,
  type RenderViewport,
  type Unsubscribe,
  type VisualClock,
} from "../../src/gfx/v2/contracts";
import { RenderHost } from "../../src/gfx/v2/render-host";
import { RenderHostError } from "../../src/gfx/v2/errors";

const INITIAL_VIEWPORT: RenderViewport = { width: 1280, height: 720, pixelRatio: 1 };

const HIGH: RenderQualityProfile = {
  tier: "high",
  pixelRatio: 1.5,
  uploadBudgetMs: 1,
  features: { temporal: true, bloom: "half" },
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

const BALANCED: RenderQualityProfile = {
  tier: "balanced",
  pixelRatio: 1.25,
  uploadBudgetMs: 1,
  features: { temporal: true, bloom: "three-eighths" },
};

function journeySnapshot(
  overrides: Partial<JourneyRenderSnapshot> = {},
): JourneyRenderSnapshot {
  return {
    seed: 20_260_818,
    storyTime: 12,
    phase: "LIFE",
    shotId: "S03",
    position: { x: 0.25, y: -0.5 },
    velocity: { x: 0.1, y: 0.2 },
    pulses: [],
    answerAt: null,
    finished: false,
    ...overrides,
  };
}

class ControlledFrameLoop implements RenderFrameLoop {
  running = false;
  starts = 0;
  stops = 0;
  #callback: ((nowMs: number) => void) | null = null;

  start(callback: (nowMs: number) => void): void {
    if (this.running) throw new Error("frame loop already running");
    this.running = true;
    this.starts += 1;
    this.#callback = callback;
  }

  stop(): void {
    this.running = false;
    this.stops += 1;
    this.#callback = null;
  }

  tick(nowMs: number): void {
    this.#callback?.(nowMs);
  }
}

type HarnessCounts = {
  backendInitialize: number;
  backendResize: number;
  backendPrecompile: number;
  backendDispose: number;
  backendSubscribe: number;
  backendUnsubscribe: number;
  resourcesInitialize: number;
  resourcesDispose: number;
  uploadsInitialize: number;
  uploadsDispose: number;
  materialsInitialize: number;
  materialsDispose: number;
  featureInitialize: number;
  featureDispose: number;
  qualitySubscribe: number;
  qualityUnsubscribe: number;
};

type HarnessCaptures = {
  readonly serviceContexts: RenderServiceInitializationContext[];
  readonly featureContexts: FeatureInitContext[];
  readonly uploadQualityProfiles: Readonly<RenderQualityProfile>[];
  readonly uploadFlushProfiles: Array<Readonly<RenderQualityProfile> | undefined>;
  readonly uploadFlushClocks: VisualClock[];
  readonly materialWarmupProfiles: Array<readonly Readonly<RenderQualityProfile>[]>;
  readonly featureWarmupProfiles: Array<readonly Readonly<RenderQualityProfile>[]>;
  readonly featureQualityProfiles: Readonly<RenderQualityProfile>[];
  readonly resizedViewports: Readonly<RenderViewport>[];
  readonly invalidations: Readonly<RenderHistoryInvalidation>[];
  precompiled: readonly RenderPass[];
};

type HarnessOptions = {
  readonly initialProfile?: Readonly<RenderQualityProfile>;
  readonly onBackendPrecompile?: (
    passes: readonly RenderPass[],
    host: RenderHost,
  ) => void | Promise<void>;
  readonly getWarmupProfiles?: (
    host: RenderHost,
  ) => readonly Readonly<RenderQualityProfile>[];
  readonly materialWarmupPasses?: (
    profiles: readonly Readonly<RenderQualityProfile>[],
    host: RenderHost,
  ) => readonly RenderPass[];
  readonly featureWarmupPasses?: (
    profiles: readonly Readonly<RenderQualityProfile>[],
    host: RenderHost,
  ) => readonly RenderPass[];
  readonly onResourcesInitialize?: (
    context: RenderServiceInitializationContext,
    host: RenderHost,
  ) => void | Promise<void>;
  readonly onUploadsInitialize?: (
    context: RenderServiceInitializationContext,
    host: RenderHost,
  ) => void | Promise<void>;
  readonly onUploadsQuality?: (
    profile: Readonly<RenderQualityProfile>,
    host: RenderHost,
  ) => void | Promise<void>;
  readonly onUploadsFlush?: (
    clock: VisualClock,
    profile: Readonly<RenderQualityProfile> | undefined,
    host: RenderHost,
  ) => void | Promise<void>;
  readonly onMaterialsInitialize?: (
    context: RenderServiceInitializationContext,
    host: RenderHost,
  ) => void | Promise<void>;
  readonly onFeatureInitialize?: (
    context: FeatureInitContext,
    host: RenderHost,
  ) => void | Promise<void>;
  readonly onFeatureResize?: (
    viewport: Readonly<RenderViewport>,
    host: RenderHost,
  ) => void | Promise<void>;
  readonly onFeatureInvalidation?: (
    event: Readonly<RenderHistoryInvalidation>,
    host: RenderHost,
  ) => void;
  readonly onFeatureDispose?: (host: RenderHost) => void | Promise<void>;
};

type Harness = {
  readonly host: RenderHost;
  readonly backend: RenderBackendAdapter;
  readonly frameLoop: ControlledFrameLoop;
  readonly counts: HarnessCounts;
  readonly captures: HarnessCaptures;
  readonly emitQuality: (profile: Readonly<RenderQualityProfile>) => void;
  readonly tick: (nowMs: number) => Promise<void>;
};

function createHarness(options: HarnessOptions = {}): Harness {
  const counts: HarnessCounts = {
    backendInitialize: 0,
    backendResize: 0,
    backendPrecompile: 0,
    backendDispose: 0,
    backendSubscribe: 0,
    backendUnsubscribe: 0,
    resourcesInitialize: 0,
    resourcesDispose: 0,
    uploadsInitialize: 0,
    uploadsDispose: 0,
    materialsInitialize: 0,
    materialsDispose: 0,
    featureInitialize: 0,
    featureDispose: 0,
    qualitySubscribe: 0,
    qualityUnsubscribe: 0,
  };
  const captures: HarnessCaptures = {
    serviceContexts: [],
    featureContexts: [],
    uploadQualityProfiles: [],
    uploadFlushProfiles: [],
    uploadFlushClocks: [],
    materialWarmupProfiles: [],
    featureWarmupProfiles: [],
    featureQualityProfiles: [],
    resizedViewports: [],
    invalidations: [],
    precompiled: [],
  };
  const listeners = new Set<(event: BackendRuntimeEvent) => void>();
  const frameLoop = new ControlledFrameLoop();

  const facts: Readonly<RenderBackendFacts> = Object.freeze({
    requestedApi: "WebGPU",
    actualApi: "WebGPU",
    adapter: "extension-test",
    device: "extension-test-device",
    fallback: false,
  });
  const zeroResources = (): Readonly<RenderResourceSnapshot> => Object.freeze({
    geometries: 0,
    textures: 0,
    renderTargets: 0,
    programs: 0,
    nodes: 0,
    objects: 0,
    subscribers: listeners.size,
    pendingUploads: 0,
  });

  const backend: RenderBackendAdapter = {
    facts,
    async initialize(): Promise<void> {
      counts.backendInitialize += 1;
    },
    resize(): void {
      counts.backendResize += 1;
    },
    async precompile(passes): Promise<Readonly<RenderPrecompileReceipt>> {
      counts.backendPrecompile += 1;
      captures.precompiled = passes;
      await options.onBackendPrecompile?.(passes, host);
      return EMPTY_PRECOMPILE_RECEIPT;
    },
    render(): void {},
    subscribeEvents(listener): Unsubscribe {
      counts.backendSubscribe += 1;
      listeners.add(listener);
      return () => {
        counts.backendUnsubscribe += 1;
        listeners.delete(listener);
      };
    },
    snapshotResources: zeroResources,
    async dispose(): Promise<void> {
      counts.backendDispose += 1;
      listeners.clear();
    },
  };

  const observer: RenderEventObserver = { observe: () => undefined };
  const resources: RenderResourceRegistry = {
    async initialize(context): Promise<void> {
      counts.resourcesInitialize += 1;
      captures.serviceContexts.push(context);
      await options.onResourcesInitialize?.(context, host);
    },
    snapshot: zeroResources,
    dispose(): void {
      counts.resourcesDispose += 1;
    },
  };
  const uploads: RenderUploadQueue = {
    async initialize(context): Promise<void> {
      counts.uploadsInitialize += 1;
      captures.serviceContexts.push(context);
      await options.onUploadsInitialize?.(context, host);
    },
    async quality(profile): Promise<void> {
      captures.uploadQualityProfiles.push(profile);
      await options.onUploadsQuality?.(profile, host);
    },
    async flush(clock, profile): Promise<void> {
      captures.uploadFlushClocks.push(clock);
      captures.uploadFlushProfiles.push(profile);
      await options.onUploadsFlush?.(clock, profile, host);
    },
    pendingCount: () => 0,
    dispose(): void {
      counts.uploadsDispose += 1;
    },
  };
  const materials: RenderMaterialLibrary = {
    async initialize(context): Promise<void> {
      counts.materialsInitialize += 1;
      captures.serviceContexts.push(context);
      await options.onMaterialsInitialize?.(context, host);
    },
    warmupPasses(profiles = []): readonly RenderPass[] {
      captures.materialWarmupProfiles.push(profiles);
      return options.materialWarmupPasses?.(profiles, host) ?? [];
    },
    quality(): void {},
    dispose(): void {
      counts.materialsDispose += 1;
    },
  };

  const feature: RenderFeature = {
    id: "extension-feature",
    async initialize(context): Promise<void> {
      counts.featureInitialize += 1;
      captures.featureContexts.push(context);
      await options.onFeatureInitialize?.(context, host);
    },
    ...(options.featureWarmupPasses
      ? {
          warmupPasses(profiles: readonly Readonly<RenderQualityProfile>[]): readonly RenderPass[] {
            captures.featureWarmupProfiles.push(profiles);
            return options.featureWarmupPasses!(profiles, host);
          },
        }
      : {}),
    update(): void {},
    render(recorder: RenderPassRecorder): void {
      recorder.record({ name: "extension-frame", kind: "scene" });
    },
    quality(profile): void {
      captures.featureQualityProfiles.push(profile);
    },
    async resize(viewport): Promise<void> {
      captures.resizedViewports.push(viewport);
      await options.onFeatureResize?.(viewport, host);
    },
    invalidateHistory(event): void {
      captures.invalidations.push(event);
      options.onFeatureInvalidation?.(event, host);
    },
    async dispose(): Promise<void> {
      counts.featureDispose += 1;
      await options.onFeatureDispose?.(host);
    },
  };

  const qualityListeners = new Set<(profile: Readonly<RenderQualityProfile>) => void>();
  const qualityProvider: RenderQualityProvider = {
    getProfile: () => options.initialProfile ?? HIGH,
    subscribe(listener): Unsubscribe {
      counts.qualitySubscribe += 1;
      qualityListeners.add(listener);
      return () => {
        counts.qualityUnsubscribe += 1;
        qualityListeners.delete(listener);
      };
    },
  };
  if (options.getWarmupProfiles) {
    qualityProvider.getWarmupProfiles = () => options.getWarmupProfiles!(host);
  }

  const dependencies: RenderHostDependencies = {
    backend,
    frameLoop,
    warmupScheduler: { yieldToMain: async () => undefined },
    features: [feature],
    materials,
    uploads,
    resources,
    qualityProvider,
    observer,
  };
  const host = new RenderHost(dependencies);

  return {
    host,
    backend,
    frameLoop,
    counts,
    captures,
    emitQuality(profile): void {
      for (const listener of [...qualityListeners]) listener(profile);
    },
    async tick(nowMs: number): Promise<void> {
      frameLoop.tick(nowMs);
      await host.whenIdle();
    },
  };
}

function expectAllOwnershipDisposedOnce(harness: Harness): void {
  expect(harness.counts).toMatchObject({
    backendDispose: 1,
    backendUnsubscribe: 1,
    resourcesDispose: 1,
    uploadsDispose: 1,
    materialsDispose: 1,
    featureDispose: 1,
    qualityUnsubscribe: 1,
  });
}

describe("RenderHost v2.1 extension contract", () => {
  it("provides the same immutable viewport snapshot to service and feature initialization", async () => {
    const sourceViewport = { width: 1280, height: 720, pixelRatio: 1 };
    const harness = createHarness();

    await harness.host.initialize(journeySnapshot(), sourceViewport);
    sourceViewport.width = 1;
    sourceViewport.height = 1;
    sourceViewport.pixelRatio = 4;

    expect(harness.captures.serviceContexts).toHaveLength(3);
    const serviceViewport = harness.captures.serviceContexts[0]!.viewport;
    expect(serviceViewport).toEqual(INITIAL_VIEWPORT);
    expect(serviceViewport).not.toBe(sourceViewport);
    expect(Object.isFrozen(serviceViewport)).toBe(true);
    for (const context of harness.captures.serviceContexts) {
      expect(context.viewport).toBe(serviceViewport);
      expect(Object.isFrozen(context)).toBe(true);
    }
    expect(harness.captures.featureContexts).toHaveLength(1);
    expect(harness.captures.featureContexts[0]!.viewport).toBe(serviceViewport);
    expect(Object.isFrozen(harness.captures.featureContexts[0])).toBe(true);

    await harness.host.dispose();
    expectAllOwnershipDisposedOnce(harness);
  });

  it("forwards frozen quality snapshots to uploads and flushes with the current profile", async () => {
    const harness = createHarness();
    await harness.host.initialize(journeySnapshot(), INITIAL_VIEWPORT);

    expect(harness.captures.uploadQualityProfiles).toHaveLength(1);
    const initial = harness.captures.uploadQualityProfiles[0]!;
    expect(initial).toEqual(HIGH);
    expect(initial).not.toBe(HIGH);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.features)).toBe(true);

    await harness.tick(16);
    expect(harness.captures.uploadFlushProfiles).toEqual([initial]);
    expect(harness.captures.uploadFlushClocks[0]).toMatchObject({ frame: 0, nowMs: 16 });
    expect(Object.isFrozen(harness.captures.uploadFlushClocks[0])).toBe(true);

    await harness.host.setQuality(BALANCED);
    const balanced = harness.captures.uploadQualityProfiles.at(-1)!;
    expect(balanced).toEqual(BALANCED);
    expect(balanced).not.toBe(BALANCED);
    expect(Object.isFrozen(balanced)).toBe(true);
    await harness.tick(32);
    expect(harness.captures.uploadFlushProfiles.at(-1)).toBe(balanced);

    await harness.host.dispose();
  });

  it("resizes the feature before emitting one frozen resize invalidation", async () => {
    const order: string[] = [];
    const harness = createHarness({
      onFeatureResize: () => {
        order.push("feature.resize");
      },
      onFeatureInvalidation: (event) => {
        if (event.reason === "resize") order.push("feature.invalidate:resize");
      },
    });
    await harness.host.initialize(journeySnapshot(), INITIAL_VIEWPORT);
    const source = { width: 900, height: 500, pixelRatio: 1.25 };

    await harness.host.resize(source);
    source.width = 1;

    expect(harness.counts.backendResize).toBe(1);
    expect(harness.captures.resizedViewports).toHaveLength(1);
    expect(harness.captures.resizedViewports[0]).toEqual({
      width: 900,
      height: 500,
      pixelRatio: 1.25,
    });
    expect(Object.isFrozen(harness.captures.resizedViewports[0])).toBe(true);
    expect(order).toEqual(["feature.resize", "feature.invalidate:resize"]);
    expect(harness.captures.invalidations.filter((event) => event.reason === "resize"))
      .toHaveLength(1);

    await harness.host.dispose();
  });

  it("emits every semantic history invalidation exactly once and suppresses duplicate transitions", async () => {
    const harness = createHarness();
    await harness.host.initialize(journeySnapshot(), INITIAL_VIEWPORT);

    await harness.host.setQuality(HIGH);
    await harness.host.setQuality(BALANCED);
    await harness.host.setQuality(BALANCED);

    const s21 = journeySnapshot({
      shotId: "S21",
      storyTime: 161,
      phase: "ANSWER",
    });
    harness.host.setSnapshot(s21);
    harness.host.setSnapshot(s21);
    const s23 = journeySnapshot({
      shotId: "S23",
      storyTime: 171,
      phase: "TWINKLE",
    });
    harness.host.setSnapshot(s23);
    harness.host.setSnapshot(s23);
    const final = journeySnapshot({
      shotId: "S24",
      storyTime: 178,
      phase: "TWINKLE",
      finished: true,
    });
    harness.host.setSnapshot(final);
    harness.host.setSnapshot(final);
    const restarted = journeySnapshot({ shotId: "S03", storyTime: 12, phase: "LIFE" });
    harness.host.setSnapshot(restarted, "restart-or-qa-seek");
    harness.host.setSnapshot(restarted, "camera-discontinuity");
    harness.host.invalidateHistory("backend-change");

    expect(harness.captures.invalidations.map((event) => event.reason)).toEqual([
      "initialization",
      "quality-change",
      "story-cut-s21",
      "story-cut-s23",
      "final-life-light",
      "restart-or-qa-seek",
      "camera-discontinuity",
      "backend-change",
    ]);
    expect(new Set(harness.captures.invalidations.map((event) => event.reason))).toEqual(
      new Set(RENDER_HISTORY_INVALIDATION_REASONS.filter((reason) => reason !== "resize")),
    );
    for (const event of harness.captures.invalidations) expect(Object.isFrozen(event)).toBe(true);
    expect(harness.captures.invalidations[0]).toMatchObject({
      reason: "initialization",
      previousShotId: null,
      nextShotId: "S03",
      storyTime: 12,
    });
    expect(harness.captures.invalidations.find((event) => event.reason === "story-cut-s21"))
      .toMatchObject({ previousShotId: "S03", nextShotId: "S21", storyTime: 161 });

    await harness.host.dispose();
  });

  it("warms every supplied profile and preserves same-name passes with distinct variants", async () => {
    const mutableLow = {
      tier: "low" as const,
      pixelRatio: 1,
      uploadBudgetMs: 1,
      features: { temporal: false },
    };
    const suppliedProfiles: RenderQualityProfile[] = [mutableLow, BALANCED, HIGH];
    const harness = createHarness({
      getWarmupProfiles: () => suppliedProfiles,
      materialWarmupPasses: () => [
        {
          name: "shared-lighting",
          kind: "lighting",
          variant: "balanced",
          payload: "material-old",
        },
        {
          name: "default-alias-regression",
          kind: "temporal",
          payload: "variant-absent",
        },
      ],
      featureWarmupPasses: () => [
        {
          name: "shared-lighting",
          kind: "lighting",
          variant: "balanced",
          payload: "feature-new",
        },
        { name: "shared-lighting", kind: "lighting", variant: "low" },
        { name: "shared-lighting", kind: "lighting", variant: "high" },
        {
          name: "default-alias-regression",
          kind: "temporal",
          variant: "default",
          payload: "variant-explicit-default",
        },
      ],
    });

    await harness.host.initialize(journeySnapshot(), INITIAL_VIEWPORT);
    mutableLow.pixelRatio = 4;
    mutableLow.features.temporal = true;

    const materialProfiles = harness.captures.materialWarmupProfiles[0]!;
    const featureProfiles = harness.captures.featureWarmupProfiles[0]!;
    expect(materialProfiles).toBe(featureProfiles);
    expect(materialProfiles.map((profile) => profile.tier)).toEqual(["low", "balanced", "high"]);
    expect(materialProfiles[0]).toMatchObject({ pixelRatio: 1, features: { temporal: false } });
    expect(Object.isFrozen(materialProfiles)).toBe(true);
    for (const profile of materialProfiles) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.features)).toBe(true);
    }

    const shared = harness.captures.precompiled.filter(
      (pass) => pass.name === "shared-lighting" && pass.kind === "lighting",
    );
    expect(shared.map((pass) => pass.variant)).toEqual(["balanced", "low", "high"]);
    expect(shared.find((pass) => pass.variant === "balanced")?.payload).toBe("feature-new");
    const defaultAliasRegression = harness.captures.precompiled.filter(
      (pass) => pass.name === "default-alias-regression" && pass.kind === "temporal",
    );
    expect(defaultAliasRegression).toHaveLength(2);
    expect(Object.prototype.hasOwnProperty.call(defaultAliasRegression[0], "variant")).toBe(false);
    expect(defaultAliasRegression[0]?.payload).toBe("variant-absent");
    expect(defaultAliasRegression[1]).toMatchObject({
      variant: "default",
      payload: "variant-explicit-default",
    });
    expect(harness.counts.backendPrecompile).toBe(1);
    expect(Object.isFrozen(harness.captures.precompiled)).toBe(true);
    for (const pass of harness.captures.precompiled) expect(Object.isFrozen(pass)).toBe(true);

    await harness.host.dispose();
  });

  it("fails closed when an un-warmed profile arrives while precompile is pending", async () => {
    let markPrecompileStarted!: () => void;
    const precompileStarted = new Promise<void>((resolve) => {
      markPrecompileStarted = resolve;
    });
    let releasePrecompile!: () => void;
    const precompileGate = new Promise<void>((resolve) => {
      releasePrecompile = resolve;
    });
    const harness = createHarness({
      initialProfile: HIGH,
      getWarmupProfiles: () => [HIGH],
      onBackendPrecompile: () => {
        markPrecompileStarted();
        return precompileGate;
      },
    });

    const initialization = harness.host.initialize(journeySnapshot(), INITIAL_VIEWPORT);
    await precompileStarted;
    expect(harness.host.state).toBe("initializing");
    harness.emitQuality(BALANCED);
    releasePrecompile();

    const failure = await initialization.catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(harness.host.error);
    expect(failure).toMatchObject({ code: "INITIALIZATION_FAILED" });
    expect(harness.host.state).toBe("failed");
    expect(harness.frameLoop.starts).toBe(0);
    expect(harness.captures.materialWarmupProfiles[0]?.map((profile) => profile.tier))
      .toEqual(["high"]);
    expect(harness.captures.uploadQualityProfiles.map((profile) => profile.tier))
      .toEqual(["high"]);
    expectAllOwnershipDisposedOnce(harness);
    await expect(harness.host.dispose()).resolves.toBeUndefined();
    expectAllOwnershipDisposedOnce(harness);
  });

  it.each([
    {
      label: "empty",
      profiles: (): readonly Readonly<RenderQualityProfile>[] => [],
    },
    {
      label: "sparse",
      profiles: (): readonly Readonly<RenderQualityProfile>[] => {
        const sparse = new Array<Readonly<RenderQualityProfile>>(2);
        sparse[0] = HIGH;
        return sparse;
      },
    },
    {
      label: "wider than the bounded contract",
      profiles: (): readonly Readonly<RenderQualityProfile>[] => Array.from(
        { length: 17 },
        () => HIGH,
      ),
    },
  ])("fails closed for an $label warm-up profile list and unwinds ownership", async ({ profiles }) => {
    const harness = createHarness({ getWarmupProfiles: profiles });

    await expect(harness.host.initialize(journeySnapshot(), INITIAL_VIEWPORT)).rejects
      .toMatchObject({ code: "INITIALIZATION_FAILED" });
    expect(harness.host.state).toBe("failed");
    expect(harness.counts.backendPrecompile).toBe(0);
    expectAllOwnershipDisposedOnce(harness);
    await expect(harness.host.dispose()).resolves.toBeUndefined();
    expectAllOwnershipDisposedOnce(harness);
  });

  it("rejects an invalid warm-up variant before precompile and unwinds ownership once", async () => {
    const harness = createHarness({
      featureWarmupPasses: () => [{ name: "history", kind: "temporal", variant: "   " }],
    });

    const failure = await harness.host.initialize(journeySnapshot(), INITIAL_VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toMatchObject({ code: "INITIALIZATION_FAILED" });
    expect(failure.cause).toMatchObject({
      message: "A render pass variant must be a non-empty string when present.",
    });
    expect(harness.counts.backendPrecompile).toBe(0);
    expectAllOwnershipDisposedOnce(harness);
  });

  it("rejects invalid manual invalidation input atomically without changing the snapshot", async () => {
    const harness = createHarness();
    await harness.host.initialize(journeySnapshot(), INITIAL_VIEWPORT);
    const before = harness.host.journeySnapshot;
    const countBefore = harness.captures.invalidations.length;

    expect(() => harness.host.setSnapshot(
      journeySnapshot({ shotId: "S08", storyTime: 36, phase: "EARTH" }),
      "quality-change" as never,
    )).toThrow(TypeError);
    expect(harness.host.journeySnapshot).toBe(before);
    expect(harness.captures.invalidations).toHaveLength(countBefore);
    expect(() => harness.host.invalidateHistory("not-a-reason" as never)).toThrow(TypeError);
    expect(harness.captures.invalidations).toHaveLength(countBefore);
    expect(harness.host.state).toBe("ready");

    await harness.host.dispose();
  });

  it("fails closed on initialization callback reentry and disposes every acquired owner once", async () => {
    const harness = createHarness({
      getWarmupProfiles: (host) => {
        host.setSnapshot(journeySnapshot({ storyTime: 13 }));
        return [HIGH];
      },
    });

    const failure = await harness.host.initialize(journeySnapshot(), INITIAL_VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toBe(harness.host.error);
    expect(failure).toMatchObject({ code: "INVALID_LIFECYCLE" });
    expect(harness.counts.backendPrecompile).toBe(0);
    expectAllOwnershipDisposedOnce(harness);
  });

  it("fails closed on live invalidation reentry and does not dispose ownership twice", async () => {
    const harness = createHarness({
      onFeatureInvalidation: (event, host) => {
        if (event.reason === "backend-change") {
          host.setSnapshot(journeySnapshot({ storyTime: 14 }));
        }
      },
    });
    await harness.host.initialize(journeySnapshot(), INITIAL_VIEWPORT);

    expect(() => harness.host.invalidateHistory("backend-change")).toThrow(RenderHostError);
    await harness.host.whenIdle();
    expect(harness.host.state).toBe("failed");
    expect(harness.host.error).toMatchObject({ code: "INVALID_LIFECYCLE" });
    expectAllOwnershipDisposedOnce(harness);
    await expect(harness.host.dispose()).resolves.toBeUndefined();
    expectAllOwnershipDisposedOnce(harness);
  });

  it("fails closed on upload-flush reentry and releases frame ownership once", async () => {
    const harness = createHarness({
      onUploadsFlush: (_clock, _profile, host) => {
        host.setSnapshot(journeySnapshot({ storyTime: 15 }));
      },
    });
    await harness.host.initialize(journeySnapshot(), INITIAL_VIEWPORT);

    await harness.tick(16);
    expect(harness.host.state).toBe("failed");
    expect(harness.host.error).toMatchObject({ code: "INVALID_LIFECYCLE" });
    expect(harness.frameLoop.running).toBe(false);
    expectAllOwnershipDisposedOnce(harness);
    await expect(harness.host.dispose()).resolves.toBeUndefined();
    expectAllOwnershipDisposedOnce(harness);
  });

  it("unwinds all ownership when initial temporal invalidation fails", async () => {
    const primary = new Error("initial history allocation failed");
    const harness = createHarness({
      onFeatureInvalidation: (event) => {
        if (event.reason === "initialization") throw primary;
      },
    });

    const failure = await harness.host.initialize(journeySnapshot(), INITIAL_VIEWPORT)
      .catch((error: unknown) => error) as RenderHostError;
    expect(failure).toMatchObject({ code: "INITIALIZATION_FAILED" });
    expect(failure.cause).toBe(primary);
    expect(harness.counts.qualitySubscribe).toBe(0);
    expect(harness.counts.qualityUnsubscribe).toBe(0);
    expect(harness.counts).toMatchObject({
      backendDispose: 1,
      backendUnsubscribe: 1,
      resourcesDispose: 1,
      uploadsDispose: 1,
      materialsDispose: 1,
      featureDispose: 1,
    });
    await expect(harness.host.dispose()).resolves.toBeUndefined();
    expect(harness.counts.featureDispose).toBe(1);
    expect(harness.counts.backendDispose).toBe(1);
  });
});
