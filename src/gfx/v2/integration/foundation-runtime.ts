import { AmbientLight, Color, PerspectiveCamera, Scene } from "three/webgpu";
import { createThreeBackend } from "../backend/create-backend";
import type {
  ThreeBackendAdapter,
  ThreeBackendFacts,
  ThreeBackendLifecycleSnapshot,
  ThreeBackendRequest,
} from "../backend/backend-adapter";
import {
  ChunkManager,
  IncrementalChunkUploadQueue,
  WorldChunkRenderFeature,
  createBrowserWorldChunkWorker,
  type ChunkRuntimeSnapshot,
} from "../chunks";
import {
  ProductionTslMaterialLibrary,
  type TslMaterialLibrarySnapshot,
} from "../materials";
import {
  ForestCityHeroFeature,
  OceanHeroFeature,
  SpaceTwinkleHeroFeature,
  type ForestCityHeroFeatureSnapshot,
  type OceanHeroFeatureSnapshot,
  type SpaceTwinkleHeroFeatureSnapshot,
} from "../hero";
import {
  ProductionLinearHdrPipeline,
  type LinearHdrPipelineSnapshot,
} from "../pipeline";
import {
  createGfxContractResizeBinding,
  createStableGfxContractOperation,
  finalizeGfxContractRuntime,
  immutableGfxContractAggregate,
  notifyGfxContractSubscribers,
  reconcileGfxContractViewport,
  rollbackGfxContractConstruction,
} from "../contract-lab";
import type {
  JourneyRenderSnapshot,
  RenderEventObserver,
  RenderFrameLoop,
  RenderHostEvent,
  RenderHostProbeSnapshot,
  RenderQualityProfile,
  RenderTwinkleSeedSnapshot,
  RenderQualityProvider,
  RenderViewport,
  Unsubscribe,
} from "../contracts";
import { RenderHost, createBrowserRenderWarmupScheduler } from "../render-host";
import {
  RollingGfxPerformanceTelemetry,
  type GfxPerformanceTelemetrySnapshot,
} from "../telemetry";
import {
  WORLD_GENERATOR_VERSION,
  createWorldGenerationContext,
  digestWorldPlan,
  generateWorldPlan,
  type StoryChunkId,
  type WorldPlan,
} from "../../../world/v2";
import { LogicalChunkResourceRegistry, type LogicalResourceRegistrySnapshot } from "./logical-resource-registry";
import {
  FoundationConstructionAdmission,
  FoundationConstructionCleanupOwner,
  assertFoundationHostReady,
  immutableFoundationCleanupFailure,
} from "./foundation-construction-owner";
import { PooledWorldChunkFeature } from "./pooled-world-chunk-feature";
import { ProductionThreeChunkUploader, type ThreeChunkUploaderSnapshot } from "./three-chunk-uploader";

export type FoundationQualityId =
  | "high-temporal"
  | "high-static"
  | "balanced-temporal"
  | "balanced-static"
  | "low-static";

function profile(
  tier: RenderQualityProfile["tier"],
  pixelRatio: number,
  temporal: boolean,
): Readonly<RenderQualityProfile> {
  return Object.freeze({
    tier,
    pixelRatio,
    uploadBudgetMs: 4,
    features: Object.freeze({ temporal, chunkStreaming: true, linearHdr: true }),
  });
}

export const FOUNDATION_QUALITY_PROFILES: Readonly<
  Record<FoundationQualityId, Readonly<RenderQualityProfile>>
> = Object.freeze({
  "high-temporal": profile("high", 1.5, true),
  "high-static": profile("high", 1.5, false),
  "balanced-temporal": profile("balanced", 1, true),
  "balanced-static": profile("balanced", 1, false),
  "low-static": profile("low", 0.75, false),
});

const WARMUP_PROFILES = Object.freeze(Object.values(FOUNDATION_QUALITY_PROFILES));
const INITIAL_QUALITY: FoundationQualityId = "high-temporal";
const INITIAL_CHUNK: StoryChunkId = "S08";
const DEFAULT_HERO_A_MARKER_SECONDS = 12;
const DEFAULT_HERO_B_MARKER_SECONDS = 58;
const DEFAULT_HERO_C_MARKER_SECONDS = 142;

const EMPTY_RENDER_PULSES = Object.freeze([]) as readonly Readonly<RenderTwinkleSeedSnapshot>[];
const HERO_C_REVIEW_PULSES: readonly Readonly<RenderTwinkleSeedSnapshot>[] = Object.freeze([
  Object.freeze({
    id: 1,
    journeyTime: 5,
    x: 0.091_909,
    y: -0.146_463,
    phase: "LIFE" as const,
    source: "player" as const,
    value: 953_532_373,
  }),
  Object.freeze({
    id: 2,
    journeyTime: 39,
    x: 0.94,
    y: 0.749_6,
    phase: "EARTH" as const,
    source: "player" as const,
    value: 1_435_770_856,
  }),
  Object.freeze({
    id: 3,
    journeyTime: 166.4,
    x: -0.94,
    y: 0.94,
    phase: "ANSWER" as const,
    source: "player" as const,
    value: 1_348_556_668,
  }),
]);

export type GfxFoundationExperience = "foundation" | "hero-a" | "hero-b" | "hero-c";

class BrowserFrameLoop implements RenderFrameLoop {
  running = false;
  starts = 0;
  stops = 0;
  ticks = 0;
  #requestId: number | null = null;
  #callback: ((nowMs: number) => void) | null = null;

  start(callback: (nowMs: number) => void): void {
    if (this.running) throw new Error("The foundation frame loop is already active.");
    this.running = true;
    this.starts += 1;
    this.#callback = callback;
    const tick = (nowMs: number) => {
      if (!this.running || this.#callback === null) return;
      this.ticks += 1;
      this.#callback(nowMs);
      this.#requestId = this.running && this.#callback !== null
        ? requestAnimationFrame(tick)
        : null;
    };
    this.#requestId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.running) this.stops += 1;
    this.running = false;
    this.#callback = null;
    if (this.#requestId !== null) cancelAnimationFrame(this.#requestId);
    this.#requestId = null;
  }

  snapshot() {
    return Object.freeze({ running: this.running, starts: this.starts, stops: this.stops, ticks: this.ticks });
  }
}

class FoundationQualityProvider implements RenderQualityProvider {
  readonly #listeners = new Set<(profile: Readonly<RenderQualityProfile>) => void>();
  #id: FoundationQualityId = INITIAL_QUALITY;

  getProfile(): Readonly<RenderQualityProfile> {
    return FOUNDATION_QUALITY_PROFILES[this.#id];
  }

  getWarmupProfiles(): readonly Readonly<RenderQualityProfile>[] {
    return WARMUP_PROFILES;
  }

  subscribe(listener: (profile: Readonly<RenderQualityProfile>) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  profile(id: FoundationQualityId): Readonly<RenderQualityProfile> {
    return FOUNDATION_QUALITY_PROFILES[id];
  }

  commit(id: FoundationQualityId): void {
    this.#id = id;
  }

  snapshot() {
    return Object.freeze({ id: this.#id, subscribers: this.#listeners.size });
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

function viewportFor(
  canvas: HTMLCanvasElement,
  quality: Readonly<RenderQualityProfile>,
): Readonly<RenderViewport> {
  return Object.freeze({
    width: Math.max(1, Math.round(canvas.clientWidth || 960)),
    height: Math.max(1, Math.round(canvas.clientHeight || 720)),
    pixelRatio: Math.min(window.devicePixelRatio || 1, quality.pixelRatio),
  });
}

function renderSnapshot(plan: Readonly<WorldPlan>, chunkId: StoryChunkId): Readonly<JourneyRenderSnapshot> {
  const chunk = plan.chunks.find((candidate) => candidate.id === chunkId);
  if (!chunk) throw new RangeError(`World plan is missing ${chunkId}.`);
  return Object.freeze({
    seed: Number(plan.worldSeed),
    storyTime: chunk.storyNode.startMs / 1000,
    phase: chunk.storyNode.phase,
    shotId: chunkId,
    position: Object.freeze({ x: 0, y: 0 }),
    velocity: Object.freeze({ x: 0, y: 0 }),
    pulses: Object.freeze([]),
    answerAt: null,
    finished: chunkId === "S24",
  });
}

function renderSnapshotAt(
  plan: Readonly<WorldPlan>,
  requestedStoryTime: number,
  pulseLedger: readonly Readonly<RenderTwinkleSeedSnapshot>[] = EMPTY_RENDER_PULSES,
  answerAt: number | null = null,
): Readonly<JourneyRenderSnapshot> {
  if (!Number.isFinite(requestedStoryTime)) {
    throw new TypeError("Foundation story time must be finite.");
  }
  const storyTime = Math.max(0, Math.min(180, requestedStoryTime));
  const storyTimeMs = Math.round(storyTime * 1000);
  const chunk = plan.chunks.find((candidate) => (
    storyTimeMs >= candidate.storyNode.startMs
    && (storyTimeMs < candidate.storyNode.endMs || candidate.id === "S24")
  ));
  if (!chunk) throw new RangeError(`World plan has no chunk at ${storyTime} seconds.`);
  const pulses = Object.freeze(pulseLedger.filter((pulse) => pulse.journeyTime <= storyTime));
  return Object.freeze({
    seed: Number(plan.worldSeed),
    storyTime,
    phase: chunk.storyNode.phase,
    shotId: chunk.id,
    position: Object.freeze({ x: 0, y: 0 }),
    velocity: Object.freeze({ x: 0, y: 0 }),
    pulses,
    answerAt: answerAt !== null && answerAt <= storyTime ? answerAt : null,
    finished: storyTime >= 180,
  });
}

function defaultMarkerFor(experience: GfxFoundationExperience): number {
  if (experience === "hero-a") return DEFAULT_HERO_A_MARKER_SECONDS;
  if (experience === "hero-b") return DEFAULT_HERO_B_MARKER_SECONDS;
  if (experience === "hero-c") return DEFAULT_HERO_C_MARKER_SECONDS;
  return 0;
}

function renderExperienceSnapshotAt(
  plan: Readonly<WorldPlan>,
  storyTime: number,
  experience: GfxFoundationExperience,
): Readonly<JourneyRenderSnapshot> {
  if (experience !== "hero-c") return renderSnapshotAt(plan, storyTime);
  return renderSnapshotAt(plan, storyTime, HERO_C_REVIEW_PULSES, 166.400_001);
}

function assertProductionSnapshot(
  plan: Readonly<WorldPlan>,
  snapshot: Readonly<JourneyRenderSnapshot>,
): Readonly<JourneyRenderSnapshot> {
  if (snapshot.seed !== Number(plan.worldSeed)) {
    throw new RangeError(
      `Production snapshot seed ${snapshot.seed} does not match the initialized world ${String(plan.worldSeed)}.`,
    );
  }
  if (!Number.isFinite(snapshot.storyTime) || snapshot.storyTime < 0 || snapshot.storyTime > 180) {
    throw new RangeError("Production story time must be finite and within the 180 second journey.");
  }
  const storyTimeMs = Math.round(snapshot.storyTime * 1000);
  const chunk = plan.chunks.find((candidate) => (
    storyTimeMs >= candidate.storyNode.startMs
    && (storyTimeMs < candidate.storyNode.endMs || candidate.id === "S24")
  ));
  if (!chunk || chunk.id !== snapshot.shotId || chunk.storyNode.phase !== snapshot.phase) {
    throw new RangeError(
      `Production snapshot ${snapshot.shotId}/${snapshot.phase} does not match the world plan at ${snapshot.storyTime}.`,
    );
  }
  return snapshot;
}

function sceneSnapshot(scene: Scene) {
  let objects = 0;
  let meshes = 0;
  scene.traverse((object) => {
    if (object !== scene) objects += 1;
    if ("isMesh" in object && object.isMesh === true) meshes += 1;
  });
  return Object.freeze({ objects, meshes, children: scene.children.length });
}

export interface GfxFoundationSnapshot {
  readonly generation: number;
  readonly planDigest: string;
  readonly host: Readonly<RenderHostProbeSnapshot>;
  readonly backendFacts: Readonly<ThreeBackendFacts>;
  readonly backendLifecycle: Readonly<ThreeBackendLifecycleSnapshot>;
  readonly pipeline: Readonly<LinearHdrPipelineSnapshot>;
  readonly materials: Readonly<TslMaterialLibrarySnapshot>;
  readonly chunks: Readonly<ChunkRuntimeSnapshot>;
  readonly uploader: Readonly<ThreeChunkUploaderSnapshot>;
  readonly logicalResources: Readonly<LogicalResourceRegistrySnapshot>;
  readonly telemetry: Readonly<GfxPerformanceTelemetrySnapshot>;
  readonly quality: Readonly<{ id: FoundationQualityId; subscribers: number }>;
  readonly frameLoop: Readonly<{ running: boolean; starts: number; stops: number; ticks: number }>;
  readonly scene: Readonly<{ objects: number; meshes: number; children: number }>;
  readonly heroA: Readonly<OceanHeroFeatureSnapshot> | null;
  readonly heroB: Readonly<ForestCityHeroFeatureSnapshot> | null;
  readonly heroC: Readonly<SpaceTwinkleHeroFeatureSnapshot> | null;
  readonly runtime: Readonly<{
    resizeListenerActive: boolean;
    resizeCalls: number;
    subscribers: number;
    disposeCalls: number;
  }>;
  readonly observedEvents: readonly string[];
}

export interface GfxFoundationRuntime {
  getSnapshot(): Readonly<GfxFoundationSnapshot>;
  subscribe(listener: () => void): Unsubscribe;
  update(snapshot: Readonly<JourneyRenderSnapshot>): void;
  seek(chunkId: StoryChunkId): void;
  seekTime(storyTime: number): void;
  resize(width: number, height: number): Promise<void>;
  setQuality(id: FoundationQualityId): Promise<void>;
  dispose(): Promise<Readonly<GfxFoundationSnapshot>>;
  diagnostics: ThreeBackendAdapter["diagnostics"];
}

const foundationConstructionAdmission = new FoundationConstructionAdmission<
  FoundationConstructionCleanupOwner
>();

type FoundationResizeBinding = ReturnType<typeof createGfxContractResizeBinding>;

async function performGfxFoundationConstruction(options: {
  readonly canvas: HTMLCanvasElement;
  readonly request: ThreeBackendRequest;
  readonly qa: boolean;
  readonly generation: number;
  readonly experience: GfxFoundationExperience;
  readonly initialStoryTime?: number;
  readonly initialSnapshot?: Readonly<JourneyRenderSnapshot>;
}, admission: FoundationConstructionAdmission<FoundationConstructionCleanupOwner>): Promise<GfxFoundationRuntime> {
  let sceneOwner: Scene | null = null;
  let pipelineOwner: ProductionLinearHdrPipeline | null = null;
  let materialsOwner: ProductionTslMaterialLibrary | null = null;
  let uploadsOwner: IncrementalChunkUploadQueue | null = null;
  let resourcesOwner: LogicalChunkResourceRegistry | null = null;
  let uploaderOwner: ProductionThreeChunkUploader | null = null;
  let qualityOwner: FoundationQualityProvider | null = null;
  let worker: ReturnType<typeof createBrowserWorldChunkWorker> | null = null;
  let backend: ThreeBackendAdapter | null = null;
  let managerOwner: ChunkManager | null = null;
  let frameLoopOwner: BrowserFrameLoop | null = null;
  let hostOwner: RenderHost | null = null;
  let resizeBindingOwner: FoundationResizeBinding | null = null;
  let telemetryOwner: RollingGfxPerformanceTelemetry | null = null;
  let heroOwner: OceanHeroFeature | ForestCityHeroFeature | SpaceTwinkleHeroFeature | null = null;
  let unsubscribeHost: Unsubscribe = () => undefined;
  let constructionFailurePresent = false;
  let constructionFailure: unknown;

  const constructionOwner = new FoundationConstructionCleanupOwner(async () => {
    const failures: unknown[] = [];
    const attempt = async (
      operation: () => void | Promise<void>,
      release: () => void,
    ) => {
      try {
        await operation();
        release();
      } catch (error: unknown) {
        failures.push(error);
      }
    };
    const detachResize = () => {
      const binding = resizeBindingOwner;
      if (!binding) return;
      binding.detach();
      if (resizeBindingOwner === binding) resizeBindingOwner = null;
    };
    const unsubscribe = () => {
      const owned = unsubscribeHost;
      owned();
      if (unsubscribeHost === owned) unsubscribeHost = () => undefined;
    };

    try {
      if (hostOwner) {
        const exactHostOwner = hostOwner;
        const rollbackFailures = constructionFailurePresent
          ? await rollbackGfxContractConstruction(
            exactHostOwner,
            unsubscribe,
            detachResize,
            constructionFailure,
          )
          : await rollbackGfxContractConstruction(
            exactHostOwner,
            unsubscribe,
            detachResize,
          );
        failures.push(...rollbackFailures);
        // The Host is the sole dependency owner after construction. Drop every
        // duplicate alias even when Host cleanup fails; retain the exact Host.
        managerOwner = null;
        worker = null;
        backend = null;
        pipelineOwner = null;
        materialsOwner = null;
        uploadsOwner = null;
        resourcesOwner = null;
        uploaderOwner = null;
        heroOwner = null;
        frameLoopOwner = null;
        if (rollbackFailures.length === 0) hostOwner = null;
      } else {
        await attempt(detachResize, () => { resizeBindingOwner = null; });
        if (managerOwner) {
          const exactManager = managerOwner;
          await attempt(
            () => exactManager.dispose(),
            () => {
              if (managerOwner === exactManager) managerOwner = null;
            },
          );
          // The manager is the exact worker owner even when its cleanup fails.
          // Keep that single owner rather than a duplicate worker alias.
          worker = null;
        } else if (worker) {
          const exactWorker = worker;
          await attempt(
            () => exactWorker.dispose(),
            () => { if (worker === exactWorker) worker = null; },
          );
        }
        if (frameLoopOwner) {
          const exactFrameLoop = frameLoopOwner;
          await attempt(
            () => exactFrameLoop.stop(),
            () => { if (frameLoopOwner === exactFrameLoop) frameLoopOwner = null; },
          );
        }
        if (heroOwner) {
          const exactHero = heroOwner;
          await attempt(
            () => exactHero.dispose(),
            () => { if (heroOwner === exactHero) heroOwner = null; },
          );
        }
        if (uploaderOwner) {
          const exactUploader = uploaderOwner;
          await attempt(
            () => exactUploader.dispose(),
            () => { if (uploaderOwner === exactUploader) uploaderOwner = null; },
          );
        }
        if (backend) {
          const exactBackend = backend;
          await attempt(
            () => exactBackend.dispose(),
            () => { if (backend === exactBackend) backend = null; },
          );
        }
        if (pipelineOwner) {
          const exactPipeline = pipelineOwner;
          await attempt(
            () => exactPipeline.dispose(),
            () => { if (pipelineOwner === exactPipeline) pipelineOwner = null; },
          );
        }
        if (materialsOwner) {
          const exactMaterials = materialsOwner;
          await attempt(
            () => exactMaterials.dispose(),
            () => { if (materialsOwner === exactMaterials) materialsOwner = null; },
          );
        }
        if (uploadsOwner) {
          const exactUploads = uploadsOwner;
          await attempt(
            () => exactUploads.dispose(),
            () => { if (uploadsOwner === exactUploads) uploadsOwner = null; },
          );
        }
        if (resourcesOwner) {
          const exactResources = resourcesOwner;
          await attempt(
            () => exactResources.dispose(),
            () => { if (resourcesOwner === exactResources) resourcesOwner = null; },
          );
        }
      }
      if (qualityOwner) {
        const exactQuality = qualityOwner;
        await attempt(
          () => exactQuality.dispose(),
          () => { if (qualityOwner === exactQuality) qualityOwner = null; },
        );
      }
      if (telemetryOwner) {
        const exactTelemetry = telemetryOwner;
        await attempt(
          () => exactTelemetry.dispose(),
          () => { if (telemetryOwner === exactTelemetry) telemetryOwner = null; },
        );
      }
      if (sceneOwner) {
        const exactScene = sceneOwner;
        await attempt(
          () => { exactScene.clear(); },
          () => { if (sceneOwner === exactScene) sceneOwner = null; },
        );
      }
      if (failures.length > 0) {
        throw immutableFoundationCleanupFailure(
          failures,
          "GFX foundation construction cleanup failed.",
        );
      }
    } finally {
      constructionFailure = undefined;
      constructionFailurePresent = false;
    }
  });
  admission.publish(constructionOwner);

  try {
    const plan = generateWorldPlan(createWorldGenerationContext({
      worldSeed: options.initialSnapshot?.seed ?? 20_260_818,
      generatorVersion: WORLD_GENERATOR_VERSION,
    }));
    const planDigest = digestWorldPlan(plan);
    const scene = sceneOwner = new Scene();
    scene.background = new Color(0x020611);
    scene.add(new AmbientLight(0xffffff, 1));
    const camera = new PerspectiveCamera(48, 1, 0.1, 80);
    camera.position.set(0, 0.2, 12);
    camera.lookAt(0, 0, 0);

    const pipeline = pipelineOwner = new ProductionLinearHdrPipeline({ temporalHistoryWeight: 0.1 });
    const materials = materialsOwner = new ProductionTslMaterialLibrary();
    const telemetry = telemetryOwner = new RollingGfxPerformanceTelemetry();
    const monotonicNow = () => performance.now();
    const uploads = uploadsOwner = new IncrementalChunkUploadQueue(
      monotonicNow,
      (event) => telemetry.recordOperation(event),
    );
    const resources = resourcesOwner = new LogicalChunkResourceRegistry();
    const uploader = uploaderOwner = new ProductionThreeChunkUploader(scene, materials, {
      presentRuntimeObjects: options.experience === "foundation",
    });
    const qualityProvider = qualityOwner = new FoundationQualityProvider();
    const initialViewport = viewportFor(options.canvas, qualityProvider.getProfile());
    worker = createBrowserWorldChunkWorker();
    backend = await createThreeBackend({
      canvas: options.canvas,
      request: options.request,
      lab: true,
      diagnosticsEnabled: options.qa,
      pipeline,
    });

    const manager = managerOwner = new ChunkManager({
      plan,
      worker,
      uploads,
      uploader,
      resources,
      generationConcurrency: 2,
      now: monotonicNow,
      telemetry,
    });
    const persistentPass = Object.freeze({
      name: "gfx-foundation-world",
      kind: "linear-hdr-world",
      variant: "persistent-v1",
      scene,
      camera,
    });
    const innerWorld = new WorldChunkRenderFeature(manager, persistentPass);
    const pooledWorld = new PooledWorldChunkFeature(innerWorld, uploader);
    const oceanHero = options.experience === "hero-a"
      ? new OceanHeroFeature(scene, camera, plan)
      : null;
    const forestCityHero = options.experience === "hero-b"
      ? new ForestCityHeroFeature(scene, camera, plan)
      : null;
    const spaceTwinkleHero = options.experience === "hero-c"
      ? new SpaceTwinkleHeroFeature(scene, camera, plan)
      : null;
    const hero = oceanHero ?? forestCityHero ?? spaceTwinkleHero;
    heroOwner = hero;
    const frameLoop = frameLoopOwner = new BrowserFrameLoop();
    const warmupScheduler = createBrowserRenderWarmupScheduler();
    const observedEvents: string[] = [];
    const observer: RenderEventObserver = {
      observe(event: RenderHostEvent) {
        observedEvents.push(event.kind);
        if (observedEvents.length > 256) observedEvents.shift();
      },
    };
    const host = hostOwner = new RenderHost(
      {
        backend,
        frameLoop,
        warmupScheduler,
        features: hero ? [pipeline, hero, pooledWorld] : [pipeline, pooledWorld],
        materials,
        uploads,
        resources,
        qualityProvider,
        observer,
      },
      Object.freeze({ telemetry, now: monotonicNow }),
    );

    const listeners = new Set<() => void>();
    let resizeCalls = 0;
    let disposeCalls = 0;
    let constructionComplete = false;
    let terminalCleanupScheduled = false;
    const notify = () => notifyGfxContractSubscribers(listeners);
    const onResize = () => {
      if (host.state !== "ready") return;
      resizeCalls += 1;
      void host.resize(viewportFor(options.canvas, qualityProvider.getProfile())).then(notify).catch(() => undefined);
    };
    const resizeBinding = resizeBindingOwner = createGfxContractResizeBinding(window, onResize);
    const detachResize = () => resizeBinding.detach();
    const getSnapshot = (): Readonly<GfxFoundationSnapshot> => Object.freeze({
      generation: options.generation,
      planDigest,
      host: host.getSnapshot(),
      backendFacts: backend!.facts,
      backendLifecycle: backend!.snapshotLifecycle(),
      pipeline: pipeline.snapshot(),
      materials: materials.snapshot(),
      chunks: manager.snapshot(),
      uploader: uploader.snapshot(),
      logicalResources: resources.snapshotEvidence(),
      telemetry: telemetry.snapshot(),
      quality: qualityProvider.snapshot(),
      frameLoop: frameLoop.snapshot(),
      scene: sceneSnapshot(scene),
      heroA: oceanHero?.snapshot() ?? null,
      heroB: forestCityHero?.snapshot() ?? null,
      heroC: spaceTwinkleHero?.snapshot() ?? null,
      runtime: Object.freeze({
        resizeListenerActive: resizeBinding.active,
        resizeCalls,
        subscribers: listeners.size,
        disposeCalls,
      }),
      observedEvents: Object.freeze(observedEvents.slice()),
    });

    const disposal = createStableGfxContractOperation(async () => {
      disposeCalls += 1;
      const failures = [...await finalizeGfxContractRuntime(
        host,
        unsubscribeHost,
        detachResize,
        listeners,
      )];
      qualityProvider.dispose();
      scene.clear();
      telemetry.dispose();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw immutableGfxContractAggregate(failures, "GFX foundation runtime cleanup failed.");
      }
      return getSnapshot();
    });

    unsubscribeHost = host.subscribe(() => {
      if (host.state === "failed" || host.state === "disposed") {
        if (constructionComplete && !terminalCleanupScheduled) {
          terminalCleanupScheduled = true;
          void disposal.run().catch(() => undefined);
        }
        return;
      }
      notify();
    });

    const initialSnapshot = options.initialSnapshot
      ? assertProductionSnapshot(plan, options.initialSnapshot)
      : options.experience === "foundation"
        ? renderSnapshot(plan, INITIAL_CHUNK)
        : renderExperienceSnapshotAt(
          plan,
          options.initialStoryTime ?? defaultMarkerFor(options.experience),
          options.experience,
        );
    await host.initialize(initialSnapshot, initialViewport);
    assertFoundationHostReady(host, "initialization");
    resizeBinding.attach();
    assertFoundationHostReady(host, "resize listener binding");
    const currentViewport = viewportFor(options.canvas, qualityProvider.getProfile());
    if (await reconcileGfxContractViewport(initialViewport, currentViewport, (viewport) => host.resize(viewport))) {
      resizeCalls += 1;
    }
    assertFoundationHostReady(host, "viewport reconciliation");
    constructionComplete = true;
    let previousProductionSnapshot = options.initialSnapshot ?? null;
    const runtime: GfxFoundationRuntime = {
      getSnapshot,
      subscribe(listener) {
        if (disposal.active() || host.state === "disposed" || host.state === "failed") {
          return () => undefined;
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      update(snapshot) {
        const next = assertProductionSnapshot(plan, snapshot);
        const discontinuity = previousProductionSnapshot !== null
          && next.storyTime < previousProductionSnapshot.storyTime
          ? "restart-or-qa-seek" as const
          : undefined;
        host.setSnapshot(next, discontinuity);
        previousProductionSnapshot = next;
        notify();
      },
      seek(chunkId) {
        host.setSnapshot(renderSnapshot(plan, chunkId), "restart-or-qa-seek");
        notify();
      },
      seekTime(storyTime) {
        host.setSnapshot(
          renderExperienceSnapshotAt(plan, storyTime, options.experience),
          "restart-or-qa-seek",
        );
        notify();
      },
      async resize(width, height) {
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new RangeError("Foundation viewport dimensions must be positive finite numbers.");
        }
        const quality = qualityProvider.getProfile();
        await host.resize(Object.freeze({
          width: Math.max(1, Math.round(width)),
          height: Math.max(1, Math.round(height)),
          pixelRatio: Math.min(window.devicePixelRatio || 1, quality.pixelRatio),
        }));
        resizeCalls += 1;
        notify();
      },
      async setQuality(id) {
        const next = qualityProvider.profile(id);
        await host.setQuality(next);
        await host.resize(viewportFor(options.canvas, next));
        qualityProvider.commit(id);
        notify();
      },
      dispose: disposal.run,
      diagnostics: backend.diagnostics,
    };
    telemetryOwner = null;
    heroOwner = null;
    admission.transfer(constructionOwner);
    return runtime;
  } catch (error: unknown) {
    constructionFailurePresent = true;
    constructionFailure = error;
    try {
      await constructionOwner.dispose();
      admission.transfer(constructionOwner);
    } catch (cleanupError: unknown) {
      throw immutableFoundationCleanupFailure(
        [error, cleanupError],
        "GFX foundation construction and rollback failed.",
      );
    }
    throw immutableFoundationCleanupFailure(
      [error],
      "GFX foundation construction failed after clean rollback.",
    );
  }
}

export function createGfxFoundationRuntime(options: {
  readonly canvas: HTMLCanvasElement;
  readonly request: ThreeBackendRequest;
  readonly qa: boolean;
  readonly generation: number;
  readonly experience?: GfxFoundationExperience;
  readonly initialStoryTime?: number;
  readonly initialSnapshot?: Readonly<JourneyRenderSnapshot>;
}): Promise<GfxFoundationRuntime> {
  return foundationConstructionAdmission.run((admission) => (
    performGfxFoundationConstruction({
      ...options,
      experience: options.experience ?? "foundation",
    }, admission)
  ));
}
