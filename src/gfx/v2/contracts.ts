import type { JourneyPhase } from "../../game/model";

export type MaybePromise<T> = T | Promise<T>;
export type Unsubscribe = () => void;

export type RenderHostLifecycle =
  | "new"
  | "initializing"
  | "ready"
  | "disposing"
  | "disposed"
  | "failed";

export type RendererApi = "WebGPU" | "WebGL2";
export type RenderQualityTier = "low" | "balanced" | "high";

export interface RenderViewport {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

export interface RenderPositionSnapshot {
  readonly x: number;
  readonly y: number;
}

export interface RenderTwinkleSeedSnapshot {
  readonly id: number;
  readonly journeyTime: number;
  readonly x: number;
  readonly y: number;
  readonly phase: JourneyPhase;
  readonly source: "player";
  readonly value: number;
}

/**
 * Renderer-only projection of game state. The host copies and recursively
 * freezes every snapshot before a feature can observe it.
 */
export interface JourneyRenderSnapshot {
  readonly seed: number;
  readonly storyTime: number;
  readonly phase: JourneyPhase;
  readonly shotId: string;
  readonly position: RenderPositionSnapshot;
  readonly velocity: RenderPositionSnapshot;
  readonly pulses: readonly RenderTwinkleSeedSnapshot[];
  readonly answerAt: number | null;
  readonly finished: boolean;
}

export interface VisualClock {
  readonly frame: number;
  readonly nowMs: number;
  readonly deltaSeconds: number;
  readonly elapsedSeconds: number;
}

/**
 * Frame-latched clock for operations that must correlate with journey state.
 * `elapsedSeconds` is monotonic visual/runtime time; `storyTime` is copied from
 * the canonical render snapshot and may pause, seek, or restart independently.
 */
export interface RenderOperationClock extends VisualClock {
  readonly storyTime: number;
}

export interface RenderQualityProfile {
  readonly tier: RenderQualityTier;
  readonly pixelRatio: number;
  readonly uploadBudgetMs: number;
  readonly features: Readonly<Record<string, boolean | number | string>>;
}

export interface RenderBackendFacts {
  readonly requestedApi: RendererApi;
  readonly actualApi: RendererApi | null;
  readonly adapter: string | null;
  readonly device: string | null;
  readonly fallback: boolean;
}

export interface RenderResourceSnapshot {
  readonly geometries: number;
  readonly textures: number;
  readonly renderTargets: number;
  readonly programs: number;
  readonly nodes: number;
  readonly objects: number;
  readonly subscribers: number;
  readonly pendingUploads: number;
}

/** Backend-owned, frame-local counters. Null means the backend cannot observe the metric. */
export interface RenderBackendFrameTelemetry {
  readonly available: boolean;
  readonly drawCalls: number | null;
  readonly triangles: number | null;
  readonly lines: number | null;
  readonly points: number | null;
  readonly pixelRatio: number | null;
  readonly drawingBufferWidth: number | null;
  readonly drawingBufferHeight: number | null;
  readonly gpuTimeMs: number | null;
}

export type BackendRuntimeEventKind = "renderer-error" | "device-lost";

export interface BackendRuntimeEvent {
  readonly kind: BackendRuntimeEventKind;
  readonly error: unknown;
  readonly occurredAtMs: number;
}

/**
 * Backend-neutral render command. Scene and camera are deliberately opaque;
 * only a backend adapter may interpret them as renderer-specific objects.
 */
export interface RenderPass {
  readonly name: string;
  readonly kind: string;
  /** Distinguishes warm-up variants that intentionally share a pass name. */
  readonly variant?: string;
  readonly scene?: unknown;
  readonly camera?: unknown;
  readonly payload?: unknown;
}

export interface RenderPassRecorder {
  readonly passes: readonly RenderPass[];
  record(pass: RenderPass): void;
  draw(name: string, scene: unknown, camera: unknown, kind?: string): void;
}

export interface BackendInitializationContext {
  readonly viewport: RenderViewport;
}

export const RENDER_COMPILE_PHASES = Object.freeze([
  "runtime-object",
  "material-isolated",
  "material-runtime-topology",
  "output-first-use",
] as const);

export type RenderCompileStepPhase = (typeof RENDER_COMPILE_PHASES)[number];

/** Bounded internal tokens only; caller-authored labels never enter telemetry. */
export interface RenderCompileStepDescriptor {
  readonly id: string;
  readonly phase: RenderCompileStepPhase;
  readonly profileId: string | null;
}

export interface RenderCompileStepRunner {
  run(
    descriptor: Readonly<RenderCompileStepDescriptor>,
    operation: () => MaybePromise<void>,
  ): Promise<void>;
}

export interface RenderPrecompileReceipt {
  readonly plannedSteps: number;
  readonly completedSteps: number;
  readonly phaseCounts: Readonly<Record<RenderCompileStepPhase, number>>;
}

export interface RenderWarmupScheduler {
  /** Waits for a newly initialized renderer context before measured work begins. */
  settleBeforeWarmup(): Promise<void>;
  yieldToMain(): Promise<void>;
}

export interface RenderBackendAdapter {
  readonly facts: Readonly<RenderBackendFacts>;
  initialize(context: BackendInitializationContext): Promise<void>;
  resize(viewport: RenderViewport): MaybePromise<void>;
  precompile(
    passes: readonly RenderPass[],
    runner: RenderCompileStepRunner,
  ): Promise<Readonly<RenderPrecompileReceipt>>;
  render(passes: readonly RenderPass[]): MaybePromise<void>;
  subscribeEvents(listener: (event: BackendRuntimeEvent) => void): Unsubscribe;
  snapshotResources(): Readonly<RenderResourceSnapshot>;
  snapshotFrameTelemetry?(): Readonly<RenderBackendFrameTelemetry>;
  dispose(): Promise<void>;
}

export interface RenderFrameLoop {
  readonly running: boolean;
  start(callback: (nowMs: number) => void): void;
  stop(): void;
}

export interface RenderEventObserver {
  observe(event: RenderHostEvent): void;
}

export type RenderHostEvent =
  | {
      readonly kind: "lifecycle";
      readonly from: RenderHostLifecycle;
      readonly to: RenderHostLifecycle;
    }
  | {
      readonly kind: "backend-event";
      readonly event: BackendRuntimeEvent;
    }
  | {
      readonly kind: "frame-error" | "initialization-error" | "disposal-error";
      readonly error: unknown;
    };

export interface RenderServiceInitializationContext {
  readonly backend: RenderBackendAdapter;
  readonly observer: RenderEventObserver;
  readonly viewport: Readonly<RenderViewport>;
}

export const RENDER_HISTORY_INVALIDATION_REASONS = Object.freeze([
  "initialization",
  "resize",
  "backend-change",
  "quality-change",
  "restart-or-qa-seek",
  "camera-discontinuity",
  "story-cut-s21",
  "story-cut-s23",
  "final-life-light",
] as const);

export type RenderHistoryInvalidationReason =
  (typeof RENDER_HISTORY_INVALIDATION_REASONS)[number];

export interface RenderHistoryInvalidation {
  readonly reason: RenderHistoryInvalidationReason;
  readonly previousShotId: string | null;
  readonly nextShotId: string;
  readonly storyTime: number;
}

export interface RenderMaterialLibrary {
  initialize(context: RenderServiceInitializationContext): MaybePromise<void>;
  warmupPasses(profiles?: readonly Readonly<RenderQualityProfile>[]): readonly RenderPass[];
  quality(profile: Readonly<RenderQualityProfile>): MaybePromise<void>;
  dispose(): MaybePromise<void>;
}

export interface RenderUploadQueue {
  initialize(context: RenderServiceInitializationContext): MaybePromise<void>;
  quality?(profile: Readonly<RenderQualityProfile>): MaybePromise<void>;
  flush(
    clock: RenderOperationClock,
    profile?: Readonly<RenderQualityProfile>,
  ): MaybePromise<void>;
  pendingCount(): number;
  dispose(): MaybePromise<void>;
}

export interface RenderLogicalResourceOwnership {
  readonly ownerId: string;
  readonly geometries: number;
  readonly textures: number;
  readonly renderTargets: number;
  readonly nodes: number;
  readonly objects: number;
  readonly bytes: number;
}

export interface RenderResourceRegistry {
  initialize(context: RenderServiceInitializationContext): MaybePromise<void>;
  adopt?(ownership: Readonly<RenderLogicalResourceOwnership>): MaybePromise<void>;
  releaseOwner?(ownerId: string): MaybePromise<void>;
  snapshot(): Readonly<RenderResourceSnapshot>;
  dispose(): MaybePromise<void>;
}

export interface RenderQualityProvider {
  getProfile(): Readonly<RenderQualityProfile>;
  getWarmupProfiles?(): readonly Readonly<RenderQualityProfile>[];
  subscribe(listener: (profile: Readonly<RenderQualityProfile>) => void): Unsubscribe;
}

export interface FeatureInitContext {
  readonly backend: RenderBackendAdapter;
  readonly materials: RenderMaterialLibrary;
  readonly uploads: RenderUploadQueue;
  readonly resources: RenderResourceRegistry;
  readonly observer: RenderEventObserver;
  readonly viewport: Readonly<RenderViewport>;
}

export interface RenderFeature {
  readonly id: string;
  initialize(context: FeatureInitContext): Promise<void>;
  warmupPasses?(profiles: readonly Readonly<RenderQualityProfile>[]): readonly RenderPass[];
  update(frame: JourneyRenderSnapshot, clock: RenderOperationClock): void;
  render(recorder: RenderPassRecorder): void;
  quality(profile: Readonly<RenderQualityProfile>): void;
  resize?(viewport: Readonly<RenderViewport>): MaybePromise<void>;
  invalidateHistory?(event: Readonly<RenderHistoryInvalidation>): void;
  dispose(): Promise<void>;
}

export interface RenderHostDependencies {
  /**
   * Dependency callbacks form a one-way boundary into RenderHost. They must
   * never call a public RenderHost method, either synchronously or after an
   * await. RenderHost rejects synchronous violations; asynchronous reentry is
   * outside the dependency contract and is prevented by composition tests.
   */
  readonly backend: RenderBackendAdapter;
  readonly frameLoop: RenderFrameLoop;
  readonly warmupScheduler: RenderWarmupScheduler;
  readonly features: readonly RenderFeature[];
  readonly materials: RenderMaterialLibrary;
  readonly uploads: RenderUploadQueue;
  readonly resources: RenderResourceRegistry;
  readonly qualityProvider: RenderQualityProvider;
  readonly observer: RenderEventObserver;
}

export interface RenderHostProbeEvent {
  readonly id: number;
  readonly kind: RenderHostEvent["kind"];
  readonly detail: string;
}

export interface RenderHostCounters {
  readonly frameCallbacks: number;
  readonly submittedFrames: number;
  readonly droppedFrames: number;
  readonly backendEvents: number;
  readonly failures: number;
  readonly probeSubscribers: number;
  readonly pendingControlOperations: number;
  /** Unique raw-fault occurrences tracked, weakly for objects, while terminal evidence is assembled. */
  readonly retainedRawFailureCauses: number;
  /** Temporary safe failure references retained by cleanup staging and coordination. */
  readonly retainedIntermediateFailureSnapshots: number;
}

/** JSON-safe diagnostics for QA routes and evidence capture. */
export interface RenderHostProbeSnapshot {
  readonly lifecycle: RenderHostLifecycle;
  readonly loopRunning: boolean;
  readonly qualityTier: RenderQualityTier | null;
  readonly journey: Readonly<{
    seed: number;
    storyTime: number;
    shotId: string;
  }> | null;
  readonly backend: Readonly<RenderBackendFacts>;
  readonly resources: Readonly<RenderResourceSnapshot>;
  readonly compileWarmup: Readonly<{
    planned: number;
    started: number;
    completed: number;
    failed: number;
    timingComplete: boolean;
    maxDuration: number | null;
    overBudget: number;
    budgetStatus: "pending" | "pass" | "fail" | "unmeasured";
    phaseCounts: Readonly<Record<RenderCompileStepPhase, number>>;
  }>;
  readonly counters: Readonly<RenderHostCounters>;
  readonly events: readonly RenderHostProbeEvent[];
  readonly error: Readonly<{
    code: string;
    message: string;
    lifecycle: RenderHostLifecycle;
  }> | null;
}
