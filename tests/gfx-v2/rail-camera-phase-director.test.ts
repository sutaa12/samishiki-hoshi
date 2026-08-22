import { describe, expect, it } from "vitest";
import {
  LIFE_EARTH_MAX_CAMERA_JUMP_SCENE_UNITS,
  RAIL_CAMERA_FOLLOW_DISTANCE_SCENE,
  RAIL_CAMERA_FOV_DEGREES,
  RAIL_CAMERA_HEIGHT_SCENE,
  RAIL_CAMERA_LOOK_AHEAD_SECONDS,
  RAIL_WORLD_SCENE_SCALE,
  createChunkSceneAnchors,
  createRailCameraSnapshot,
} from "../../src/gfx/v2/camera";
import {
  LIFE_EARTH_CONTINUITY_THRESHOLDS,
  PHASE_BLEND_DURATION_SECONDS,
  LifeEarthContinuityTrace,
  phaseDirectorSnapshotAt,
} from "../../src/gfx/v2/integration/phase-director";
import type { RailRenderSnapshot } from "../../src/gfx/v2/contracts";
import {
  WORLD_GENERATOR_VERSION,
  createWorldGenerationContext,
  generateWorldPlan,
} from "../../src/world/v2";

const PLAN = generateWorldPlan(createWorldGenerationContext({
  worldSeed: 20_260_818,
  generatorVersion: WORLD_GENERATOR_VERSION,
}));

function railAt(storyTime: number, corridorX = 0, corridorY = 0): Readonly<RailRenderSnapshot> {
  return Object.freeze({
    distanceMm: Math.round(storyTime * 10_000),
    forwardSpeedMmPerSecond: 10_000,
    corridorOffset: Object.freeze({ x: corridorX, y: corridorY }),
  });
}

describe("QX-R3-005 RailCamera", () => {
  it("samples the WorldPlan Flow spline with canonical distance, look-ahead, and corridor offset", () => {
    const camera = createRailCameraSnapshot({
      plan: PLAN,
      storyTime: 35,
      rail: railAt(35, 650, -300),
      reducedMotion: false,
    });

    expect(camera.distanceMm).toBe(350_000);
    expect(camera.lookAheadSeconds).toBe(RAIL_CAMERA_LOOK_AHEAD_SECONDS);
    expect(camera.lookAheadDistanceMm).toBe(357_500);
    expect(camera.flowChunkId).toBe("S06");
    expect(camera.corridorOffsetScene).toEqual({
      x: 650 * RAIL_WORLD_SCENE_SCALE,
      y: -300 * RAIL_WORLD_SCENE_SCALE,
    });
    expect(camera.target).not.toEqual(camera.position);
    expect(Math.hypot(camera.forward.x, camera.forward.y, camera.forward.z)).toBeCloseTo(1, 8);
    expect(camera.fovDegrees).toBe(RAIL_CAMERA_FOV_DEGREES);
    expect(camera.fovDegrees).toBeGreaterThanOrEqual(55);
    expect(camera.fovDegrees).toBeLessThanOrEqual(65);
    const baseToCamera = {
      x: camera.position.x - camera.basePosition.x,
      y: camera.position.y - camera.basePosition.y,
      z: camera.position.z - camera.basePosition.z,
    };
    const backwardDistance = -(baseToCamera.x * camera.forward.x
      + baseToCamera.y * camera.forward.y
      + baseToCamera.z * camera.forward.z);
    const verticalDistance = baseToCamera.x * camera.up.x
      + baseToCamera.y * camera.up.y
      + baseToCamera.z * camera.up.z;
    expect(backwardDistance).toBeGreaterThanOrEqual(RAIL_CAMERA_FOLLOW_DISTANCE_SCENE * 0.9);
    expect(verticalDistance).toBeGreaterThanOrEqual(RAIL_CAMERA_HEIGHT_SCENE * 0.5);
    expect(Object.isFrozen(camera)).toBe(true);
    expect(Object.isFrozen(camera.position)).toBe(true);
    expect(() => JSON.parse(JSON.stringify(camera))).not.toThrow();
  });

  it("keeps forward travel identical while Reduced Motion lowers sway, roll, and parallax", () => {
    const input = {
      plan: PLAN,
      storyTime: 35.25,
      rail: railAt(35.25, 900, -700),
    } as const;
    const full = createRailCameraSnapshot({ ...input, reducedMotion: false });
    const reduced = createRailCameraSnapshot({ ...input, reducedMotion: true });
    const reducedNext = createRailCameraSnapshot({
      ...input,
      storyTime: input.storyTime + 1 / 60,
      rail: railAt(input.storyTime + 1 / 60, 900, -700),
      reducedMotion: true,
    });

    expect(reduced.basePosition).toEqual(full.basePosition);
    expect(reduced.lookAheadBasePosition).toEqual(full.lookAheadBasePosition);
    expect(reduced.distanceMm).toBe(full.distanceMm);
    expect(reduced.lookAheadDistanceMm).toBe(full.lookAheadDistanceMm);
    expect(Math.abs(reduced.rollRadians)).toBeLessThan(Math.abs(full.rollRadians));
    expect(reduced.swayAmplitudeScene).toBeLessThan(full.swayAmplitudeScene);
    expect(reduced.parallax.near).toBeLessThan(full.parallax.near);
    expect(reduced.parallax.mid).toBeLessThan(full.parallax.mid);
    expect(reduced.parallax.far).toBeLessThan(full.parallax.far);
    expect(reducedNext.basePosition).not.toEqual(reduced.basePosition);
  });

  it("uses one immutable mm-to-scene anchor map for all 24 chunk groups", () => {
    const anchors = createChunkSceneAnchors(PLAN);
    expect(Object.keys(anchors)).toHaveLength(24);
    expect(anchors.S02).toEqual({
      x: PLAN.chunks[1]!.flowSegment.points[1]!.x * RAIL_WORLD_SCENE_SCALE,
      y: PLAN.chunks[1]!.flowSegment.points[1]!.y * RAIL_WORLD_SCENE_SCALE,
      z: PLAN.chunks[1]!.flowSegment.points[1]!.z * RAIL_WORLD_SCENE_SCALE,
    });
    expect(Object.isFrozen(anchors)).toBe(true);
    expect(Object.values(anchors).every(Object.isFrozen)).toBe(true);
  });
});

describe("QX-R3-005 PhaseDirector", () => {
  it("blends every channel over exactly eight seconds centered on LIFE to EARTH", () => {
    const before = phaseDirectorSnapshotAt(31.999);
    const start = phaseDirectorSnapshotAt(32);
    const center = phaseDirectorSnapshotAt(36);
    const end = phaseDirectorSnapshotAt(40);
    const after = phaseDirectorSnapshotAt(40.001);

    expect(PHASE_BLEND_DURATION_SECONDS).toBe(8);
    expect(before).toMatchObject({
      fromPhase: "LIFE",
      toPhase: "LIFE",
      phaseBlendProgress01: 0,
      localTransitionMix01: null,
    });
    expect(start).toMatchObject({
      fromPhase: "LIFE",
      toPhase: "EARTH",
      phaseBlendProgress01: 0,
      localTransitionMix01: 0,
    });
    expect(center).toMatchObject({
      fromPhase: "LIFE",
      toPhase: "EARTH",
      phaseBlendProgress01: 0.1,
      localTransitionMix01: 0.5,
    });
    expect(end).toMatchObject({
      fromPhase: "LIFE",
      toPhase: "EARTH",
      phaseBlendProgress01: 0.2,
      localTransitionMix01: 1,
    });
    expect(after).toMatchObject({
      fromPhase: "EARTH",
      toPhase: "EARTH",
      phaseBlendProgress01: 0.2,
      localTransitionMix01: null,
    });
    expect(end.channels).toEqual(after.channels);
    expect(center.channels.fog.density).toBeGreaterThan(end.channels.fog.density);
    expect(center.channels.exposure).toBeGreaterThan(start.channels.exposure);
    expect(center.channels.material).toBeGreaterThan(start.channels.material);
    expect(center.channels.particle).toBeLessThan(start.channels.particle);
    expect(center.channels.audioLayer).toBeGreaterThan(start.channels.audioLayer);
    expect(Object.isFrozen(center.channels.fog.color)).toBe(true);
  });

  it("is continuous at every exact phase boundary and independent of renderer quality/backend", () => {
    for (const boundary of [36, 88, 130, 161, 171]) {
      const left = phaseDirectorSnapshotAt(boundary - 1 / 60);
      const exact = phaseDirectorSnapshotAt(boundary);
      const right = phaseDirectorSnapshotAt(boundary + 1 / 60);
      const leftJump = Math.abs(exact.channels.exposure - left.channels.exposure);
      const rightJump = Math.abs(right.channels.exposure - exact.channels.exposure);
      expect(leftJump).toBeLessThan(0.01);
      expect(rightJump).toBeLessThan(0.01);
      expect(exact.transitionBoundarySeconds).toBe(boundary);
      expect(exact.localTransitionMix01).toBe(0.5);
    }
    expect(phaseDirectorSnapshotAt(88)).toEqual(phaseDirectorSnapshotAt(88));
  });

  it("keeps public phase-blend progress finite, clamped, monotonic, and continuous at 60 Hz", () => {
    let previous = phaseDirectorSnapshotAt(0).phaseBlendProgress01;
    for (let frame = 1; frame <= 180 * 60; frame += 1) {
      const snapshot = phaseDirectorSnapshotAt(frame / 60);
      const progress = snapshot.phaseBlendProgress01;
      expect(Number.isFinite(progress)).toBe(true);
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThanOrEqual(1);
      expect(progress).toBeGreaterThanOrEqual(previous);
      expect(Math.abs(progress - previous)).toBeLessThanOrEqual(0.01);
      if (snapshot.localTransitionMix01 !== null) {
        expect(snapshot.localTransitionMix01).toBeGreaterThanOrEqual(0);
        expect(snapshot.localTransitionMix01).toBeLessThanOrEqual(1);
      }
      previous = progress;
    }
    expect(previous).toBe(1);
  });
});

describe("QX-R3-005 LIFE to EARTH 120-frame continuity gate", () => {
  it("passes the predeclared jump, color, compile, still, and resident-chunk thresholds", () => {
    expect(LIFE_EARTH_CONTINUITY_THRESHOLDS).toEqual({
      sampleFrames: 120,
      maxCameraJumpSceneUnits: LIFE_EARTH_MAX_CAMERA_JUMP_SCENE_UNITS,
      maxBlackFrames: 0,
      maxMonochromeFrames: 0,
      maxRuntimeCompileDelta: 0,
      maxBackendProgramDelta: 0,
      maxStillFrameRatio: 0.05,
      maxMissingCurrentChunkFrames: 0,
      maxMissingCameraChunkFrames: 0,
      maxMissingNextChunkFramesBeforeBoundary: 0,
    });

    const trace = new LifeEarthContinuityTrace();
    const initialCamera = createRailCameraSnapshot({
      plan: PLAN,
      storyTime: 35,
      rail: railAt(35),
      reducedMotion: false,
    });
    const initialPhase = phaseDirectorSnapshotAt(35);
    trace.observe({
      storyTime: 35,
      cameraPosition: initialCamera.position,
      backgroundColor: initialPhase.channels.background,
      runtimeCompileEvents: 88,
      backendProgramCount: 24,
      currentChunkReady: true,
      cameraChunkReady: true,
      nextChunkReadyBeforeBoundary: true,
    });

    for (let frame = 1; frame <= 120; frame += 1) {
      const storyTime = 35 + frame / 60;
      const camera = createRailCameraSnapshot({
        plan: PLAN,
        storyTime,
        rail: railAt(storyTime),
        reducedMotion: false,
      });
      const phase = phaseDirectorSnapshotAt(storyTime);
      trace.observe({
        storyTime,
        cameraPosition: camera.position,
        backgroundColor: phase.channels.background,
        runtimeCompileEvents: 88,
        backendProgramCount: 24,
        currentChunkReady: true,
        cameraChunkReady: true,
        nextChunkReadyBeforeBoundary: true,
      });
    }

    const snapshot = trace.snapshot();
    expect(snapshot).toMatchObject({
      complete: true,
      passed: true,
      sampleFrames: 120,
      blackFrames: 0,
      monochromeFrames: 0,
      runtimeCompileDelta: 0,
      backendProgramDelta: 0,
      currentChunkMissingFrames: 0,
      cameraChunkMissingFrames: 0,
      nextChunkMissingFramesBeforeBoundary: 0,
    });
    expect(snapshot.maxCameraJumpSceneUnits).toBeLessThanOrEqual(0.25);
    expect(snapshot.stillFrameRatio).toBeLessThanOrEqual(0.05);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("fails closed when the backend program inventory grows inside the exact trace", () => {
    const trace = new LifeEarthContinuityTrace();
    const backgroundColor = Object.freeze({ r: 0.05, g: 0.16, b: 0.24 });
    trace.observe({
      storyTime: 35,
      cameraPosition: Object.freeze({ x: 0, y: 0, z: 0 }),
      backgroundColor,
      runtimeCompileEvents: 88,
      backendProgramCount: 24,
      currentChunkReady: true,
      cameraChunkReady: true,
      nextChunkReadyBeforeBoundary: true,
    });
    for (let frame = 1; frame <= 120; frame += 1) {
      trace.observe({
        storyTime: 35 + frame / 60,
        cameraPosition: Object.freeze({ x: frame * 0.001, y: 0, z: 0 }),
        backgroundColor,
        runtimeCompileEvents: 88,
        backendProgramCount: frame < 60 ? 24 : 25,
        currentChunkReady: true,
        cameraChunkReady: true,
        nextChunkReadyBeforeBoundary: true,
      });
    }
    expect(trace.snapshot()).toMatchObject({
      complete: true,
      passed: false,
      backendProgramDelta: 1,
      runtimeCompileDelta: 0,
    });
  });
});
