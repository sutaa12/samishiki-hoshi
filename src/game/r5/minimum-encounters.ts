export type MinimumEncounterId = "ring" | "obstacle" | "node";

export type MinimumEncounter = Readonly<{
  id: MinimumEncounterId;
  distanceMm: number;
  xPermille: number;
}>;

export const MINIMUM_DURATION_MS = 15_000;
export const MINIMUM_SPEED_MM_PER_SECOND = 1_200;

export const MINIMUM_ENCOUNTERS: Readonly<Record<MinimumEncounterId, MinimumEncounter>> = Object.freeze({
  ring: Object.freeze({ id: "ring", distanceMm: 4_800, xPermille: -200 }),
  obstacle: Object.freeze({ id: "obstacle", distanceMm: 9_600, xPermille: 100 }),
  node: Object.freeze({ id: "node", distanceMm: 13_200, xPermille: 450 }),
});

export const MINIMUM_ENCOUNTER_ORDER = Object.freeze([
  MINIMUM_ENCOUNTERS.ring,
  MINIMUM_ENCOUNTERS.obstacle,
  MINIMUM_ENCOUNTERS.node,
]);
