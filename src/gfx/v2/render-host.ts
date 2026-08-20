import {
  RENDER_HISTORY_INVALIDATION_REASONS,
  type BackendRuntimeEvent,
  type JourneyRenderSnapshot,
  type RenderBackendFrameTelemetry,
  type RenderCompileStepDescriptor,
  type RenderCompileStepPhase,
  type RenderCompileStepRunner,
  type RenderHostDependencies,
  type RenderHostEvent,
  type RenderHostLifecycle,
  type RenderHostProbeEvent,
  type RenderHostProbeSnapshot,
  type RenderHistoryInvalidation,
  type RenderHistoryInvalidationReason,
  type RenderPass,
  type RenderPassRecorder,
  type RenderPrecompileReceipt,
  type RenderOperationClock,
  type RenderQualityProfile,
  type RenderResourceSnapshot,
  type RenderViewport,
  type RenderWarmupScheduler,
  type Unsubscribe,
} from "./contracts";
import { RENDER_COMPILE_PHASES } from "./contracts";
import { GFX_TELEMETRY_RUNTIME_SPIKE_MS } from "./telemetry/contracts";
import type {
  GfxFrameTelemetryInput,
  GfxOperationalEventInput,
  GfxTelemetrySink,
} from "./telemetry/contracts";
import {
  attachRenderHostCleanupFailures,
  hostError,
  immutableRenderHostAggregate,
  lifecycleError,
  RenderHostError,
  replaceRenderHostErrorCause,
  renderHostErrorCause,
} from "./errors";

const hostIntrinsicAggregateError = AggregateError;
const hostIntrinsicError = Error;
const hostIntrinsicMathMax = Math.max;
const hostIntrinsicNumberIsFinite = Number.isFinite;
const hostIntrinsicNumberIsSafeInteger = Number.isSafeInteger;
const hostIntrinsicObjectFreeze = Object.freeze;
const hostIntrinsicObjectIs = Object.is;
const hostIntrinsicPromise = Promise;
const hostIntrinsicPromiseAllSettled = Promise.allSettled;
const hostIntrinsicPromiseThen = Promise.prototype.then;
const hostIntrinsicReflectApply = Reflect.apply;
const hostIntrinsicReflectConstruct = Reflect.construct;
const hostIntrinsicReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const hostIntrinsicReflectGetPrototypeOf = Reflect.getPrototypeOf;
const hostIntrinsicReflectOwnKeys = Reflect.ownKeys;
const hostIntrinsicRegExpTest = RegExp.prototype.test;
const hostIntrinsicSet = Set;
const hostIntrinsicSetAdd = Set.prototype.add;
const hostIntrinsicSetDelete = Set.prototype.delete;
const hostIntrinsicSetForEach = Set.prototype.forEach;
const hostIntrinsicSetHas = Set.prototype.has;
const hostIntrinsicSetSize = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!;
const RENDER_CONTEXT_SETTLE_MS = 500;
const RENDER_COMPILE_COOLDOWN_MS = 4;

function captureRenderPass(
  pass: RenderPass,
  assertContinue: () => void = () => undefined,
): Readonly<RenderPass> {
  const name = pass.name;
  assertContinue();
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("A render pass requires non-empty name and kind fields.");
  }
  const kind = pass.kind;
  assertContinue();
  if (typeof kind !== "string" || !kind.trim()) {
    throw new TypeError("A render pass requires non-empty name and kind fields.");
  }
  const variant = pass.variant;
  assertContinue();
  if (variant !== undefined && (typeof variant !== "string" || !variant.trim())) {
    throw new TypeError("A render pass variant must be a non-empty string when present.");
  }
  const scene = pass.scene;
  assertContinue();
  const camera = pass.camera;
  assertContinue();
  const payload = pass.payload;
  assertContinue();
  const captured = variant === undefined
    ? { name, kind, scene, camera }
    : { name, kind, variant, scene, camera };
  return Object.freeze(payload === undefined
    ? captured
    : { ...captured, payload });
}

function captureWarmupPasses(
  passes: readonly RenderPass[],
  assertContinue: () => void,
): readonly RenderPass[] {
  const length = passes.length;
  assertContinue();
  if (!Number.isSafeInteger(length) || length < 0 || length > 256) {
    throw new RangeError("A warm-up inventory accepts at most 256 render passes.");
  }
  const captured: RenderPass[] = [];
  for (let index = 0; index < length; index += 1) {
    const present = Object.prototype.hasOwnProperty.call(passes, index);
    assertContinue();
    if (!present) throw new TypeError("Warm-up pass inventories must be dense.");
    const pass = passes[index];
    assertContinue();
    captured.push(captureRenderPass(pass!, assertContinue));
  }
  return Object.freeze(captured);
}

class FramePassRecorder implements RenderPassRecorder {
  readonly #passes: RenderPass[] = [];
  readonly #assertContinue: () => void;

  constructor(assertContinue: () => void = () => undefined) {
    this.#assertContinue = assertContinue;
  }

  get passes(): readonly RenderPass[] {
    return Object.freeze(this.#passes.slice());
  }

  record(pass: RenderPass): void {
    this.#passes.push(captureRenderPass(pass, this.#assertContinue));
  }

  draw(name: string, scene: unknown, camera: unknown, kind = "scene"): void {
    this.record({ name, kind, scene, camera });
  }
}

export interface RenderHostInstrumentation {
  readonly telemetry: GfxTelemetrySink;
  readonly now: () => number;
}

interface CapturedRenderHostInstrumentation {
  readonly now: () => number;
  readonly recordFrame: (sample: Readonly<GfxFrameTelemetryInput>) => void;
  readonly recordOperation: (event: Readonly<GfxOperationalEventInput>) => void;
}

interface PendingDroppedTelemetryFrame {
  readonly frameId: number;
  readonly rafTimestampMs: number;
  readonly storyTime: number;
  readonly qualityTier: RenderQualityProfile["tier"];
}

const MAXIMUM_RENDER_COMPILE_STEPS = 8_192;
const MAXIMUM_RENDER_COMPILE_DESCRIPTOR_ID_LENGTH = 96;
const MAXIMUM_RENDER_COMPILE_PROFILE_ID_LENGTH = 64;
const INTERNAL_COMPILE_ID = /^[a-z0-9][a-z0-9:-]*$/;
const INTERNAL_COMPILE_PROFILE_ID = /^[a-z0-9][a-z0-9-]*$/;

type CompileWarmupState = {
  planned: number;
  started: number;
  completed: number;
  failed: number;
  measured: number;
  maxDuration: number | null;
  overBudget: number;
  unmeasured: boolean;
  finalized: boolean;
  terminated: boolean;
  phaseCounts: Record<RenderCompileStepPhase, number>;
};

type CompileRunnerSession = {
  open: boolean;
  running: boolean;
  readonly ids: Set<string>;
  readonly inFlight: Set<Promise<void>>;
  violation: Error | null;
};

function emptyCompilePhaseCounts(): Record<RenderCompileStepPhase, number> {
  return {
    "runtime-object": 0,
    "material-isolated": 0,
    "material-runtime-topology": 0,
    "output-first-use": 0,
  };
}

function safeIntegerCount(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !hostIntrinsicNumberIsSafeInteger(value)
    || value < 0
    || value > MAXIMUM_RENDER_COMPILE_STEPS
    || hostIntrinsicObjectIs(value, -0)
  ) {
    throw new RangeError(`${label} must be a non-negative safe integer no greater than ${MAXIMUM_RENDER_COMPILE_STEPS}.`);
  }
  return value;
}

function captureCompileDescriptor(
  descriptor: Readonly<RenderCompileStepDescriptor>,
): Readonly<RenderCompileStepDescriptor> {
  if ((typeof descriptor !== "object" || descriptor === null) && typeof descriptor !== "function") {
    throw new TypeError("A compile step descriptor must be an object.");
  }
  const id = instrumentationOwnDataValue(descriptor, "id", "compile descriptor");
  const phase = instrumentationOwnDataValue(descriptor, "phase", "compile descriptor");
  const profileId = instrumentationOwnDataValue(
    descriptor,
    "profileId",
    "compile descriptor",
  );
  if (
    typeof id !== "string"
    || id.length === 0
    || id.length > MAXIMUM_RENDER_COMPILE_DESCRIPTOR_ID_LENGTH
    || !hostIntrinsicReflectApply(hostIntrinsicRegExpTest, INTERNAL_COMPILE_ID, [id])
  ) {
    throw new TypeError("A compile descriptor id must be a bounded internal token.");
  }
  if (!isCompileStepPhase(phase)) {
    throw new TypeError("A compile descriptor phase is invalid.");
  }
  if (
    profileId !== null
    && (
      typeof profileId !== "string"
      || profileId.length === 0
      || profileId.length > MAXIMUM_RENDER_COMPILE_PROFILE_ID_LENGTH
      || !hostIntrinsicReflectApply(
        hostIntrinsicRegExpTest,
        INTERNAL_COMPILE_PROFILE_ID,
        [profileId],
      )
    )
  ) {
    throw new TypeError("A compile descriptor profile id must be null or a bounded internal token.");
  }
  return hostIntrinsicObjectFreeze({
    id,
    phase: phase as RenderCompileStepPhase,
    profileId: profileId as string | null,
  });
}

function isCompileStepPhase(value: unknown): value is RenderCompileStepPhase {
  return value === "runtime-object"
    || value === "material-isolated"
    || value === "material-runtime-topology"
    || value === "output-first-use";
}

function capturePrecompileReceipt(
  receipt: Readonly<RenderPrecompileReceipt>,
): Readonly<RenderPrecompileReceipt> {
  if ((typeof receipt !== "object" || receipt === null) && typeof receipt !== "function") {
    throw new TypeError("A precompile receipt must be an object.");
  }
  const plannedSteps = safeIntegerCount(
    instrumentationOwnDataValue(receipt, "plannedSteps", "precompile receipt"),
    "precompile receipt plannedSteps",
  );
  const completedSteps = safeIntegerCount(
    instrumentationOwnDataValue(receipt, "completedSteps", "precompile receipt"),
    "precompile receipt completedSteps",
  );
  const phaseCountsSource = instrumentationOwnDataValue(
    receipt,
    "phaseCounts",
    "precompile receipt",
  );
  if (
    (typeof phaseCountsSource !== "object" || phaseCountsSource === null)
    && typeof phaseCountsSource !== "function"
  ) {
    throw new TypeError("A precompile receipt phaseCounts value must be an object.");
  }
  let keys: readonly PropertyKey[];
  try {
    keys = hostIntrinsicReflectOwnKeys(phaseCountsSource);
  } catch {
    throw new TypeError("A precompile receipt phaseCounts value could not be inspected.");
  }
  if (
    keys.length !== 4
  ) {
    throw new TypeError("A precompile receipt must contain exactly the four compile phase counts.");
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (!isCompileStepPhase(keys[index])) {
      throw new TypeError("A precompile receipt must contain exactly the four compile phase counts.");
    }
  }
  const phaseCounts = emptyCompilePhaseCounts();
  let phaseTotal = 0;
  for (let index = 0; index < 4; index += 1) {
    const phase = RENDER_COMPILE_PHASES[index]!;
    const count = safeIntegerCount(
      instrumentationOwnDataValue(phaseCountsSource, phase, "precompile receipt phaseCounts"),
      `precompile receipt ${phase} count`,
    );
    phaseCounts[phase] = count;
    phaseTotal += count;
  }
  if (phaseTotal !== plannedSteps || completedSteps > plannedSteps) {
    throw new RangeError("A precompile receipt has inconsistent planned, completed, or phase counts.");
  }
  return hostIntrinsicObjectFreeze({
    plannedSteps,
    completedSteps,
    phaseCounts: hostIntrinsicObjectFreeze(phaseCounts),
  });
}

function safeDataMethod(
  receiver: object,
  key: PropertyKey,
): ((...args: unknown[]) => unknown) | null {
  let owner: object | null = receiver;
  for (let depth = 0; depth < 8 && owner !== null; depth += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = hostIntrinsicReflectGetOwnPropertyDescriptor(owner, key);
    } catch {
      return null;
    }
    if (descriptor) {
      return "value" in descriptor && typeof descriptor.value === "function"
        ? descriptor.value as (...args: unknown[]) => unknown
        : null;
    }
    try {
      owner = hostIntrinsicReflectGetPrototypeOf(owner);
    } catch {
      return null;
    }
  }
  return null;
}

function safeAccessorGetter(
  receiver: object,
  key: PropertyKey,
): ((...args: unknown[]) => unknown) | null {
  let owner: object | null = receiver;
  for (let depth = 0; depth < 8 && owner !== null; depth += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = hostIntrinsicReflectGetOwnPropertyDescriptor(owner, key);
    } catch {
      return null;
    }
    if (descriptor) {
      return !("value" in descriptor) && typeof descriptor.get === "function"
        ? descriptor.get as (...args: unknown[]) => unknown
        : null;
    }
    try {
      owner = hostIntrinsicReflectGetPrototypeOf(owner);
    } catch {
      return null;
    }
  }
  return null;
}

function optionalOwnDataValue(source: object, key: PropertyKey): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = hostIntrinsicReflectGetOwnPropertyDescriptor(source, key);
  } catch {
    return undefined;
  }
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function captureExactPromise(candidate: unknown): Promise<void> {
  return new hostIntrinsicPromise<void>((resolve, reject) => {
    try {
      hostIntrinsicReflectApply(hostIntrinsicPromiseThen, candidate, [
        () => resolve(),
        reject,
      ]);
    } catch (error: unknown) {
      reject(error);
    }
  });
}

/** Captures browser scheduling primitives once without consulting accessor-backed globals. */
export function createBrowserRenderWarmupScheduler(
  scope: object = globalThis,
): Readonly<RenderWarmupScheduler> {
  const setTimeoutMethod = safeDataMethod(scope, "setTimeout");
  const scheduler = optionalOwnDataValue(scope, "scheduler");
  const schedulerYield = (
    (typeof scheduler === "object" && scheduler !== null) || typeof scheduler === "function"
  ) ? safeDataMethod(scheduler as object, "yield") : null;
  const messageChannel = optionalOwnDataValue(scope, "MessageChannel");
  const messageChannelPrototype = typeof messageChannel === "function"
    ? optionalOwnDataValue(messageChannel as object, "prototype")
    : undefined;
  const messageChannelPrototypeObject = (
    (typeof messageChannelPrototype === "object" && messageChannelPrototype !== null)
    || typeof messageChannelPrototype === "function"
  ) ? messageChannelPrototype as object : null;
  const port1Getter = messageChannelPrototypeObject === null
    ? null
    : safeAccessorGetter(messageChannelPrototypeObject, "port1");
  const port2Getter = messageChannelPrototypeObject === null
    ? null
    : safeAccessorGetter(messageChannelPrototypeObject, "port2");
  const waitForTimer = (delayMs: number): Promise<void> => {
    if (setTimeoutMethod === null) {
      return new hostIntrinsicPromise<void>((_resolve, reject) => {
        reject(new hostIntrinsicError("A safe renderer-context settle timer is unavailable."));
      });
    }
    return new hostIntrinsicPromise<void>((resolve, reject) => {
      try {
        hostIntrinsicReflectApply(setTimeoutMethod, scope, [resolve, delayMs]);
      } catch (error: unknown) {
        reject(error);
      }
    });
  };
  return hostIntrinsicObjectFreeze({
    settleBeforeWarmup(): Promise<void> {
      return waitForTimer(RENDER_CONTEXT_SETTLE_MS);
    },
    async yieldToMain(): Promise<void> {
      if (schedulerYield !== null) {
        await hostIntrinsicReflectApply(schedulerYield, scheduler, []);
        if (setTimeoutMethod !== null) await waitForTimer(RENDER_COMPILE_COOLDOWN_MS);
        return;
      }
      if (
        typeof messageChannel !== "function"
        || port1Getter === null
        || port2Getter === null
      ) {
        throw new Error("A safe main-thread warm-up scheduler is unavailable.");
      }
      const channel = hostIntrinsicReflectConstruct(messageChannel, []) as object;
      let port1: object | null = null;
      let port2: object | null = null;
      let close1: ((...args: unknown[]) => unknown) | null = null;
      let close2: ((...args: unknown[]) => unknown) | null = null;
      let cleanupAttempted = false;
      const close = () => {
        if (cleanupAttempted) return;
        cleanupAttempted = true;
        let firstFailed = false;
        let firstFailure: unknown;
        let secondFailed = false;
        let secondFailure: unknown;
        if (close1 !== null && port1 !== null) {
          try {
            hostIntrinsicReflectApply(close1, port1, []);
          } catch (error: unknown) {
            firstFailed = true;
            firstFailure = error;
          }
        }
        if (close2 !== null && port2 !== null) {
          try {
            hostIntrinsicReflectApply(close2, port2, []);
          } catch (error: unknown) {
            secondFailed = true;
            secondFailure = error;
          }
        }
        if (firstFailed && secondFailed) {
          throw new hostIntrinsicAggregateError(
            [firstFailure, secondFailure],
            "Both MessageChannel warm-up ports failed to close.",
          );
        }
        if (firstFailed) throw firstFailure;
        if (secondFailed) throw secondFailure;
      };
      let addEventListener: ((...args: unknown[]) => unknown);
      let start: ((...args: unknown[]) => unknown) | null;
      let postMessage: ((...args: unknown[]) => unknown);
      try {
        const observedPort1 = hostIntrinsicReflectApply(port1Getter, channel, []);
        if (
          (typeof observedPort1 !== "object" || observedPort1 === null)
          && typeof observedPort1 !== "function"
        ) {
          throw new hostIntrinsicError("A MessageChannel warm-up task could not acquire port1.");
        }
        port1 = observedPort1 as object;
        close1 = safeDataMethod(port1, "close");
        const observedPort2 = hostIntrinsicReflectApply(port2Getter, channel, []);
        if (
          (typeof observedPort2 !== "object" || observedPort2 === null)
          && typeof observedPort2 !== "function"
        ) {
          throw new hostIntrinsicError("A MessageChannel warm-up task could not acquire port2.");
        }
        port2 = observedPort2 as object;
        close2 = safeDataMethod(port2, "close");
        const observedAddEventListener = safeDataMethod(port1, "addEventListener");
        start = safeDataMethod(port1, "start");
        const observedPostMessage = safeDataMethod(port2, "postMessage");
        if (observedAddEventListener === null || observedPostMessage === null) {
          throw new hostIntrinsicError("A MessageChannel warm-up task lacks safe data methods.");
        }
        addEventListener = observedAddEventListener;
        postMessage = observedPostMessage;
      } catch (error: unknown) {
        try {
          close();
        } catch {
          // Port acquisition/setup failure remains authoritative.
        }
        throw error;
      }
      await new hostIntrinsicPromise<void>((resolve, reject) => {
        let settled = false;
        const complete = () => {
          if (settled) return;
          settled = true;
          try {
            close();
            resolve();
          } catch (error: unknown) {
            reject(error);
          }
        };
        try {
          hostIntrinsicReflectApply(addEventListener, port1, ["message", complete, { once: true }]);
          if (settled) return;
          if (start) hostIntrinsicReflectApply(start, port1, []);
          if (settled) return;
          hostIntrinsicReflectApply(postMessage, port2, [undefined]);
        } catch (error: unknown) {
          settled = true;
          try {
            close();
          } catch {
            // The scheduling failure remains authoritative.
          }
          reject(error);
        }
      });
      if (setTimeoutMethod !== null) await waitForTimer(RENDER_COMPILE_COOLDOWN_MS);
    },
  });
}

function instrumentationOwnDataValue(
  input: object,
  key: PropertyKey,
  label: string,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = hostIntrinsicReflectGetOwnPropertyDescriptor(input, key);
  } catch {
    throw new TypeError(`${label}.${String(key)} could not be inspected.`);
  }
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`${label}.${String(key)} must be an own data property.`);
  }
  return descriptor.value;
}

function instrumentationMethod(
  receiver: object,
  key: "recordFrame" | "recordOperation",
): (...args: unknown[]) => unknown {
  let owner: object | null = receiver;
  for (let depth = 0; depth < 8 && owner !== null; depth += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = hostIntrinsicReflectGetOwnPropertyDescriptor(owner, key);
    } catch {
      throw new TypeError(`RenderHost telemetry ${key} could not be inspected.`);
    }
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`RenderHost telemetry ${key} must be a data method.`);
      }
      return descriptor.value as (...args: unknown[]) => unknown;
    }
    try {
      owner = hostIntrinsicReflectGetPrototypeOf(owner);
    } catch {
      throw new TypeError(`RenderHost telemetry ${key} prototype could not be inspected.`);
    }
  }
  throw new TypeError(`RenderHost telemetry ${key} is missing.`);
}

function captureRenderHostInstrumentation(
  input: Readonly<RenderHostInstrumentation>,
): Readonly<CapturedRenderHostInstrumentation> {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("RenderHost instrumentation must be an object.");
  }
  const telemetry = instrumentationOwnDataValue(input, "telemetry", "instrumentation");
  const now = instrumentationOwnDataValue(input, "now", "instrumentation");
  if ((typeof telemetry !== "object" || telemetry === null) && typeof telemetry !== "function") {
    throw new TypeError("RenderHost instrumentation telemetry must be an object.");
  }
  if (typeof now !== "function") {
    throw new TypeError("RenderHost instrumentation now must be a function.");
  }
  const recordFrame = instrumentationMethod(telemetry as object, "recordFrame");
  const recordOperation = instrumentationMethod(telemetry as object, "recordOperation");
  return Object.freeze({
    now: () => hostIntrinsicReflectApply(now, input, []),
    recordFrame: (sample: Readonly<GfxFrameTelemetryInput>) => {
      hostIntrinsicReflectApply(recordFrame, telemetry, [sample]);
    },
    recordOperation: (event: Readonly<GfxOperationalEventInput>) => {
      hostIntrinsicReflectApply(recordOperation, telemetry, [event]);
    },
  });
}

const UNAVAILABLE_FRAME_TELEMETRY = Object.freeze({
  available: false,
  drawCalls: null,
  triangles: null,
  lines: null,
  points: null,
  pixelRatio: null,
  drawingBufferWidth: null,
  drawingBufferHeight: null,
  gpuTimeMs: null,
}) satisfies Readonly<RenderBackendFrameTelemetry>;

const EMPTY_TELEMETRY_RESOURCES = Object.freeze({
  geometries: 0,
  textures: 0,
  renderTargets: 0,
  programs: 0,
  nodes: 0,
  objects: 0,
  subscribers: 0,
  pendingUploads: 0,
}) satisfies Readonly<RenderResourceSnapshot>;

function freezeSnapshot(snapshot: JourneyRenderSnapshot): JourneyRenderSnapshot {
  const sourcePulses = snapshot.pulses;
  const sourcePosition = snapshot.position;
  const sourceVelocity = snapshot.velocity;
  const pulses = sourcePulses.map((pulse) => Object.freeze({
    id: pulse.id,
    journeyTime: pulse.journeyTime,
    x: pulse.x,
    y: pulse.y,
    phase: pulse.phase,
    source: pulse.source,
    value: pulse.value,
  }));

  return Object.freeze({
    seed: snapshot.seed,
    storyTime: snapshot.storyTime,
    phase: snapshot.phase,
    shotId: snapshot.shotId,
    position: Object.freeze({ x: sourcePosition.x, y: sourcePosition.y }),
    velocity: Object.freeze({ x: sourceVelocity.x, y: sourceVelocity.y }),
    pulses: Object.freeze(pulses),
    answerAt: snapshot.answerAt,
    finished: snapshot.finished,
  });
}

function freezeQuality(profile: Readonly<RenderQualityProfile>): Readonly<RenderQualityProfile> {
  return Object.freeze({
    tier: profile.tier,
    pixelRatio: profile.pixelRatio,
    uploadBudgetMs: profile.uploadBudgetMs,
    features: Object.freeze({ ...profile.features }),
  });
}

function freezeWarmupProfiles(
  profiles: readonly Readonly<RenderQualityProfile>[],
): readonly Readonly<RenderQualityProfile>[] {
  const length = profiles.length;
  if (!Number.isSafeInteger(length) || length < 1 || length > 16) {
    throw new RangeError("Warm-up requires between one and sixteen quality profiles.");
  }
  const frozen: Readonly<RenderQualityProfile>[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(profiles, index)) {
      throw new TypeError("Warm-up quality profiles must be dense.");
    }
    frozen.push(freezeQuality(profiles[index]!));
  }
  return Object.freeze(frozen);
}

function qualityProfilesEqual(
  left: Readonly<RenderQualityProfile> | null,
  right: Readonly<RenderQualityProfile>,
): boolean {
  if (
    left === null
    || left.tier !== right.tier
    || left.pixelRatio !== right.pixelRatio
    || left.uploadBudgetMs !== right.uploadBudgetMs
  ) return false;
  const leftKeys = Object.keys(left.features);
  const rightKeys = Object.keys(right.features);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => left.features[key] === right.features[key]);
}

function freezeViewport(viewport: RenderViewport): RenderViewport {
  const width = viewport.width;
  const height = viewport.height;
  const pixelRatio = viewport.pixelRatio;
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || !Number.isFinite(pixelRatio)
    || width <= 0
    || height <= 0
    || pixelRatio <= 0
  ) {
    throw new RangeError("Render viewport dimensions and pixel ratio must be positive.");
  }
  return Object.freeze({
    width,
    height,
    pixelRatio,
  });
}

function deferredVoid() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject } as const;
}

type PrimitiveFailureCause = string | number | bigint | boolean | symbol | null | undefined;
type OwnPrimitiveFailureCause = Readonly<{ value: PrimitiveFailureCause }>;
const MAXIMUM_IMMUTABLE_FAILURE_AGGREGATE_DETAILS = 256;
const MAXIMUM_FAILURE_EVIDENCE_DEPTH = 256;
const MAXIMUM_FAILURE_EVIDENCE_NODES = 8_192;
const REBASABLE_PRIMARY_EVIDENCE_THRESHOLD = 4_096;
const OMIT_FAILURE_EVIDENCE = Symbol("omit-failure-evidence");
const immutableFailureEvidenceSnapshots = new WeakSet<object>();
const cleanupOperationAggregateSnapshots = new WeakSet<object>();
const EMPTY_CLEANUP_FAILURES: readonly unknown[] = Object.freeze([]);
const EMPTY_CLEANUP_FAILURE_CHANNELS: readonly (readonly unknown[])[] = Object.freeze([]);
const EMPTY_FULFILLED_CLEANUP_PROMISE = Promise.resolve(EMPTY_CLEANUP_FAILURES);
type CleanupFailureWorkspace = {
  readonly failureChannels: unknown[][];
  readonly failures: unknown[];
};
type FailureEvidenceLossReason =
  | "depth"
  | "ingress-budget"
  | "hostile-inspection"
  | "final-output";
const failureEvidenceLossReasons = new WeakMap<object, readonly FailureEvidenceLossReason[]>();
const failureEvidenceCarriedLossReasons = new WeakMap<
object,
readonly FailureEvidenceLossReason[]
>();

function failureEvidenceLossMarker(
  reasons: ReadonlySet<FailureEvidenceLossReason>,
  terminalComposition: boolean,
  omittedCleanupChannels = 0,
): RangeError {
  const ordered = [
    "depth",
    "ingress-budget",
    "hostile-inspection",
    "final-output",
  ].filter((reason): reason is FailureEvidenceLossReason => reasons.has(
    reason as FailureEvidenceLossReason,
  ));
  const details = ordered.map((reason) => {
    if (reason === "depth") return `safe-snapshot depth ${MAXIMUM_FAILURE_EVIDENCE_DEPTH}`;
    if (reason === "ingress-budget") {
      return `${MAXIMUM_FAILURE_EVIDENCE_NODES}-node ingress budget`;
    }
    if (reason === "hostile-inspection") return "hostile inspection";
    return `shared ${MAXIMUM_FAILURE_EVIDENCE_NODES}-node output budget`;
  }).join(", ");
  const omission = omittedCleanupChannels > 0
    ? ` Omitted ${omittedCleanupChannels} cleanup operation channel(s) because their bounded channel heads did not fit.`
    : "";
  const marker = new RangeError((terminalComposition
    ? `Terminal failure evidence composition retained loss from ${details}.`
    : `Failure evidence traversal exceeded ${details}.`) + omission);
  const immutable = freezeFailureEvidence(marker);
  failureEvidenceLossReasons.set(immutable, Object.freeze(ordered));
  return immutable;
}

function failureEvidenceReasons(value: unknown): readonly FailureEvidenceLossReason[] | null {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return null;
  }
  return failureEvidenceLossReasons.get(value as object) ?? null;
}

function carriedFailureEvidenceReasons(
  value: unknown,
): readonly FailureEvidenceLossReason[] | null {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return null;
  }
  return failureEvidenceReasons(value)
    ?? failureEvidenceCarriedLossReasons.get(value as object)
    ?? null;
}

function carryFailureEvidenceReasons(
  target: object,
  entries: readonly unknown[],
): void {
  const reasons = new Set<FailureEvidenceLossReason>();
  for (const entry of entries) {
    const carried = carriedFailureEvidenceReasons(entry);
    if (carried === null) continue;
    for (const reason of carried) reasons.add(reason);
  }
  if (reasons.size > 0) {
    failureEvidenceCarriedLossReasons.set(target, Object.freeze([...reasons]));
  }
}

type FailureEvidenceClassification = "aggregate" | "error" | "opaque" | "uninspectable";

function classifyFailureEvidence(value: unknown): FailureEvidenceClassification {
  try {
    if (value instanceof AggregateError) return "aggregate";
    if (value instanceof Error) return "error";
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      const candidate = value as {
        readonly cause?: unknown;
        readonly errors?: unknown;
        readonly name?: unknown;
      };
      const tag = Object.prototype.toString.call(value);
      const name = candidate.name;
      if (tag === "[object Error]" && name === "AggregateError") return "aggregate";
      if (tag === "[object Error]") return "error";
      let hasErrors = false;
      let hasCause = false;
      try {
        hasErrors = "errors" in candidate;
        hasCause = "cause" in candidate;
      } catch {
        return "uninspectable";
      }
      if (hasErrors) return "aggregate";
      if (hasCause) return "error";
    }
  } catch {
    return "uninspectable";
  }
  return "opaque";
}

type FailureEvidenceBudget = {
  deferTruncationMarker: boolean;
  exhausted: boolean;
  limitReason: "ingress-budget" | "final-output";
  lossReasons: Set<FailureEvidenceLossReason>;
  markerEmitted: boolean;
  maximumNodes: number;
  priorLossMarkerOmissions: number;
  terminalComposition: boolean;
  truncationMarkerCharged: boolean;
  usedNodes: number;
};

function failureEvidenceBudget(
  reservedOutputNodes = 0,
  maximumNodes = MAXIMUM_FAILURE_EVIDENCE_NODES,
  limitReason: "ingress-budget" | "final-output" = "ingress-budget",
  deferTruncationMarker = false,
): FailureEvidenceBudget {
  return {
    deferTruncationMarker,
    exhausted: false,
    limitReason,
    lossReasons: new Set<FailureEvidenceLossReason>(),
    markerEmitted: false,
    maximumNodes,
    priorLossMarkerOmissions: 0,
    terminalComposition: limitReason === "final-output",
    truncationMarkerCharged: false,
    usedNodes: reservedOutputNodes,
  };
}

function chargeFailureEvidenceNodes(
  budget: FailureEvidenceBudget,
  count = 1,
): boolean {
  if (
    budget.exhausted
    || !Number.isSafeInteger(count)
    || count < 0
    // Keep one node available for the single immutable provenance marker. The
    // enclosing Host aggregate is charged by its caller through the reserved
    // output count rather than being allowed to grow outside this budget.
    || budget.usedNodes + count > budget.maximumNodes - 1
  ) {
    budget.exhausted = true;
    return false;
  }
  budget.usedNodes += count;
  return true;
}

function truncateFailureEvidence(
  budget: FailureEvidenceBudget,
  reason: FailureEvidenceLossReason = budget.limitReason,
): RangeError | typeof OMIT_FAILURE_EVIDENCE {
  budget.lossReasons.add(reason);
  budget.truncationMarkerCharged = true;
  budget.exhausted = true;
  if (budget.deferTruncationMarker) return OMIT_FAILURE_EVIDENCE;
  if (budget.markerEmitted) return OMIT_FAILURE_EVIDENCE;
  budget.markerEmitted = true;
  budget.usedNodes += 1;
  return failureEvidenceLossMarker(
    budget.lossReasons,
    budget.terminalComposition,
  );
}

function freezeFailureEvidence<T extends object>(value: T): T {
  Object.freeze(value);
  immutableFailureEvidenceSnapshots.add(value);
  return value;
}

function ownPrimitiveFailureCause(value: object): OwnPrimitiveFailureCause | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, "cause");
  if (descriptor === undefined || !("value" in descriptor)) return null;
  const cause = descriptor.value;
  if (
    (typeof cause === "object" && cause !== null)
    || typeof cause === "function"
  ) return null;
  return Object.freeze({ value: cause as PrimitiveFailureCause });
}

function immutableAggregateFailureOccurrence(
  errors: readonly unknown[],
  message: string,
  ownCause: OwnPrimitiveFailureCause,
  budget: FailureEvidenceBudget,
  capturedPrimitiveCauses?: WeakMap<object, OwnPrimitiveFailureCause | null>,
): unknown {
  if (!chargeFailureEvidenceNodes(budget, 2)) {
    return truncateFailureEvidence(budget);
  }
  const immutableErrors: unknown[] = [];
  for (const error of errors) {
    const immutable = immutableFailureOccurrence(
      error,
      budget,
      capturedPrimitiveCauses?.get(error as object),
    );
    if (immutable !== OMIT_FAILURE_EVIDENCE) immutableErrors.push(immutable);
    if (budget.exhausted) break;
  }
  const aggregate = new AggregateError(immutableErrors, message);
  Object.defineProperty(aggregate, "cause", {
    configurable: true,
    value: ownCause.value,
    writable: true,
  });
  Object.freeze(aggregate.errors);
  const immutable = freezeFailureEvidence(aggregate);
  carryFailureEvidenceReasons(immutable, immutableErrors);
  return immutable;
}

function immutableFailureOccurrence(
  value: unknown,
  budget: FailureEvidenceBudget,
  capturedOwnPrimitiveCause?: OwnPrimitiveFailureCause | null,
): unknown {
  const hasIdentity = (typeof value === "object" && value !== null)
    || typeof value === "function";
  if (!hasIdentity) return value;
  if (immutableFailureEvidenceSnapshots.has(value as object)) return value;
  let message = "RenderHost cleanup operation failed.";
  try {
    const classification = classifyFailureEvidence(value);
    if (classification !== "error" && classification !== "aggregate") {
      throw new TypeError("opaque failure");
    }
    const observed = (value as Error).message;
    if (typeof observed === "string" && observed.length > 0) message = observed;
    // Capture own cause metadata before the AggregateError branch. Accessor
    // descriptors are never invoked, and object/function graphs are detached.
    const ownPrimitiveCause = capturedOwnPrimitiveCause === undefined
      ? ownPrimitiveFailureCause(value)
      : capturedOwnPrimitiveCause;
    if (classification === "aggregate") {
      const entries = (value as AggregateError).errors;
      if (
        !Array.isArray(entries)
        || entries.length > MAXIMUM_IMMUTABLE_FAILURE_AGGREGATE_DETAILS
      ) {
        throw new RangeError("aggregate snapshot width");
      }
      const wrapperNodes = ownPrimitiveCause === null ? 1 : 2;
      if (!chargeFailureEvidenceNodes(budget, wrapperNodes)) {
        return truncateFailureEvidence(budget);
      }
      const immutableEntries: unknown[] = [];
      for (const entry of entries) {
        const immutable = immutableFailureOccurrence(entry, budget);
        if (immutable !== OMIT_FAILURE_EVIDENCE) immutableEntries.push(immutable);
        if (budget.exhausted) break;
      }
      if (ownPrimitiveCause !== null) {
        const aggregate = new AggregateError(immutableEntries, message);
        Object.defineProperty(aggregate, "cause", {
          configurable: true,
          value: ownPrimitiveCause.value,
          writable: true,
        });
        Object.freeze(aggregate.errors);
        const immutable = freezeFailureEvidence(aggregate);
        carryFailureEvidenceReasons(immutable, immutableEntries);
        return immutable;
      }
      const aggregate = new AggregateError(immutableEntries, message);
      Object.freeze(aggregate.errors);
      const immutable = freezeFailureEvidence(aggregate);
      carryFailureEvidenceReasons(immutable, immutableEntries);
      return immutable;
    }

    if (!chargeFailureEvidenceNodes(budget, ownPrimitiveCause === null ? 1 : 2)) {
      return truncateFailureEvidence(budget);
    }
    const snapshot = value instanceof RangeError
      ? new RangeError(message)
      : value instanceof TypeError
        ? new TypeError(message)
        : new Error(message);
    if (ownPrimitiveCause !== null) {
      Object.defineProperty(snapshot, "cause", {
        configurable: true,
        value: ownPrimitiveCause.value,
        writable: true,
      });
    }
    return freezeFailureEvidence(snapshot);
  } catch {
    message = "Opaque RenderHost cleanup failure was sanitized.";
  }
  if (!chargeFailureEvidenceNodes(budget)) {
    return truncateFailureEvidence(budget);
  }
  const snapshot = new Error(message);
  return freezeFailureEvidence(snapshot);
}

/**
 * Owns the sole animation loop and all graphics lifecycle transitions. It never
 * exposes a renderer object and never mutates simulation state.
 */
export class RenderHost {
  readonly #dependencies: RenderHostDependencies;
  readonly #instrumentation: Readonly<CapturedRenderHostInstrumentation> | null;
  readonly #settleWarmupBeforeFirstStep: () => Promise<void>;
  readonly #yieldWarmupToMain: () => Promise<void>;
  readonly #errorOwner = Object.freeze({});
  #lifecycle: RenderHostLifecycle = "new";
  #snapshot: JourneyRenderSnapshot | null = null;
  #snapshotVersion = 0;
  #viewport: RenderViewport | null = null;
  #quality: Readonly<RenderQualityProfile> | null = null;
  #initializePromise: Promise<void> | null = null;
  #initializeSettled = false;
  #disposePromise: Promise<void> | null = null;
  #cleanupPromise: Promise<readonly unknown[]> | null = null;
  #cleanupPromiseResult: readonly unknown[] = EMPTY_CLEANUP_FAILURES;
  #cleanupFailureWorkspace: CleanupFailureWorkspace | null = null;
  #failurePromise: Promise<void> | null = null;
  #failureDeferred: {
    resolve(): void;
    reject(error: unknown): void;
  } | null = null;
  #framePromise: Promise<void> | null = null;
  #controlTail: Promise<void> = Promise.resolve();
  #backendUnsubscribe: Unsubscribe | null = null;
  #backendRelay: {
    listener: ((event: BackendRuntimeEvent) => void) | null;
  } | null = null;
  #qualityUnsubscribe: Unsubscribe | null = null;
  #qualityRelay: {
    listener: ((profile: Readonly<RenderQualityProfile>) => void) | null;
  } | null = null;
  #frameRelay: {
    listener: ((nowMs: number) => void) | null;
  } | null = null;
  #pendingQualityDuringInitialization: Readonly<RenderQualityProfile> | null = null;
  #pendingQualityVersion = 0;
  #warmedQualityProfiles: readonly Readonly<RenderQualityProfile>[] | null = null;
  #initializedFeatures: number[] = [];
  #backendStarted = false;
  #materialsStarted = false;
  #uploadsStarted = false;
  #resourcesStarted = false;
  #frame = 0;
  #firstFrameAtMs: number | null = null;
  #lastFrameAtMs: number | null = null;
  #terminalError: RenderHostError | null = null;
  #failureClaimed = false;
  #terminalRawCausePresent = false;
  #terminalRawCauseIsWeak = false;
  #terminalRawCause: PrimitiveFailureCause | WeakRef<object>;
  #terminalFailureFinalized = false;
  #cleanupFailureEventPublished = false;
  #cleanupFailureChannels: readonly (readonly unknown[])[] = EMPTY_CLEANUP_FAILURE_CHANNELS;
  #preCleanupFailures: unknown[] = [];
  #preCleanupFailureChannels: (readonly unknown[])[] = [];
  #probeEvents: RenderHostProbeEvent[] = [];
  #probeListeners = new Set<() => void>();
  #nextProbeEventId = 1;
  #frameCallbacks = 0;
  #pendingDroppedTelemetryFrames: Readonly<PendingDroppedTelemetryFrame>[] = [];
  #submittedFrames = 0;
  #droppedFrames = 0;
  #backendEvents = 0;
  #failures = 0;
  #pendingControlOperations = 0;
  #controlTailRetainsFailure = false;
  #controlTailRawFailureIsWeak = false;
  #controlTailRawFailure: PrimitiveFailureCause | WeakRef<object>;
  #frameLoopStopped = false;
  #frameLoopStopFailure: Error | null = null;
  #ownedCallbackDepth = 0;
  readonly #compileWarmup: CompileWarmupState = {
    planned: 0,
    started: 0,
    completed: 0,
    failed: 0,
    measured: 0,
    maxDuration: null,
    overBudget: 0,
    unmeasured: false,
    finalized: false,
    terminated: false,
    phaseCounts: emptyCompilePhaseCounts(),
  };

  constructor(
    dependencies: RenderHostDependencies,
    instrumentation?: Readonly<RenderHostInstrumentation>,
  ) {
    const warmupScheduler = dependencies.warmupScheduler;
    if (
      (typeof warmupScheduler !== "object" || warmupScheduler === null)
      && typeof warmupScheduler !== "function"
    ) {
      throw new TypeError("RenderHost requires a warm-up scheduler object.");
    }
    const settleBeforeWarmup = safeDataMethod(
      warmupScheduler as object,
      "settleBeforeWarmup",
    );
    if (settleBeforeWarmup === null) {
      throw new TypeError(
        "RenderHost warm-up scheduler settleBeforeWarmup must be a data method.",
      );
    }
    const yieldToMain = safeDataMethod(warmupScheduler as object, "yieldToMain");
    if (yieldToMain === null) {
      throw new TypeError("RenderHost warm-up scheduler yieldToMain must be a data method.");
    }
    this.#settleWarmupBeforeFirstStep = () => {
      const candidate = hostIntrinsicReflectApply(settleBeforeWarmup, warmupScheduler, []);
      return captureExactPromise(candidate);
    };
    this.#yieldWarmupToMain = () => {
      const candidate = hostIntrinsicReflectApply(yieldToMain, warmupScheduler, []);
      return captureExactPromise(candidate);
    };
    this.#dependencies = Object.freeze({
      backend: dependencies.backend,
      frameLoop: dependencies.frameLoop,
      warmupScheduler,
      features: Object.freeze(dependencies.features.slice()),
      materials: dependencies.materials,
      uploads: dependencies.uploads,
      resources: dependencies.resources,
      qualityProvider: dependencies.qualityProvider,
      observer: dependencies.observer,
    });
    this.#instrumentation = instrumentation === undefined
      ? null
      : captureRenderHostInstrumentation(instrumentation);
  }

  get state(): RenderHostLifecycle {
    return this.#lifecycle;
  }

  get error(): RenderHostError | null {
    return this.#terminalError;
  }

  get journeySnapshot(): JourneyRenderSnapshot | null {
    return this.#snapshot;
  }

  subscribe(listener: () => void): Unsubscribe {
    this.#assertNoOwnedCallbackReentry("subscribe to probes");
    if (this.#lifecycle === "disposing" || this.#lifecycle === "disposed" || this.#lifecycle === "failed") {
      return () => undefined;
    }
    this.#probeListeners.add(listener);
    return () => this.#probeListeners.delete(listener);
  }

  getSnapshot(): RenderHostProbeSnapshot {
    this.#assertNoOwnedCallbackReentry("read a probe snapshot");
    let resources;
    try {
      resources = this.#invokeOwnedCallback(
        () => Object.freeze({ ...this.#dependencies.backend.snapshotResources() }),
      );
    } catch (error: unknown) {
      if (error instanceof RenderHostError && error.code === "INVALID_LIFECYCLE") throw error;
      resources = this.#invokeOwnedCallback(
        () => Object.freeze({ ...this.#dependencies.resources.snapshot() }),
      );
    }
    resources = Object.freeze({
      ...resources,
      pendingUploads: this.#invokeOwnedCallback(
        () => this.#dependencies.uploads.pendingCount(),
      ),
    });
    const loopRunning = this.#invokeOwnedCallback(
      () => this.#dependencies.frameLoop.running,
    );
    const backendFacts = this.#invokeOwnedCallback(
      () => Object.freeze({ ...this.#dependencies.backend.facts }),
    );
    return hostIntrinsicObjectFreeze({
      lifecycle: this.#lifecycle,
      loopRunning,
      qualityTier: this.#quality?.tier ?? null,
      journey: this.#snapshot
        ? Object.freeze({
            seed: this.#snapshot.seed,
            storyTime: this.#snapshot.storyTime,
            shotId: this.#snapshot.shotId,
          })
        : null,
      backend: backendFacts,
      resources: Object.freeze({ ...resources }),
      compileWarmup: this.#compileWarmupSnapshot(),
      counters: Object.freeze({
        frameCallbacks: this.#frameCallbacks,
        submittedFrames: this.#submittedFrames,
        droppedFrames: this.#droppedFrames,
        backendEvents: this.#backendEvents,
        failures: this.#failures,
        probeSubscribers: this.#probeListeners.size,
        pendingControlOperations: this.#pendingControlOperations,
        retainedRawFailureCauses: this.#retainedRawFailureCauses(),
        retainedIntermediateFailureSnapshots: this.#retainedIntermediateFailureSnapshots(),
      }),
      events: Object.freeze(this.#probeEvents.map((event) => Object.freeze({ ...event }))),
      error: this.#terminalError
        ? Object.freeze({
            code: this.#terminalError.code,
            message: this.#terminalError.message,
            lifecycle: this.#terminalError.lifecycle,
          })
        : null,
    });
  }

  #compileWarmupSnapshot(): RenderHostProbeSnapshot["compileWarmup"] {
    const warmup = this.#compileWarmup;
    const timingComplete = warmup.finalized
      && !warmup.unmeasured
      && warmup.measured === warmup.started
      && warmup.started === warmup.completed
      && warmup.failed === 0;
    const budgetStatus: RenderHostProbeSnapshot["compileWarmup"]["budgetStatus"] =
      warmup.unmeasured
        ? "unmeasured"
        : warmup.finalized
          ? warmup.overBudget === 0 && timingComplete ? "pass" : "fail"
          : warmup.terminated
            ? "fail"
            : "pending";
    return hostIntrinsicObjectFreeze({
      planned: warmup.planned,
      started: warmup.started,
      completed: warmup.completed,
      failed: warmup.failed,
      timingComplete,
      maxDuration: warmup.maxDuration,
      overBudget: warmup.overBudget,
      budgetStatus,
      phaseCounts: hostIntrinsicObjectFreeze({
        "runtime-object": warmup.phaseCounts["runtime-object"],
        "material-isolated": warmup.phaseCounts["material-isolated"],
        "material-runtime-topology": warmup.phaseCounts["material-runtime-topology"],
        "output-first-use": warmup.phaseCounts["output-first-use"],
      }),
    });
  }

  #retainedIntermediateFailureSnapshots(): number {
    const channelEntries = (channels: readonly (readonly unknown[])[]): number => channels
      .reduce((total, channel) => total + channel.length, 0);
    let retained = this.#preCleanupFailures.length
      + channelEntries(this.#preCleanupFailureChannels);
    if (this.#cleanupFailureWorkspace !== null) {
      retained += this.#cleanupFailureWorkspace.failures.length;
      retained += channelEntries(this.#cleanupFailureWorkspace.failureChannels);
      return retained;
    }
    retained += this.#cleanupPromiseResult.length;
    retained += channelEntries(this.#cleanupFailureChannels);
    return retained;
  }

  #retainedRawFailureCauses(): number {
    const terminalOccurrences = this.#terminalRawCausePresent ? 1 : 0;
    const controlTailOccurrences = this.#controlTailRetainsFailure ? 1 : 0;
    if (
      terminalOccurrences === 1
      && controlTailOccurrences === 1
      && this.#terminalAndControlTailRawFailuresMatch()
    ) {
      return 1;
    }
    return terminalOccurrences + controlTailOccurrences;
  }

  initialize(snapshot: JourneyRenderSnapshot, viewport: RenderViewport): Promise<void> {
    if (this.#ownedCallbackDepth > 0) {
      return Promise.reject(lifecycleError(
        "initialize from an owned dependency callback",
        this.#lifecycle,
        this.#errorOwner,
      ));
    }
    if (this.#initializePromise && !this.#initializeSettled) {
      return this.#initializePromise;
    }
    if (
      (this.#lifecycle === "new" || this.#lifecycle === "initializing" || this.#lifecycle === "ready")
      && this.#initializePromise
    ) {
      return this.#initializePromise;
    }
    if (this.#lifecycle === "ready") return Promise.resolve();
    if (this.#lifecycle !== "new") {
      return Promise.reject(lifecycleError("initialize", this.#lifecycle, this.#errorOwner));
    }

    const deferred = deferredVoid();
    this.#initializePromise = deferred.promise;
    void this.#performInitialize(snapshot, viewport).then(
      () => {
        this.#initializeSettled = true;
        deferred.resolve();
      },
      (error: unknown) => {
        this.#initializeSettled = true;
        deferred.reject(error);
      },
    );
    return this.#initializePromise;
  }

  setSnapshot(
    snapshot: JourneyRenderSnapshot,
    discontinuity?: Extract<
      RenderHistoryInvalidationReason,
      "restart-or-qa-seek" | "camera-discontinuity"
    >,
  ): void {
    this.#assertNoOwnedCallbackReentry("set a snapshot");
    this.#assertSnapshotWritable();
    if (
      discontinuity !== undefined
      && discontinuity !== "restart-or-qa-seek"
      && discontinuity !== "camera-discontinuity"
    ) {
      throw new TypeError("Snapshot discontinuity must be restart-or-qa-seek or camera-discontinuity.");
    }
    const version = this.#snapshotVersion;
    const previous = this.#snapshot;
    const frozen = freezeSnapshot(snapshot);
    this.#assertSnapshotWritable();
    if (this.#snapshotVersion !== version) return;
    this.#snapshot = frozen;
    this.#snapshotVersion += 1;
    const reasons = new Set<RenderHistoryInvalidationReason>();
    if (discontinuity !== undefined) reasons.add(discontinuity);
    if (previous?.shotId !== frozen.shotId && frozen.shotId === "S21") {
      reasons.add("story-cut-s21");
    }
    if (previous?.shotId !== frozen.shotId && frozen.shotId === "S23") {
      reasons.add("story-cut-s23");
    }
    if (previous !== null && !previous.finished && frozen.finished) {
      reasons.add("final-life-light");
    }
    try {
      for (const reason of reasons) this.#invalidateFeatureHistory(reason, previous, frozen);
    } catch (error: unknown) {
      this.#beginFailure(
        "FRAME_FAILED",
        "Temporal history invalidation failed.",
        error,
        "frame-error",
      );
      throw this.#terminalError ?? error;
    }
    this.#notifyProbeListeners();
  }

  invalidateHistory(reason: RenderHistoryInvalidationReason): void {
    this.#assertNoOwnedCallbackReentry("invalidate temporal history");
    if (this.#lifecycle !== "ready" || this.#snapshot === null) {
      throw lifecycleError("invalidate temporal history", this.#lifecycle, this.#errorOwner);
    }
    if (!RENDER_HISTORY_INVALIDATION_REASONS.includes(reason)) {
      throw new TypeError(`Unknown temporal-history invalidation reason: ${String(reason)}.`);
    }
    try {
      this.#invalidateFeatureHistory(reason, this.#snapshot, this.#snapshot);
    } catch (error: unknown) {
      this.#beginFailure(
        "FRAME_FAILED",
        "Temporal history invalidation failed.",
        error,
        "frame-error",
      );
      throw this.#terminalError ?? error;
    }
    this.#notifyProbeListeners();
  }

  async setQuality(profile: Readonly<RenderQualityProfile>): Promise<void> {
    this.#assertNoOwnedCallbackReentry("set quality");
    if (this.#lifecycle !== "ready") {
      throw lifecycleError("set quality", this.#lifecycle, this.#errorOwner);
    }
    // A direct control call is newer than any provider event that has only
    // scheduled (but not yet enqueued) its microtask.
    this.#pendingQualityVersion += 1;
    await this.#queueQualityControl(() => freezeQuality(profile));
  }

  async #queueQualityControl(
    prepare: () => Readonly<RenderQualityProfile>,
  ): Promise<void> {
    try {
      await this.#enqueueControlOperation(
        prepare,
        async (frozen) => {
          this.#assertControlCanContinue();
          await this.#applyQuality(frozen);
        },
      );
      this.#notifyProbeListeners();
    } catch (error: unknown) {
      this.#beginFailure("FRAME_FAILED", "Quality update failed.", error, "frame-error");
      if (this.#disposePromise === null) {
        await this.#failurePromise?.catch(() => undefined);
      }
      throw this.#terminalError ?? error;
    }
  }

  async resize(viewport: RenderViewport): Promise<void> {
    this.#assertNoOwnedCallbackReentry("resize");
    if (this.#lifecycle !== "ready") {
      throw lifecycleError("resize", this.#lifecycle, this.#errorOwner);
    }
    try {
      await this.#enqueueControlOperation(
        () => freezeViewport(viewport),
        async (frozen) => {
          this.#assertControlCanContinue();
          await this.#invokeOwnedCallback(() => this.#dependencies.backend.resize(frozen));
          this.#assertControlCanContinue();
          for (const feature of this.#dependencies.features) {
            await this.#invokeOwnedCallback(() => {
              const resize = feature.resize;
              return resize?.call(feature, frozen);
            });
            this.#assertControlCanContinue();
          }
          this.#viewport = frozen;
          if (this.#snapshot !== null) {
            this.#invalidateFeatureHistory("resize", this.#snapshot, this.#snapshot);
            this.#assertControlCanContinue();
          }
        },
      );
      this.#notifyProbeListeners();
    } catch (error: unknown) {
      this.#beginFailure("FRAME_FAILED", "Resize failed.", error, "frame-error");
      if (this.#disposePromise === null) {
        await this.#failurePromise?.catch(() => undefined);
      }
      throw this.#terminalError ?? error;
    }
  }

  dispose(): Promise<void> {
    if (this.#ownedCallbackDepth > 0) {
      return Promise.reject(lifecycleError(
        "dispose from an owned dependency callback",
        this.#lifecycle,
        this.#errorOwner,
      ));
    }
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#lifecycle === "disposed") return Promise.resolve();
    if (this.#failureClaimed && this.#failurePromise) return this.#failurePromise;
    if (this.#lifecycle === "failed") return this.#failurePromise ?? Promise.resolve();

    const deferred = deferredVoid();
    this.#disposePromise = deferred.promise;
    void this.#performDispose().then(deferred.resolve, deferred.reject);
    return this.#disposePromise;
  }

  async whenIdle(): Promise<void> {
    this.#assertNoOwnedCallbackReentry("wait for idle");
    if (this.#lifecycle === "initializing") {
      await this.#initializePromise?.catch(() => undefined);
    }
    await this.#framePromise?.catch(() => undefined);
    while (this.#pendingControlOperations > 0) {
      const pendingControls = this.#controlTail;
      await pendingControls.catch(() => undefined);
      if (pendingControls === this.#controlTail && this.#pendingControlOperations > 0) {
        await Promise.resolve();
      }
    }
    await this.#disposePromise?.catch(() => undefined);
    await this.#failurePromise?.catch(() => undefined);
  }

  async #performInitialize(
    snapshot: JourneyRenderSnapshot,
    viewport: RenderViewport,
  ): Promise<void> {
    const initializationStartedAt = this.#sampleTelemetryNow();
    let initializationTelemetryComplete = false;
    const completeInitializationTelemetry = (success: boolean): void => {
      if (initializationTelemetryComplete) return;
      initializationTelemetryComplete = true;
      this.#completeTelemetryOperation({
        kind: "initialization",
        name: "render-host-initialization",
        frameId: null,
        storyTime: null,
        success,
        affectsStoryTime: false,
      }, initializationStartedAt);
    };
    const initialSnapshotVersion = this.#snapshotVersion;
    this.#transition("initializing");

    try {
      const initialSnapshot = freezeSnapshot(snapshot);
      if (this.#snapshotVersion === initialSnapshotVersion) {
        this.#snapshot = initialSnapshot;
        this.#snapshotVersion += 1;
      }
      this.#viewport = freezeViewport(viewport);
      const serviceContext = Object.freeze({
        backend: this.#dependencies.backend,
        observer: this.#dependencies.observer,
        viewport: this.#viewport,
      });
      // Subscription itself may partially acquire backend ownership before
      // throwing, so backend disposal must already be part of the unwind set.
      this.#backendStarted = true;
      const backendRelay: {
        listener: ((event: BackendRuntimeEvent) => void) | null;
      } = {
        listener: (event) => this.#ingestBackendEvent(event),
      };
      this.#backendRelay = backendRelay;
      try {
        this.#backendUnsubscribe = this.#invokeOwnedCallback(
          () => this.#dependencies.backend.subscribeEvents(
            (event) => backendRelay.listener?.(event),
          ),
        );
      } catch (error: unknown) {
        backendRelay.listener = null;
        if (this.#backendRelay === backendRelay) this.#backendRelay = null;
        throw error;
      }
      this.#assertInitializing();

      await this.#invokeOwnedCallback(
        () => this.#dependencies.backend.initialize({ viewport: this.#viewport! }),
      );
      this.#assertInitializing();

      this.#resourcesStarted = true;
      await this.#invokeOwnedCallback(
        () => this.#dependencies.resources.initialize(serviceContext),
      );
      this.#assertInitializing();

      this.#uploadsStarted = true;
      await this.#invokeOwnedCallback(
        () => this.#dependencies.uploads.initialize(serviceContext),
      );
      this.#assertInitializing();

      this.#materialsStarted = true;
      await this.#invokeOwnedCallback(
        () => this.#dependencies.materials.initialize(serviceContext),
      );
      this.#assertInitializing();

      const featureContext = Object.freeze({
        backend: this.#dependencies.backend,
        materials: this.#dependencies.materials,
        uploads: this.#dependencies.uploads,
        resources: this.#dependencies.resources,
        observer: this.#dependencies.observer,
        viewport: this.#viewport,
      });
      for (let index = 0; index < this.#dependencies.features.length; index += 1) {
        this.#initializedFeatures.push(index);
        await this.#invokeOwnedCallback(
          () => this.#dependencies.features[index].initialize(featureContext),
        );
        this.#assertInitializing();
      }

      const initialQuality = this.#invokeOwnedCallback(
        () => freezeQuality(this.#dependencies.qualityProvider.getProfile()),
      );
      this.#assertInitializing();
      await this.#applyQuality(initialQuality);
      this.#assertInitializing();
      await this.#invalidateFeatureHistory("initialization", null, this.#snapshot!);
      this.#assertInitializing();
      const qualityRelay: {
        listener: ((profile: Readonly<RenderQualityProfile>) => void) | null;
      } = {
        listener: (profile: Readonly<RenderQualityProfile>) => this.#onQualityProfile(profile),
      };
      this.#qualityRelay = qualityRelay;
      try {
        this.#qualityUnsubscribe = this.#invokeOwnedCallback(
          () => this.#dependencies.qualityProvider.subscribe(
            (profile) => qualityRelay.listener?.(profile),
          ),
        );
      } catch (error: unknown) {
        qualityRelay.listener = null;
        if (this.#qualityRelay === qualityRelay) this.#qualityRelay = null;
        throw error;
      }
      this.#assertInitializing();
      const qualityVersionBeforeResample = this.#pendingQualityVersion;
      const resampledQuality = this.#invokeOwnedCallback(
        () => freezeQuality(this.#dependencies.qualityProvider.getProfile()),
      );
      this.#assertInitializing();
      if (
        this.#pendingQualityVersion === qualityVersionBeforeResample
        && !qualityProfilesEqual(this.#quality, resampledQuality)
      ) {
        this.#pendingQualityDuringInitialization = resampledQuality;
        this.#pendingQualityVersion += 1;
      }
      while (this.#pendingQualityDuringInitialization !== null) {
        await this.#drainPendingInitializationQuality();
      }

      const warmupInventory = this.#invokeOwnedCallback(() => {
        const provider = this.#dependencies.qualityProvider;
        const getWarmupProfiles = provider.getWarmupProfiles;
        const profiles = freezeWarmupProfiles(
          getWarmupProfiles
            ? getWarmupProfiles.call(provider)
            : [this.#quality!],
        );
        if (!profiles.some((profile) => qualityProfilesEqual(this.#quality, profile))) {
          throw new RangeError("Warm-up profiles must include the currently applied profile.");
        }
        return Object.freeze({
          profiles,
          declared: getWarmupProfiles !== undefined,
        });
      });
      const warmupProfiles = warmupInventory.profiles;
      // Legacy providers without an inventory can continue to accept explicit
      // control profiles. Providers that declare the runtime-selectable set
      // make compile-before-ready enforceable, so every later profile must be
      // one of these exact frozen snapshots.
      this.#warmedQualityProfiles = warmupInventory.declared ? warmupProfiles : null;
      this.#assertInitializing();

      const warmupRecorder = new FramePassRecorder(() => this.#assertInitializing());
      const featureWarmupPasses: RenderPass[] = [];
      for (const feature of this.#dependencies.features) {
        this.#invokeOwnedCallback(() => feature.render(warmupRecorder));
        this.#assertInitializing();
        const passes = this.#invokeOwnedCallback(() => {
          const warmupPasses = feature.warmupPasses;
          return warmupPasses
            ? captureWarmupPasses(
              warmupPasses.call(feature, warmupProfiles),
              () => this.#assertInitializing(),
            )
            : [];
        });
        featureWarmupPasses.push(...passes);
        this.#assertInitializing();
      }
      const materialWarmupPasses = this.#invokeOwnedCallback(
        () => captureWarmupPasses(
          this.#dependencies.materials.warmupPasses(warmupProfiles),
          () => this.#assertInitializing(),
        ),
      );
      this.#assertInitializing();
      const uniqueWarmupPasses: RenderPass[] = [];
      const warmupPassIndices = new Map<
        string,
        Map<string, Map<string | undefined, number>>
      >();
      for (const pass of [
        ...materialWarmupPasses,
        ...featureWarmupPasses,
        ...warmupRecorder.passes,
      ]) {
        let nameIndices = warmupPassIndices.get(pass.kind);
        if (!nameIndices) {
          nameIndices = new Map<string, Map<string | undefined, number>>();
          warmupPassIndices.set(pass.kind, nameIndices);
        }
        let variantIndices = nameIndices.get(pass.name);
        if (!variantIndices) {
          variantIndices = new Map<string | undefined, number>();
          nameIndices.set(pass.name, variantIndices);
        }
        const variantKey = pass.variant;
        const existingIndex = variantIndices.get(variantKey);
        if (existingIndex === undefined) {
          variantIndices.set(variantKey, uniqueWarmupPasses.length);
          uniqueWarmupPasses.push(pass);
        } else {
          uniqueWarmupPasses[existingIndex] = pass;
        }
      }
      this.#assertInitializing();
      await this.#precompileWarmup(Object.freeze(uniqueWarmupPasses.slice()));
      this.#assertInitializing();
      while (this.#pendingQualityDuringInitialization !== null) {
        await this.#drainPendingInitializationQuality();
      }

      const frameRelay = {
        listener: (nowMs: number) => this.#onFrame(nowMs),
      };
      this.#frameRelay = frameRelay;
      this.#invokeOwnedCallback(
        () => this.#dependencies.frameLoop.start((nowMs) => frameRelay.listener?.(nowMs)),
      );
      this.#assertInitializing();
      while (this.#pendingQualityDuringInitialization !== null) {
        await this.#drainPendingInitializationQuality();
      }
      this.#assertInitializing();
      this.#transition("ready");
      if (this.#lifecycle === "failed") {
        throw this.#terminalError ?? lifecycleError(
          "complete initialization",
          this.#lifecycle,
          this.#errorOwner,
        );
      }
      completeInitializationTelemetry(true);
    } catch (error: unknown) {
      completeInitializationTelemetry(false);
      if (
        this.#lifecycle === "failed"
        && this.#terminalError !== null
        && this.#failurePromise !== null
        && this.#failureDeferred === null
      ) {
        await this.#failurePromise.catch(() => undefined);
        throw this.#terminalError;
      }
      let primary: RenderHostError;
      if (this.#lifecycle === "failed" && this.#terminalError !== null) {
        primary = this.#terminalError;
      } else {
        this.#failureClaimed = true;
        this.#captureTerminalRawCauseOccurrence(error);
        this.#ensureFailureDeferred();
        primary = hostError(
          "INITIALIZATION_FAILED",
          "RenderHost initialization failed.",
          this.#lifecycle,
          this.#capturePrimaryFailureEvidence(error),
          this.#errorOwner,
        );
        this.#terminalError = primary;
        this.#failures += 1;
      }
      if (primary === this.#terminalError) {
        const snapshots = this.#snapshotFailureOccurrences(error, primary);
        this.#preCleanupFailures.push(...snapshots);
        if (snapshots.length > 0) {
          this.#preCleanupFailureChannels.push(
            this.#cleanupOperationChannel(error, snapshots),
          );
        }
      }
      if (this.#failurePromise === null) this.#ensureFailureDeferred();
      if (this.#lifecycle !== "failed") this.#transition("failed");
      const cleanupFailures = await this.#cleanup();
      const wrapped = this.#finalizeTerminalFailure(
        primary,
        cleanupFailures,
        cleanupFailures.length > 0,
      );
      this.#observe({ kind: "initialization-error", error: wrapped });
      this.#notifyAndClearProbeListeners();
      if (this.#failureDeferred) {
        this.#settleFailureDeferred(cleanupFailures.length > 0 ? wrapped : null);
      }
      throw wrapped;
    }
  }

  async #precompileWarmup(passes: readonly RenderPass[]): Promise<void> {
    const settleAttempt = this.#invokeOwnedCallback(this.#settleWarmupBeforeFirstStep);
    await settleAttempt;
    this.#assertInitializing();
    const session: CompileRunnerSession = {
      open: true,
      running: false,
      ids: new hostIntrinsicSet<string>(),
      inFlight: new hostIntrinsicSet<Promise<void>>(),
      violation: null,
    };
    const runner: Readonly<RenderCompileStepRunner> = hostIntrinsicObjectFreeze({
      run: (
        descriptor: Readonly<RenderCompileStepDescriptor>,
        operation: () => void | Promise<void>,
      ): Promise<void> => {
        const attempt = this.#runCompileStep(session, descriptor, operation);
        hostIntrinsicReflectApply(hostIntrinsicSetAdd, session.inFlight, [attempt]);
        void hostIntrinsicReflectApply(hostIntrinsicPromiseThen, attempt, [
          () => hostIntrinsicReflectApply(hostIntrinsicSetDelete, session.inFlight, [attempt]),
          () => {
            hostIntrinsicReflectApply(hostIntrinsicSetDelete, session.inFlight, [attempt]);
            session.violation ??= new hostIntrinsicError(
              "A compile runner action failed or violated its atomic contract.",
            );
          },
        ]);
        return attempt;
      },
    });
    let receipt: Readonly<RenderPrecompileReceipt>;
    try {
      receipt = await this.#invokeOwnedCallback(
        () => this.#dependencies.backend.precompile(passes, runner),
      );
    } finally {
      session.open = false;
      this.#compileWarmup.terminated = true;
    }
    if (hostIntrinsicReflectApply(hostIntrinsicSetSize, session.inFlight, []) > 0 || session.running) {
      const violation = new hostIntrinsicError(
        "A precompile backend returned while a compile runner action was still active.",
      );
      session.violation ??= violation;
      const pending: Promise<void>[] = [];
      hostIntrinsicReflectApply(hostIntrinsicSetForEach, session.inFlight, [
        (entry: Promise<void>) => { pending[pending.length] = entry; },
      ]);
      await hostIntrinsicReflectApply(hostIntrinsicPromiseAllSettled, hostIntrinsicPromise, [pending]);
      throw violation;
    }
    if (session.violation !== null) throw session.violation;
    const captured = capturePrecompileReceipt(receipt);
    const warmup = this.#compileWarmup;
    warmup.planned = captured.plannedSteps;
    if (
      captured.plannedSteps !== warmup.started
      || captured.completedSteps !== warmup.completed
      || warmup.started !== warmup.completed
      || warmup.failed !== 0
      || captured.phaseCounts["runtime-object"] !== warmup.phaseCounts["runtime-object"]
      || captured.phaseCounts["material-isolated"] !== warmup.phaseCounts["material-isolated"]
      || captured.phaseCounts["material-runtime-topology"]
        !== warmup.phaseCounts["material-runtime-topology"]
      || captured.phaseCounts["output-first-use"] !== warmup.phaseCounts["output-first-use"]
    ) {
      throw new hostIntrinsicError(
        "A precompile receipt does not match the Host-owned compile runner counts.",
      );
    }
    warmup.finalized = true;
  }

  async #runCompileStep(
    session: CompileRunnerSession,
    sourceDescriptor: Readonly<RenderCompileStepDescriptor>,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    if (!session.open || this.#lifecycle !== "initializing") {
      throw new hostIntrinsicError("A compile runner cannot start a late action.");
    }
    if (
      session.running
      || hostIntrinsicReflectApply(hostIntrinsicSetSize, session.inFlight, []) !== 0
    ) {
      throw new hostIntrinsicError("A compile runner cannot run concurrent or recursive actions.");
    }
    if (typeof operation !== "function") {
      throw new TypeError("A compile runner action must be a function.");
    }
    session.running = true;
    let descriptor: Readonly<RenderCompileStepDescriptor>;
    let warmup: CompileWarmupState;
    let startedAt: number | null;
    try {
      descriptor = captureCompileDescriptor(sourceDescriptor);
      if (hostIntrinsicReflectApply(hostIntrinsicSetHas, session.ids, [descriptor.id])) {
        throw new hostIntrinsicError("A compile runner cannot reuse a descriptor id.");
      }
      if (
        hostIntrinsicReflectApply(hostIntrinsicSetSize, session.ids, [])
        >= MAXIMUM_RENDER_COMPILE_STEPS
      ) {
        throw new RangeError("A compile runner exceeded its bounded step inventory.");
      }
      hostIntrinsicReflectApply(hostIntrinsicSetAdd, session.ids, [descriptor.id]);
      warmup = this.#compileWarmup;
      warmup.planned += 1;
      warmup.phaseCounts[descriptor.phase] += 1;
      warmup.started += 1;
      startedAt = this.#sampleCompileNow();
      if (startedAt === null) warmup.unmeasured = true;
    } catch (error: unknown) {
      session.running = false;
      throw error;
    }

    let actionFailed = false;
    let actionFailure: unknown;
    let schedulerFailed = false;
    let schedulerFailure: unknown;
    let succeeded = false;
    try {
      try {
        await hostIntrinsicReflectApply(operation, undefined, []);
        warmup.completed += 1;
        succeeded = true;
      } catch (error: unknown) {
        warmup.failed += 1;
        actionFailed = true;
        actionFailure = error;
      }

      if (startedAt !== null) {
        const endedAt = this.#sampleCompileNow();
        if (endedAt !== null && endedAt >= startedAt) {
        const durationMs = endedAt - startedAt;
        warmup.measured += 1;
        warmup.maxDuration = warmup.maxDuration === null
          ? durationMs
          : hostIntrinsicMathMax(warmup.maxDuration, durationMs);
        if (durationMs > GFX_TELEMETRY_RUNTIME_SPIKE_MS) warmup.overBudget += 1;
        const recorded = this.#recordTelemetryOperation({
          kind: "compile",
          name: descriptor.id,
          startedAtMs: startedAt,
          durationMs,
          frameId: null,
          storyTime: null,
          success: succeeded,
          affectsStoryTime: false,
        });
        if (!recorded) warmup.unmeasured = true;
        } else {
          warmup.unmeasured = true;
        }
      }

      if (actionFailed) {
        throw actionFailure;
      }

      try {
        const schedulerAttempt = this.#invokeOwnedCallback(this.#yieldWarmupToMain);
        await schedulerAttempt;
      } catch (error: unknown) {
        schedulerFailed = true;
        schedulerFailure = error;
      }
    } finally {
      session.running = false;
    }

    if (schedulerFailed) throw schedulerFailure;
  }

  #sampleCompileNow(): number | null {
    const instrumentation = this.#instrumentation;
    if (instrumentation === null) return null;
    let observed: unknown;
    try {
      observed = this.#invokeOwnedCallback(instrumentation.now);
    } catch {
      return null;
    }
    if (
      typeof observed !== "number"
      || !hostIntrinsicNumberIsFinite(observed)
      || observed < 0
      || hostIntrinsicObjectIs(observed, -0)
    ) {
      return null;
    }
    return observed;
  }

  async #performDispose(): Promise<void> {
    if (this.#lifecycle === "initializing") {
      await this.#initializePromise?.catch(() => undefined);
      if (this.state === "failed") {
        await this.#failurePromise;
        return;
      }
    }
    if (this.#lifecycle !== "new" && this.#lifecycle !== "ready") {
      if (this.#lifecycle === "disposed" || this.#lifecycle === "failed") return;
      throw lifecycleError("dispose", this.#lifecycle, this.#errorOwner);
    }

    this.#transition("disposing");
    try {
      this.#stopFrameLoop();
    } catch (error: unknown) {
      const snapshots = this.#snapshotFailureOccurrences(error, null, false);
      this.#preCleanupFailures.push(...snapshots);
      if (snapshots.length > 0) {
        this.#preCleanupFailureChannels.push(
          this.#cleanupOperationChannel(error, snapshots),
        );
      }
    }
    await this.#framePromise?.catch(() => undefined);
    const failures = await this.#cleanup();
    const terminalFailure = this.#currentTerminalFailure();
    if (terminalFailure) {
      const wrapped = this.#finalizeTerminalFailure(terminalFailure, failures, true);
      this.#notifyAndClearProbeListeners();
      throw wrapped;
    }
    if (failures.length > 0) {
      const budget = failureEvidenceBudget(1);
      const boundedFailures: unknown[] = budget.exhausted
        ? failures.slice()
        : [];
      if (!budget.exhausted) {
        for (const failure of failures) {
          boundedFailures.push(...this.#supplementalInitializationFailures(
            failure,
            null,
            false,
            budget,
          ));
          if (budget.exhausted) break;
        }
      }
      const immutableFailures = Object.freeze(boundedFailures);
      const wrapped = hostError(
        "DISPOSAL_FAILED",
        `RenderHost disposal failed in ${failures.length} cleanup operation(s).`,
        this.#lifecycle,
        immutableRenderHostAggregate(
          immutableFailures,
          "RenderHost disposal cleanup failed.",
        ),
        this.#errorOwner,
      );
      this.#terminalError = wrapped;
      this.#terminalFailureFinalized = true;
      this.#releaseTerminalRawCause();
      this.#releaseIntermediateFailureSnapshots();
      this.#observe({ kind: "disposal-error", error: wrapped });
      this.#transition("failed");
      this.#notifyAndClearProbeListeners();
      throw wrapped;
    }
    this.#releaseTerminalRawCause();
    this.#releaseIntermediateFailureSnapshots();
    this.#transition("disposed");
    this.#notifyAndClearProbeListeners();
  }

  #onFrame(nowMs: number): void {
    this.#frameCallbacks += 1;
    if (this.#lifecycle !== "ready") {
      this.#droppedFrames += 1;
      this.#notifyProbeListeners();
      return;
    }
    const frameId = this.#frame;
    this.#frame += 1;
    if (this.#framePromise || this.#pendingControlOperations > 0) {
      this.#droppedFrames += 1;
      const entry = this.#captureDroppedTelemetryFrame(frameId, nowMs);
      if (this.#framePromise && entry !== null) {
        const pending = this.#pendingDroppedTelemetryFrames;
        if (pending.length < 600) {
          pending[pending.length] = entry;
        } else {
          for (let index = 1; index < pending.length; index += 1) {
            pending[index - 1] = pending[index]!;
          }
          pending[pending.length - 1] = entry;
        }
      } else if (entry !== null) {
        this.#recordDroppedTelemetryFrame(entry);
      }
      this.#notifyProbeListeners();
      return;
    }
    const deferred = deferredVoid();
    const operation = deferred.promise;
    this.#framePromise = operation;
    void Promise.resolve()
      .then(() => this.#renderFrame(nowMs, frameId))
      .then(deferred.resolve, deferred.reject);
    void operation
      .catch((error: unknown) => {
        this.#beginFailure("FRAME_FAILED", "Render frame failed.", error, "frame-error");
      })
      .finally(() => {
        if (this.#framePromise === operation) this.#framePromise = null;
      });
  }

  async #renderFrame(nowMs: number, frameId: number): Promise<void> {
    this.#assertFrameCanContinue();
    const snapshot = this.#snapshot;
    if (!snapshot) throw new Error("RenderHost has no journey snapshot.");
    const frameStartedAt = this.#sampleTelemetryNow();

    const firstFrameAtMs = this.#firstFrameAtMs ?? nowMs;
    const previousFrameAtMs = this.#lastFrameAtMs ?? nowMs;
    const clock: RenderOperationClock = Object.freeze({
      frame: frameId,
      nowMs,
      deltaSeconds: Math.max(0, nowMs - previousFrameAtMs) / 1000,
      elapsedSeconds: Math.max(0, nowMs - firstFrameAtMs) / 1000,
      storyTime: snapshot.storyTime,
    });
    this.#firstFrameAtMs = firstFrameAtMs;
    this.#lastFrameAtMs = nowMs;
    let submitted = false;
    let framePasses: readonly RenderPass[] = Object.freeze([]);
    try {
      await this.#invokeOwnedCallback(
        () => this.#dependencies.uploads.flush(clock, this.#quality ?? undefined),
      );
      this.#assertFrameCanContinue();
      for (const feature of this.#dependencies.features) {
        this.#invokeOwnedCallback(() => feature.update(snapshot, clock));
        this.#assertFrameCanContinue();
      }

      const recorder = new FramePassRecorder(() => this.#assertFrameCanContinue());
      for (const feature of this.#dependencies.features) {
        this.#invokeOwnedCallback(() => feature.render(recorder));
        this.#assertFrameCanContinue();
      }
      framePasses = recorder.passes;
      await this.#invokeOwnedCallback(() => this.#dependencies.backend.render(framePasses));
      this.#assertFrameCanContinue();
      this.#submittedFrames += 1;
      submitted = true;
      this.#notifyProbeListeners();
    } finally {
      this.#recordTelemetryFrame(clock, snapshot, frameStartedAt, submitted, framePasses);
      // Publish the active frame before later RAF callbacks. Keeping this flush
      // inside the frame operation also guarantees cleanup cannot race ahead
      // and leave callback-time snapshots retained in the Host.
      this.#flushDroppedTelemetryFrames();
    }
  }

  async #applyQuality(profile: Readonly<RenderQualityProfile>): Promise<void> {
    const warmedProfiles = this.#warmedQualityProfiles;
    if (
      warmedProfiles !== null
      && !warmedProfiles.some((warmedProfile) => qualityProfilesEqual(warmedProfile, profile))
    ) {
      throw new RangeError(
        "A render quality profile cannot be applied unless it was included in the warm-up inventory.",
      );
    }
    const previous = this.#quality;
    const changed = previous !== null && !qualityProfilesEqual(previous, profile);
    const qualityStartedAt = changed ? this.#sampleTelemetryNow() : null;
    const affectsStoryTime = this.#lifecycle === "ready";
    let qualitySucceeded = false;
    try {
      await this.#invokeOwnedCallback(() => this.#dependencies.materials.quality(profile));
      this.#assertControlCanContinue();
      await this.#invokeOwnedCallback(() => {
        const quality = this.#dependencies.uploads.quality;
        return quality?.call(this.#dependencies.uploads, profile);
      });
      this.#assertControlCanContinue();
      for (const feature of this.#dependencies.features) {
        this.#invokeOwnedCallback(() => feature.quality(profile));
        this.#assertControlCanContinue();
      }
      this.#quality = profile;
      if (changed && this.#snapshot !== null) {
        this.#invalidateFeatureHistory("quality-change", this.#snapshot, this.#snapshot);
        this.#assertControlCanContinue();
      }
      qualitySucceeded = true;
    } finally {
      if (changed) {
        this.#completeTelemetryOperation({
          kind: "quality-change",
          name: `${previous.tier}-to-${profile.tier}`,
          frameId: null,
          storyTime: this.#snapshot?.storyTime ?? null,
          success: qualitySucceeded,
          affectsStoryTime,
        }, qualityStartedAt);
      }
    }
  }

  #invalidateFeatureHistory(
    reason: RenderHistoryInvalidationReason,
    previous: JourneyRenderSnapshot | null,
    next: JourneyRenderSnapshot,
  ): void {
    const historyStartedAt = this.#sampleTelemetryNow();
    const affectsStoryTime = this.#lifecycle === "ready";
    let historySucceeded = false;
    const event: Readonly<RenderHistoryInvalidation> = Object.freeze({
      reason,
      previousShotId: previous?.shotId ?? null,
      nextShotId: next.shotId,
      storyTime: next.storyTime,
    });
    try {
      for (const feature of this.#dependencies.features) {
        this.#invokeOwnedCallback(() => {
          const invalidateHistory = feature.invalidateHistory;
          invalidateHistory?.call(feature, event);
        });
        if (this.#lifecycle === "initializing") this.#assertInitializing();
        else this.#assertControlCanContinue();
      }
      historySucceeded = true;
    } finally {
      this.#completeTelemetryOperation({
        kind: "history-reset",
        name: reason,
        frameId: null,
        storyTime: next.storyTime,
        success: historySucceeded,
        affectsStoryTime,
        historyReason: reason,
      }, historyStartedAt);
    }
  }

  async #drainPendingInitializationQuality(): Promise<void> {
    while (this.#pendingQualityDuringInitialization !== null) {
      const pending = this.#pendingQualityDuringInitialization;
      this.#pendingQualityDuringInitialization = null;
      await this.#applyQuality(pending);
      this.#assertInitializing();
    }
  }

  #onQualityProfile(profile: Readonly<RenderQualityProfile>): void {
    const lifecycle = this.#lifecycle;
    if (lifecycle !== "initializing" && lifecycle !== "ready") return;
    const version = this.#pendingQualityVersion + 1;
    this.#pendingQualityVersion = version;
    let frozen: Readonly<RenderQualityProfile>;
    try {
      frozen = this.#invokeOwnedCallback(() => freezeQuality(profile));
    } catch (error: unknown) {
      this.#beginFailure(
        "FRAME_FAILED",
        "Quality subscription update failed.",
        error,
        "frame-error",
      );
      return;
    }
    if (lifecycle === "initializing") {
      if (this.#lifecycle !== "initializing" || this.#pendingQualityVersion !== version) return;
      this.#pendingQualityDuringInitialization = frozen;
      return;
    }
    if (this.#lifecycle !== "ready" || this.#pendingQualityVersion !== version) return;
    // Reserve the serialized control slot before returning to the provider so
    // a later resize/direct quality call cannot overtake this emission.
    void this.#queueQualityControl(() => frozen).catch(() => undefined);
  }

  #onBackendEvent(event: BackendRuntimeEvent): void {
    this.#backendEvents += 1;
    const claimed = this.#beginFailure(
      "BACKEND_RUNTIME_FAILED",
      `Graphics backend reported ${event.kind}.`,
      event.error,
      "frame-error",
    );
    if (claimed) this.#observe({ kind: "backend-event", event });
  }

  #ingestBackendEvent(event: BackendRuntimeEvent): void {
    try {
      const captured = this.#invokeOwnedCallback(() => {
        const kind = event.kind;
        const error = event.error;
        const occurredAtMs = event.occurredAtMs;
        if (kind !== "renderer-error" && kind !== "device-lost") {
          throw new TypeError(`Unknown graphics backend event kind: ${String(kind)}.`);
        }
        if (!Number.isFinite(occurredAtMs)) {
          throw new TypeError("Graphics backend event timestamp must be finite.");
        }
        return Object.freeze({ kind, error, occurredAtMs });
      });
      this.#onBackendEvent(captured);
    } catch (error: unknown) {
      this.#backendEvents += 1;
      this.#beginFailure(
        "BACKEND_RUNTIME_FAILED",
        "Graphics backend event capture failed.",
        error,
        "frame-error",
      );
    }
  }

  #beginFailure(
    code: "FRAME_FAILED" | "BACKEND_RUNTIME_FAILED",
    message: string,
    cause: unknown,
    observerKind: "frame-error",
  ): boolean {
    if (this.#lifecycle === "failed" || this.#lifecycle === "disposed") return false;
    if (this.#failureClaimed) return false;
    this.#failureClaimed = true;
    const lifecycleAtFailure = this.#lifecycle;
    this.#captureTerminalRawCauseOccurrence(cause);
    if (lifecycleAtFailure !== "disposing") this.#ensureFailureDeferred();
    const wrapped = hostError(
      code,
      message,
      lifecycleAtFailure,
      this.#capturePrimaryFailureEvidence(cause),
      this.#errorOwner,
    );
    this.#terminalError = wrapped;
    this.#failures += 1;
    if (lifecycleAtFailure !== "initializing" && lifecycleAtFailure !== "disposing") {
      void Promise.resolve()
        .then(() => this.#cleanupAfterFailure(wrapped))
        .then(
          () => this.#settleFailureDeferred(null),
          (error: unknown) => this.#settleFailureDeferred(error),
        );
    }
    this.#transition("failed");
    this.#observe({ kind: observerKind, error: wrapped });
    return true;
  }

  #cleanup(): Promise<readonly unknown[]> {
    if (this.#cleanupPromise) return this.#cleanupPromise;
    this.#cleanupPromise = Promise.resolve().then(() => this.#performCleanup());
    return this.#cleanupPromise;
  }

  async #performCleanup(): Promise<readonly unknown[]> {
    const failures: unknown[] = this.#preCleanupFailures.splice(0);
    const failureChannels: unknown[][] = this.#preCleanupFailureChannels
      .splice(0)
      .map((channel) => [...channel]);
    this.#cleanupFailureWorkspace = Object.freeze({ failures, failureChannels });
    if (failureChannels.length === 0 && failures.length > 0) {
      failureChannels.push(failures.slice());
    }
    const seenFailures = new Set(failures.filter(
      (value) => (typeof value === "object" && value !== null) || typeof value === "function",
    ));
    if (this.#terminalError) seenFailures.add(this.#terminalError);
    const recordRawFailure = (error: unknown) => {
      const accepted: unknown[] = [];
      for (const snapshot of this.#snapshotFailureOccurrences(error, null, false)) {
        const hasIdentity = (typeof snapshot === "object" && snapshot !== null)
          || typeof snapshot === "function";
        if (hasIdentity) seenFailures.add(snapshot);
        failures.push(snapshot);
        accepted.push(snapshot);
      }
      if (accepted.length > 0) {
        failureChannels.push([...this.#cleanupOperationChannel(error, accepted)]);
      }
    };
    const recordSupplementalOccurrences = (
      rejection: unknown,
      supplementals: readonly unknown[],
    ) => {
      // Identities present before this reported operation are propagation
      // duplicates. Repeated identities inside this one operation are distinct
      // occurrences and must all remain visible.
      const previouslySeen = new Set(seenFailures);
      const accepted: unknown[] = [];
      for (const supplemental of supplementals) {
        const hasIdentity = (typeof supplemental === "object" && supplemental !== null)
          || typeof supplemental === "function";
        if (hasIdentity && previouslySeen.has(supplemental)) continue;
        if (hasIdentity) seenFailures.add(supplemental);
        failures.push(supplemental);
        accepted.push(supplemental);
      }
      if (accepted.length > 0) {
        failureChannels.push([...this.#cleanupOperationChannel(rejection, accepted)]);
      }
    };
    const recordFailure = (error: unknown) => {
      if (!this.#terminalError) {
        recordRawFailure(error);
        return;
      }
      recordSupplementalOccurrences(
        error,
        this.#snapshotFailureOccurrences(
          error,
          this.#terminalError,
          false,
        ),
      );
    };
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error: unknown) {
        recordFailure(error);
      }
    };
    const retryUnsubscribe = async (
      operation: Unsubscribe,
      release: () => void,
    ): Promise<void> => {
      for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
        try {
          this.#invokeOwnedCallback(operation);
          release();
          return;
        } catch (error: unknown) {
          recordFailure(error);
        }
      }
    };

    const frameRelay = this.#frameRelay;
    this.#frameRelay = null;
    if (frameRelay) frameRelay.listener = null;
    await attempt(() => this.#stopFrameLoop());
    if (!this.#frameLoopStopped) await attempt(() => this.#stopFrameLoop());
    const qualityRelay = this.#qualityRelay;
    this.#qualityRelay = null;
    if (qualityRelay) qualityRelay.listener = null;
    const qualityUnsubscribe = this.#qualityUnsubscribe;
    this.#pendingQualityDuringInitialization = null;
    if (qualityUnsubscribe) {
      await retryUnsubscribe(qualityUnsubscribe, () => {
        if (this.#qualityUnsubscribe === qualityUnsubscribe) this.#qualityUnsubscribe = null;
      });
    }
    const activeFrame = this.#framePromise;
    const recordOperationRejection = (error: unknown): void => {
      if (this.#terminalError) {
        recordSupplementalOccurrences(
          error,
          this.#snapshotFailureOccurrences(
            error,
            this.#terminalError,
          ),
        );
        return;
      }
      recordFailure(error);
    };
    if (activeFrame) {
      try {
        await activeFrame;
      } catch (error: unknown) {
        recordOperationRejection(error);
      }
    }
    // A frame can fail before entering its internal telemetry finally block.
    // Drain any callback-time snapshots once the exact frame promise settles.
    this.#flushDroppedTelemetryFrames();
    try {
      await this.#controlTail;
    } catch (error: unknown) {
      recordOperationRejection(error);
    }
    // The public control caller retains its own rejection. Replace the Host's
    // internal latch after evidence capture so no raw error graph survives cleanup.
    this.#controlTail = Promise.resolve();
    this.#releaseControlTailRawFailure();
    this.#warmedQualityProfiles = null;

    for (const index of this.#initializedFeatures.slice().reverse()) {
      await attempt(
        () => this.#invokeOwnedCallback(() => this.#dependencies.features[index].dispose()),
      );
    }
    this.#initializedFeatures = [];

    if (this.#materialsStarted) {
      await attempt(() => this.#invokeOwnedCallback(() => this.#dependencies.materials.dispose()));
    }
    if (this.#uploadsStarted) {
      await attempt(() => this.#invokeOwnedCallback(() => this.#dependencies.uploads.dispose()));
      await attempt(() => {
        const pending = this.#invokeOwnedCallback(
          () => this.#dependencies.uploads.pendingCount(),
        );
        if (pending !== 0) {
          throw new Error(`Render upload queue retained ${pending} pending item(s) after disposal.`);
        }
      });
    }
    if (this.#resourcesStarted) {
      await attempt(() => this.#invokeOwnedCallback(() => this.#dependencies.resources.dispose()));
    }
    // Keep backend events observable until every operation that can still
    // touch the backend has drained. Only then revoke the relay and detach it.
    const backendUnsubscribe = this.#backendUnsubscribe;
    const backendRelay = this.#backendRelay;
    this.#backendRelay = null;
    if (backendRelay) backendRelay.listener = null;
    if (backendUnsubscribe) {
      await retryUnsubscribe(backendUnsubscribe, () => {
        if (this.#backendUnsubscribe === backendUnsubscribe) this.#backendUnsubscribe = null;
      });
    }
    if (this.#backendStarted) {
      await attempt(() => this.#invokeOwnedCallback(() => this.#dependencies.backend.dispose()));
    }

    this.#materialsStarted = false;
    this.#uploadsStarted = false;
    this.#resourcesStarted = false;
    this.#backendStarted = false;
    const immutableFailures = Object.freeze(failures.slice());
    this.#cleanupPromiseResult = immutableFailures;
    this.#cleanupFailureWorkspace = null;
    if (this.#terminalError) {
      // Every occurrence was already snapshotted at ingress. Preserve the
      // operation boundaries so final composition can budget all cleanup
      // channels fairly instead of allowing the first large root to starve later ones.
      this.#cleanupFailureChannels = Object.freeze(failureChannels.map(
        (channel) => Object.freeze(channel.slice()),
      ));
      return immutableFailures;
    }
    this.#cleanupFailureChannels = EMPTY_CLEANUP_FAILURE_CHANNELS;
    return immutableFailures;
  }

  async #cleanupAfterFailure(primary: RenderHostError): Promise<void> {
    const failures = await this.#cleanup();
    const wrapped = this.#finalizeTerminalFailure(primary, failures, true);
    if (failures.length === 0) {
      this.#notifyAndClearProbeListeners();
      return;
    }
    this.#notifyAndClearProbeListeners();
    throw wrapped;
  }

  #enqueueControlOperation<T>(
    prepare: () => T,
    operation: (prepared: T) => Promise<void>,
  ): Promise<void> {
    const activeFrame = this.#framePromise;
    this.#pendingControlOperations += 1;
    const preparationGate = deferredVoid();
    let prepared!: T;
    let preparationFailed = false;
    let preparationError: unknown;
    const next = this.#controlTail
      .catch(() => undefined)
      .then(async () => {
        await activeFrame?.catch(() => undefined);
        await preparationGate.promise;
        if (preparationFailed) throw preparationError;
        this.#assertControlCanContinue();
        await operation(prepared);
        this.#assertControlCanContinue();
      });
    const tracked = next.finally(() => {
      this.#pendingControlOperations -= 1;
      this.#notifyProbeListeners();
    });
    this.#controlTail = tracked;
    void tracked.catch((error: unknown) => {
      this.#captureControlTailRawFailure(error);
    });
    try {
      prepared = prepare();
    } catch (error: unknown) {
      preparationFailed = true;
      preparationError = error;
    } finally {
      preparationGate.resolve();
    }
    return tracked;
  }

  #ensureFailureDeferred(): void {
    if (this.#failurePromise) return;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.#failureDeferred = { resolve, reject };
    this.#failurePromise = promise;
    void promise.catch(() => undefined);
  }

  #settleFailureDeferred(error: unknown): void {
    const deferred = this.#failureDeferred;
    this.#releaseTerminalRawCause();
    if (!deferred) return;
    this.#failureDeferred = null;
    if (error === null) deferred.resolve();
    else deferred.reject(error);
  }

  #withCleanupFailures(
    primary: RenderHostError,
    failures: readonly unknown[],
  ): RenderHostError {
    if (failures.length > 0) {
      const cleanupChannels = this.#cleanupFailureChannels.length > 0
        ? this.#cleanupFailureChannels
        : Object.freeze(failures.map((failure) => Object.freeze([failure])));
      const composed = this.#composeTerminalFailureEvidence(
        primary,
        Object.freeze([renderHostErrorCause(primary)]),
        cleanupChannels,
      );
      return replaceRenderHostErrorCause(
        primary,
        immutableRenderHostAggregate(
          composed,
          "RenderHost terminal failure evidence was recomposed after cleanup.",
        ),
        this.#errorOwner,
      );
    }
    return attachRenderHostCleanupFailures(
      primary,
      this.#supplementalFailureEvidence(primary, failures),
      this.#errorOwner,
    );
  }

  #primaryFailureOccurrences(
    cause: unknown,
    budget: FailureEvidenceBudget,
    immutableOutput = false,
  ): readonly unknown[] {
    return this.#supplementalInitializationFailures(
      cause,
      null,
      false,
      budget,
      immutableOutput,
    );
  }

  #materializePrimaryFailureEvidence(evidence: readonly unknown[]): unknown {
    if (evidence.length === 1) return evidence[0];
    const aggregate = immutableRenderHostAggregate(
      evidence,
      "RenderHost primary failure contained multiple errors.",
    );
    carryFailureEvidenceReasons(aggregate, evidence);
    return aggregate;
  }

  #capturePrimaryFailureEvidence(cause: unknown): unknown {
    const ingressBudget = failureEvidenceBudget(2);
    let occurrences: readonly unknown[];
    try {
      occurrences = this.#invokeOwnedCallback(
        () => this.#primaryFailureOccurrences(cause, ingressBudget),
      );
    } catch {
      if (!chargeFailureEvidenceNodes(ingressBudget)) {
        const truncation = truncateFailureEvidence(ingressBudget);
        occurrences = Object.freeze([truncation === OMIT_FAILURE_EVIDENCE
          ? failureEvidenceLossMarker(ingressBudget.lossReasons, false)
          : truncation]);
      } else {
        occurrences = Object.freeze([freezeFailureEvidence(new Error(
          "RenderHost primary failure evidence could not be captured.",
        ))]);
      }
    }
    if (
      occurrences.length > 1
      || ingressBudget.truncationMarkerCharged
      || ingressBudget.usedNodes >= REBASABLE_PRIMARY_EVIDENCE_THRESHOLD
    ) {
      const safeBudget = failureEvidenceBudget(2);
      const safeOccurrences: unknown[] = [];
      for (const occurrence of occurrences) {
        safeOccurrences.push(...this.#supplementalInitializationFailures(
          occurrence,
          null,
          false,
          safeBudget,
          true,
        ));
        if (safeBudget.exhausted) break;
      }
      occurrences = Object.freeze(safeOccurrences);
    }
    return this.#materializePrimaryFailureEvidence(occurrences);
  }

  #cleanupOperationChannel(
    rejection: unknown,
    snapshots: readonly unknown[],
  ): readonly unknown[] {
    const classification = classifyFailureEvidence(rejection);
    if (classification !== "aggregate" && classification !== "uninspectable") {
      return Object.freeze(snapshots.slice());
    }
    let message = classification === "aggregate"
      ? "Sanitized cleanup aggregate operation."
      : "Sanitized cleanup operation with an uninspectable failure root.";
    if (classification === "aggregate") {
      try {
        const messageDescriptor = Object.getOwnPropertyDescriptor(
          rejection as object,
          "message",
        );
        const capturedMessage = messageDescriptor && "value" in messageDescriptor
          ? messageDescriptor.value
          : undefined;
        if (typeof capturedMessage === "string" && capturedMessage.length > 0) {
          message = capturedMessage;
        }
      } catch {
        // A generic detached operation message is safer than another raw read.
      }
    }
    try {
      if (classification === "aggregate") {
        if (
          snapshots.length === 1
          && snapshots[0] instanceof AggregateError
          && snapshots[0].message === message
        ) {
          if (ownPrimitiveFailureCause(snapshots[0]) !== null) return snapshots;
          cleanupOperationAggregateSnapshots.add(snapshots[0]);
          carryFailureEvidenceReasons(snapshots[0], snapshots[0].errors);
          return Object.freeze(snapshots.slice());
        }
      }
      const aggregate = new AggregateError(snapshots, message);
      Object.freeze(aggregate.errors);
      const immutable = freezeFailureEvidence(aggregate);
      cleanupOperationAggregateSnapshots.add(immutable);
      carryFailureEvidenceReasons(immutable, snapshots);
      return Object.freeze([immutable]);
    } catch {
      // The already-safe occurrence snapshots remain the fallback operation head.
    }
    return Object.freeze(snapshots.slice());
  }

  #snapshotFailureOccurrences(
    rejection: unknown,
    primary: RenderHostError | null,
    consumePrimaryCause = true,
  ): readonly unknown[] {
    const budget = failureEvidenceBudget(2);
    try {
      return this.#invokeOwnedCallback(() => Object.freeze(
        this.#supplementalInitializationFailures(
          rejection,
          primary,
          consumePrimaryCause,
          budget,
          true,
        ),
      ));
    } catch {
      const immutable = immutableFailureOccurrence(new Error(
        "RenderHost cleanup failure evidence could not be captured.",
      ), budget);
      return immutable === OMIT_FAILURE_EVIDENCE
        ? Object.freeze([])
        : Object.freeze([immutable]);
    }
  }

  #supplementalFailureEvidence(
    primary: RenderHostError,
    failures: readonly unknown[],
  ): readonly unknown[] {
    const budget = failureEvidenceBudget(2);
    const evidence: unknown[] = [];
    for (const failure of failures) {
      evidence.push(...this.#supplementalInitializationFailures(
        failure,
        primary,
        false,
        budget,
      ));
      if (budget.exhausted) break;
    }
    return Object.freeze(evidence);
  }

  #composeTerminalFailureEvidence(
    primary: RenderHostError,
    primaryEntries: readonly unknown[],
    cleanupChannels: readonly (readonly unknown[])[],
  ): readonly unknown[] {
    const budget = failureEvidenceBudget(
      1,
      MAXIMUM_FAILURE_EVIDENCE_NODES,
      "final-output",
      true,
    );
    const expandChannel = (value: unknown): readonly unknown[] => {
      try {
        if (!(value instanceof AggregateError)) return Object.freeze([value]);
        if (cleanupOperationAggregateSnapshots.has(value)) {
          return Object.freeze([value]);
        }
        if (Object.getOwnPropertyDescriptor(value, "cause") !== undefined) {
          return Object.freeze([value]);
        }
        const entries = value.errors;
        if (!Array.isArray(entries) || entries.length === 0) {
          return Object.freeze([value]);
        }
        return Object.freeze(entries.slice());
      } catch {
        return Object.freeze([value]);
      }
    };
    type AtomicPlan = {
      readonly hasPriorLoss: boolean;
      readonly kind: "atomic";
      readonly priorReasons: readonly FailureEvidenceLossReason[] | null;
      readonly value: unknown;
      evidence: unknown[];
      processed: boolean;
    };
    type AggregatePlan = {
      readonly cause: OwnPrimitiveFailureCause | null;
      readonly details: readonly unknown[];
      readonly hasPriorLoss: boolean;
      readonly kind: "aggregate";
      readonly message: string;
      readonly priorReasons: readonly FailureEvidenceLossReason[] | null;
      detailCursor: number;
      detailEvidence: unknown[];
      rootReserved: boolean;
    };
    type EntryPlan = AtomicPlan | AggregatePlan;
    type ChannelPlan = {
      cursor: number;
      readonly entries: readonly EntryPlan[];
      readonly preserveIdentity: boolean;
      represented: boolean;
    };
    const planEntry = (value: unknown): EntryPlan => {
      const priorReasons = carriedFailureEvidenceReasons(value);
      const hasPriorLoss = priorReasons !== null;
      try {
        if (
          value instanceof AggregateError
          && immutableFailureEvidenceSnapshots.has(value)
        ) {
          const cause = ownPrimitiveFailureCause(value);
          const details = value.errors;
          if (
            Array.isArray(details)
            && (
              cause !== null
              || cleanupOperationAggregateSnapshots.has(value)
            )
          ) {
            const message = typeof value.message === "string" && value.message.length > 0
              ? value.message
              : cause === null
                ? "Sanitized cleanup aggregate operation."
                : "Sanitized aggregate failure with a primitive cause.";
            return {
              cause,
              details: Object.freeze(details.slice()),
              detailCursor: 0,
              detailEvidence: [],
              hasPriorLoss,
              kind: "aggregate",
              message,
              priorReasons,
              rootReserved: false,
            };
          }
        }
      } catch {
        // Only trusted immutable snapshots are split. Anything surprising is
        // processed through the existing defensive sanitizer as one entry.
      }
      return {
        evidence: [],
        hasPriorLoss,
        kind: "atomic",
        priorReasons,
        processed: false,
        value,
      };
    };
    const makeChannel = (
      entries: readonly unknown[],
      preserveIdentity: boolean,
    ): ChannelPlan => ({
      cursor: 0,
      entries: Object.freeze(entries
        .flatMap((entry) => expandChannel(entry))
        .map((entry) => planEntry(entry))),
      preserveIdentity,
      represented: false,
    });
    const channels = [
      makeChannel(primaryEntries, true),
      ...cleanupChannels.map((entries) => makeChannel(entries, false)),
    ];
    for (const channel of channels) {
      for (const entry of channel.entries) {
        if (entry.priorReasons === null) continue;
        for (const reason of entry.priorReasons) budget.lossReasons.add(reason);
      }
    }
    const processAtomic = (plan: AtomicPlan, channel: ChannelPlan): void => {
      plan.evidence.push(...this.#supplementalInitializationFailures(
        plan.value,
        primary,
        false,
        budget,
        !channel.preserveIdentity,
        true,
      ));
      plan.processed = true;
      if (plan.evidence.length > 0) channel.represented = true;
    };
    const reserveAggregateRoot = (
      plan: AggregatePlan,
      channel: ChannelPlan,
    ): boolean => {
      if (budget.exhausted) return false;
      // Charge the already-safe source root and generated bounded summary,
      // plus the own primitive cause when present, before spending on details.
      const rootCost = plan.cause === null ? 2 : 3;
      if (budget.usedNodes + rootCost > budget.maximumNodes - 1) {
        budget.lossReasons.add("final-output");
        return false;
      }
      budget.usedNodes += rootCost;
      plan.rootReserved = true;
      channel.represented = true;
      return true;
    };
    const reserveAtomicHead = (
      plan: AtomicPlan,
      channel: ChannelPlan,
      cleanup: boolean,
    ): boolean => {
      if (budget.exhausted) {
        plan.processed = true;
        return false;
      }
      if (
        cleanup
        && plan.priorReasons !== null
        && failureEvidenceReasons(plan.value) !== null
      ) {
        // The shared terminal marker carries the loss provenance. Retain a
        // separate, non-provenance summary so this cleanup operation still has
        // a bounded unique head without duplicating the marker.
        if (budget.usedNodes + 2 > budget.maximumNodes - 1) {
          budget.lossReasons.add("final-output");
          plan.processed = true;
          return false;
        }
        budget.usedNodes += 2;
        plan.evidence.push(freezeFailureEvidence(new Error(
          "Sanitized cleanup operation head retained after evidence loss.",
        )));
        plan.processed = true;
        channel.represented = true;
        return true;
      }
      let headCost = 1;
      try {
        if (
          (typeof plan.value === "object" && plan.value !== null)
          || typeof plan.value === "function"
        ) {
          if (ownPrimitiveFailureCause(plan.value as object) !== null) headCost += 1;
        }
      } catch {
        headCost = 1;
      }
      if (budget.usedNodes + headCost > budget.maximumNodes - 1) {
        budget.lossReasons.add("final-output");
        plan.processed = true;
        return false;
      }
      processAtomic(plan, channel);
      return plan.evidence.length > 0;
    };
    const reserveChannelHead = (
      channel: ChannelPlan,
      cleanup: boolean,
    ): void => {
      const head = channel.entries[0];
      if (!head) {
        budget.lossReasons.add("final-output");
        return;
      }
      if (head.kind === "aggregate") reserveAggregateRoot(head, channel);
      else reserveAtomicHead(head, channel, cleanup);
    };
    reserveChannelHead(channels[0], false);
    for (const channel of channels.slice(1)) reserveChannelHead(channel, true);
    const processChannelStep = (channel: ChannelPlan): boolean => {
      while (channel.cursor < channel.entries.length) {
        const plan = channel.entries[channel.cursor];
        if (plan.kind === "atomic") {
          channel.cursor += 1;
          if (plan.processed) continue;
          processAtomic(plan, channel);
          return true;
        }
        if (!plan.rootReserved) {
          if (reserveAggregateRoot(plan, channel)) return true;
          channel.cursor += 1;
          continue;
        }
        if (plan.detailCursor < plan.details.length) {
          const detail = plan.details[plan.detailCursor];
          plan.detailCursor += 1;
          plan.detailEvidence.push(...this.#supplementalInitializationFailures(
            detail,
            primary,
            false,
            budget,
            true,
            true,
          ));
          return true;
        }
        channel.cursor += 1;
      }
      return false;
    };
    while (!budget.exhausted) {
      let progressed = false;
      for (const channel of channels) {
        if (processChannelStep(channel)) progressed = true;
        if (budget.exhausted) break;
      }
      if (!progressed) break;
    }
    const omittedCleanupChannels = channels.slice(1).filter(
      (channel) => !channel.represented,
    ).length;
    if (omittedCleanupChannels > 0) budget.lossReasons.add("final-output");
    const marker = budget.lossReasons.size > 0
      ? failureEvidenceLossMarker(
        budget.lossReasons,
        true,
        omittedCleanupChannels,
      )
      : null;
    const materializeAggregate = (plan: AggregatePlan): AggregateError => {
      const aggregate = new AggregateError(plan.detailEvidence, plan.message);
      if (plan.cause !== null) {
        Object.defineProperty(aggregate, "cause", {
          configurable: true,
          value: plan.cause.value,
          writable: true,
        });
      }
      Object.freeze(aggregate.errors);
      const immutable = freezeFailureEvidence(aggregate);
      carryFailureEvidenceReasons(immutable, plan.detailEvidence);
      return immutable;
    };
    const evidence: unknown[] = [];
    let markerPlaced = false;
    for (const channel of channels) {
      for (const plan of channel.entries) {
        if (marker !== null && !markerPlaced && plan.hasPriorLoss) {
          evidence.push(marker);
          markerPlaced = true;
        }
        if (plan.kind === "atomic") evidence.push(...plan.evidence);
        else if (plan.rootReserved) evidence.push(materializeAggregate(plan));
      }
    }
    if (marker !== null && !markerPlaced) evidence.push(marker);
    return Object.freeze(evidence);
  }

  #supplementalInitializationFailures(
    rejection: unknown,
    primary: RenderHostError | null,
    consumePrimaryCause = true,
    budget = failureEvidenceBudget(1),
    immutableOutput = false,
    omitPriorLossMarkers = false,
  ): readonly unknown[] {
    const failures: unknown[] = [];
    const activePath = new Set<unknown>();
    const primaryCause = primary === null
      ? Symbol("no-render-host-primary")
      : renderHostErrorCause(primary);
    const rawPrimaryAvailable = primary !== null
      && primary === this.#terminalError
      && this.#terminalRawCausePresent;
    let primaryRepresentationConsumed = false;
    let primaryReferenceCount = 0;
    let sanitizationCount = 0;
    let traversalTruncationCount = 0;
    let traversalBudgetEvidenceRecorded = false;
    const capturedPrimitiveCauses = new WeakMap<
      object,
      OwnPrimitiveFailureCause | null
    >();
    const hasIdentity = (value: unknown): boolean => (
      (typeof value === "object" && value !== null) || typeof value === "function"
    );
    const wasSeen = (value: unknown): boolean => hasIdentity(value) && activePath.has(value);
    const markSeen = (value: unknown): void => {
      if (hasIdentity(value)) activePath.add(value);
    };
    const recordTraversalTruncation = (
      reason: FailureEvidenceLossReason = budget.limitReason,
    ): void => {
      traversalTruncationCount += 1;
      if (traversalBudgetEvidenceRecorded) return;
      traversalBudgetEvidenceRecorded = true;
      const truncation = truncateFailureEvidence(budget, reason);
      if (truncation !== OMIT_FAILURE_EVIDENCE) failures.push(truncation);
    };
    const recordOpaque = (
      value: unknown,
      capturedOwnPrimitiveCause?: OwnPrimitiveFailureCause | null,
    ): void => {
      if (wasSeen(value)) return;
      if (!immutableOutput) {
        if (
          capturedOwnPrimitiveCause !== null
          && capturedOwnPrimitiveCause !== undefined
          && !chargeFailureEvidenceNodes(budget)
        ) {
          recordTraversalTruncation();
          return;
        }
        failures.push(value);
        return;
      }
      if (
        hasIdentity(value)
        && immutableFailureEvidenceSnapshots.has(value as object)
      ) {
        if (
          capturedOwnPrimitiveCause !== null
          && capturedOwnPrimitiveCause !== undefined
          && !chargeFailureEvidenceNodes(budget)
        ) {
          recordTraversalTruncation();
          return;
        }
        failures.push(value);
        return;
      }
      const immutable = immutableFailureOccurrence(
        value,
        budget,
        capturedOwnPrimitiveCause,
      );
      if (immutable !== OMIT_FAILURE_EVIDENCE) failures.push(immutable);
      if (failureEvidenceReasons(immutable) !== null) {
        traversalTruncationCount += 1;
        traversalBudgetEvidenceRecorded = true;
      }
    };
    const recordSanitizedEvidence = <T extends Error>(
      evidence: T,
      lossReason?: FailureEvidenceLossReason,
    ): Error | typeof OMIT_FAILURE_EVIDENCE => {
      sanitizationCount += 1;
      if (!chargeFailureEvidenceNodes(budget)) {
        recordTraversalTruncation();
        return OMIT_FAILURE_EVIDENCE;
      }
      const immutable = freezeFailureEvidence(evidence);
      if (lossReason) {
        failureEvidenceLossReasons.set(immutable, Object.freeze([lossReason]));
        budget.lossReasons.add(lossReason);
      }
      failures.push(immutable);
      return immutable;
    };
    const classify = classifyFailureEvidence;
    const visit = (
      value: unknown,
      depth = 0,
      classificationHint?: ReturnType<typeof classify>,
    ): void => {
      if (omitPriorLossMarkers) {
        const priorReasons = failureEvidenceReasons(value);
        if (priorReasons !== null) {
          for (const reason of priorReasons) budget.lossReasons.add(reason);
          budget.truncationMarkerCharged = true;
          budget.priorLossMarkerOmissions += 1;
          return;
        }
      }
      if (primary !== null && value === primary) {
        primaryReferenceCount += 1;
        return;
      }
      if (
        consumePrimaryCause
        && rawPrimaryAvailable
        && !primaryRepresentationConsumed
        && this.#terminalRawCauseMatches(value)
      ) {
        primaryRepresentationConsumed = true;
        return;
      }
      if (
        primary !== null
        && consumePrimaryCause
        && !primaryRepresentationConsumed
        && Object.is(value, primaryCause)
      ) {
        primaryRepresentationConsumed = true;
        return;
      }
      if (budget.exhausted) return;
      if (depth > MAXIMUM_FAILURE_EVIDENCE_DEPTH) {
        recordTraversalTruncation("depth");
        return;
      }
      if (!chargeFailureEvidenceNodes(budget)) {
        recordTraversalTruncation(budget.limitReason);
        return;
      }
      if (wasSeen(value)) {
        recordSanitizedEvidence(new Error("Cyclic failure evidence was sanitized."));
        return;
      }
      const classification = classificationHint ?? classify(value);
      if (classification === "uninspectable") {
        recordSanitizedEvidence(
          new Error("Failure value type could not be inspected."),
          "hostile-inspection",
        );
        return;
      }
      if (classification === "aggregate") {
        const failureCountBefore = failures.length;
        const primaryConsumedBefore = primaryRepresentationConsumed;
        const primaryReferenceBefore = primaryReferenceCount;
        const traversalTruncationBefore = traversalTruncationCount;
        const sanitizationBefore = sanitizationCount;
        markSeen(value);
        try {
        const recordInspectionFailure = (message: string, _error: unknown): void => {
          void _error;
          // The thrown accessor value may itself be the primary fault. The
          // distinct inspection failure is therefore represented by a safe marker.
          recordSanitizedEvidence(new Error(message), "hostile-inspection");
        };
        let aggregateOwnPrimitiveCause: OwnPrimitiveFailureCause | null = null;
        try {
          aggregateOwnPrimitiveCause = ownPrimitiveFailureCause(value as object);
        } catch (error: unknown) {
          recordInspectionFailure("Aggregate failure cause could not be inspected.", error);
        }
        if (
          aggregateOwnPrimitiveCause !== null
          && primary !== null
          && consumePrimaryCause
          && !primaryRepresentationConsumed
          && (
            (
              rawPrimaryAvailable
              && this.#terminalRawCauseMatches(
                aggregateOwnPrimitiveCause.value,
              )
            )
            || Object.is(aggregateOwnPrimitiveCause.value, primaryCause)
          )
        ) {
          // Reserve the propagated cause edge before inspecting entries. Any
          // same-value entries are distinct secondary occurrences and must not
          // be consumed after this point.
          primaryRepresentationConsumed = true;
          aggregateOwnPrimitiveCause = null;
        }
        const preservePrimitiveCauseAggregate = (): boolean => {
          if (aggregateOwnPrimitiveCause === null) return false;
          if (budget.exhausted) return true;
          let message = "Sanitized aggregate failure with a primitive cause.";
          try {
            const observedMessage = (value as AggregateError).message;
            if (typeof observedMessage === "string" && observedMessage.length > 0) {
              message = observedMessage;
            }
          } catch {
            // The immutable clone deliberately keeps no source-container reference.
          }
          let nestedEvidence = failures.splice(failureCountBefore);
          if (nestedEvidence.length > MAXIMUM_IMMUTABLE_FAILURE_AGGREGATE_DETAILS) {
            const truncation = new RangeError(
              `Aggregate failure snapshot exceeded ${MAXIMUM_IMMUTABLE_FAILURE_AGGREGATE_DETAILS} entries.`,
            );
            const immutableTruncation = chargeFailureEvidenceNodes(budget)
              ? freezeFailureEvidence(truncation)
              : truncateFailureEvidence(budget);
            nestedEvidence = [
              ...nestedEvidence.slice(
                0,
                MAXIMUM_IMMUTABLE_FAILURE_AGGREGATE_DETAILS - 1,
              ),
              ...(immutableTruncation === OMIT_FAILURE_EVIDENCE
                ? []
                : [immutableTruncation]),
            ];
          }
          const immutableAggregate = immutableAggregateFailureOccurrence(
            nestedEvidence,
            message,
            aggregateOwnPrimitiveCause,
            budget,
            capturedPrimitiveCauses,
          );
          if (immutableAggregate !== OMIT_FAILURE_EVIDENCE) {
            failures.push(immutableAggregate);
          }
          if (budget.exhausted) {
            traversalTruncationCount += 1;
            traversalBudgetEvidenceRecorded = true;
          }
          return true;
        };
        let candidate: unknown[];
        try {
          const observed = (value as AggregateError).errors;
          if (!Array.isArray(observed)) {
            recordSanitizedEvidence(
              new TypeError("Aggregate failure details were not an array."),
            );
            preservePrimitiveCauseAggregate();
            return;
          }
          candidate = observed;
        } catch (error: unknown) {
          recordInspectionFailure("Aggregate failure details could not be read.", error);
          preservePrimitiveCauseAggregate();
          return;
        }
        let length = 0;
        try {
          length = candidate.length;
        } catch (error: unknown) {
          recordInspectionFailure("Aggregate failure detail count could not be read.", error);
          preservePrimitiveCauseAggregate();
          return;
        }
        const maximumFailureDetails = 4_096;
        if (
          !Number.isSafeInteger(length)
          || length < 0
          || length > maximumFailureDetails
        ) {
          recordSanitizedEvidence(new RangeError(
            `Aggregate failure detail count must be a safe integer between 0 and ${maximumFailureDetails}.`,
          ));
          preservePrimitiveCauseAggregate();
          return;
        }
        for (let index = 0; index < length; index += 1) {
          if (budget.exhausted) break;
          let nested: unknown;
          try {
            if (!Object.prototype.hasOwnProperty.call(candidate, index)) continue;
            nested = candidate[index];
          } catch (error: unknown) {
            recordInspectionFailure(
              `Aggregate failure detail ${index} could not be read.`,
              error,
            );
            continue;
          }
          try {
            visit(nested, depth + 1);
          } catch (error: unknown) {
            // A single hostile child must never cause the containing aggregate,
            // which may reference the terminal error, to be reattached wholesale.
            recordInspectionFailure(
              `Aggregate failure detail ${index} could not be inspected.`,
              error,
            );
          }
        }
        if (preservePrimitiveCauseAggregate()) return;
        if (
          failures.length === failureCountBefore
          && primaryRepresentationConsumed === primaryConsumedBefore
          && primaryReferenceCount === primaryReferenceBefore
          && traversalTruncationCount === traversalTruncationBefore
          && sanitizationCount === sanitizationBefore
        ) {
          let message = "Sanitized aggregate failure with no inspectable entries.";
          try {
            const observedMessage = (value as AggregateError).message;
            if (typeof observedMessage === "string" && observedMessage.length > 0) {
              message = observedMessage;
            }
          } catch {
            // The safe clone intentionally has no reference back to the source container.
          }
          const sanitizedAggregate = new AggregateError([], message);
          Object.freeze(sanitizedAggregate.errors);
          recordSanitizedEvidence(sanitizedAggregate);
        }
        } finally {
          activePath.delete(value);
        }
        return;
      }
      let capturedErrorOwnPrimitiveCause: OwnPrimitiveFailureCause | null | undefined;
      if (classification === "error") {
        markSeen(value);
        try {
        let nestedCause: unknown;
        let causePresence: boolean | null = null;
        try {
          try {
            causePresence = "cause" in (value as object);
          } catch {
            causePresence = null;
          }
          // Read once even when a Proxy lies about property presence. A directly
          // observed terminal reference must always be stripped.
          nestedCause = (value as Error).cause;
          if (primary !== null && nestedCause === primary) {
            primaryReferenceCount += 1;
            return;
          }
          if (
            primary !== null
            && causePresence === true
            && consumePrimaryCause
            && !primaryRepresentationConsumed
            && Object.is(nestedCause, primaryCause)
          ) {
            primaryRepresentationConsumed = true;
            return;
          }
        } catch {
          recordSanitizedEvidence(
            new Error("Error failure cause could not be inspected."),
            "hostile-inspection",
          );
          return;
        }
        try {
          capturedErrorOwnPrimitiveCause = ownPrimitiveFailureCause(value as object);
          capturedPrimitiveCauses.set(
            value as object,
            capturedErrorOwnPrimitiveCause,
          );
        } catch {
          recordSanitizedEvidence(new Error(
            "Error failure cause descriptor could not be inspected.",
          ), "hostile-inspection");
          return;
        }
        if (causePresence === null && nestedCause === undefined) {
          recordSanitizedEvidence(
            new Error("Error failure cause presence could not be inspected."),
            "hostile-inspection",
          );
          return;
        }
        if (causePresence === false && nestedCause === undefined) {
          activePath.delete(value);
          recordOpaque(value, capturedErrorOwnPrimitiveCause);
          return;
        }
        const nestedClassification = classify(nestedCause);
        if (nestedClassification === "uninspectable") {
          recordSanitizedEvidence(
            new Error("Nested failure cause type could not be inspected."),
            "hostile-inspection",
          );
          return;
        }
        if (
          nestedClassification === "error"
          || nestedClassification === "aggregate"
          || (nestedClassification === "opaque" && hasIdentity(nestedCause))
        ) {
          const failureCountBefore = failures.length;
          const primaryConsumedBefore = primaryRepresentationConsumed;
          const primaryReferenceBefore = primaryReferenceCount;
          const traversalTruncationBefore = traversalTruncationCount;
          const sanitizationBefore = sanitizationCount;
          visit(nestedCause, depth + 1, nestedClassification);
          if (
            (primary === null && failures.length > failureCountBefore)
            ||
            primaryRepresentationConsumed !== primaryConsumedBefore
            || primaryReferenceCount !== primaryReferenceBefore
            || traversalTruncationCount !== traversalTruncationBefore
            || sanitizationCount !== sanitizationBefore
          ) {
            return;
          }
          failures.splice(failureCountBefore);
        }
        activePath.delete(value);
        } finally {
          activePath.delete(value);
        }
      }
      if (classification === "opaque" && hasIdentity(value)) {
        // Never attach an unknown object graph directly: it may be a
        // cross-realm or Proxy-wrapped error that hides the published terminal
        // error behind fields we cannot inspect safely.
        recordSanitizedEvidence(new Error("Opaque failure value was sanitized."));
        return;
      }
      recordOpaque(value, capturedErrorOwnPrimitiveCause);
    };
    try {
      visit(rejection, 0);
    } catch {
      traversalTruncationCount += 1;
      if (!traversalBudgetEvidenceRecorded) {
        traversalBudgetEvidenceRecorded = true;
        recordSanitizedEvidence(
          new Error("Failure evidence traversal aborted unexpectedly."),
          "hostile-inspection",
        );
      }
    }
    return Object.freeze(failures);
  }

  #finalizeTerminalFailure(
    primary: RenderHostError,
    failures: readonly unknown[],
    publishCleanupError: boolean,
  ): RenderHostError {
    let wrapped: RenderHostError;
    let shouldPublishCleanupError = false;
    try {
      if (this.#terminalFailureFinalized && this.#terminalError) {
        wrapped = this.#terminalError;
        if (publishCleanupError && failures.length > 0 && !this.#cleanupFailureEventPublished) {
          this.#cleanupFailureEventPublished = true;
          shouldPublishCleanupError = true;
        }
      } else {
        wrapped = this.#withCleanupFailures(primary, failures);
        this.#terminalError = wrapped;
        this.#terminalFailureFinalized = true;
        if (publishCleanupError && failures.length > 0) {
          this.#cleanupFailureEventPublished = true;
          shouldPublishCleanupError = true;
        }
      }
    } finally {
      // Raw caller-owned graphs are needed only to match one propagated primary
      // occurrence while cleanup drains. Never retain them after evidence is final.
      this.#releaseTerminalRawCause();
      this.#releaseIntermediateFailureSnapshots();
    }
    if (shouldPublishCleanupError) {
      this.#observe({ kind: "disposal-error", error: wrapped });
    }
    return wrapped;
  }

  #releaseTerminalRawCause(): void {
    this.#terminalRawCause = undefined;
    this.#terminalRawCausePresent = false;
    this.#terminalRawCauseIsWeak = false;
  }

  #releaseControlTailRawFailure(): void {
    this.#controlTailRawFailure = undefined;
    this.#controlTailRetainsFailure = false;
    this.#controlTailRawFailureIsWeak = false;
  }

  #releaseIntermediateFailureSnapshots(): void {
    this.#pendingDroppedTelemetryFrames = [];
    this.#preCleanupFailures = [];
    this.#preCleanupFailureChannels = [];
    this.#cleanupFailureWorkspace = null;
    this.#cleanupPromiseResult = EMPTY_CLEANUP_FAILURES;
    this.#cleanupFailureChannels = EMPTY_CLEANUP_FAILURE_CHANNELS;
    // A settled Promise permanently retains its fulfillment value. Replace it
    // with a shared empty sentinel after terminal evidence owns the bounded copy.
    this.#cleanupPromise = EMPTY_FULFILLED_CLEANUP_PROMISE;
  }

  #captureTerminalRawCauseOccurrence(value: unknown): void {
    this.#terminalRawCausePresent = true;
    if (
      (typeof value === "object" && value !== null)
      || typeof value === "function"
    ) {
      this.#terminalRawCause = new WeakRef(value as object);
      this.#terminalRawCauseIsWeak = true;
      return;
    }
    this.#terminalRawCause = value as PrimitiveFailureCause;
    this.#terminalRawCauseIsWeak = false;
  }

  #captureControlTailRawFailure(value: unknown): void {
    this.#controlTailRetainsFailure = true;
    if (
      (typeof value === "object" && value !== null)
      || typeof value === "function"
    ) {
      this.#controlTailRawFailure = new WeakRef(value as object);
      this.#controlTailRawFailureIsWeak = true;
      return;
    }
    this.#controlTailRawFailure = value as PrimitiveFailureCause;
    this.#controlTailRawFailureIsWeak = false;
  }

  #controlTailRawFailureMatches(value: unknown): boolean {
    if (!this.#controlTailRetainsFailure) return false;
    if (!this.#controlTailRawFailureIsWeak) {
      return Object.is(value, this.#controlTailRawFailure);
    }
    const reference = (this.#controlTailRawFailure as WeakRef<object>).deref();
    return reference !== undefined && value === reference;
  }

  #terminalAndControlTailRawFailuresMatch(): boolean {
    if (!this.#terminalRawCausePresent || !this.#controlTailRetainsFailure) return false;
    if (this.#terminalRawCauseIsWeak) {
      const reference = (this.#terminalRawCause as WeakRef<object>).deref();
      return reference !== undefined && this.#controlTailRawFailureMatches(reference);
    }
    return this.#controlTailRawFailureMatches(this.#terminalRawCause);
  }

  #terminalRawCauseMatches(value: unknown): boolean {
    if (!this.#terminalRawCausePresent) return false;
    if (!this.#terminalRawCauseIsWeak) {
      return Object.is(value, this.#terminalRawCause);
    }
    const reference = (this.#terminalRawCause as WeakRef<object>).deref();
    return reference !== undefined && value === reference;
  }

  #stopFrameLoop(): void {
    if (this.#frameLoopStopped) return;
    this.#invokeOwnedCallback(() => this.#dependencies.frameLoop.stop());
    const running = this.#invokeOwnedCallback(
      () => this.#dependencies.frameLoop.running,
    );
    if (running) {
      this.#frameLoopStopFailure ??= new Error(
        "Render frame loop stop returned while the loop was still running.",
      );
      throw this.#frameLoopStopFailure;
    }
    this.#frameLoopStopped = true;
  }

  #sampleTelemetryNow(): number | null {
    const instrumentation = this.#instrumentation;
    if (instrumentation === null) return null;
    try {
      const observed = this.#invokeOwnedCallback(instrumentation.now);
      return typeof observed === "number"
        && Number.isFinite(observed)
        && observed >= 0
        && !Object.is(observed, -0)
        ? observed
        : null;
    } catch {
      return null;
    }
  }

  #recordTelemetryOperation(event: Readonly<GfxOperationalEventInput>): boolean {
    const instrumentation = this.#instrumentation;
    if (instrumentation === null) return false;
    try {
      this.#invokeOwnedCallback(
        () => instrumentation.recordOperation(hostIntrinsicObjectFreeze(event)),
      );
      return true;
    } catch {
      // Performance evidence is diagnostic and cannot affect renderer lifecycle.
      return false;
    }
  }

  #completeTelemetryOperation(
    input: Omit<GfxOperationalEventInput, "durationMs" | "startedAtMs">,
    startedAtMs: number | null,
  ): void {
    if (startedAtMs === null) return;
    const endedAtMs = this.#sampleTelemetryNow();
    if (endedAtMs === null) return;
    this.#recordTelemetryOperation({
      ...input,
      startedAtMs,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
    });
  }

  #telemetryBackendFrame(): Readonly<RenderBackendFrameTelemetry> {
    try {
      return this.#invokeOwnedCallback(() => {
        const backend = this.#dependencies.backend;
        const snapshot = backend.snapshotFrameTelemetry;
        return typeof snapshot === "function"
          ? Reflect.apply(snapshot, backend, [])
          : UNAVAILABLE_FRAME_TELEMETRY;
      });
    } catch {
      return UNAVAILABLE_FRAME_TELEMETRY;
    }
  }

  #telemetryResources(): Readonly<RenderResourceSnapshot> {
    try {
      return this.#invokeOwnedCallback(() => {
        const backendResources = this.#dependencies.backend.snapshotResources();
        const pendingUploads = this.#dependencies.uploads.pendingCount();
        return Object.freeze({ ...backendResources, pendingUploads });
      });
    } catch {
      try {
        return this.#invokeOwnedCallback(() => {
          const resources = this.#dependencies.resources.snapshot();
          const pendingUploads = this.#dependencies.uploads.pendingCount();
          return Object.freeze({ ...resources, pendingUploads });
        });
      } catch {
        return EMPTY_TELEMETRY_RESOURCES;
      }
    }
  }

  #telemetryBackendApi(): "WebGPU" | "WebGL2" | null {
    try {
      const actualApi = this.#invokeOwnedCallback(
        () => this.#dependencies.backend.facts.actualApi,
      );
      return actualApi === "WebGPU" || actualApi === "WebGL2" ? actualApi : null;
    } catch {
      return null;
    }
  }

  #recordTelemetryFrame(
    clock: Readonly<RenderOperationClock>,
    snapshot: Readonly<JourneyRenderSnapshot>,
    startedAtMs: number | null,
    submitted: boolean,
    passes: readonly RenderPass[],
  ): void {
    const instrumentation = this.#instrumentation;
    const quality = this.#quality;
    if (instrumentation === null || quality === null || startedAtMs === null) return;
    const endedAtMs = this.#sampleTelemetryNow();
    if (endedAtMs === null) return;
    let transparentPasses = 0;
    let fullscreenPasses = 0;
    for (let index = 0; index < passes.length; index += 1) {
      const kind = passes[index]!.kind.toLowerCase();
      if (kind.includes("transparent")) transparentPasses += 1;
      if (
        kind.includes("fullscreen")
        || kind.includes("post")
        || kind.includes("temporal")
        || kind.includes("composite")
      ) {
        fullscreenPasses += 1;
      }
    }
    const frame = Object.freeze({
      frameId: clock.frame,
      rafTimestampMs: clock.nowMs,
      storyTime: snapshot.storyTime,
      qualityTier: quality.tier,
      backendApi: this.#telemetryBackendApi(),
      mainThreadWorkMs: Math.max(0, endedAtMs - startedAtMs),
      submitted,
      passCount: passes.length,
      transparentPasses,
      fullscreenPasses,
      renderer: this.#telemetryBackendFrame(),
      resources: this.#telemetryResources(),
    }) satisfies Readonly<GfxFrameTelemetryInput>;
    try {
      this.#invokeOwnedCallback(() => instrumentation.recordFrame(frame));
    } catch {
      // Performance evidence is diagnostic and cannot affect renderer lifecycle.
    }
  }

  #captureDroppedTelemetryFrame(
    frameId: number,
    rafTimestampMs: number,
  ): Readonly<PendingDroppedTelemetryFrame> | null {
    const instrumentation = this.#instrumentation;
    const snapshot = this.#snapshot;
    const quality = this.#quality;
    if (instrumentation === null || snapshot === null || quality === null) return null;
    return Object.freeze({
      frameId,
      rafTimestampMs,
      storyTime: snapshot.storyTime,
      qualityTier: quality.tier,
    });
  }

  #recordDroppedTelemetryFrame(entry: Readonly<PendingDroppedTelemetryFrame>): void {
    const instrumentation = this.#instrumentation;
    if (instrumentation === null) return;
    const frame = Object.freeze({
      frameId: entry.frameId,
      rafTimestampMs: entry.rafTimestampMs,
      storyTime: entry.storyTime,
      qualityTier: entry.qualityTier,
      backendApi: this.#telemetryBackendApi(),
      mainThreadWorkMs: 0,
      submitted: false,
      passCount: 0,
      transparentPasses: 0,
      fullscreenPasses: 0,
      renderer: UNAVAILABLE_FRAME_TELEMETRY,
      resources: EMPTY_TELEMETRY_RESOURCES,
    }) satisfies Readonly<GfxFrameTelemetryInput>;
    try {
      this.#invokeOwnedCallback(() => instrumentation.recordFrame(frame));
    } catch {
      // Performance evidence is diagnostic and cannot affect renderer lifecycle.
    }
  }

  #flushDroppedTelemetryFrames(): void {
    const pending = this.#pendingDroppedTelemetryFrames;
    this.#pendingDroppedTelemetryFrames = [];
    for (let index = 0; index < pending.length; index += 1) {
      const entry = pending[index]!;
      this.#recordDroppedTelemetryFrame(entry);
    }
  }

  #invokeOwnedCallback<T>(operation: () => T): T {
    this.#ownedCallbackDepth += 1;
    try {
      return operation();
    } finally {
      this.#ownedCallbackDepth -= 1;
    }
  }

  #invokeHostCallback<T>(operation: () => T): T {
    const ownedDepth = this.#ownedCallbackDepth;
    this.#ownedCallbackDepth = 0;
    try {
      return operation();
    } finally {
      this.#ownedCallbackDepth = ownedDepth;
    }
  }

  #currentTerminalFailure(): RenderHostError | null {
    return this.#lifecycle === "failed" ? this.#terminalError : null;
  }

  #transition(next: RenderHostLifecycle): void {
    const from = this.#lifecycle;
    this.#lifecycle = next;
    this.#observe({ kind: "lifecycle", from, to: next });
  }

  #observe(event: RenderHostEvent): void {
    this.#probeEvents.push(Object.freeze({
      id: this.#nextProbeEventId,
      kind: event.kind,
      detail: this.#eventDetail(event),
    }));
    this.#nextProbeEventId += 1;
    if (this.#probeEvents.length > 128) this.#probeEvents.shift();
    try {
      this.#invokeOwnedCallback(
        () => this.#dependencies.observer.observe(Object.freeze(event)),
      );
    } catch {
      // Diagnostics must never change renderer lifecycle or simulation behavior.
    }
    this.#notifyProbeListeners();
  }

  #eventDetail(event: RenderHostEvent): string {
    try {
      if (event.kind === "lifecycle") return `${event.from}->${event.to}`;
      if (event.kind === "backend-event") return event.event.kind;
      try {
        if (event.error instanceof Error) return event.error.message;
      } catch {
        return "[uninspectable error]";
      }
      try {
        return String(event.error);
      } catch {
        return "[uninspectable error]";
      }
    } catch {
      return "[uninspectable event]";
    }
  }

  #notifyProbeListeners(): void {
    for (const listener of [...this.#probeListeners]) {
      try {
        this.#invokeHostCallback(listener);
      } catch {
        // Probe subscribers are diagnostic only.
      }
    }
  }

  #notifyAndClearProbeListeners(): void {
    const listeners = [...this.#probeListeners];
    this.#probeListeners.clear();
    for (const listener of listeners) {
      try {
        this.#invokeHostCallback(listener);
      } catch {
        // Final diagnostic delivery must not change terminal cleanup semantics.
      }
    }
  }

  #assertInitializing(): void {
    if (this.#lifecycle !== "initializing") {
      throw this.#terminalError ?? lifecycleError(
        "continue initialization",
        this.#lifecycle,
        this.#errorOwner,
      );
    }
  }

  #assertSnapshotWritable(): void {
    if (
      this.#lifecycle === "disposing"
      || this.#lifecycle === "disposed"
      || this.#lifecycle === "failed"
    ) {
      throw lifecycleError("set a snapshot", this.#lifecycle, this.#errorOwner);
    }
  }

  #assertControlCanContinue(): void {
    if (this.#lifecycle === "failed" || this.#lifecycle === "disposed") {
      throw this.#terminalError ?? lifecycleError(
        "continue a render control",
        this.#lifecycle,
        this.#errorOwner,
      );
    }
  }

  #assertFrameCanContinue(): void {
    if (this.#lifecycle === "failed" || this.#lifecycle === "disposed") {
      throw this.#terminalError ?? lifecycleError(
        "continue a render frame",
        this.#lifecycle,
        this.#errorOwner,
      );
    }
  }

  #assertNoOwnedCallbackReentry(operation: string): void {
    if (this.#ownedCallbackDepth > 0) {
      throw lifecycleError(
        `${operation} from an owned dependency callback`,
        this.#lifecycle,
        this.#errorOwner,
      );
    }
  }
}
