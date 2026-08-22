import type { CorridorOffsetMm } from "./rail-flight-state";

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

/** R3 graybox encounters. R3-004 will replace this list with WorldPlan output. */
export const DEFAULT_RAIL_ENCOUNTERS: readonly Readonly<RailEncounter>[] = Object.freeze([
  freezeEncounter({ id: "node-start", kind: "life-node", distanceMm: 0, center: { x: 0, y: 0 }, perfectRadiusMm: 2_500, goodRadiusMm: 10_000 }),
  freezeEncounter({ id: "node-replay-01128", kind: "life-node", distanceMm: 11_284, center: { x: 0, y: 0 }, perfectRadiusMm: 2_500, goodRadiusMm: 10_000 }),
  freezeEncounter({ id: "node-replay-05", kind: "life-node", distanceMm: 50_000, center: { x: 0, y: 0 }, perfectRadiusMm: 2_500, goodRadiusMm: 10_000 }),
  freezeEncounter({ id: "gate-life-01", kind: "gate", distanceMm: 80_000, center: { x: 700, y: 420 }, radiusMm: 340 }),
  freezeEncounter({ id: "obstacle-life-01", kind: "obstacle", distanceMm: 140_000, center: { x: 1_800, y: 1_800 }, hitRadiusMm: 260, nearMissRadiusMm: 520 }),
  freezeEncounter({ id: "gate-life-02", kind: "gate", distanceMm: 180_000, center: { x: -720, y: 340 }, radiusMm: 340 }),
  freezeEncounter({ id: "node-replay-24", kind: "life-node", distanceMm: 240_000, center: { x: 0, y: 0 }, perfectRadiusMm: 2_500, goodRadiusMm: 10_000 }),
  freezeEncounter({ id: "obstacle-life-02", kind: "obstacle", distanceMm: 280_000, center: { x: -1_800, y: 1_800 }, hitRadiusMm: 260, nearMissRadiusMm: 520 }),
  freezeEncounter({ id: "gate-life-03", kind: "gate", distanceMm: 320_000, center: { x: 680, y: -360 }, radiusMm: 340 }),
  freezeEncounter({ id: "node-phase-36", kind: "life-node", distanceMm: 360_000, center: { x: 0, y: 0 }, perfectRadiusMm: 2_500, goodRadiusMm: 10_000 }),
  freezeEncounter({ id: "node-replay-39", kind: "life-node", distanceMm: 390_000, center: { x: 0, y: 0 }, perfectRadiusMm: 2_500, goodRadiusMm: 10_000 }),
  freezeEncounter({ id: "node-production-484", kind: "life-node", distanceMm: 484_000, center: { x: 0, y: 0 }, perfectRadiusMm: 2_500, goodRadiusMm: 10_000 }),
  ...[880_000, 1_300_000, 1_610_000, 1_664_000, 1_710_000].map((distanceMm, index) => freezeEncounter({
    id: `node-phase-${index + 1}`,
    kind: "life-node" as const,
    distanceMm,
    center: { x: 0, y: 0 },
    perfectRadiusMm: 2_500,
    goodRadiusMm: 10_000,
  })),
].sort((left, right) => left.distanceMm - right.distanceMm || left.id.localeCompare(right.id)));

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
