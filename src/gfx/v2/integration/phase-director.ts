import { phaseAt, type JourneyPhase } from "../../../game/model";
import { LIFE_EARTH_MAX_CAMERA_JUMP_SCENE_UNITS } from "../camera";
import type { RailScenePointSnapshot } from "../camera";

export const PHASE_BLEND_DURATION_SECONDS = 8;
const PHASE_BLEND_HALF_SECONDS = PHASE_BLEND_DURATION_SECONDS / 2;
export const LIFE_EARTH_TRACE_START_SECONDS = 35;
export const LIFE_EARTH_TRACE_END_SECONDS = 37;
const BLACK_LUMINANCE_THRESHOLD = 0.015;
const MONOCHROME_CHROMA_THRESHOLD = 0.01;
const STILL_CAMERA_DELTA_THRESHOLD = 0.000_01;

export interface PhaseColorSnapshot {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface PhaseDirectorChannels {
  readonly background: Readonly<PhaseColorSnapshot>;
  readonly fog: Readonly<{
    readonly color: Readonly<PhaseColorSnapshot>;
    readonly density: number;
  }>;
  readonly ambient: Readonly<{
    readonly color: Readonly<PhaseColorSnapshot>;
    readonly intensity: number;
  }>;
  readonly sun: Readonly<{
    readonly color: Readonly<PhaseColorSnapshot>;
    readonly intensity: number;
    readonly direction: Readonly<RailScenePointSnapshot>;
  }>;
  readonly exposure: number;
  readonly material: number;
  readonly particle: number;
  readonly audioLayer: number;
}

export interface PhaseDirectorSnapshot {
  readonly storyTime: number;
  readonly fromPhase: JourneyPhase;
  readonly toPhase: JourneyPhase;
  readonly blend01: number;
  readonly transitionBoundarySeconds: number | null;
  readonly transitionStartSeconds: number | null;
  readonly transitionEndSeconds: number | null;
  readonly channels: Readonly<PhaseDirectorChannels>;
}

type PhasePreset = PhaseDirectorChannels;

function color(r: number, g: number, b: number): Readonly<PhaseColorSnapshot> {
  return Object.freeze({ r, g, b });
}

function direction(x: number, y: number, z: number): Readonly<RailScenePointSnapshot> {
  const length = Math.hypot(x, y, z) || 1;
  return Object.freeze({ x: x / length, y: y / length, z: z / length });
}

function preset(values: PhasePreset): Readonly<PhasePreset> {
  return Object.freeze({
    background: values.background,
    fog: Object.freeze({ ...values.fog }),
    ambient: Object.freeze({ ...values.ambient }),
    sun: Object.freeze({ ...values.sun }),
    exposure: values.exposure,
    material: values.material,
    particle: values.particle,
    audioLayer: values.audioLayer,
  });
}

const PHASE_PRESETS: Readonly<Record<JourneyPhase, Readonly<PhasePreset>>> = Object.freeze({
  LIFE: preset({
    background: color(0.015, 0.12, 0.2),
    fog: { color: color(0.02, 0.15, 0.24), density: 0.06 },
    ambient: { color: color(0.42, 0.66, 0.74), intensity: 0.55 },
    sun: { color: color(0.86, 0.97, 1), intensity: 3.8, direction: direction(-0.35, 0.8, 0.48) },
    exposure: 1.05,
    material: 0.2,
    particle: 0.75,
    audioLayer: 0.1,
  }),
  EARTH: preset({
    background: color(0.06, 0.18, 0.13),
    fog: { color: color(0.08, 0.22, 0.16), density: 0.045 },
    ambient: { color: color(0.55, 0.64, 0.48), intensity: 0.65 },
    sun: { color: color(1, 0.7, 0.42), intensity: 4.2, direction: direction(-0.6, 0.58, 0.52) },
    exposure: 1.12,
    material: 0.45,
    particle: 0.55,
    audioLayer: 0.32,
  }),
  ASCENT: preset({
    background: color(0.12, 0.22, 0.38),
    fog: { color: color(0.18, 0.3, 0.46), density: 0.025 },
    ambient: { color: color(0.52, 0.62, 0.82), intensity: 0.6 },
    sun: { color: color(1, 0.83, 0.62), intensity: 4.7, direction: direction(-0.42, 0.72, 0.55) },
    exposure: 1.2,
    material: 0.6,
    particle: 0.48,
    audioLayer: 0.5,
  }),
  SOLITUDE: preset({
    background: color(0.008, 0.012, 0.035),
    fog: { color: color(0.02, 0.025, 0.07), density: 0.008 },
    ambient: { color: color(0.22, 0.28, 0.48), intensity: 0.28 },
    sun: { color: color(0.45, 0.6, 1), intensity: 2.2, direction: direction(-0.25, 0.4, 0.88) },
    exposure: 1,
    material: 0.72,
    particle: 0.28,
    audioLayer: 0.62,
  }),
  ANSWER: preset({
    background: color(0.018, 0.018, 0.055),
    fog: { color: color(0.035, 0.035, 0.09), density: 0.006 },
    ambient: { color: color(0.3, 0.34, 0.58), intensity: 0.36 },
    sun: { color: color(0.55, 0.78, 1), intensity: 2.8, direction: direction(-0.5, 0.28, 0.82) },
    exposure: 1.14,
    material: 0.86,
    particle: 0.55,
    audioLayer: 0.85,
  }),
  TWINKLE: preset({
    background: color(0.025, 0.035, 0.075),
    fog: { color: color(0.06, 0.08, 0.14), density: 0.004 },
    ambient: { color: color(0.42, 0.5, 0.72), intensity: 0.5 },
    sun: { color: color(1, 0.78, 0.65), intensity: 3.4, direction: direction(-0.56, 0.5, 0.66) },
    exposure: 1.22,
    material: 1,
    particle: 1,
    audioLayer: 1,
  }),
});

const PHASE_TRANSITIONS = Object.freeze([
  Object.freeze({ boundary: 36, from: "LIFE" as const, to: "EARTH" as const }),
  Object.freeze({ boundary: 88, from: "EARTH" as const, to: "ASCENT" as const }),
  Object.freeze({ boundary: 130, from: "ASCENT" as const, to: "SOLITUDE" as const }),
  Object.freeze({ boundary: 161, from: "SOLITUDE" as const, to: "ANSWER" as const }),
  Object.freeze({ boundary: 171, from: "ANSWER" as const, to: "TWINKLE" as const }),
]);

function mix(left: number, right: number, amount: number): number {
  if (amount <= 0) return left;
  if (amount >= 1) return right;
  return left + (right - left) * amount;
}

function mixColor(
  left: Readonly<PhaseColorSnapshot>,
  right: Readonly<PhaseColorSnapshot>,
  amount: number,
): Readonly<PhaseColorSnapshot> {
  return color(
    mix(left.r, right.r, amount),
    mix(left.g, right.g, amount),
    mix(left.b, right.b, amount),
  );
}

function mixDirection(
  left: Readonly<RailScenePointSnapshot>,
  right: Readonly<RailScenePointSnapshot>,
  amount: number,
): Readonly<RailScenePointSnapshot> {
  return direction(
    mix(left.x, right.x, amount),
    mix(left.y, right.y, amount),
    mix(left.z, right.z, amount),
  );
}

function mixChannels(
  left: Readonly<PhasePreset>,
  right: Readonly<PhasePreset>,
  amount: number,
): Readonly<PhaseDirectorChannels> {
  return Object.freeze({
    background: mixColor(left.background, right.background, amount),
    fog: Object.freeze({
      color: mixColor(left.fog.color, right.fog.color, amount),
      density: mix(left.fog.density, right.fog.density, amount),
    }),
    ambient: Object.freeze({
      color: mixColor(left.ambient.color, right.ambient.color, amount),
      intensity: mix(left.ambient.intensity, right.ambient.intensity, amount),
    }),
    sun: Object.freeze({
      color: mixColor(left.sun.color, right.sun.color, amount),
      intensity: mix(left.sun.intensity, right.sun.intensity, amount),
      direction: mixDirection(left.sun.direction, right.sun.direction, amount),
    }),
    exposure: mix(left.exposure, right.exposure, amount),
    material: mix(left.material, right.material, amount),
    particle: mix(left.particle, right.particle, amount),
    audioLayer: mix(left.audioLayer, right.audioLayer, amount),
  });
}

export function phaseDirectorSnapshotAt(storyTime: number): Readonly<PhaseDirectorSnapshot> {
  if (!Number.isFinite(storyTime) || storyTime < 0 || storyTime > 180) {
    throw new RangeError("PhaseDirector story time must be within the 180 second journey.");
  }
  for (const transition of PHASE_TRANSITIONS) {
    const start = transition.boundary - PHASE_BLEND_HALF_SECONDS;
    const end = transition.boundary + PHASE_BLEND_HALF_SECONDS;
    if (storyTime < start || storyTime > end) continue;
    const raw = (storyTime - start) / PHASE_BLEND_DURATION_SECONDS;
    const blend01 = raw * raw * (3 - 2 * raw);
    return Object.freeze({
      storyTime,
      fromPhase: transition.from,
      toPhase: transition.to,
      blend01,
      transitionBoundarySeconds: transition.boundary,
      transitionStartSeconds: start,
      transitionEndSeconds: end,
      channels: mixChannels(PHASE_PRESETS[transition.from], PHASE_PRESETS[transition.to], blend01),
    });
  }
  const phase = phaseAt(storyTime);
  return Object.freeze({
    storyTime,
    fromPhase: phase,
    toPhase: phase,
    blend01: 0,
    transitionBoundarySeconds: null,
    transitionStartSeconds: null,
    transitionEndSeconds: null,
    channels: PHASE_PRESETS[phase],
  });
}

export const LIFE_EARTH_CONTINUITY_THRESHOLDS = Object.freeze({
  sampleFrames: 120,
  maxCameraJumpSceneUnits: LIFE_EARTH_MAX_CAMERA_JUMP_SCENE_UNITS,
  maxBlackFrames: 0,
  maxMonochromeFrames: 0,
  maxRuntimeCompileDelta: 0,
  maxStillFrameRatio: 0.05,
  maxMissingCurrentChunkFrames: 0,
  maxMissingCameraChunkFrames: 0,
  maxMissingNextChunkFramesBeforeBoundary: 0,
});

export interface LifeEarthContinuityObservation {
  readonly storyTime: number;
  readonly cameraPosition: Readonly<RailScenePointSnapshot>;
  readonly backgroundColor: Readonly<PhaseColorSnapshot>;
  readonly runtimeCompileEvents: number;
  readonly currentChunkReady: boolean;
  readonly cameraChunkReady: boolean;
  readonly nextChunkReadyBeforeBoundary: boolean;
}

export interface LifeEarthContinuitySnapshot {
  readonly complete: boolean;
  readonly passed: boolean | null;
  readonly sampleFrames: number;
  readonly blackFrames: number;
  readonly monochromeFrames: number;
  readonly runtimeCompileDelta: number;
  readonly maxCameraJumpSceneUnits: number;
  readonly stillFrames: number;
  readonly stillFrameRatio: number;
  readonly currentChunkMissingFrames: number;
  readonly cameraChunkMissingFrames: number;
  readonly nextChunkMissingFramesBeforeBoundary: number;
  readonly thresholds: typeof LIFE_EARTH_CONTINUITY_THRESHOLDS;
}

export class LifeEarthContinuityTrace {
  #previous: Readonly<LifeEarthContinuityObservation> | null = null;
  #compileBaseline: number | null = null;
  #maximumCompileEvents = 0;
  #sampleFrames = 0;
  #blackFrames = 0;
  #monochromeFrames = 0;
  #maxCameraJumpSceneUnits = 0;
  #stillFrames = 0;
  #currentChunkMissingFrames = 0;
  #cameraChunkMissingFrames = 0;
  #nextChunkMissingFramesBeforeBoundary = 0;

  observe(observation: Readonly<LifeEarthContinuityObservation>): void {
    if (!Number.isFinite(observation.storyTime)) {
      throw new RangeError("Continuity trace story time must be finite.");
    }
    if (!Number.isSafeInteger(observation.runtimeCompileEvents) || observation.runtimeCompileEvents < 0) {
      throw new RangeError("Continuity trace compile events must be a non-negative safe integer.");
    }
    if (this.#previous && observation.storyTime < this.#previous.storyTime) this.#reset();
    const previous = this.#previous;
    this.#previous = Object.freeze({
      storyTime: observation.storyTime,
      cameraPosition: Object.freeze({ ...observation.cameraPosition }),
      backgroundColor: Object.freeze({ ...observation.backgroundColor }),
      runtimeCompileEvents: observation.runtimeCompileEvents,
      currentChunkReady: Boolean(observation.currentChunkReady),
      cameraChunkReady: Boolean(observation.cameraChunkReady),
      nextChunkReadyBeforeBoundary: Boolean(observation.nextChunkReadyBeforeBoundary),
    });
    if (observation.storyTime <= LIFE_EARTH_TRACE_START_SECONDS && this.#sampleFrames === 0) {
      this.#compileBaseline = observation.runtimeCompileEvents;
      this.#maximumCompileEvents = observation.runtimeCompileEvents;
    }
    if (
      previous === null
      || observation.storyTime <= previous.storyTime
      || observation.storyTime <= LIFE_EARTH_TRACE_START_SECONDS
      || observation.storyTime > LIFE_EARTH_TRACE_END_SECONDS + 1e-6
      || this.#sampleFrames >= LIFE_EARTH_CONTINUITY_THRESHOLDS.sampleFrames
    ) return;

    if (this.#compileBaseline === null) this.#compileBaseline = previous.runtimeCompileEvents;
    this.#maximumCompileEvents = Math.max(this.#maximumCompileEvents, observation.runtimeCompileEvents);
    const cameraJump = Math.hypot(
      observation.cameraPosition.x - previous.cameraPosition.x,
      observation.cameraPosition.y - previous.cameraPosition.y,
      observation.cameraPosition.z - previous.cameraPosition.z,
    );
    this.#maxCameraJumpSceneUnits = Math.max(this.#maxCameraJumpSceneUnits, cameraJump);
    if (cameraJump <= STILL_CAMERA_DELTA_THRESHOLD) this.#stillFrames += 1;
    const luminance = observation.backgroundColor.r * 0.2126
      + observation.backgroundColor.g * 0.7152
      + observation.backgroundColor.b * 0.0722;
    if (luminance <= BLACK_LUMINANCE_THRESHOLD) this.#blackFrames += 1;
    const chroma = Math.max(
      observation.backgroundColor.r,
      observation.backgroundColor.g,
      observation.backgroundColor.b,
    ) - Math.min(
      observation.backgroundColor.r,
      observation.backgroundColor.g,
      observation.backgroundColor.b,
    );
    if (chroma <= MONOCHROME_CHROMA_THRESHOLD) this.#monochromeFrames += 1;
    if (!observation.currentChunkReady) this.#currentChunkMissingFrames += 1;
    if (!observation.cameraChunkReady) this.#cameraChunkMissingFrames += 1;
    if (observation.storyTime < 36 && !observation.nextChunkReadyBeforeBoundary) {
      this.#nextChunkMissingFramesBeforeBoundary += 1;
    }
    this.#sampleFrames += 1;
  }

  snapshot(): Readonly<LifeEarthContinuitySnapshot> {
    const complete = this.#sampleFrames >= LIFE_EARTH_CONTINUITY_THRESHOLDS.sampleFrames;
    const runtimeCompileDelta = this.#compileBaseline === null
      ? 0
      : Math.max(0, this.#maximumCompileEvents - this.#compileBaseline);
    const stillFrameRatio = this.#sampleFrames === 0 ? 0 : this.#stillFrames / this.#sampleFrames;
    const passed = complete
      ? this.#blackFrames <= LIFE_EARTH_CONTINUITY_THRESHOLDS.maxBlackFrames
        && this.#monochromeFrames <= LIFE_EARTH_CONTINUITY_THRESHOLDS.maxMonochromeFrames
        && runtimeCompileDelta <= LIFE_EARTH_CONTINUITY_THRESHOLDS.maxRuntimeCompileDelta
        && this.#maxCameraJumpSceneUnits <= LIFE_EARTH_CONTINUITY_THRESHOLDS.maxCameraJumpSceneUnits
        && stillFrameRatio <= LIFE_EARTH_CONTINUITY_THRESHOLDS.maxStillFrameRatio
        && this.#currentChunkMissingFrames <= LIFE_EARTH_CONTINUITY_THRESHOLDS.maxMissingCurrentChunkFrames
        && this.#cameraChunkMissingFrames <= LIFE_EARTH_CONTINUITY_THRESHOLDS.maxMissingCameraChunkFrames
        && this.#nextChunkMissingFramesBeforeBoundary
          <= LIFE_EARTH_CONTINUITY_THRESHOLDS.maxMissingNextChunkFramesBeforeBoundary
      : null;
    return Object.freeze({
      complete,
      passed,
      sampleFrames: this.#sampleFrames,
      blackFrames: this.#blackFrames,
      monochromeFrames: this.#monochromeFrames,
      runtimeCompileDelta,
      maxCameraJumpSceneUnits: this.#maxCameraJumpSceneUnits,
      stillFrames: this.#stillFrames,
      stillFrameRatio,
      currentChunkMissingFrames: this.#currentChunkMissingFrames,
      cameraChunkMissingFrames: this.#cameraChunkMissingFrames,
      nextChunkMissingFramesBeforeBoundary: this.#nextChunkMissingFramesBeforeBoundary,
      thresholds: LIFE_EARTH_CONTINUITY_THRESHOLDS,
    });
  }

  #reset(): void {
    this.#previous = null;
    this.#compileBaseline = null;
    this.#maximumCompileEvents = 0;
    this.#sampleFrames = 0;
    this.#blackFrames = 0;
    this.#monochromeFrames = 0;
    this.#maxCameraJumpSceneUnits = 0;
    this.#stillFrames = 0;
    this.#currentChunkMissingFrames = 0;
    this.#cameraChunkMissingFrames = 0;
    this.#nextChunkMissingFramesBeforeBoundary = 0;
  }
}
