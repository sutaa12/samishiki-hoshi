import type { JourneyPhase } from "./model";

export type GameplayEventKind =
  | "gate-pass"
  | "gate-miss"
  | "obstacle-hit"
  | "obstacle-near-miss"
  | "node-perfect"
  | "node-good"
  | "node-miss"
  | "assist-next-gate"
  | "pulse-empty"
  | "pulse-cooldown";

/** Immutable, replay-safe event emitted once for one resolved interaction. */
export interface GameplayEvent {
  readonly id: number;
  readonly kind: GameplayEventKind;
  readonly encounterId: string | null;
  readonly journeyTime: number;
  readonly distanceMm: number;
  readonly phase: JourneyPhase;
  readonly scoreDelta: number;
}

export function gameplayEvent(options: Omit<GameplayEvent, "journeyTime"> & {
  readonly journeyTime: number;
}): Readonly<GameplayEvent> {
  return Object.freeze({
    id: options.id,
    kind: options.kind,
    encounterId: options.encounterId,
    journeyTime: Number(options.journeyTime.toFixed(6)),
    distanceMm: Math.max(0, Math.round(options.distanceMm)),
    phase: options.phase,
    scoreDelta: Math.round(options.scoreDelta),
  });
}
