import type { QualityLevel } from "../../../game/model";
import type { ThreeBackendAdapter, ThreeBackendRequest } from "../backend/backend-adapter";
import type { JourneyRenderSnapshot, RailRenderSnapshot, Unsubscribe } from "../contracts";
import type { GfxPerformanceTelemetrySnapshot } from "../telemetry";
import {
  createGfxFoundationRuntime,
  type FoundationQualityId,
  type GfxFoundationRuntime,
  type GfxFoundationSnapshot,
} from "./foundation-runtime";

const PRODUCTION_QUALITY_IDS: Readonly<Record<QualityLevel, FoundationQualityId>> = Object.freeze({
  low: "low-static",
  balanced: "balanced-temporal",
  high: "high-temporal",
});

const PRODUCTION_REDUCED_MOTION_QUALITY_IDS: Readonly<Record<QualityLevel, FoundationQualityId>> = Object.freeze({
  low: "low-static",
  balanced: "balanced-static",
  high: "high-static",
});

export interface ProductionPresentationPreferences {
  readonly quality: QualityLevel;
  readonly reducedMotion: boolean;
  readonly highContrast: boolean;
  readonly colorIndependentCues: true;
}

export function productionQualityId(
  quality: QualityLevel,
  reducedMotion = false,
): FoundationQualityId {
  return (reducedMotion ? PRODUCTION_REDUCED_MOTION_QUALITY_IDS : PRODUCTION_QUALITY_IDS)[quality];
}

export interface ProductionGfxRuntime {
  update(snapshot: Readonly<JourneyRenderSnapshot>, rail: Readonly<RailRenderSnapshot>): void;
  setQuality(quality: QualityLevel): Promise<void>;
  configurePresentation(preferences: Readonly<ProductionPresentationPreferences>): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  getSnapshot(): Readonly<GfxFoundationSnapshot>;
  getJourneySnapshot(): Readonly<JourneyRenderSnapshot>;
  getRailSnapshot(): Readonly<RailRenderSnapshot>;
  getPresentation(): Readonly<ProductionPresentationPreferences>;
  getTelemetry(): Readonly<GfxPerformanceTelemetrySnapshot>;
  subscribe(listener: () => void): Unsubscribe;
  dispose(): Promise<Readonly<GfxFoundationSnapshot>>;
  readonly diagnostics: ThreeBackendAdapter["diagnostics"];
}

class ProductionJourneyRuntime implements ProductionGfxRuntime {
  readonly #foundation: GfxFoundationRuntime;
  readonly #canvas: HTMLCanvasElement;
  readonly #initialCanvasFilter: string;
  #journey: Readonly<JourneyRenderSnapshot>;
  #rail: Readonly<RailRenderSnapshot>;
  #presentation: Readonly<ProductionPresentationPreferences>;
  #presentationTail: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(
    foundation: GfxFoundationRuntime,
    canvas: HTMLCanvasElement,
    initialSnapshot: Readonly<JourneyRenderSnapshot>,
    initialRailSnapshot: Readonly<RailRenderSnapshot>,
    initialPresentation: Readonly<ProductionPresentationPreferences>,
  ) {
    this.#foundation = foundation;
    this.#canvas = canvas;
    this.#initialCanvasFilter = canvas.style.filter;
    this.#journey = copyJourneySnapshot(initialSnapshot);
    this.#rail = copyRailSnapshot(initialRailSnapshot);
    this.#presentation = copyPresentationPreferences(initialPresentation);
    this.#applyJourneyDataset();
    this.#applyCanvasPresentation(this.#presentation);
  }

  get diagnostics(): ThreeBackendAdapter["diagnostics"] {
    return this.#foundation.diagnostics;
  }

  update(snapshot: Readonly<JourneyRenderSnapshot>, rail: Readonly<RailRenderSnapshot>): void {
    const next = copyJourneySnapshot(snapshot);
    const nextRail = copyRailSnapshot(rail);
    this.#foundation.update(next, nextRail);
    this.#journey = next;
    this.#rail = nextRail;
    this.#applyJourneyDataset();
  }

  setQuality(quality: QualityLevel): Promise<void> {
    return this.configurePresentation(Object.freeze({ ...this.#presentation, quality }));
  }

  configurePresentation(
    preferences: Readonly<ProductionPresentationPreferences>,
  ): Promise<void> {
    const next = copyPresentationPreferences(preferences);
    const operation = this.#presentationTail.then(async () => {
      if (this.#disposed) throw new Error("Cannot configure a disposed Production renderer.");
      await this.#foundation.setQuality(productionQualityId(next.quality, next.reducedMotion));
      this.#foundation.setReducedMotion(next.reducedMotion);
      this.#presentation = next;
      this.#applyCanvasPresentation(next);
    });
    this.#presentationTail = operation.catch(() => undefined);
    return operation;
  }

  resize(width: number, height: number): Promise<void> {
    return this.#foundation.resize(width, height);
  }

  getSnapshot(): Readonly<GfxFoundationSnapshot> {
    return this.#foundation.getSnapshot();
  }

  getJourneySnapshot(): Readonly<JourneyRenderSnapshot> {
    return this.#journey;
  }

  getRailSnapshot(): Readonly<RailRenderSnapshot> {
    return this.#rail;
  }

  getPresentation(): Readonly<ProductionPresentationPreferences> {
    return this.#presentation;
  }

  getTelemetry(): Readonly<GfxPerformanceTelemetrySnapshot> {
    return this.#foundation.getSnapshot().telemetry;
  }

  subscribe(listener: () => void): Unsubscribe {
    return this.#foundation.subscribe(listener);
  }

  async dispose(): Promise<Readonly<GfxFoundationSnapshot>> {
    this.#disposed = true;
    await this.#presentationTail.catch(() => undefined);
    this.#canvas.style.filter = this.#initialCanvasFilter;
    delete this.#canvas.dataset.renderContrast;
    delete this.#canvas.dataset.renderMotion;
    delete this.#canvas.dataset.renderStoryTimeExact;
    delete this.#canvas.dataset.renderDistanceMm;
    return this.#foundation.dispose();
  }

  #applyCanvasPresentation(preferences: Readonly<ProductionPresentationPreferences>): void {
    const accessibilityFilter = preferences.highContrast
      ? "contrast(1.2) saturate(0.92)"
      : "";
    this.#canvas.style.filter = [this.#initialCanvasFilter, accessibilityFilter]
      .filter(Boolean)
      .join(" ");
    this.#canvas.dataset.renderContrast = preferences.highContrast ? "high" : "standard";
    this.#canvas.dataset.renderMotion = preferences.reducedMotion ? "reduced" : "full";
  }

  #applyJourneyDataset(): void {
    this.#canvas.dataset.renderStoryTimeExact = this.#journey.storyTime.toFixed(6);
    this.#canvas.dataset.renderDistanceMm = String(this.#rail.distanceMm);
  }
}

function copyPresentationPreferences(
  preferences: Readonly<ProductionPresentationPreferences>,
): Readonly<ProductionPresentationPreferences> {
  return Object.freeze({
    quality: preferences.quality,
    reducedMotion: Boolean(preferences.reducedMotion),
    highContrast: Boolean(preferences.highContrast),
    colorIndependentCues: true,
  });
}

function copyJourneySnapshot(
  snapshot: Readonly<JourneyRenderSnapshot>,
): Readonly<JourneyRenderSnapshot> {
  return Object.freeze({
    seed: snapshot.seed,
    storyTime: snapshot.storyTime,
    phase: snapshot.phase,
    shotId: snapshot.shotId,
    position: Object.freeze({ x: snapshot.position.x, y: snapshot.position.y }),
    velocity: Object.freeze({ x: snapshot.velocity.x, y: snapshot.velocity.y }),
    pulses: Object.freeze(snapshot.pulses.map((pulse) => Object.freeze({ ...pulse }))),
    answerAt: snapshot.answerAt,
    finished: snapshot.finished,
  });
}

function copyRailSnapshot(
  snapshot: Readonly<RailRenderSnapshot>,
): Readonly<RailRenderSnapshot> {
  return Object.freeze({
    distanceMm: snapshot.distanceMm === 0 ? 0 : snapshot.distanceMm,
    forwardSpeedMmPerSecond: snapshot.forwardSpeedMmPerSecond === 0
      ? 0
      : snapshot.forwardSpeedMmPerSecond,
    corridorOffset: Object.freeze({
      x: snapshot.corridorOffset.x === 0 ? 0 : snapshot.corridorOffset.x,
      y: snapshot.corridorOffset.y === 0 ? 0 : snapshot.corridorOffset.y,
    }),
  });
}

export async function createProductionJourneyRuntime(options: {
  readonly canvas: HTMLCanvasElement;
  readonly request: ThreeBackendRequest;
  readonly qa: boolean;
  readonly generation: number;
  readonly presentation: Readonly<ProductionPresentationPreferences>;
  readonly initialSnapshot: Readonly<JourneyRenderSnapshot>;
  readonly initialRailSnapshot: Readonly<RailRenderSnapshot>;
}): Promise<ProductionGfxRuntime> {
  const foundation = await createGfxFoundationRuntime({
    canvas: options.canvas,
    request: options.request,
    qa: options.qa,
    generation: options.generation,
    experience: "foundation",
    initialSnapshot: options.initialSnapshot,
    initialRailSnapshot: options.initialRailSnapshot,
    reducedMotion: options.presentation.reducedMotion,
  });
  try {
    const presentation = copyPresentationPreferences(options.presentation);
    await foundation.setQuality(productionQualityId(presentation.quality, presentation.reducedMotion));
    return new ProductionJourneyRuntime(
      foundation,
      options.canvas,
      options.initialSnapshot,
      options.initialRailSnapshot,
      presentation,
    );
  } catch (error: unknown) {
    try {
      await foundation.dispose();
    } catch {
      // Preserve the construction error. The underlying runtime retains its
      // own structured cleanup evidence when disposal also fails.
    }
    throw error;
  }
}
