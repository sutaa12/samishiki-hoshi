import type { QualityLevel } from "../../../game/model";
import type { ThreeBackendAdapter, ThreeBackendRequest } from "../backend/backend-adapter";
import type { JourneyRenderSnapshot, Unsubscribe } from "../contracts";
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

export function productionQualityId(quality: QualityLevel): FoundationQualityId {
  return PRODUCTION_QUALITY_IDS[quality];
}

export interface ProductionGfxRuntime {
  update(snapshot: Readonly<JourneyRenderSnapshot>): void;
  setQuality(quality: QualityLevel): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  getSnapshot(): Readonly<GfxFoundationSnapshot>;
  getJourneySnapshot(): Readonly<JourneyRenderSnapshot>;
  getTelemetry(): Readonly<GfxPerformanceTelemetrySnapshot>;
  subscribe(listener: () => void): Unsubscribe;
  dispose(): Promise<Readonly<GfxFoundationSnapshot>>;
  readonly diagnostics: ThreeBackendAdapter["diagnostics"];
}

class ProductionJourneyRuntime implements ProductionGfxRuntime {
  readonly #foundation: GfxFoundationRuntime;
  #journey: Readonly<JourneyRenderSnapshot>;

  constructor(
    foundation: GfxFoundationRuntime,
    initialSnapshot: Readonly<JourneyRenderSnapshot>,
  ) {
    this.#foundation = foundation;
    this.#journey = copyJourneySnapshot(initialSnapshot);
  }

  get diagnostics(): ThreeBackendAdapter["diagnostics"] {
    return this.#foundation.diagnostics;
  }

  update(snapshot: Readonly<JourneyRenderSnapshot>): void {
    const next = copyJourneySnapshot(snapshot);
    this.#foundation.update(next);
    this.#journey = next;
  }

  setQuality(quality: QualityLevel): Promise<void> {
    return this.#foundation.setQuality(productionQualityId(quality));
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

  getTelemetry(): Readonly<GfxPerformanceTelemetrySnapshot> {
    return this.#foundation.getSnapshot().telemetry;
  }

  subscribe(listener: () => void): Unsubscribe {
    return this.#foundation.subscribe(listener);
  }

  dispose(): Promise<Readonly<GfxFoundationSnapshot>> {
    return this.#foundation.dispose();
  }
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

export async function createProductionJourneyRuntime(options: {
  readonly canvas: HTMLCanvasElement;
  readonly request: ThreeBackendRequest;
  readonly qa: boolean;
  readonly generation: number;
  readonly quality: QualityLevel;
  readonly initialSnapshot: Readonly<JourneyRenderSnapshot>;
}): Promise<ProductionGfxRuntime> {
  const foundation = await createGfxFoundationRuntime({
    canvas: options.canvas,
    request: options.request,
    qa: options.qa,
    generation: options.generation,
    experience: "foundation",
    initialSnapshot: options.initialSnapshot,
  });
  try {
    await foundation.setQuality(productionQualityId(options.quality));
    return new ProductionJourneyRuntime(foundation, options.initialSnapshot);
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
