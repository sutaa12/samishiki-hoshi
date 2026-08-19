import {
  RENDER_HISTORY_INVALIDATION_REASONS,
  type RenderHistoryInvalidationReason,
  type RenderBackendFrameTelemetry,
  type RendererApi,
  type RenderQualityTier,
  type RenderResourceSnapshot,
} from "../contracts";
import {
  GFX_TELEMETRY_EVENT_CAPACITY,
  GFX_TELEMETRY_FRAME_CAPACITY,
  GFX_TELEMETRY_MINIMUM_PERCENTILE_SAMPLES,
  GFX_TELEMETRY_RUNTIME_SPIKE_MS,
  type GfxFrameTelemetryInput,
  type GfxLatestFrameSnapshot,
  type GfxMetricPercentiles,
  type GfxOperationalEventInput,
  type GfxOperationalEventKind,
  type GfxOperationalEventSnapshot,
  type GfxPerformanceTelemetry,
  type GfxPerformanceTelemetrySnapshot,
} from "./contracts";

const intrinsicDefineProperty = Object.defineProperty;
const intrinsicFreeze = Object.freeze;
const intrinsicNumberIsFinite = Number.isFinite;
const intrinsicNumberIsSafeInteger = Number.isSafeInteger;
const intrinsicObjectIs = Object.is;
const intrinsicMathCeil = Math.ceil;
const intrinsicMathMax = Math.max;
const intrinsicMathMin = Math.min;
const intrinsicReflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const intrinsicSort = Array.prototype.sort;
const intrinsicReflectApply = Reflect.apply;

const OPERATION_KINDS = intrinsicFreeze([
  "initialization",
  "compile",
  "upload",
  "activation",
  "quality-change",
  "history-reset",
] as const);

const EMPTY_BACKEND_FRAME = intrinsicFreeze({
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

function ownDataValue(source: object, key: PropertyKey, label: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = intrinsicReflectGetOwnPropertyDescriptor(source, key);
  } catch {
    throw new TypeError(`${label}.${String(key)} could not be inspected.`);
  }
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`${label}.${String(key)} must be an own data property.`);
  }
  return descriptor.value;
}

function optionalOwnDataValue(source: object, key: PropertyKey, label: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = intrinsicReflectGetOwnPropertyDescriptor(source, key);
  } catch {
    throw new TypeError(`${label}.${String(key)} could not be inspected.`);
  }
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    throw new TypeError(`${label}.${String(key)} must be an own data property when present.`);
  }
  return descriptor.value;
}

function recordFromKeys(
  source: unknown,
  keys: readonly PropertyKey[],
  label: string,
): Readonly<Record<PropertyKey, unknown>> {
  if ((typeof source !== "object" || source === null) && typeof source !== "function") {
    throw new TypeError(`${label} must be an object.`);
  }
  const values: Record<PropertyKey, unknown> = {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    intrinsicDefineProperty(values, key, {
      configurable: true,
      enumerable: true,
      value: ownDataValue(source, key, label),
      writable: true,
    });
  }
  return values;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !intrinsicNumberIsFinite(value)
    || value < 0
    || intrinsicObjectIs(value, -0)
  ) {
    throw new RangeError(`${label} must be a finite non-negative number.`);
  }
  return value;
}

function safeCount(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !intrinsicNumberIsSafeInteger(value)
    || value < 0
    || intrinsicObjectIs(value, -0)
  ) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function nullableSafeCount(value: unknown, label: string): number | null {
  return value === null ? null : safeCount(value, label);
}

function nullableFiniteNonNegative(value: unknown, label: string): number | null {
  return value === null ? null : finiteNonNegative(value, label);
}

function qualityTier(value: unknown): RenderQualityTier {
  if (value !== "low" && value !== "balanced" && value !== "high") {
    throw new TypeError("Telemetry quality tier is invalid.");
  }
  return value;
}

function rendererApi(value: unknown): RendererApi | null {
  if (value !== null && value !== "WebGPU" && value !== "WebGL2") {
    throw new TypeError("Telemetry renderer API is invalid.");
  }
  return value;
}

function captureBackendFrame(input: unknown): Readonly<RenderBackendFrameTelemetry> {
  const values = recordFromKeys(input, [
    "available",
    "drawCalls",
    "triangles",
    "lines",
    "points",
    "pixelRatio",
    "drawingBufferWidth",
    "drawingBufferHeight",
    "gpuTimeMs",
  ], "frame.renderer");
  if (typeof values.available !== "boolean") {
    throw new TypeError("frame.renderer.available must be boolean.");
  }
  return intrinsicFreeze({
    available: values.available,
    drawCalls: nullableSafeCount(values.drawCalls, "frame.renderer.drawCalls"),
    triangles: nullableSafeCount(values.triangles, "frame.renderer.triangles"),
    lines: nullableSafeCount(values.lines, "frame.renderer.lines"),
    points: nullableSafeCount(values.points, "frame.renderer.points"),
    pixelRatio: nullableFiniteNonNegative(values.pixelRatio, "frame.renderer.pixelRatio"),
    drawingBufferWidth: nullableSafeCount(
      values.drawingBufferWidth,
      "frame.renderer.drawingBufferWidth",
    ),
    drawingBufferHeight: nullableSafeCount(
      values.drawingBufferHeight,
      "frame.renderer.drawingBufferHeight",
    ),
    gpuTimeMs: nullableFiniteNonNegative(values.gpuTimeMs, "frame.renderer.gpuTimeMs"),
  });
}

function captureResources(input: unknown): Readonly<RenderResourceSnapshot> {
  const values = recordFromKeys(input, [
    "geometries",
    "textures",
    "renderTargets",
    "programs",
    "nodes",
    "objects",
    "subscribers",
    "pendingUploads",
  ], "frame.resources");
  return intrinsicFreeze({
    geometries: safeCount(values.geometries, "frame.resources.geometries"),
    textures: safeCount(values.textures, "frame.resources.textures"),
    renderTargets: safeCount(values.renderTargets, "frame.resources.renderTargets"),
    programs: safeCount(values.programs, "frame.resources.programs"),
    nodes: safeCount(values.nodes, "frame.resources.nodes"),
    objects: safeCount(values.objects, "frame.resources.objects"),
    subscribers: safeCount(values.subscribers, "frame.resources.subscribers"),
    pendingUploads: safeCount(values.pendingUploads, "frame.resources.pendingUploads"),
  });
}

function captureFrame(input: Readonly<GfxFrameTelemetryInput>): Readonly<GfxFrameTelemetryInput> {
  const values = recordFromKeys(input, [
    "frameId",
    "rafTimestampMs",
    "storyTime",
    "qualityTier",
    "backendApi",
    "mainThreadWorkMs",
    "submitted",
    "passCount",
    "transparentPasses",
    "fullscreenPasses",
    "renderer",
    "resources",
  ], "frame");
  if (typeof values.submitted !== "boolean") {
    throw new TypeError("frame.submitted must be boolean.");
  }
  return intrinsicFreeze({
    frameId: safeCount(values.frameId, "frame.frameId"),
    rafTimestampMs: finiteNonNegative(values.rafTimestampMs, "frame.rafTimestampMs"),
    storyTime: finiteNonNegative(values.storyTime, "frame.storyTime"),
    qualityTier: qualityTier(values.qualityTier),
    backendApi: rendererApi(values.backendApi),
    mainThreadWorkMs: finiteNonNegative(values.mainThreadWorkMs, "frame.mainThreadWorkMs"),
    submitted: values.submitted,
    passCount: safeCount(values.passCount, "frame.passCount"),
    transparentPasses: safeCount(values.transparentPasses, "frame.transparentPasses"),
    fullscreenPasses: safeCount(values.fullscreenPasses, "frame.fullscreenPasses"),
    renderer: captureBackendFrame(values.renderer),
    resources: captureResources(values.resources),
  });
}

function operationKind(value: unknown): GfxOperationalEventKind {
  for (let index = 0; index < OPERATION_KINDS.length; index += 1) {
    if (OPERATION_KINDS[index] === value) return OPERATION_KINDS[index]!;
  }
  throw new TypeError("Telemetry operation kind is invalid.");
}

function boundedName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError("Telemetry operation name must contain 1 through 128 characters.");
  }
  return value;
}

function historyReason(value: unknown): RenderHistoryInvalidationReason | undefined {
  if (value === undefined) return undefined;
  for (let index = 0; index < RENDER_HISTORY_INVALIDATION_REASONS.length; index += 1) {
    if (RENDER_HISTORY_INVALIDATION_REASONS[index] === value) {
      return RENDER_HISTORY_INVALIDATION_REASONS[index]!;
    }
  }
  throw new TypeError("Telemetry history reset reason is invalid.");
}

function captureOperation(
  input: Readonly<GfxOperationalEventInput>,
): Readonly<GfxOperationalEventInput> {
  const values = recordFromKeys(input, [
    "kind",
    "name",
    "startedAtMs",
    "durationMs",
    "frameId",
    "storyTime",
    "success",
    "affectsStoryTime",
  ], "operation");
  const capturedHistoryReason = optionalOwnDataValue(input, "historyReason", "operation");
  if (typeof values.success !== "boolean" || typeof values.affectsStoryTime !== "boolean") {
    throw new TypeError("Telemetry operation booleans are invalid.");
  }
  const kind = operationKind(values.kind);
  const reason = historyReason(capturedHistoryReason);
  if ((kind === "history-reset") !== (reason !== undefined)) {
    throw new TypeError("History reset telemetry must carry exactly one valid reason.");
  }
  return intrinsicFreeze({
    kind,
    name: boundedName(values.name),
    startedAtMs: finiteNonNegative(values.startedAtMs, "operation.startedAtMs"),
    durationMs: finiteNonNegative(values.durationMs, "operation.durationMs"),
    frameId: values.frameId === null ? null : safeCount(values.frameId, "operation.frameId"),
    storyTime: values.storyTime === null
      ? null
      : finiteNonNegative(values.storyTime, "operation.storyTime"),
    success: values.success,
    affectsStoryTime: values.affectsStoryTime,
    ...(reason === undefined ? {} : { historyReason: reason }),
  });
}

function emptyOperationTotals(): Record<GfxOperationalEventKind, number> {
  return {
    initialization: 0,
    compile: 0,
    upload: 0,
    activation: 0,
    "quality-change": 0,
    "history-reset": 0,
  };
}

function emptyHistoryCounts(): Record<RenderHistoryInvalidationReason, number> {
  const counts = {} as Record<RenderHistoryInvalidationReason, number>;
  for (let index = 0; index < RENDER_HISTORY_INVALIDATION_REASONS.length; index += 1) {
    counts[RENDER_HISTORY_INVALIDATION_REASONS[index]!] = 0;
  }
  return counts;
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const rank = intrinsicMathMax(1, intrinsicMathCeil(percentile * sorted.length));
  return sorted[rank - 1]!;
}

function percentiles(values: number[]): Readonly<GfxMetricPercentiles> {
  const sampleCount = values.length;
  if (sampleCount < GFX_TELEMETRY_MINIMUM_PERCENTILE_SAMPLES) {
    return intrinsicFreeze({ sampleCount, p50: null, p95: null, p99: null });
  }
  intrinsicReflectApply(intrinsicSort, values, [(left: number, right: number) => left - right]);
  return intrinsicFreeze({
    sampleCount,
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99),
  });
}

function appendValue<T>(target: T[], value: T): void {
  intrinsicDefineProperty(target, target.length, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export class RollingGfxPerformanceTelemetry implements GfxPerformanceTelemetry {
  readonly #frameIds = new Float64Array(GFX_TELEMETRY_FRAME_CAPACITY);
  readonly #frameIntervals = new Float64Array(GFX_TELEMETRY_FRAME_CAPACITY);
  readonly #mainThreadWork = new Float64Array(GFX_TELEMETRY_FRAME_CAPACITY);
  readonly #gpuTime = new Float64Array(GFX_TELEMETRY_FRAME_CAPACITY);
  readonly #intervalAvailable = new Uint8Array(GFX_TELEMETRY_FRAME_CAPACITY);
  readonly #gpuAvailable = new Uint8Array(GFX_TELEMETRY_FRAME_CAPACITY);
  readonly #steady = new Uint8Array(GFX_TELEMETRY_FRAME_CAPACITY);
  readonly #submitted = new Uint8Array(GFX_TELEMETRY_FRAME_CAPACITY);
  readonly #events: Readonly<GfxOperationalEventSnapshot>[] = [];
  readonly #pendingOperationalFrames: number[] = [];
  readonly #eventTotals = emptyOperationTotals();
  readonly #historyResetCounts = emptyHistoryCounts();
  #state: GfxPerformanceTelemetrySnapshot["state"] = "active";
  #cursor = 0;
  #retainedFrames = 0;
  #totalFramesObserved = 0;
  #lastRafTimestampMs: number | null = null;
  #lastFrameId: number | null = null;
  #latestFrame: Readonly<GfxLatestFrameSnapshot> | null = null;
  #eventSequence = 0;
  #runtimeSpikesOver50Ms = 0;
  #ingressActive = false;

  recordFrame(input: Readonly<GfxFrameTelemetryInput>): void {
    if (this.#state === "disposed") return;
    if (this.#ingressActive) throw new Error("Telemetry ingress cannot reenter.");
    this.#ingressActive = true;
    try {
      const frame = captureFrame(input);
      if (this.#isDisposed()) return;
      if (this.#lastFrameId !== null && frame.frameId <= this.#lastFrameId) {
        throw new RangeError("Telemetry frame ids must increase strictly.");
      }
      if (
        this.#lastRafTimestampMs !== null
        && frame.rafTimestampMs < this.#lastRafTimestampMs
      ) {
        throw new RangeError("Telemetry RAF timestamps must not move backwards.");
      }
      const interval = this.#lastRafTimestampMs === null
        ? null
        : intrinsicMathMax(0, frame.rafTimestampMs - this.#lastRafTimestampMs);
      this.#lastRafTimestampMs = frame.rafTimestampMs;
      this.#lastFrameId = frame.frameId;
      const operational = this.#takePendingOperationalFrame(frame.frameId);
      const steady = !operational;
      const index = this.#cursor;
      this.#frameIds[index] = frame.frameId;
      this.#frameIntervals[index] = interval ?? 0;
      this.#mainThreadWork[index] = frame.mainThreadWorkMs;
      this.#gpuTime[index] = frame.renderer.gpuTimeMs ?? 0;
      this.#intervalAvailable[index] = interval === null ? 0 : 1;
      this.#gpuAvailable[index] = frame.renderer.gpuTimeMs === null ? 0 : 1;
      this.#steady[index] = steady ? 1 : 0;
      this.#submitted[index] = frame.submitted ? 1 : 0;
      this.#cursor = (index + 1) % GFX_TELEMETRY_FRAME_CAPACITY;
      this.#retainedFrames = intrinsicMathMin(
        GFX_TELEMETRY_FRAME_CAPACITY,
        this.#retainedFrames + 1,
      );
      this.#totalFramesObserved += 1;
      this.#latestFrame = intrinsicFreeze({
        ...frame,
        frameIntervalMs: interval,
        steadyState: steady,
      });
    } finally {
      this.#ingressActive = false;
    }
  }

  recordOperation(input: Readonly<GfxOperationalEventInput>): void {
    if (this.#state === "disposed") return;
    if (this.#ingressActive) throw new Error("Telemetry ingress cannot reenter.");
    this.#ingressActive = true;
    try {
      const operation = captureOperation(input);
      if (this.#isDisposed()) return;
      const exceedsRuntimeSpikeLimit = operation.affectsStoryTime
        && operation.durationMs > GFX_TELEMETRY_RUNTIME_SPIKE_MS;
      this.#eventSequence += 1;
      const event = intrinsicFreeze({
        ...operation,
        sequence: this.#eventSequence,
        exceedsRuntimeSpikeLimit,
      });
      appendValue(this.#events, event);
      if (this.#events.length > GFX_TELEMETRY_EVENT_CAPACITY) {
        for (let index = 1; index < this.#events.length; index += 1) {
          this.#events[index - 1] = this.#events[index]!;
        }
        this.#events.length = GFX_TELEMETRY_EVENT_CAPACITY;
      }
      this.#eventTotals[operation.kind] += 1;
      if (exceedsRuntimeSpikeLimit) this.#runtimeSpikesOver50Ms += 1;
      if (operation.kind === "history-reset") {
        this.#historyResetCounts[operation.historyReason!] += 1;
      }
      if (
        operation.frameId !== null
        && (operation.kind === "upload" || operation.kind === "activation")
      ) {
        if (!this.#markRetainedFrameOperational(operation.frameId)) {
          if (this.#lastFrameId === null || operation.frameId > this.#lastFrameId) {
            this.#rememberPendingOperationalFrame(operation.frameId);
          }
        }
      }
    } finally {
      this.#ingressActive = false;
    }
  }

  snapshot(): Readonly<GfxPerformanceTelemetrySnapshot> {
    const frameValues: number[] = [];
    const mainValues: number[] = [];
    const gpuValues: number[] = [];
    let steadyFrames = 0;
    for (let offset = 0; offset < this.#retainedFrames; offset += 1) {
      const index = (
        this.#cursor - this.#retainedFrames + offset + GFX_TELEMETRY_FRAME_CAPACITY
      ) % GFX_TELEMETRY_FRAME_CAPACITY;
      if (this.#steady[index] !== 1) continue;
      steadyFrames += 1;
      if (this.#intervalAvailable[index] === 1) {
        appendValue(frameValues, this.#frameIntervals[index]!);
      }
      if (this.#submitted[index] !== 1) continue;
      appendValue(mainValues, this.#mainThreadWork[index]!);
      if (this.#gpuAvailable[index] === 1) appendValue(gpuValues, this.#gpuTime[index]!);
    }
    return intrinsicFreeze({
      state: this.#state,
      window: intrinsicFreeze({
        capacity: GFX_TELEMETRY_FRAME_CAPACITY,
        minimumPercentileSamples: GFX_TELEMETRY_MINIMUM_PERCENTILE_SAMPLES,
        retainedFrames: this.#retainedFrames,
        steadyFrames,
        excludedOperationalFrames: this.#retainedFrames - steadyFrames,
        totalFramesObserved: this.#totalFramesObserved,
      }),
      frameIntervalMs: percentiles(frameValues),
      mainThreadWorkMs: percentiles(mainValues),
      gpuTimeMs: percentiles(gpuValues),
      gpuTimingSupported: gpuValues.length > 0,
      latestFrame: this.#latestFrame,
      events: this.#snapshotEvents(),
      eventTotals: intrinsicFreeze({ ...this.#eventTotals }),
      runtimeSpikesOver50Ms: this.#runtimeSpikesOver50Ms,
      historyResetCounts: intrinsicFreeze({ ...this.#historyResetCounts }),
    });
  }

  dispose(): void {
    this.#state = "disposed";
    this.#pendingOperationalFrames.length = 0;
  }

  #takePendingOperationalFrame(frameId: number): boolean {
    const pending = this.#pendingOperationalFrames;
    for (let index = 0; index < pending.length; index += 1) {
      if (pending[index] !== frameId) continue;
      for (let move = index + 1; move < pending.length; move += 1) {
        pending[move - 1] = pending[move]!;
      }
      pending.length -= 1;
      return true;
    }
    return false;
  }

  #rememberPendingOperationalFrame(frameId: number): void {
    const pending = this.#pendingOperationalFrames;
    for (let index = 0; index < pending.length; index += 1) {
      if (pending[index] === frameId) return;
    }
    if (pending.length < GFX_TELEMETRY_FRAME_CAPACITY) {
      pending[pending.length] = frameId;
      return;
    }
    for (let index = 1; index < pending.length; index += 1) {
      pending[index - 1] = pending[index]!;
    }
    pending[pending.length - 1] = frameId;
  }

  #snapshotEvents(): readonly Readonly<GfxOperationalEventSnapshot>[] {
    const snapshot: Readonly<GfxOperationalEventSnapshot>[] = [];
    for (let index = 0; index < this.#events.length; index += 1) {
      appendValue(snapshot, this.#events[index]!);
    }
    return intrinsicFreeze(snapshot);
  }

  #markRetainedFrameOperational(frameId: number): boolean {
    for (let offset = 0; offset < this.#retainedFrames; offset += 1) {
      const index = (
        this.#cursor - this.#retainedFrames + offset + GFX_TELEMETRY_FRAME_CAPACITY
      ) % GFX_TELEMETRY_FRAME_CAPACITY;
      if (this.#frameIds[index] !== frameId) continue;
      this.#steady[index] = 0;
      if (this.#latestFrame?.frameId === frameId && this.#latestFrame.steadyState) {
        this.#latestFrame = intrinsicFreeze({ ...this.#latestFrame, steadyState: false });
      }
      return true;
    }
    return false;
  }

  #isDisposed(): boolean {
    return this.#state === "disposed";
  }
}

export { EMPTY_BACKEND_FRAME };
