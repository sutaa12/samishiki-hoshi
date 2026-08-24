export const MINIMUM_WORLD_UNITS_PER_MM = 1 / 450;
export const MINIMUM_PLAYER_Z = 1.5;
export const MINIMUM_NEAR_MARKER_SPACING_MM = 720;
export const MINIMUM_NEAR_MARKER_CYCLE_MM = MINIMUM_NEAR_MARKER_SPACING_MM * 12;
export const MINIMUM_NEAR_RECYCLE_BEHIND_MM = 3_600;
export const MINIMUM_FOV_CANDIDATES = Object.freeze([55, 62, 70] as const);

export type MinimumFovEvaluation = Readonly<{
  fovDegrees: number;
  objectReadability: number;
  flowContext: number;
  score: number;
}>;

export type ConveyorRailConfig = Readonly<{
  playerZ: number;
  worldUnitsPerMm: number;
}>;

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

export function evaluateMinimumFov(fovDegrees: number): MinimumFovEvaluation {
  const objectReadability = Math.max(0, 1 - Math.abs(fovDegrees - 62) / 15);
  const flowContext = Math.max(0, 1 - Math.abs(fovDegrees - 64) / 22);
  return Object.freeze({
    fovDegrees,
    objectReadability,
    flowContext,
    score: objectReadability * 0.65 + flowContext * 0.35,
  });
}

export const MINIMUM_FOV_EVALUATIONS = Object.freeze(
  MINIMUM_FOV_CANDIDATES.map(evaluateMinimumFov),
);

export const MINIMUM_SELECTED_FOV = MINIMUM_FOV_EVALUATIONS.reduce(
  (best, candidate) => candidate.score > best.score ? candidate : best,
).fovDegrees;

export class ConveyorRail {
  readonly playerZ: number;
  readonly worldUnitsPerMm: number;

  constructor(config: ConveyorRailConfig = {
    playerZ: MINIMUM_PLAYER_Z,
    worldUnitsPerMm: MINIMUM_WORLD_UNITS_PER_MM,
  }) {
    this.playerZ = config.playerZ;
    this.worldUnitsPerMm = config.worldUnitsPerMm;
  }

  relativeDistanceMm(anchorDistanceMm: number, travelledDistanceMm: number): number {
    return anchorDistanceMm - travelledDistanceMm;
  }

  zAt(anchorDistanceMm: number, travelledDistanceMm: number): number {
    return this.playerZ - this.relativeDistanceMm(anchorDistanceMm, travelledDistanceMm) * this.worldUnitsPerMm;
  }

  repeatedRelativeDistanceMm(
    anchorDistanceMm: number,
    travelledDistanceMm: number,
    cycleDistanceMm: number,
    recycleBehindMm: number,
  ): number {
    if (cycleDistanceMm <= 0) throw new RangeError("cycleDistanceMm must be positive");
    if (recycleBehindMm < 0 || recycleBehindMm >= cycleDistanceMm) {
      throw new RangeError("recycleBehindMm must be within the rail cycle");
    }
    return positiveModulo(
      this.relativeDistanceMm(anchorDistanceMm, travelledDistanceMm) + recycleBehindMm,
      cycleDistanceMm,
    ) - recycleBehindMm;
  }

  repeatedZAt(
    anchorDistanceMm: number,
    travelledDistanceMm: number,
    cycleDistanceMm: number,
    recycleBehindMm: number,
  ): number {
    return this.playerZ - this.repeatedRelativeDistanceMm(
      anchorDistanceMm,
      travelledDistanceMm,
      cycleDistanceMm,
      recycleBehindMm,
    ) * this.worldUnitsPerMm;
  }

  passIndex(travelledDistanceMm: number, spacingMm: number, firstPassDistanceMm: number): number {
    return Math.floor((travelledDistanceMm - firstPassDistanceMm) / spacingMm) + 1;
  }

  passIntervalMs(spacingMm: number, speedMmPerSecond: number): number {
    if (speedMmPerSecond <= 0) throw new RangeError("speedMmPerSecond must be positive");
    return (spacingMm / speedMmPerSecond) * 1_000;
  }
}
