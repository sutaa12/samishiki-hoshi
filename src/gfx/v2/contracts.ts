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

export interface RenderBackendAdapter {
  readonly facts: Readonly<RenderBackendFacts>;
  initialize(context: BackendInitializationContext): Promise<void>;
  resize(viewport: RenderViewport): MaybePromise<void>;
  precompile(passes: readonly RenderPass[]): MaybePromise<void>;
  render(passes: readonly RenderPass[]): MaybePromise<void>;
  subscribeEvents(listener: (event: BackendRuntimeEvent) => void): Unsubscribe;
  snapshotResources(): Readonly<RenderResourceSnapshot>;
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
}

export interface RenderMaterialLibrary {
  initialize(context: RenderServiceInitializationContext): MaybePromise<void>;
  warmupPasses(): readonly RenderPass[];
  quality(profile: Readonly<RenderQualityProfile>): MaybePromise<void>;
  dispose(): MaybePromise<void>;
}

export interface RenderUploadQueue {
  initialize(context: RenderServiceInitializationContext): MaybePromise<void>;
  flush(clock: VisualClock): MaybePromise<void>;
  pendingCount(): number;
  dispose(): MaybePromise<void>;
}

export interface RenderResourceRegistry {
  initialize(context: RenderServiceInitializationContext): MaybePromise<void>;
  snapshot(): Readonly<RenderResourceSnapshot>;
  dispose(): MaybePromise<void>;
}

export interface RenderQualityProvider {
  getProfile(): Readonly<RenderQualityProfile>;
  subscribe(listener: (profile: Readonly<RenderQualityProfile>) => void): Unsubscribe;
}

export interface FeatureInitContext {
  readonly backend: RenderBackendAdapter;
  readonly materials: RenderMaterialLibrary;
  readonly uploads: RenderUploadQueue;
  readonly resources: RenderResourceRegistry;
  readonly observer: RenderEventObserver;
}

export interface RenderFeature {
  readonly id: string;
  initialize(context: FeatureInitContext): Promise<void>;
  update(frame: JourneyRenderSnapshot, clock: VisualClock): void;
  render(recorder: RenderPassRecorder): void;
  quality(profile: Readonly<RenderQualityProfile>): void;
  dispose(): Promise<void>;
}

export interface RenderHostDependencies {
  readonly backend: RenderBackendAdapter;
  readonly frameLoop: RenderFrameLoop;
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
  readonly counters: Readonly<RenderHostCounters>;
  readonly events: readonly RenderHostProbeEvent[];
  readonly error: Readonly<{
    code: string;
    message: string;
    lifecycle: RenderHostLifecycle;
  }> | null;
}
