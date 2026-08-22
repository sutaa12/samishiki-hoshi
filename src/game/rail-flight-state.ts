import type { GameplayEvent } from "./gameplay-events";
import type { JourneyState } from "./model";

export const RAIL_FORWARD_SPEED_MM_PER_SECOND = 10_000;
export const RAIL_HIT_SPEED_MM_PER_SECOND = 5_500;
export const RAIL_HIT_SLOWDOWN_MS = 650;
export const PULSE_COOLDOWN_MS = 700;
export const CORRIDOR_SCALE_MM = 1_000;

export interface CorridorOffsetMm {
  readonly x: number;
  readonly y: number;
}

/** Canonical deterministic gameplay state for the seamless on-rails journey. */
export interface RailFlightState extends JourneyState {
  readonly score: number;
  readonly distanceMm: number;
  /** Fractional millimetres carried across slices; distanceMm remains canonical. */
  readonly distanceRemainderMm: number;
  readonly forwardSpeedMmPerSecond: number;
  readonly corridorOffset: CorridorOffsetMm;
  readonly lifeChain: number;
  /** Integer purity in the inclusive range 0..1000. */
  readonly flowPurity: number;
  readonly mistakes: number;
  readonly consecutiveMisses: number;
  readonly assistLevel: number;
  readonly assistNextGate: boolean;
  readonly pulseCooldownRemainingMs: number;
  readonly slowdownRemainingMs: number;
  readonly activeEncounterId: string | null;
  readonly activeEncounterKind: "gate" | "obstacle" | "life-node" | null;
  readonly activeEncounterDistanceMm: number | null;
  readonly passedEncounterIds: readonly string[];
  readonly activatedEncounterIds: readonly string[];
  readonly missedEncounterIds: readonly string[];
  readonly resolvedEncounterIds: readonly string[];
  readonly gameplayEvents: readonly Readonly<GameplayEvent>[];
}

export function corridorOffsetFromPosition(position: Readonly<{ x: number; y: number }>): CorridorOffsetMm {
  return Object.freeze({
    x: Math.round(position.x * CORRIDOR_SCALE_MM),
    y: Math.round(position.y * CORRIDOR_SCALE_MM),
  });
}

export function initialRailFlightFields(position: Readonly<{ x: number; y: number }>): Omit<
  RailFlightState,
  keyof JourneyState
> {
  return {
    score: 0,
    distanceMm: 0,
    distanceRemainderMm: 0,
    forwardSpeedMmPerSecond: RAIL_FORWARD_SPEED_MM_PER_SECOND,
    corridorOffset: corridorOffsetFromPosition(position),
    lifeChain: 0,
    flowPurity: 1_000,
    mistakes: 0,
    consecutiveMisses: 0,
    assistLevel: 0,
    assistNextGate: false,
    pulseCooldownRemainingMs: 0,
    slowdownRemainingMs: 0,
    activeEncounterId: null,
    activeEncounterKind: null,
    activeEncounterDistanceMm: null,
    passedEncounterIds: Object.freeze([]),
    activatedEncounterIds: Object.freeze([]),
    missedEncounterIds: Object.freeze([]),
    resolvedEncounterIds: Object.freeze([]),
    gameplayEvents: Object.freeze([]),
  };
}
