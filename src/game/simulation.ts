import {
  JOURNEY_SECONDS,
  type NormalizedInput,
  type QualityLevel,
  type TimedInput,
  type TwinkleSeed,
  type Vec2,
  normalizeInput,
  phaseAt,
} from "./model";
import {
  DEFAULT_RAIL_ENCOUNTERS,
  activeEncounterAt,
  crossedEncounterPlane,
  distanceToEncounter3dMm,
  gateRadiusMm,
  type GateEncounter,
  type LifeNodeEncounter,
  type ObstacleEncounter,
  type RailEncounter,
} from "./encounter-system";
import { gameplayEvent, type GameplayEventKind } from "./gameplay-events";
import {
  PULSE_COOLDOWN_MS,
  RAIL_FORWARD_SPEED_MM_PER_SECOND,
  RAIL_HIT_SLOWDOWN_MS,
  RAIL_HIT_SPEED_MM_PER_SECOND,
  corridorOffsetFromPosition,
  initialRailFlightFields,
  type RailFlightState,
} from "./rail-flight-state";
import { flowAt, mixSeed, validateRoutes } from "./procedural";

const STEP_SECONDS = 1 / 60;
const PLAYER_SPEED = 0.54;
const FLOW_SPEED = 0.24;
const PLAYABLE_BOUND = 0.94;

export interface SimulationOptions {
  seed?: number;
  /** Accepted for render callers, deliberately excluded from all state and hashes. */
  quality?: QualityLevel;
  /** Explicit graybox encounters; R3-004 will provide WorldPlan-derived data. */
  encounters?: readonly Readonly<RailEncounter>[];
}

export function createJourneyState(options: SimulationOptions = {}): RailFlightState {
  const position = Object.freeze({ x: 0, y: -0.72 });
  return {
    seed: (options.seed ?? 1) >>> 0,
    time: 0,
    position,
    velocity: Object.freeze({ x: 0, y: 0 }),
    pulses: Object.freeze([]),
    answerAt: null,
    finished: false,
    ...initialRailFlightFields(position),
  };
}

function clampPlane(point: Vec2): Vec2 {
  return Object.freeze({
    x: Math.max(-PLAYABLE_BOUND, Math.min(PLAYABLE_BOUND, point.x)),
    y: Math.max(-PLAYABLE_BOUND, Math.min(PLAYABLE_BOUND, point.y)),
  });
}

function seedForPulse(state: RailFlightState, id: number): number {
  const timeBits = Math.round(state.time * 1000) >>> 0;
  return mixSeed(state.seed, mixSeed(id, timeBits));
}

function appendId(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids : Object.freeze([...ids, id]);
}

function emit(
  state: RailFlightState,
  kind: GameplayEventKind,
  encounterId: string | null,
  scoreDelta: number,
): RailFlightState {
  const event = gameplayEvent({
    id: state.gameplayEvents.length + 1,
    kind,
    encounterId,
    journeyTime: state.time,
    distanceMm: state.distanceMm,
    phase: phaseAt(state.time),
    scoreDelta,
  });
  return { ...state, gameplayEvents: Object.freeze([...state.gameplayEvents, event]) };
}

function applyMiss(state: RailFlightState): RailFlightState {
  const missCount = state.consecutiveMisses + 1;
  let next: RailFlightState = {
    ...state,
    lifeChain: 0,
    flowPurity: Math.max(0, state.flowPurity - 90),
    mistakes: state.mistakes + 1,
    consecutiveMisses: missCount,
  };
  if (missCount >= 3) {
    next = emit({
      ...next,
      consecutiveMisses: 0,
      assistLevel: Math.min(3, state.assistLevel + 1),
      assistNextGate: true,
    }, "assist-next-gate", null, 0);
  }
  return next;
}

function resolveGate(state: RailFlightState, gate: Readonly<GateEncounter>): RailFlightState {
  const passed = distanceToEncounter3dMm(state.distanceMm, state.corridorOffset, gate)
    <= gateRadiusMm(gate, state.assistNextGate);
  if (passed) {
    return emit({
      ...state,
      score: state.score + 100,
      lifeChain: state.lifeChain + 1,
      flowPurity: Math.min(1_000, state.flowPurity + 20),
      consecutiveMisses: 0,
      assistNextGate: false,
      passedEncounterIds: appendId(state.passedEncounterIds, gate.id),
      resolvedEncounterIds: appendId(state.resolvedEncounterIds, gate.id),
    }, "gate-pass", gate.id, 100);
  }
  const missed = emit({
    ...state,
    assistNextGate: false,
    missedEncounterIds: appendId(state.missedEncounterIds, gate.id),
    resolvedEncounterIds: appendId(state.resolvedEncounterIds, gate.id),
  }, "gate-miss", gate.id, 0);
  return applyMiss(missed);
}

function resolveObstacle(state: RailFlightState, obstacle: Readonly<ObstacleEncounter>): RailFlightState {
  const proximity3d = distanceToEncounter3dMm(state.distanceMm, state.corridorOffset, obstacle);
  const resolved = {
    ...state,
    resolvedEncounterIds: appendId(state.resolvedEncounterIds, obstacle.id),
  };
  if (proximity3d <= obstacle.hitRadiusMm) {
    return applyMiss(emit({
      ...resolved,
      forwardSpeedMmPerSecond: RAIL_HIT_SPEED_MM_PER_SECOND,
      slowdownRemainingMs: RAIL_HIT_SLOWDOWN_MS,
    }, "obstacle-hit", obstacle.id, 0));
  }
  if (proximity3d <= obstacle.nearMissRadiusMm) {
    return emit({
      ...resolved,
      score: state.score + 25,
      lifeChain: state.lifeChain + 1,
      flowPurity: Math.min(1_000, state.flowPurity + 5),
      consecutiveMisses: 0,
    }, "obstacle-near-miss", obstacle.id, 25);
  }
  return resolved;
}

function resolvePassedEncounters(
  state: RailFlightState,
  previousDistanceMm: number,
  encounters: readonly Readonly<RailEncounter>[],
): RailFlightState {
  let next = state;
  for (const encounter of encounters) {
    if (next.resolvedEncounterIds.includes(encounter.id)) continue;
    if (encounter.kind === "gate" && crossedEncounterPlane(previousDistanceMm, next.distanceMm, encounter.distanceMm)) {
      next = resolveGate(next, encounter);
      continue;
    }
    if (encounter.kind === "obstacle" && crossedEncounterPlane(previousDistanceMm, next.distanceMm, encounter.distanceMm)) {
      next = resolveObstacle(next, encounter);
      continue;
    }
    if (encounter.kind === "life-node" && next.distanceMm > encounter.distanceMm + encounter.goodRadiusMm) {
      next = applyMiss(emit({
        ...next,
        missedEncounterIds: appendId(next.missedEncounterIds, encounter.id),
        resolvedEncounterIds: appendId(next.resolvedEncounterIds, encounter.id),
      }, "node-miss", encounter.id, 0));
    }
  }
  return next;
}

function closestLifeNode(
  state: RailFlightState,
  encounters: readonly Readonly<RailEncounter>[],
): Readonly<LifeNodeEncounter> | null {
  return encounters
    .filter((encounter): encounter is Readonly<LifeNodeEncounter> => (
      encounter.kind === "life-node" && !state.resolvedEncounterIds.includes(encounter.id)
    ))
    .map((encounter) => ({ encounter, distance: distanceToEncounter3dMm(state.distanceMm, state.corridorOffset, encounter) }))
    .filter(({ encounter, distance }) => distance <= encounter.goodRadiusMm)
    .sort((left, right) => left.distance - right.distance || left.encounter.id.localeCompare(right.encounter.id))[0]?.encounter ?? null;
}

function resolvePulse(
  state: RailFlightState,
  encounters: readonly Readonly<RailEncounter>[],
): RailFlightState {
  if (state.pulseCooldownRemainingMs > 0) {
    return emit(state, "pulse-cooldown", null, 0);
  }
  let next: RailFlightState = { ...state, pulseCooldownRemainingMs: PULSE_COOLDOWN_MS };
  const node = closestLifeNode(next, encounters);
  if (!node) return emit(next, "pulse-empty", null, 0);

  const distance = distanceToEncounter3dMm(next.distanceMm, next.corridorOffset, node);
  const perfect = distance <= node.perfectRadiusMm;
  const id = next.pulses.length + 1;
  const pulse: TwinkleSeed = Object.freeze({
    id,
    journeyTime: Number(next.time.toFixed(3)),
    x: Number(next.position.x.toFixed(6)),
    y: Number(next.position.y.toFixed(6)),
    phase: phaseAt(next.time),
    source: "player",
    value: seedForPulse(next, id),
  });
  const scoreDelta = perfect ? 250 : 120;
  const shouldAnswer = pulse.phase === "ANSWER" && pulse.journeyTime >= 166 && next.answerAt === null;
  next = {
    ...next,
    score: next.score + scoreDelta,
    lifeChain: next.lifeChain + 1,
    flowPurity: Math.min(1_000, next.flowPurity + (perfect ? 35 : 15)),
    consecutiveMisses: 0,
    pulses: Object.freeze([...next.pulses, pulse]),
    answerAt: shouldAnswer ? next.time : next.answerAt,
    activatedEncounterIds: appendId(next.activatedEncounterIds, node.id),
    resolvedEncounterIds: appendId(next.resolvedEncounterIds, node.id),
  };
  return emit(next, perfect ? "node-perfect" : "node-good", node.id, scoreDelta);
}

/** Advance one deterministic slice. Story time and rail distance are separate clocks. */
export function stepJourney(
  state: RailFlightState,
  rawInput: Partial<NormalizedInput> = {},
  seconds = STEP_SECONDS,
  encounters: readonly Readonly<RailEncounter>[] = DEFAULT_RAIL_ENCOUNTERS,
): RailFlightState {
  if (state.finished || !Number.isFinite(seconds) || seconds <= 0) return state;
  const dt = Math.min(seconds, JOURNEY_SECONDS - state.time);
  const input = normalizeInput(rawInput);
  const flow = flowAt(state.seed, state.time, state.position);
  const velocity = Object.freeze({
    x: input.moveX * PLAYER_SPEED + flow.x * FLOW_SPEED - state.position.x * 0.12,
    y: input.moveY * PLAYER_SPEED + flow.y * FLOW_SPEED - state.position.y * 0.12,
  });
  const position = clampPlane({
    x: state.position.x + velocity.x * dt,
    y: state.position.y + velocity.y * dt,
  });
  const elapsedMs = Math.round(dt * 1_000);
  const previousDistanceMm = state.distanceMm;
  const exactTravelMm = state.distanceRemainderMm + state.forwardSpeedMmPerSecond * dt;
  let wholeTravelMm = Math.floor(exactTravelMm + 1e-9);
  let distanceRemainderMm = exactTravelMm - wholeTravelMm;
  if (distanceRemainderMm >= 1 - 1e-6) {
    wholeTravelMm += 1;
    distanceRemainderMm = 0;
  } else if (distanceRemainderMm < 0 && distanceRemainderMm > -1e-6) {
    distanceRemainderMm = 0;
  }
  distanceRemainderMm = Number(distanceRemainderMm.toFixed(12));
  const distanceMm = previousDistanceMm + Math.max(0, wholeTravelMm);
  const slowdownRemainingMs = Math.max(0, state.slowdownRemainingMs - elapsedMs);
  const nextTime = Math.min(JOURNEY_SECONDS, state.time + dt);
  let next: RailFlightState = {
    ...state,
    time: nextTime,
    velocity,
    position,
    distanceMm,
    distanceRemainderMm,
    corridorOffset: corridorOffsetFromPosition(position),
    pulseCooldownRemainingMs: Math.max(0, state.pulseCooldownRemainingMs - elapsedMs),
    slowdownRemainingMs,
    forwardSpeedMmPerSecond: slowdownRemainingMs > 0
      ? RAIL_HIT_SPEED_MM_PER_SECOND
      : RAIL_FORWARD_SPEED_MM_PER_SECOND,
    finished: nextTime >= JOURNEY_SECONDS,
  };
  next = resolvePassedEncounters(next, previousDistanceMm, encounters);
  if (input.pulse) next = resolvePulse(next, encounters);
  const active = activeEncounterAt(next.distanceMm, new Set(next.resolvedEncounterIds), encounters);
  return {
    ...next,
    activeEncounterId: active?.id ?? null,
    activeEncounterKind: active?.kind ?? null,
    activeEncounterDistanceMm: active === null
      ? null
      : Math.round(distanceToEncounter3dMm(next.distanceMm, next.corridorOffset, active)),
  };
}

/** Advance to an exact story-time checkpoint for deterministic QA and replay tooling. */
export function advanceJourneyTo(
  state: RailFlightState,
  targetTime: number,
  input: Partial<NormalizedInput> = {},
  encounters: readonly Readonly<RailEncounter>[] = DEFAULT_RAIL_ENCOUNTERS,
): RailFlightState {
  const target = Math.max(state.time, Math.min(JOURNEY_SECONDS, targetTime));
  let next = state;
  while (!next.finished && next.time < target) {
    next = stepJourney(next, input, Math.min(STEP_SECONDS, target - next.time), encounters);
  }
  return next;
}

/** Replays timestamped edge inputs on the canonical 60 Hz clock. */
export function simulateJourney(inputs: readonly TimedInput[] = [], options: SimulationOptions = {}): RailFlightState {
  const encounters = options.encounters ?? DEFAULT_RAIL_ENCOUNTERS;
  const ordered = [...inputs]
    .filter((input) => Number.isFinite(input.at) && input.at >= 0 && input.at <= JOURNEY_SECONDS)
    .sort((left, right) => left.at - right.at);
  let state = createJourneyState(options);
  let inputIndex = 0;
  let held: NormalizedInput = { moveX: 0, moveY: 0 };
  while (!state.finished) {
    const nextInput = ordered[inputIndex];
    const boundary = Math.min(state.time + STEP_SECONDS, nextInput?.at ?? JOURNEY_SECONDS, JOURNEY_SECONDS);
    state = stepJourney(state, held, boundary - state.time, encounters);
    while (ordered[inputIndex] && Math.abs(ordered[inputIndex].at - state.time) < 1e-8) {
      const event = ordered[inputIndex];
      const normalized = normalizeInput(event);
      held = { moveX: normalized.moveX, moveY: normalized.moveY, pulse: false };
      state = stepJourney(state, { ...held, pulse: Boolean(event.pulse) }, 0.000_001, encounters);
      inputIndex += 1;
    }
    if (boundary === state.time && !nextInput && !state.finished) {
      state = stepJourney(state, held, STEP_SECONDS, encounters);
    }
  }
  return state;
}

/** FNV-1a stable digest of all gameplay-relevant rail and journey state. */
export function hashJourney(state: RailFlightState): string {
  const canonical = JSON.stringify({
    seed: state.seed,
    time: Number(state.time.toFixed(6)),
    position: [Number(state.position.x.toFixed(6)), Number(state.position.y.toFixed(6))],
    velocity: [Number(state.velocity.x.toFixed(6)), Number(state.velocity.y.toFixed(6))],
    answerAt: state.answerAt === null ? null : Number(state.answerAt.toFixed(6)),
    finished: state.finished,
    pulses: state.pulses.map((pulse) => [pulse.id, pulse.journeyTime, pulse.x, pulse.y, pulse.phase, pulse.value]),
    rail: [state.score, state.distanceMm, Number(state.distanceRemainderMm.toFixed(9)), state.forwardSpeedMmPerSecond, state.corridorOffset.x, state.corridorOffset.y, state.lifeChain, state.flowPurity, state.mistakes, state.consecutiveMisses, state.assistLevel, state.assistNextGate ? 1 : 0, state.pulseCooldownRemainingMs, state.slowdownRemainingMs, state.activeEncounterId, state.activeEncounterKind, state.activeEncounterDistanceMm],
    outcomes: [state.passedEncounterIds, state.activatedEncounterIds, state.missedEncounterIds, state.resolvedEncounterIds],
    events: state.gameplayEvents.map((event) => [event.id, event.kind, event.encounterId, event.journeyTime, event.distanceMm, event.phase, event.scoreDelta]),
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface PropertyCheck {
  valid: boolean;
  checked: number;
  invalidSeeds: readonly number[];
}

/** 1,000 seed safety property required for generated traversable routes. */
export function validateSeedProperties(seedCount = 1000): PropertyCheck {
  const routes = validateRoutes(seedCount);
  return { valid: routes.valid, checked: routes.checked, invalidSeeds: routes.invalidSeeds };
}
