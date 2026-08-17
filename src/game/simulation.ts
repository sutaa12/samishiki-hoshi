import {
  JOURNEY_SECONDS,
  type JourneyState,
  type NormalizedInput,
  type QualityLevel,
  type TimedInput,
  type TwinkleSeed,
  type Vec2,
  normalizeInput,
  phaseAt,
} from "./model";
import { flowAt, mixSeed, validateRoutes } from "./procedural";

const STEP_SECONDS = 1 / 60;
const PLAYER_SPEED = 0.54;
const FLOW_SPEED = 0.24;
const PLAYABLE_BOUND = 0.94;

export interface SimulationOptions {
  seed?: number;
  /** Accepted for render callers, deliberately excluded from all state and hashes. */
  quality?: QualityLevel;
}

export function createJourneyState(options: SimulationOptions = {}): JourneyState {
  return {
    seed: (options.seed ?? 1) >>> 0,
    time: 0,
    position: { x: 0, y: -0.72 },
    velocity: { x: 0, y: 0 },
    pulses: [],
    answerAt: null,
    finished: false,
  };
}

function clampPlane(point: Vec2): Vec2 {
  return {
    x: Math.max(-PLAYABLE_BOUND, Math.min(PLAYABLE_BOUND, point.x)),
    y: Math.max(-PLAYABLE_BOUND, Math.min(PLAYABLE_BOUND, point.y)),
  };
}

function seedForPulse(state: JourneyState, id: number): number {
  const timeBits = Math.round(state.time * 1000) >>> 0;
  return mixSeed(state.seed, mixSeed(id, timeBits));
}

function addPulse(state: JourneyState): JourneyState {
  const id = state.pulses.length + 1;
  const event: TwinkleSeed = Object.freeze({
    id,
    journeyTime: Number(state.time.toFixed(3)),
    x: Number(state.position.x.toFixed(6)),
    y: Number(state.position.y.toFixed(6)),
    phase: phaseAt(state.time),
    source: "player",
    value: seedForPulse(state, id),
  });
  const shouldAnswer =
    event.phase === "ANSWER" && event.journeyTime >= 166 && state.answerAt === null;
  return {
    ...state,
    pulses: Object.freeze([...state.pulses, event]),
    answerAt: shouldAnswer ? state.time : state.answerAt,
  };
}

/** Advance exactly one fixed (or smaller final) deterministic simulation slice. */
export function stepJourney(state: JourneyState, rawInput: Partial<NormalizedInput> = {}, seconds = STEP_SECONDS): JourneyState {
  if (state.finished || !Number.isFinite(seconds) || seconds <= 0) return state;
  const dt = Math.min(seconds, JOURNEY_SECONDS - state.time);
  const input = normalizeInput(rawInput);
  const flow = flowAt(state.seed, state.time, state.position);
  const velocity = {
    x: input.moveX * PLAYER_SPEED + flow.x * FLOW_SPEED,
    y: input.moveY * PLAYER_SPEED + flow.y * FLOW_SPEED,
  };
  const nextTime = Math.min(JOURNEY_SECONDS, state.time + dt);
  let next: JourneyState = {
    ...state,
    time: nextTime,
    velocity,
    position: clampPlane({ x: state.position.x + velocity.x * dt, y: state.position.y + velocity.y * dt }),
    finished: nextTime >= JOURNEY_SECONDS,
  };
  if (input.pulse) next = addPulse(next);
  // The conversation opens at 166s; silence receives an automatic answer 2.5s later.
  if (next.answerAt === null && state.time < 168.5 && nextTime >= 168.5) {
    next = { ...next, answerAt: 168.5 };
  }
  return next;
}

/** Replays timestamped edge inputs on the canonical 60 Hz clock. */
export function simulateJourney(inputs: readonly TimedInput[] = [], options: SimulationOptions = {}): JourneyState {
  const ordered = [...inputs]
    .filter((input) => Number.isFinite(input.at) && input.at >= 0 && input.at <= JOURNEY_SECONDS)
    .sort((left, right) => left.at - right.at);
  let state = createJourneyState(options);
  let inputIndex = 0;
  let held: NormalizedInput = { moveX: 0, moveY: 0 };
  while (!state.finished) {
    const nextInput = ordered[inputIndex];
    const boundary = Math.min(state.time + STEP_SECONDS, nextInput?.at ?? JOURNEY_SECONDS, JOURNEY_SECONDS);
    state = stepJourney(state, held, boundary - state.time);
    while (ordered[inputIndex] && Math.abs(ordered[inputIndex].at - state.time) < 1e-8) {
      const event = ordered[inputIndex];
      const normalized = normalizeInput(event);
      // Pulse is an edge, never a held button; movement is the only persistent input.
      held = { moveX: normalized.moveX, moveY: normalized.moveY, pulse: false };
      state = stepJourney(state, { ...held, pulse: Boolean(event.pulse) }, 0.000_001);
      inputIndex += 1;
    }
    // Avoid a zero-width loop for sub-frame events; inputs are still deterministic.
    if (boundary === state.time && !nextInput && !state.finished) state = stepJourney(state, held, STEP_SECONDS);
  }
  return state;
}

/** FNV-1a style stable digest of only gameplay-relevant state. */
export function hashJourney(state: JourneyState): string {
  const canonical = JSON.stringify({
    seed: state.seed,
    time: Number(state.time.toFixed(6)),
    position: [Number(state.position.x.toFixed(6)), Number(state.position.y.toFixed(6))],
    velocity: [Number(state.velocity.x.toFixed(6)), Number(state.velocity.y.toFixed(6))],
    answerAt: state.answerAt === null ? null : Number(state.answerAt.toFixed(6)),
    finished: state.finished,
    pulses: state.pulses.map((pulse) => [pulse.id, pulse.journeyTime, pulse.x, pulse.y, pulse.phase, pulse.value]),
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
