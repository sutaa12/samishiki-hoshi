import type { CorridorOffsetMm } from "./rail-flight-state";
import { createWorldGenerationContext } from "../world/v2/seed-streams";
import type { WorldEncounterPlan, WorldPlan } from "../world/v2/contracts";
import { generateWorldPlan } from "../world/v2/world-plan";

export type RailEncounter = GateEncounter | ObstacleEncounter | LifeNodeEncounter;

interface RailEncounterBase {
  readonly id: string;
  readonly distanceMm: number;
  readonly center: CorridorOffsetMm;
}

export interface GateEncounter extends RailEncounterBase {
  readonly kind: "gate";
  readonly radiusMm: number;
}

export interface ObstacleEncounter extends RailEncounterBase {
  readonly kind: "obstacle";
  readonly hitRadiusMm: number;
  readonly nearMissRadiusMm: number;
}

export interface LifeNodeEncounter extends RailEncounterBase {
  readonly kind: "life-node";
  readonly perfectRadiusMm: number;
  readonly goodRadiusMm: number;
}

function freezeEncounter<T extends RailEncounter>(encounter: T): Readonly<T> {
  return Object.freeze({
    ...encounter,
    distanceMm: Math.max(0, Math.round(encounter.distanceMm)),
    center: Object.freeze({ x: Math.round(encounter.center.x), y: Math.round(encounter.center.y) }),
  }) as Readonly<T>;
}

function railEncounterFromWorld(descriptor: Readonly<WorldEncounterPlan>): Readonly<RailEncounter> {
  const common = {
    id: descriptor.id,
    kind: descriptor.kind,
    distanceMm: descriptor.distanceMm,
    center: descriptor.centerOffsetMm,
  } as const;
  if (descriptor.kind === "gate") {
    return freezeEncounter({ ...common, kind: "gate", radiusMm: descriptor.radii.collisionMm });
  }
  if (descriptor.kind === "obstacle") {
    return freezeEncounter({
      ...common,
      kind: "obstacle",
      hitRadiusMm: descriptor.radii.collisionMm,
      nearMissRadiusMm: descriptor.radii.visibleRingMm,
    });
  }
  return freezeEncounter({
    ...common,
    kind: "life-node",
    perfectRadiusMm: descriptor.radii.collisionMm,
    goodRadiusMm: descriptor.radii.visibleRingMm,
  });
}

export function railEncountersFromWorldPlan(
  plan: Readonly<WorldPlan>,
): readonly Readonly<RailEncounter>[] {
  return Object.freeze(plan.encounters.map(railEncounterFromWorld));
}

const ENCOUNTER_CACHE = new Map<number, readonly Readonly<RailEncounter>[]>();

export function railEncountersForSeed(seed: number): readonly Readonly<RailEncounter>[] {
  const canonicalSeed = seed >>> 0;
  const cached = ENCOUNTER_CACHE.get(canonicalSeed);
  if (cached) return cached;
  const encounters = railEncountersFromWorldPlan(generateWorldPlan(
    createWorldGenerationContext({ worldSeed: canonicalSeed }),
  ));
  if (ENCOUNTER_CACHE.size >= 32) ENCOUNTER_CACHE.delete(ENCOUNTER_CACHE.keys().next().value ?? canonicalSeed);
  ENCOUNTER_CACHE.set(canonicalSeed, encounters);
  return encounters;
}

/** Canonical seed-one compatibility fixture, generated from WorldPlan. */
export const DEFAULT_RAIL_ENCOUNTERS = railEncountersForSeed(1);

export function crossedEncounterPlane(previousDistanceMm: number, nextDistanceMm: number, encounterDistanceMm: number): boolean {
  return previousDistanceMm < encounterDistanceMm && nextDistanceMm >= encounterDistanceMm;
}

export function radialDistanceMm(offset: Readonly<CorridorOffsetMm>, center: Readonly<CorridorOffsetMm>): number {
  return Math.hypot(offset.x - center.x, offset.y - center.y);
}

export function distanceToEncounter3dMm(
  distanceMm: number,
  offset: Readonly<CorridorOffsetMm>,
  encounter: Readonly<RailEncounter>,
): number {
  return Math.hypot(distanceMm - encounter.distanceMm, radialDistanceMm(offset, encounter.center));
}

export function gateRadiusMm(gate: Readonly<GateEncounter>, assistNextGate: boolean): number {
  return Math.round(gate.radiusMm * (assistNextGate ? 1.5 : 1));
}

export function activeEncounterAt(
  distanceMm: number,
  resolvedIds: ReadonlySet<string>,
  encounters: readonly Readonly<RailEncounter>[] = DEFAULT_RAIL_ENCOUNTERS,
): Readonly<RailEncounter> | null {
  return encounters.find((encounter) => (
    !resolvedIds.has(encounter.id)
      && encounter.distanceMm >= distanceMm - 2_000
      && encounter.distanceMm <= distanceMm + 18_000
  )) ?? null;
}
