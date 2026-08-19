import type {
  JourneyRenderSnapshot,
  MaybePromise,
  RenderFeature,
  RenderHistoryInvalidationReason,
  RenderPass,
  RenderQualityProfile,
  RenderViewport,
  RendererApi,
  VisualClock,
} from "../contracts";

export const LINEAR_HDR_PIPELINE_PROFILE_IDS = Object.freeze([
  "webgpu-high-temporal",
  "webgpu-high-static",
  "webgpu-balanced-temporal",
  "webgpu-balanced-static",
  "webgpu-low-static",
  "webgl2-high-static",
  "webgl2-balanced-static",
  "webgl2-low-static",
] as const);

export type LinearHdrPipelineProfileId = (typeof LINEAR_HDR_PIPELINE_PROFILE_IDS)[number];

export const LINEAR_HDR_PASS_STAGES = Object.freeze([
  "depth-velocity",
  "opaque-pbr",
  "terrain",
  "vegetation",
  "water",
  "atmosphere",
  "cloud-fog",
  "transparent-twinkle",
  "temporal",
  "bloom-light-shaft",
  "tone-map-grade",
] as const);

export type LinearHdrPassStage = (typeof LINEAR_HDR_PASS_STAGES)[number];

export interface LinearHdrPipelineProfile {
  readonly id: LinearHdrPipelineProfileId;
  readonly actualApi: RendererApi;
  readonly tier: RenderQualityProfile["tier"];
  readonly temporal: boolean;
  readonly antiAliasing: "temporal" | "fxaa";
  readonly intermediateType: "half-float";
  readonly toneMapping: "aces-filmic";
  readonly outputColorSpace: "srgb";
  readonly outputTransformCount: 1;
}

/** Graph callbacks are one-way and must not call mutating APIs on their owning pipeline. */
export interface LinearHdrGraph {
  readonly profile: Readonly<LinearHdrPipelineProfile>;
  readonly passSignature: string;
  readonly depthOwned: true;
  readonly velocityOwned: boolean;
  readonly historyOwned: boolean;
  precompile(): Promise<number>;
  setHistoryWeight(weight: number): MaybePromise<void>;
  resize(viewport: Readonly<RenderViewport>): MaybePromise<void>;
  render(): MaybePromise<void>;
  dispose(): MaybePromise<void>;
}

export interface LinearHdrGraphFactoryContext {
  readonly renderer: unknown;
  readonly profile: Readonly<LinearHdrPipelineProfile>;
  /**
   * Compile-only material inventory. Graphs must compile these scenes against
   * their own target/MRT topology and each material against the persistent
   * runtime scene topology, then release every temporary pass/object. These
   * passes never participate in the persistent runtime pass graph.
   */
  readonly materialWarmupPasses: readonly Readonly<RenderPass>[];
  readonly passes: readonly Readonly<RenderPass>[];
  readonly passSignature: string;
  readonly viewport: Readonly<RenderViewport>;
}

export type LinearHdrGraphFactory = (
  context: Readonly<LinearHdrGraphFactoryContext>,
) => LinearHdrGraph;

/**
 * Internal backend seam; raw renderer ownership never crosses into RenderHost.
 * Port callbacks are one-way and must not call mutating APIs on their owning backend.
 */
export interface ThreeRenderPipelinePort {
  attachBackend(
    renderer: unknown,
    actualApi: "webgpu" | "webgl2",
    viewport: Readonly<RenderViewport>,
  ): MaybePromise<void>;
  resize(viewport: Readonly<RenderViewport>): MaybePromise<void>;
  precompile(passes: readonly Readonly<RenderPass>[]): Promise<void>;
  submit(passes: readonly Readonly<RenderPass>[]): MaybePromise<void>;
  dispose(): Promise<void>;
}

export interface LinearHdrPipelineSnapshot {
  readonly state: "new" | "attached" | "warming" | "ready" | "disposing" | "disposed" | "failed";
  readonly actualApi: RendererApi | null;
  readonly activeProfileId: LinearHdrPipelineProfileId | null;
  readonly warmedProfileIds: readonly LinearHdrPipelineProfileId[];
  readonly graphCount: number;
  readonly compileEvents: number;
  readonly compileEventsAtReady: number | null;
  readonly runtimeCompileEvents: number;
  readonly programCountAtReady: number | null;
  readonly programGrowthAfterReady: number;
  readonly outputTransformCount: 0 | 1;
  readonly intermediateType: "half-float";
  readonly depthOwned: boolean;
  readonly velocityOwned: boolean;
  readonly historyOwned: boolean;
  readonly historyGeneration: number;
  readonly historyValid: boolean;
  readonly pendingHistoryResets: readonly RenderHistoryInvalidationReason[];
  readonly historyResetCounts: Readonly<Record<RenderHistoryInvalidationReason, number>>;
  readonly disposedGraphs: number;
  /** Graphs still retained after an attempted cleanup failed. */
  readonly cleanupPendingGraphs: number;
}

export type LinearHdrPipelineFeature = RenderFeature & ThreeRenderPipelinePort & {
  readonly id: "gfx005-linear-hdr-pipeline";
  snapshot(): Readonly<LinearHdrPipelineSnapshot>;
  update(frame: JourneyRenderSnapshot, clock: VisualClock): void;
};

export interface CreateLinearHdrPipelineOptions {
  readonly graphFactory?: LinearHdrGraphFactory;
  readonly temporalHistoryWeight?: number;
}
