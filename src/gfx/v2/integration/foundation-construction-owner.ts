const MAX_FOUNDATION_CLEANUP_FAILURES = 16;
const MAX_FOUNDATION_FAILURE_DEPTH = 8;
const MAX_FOUNDATION_FAILURE_WIDTH = 8;
const MAX_FOUNDATION_FAILURE_NODES = 128;
const MAX_FOUNDATION_FAILURE_TEXT = 512;

type FoundationFailurePrimitive = string | number | boolean | null;

export type FoundationFailureSnapshot = Readonly<{
  readonly kind: "primitive" | "object" | "cycle" | "truncated" | "uninspectable";
  readonly type: string;
  readonly value?: FoundationFailurePrimitive;
  readonly name?: string;
  readonly message?: string;
  readonly code?: string | number;
  readonly cause?: FoundationFailureSnapshot;
  readonly errors?: readonly FoundationFailureSnapshot[];
}>;

export interface StableFoundationConstructionOwner {
  dispose(): Promise<void>;
}

export interface FoundationHostReadiness {
  readonly state: string;
  readonly error: unknown;
}

interface FailureSnapshotBudget {
  readonly seen: WeakSet<object>;
  nodes: number;
}

const NODE_LIMIT_SNAPSHOT: FoundationFailureSnapshot = Object.freeze({
  kind: "truncated",
  type: "global-node-budget",
});

/** Throws before ownership transfer if a late Host failure wins a construction race. */
export function assertFoundationHostReady(
  host: Readonly<FoundationHostReadiness>,
  phase: string,
): void {
  const state = host.state;
  if (state === "ready") return;
  const error = host.error;
  if (error !== null && error !== undefined) throw error;
  throw new Error(`GFX foundation Host changed to ${state} during ${boundedText(phase)}.`);
}

function boundedText(value: string): string {
  return value.length <= MAX_FOUNDATION_FAILURE_TEXT
    ? value
    : `${value.slice(0, MAX_FOUNDATION_FAILURE_TEXT - 1)}…`;
}

function primitiveSnapshot(value: unknown): FoundationFailureSnapshot | null {
  if (value === null) return Object.freeze({ kind: "primitive", type: "null", value: null });
  if (typeof value === "string") {
    return Object.freeze({ kind: "primitive", type: "string", value: boundedText(value) });
  }
  if (typeof value === "boolean") {
    return Object.freeze({ kind: "primitive", type: "boolean", value });
  }
  if (typeof value === "number") {
    return Object.freeze({
      kind: "primitive",
      type: "number",
      value: Number.isFinite(value) ? value : String(value),
    });
  }
  if (typeof value === "undefined") {
    return Object.freeze({ kind: "primitive", type: "undefined", value: "undefined" });
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return Object.freeze({ kind: "primitive", type: typeof value, value: boundedText(String(value)) });
  }
  return null;
}

function dataDescriptor(record: object, key: PropertyKey): PropertyDescriptor | undefined {
  return Reflect.getOwnPropertyDescriptor(record, key);
}

function ownTextOrNumber(record: object, key: string): string | number | undefined {
  const descriptor = dataDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) return undefined;
  if (typeof descriptor.value === "string") return boundedText(descriptor.value);
  return typeof descriptor.value === "number" && Number.isFinite(descriptor.value)
    ? descriptor.value
    : undefined;
}

function snapshotFailureList(
  value: unknown,
  budget: FailureSnapshotBudget,
  depth: number,
): readonly FoundationFailureSnapshot[] | undefined {
  let array = false;
  try {
    array = Array.isArray(value);
  } catch {
    return Object.freeze([Object.freeze({ kind: "uninspectable", type: "failure-list" })]);
  }
  if (!array) return undefined;
  const source = value as unknown[];
  if (budget.seen.has(source)) {
    return Object.freeze([Object.freeze({ kind: "cycle", type: "failure-list" })]);
  }
  budget.seen.add(source);
  try {
    const lengthDescriptor = dataDescriptor(source, "length");
    if (
      !lengthDescriptor
      || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      return Object.freeze([Object.freeze({ kind: "uninspectable", type: "failure-list" })]);
    }
    const length = Math.min(lengthDescriptor.value, MAX_FOUNDATION_FAILURE_WIDTH);
    const entries: FoundationFailureSnapshot[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = dataDescriptor(source, String(index));
      if (descriptor && "value" in descriptor) {
        entries.push(snapshotFailure(descriptor.value, budget, depth + 1));
      }
    }
    if (lengthDescriptor.value > length) {
      entries.push(Object.freeze({ kind: "truncated", type: "failure-list-width" }));
    }
    return Object.freeze(entries);
  } catch {
    return Object.freeze([Object.freeze({ kind: "uninspectable", type: "failure-list" })]);
  }
}

function snapshotFailure(
  value: unknown,
  budget: FailureSnapshotBudget,
  depth = 0,
): FoundationFailureSnapshot {
  if (budget.nodes >= MAX_FOUNDATION_FAILURE_NODES) return NODE_LIMIT_SNAPSHOT;
  budget.nodes += 1;
  const primitive = primitiveSnapshot(value);
  if (primitive) return primitive;
  if (depth >= MAX_FOUNDATION_FAILURE_DEPTH) {
    return Object.freeze({ kind: "truncated", type: "failure-depth" });
  }
  const record = value as object;
  if (budget.seen.has(record)) return Object.freeze({ kind: "cycle", type: typeof value });
  budget.seen.add(record);
  try {
    const name = ownTextOrNumber(record, "name");
    const message = ownTextOrNumber(record, "message");
    const code = ownTextOrNumber(record, "code");
    const causeDescriptor = dataDescriptor(record, "cause");
    const cause = causeDescriptor && "value" in causeDescriptor
      ? snapshotFailure(causeDescriptor.value, budget, depth + 1)
      : undefined;
    const errorsDescriptor = dataDescriptor(record, "errors");
    const errors = errorsDescriptor && "value" in errorsDescriptor
      ? snapshotFailureList(errorsDescriptor.value, budget, depth + 1)
      : undefined;
    return Object.freeze({
      kind: "object",
      type: typeof value,
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof message === "string" ? { message } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(cause ? { cause } : {}),
      ...(errors ? { errors } : {}),
    });
  } catch {
    return Object.freeze({ kind: "uninspectable", type: typeof value });
  }
}

/**
 * Immutable bounded evidence with one shared graph budget. Source identities,
 * accessors, prototypes, mutable AggregateError arrays, and cause graphs are
 * never retained by the published error.
 */
export function immutableFoundationCleanupFailure(
  failures: readonly unknown[],
  message: string,
): AggregateError {
  const budget: FailureSnapshotBudget = { seen: new WeakSet<object>(), nodes: 0 };
  const retained = failures.length > MAX_FOUNDATION_CLEANUP_FAILURES
    ? failures.slice(0, MAX_FOUNDATION_CLEANUP_FAILURES - 1)
    : failures.slice();
  const snapshots = retained.map((failure) => snapshotFailure(failure, budget));
  if (failures.length > retained.length) {
    snapshots.push(Object.freeze({
      kind: "truncated",
      type: "failure-root-width",
      value: `${failures.length - retained.length} additional failures omitted`,
    }));
  }
  const aggregate = new AggregateError(Object.freeze(snapshots), boundedText(message));
  Object.freeze(aggregate.errors);
  return Object.freeze(aggregate);
}

/**
 * Publishes one stable cleanup promise before invoking any fallible cleanup.
 * A rejection retains both the exact cleanup closure and the same promise.
 */
export class FoundationConstructionCleanupOwner implements StableFoundationConstructionOwner {
  readonly #cleanup: () => void | Promise<void>;
  #disposePromise: Promise<void> | null = null;

  constructor(cleanup: () => void | Promise<void>) {
    this.#cleanup = cleanup;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.#disposePromise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void Promise.resolve().then(this.#cleanup).then(resolve, reject);
    return this.#disposePromise;
  }
}

/**
 * Persistent, exclusive admission owner for construction attempts. `run`
 * serializes the entire attempt, drains a retained cleanup owner before the
 * callback, and advances only after transfer or cleanup has settled.
 */
export class FoundationConstructionAdmission<
  Owner extends StableFoundationConstructionOwner,
> {
  #retained: Owner | null = null;
  #tail: Promise<void> = Promise.resolve();

  retained(): Owner | null {
    return this.#retained;
  }

  run<Result>(operation: (admission: this) => Promise<Result>): Promise<Result> {
    const attempt = this.#tail
      .catch(() => undefined)
      .then(async () => {
        await this.drain();
        return operation(this);
      });
    this.#tail = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }

  publish(owner: Owner): void {
    if (this.#retained !== null) {
      throw new Error("A foundation construction cleanup owner is already retained.");
    }
    this.#retained = owner;
  }

  transfer(owner: Owner): void {
    if (this.#retained !== owner) {
      throw new Error("Cannot transfer an unowned foundation construction record.");
    }
    this.#retained = null;
  }

  async drain(): Promise<void> {
    const retained = this.#retained;
    if (!retained) return;
    await retained.dispose();
    if (this.#retained === retained) this.#retained = null;
  }
}
