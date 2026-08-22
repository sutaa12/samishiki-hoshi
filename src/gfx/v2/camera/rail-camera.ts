import { RAIL_FORWARD_SPEED_MM_PER_SECOND } from "../../../game/rail-flight-state";
import type { RailRenderSnapshot } from "../contracts";
import type {
  StoryChunkId,
  WorldPlan,
  WorldPointMm,
} from "../../../world/v2";

export const RAIL_WORLD_SCENE_SCALE = 1 / 10_000;
export const RAIL_CAMERA_LOOK_AHEAD_SECONDS = 0.75;
export const RAIL_CAMERA_FOV_DEGREES = 60;
export const RAIL_CAMERA_FOLLOW_DISTANCE_SCENE = 0.6;
export const RAIL_CAMERA_HEIGHT_SCENE = 0.24;
export const LIFE_EARTH_MAX_CAMERA_JUMP_SCENE_UNITS = 0.25;

export interface RailScenePointSnapshot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface RailCameraSnapshot {
  readonly fovDegrees: number;
  readonly distanceMm: number;
  readonly lookAheadDistanceMm: number;
  readonly lookAheadSeconds: number;
  readonly flowChunkId: StoryChunkId;
  readonly reducedMotion: boolean;
  readonly basePosition: Readonly<RailScenePointSnapshot>;
  readonly lookAheadBasePosition: Readonly<RailScenePointSnapshot>;
  readonly position: Readonly<RailScenePointSnapshot>;
  readonly target: Readonly<RailScenePointSnapshot>;
  readonly up: Readonly<RailScenePointSnapshot>;
  readonly forward: Readonly<RailScenePointSnapshot>;
  readonly corridorOffsetScene: Readonly<{ readonly x: number; readonly y: number }>;
  readonly rollRadians: number;
  readonly swayAmplitudeScene: number;
  readonly parallax: Readonly<{
    readonly near: number;
    readonly mid: number;
    readonly far: number;
  }>;
}

export interface CreateRailCameraSnapshotOptions {
  readonly plan: Readonly<WorldPlan>;
  readonly storyTime: number;
  readonly rail: Readonly<RailRenderSnapshot>;
  readonly reducedMotion: boolean;
}

interface TimedWorldPoint {
  readonly timeSeconds: number;
  readonly point: Readonly<WorldPointMm>;
}

const TIMED_SPLINE_POINTS = new WeakMap<WorldPlan, readonly TimedWorldPoint[]>();

function point(x: number, y: number, z: number): Readonly<RailScenePointSnapshot> {
  return { x, y, z };
}

function freezePoint(
  value: Readonly<RailScenePointSnapshot>,
): Readonly<RailScenePointSnapshot> {
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

function add(
  left: Readonly<RailScenePointSnapshot>,
  right: Readonly<RailScenePointSnapshot>,
): Readonly<RailScenePointSnapshot> {
  return point(left.x + right.x, left.y + right.y, left.z + right.z);
}

function multiply(
  value: Readonly<RailScenePointSnapshot>,
  scalar: number,
): Readonly<RailScenePointSnapshot> {
  return point(value.x * scalar, value.y * scalar, value.z * scalar);
}

function subtract(
  left: Readonly<RailScenePointSnapshot>,
  right: Readonly<RailScenePointSnapshot>,
): Readonly<RailScenePointSnapshot> {
  return point(left.x - right.x, left.y - right.y, left.z - right.z);
}

function cross(
  left: Readonly<RailScenePointSnapshot>,
  right: Readonly<RailScenePointSnapshot>,
): Readonly<RailScenePointSnapshot> {
  return point(
    left.y * right.z - left.z * right.y,
    left.z * right.x - left.x * right.z,
    left.x * right.y - left.y * right.x,
  );
}

function normalize(
  value: Readonly<RailScenePointSnapshot>,
  fallback: Readonly<RailScenePointSnapshot>,
): Readonly<RailScenePointSnapshot> {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!Number.isFinite(length) || length <= 1e-9) return fallback;
  return point(value.x / length, value.y / length, value.z / length);
}

export function worldPointMmToScene(
  value: Readonly<WorldPointMm>,
): Readonly<RailScenePointSnapshot> {
  return freezePoint(point(
    value.x * RAIL_WORLD_SCENE_SCALE,
    value.y * RAIL_WORLD_SCENE_SCALE,
    value.z * RAIL_WORLD_SCENE_SCALE,
  ));
}

function timedSplinePoints(plan: Readonly<WorldPlan>): readonly TimedWorldPoint[] {
  const cached = TIMED_SPLINE_POINTS.get(plan);
  if (cached) return cached;
  const samples: TimedWorldPoint[] = [];
  for (const chunk of plan.chunks) {
    const [start, middle, end] = chunk.flowSegment.points;
    if (!start || !middle || !end) {
      throw new RangeError(`RailCamera requires three Flow points for ${chunk.id}.`);
    }
    const startSeconds = chunk.storyNode.startMs / 1_000;
    const endSeconds = chunk.storyNode.endMs / 1_000;
    const candidates: readonly TimedWorldPoint[] = [
      { timeSeconds: startSeconds, point: start },
      { timeSeconds: (startSeconds + endSeconds) / 2, point: middle },
      { timeSeconds: endSeconds, point: end },
    ];
    for (const candidate of candidates) {
      const previous = samples.at(-1);
      if (previous?.timeSeconds === candidate.timeSeconds) {
        if (
          previous.point.x !== candidate.point.x
          || previous.point.y !== candidate.point.y
          || previous.point.z !== candidate.point.z
        ) {
          throw new RangeError(`WorldPlan Flow is discontinuous at ${candidate.timeSeconds}s.`);
        }
        continue;
      }
      samples.push(candidate);
    }
  }
  if (samples.length < 2) throw new RangeError("RailCamera requires at least two timed Flow points.");
  const frozen = Object.freeze(samples);
  TIMED_SPLINE_POINTS.set(plan, frozen);
  return frozen;
}

function tangentAt(samples: readonly TimedWorldPoint[], index: number): Readonly<WorldPointMm> {
  const previous = samples[Math.max(0, index - 1)]!;
  const next = samples[Math.min(samples.length - 1, index + 1)]!;
  const duration = next.timeSeconds - previous.timeSeconds;
  if (duration <= 0) return { x: 0, y: 0, z: 0 };
  return {
    x: (next.point.x - previous.point.x) / duration,
    y: (next.point.y - previous.point.y) / duration,
    z: (next.point.z - previous.point.z) / duration,
  };
}

function sampleTimedFlowMm(
  samples: readonly TimedWorldPoint[],
  requestedTimeSeconds: number,
): Readonly<WorldPointMm> {
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const timeSeconds = Math.max(first.timeSeconds, Math.min(last.timeSeconds, requestedTimeSeconds));
  if (timeSeconds <= first.timeSeconds) return first.point;
  if (timeSeconds >= last.timeSeconds) return last.point;

  let rightIndex = 1;
  while (rightIndex < samples.length && samples[rightIndex]!.timeSeconds < timeSeconds) {
    rightIndex += 1;
  }
  const leftIndex = rightIndex - 1;
  const left = samples[leftIndex]!;
  const right = samples[rightIndex]!;
  const duration = right.timeSeconds - left.timeSeconds;
  const t = duration <= 0 ? 0 : (timeSeconds - left.timeSeconds) / duration;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const leftTangent = tangentAt(samples, leftIndex);
  const rightTangent = tangentAt(samples, rightIndex);
  return {
    x: h00 * left.point.x + h10 * duration * leftTangent.x
      + h01 * right.point.x + h11 * duration * rightTangent.x,
    y: h00 * left.point.y + h10 * duration * leftTangent.y
      + h01 * right.point.y + h11 * duration * rightTangent.y,
    z: h00 * left.point.z + h10 * duration * leftTangent.z
      + h01 * right.point.z + h11 * duration * rightTangent.z,
  };
}

function flowChunkAt(plan: Readonly<WorldPlan>, railTimeSeconds: number): StoryChunkId {
  const timeMs = Math.round(Math.max(0, Math.min(180, railTimeSeconds)) * 1_000);
  const chunk = plan.chunks.find((candidate) => (
    timeMs >= candidate.storyNode.startMs
    && (timeMs < candidate.storyNode.endMs || candidate.id === "S24")
  ));
  if (!chunk) throw new RangeError(`WorldPlan has no Flow chunk at ${railTimeSeconds}s.`);
  return chunk.id;
}

function assertRailSnapshot(rail: Readonly<RailRenderSnapshot>): void {
  for (const [label, value] of [
    ["distance", rail.distanceMm],
    ["forward speed", rail.forwardSpeedMmPerSecond],
    ["corridor x", rail.corridorOffset.x],
    ["corridor y", rail.corridorOffset.y],
  ] as const) {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`RailCamera ${label} must be a safe integer.`);
    }
  }
  if (rail.distanceMm < 0 || rail.forwardSpeedMmPerSecond < 0) {
    throw new RangeError("RailCamera distance and forward speed must be non-negative.");
  }
}

export function createRailCameraSnapshot(
  options: Readonly<CreateRailCameraSnapshotOptions>,
): Readonly<RailCameraSnapshot> {
  if (!Number.isFinite(options.storyTime) || options.storyTime < 0 || options.storyTime > 180) {
    throw new RangeError("RailCamera story time must be within the 180 second journey.");
  }
  assertRailSnapshot(options.rail);
  const samples = timedSplinePoints(options.plan);
  const railTimeSeconds = options.rail.distanceMm / RAIL_FORWARD_SPEED_MM_PER_SECOND;
  const lookAheadDistanceMm = options.rail.distanceMm
    + Math.round(options.rail.forwardSpeedMmPerSecond * RAIL_CAMERA_LOOK_AHEAD_SECONDS);
  const lookAheadRailTimeSeconds = lookAheadDistanceMm / RAIL_FORWARD_SPEED_MM_PER_SECOND;
  const basePosition = worldPointMmToScene(sampleTimedFlowMm(samples, railTimeSeconds));
  const lookAheadBasePosition = worldPointMmToScene(sampleTimedFlowMm(samples, lookAheadRailTimeSeconds));
  let forward = normalize(subtract(lookAheadBasePosition, basePosition), point(0, 0, 1));
  if (lookAheadDistanceMm === options.rail.distanceMm) {
    const prior = worldPointMmToScene(sampleTimedFlowMm(samples, Math.max(0, railTimeSeconds - 0.05)));
    forward = normalize(subtract(basePosition, prior), point(0, 0, 1));
  }
  const worldUp = point(0, 1, 0);
  const right = normalize(cross(worldUp, forward), point(1, 0, 0));
  const localUp = normalize(cross(forward, right), worldUp);
  const corridorOffsetScene = Object.freeze({
    x: (options.rail.corridorOffset.x === 0 ? 0 : options.rail.corridorOffset.x)
      * RAIL_WORLD_SCENE_SCALE,
    y: (options.rail.corridorOffset.y === 0 ? 0 : options.rail.corridorOffset.y)
      * RAIL_WORLD_SCENE_SCALE,
  });
  const motionScale = options.reducedMotion ? 0.2 : 1;
  const corridorScale = options.reducedMotion ? 0.65 : 1;
  const swayAmplitudeScene = options.reducedMotion ? 0.008 : 0.04;
  const sway = Math.sin(options.storyTime * 0.73) * swayAmplitudeScene;
  const lift = RAIL_CAMERA_HEIGHT_SCENE
    + Math.cos(options.storyTime * 0.41) * swayAmplitudeScene * 0.3;
  const lateral = corridorOffsetScene.x * corridorScale + sway;
  const vertical = corridorOffsetScene.y * corridorScale + lift;
  const position = add(
    add(basePosition, multiply(forward, -RAIL_CAMERA_FOLLOW_DISTANCE_SCENE)),
    add(multiply(right, lateral), multiply(localUp, vertical)),
  );
  const target = add(
    lookAheadBasePosition,
    add(
      multiply(right, corridorOffsetScene.x * corridorScale * 0.3),
      multiply(localUp, corridorOffsetScene.y * corridorScale * 0.3),
    ),
  );
  const rollRadians = Math.sin(options.storyTime * 0.37) * 0.018 * motionScale;
  const up = normalize(
    add(multiply(localUp, Math.cos(rollRadians)), multiply(right, Math.sin(rollRadians))),
    worldUp,
  );
  const parallax = options.reducedMotion
    ? Object.freeze({ near: 0.35, mid: 0.2, far: 0.08 })
    : Object.freeze({ near: 1, mid: 0.45, far: 0.12 });

  return Object.freeze({
    fovDegrees: RAIL_CAMERA_FOV_DEGREES,
    distanceMm: options.rail.distanceMm,
    lookAheadDistanceMm,
    lookAheadSeconds: RAIL_CAMERA_LOOK_AHEAD_SECONDS,
    flowChunkId: flowChunkAt(options.plan, railTimeSeconds),
    reducedMotion: options.reducedMotion,
    basePosition,
    lookAheadBasePosition,
    position: freezePoint(position),
    target: freezePoint(target),
    up: freezePoint(up),
    forward: freezePoint(forward),
    corridorOffsetScene,
    rollRadians,
    swayAmplitudeScene,
    parallax,
  });
}

export function createChunkSceneAnchors(
  plan: Readonly<WorldPlan>,
): Readonly<Record<StoryChunkId, Readonly<RailScenePointSnapshot>>> {
  const anchors = {} as Record<StoryChunkId, Readonly<RailScenePointSnapshot>>;
  for (const chunk of plan.chunks) {
    const middle = chunk.flowSegment.points[1];
    if (!middle) throw new RangeError(`Chunk ${chunk.id} has no Flow midpoint anchor.`);
    anchors[chunk.id] = worldPointMmToScene(middle);
  }
  return Object.freeze(anchors);
}
