import {
  RENDER_HISTORY_INVALIDATION_REASONS,
  type RenderHistoryInvalidationReason,
  type RenderViewport,
} from "../contracts";

const intrinsicDefineProperty = Object.defineProperty;
const intrinsicFreeze = Object.freeze;
const intrinsicNumberIsFinite = Number.isFinite;
const intrinsicReflectApply = Reflect.apply;
const intrinsicSetAdd = Set.prototype.add;
const intrinsicSetClear = Set.prototype.clear;
const intrinsicSetForEach = Set.prototype.forEach;
const intrinsicSetHas = Set.prototype.has;
const intrinsicSetSize = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!;

function appendArrayValue<T>(target: T[], value: T): void {
  intrinsicDefineProperty(target, target.length, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export interface TemporalHistorySnapshot {
  readonly state: "new" | "ready" | "disposed";
  readonly generation: number;
  readonly valid: boolean;
  readonly frameActive: boolean;
  readonly viewport: Readonly<RenderViewport> | null;
  readonly pendingReasons: readonly RenderHistoryInvalidationReason[];
  readonly resetCounts: Readonly<Record<RenderHistoryInvalidationReason, number>>;
}

export interface TemporalHistoryFrame {
  readonly generation: number;
  readonly blendWeight: number;
  readonly resetReasons: readonly RenderHistoryInvalidationReason[];
}

function captureDimension(value: unknown, label: string, minimum: number): number {
  if (!intrinsicNumberIsFinite(value) || (value as number) < minimum) {
    throw new RangeError(`${label} must be a finite number >= ${minimum}.`);
  }
  return value as number;
}

function captureViewport(viewport: Readonly<RenderViewport>): Readonly<RenderViewport> {
  return intrinsicFreeze({
    width: captureDimension(viewport.width, "viewport.width", 1),
    height: captureDimension(viewport.height, "viewport.height", 1),
    pixelRatio: captureDimension(viewport.pixelRatio, "viewport.pixelRatio", Number.MIN_VALUE),
  });
}

function emptyResetCounts(): Record<RenderHistoryInvalidationReason, number> {
  const counts = {} as Record<RenderHistoryInvalidationReason, number>;
  for (let index = 0; index < RENDER_HISTORY_INVALIDATION_REASONS.length; index += 1) {
    counts[RENDER_HISTORY_INVALIDATION_REASONS[index]!] = 0;
  }
  return counts;
}

function isHistoryInvalidationReason(value: unknown): value is RenderHistoryInvalidationReason {
  for (let index = 0; index < RENDER_HISTORY_INVALIDATION_REASONS.length; index += 1) {
    if (RENDER_HISTORY_INVALIDATION_REASONS[index] === value) return true;
  }
  return false;
}

function capturePendingReasons(
  source: Set<RenderHistoryInvalidationReason>,
): readonly RenderHistoryInvalidationReason[] {
  const reasons: RenderHistoryInvalidationReason[] = [];
  intrinsicReflectApply(intrinsicSetForEach, source, [(
    reason: RenderHistoryInvalidationReason,
  ) => {
    appendArrayValue(reasons, reason);
  }]);
  return intrinsicFreeze(reasons);
}

export class TemporalHistoryOwner {
  readonly #historyWeight: number;
  readonly #pendingReasons = new Set<RenderHistoryInvalidationReason>();
  readonly #resetCounts = emptyResetCounts();
  #state: TemporalHistorySnapshot["state"] = "new";
  #viewport: Readonly<RenderViewport> | null = null;
  #generation = 0;
  #valid = false;
  #frameActive = false;
  #viewportMutation: "initialize" | "resize" | null = null;

  constructor(historyWeight = 0.1) {
    if (!Number.isFinite(historyWeight) || historyWeight < 0 || historyWeight > 0.25) {
      throw new RangeError("Temporal history weight must be from 0 through 0.25.");
    }
    this.#historyWeight = historyWeight;
  }

  initialize(viewport: Readonly<RenderViewport>): void {
    this.#assertNoViewportMutation("initialize temporal history");
    if (this.#state !== "new") {
      throw new Error(`Cannot initialize temporal history while ${this.#state}.`);
    }
    this.#viewportMutation = "initialize";
    try {
      const capturedViewport = captureViewport(viewport);
      if (this.#state !== "new" || this.#viewportMutation !== "initialize") {
        throw new Error(`Cannot initialize temporal history after it became ${this.#state}.`);
      }
      this.#viewport = capturedViewport;
      this.#state = "ready";
      this.#invalidateOwned("initialization");
    } finally {
      this.#viewportMutation = null;
    }
  }

  resize(viewport: Readonly<RenderViewport>): boolean {
    this.#assertNoViewportMutation("resize temporal history");
    this.#assertReady("resize temporal history");
    this.#viewportMutation = "resize";
    try {
      const next = captureViewport(viewport);
      if (this.#state !== "ready" || this.#viewportMutation !== "resize") {
        throw new Error(`Cannot resize temporal history after it became ${this.#state}.`);
      }
      if (
        this.#viewport!.width === next.width
        && this.#viewport!.height === next.height
        && this.#viewport!.pixelRatio === next.pixelRatio
      ) return false;
      this.#viewport = next;
      this.#invalidateOwned("resize");
      return true;
    } finally {
      this.#viewportMutation = null;
    }
  }

  invalidate(reason: RenderHistoryInvalidationReason): boolean {
    this.#assertNoViewportMutation("invalidate temporal history");
    this.#assertReady("invalidate temporal history");
    if (!isHistoryInvalidationReason(reason)) {
      throw new TypeError("Unknown temporal-history invalidation reason.");
    }
    return this.#invalidateOwned(reason);
  }

  #invalidateOwned(reason: RenderHistoryInvalidationReason): boolean {
    this.#valid = false;
    if (intrinsicReflectApply(intrinsicSetHas, this.#pendingReasons, [reason])) return false;
    intrinsicReflectApply(intrinsicSetAdd, this.#pendingReasons, [reason]);
    this.#resetCounts[reason] += 1;
    this.#generation += 1;
    return true;
  }

  beginFrame(): Readonly<TemporalHistoryFrame> {
    this.#assertNoViewportMutation("begin a temporal frame");
    this.#assertReady("begin a temporal frame");
    if (this.#frameActive) throw new Error("A temporal-history frame is already active.");
    this.#frameActive = true;
    const resetReasons = capturePendingReasons(this.#pendingReasons);
    intrinsicReflectApply(intrinsicSetClear, this.#pendingReasons, []);
    return intrinsicFreeze({
      generation: this.#generation,
      blendWeight: this.#valid && resetReasons.length === 0 ? this.#historyWeight : 0,
      resetReasons,
    });
  }

  completeFrame(success: boolean): void {
    this.#assertNoViewportMutation("complete a temporal frame");
    this.#assertReady("complete a temporal frame");
    if (!this.#frameActive) throw new Error("No temporal-history frame is active.");
    this.#frameActive = false;
    this.#valid = success
      && intrinsicReflectApply(intrinsicSetSize, this.#pendingReasons, []) === 0;
  }

  snapshot(): Readonly<TemporalHistorySnapshot> {
    return intrinsicFreeze({
      state: this.#state,
      generation: this.#generation,
      valid: this.#valid,
      frameActive: this.#frameActive,
      viewport: this.#viewport,
      pendingReasons: capturePendingReasons(this.#pendingReasons),
      resetCounts: intrinsicFreeze({ ...this.#resetCounts }),
    });
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    intrinsicReflectApply(intrinsicSetClear, this.#pendingReasons, []);
    this.#valid = false;
    this.#frameActive = false;
    this.#viewport = null;
    this.#state = "disposed";
  }

  #assertReady(operation: string): void {
    if (this.#state !== "ready") {
      throw new Error(`Cannot ${operation} while temporal history is ${this.#state}.`);
    }
  }

  #assertNoViewportMutation(operation: string): void {
    if (this.#viewportMutation !== null) {
      throw new Error(
        `Cannot ${operation} while temporal-history ${this.#viewportMutation} is active.`,
      );
    }
  }
}
