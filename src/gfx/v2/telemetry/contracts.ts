import type {
  RenderHistoryInvalidationReason,
  RenderBackendFrameTelemetry,
  RendererApi,
  RenderQualityTier,
  RenderResourceSnapshot,
} from "../contracts";

export const GFX_TELEMETRY_FRAME_CAPACITY = 600;
export const GFX_TELEMETRY_MINIMUM_PERCENTILE_SAMPLES = 120;
export const GFX_TELEMETRY_EVENT_CAPACITY = 1_024;
export const GFX_TELEMETRY_RUNTIME_SPIKE_MS = 50;

export type GfxTelemetryLifecycle = "active" | "disposed";

export type GfxOperationalEventKind =
  | "initialization"
  | "compile"
  | "upload"
  | "activation"
  | "quality-change"
  | "history-reset";

export interface GfxFrameTelemetryInput {
  readonly frameId: number;
  readonly rafTimestampMs: number;
  readonly storyTime: number;
  readonly qualityTier: RenderQualityTier;
  readonly backendApi: RendererApi | null;
  readonly mainThreadWorkMs: number;
  readonly submitted: boolean;
  readonly passCount: number;
  readonly transparentPasses: number;
  readonly fullscreenPasses: number;
  readonly renderer: Readonly<RenderBackendFrameTelemetry>;
  readonly resources: Readonly<RenderResourceSnapshot>;
}

export interface GfxOperationalEventInput {
  readonly kind: GfxOperationalEventKind;
  readonly name: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly frameId: number | null;
  readonly storyTime: number | null;
  readonly success: boolean;
  /** True only when the operation runs after story time has begun. */
  readonly affectsStoryTime: boolean;
  readonly historyReason?: RenderHistoryInvalidationReason;
}

export interface GfxMetricPercentiles {
  readonly sampleCount: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

export interface GfxOperationalEventSnapshot extends GfxOperationalEventInput {
  readonly sequence: number;
  readonly exceedsRuntimeSpikeLimit: boolean;
}

export interface GfxLatestFrameSnapshot {
  readonly frameId: number;
  readonly rafTimestampMs: number;
  readonly frameIntervalMs: number | null;
  readonly storyTime: number;
  readonly qualityTier: RenderQualityTier;
  readonly backendApi: RendererApi | null;
  readonly mainThreadWorkMs: number;
  readonly submitted: boolean;
  readonly steadyState: boolean;
  readonly passCount: number;
  readonly transparentPasses: number;
  readonly fullscreenPasses: number;
  readonly renderer: Readonly<RenderBackendFrameTelemetry>;
  readonly resources: Readonly<RenderResourceSnapshot>;
}

export interface GfxPerformanceTelemetrySnapshot {
  readonly state: GfxTelemetryLifecycle;
  readonly window: Readonly<{
    capacity: typeof GFX_TELEMETRY_FRAME_CAPACITY;
    minimumPercentileSamples: typeof GFX_TELEMETRY_MINIMUM_PERCENTILE_SAMPLES;
    retainedFrames: number;
    steadyFrames: number;
    excludedOperationalFrames: number;
    totalFramesObserved: number;
  }>;
  readonly frameIntervalMs: Readonly<GfxMetricPercentiles>;
  readonly mainThreadWorkMs: Readonly<GfxMetricPercentiles>;
  readonly gpuTimeMs: Readonly<GfxMetricPercentiles>;
  readonly gpuTimingSupported: boolean;
  readonly latestFrame: Readonly<GfxLatestFrameSnapshot> | null;
  readonly events: readonly Readonly<GfxOperationalEventSnapshot>[];
  readonly eventTotals: Readonly<Record<GfxOperationalEventKind, number>>;
  readonly runtimeSpikesOver50Ms: number;
  readonly historyResetCounts: Readonly<Record<RenderHistoryInvalidationReason, number>>;
}

export interface GfxTelemetrySink {
  recordFrame(sample: Readonly<GfxFrameTelemetryInput>): void;
  recordOperation(event: Readonly<GfxOperationalEventInput>): void;
}

export interface GfxPerformanceTelemetry extends GfxTelemetrySink {
  snapshot(): Readonly<GfxPerformanceTelemetrySnapshot>;
  dispose(): void;
}
