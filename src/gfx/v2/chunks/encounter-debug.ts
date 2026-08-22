import type {
  WorldEncounterKind,
  WorldPlan,
  WorldPointMm,
} from "../../../world/v2/contracts";

export type EncounterDebugQuality = "high" | "fallback";

export interface EncounterDebugMarker {
  readonly id: string;
  readonly kind: WorldEncounterKind;
  readonly chunkId: string;
  readonly distanceMm: number;
  readonly centerOffsetMm: Readonly<{ readonly x: number; readonly y: number }>;
  readonly worldPoint: Readonly<WorldPointMm>;
  readonly collisionRadiusMm: number;
  readonly visibleRingRadiusMm: number;
  readonly safeRouteOffsetMm: Readonly<{ readonly x: number; readonly y: number }> | null;
}

/**
 * Renderer-neutral debug projection. Quality is accepted only so QA can prove
 * High/Fallback parity; it never participates in descriptor selection.
 */
export function projectEncounterDebugMarkers(
  plan: Readonly<WorldPlan>,
  quality: EncounterDebugQuality,
): readonly Readonly<EncounterDebugMarker>[] {
  void quality;
  return Object.freeze(plan.encounters.map((encounter) => Object.freeze({
    id: encounter.id,
    kind: encounter.kind,
    chunkId: encounter.chunkId,
    distanceMm: encounter.distanceMm,
    centerOffsetMm: Object.freeze({ ...encounter.centerOffsetMm }),
    worldPoint: Object.freeze({ ...encounter.worldPoint }),
    collisionRadiusMm: encounter.radii.collisionMm,
    visibleRingRadiusMm: encounter.radii.visibleRingMm,
    safeRouteOffsetMm: encounter.kind === "obstacle"
      ? Object.freeze({ ...encounter.safeRouteOffsetMm })
      : null,
  })));
}
