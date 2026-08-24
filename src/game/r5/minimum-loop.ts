import {
  MINIMUM_DURATION_MS,
  MINIMUM_ENCOUNTERS,
  MINIMUM_SPEED_MM_PER_SECOND,
  type MinimumEncounterId,
} from "./minimum-encounters";

export type RingResult = "pending" | "pass" | "miss";
export type ObstacleResult = "pending" | "dodge" | "hit";
export type NodeResult = "pending" | "perfect" | "good" | "empty";

export type MinimumLoopEvent = Readonly<{
  index: number;
  atMs: number;
  distanceMm: number;
  encounter: MinimumEncounterId;
  result: Exclude<RingResult | ObstacleResult | NodeResult, "pending">;
  playerXPermille: number;
}>;

export type MinimumLoopState = Readonly<{
  timeMs: number;
  distanceMm: number;
  playerXPermille: number;
  activeStep: MinimumEncounterId | "complete";
  ringResult: RingResult;
  obstacleResult: ObstacleResult;
  nodeResult: NodeResult;
  progress: 0 | 1 | 2 | 3;
  events: readonly MinimumLoopEvent[];
  lastPulseMs: number | null;
}>;

export type MinimumLoopInput = Readonly<{
  moveX: -1 | 0 | 1;
  pointerXPermille: number | null;
  pulse: boolean;
}>;

const PLAYER_LIMIT = 850;
const STEER_PER_SECOND = 900;
const POINTER_CHASE_PER_SECOND = 1_900;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function approach(current: number, target: number, maximumDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maximumDelta) return target;
  return current + Math.sign(delta) * maximumDelta;
}

function event(
  state: MinimumLoopState,
  encounter: MinimumEncounterId,
  result: MinimumLoopEvent["result"],
  atMs: number,
  playerXPermille: number,
): MinimumLoopEvent {
  return Object.freeze({
    index: state.events.length + 1,
    atMs,
    distanceMm: Math.round((atMs * MINIMUM_SPEED_MM_PER_SECOND) / 1_000),
    encounter,
    result,
    playerXPermille,
  });
}

export function createMinimumLoopState(): MinimumLoopState {
  return Object.freeze({
    timeMs: 0,
    distanceMm: 0,
    playerXPermille: 0,
    activeStep: "ring",
    ringResult: "pending",
    obstacleResult: "pending",
    nodeResult: "pending",
    progress: 0,
    events: Object.freeze([]),
    lastPulseMs: null,
  });
}

export function stepMinimumLoop(
  state: MinimumLoopState,
  input: MinimumLoopInput,
  deltaMs: number,
): MinimumLoopState {
  if (state.timeMs >= MINIMUM_DURATION_MS) return state;
  const boundedDelta = Math.max(0, Math.min(100, Math.round(deltaMs)));
  const timeMs = Math.min(MINIMUM_DURATION_MS, state.timeMs + boundedDelta);
  const steerDelta = (STEER_PER_SECOND * boundedDelta) / 1_000;
  let playerXPermille = state.playerXPermille + input.moveX * steerDelta;
  if (input.pointerXPermille !== null) {
    playerXPermille = approach(
      playerXPermille,
      clamp(input.pointerXPermille, -PLAYER_LIMIT, PLAYER_LIMIT),
      (POINTER_CHASE_PER_SECOND * boundedDelta) / 1_000,
    );
  }
  playerXPermille = Math.round(clamp(playerXPermille, -PLAYER_LIMIT, PLAYER_LIMIT));
  const lastPulseMs = input.pulse ? timeMs : state.lastPulseMs;
  const nextEvents = [...state.events];
  let ringResult = state.ringResult;
  let obstacleResult = state.obstacleResult;
  let nodeResult = state.nodeResult;
  let progress = state.progress;
  let activeStep = state.activeStep;

  if (ringResult === "pending" && state.timeMs < 4_000 && timeMs >= 4_000) {
    ringResult = Math.abs(playerXPermille - MINIMUM_ENCOUNTERS.ring.xPermille) <= 360 ? "pass" : "miss";
    nextEvents.push(event(state, "ring", ringResult, 4_000, playerXPermille));
    progress = 1;
    activeStep = "obstacle";
  }
  if (obstacleResult === "pending" && state.timeMs < 8_000 && timeMs >= 8_000) {
    obstacleResult = Math.abs(playerXPermille - MINIMUM_ENCOUNTERS.obstacle.xPermille) >= 330 ? "dodge" : "hit";
    nextEvents.push(event({ ...state, events: nextEvents }, "obstacle", obstacleResult, 8_000, playerXPermille));
    progress = 2;
    activeStep = "node";
  }
  if (nodeResult === "pending" && state.timeMs < 11_000 && timeMs >= 11_000) {
    const positionError = Math.abs(playerXPermille - MINIMUM_ENCOUNTERS.node.xPermille);
    const pulseAge = lastPulseMs === null ? Number.POSITIVE_INFINITY : 11_000 - lastPulseMs;
    nodeResult = positionError <= 220 && pulseAge >= 0 && pulseAge <= 700
      ? "perfect"
      : positionError <= 450 && pulseAge >= 0 && pulseAge <= 1_500
        ? "good"
        : "empty";
    nextEvents.push(event({ ...state, events: nextEvents }, "node", nodeResult, 11_000, playerXPermille));
    progress = 3;
    activeStep = "complete";
  }

  return Object.freeze({
    timeMs,
    distanceMm: Math.round((timeMs * MINIMUM_SPEED_MM_PER_SECOND) / 1_000),
    playerXPermille,
    activeStep,
    ringResult,
    obstacleResult,
    nodeResult,
    progress,
    events: Object.freeze(nextEvents),
    lastPulseMs,
  });
}
