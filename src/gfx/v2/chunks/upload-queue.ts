import type {
  RenderLogicalResourceOwnership,
  RenderQualityProfile,
  RenderServiceInitializationContext,
  RenderUploadQueue,
  VisualClock,
} from "../contracts";
import {
  CHUNK_UPLOAD_HARD_CAP_MS,
  CHUNK_UPLOAD_TARGET_MS,
  CHUNK_UPLOAD_WARNING_MS,
  DEFAULT_CHUNK_UPLOAD_BUDGET_MS,
  MAX_CHUNK_PAYLOAD_BYTES,
  MAX_CHUNK_PENDING_UPLOADS,
  MAX_CHUNK_TELEMETRY_EVENTS,
  type ChunkGpuLease,
  type ChunkIssue,
  type ChunkRuntimeEvent,
  type ChunkUploadJob,
  type ChunkUploadQueueLike,
  type ChunkUploadQueueSnapshot,
  type ChunkUploadResult,
  type ChunkUploadStepResult,
  type ChunkUploadTicket,
} from "./contracts";
import { validateChunkGenerationToken } from "./worker-protocol";

export type ChunkMonotonicClock = () => number;

interface CapturedUploadJob {
  readonly id: string;
  readonly ownerId: string;
  readonly token: ChunkUploadJob["token"];
  readonly byteLength: number;
  readonly maximumSliceMs: number;
  readonly runSlice: (clock: VisualClock) => Readonly<ChunkUploadStepResult>;
  readonly cancel: () => ReturnType<ChunkUploadJob["cancel"]>;
}

interface PendingUpload {
  readonly job: CapturedUploadJob;
  readonly ticket: Readonly<ChunkUploadTicket>;
  readonly resolve: (result: Readonly<ChunkUploadResult>) => void;
  uploadedBytes: number;
  cancelRequested: boolean;
  settled: boolean;
  ownershipTransferredToLease: boolean;
  transferredLease: ChunkGpuLease | null;
  executingSlice: boolean;
  cleanupPromise: Promise<boolean> | null;
}

function deferredResult(): {
  readonly promise: Promise<Readonly<ChunkUploadResult>>;
  readonly resolve: (result: Readonly<ChunkUploadResult>) => void;
} {
  let resolve!: (result: Readonly<ChunkUploadResult>) => void;
  const promise = new Promise<Readonly<ChunkUploadResult>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function deferredBoolean(): {
  readonly promise: Promise<boolean>;
  readonly resolve: (value: boolean) => void;
} {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function deferredVoid(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function uploadIssue(
  code: ChunkIssue["code"],
  detail: string,
  path = "$.upload",
): Readonly<ChunkIssue> {
  return Object.freeze({ code, path, detail: detail.slice(0, 512) });
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function captureOwnDataValues(input: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  let ownKeys: readonly (string | symbol)[];
  let prototype: object | null;
  try {
    ownKeys = Reflect.ownKeys(input);
    prototype = Reflect.getPrototypeOf(input);
  } catch {
    throw new TypeError(`${label} shape could not be inspected.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain or null prototype.`);
  }
  if (ownKeys.length !== keys.length) throw new TypeError(`${label} has unexpected or missing properties.`);
  const expected = new Set(keys);
  const values: Record<string, unknown> = {};
  for (const key of ownKeys) {
    if (typeof key !== "string" || !expected.has(key)) throw new TypeError(`${label} has an unexpected property.`);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    } catch {
      throw new TypeError(`${label}.${key} could not be inspected.`);
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}.${key} must be an enumerable data property.`);
    }
    values[key] = descriptor.value;
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) throw new TypeError(`${label}.${key} is missing.`);
  }
  return values;
}

function captureProfileBudget(profile: Readonly<RenderQualityProfile>): number {
  const values = captureOwnDataValues(
    profile,
    ["tier", "pixelRatio", "uploadBudgetMs", "features"],
    "Render quality profile",
  );
  if (
    typeof values.uploadBudgetMs !== "number"
    || !Number.isFinite(values.uploadBudgetMs)
    || values.uploadBudgetMs <= 0
    || Object.is(values.uploadBudgetMs, -0)
  ) {
    throw new RangeError("Chunk upload budget must be a positive finite number.");
  }
  return Math.min(values.uploadBudgetMs, CHUNK_UPLOAD_HARD_CAP_MS);
}

function captureVisualClock(clock: VisualClock): Readonly<VisualClock> {
  const values = captureOwnDataValues(
    clock,
    ["frame", "nowMs", "deltaSeconds", "elapsedSeconds"],
    "Visual clock",
  );
  if (typeof values.frame !== "number" || !Number.isSafeInteger(values.frame) || values.frame < 0) {
    throw new TypeError("Visual clock frame is invalid.");
  }
  for (const key of ["nowMs", "deltaSeconds", "elapsedSeconds"] as const) {
    if (typeof values[key] !== "number" || !Number.isFinite(values[key]) || values[key] < 0 || Object.is(values[key], -0)) {
      throw new TypeError(`Visual clock ${key} is invalid.`);
    }
  }
  return Object.freeze({
    frame: values.frame,
    nowMs: values.nowMs,
    deltaSeconds: values.deltaSeconds,
    elapsedSeconds: values.elapsedSeconds,
  }) as Readonly<VisualClock>;
}

function captureJob(job: Readonly<ChunkUploadJob>): CapturedUploadJob {
  const values = captureOwnDataValues(job, [
    "id",
    "ownerId",
    "token",
    "byteLength",
    "maximumSliceMs",
    "runSlice",
    "cancel",
  ], "Chunk upload job");
  if (typeof values.id !== "string" || !/^[a-z0-9](?:[a-z0-9:._-]{0,126}[a-z0-9])?$/.test(values.id)) {
    throw new TypeError("Chunk upload job id must be a bounded lower-case ASCII token.");
  }
  if (typeof values.ownerId !== "string" || !/^[a-z0-9](?:[a-z0-9:._-]{0,126}[a-z0-9])?$/.test(values.ownerId)) {
    throw new TypeError("Chunk upload owner id must be a bounded lower-case ASCII token.");
  }
  const tokenReport = validateChunkGenerationToken(values.token);
  if (!tokenReport.valid || !tokenReport.value) throw new TypeError("Chunk upload job token is invalid.");
  if (!safeCount(values.byteLength) || values.byteLength > MAX_CHUNK_PAYLOAD_BYTES) {
    throw new RangeError(`Chunk upload job exceeds ${MAX_CHUNK_PAYLOAD_BYTES} bytes.`);
  }
  if (
    typeof values.maximumSliceMs !== "number"
    || !Number.isFinite(values.maximumSliceMs)
    || values.maximumSliceMs <= 0
    || values.maximumSliceMs > CHUNK_UPLOAD_TARGET_MS
  ) {
    throw new RangeError(`Chunk upload slices must declare a bound from 0 through ${CHUNK_UPLOAD_TARGET_MS} ms.`);
  }
  if (typeof values.runSlice !== "function" || typeof values.cancel !== "function") {
    throw new TypeError("Chunk upload jobs require runSlice and cancel functions.");
  }
  const receiver = job as ChunkUploadJob;
  const runSlice = values.runSlice as ChunkUploadJob["runSlice"];
  const cancel = values.cancel as ChunkUploadJob["cancel"];
  return Object.freeze({
    id: values.id,
    ownerId: values.ownerId,
    token: tokenReport.value,
    byteLength: values.byteLength,
    maximumSliceMs: values.maximumSliceMs,
    runSlice: (clock: VisualClock) => Reflect.apply(runSlice, receiver, [clock]) as Readonly<ChunkUploadStepResult>,
    cancel: () => Reflect.apply(cancel, receiver, []) as ReturnType<ChunkUploadJob["cancel"]>,
  });
}

function captureOwnership(input: unknown, ownerId: string): Readonly<RenderLogicalResourceOwnership> {
  const values = captureOwnDataValues(input, [
    "ownerId",
    "geometries",
    "textures",
    "renderTargets",
    "nodes",
    "objects",
    "bytes",
  ], "Chunk GPU ownership");
  if (values.ownerId !== ownerId) throw new TypeError("Chunk GPU lease owner does not match the upload owner.");
  for (const key of ["geometries", "textures", "renderTargets", "nodes", "objects", "bytes"] as const) {
    if (!safeCount(values[key])) throw new TypeError(`Chunk GPU ownership ${key} must be a non-negative safe integer.`);
  }
  return Object.freeze({
    ownerId,
    geometries: values.geometries as number,
    textures: values.textures as number,
    renderTargets: values.renderTargets as number,
    nodes: values.nodes as number,
    objects: values.objects as number,
    bytes: values.bytes as number,
  });
}

function captureLease(input: unknown, ownerId: string): ChunkGpuLease {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Chunk GPU lease must be an object.");
  }
  let ownKeys: readonly (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(input);
  } catch {
    throw new TypeError("Chunk GPU lease shape could not be inspected.");
  }
  const allowed = new Set(["ownerId", "ownership", "quality", "setActive", "dispose"]);
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("Chunk GPU lease has an unexpected property.");
  }
  const keys = ownKeys.filter((key): key is string => typeof key === "string");
  if (!["ownerId", "ownership", "dispose"].every((key) => keys.includes(key))) {
    throw new TypeError("Chunk GPU lease is missing a required property.");
  }
  const values = captureOwnDataValues(input, keys, "Chunk GPU lease");
  if (values.ownerId !== ownerId) throw new TypeError("Chunk GPU lease owner id does not match the upload job.");
  if (typeof values.dispose !== "function") throw new TypeError("Chunk GPU lease requires a disposer.");
  if (values.quality !== undefined && typeof values.quality !== "function") {
    throw new TypeError("Chunk GPU lease quality hook must be a function.");
  }
  if (values.setActive !== undefined && typeof values.setActive !== "function") {
    throw new TypeError("Chunk GPU lease activation hook must be a function.");
  }
  const receiver = input as ChunkGpuLease;
  const dispose = values.dispose as ChunkGpuLease["dispose"];
  const quality = values.quality as ChunkGpuLease["quality"];
  const setActive = values.setActive as ChunkGpuLease["setActive"];
  return Object.freeze({
    ownerId,
    ownership: captureOwnership(values.ownership, ownerId),
    ...(quality === undefined ? {} : {
      quality: (profile: Readonly<RenderQualityProfile>) => Reflect.apply(quality, receiver, [profile]) as void,
    }),
    ...(setActive === undefined ? {} : {
      setActive: (active: boolean) => Reflect.apply(setActive, receiver, [active]) as void,
    }),
    dispose: () => Reflect.apply(dispose, receiver, []) as ReturnType<ChunkGpuLease["dispose"]>,
  });
}

function captureStep(input: unknown, ownerId: string): Readonly<ChunkUploadStepResult> {
  if (typeof input !== "object" || input === null) throw new TypeError("Chunk upload step result must be an object.");
  let kindDescriptor: PropertyDescriptor | undefined;
  try {
    kindDescriptor = Reflect.getOwnPropertyDescriptor(input, "kind");
  } catch {
    throw new TypeError("Chunk upload step kind could not be inspected.");
  }
  const kind = kindDescriptor && "value" in kindDescriptor ? kindDescriptor.value : undefined;
  if (kind === "pending") {
    const values = captureOwnDataValues(input, ["kind", "uploadedBytes"], "Pending upload step");
    if (!safeCount(values.uploadedBytes)) throw new TypeError("Pending upload byte count is invalid.");
    return Object.freeze({ kind: "pending", uploadedBytes: values.uploadedBytes });
  }
  if (kind === "complete") {
    const values = captureOwnDataValues(input, ["kind", "uploadedBytes", "lease"], "Completed upload step");
    if (!safeCount(values.uploadedBytes)) throw new TypeError("Completed upload byte count is invalid.");
    return Object.freeze({
      kind: "complete",
      uploadedBytes: values.uploadedBytes,
      lease: captureLease(values.lease, ownerId),
    });
  }
  throw new TypeError("Chunk upload step has an unknown kind.");
}

export class IncrementalChunkUploadQueue implements RenderUploadQueue, ChunkUploadQueueLike {
  readonly #now: ChunkMonotonicClock;
  readonly #queue: PendingUpload[] = [];
  readonly #knownIds = new Set<string>();
  readonly #events: Readonly<ChunkRuntimeEvent>[] = [];
  readonly #orphanLeases = new Set<ChunkGpuLease>();
  readonly #leaseCleanupInFlight = new Map<ChunkGpuLease, Promise<boolean>>();
  readonly #orphanJobs = new Set<CapturedUploadJob>();
  readonly #jobCleanupInFlight = new Map<CapturedUploadJob, Promise<boolean>>();
  #active: PendingUpload | null = null;
  #initialized = false;
  #disposed = false;
  #flushing = false;
  #budgetMs = DEFAULT_CHUNK_UPLOAD_BUDGET_MS;
  #sequence = 0;
  #completed = 0;
  #cancelled = 0;
  #failed = 0;
  #totalUploadedBytes = 0;
  #cleanupFailureCount = 0;
  #lastClockSample = Number.NEGATIVE_INFINITY;
  #disposePromise: Promise<void> | null = null;
  #flushDrain: Promise<void> = Promise.resolve();
  #resolveFlushDrain: (() => void) | null = null;

  constructor(now: ChunkMonotonicClock) {
    if (typeof now !== "function") throw new TypeError("Chunk upload queue requires an injected monotonic clock.");
    this.#now = now;
  }

  initialize(context: RenderServiceInitializationContext): void {
    void context;
    if (this.#disposed) throw new Error("Cannot initialize a disposed chunk upload queue.");
    this.#initialized = true;
  }

  quality(profile: Readonly<RenderQualityProfile>): void {
    this.#budgetMs = captureProfileBudget(profile);
  }

  enqueue(job: Readonly<ChunkUploadJob>): Readonly<ChunkUploadTicket> {
    if (!this.#initialized || this.#disposed) throw new Error("Chunk upload queue is not active.");
    if (this.pendingCount() >= MAX_CHUNK_PENDING_UPLOADS) {
      throw Object.assign(new RangeError(`Chunk upload queue exceeds ${MAX_CHUNK_PENDING_UPLOADS} jobs.`), {
        issue: uploadIssue("UPLOAD_QUEUE_FULL", "Chunk upload queue capacity was exceeded."),
      });
    }
    const captured = captureJob(job);
    if (this.#knownIds.has(captured.id)) throw new TypeError(`Duplicate chunk upload job id: ${captured.id}.`);
    this.#knownIds.add(captured.id);
    const deferred = deferredResult();
    const ticket = Object.freeze({ id: captured.id, ownerId: captured.ownerId, result: deferred.promise });
    this.#queue.push({
      job: captured,
      ticket,
      resolve: deferred.resolve,
      uploadedBytes: 0,
      cancelRequested: false,
      settled: false,
      ownershipTransferredToLease: false,
      transferredLease: null,
      executingSlice: false,
      cleanupPromise: null,
    });
    this.#event("upload", "queued", captured.token.chunkId, captured.token.requestId, null, captured.byteLength);
    return ticket;
  }

  async cancelOwner(ownerId: string): Promise<void> {
    if (typeof ownerId !== "string" || ownerId.length === 0) throw new TypeError("Chunk upload owner id is required.");
    const matches: PendingUpload[] = [];
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const pending = this.#queue[index];
      if (!pending || pending.job.ownerId !== ownerId) continue;
      this.#queue.splice(index, 1);
      pending.cancelRequested = true;
      matches.push(pending);
    }
    if (this.#active?.job.ownerId === ownerId) {
      this.#active.cancelRequested = true;
      if (!matches.includes(this.#active)) matches.push(this.#active);
    }
    const cleanup = await Promise.all(matches.map(async (pending) => {
      if (pending.executingSlice) await pending.ticket.result;
      else this.#cancel(pending);
      await pending.ticket.result;
      return pending.cleanupPromise ? pending.cleanupPromise : true;
    }));
    if (cleanup.some((complete) => !complete)) {
      throw new Error("Chunk upload owner cancellation retained a cleanup obligation.");
    }
  }

  async flush(clock: VisualClock, profile?: Readonly<RenderQualityProfile>): Promise<void> {
    if (!this.#initialized || this.#disposed) return;
    if (this.#flushing) throw new Error("Chunk upload queue flush cannot reenter.");
    this.#flushing = true;
    this.#flushDrain = new Promise<void>((resolve) => {
      this.#resolveFlushDrain = resolve;
    });
    try {
      const ownedClock = captureVisualClock(clock);
      if (profile) this.#budgetMs = captureProfileBudget(profile);
      const hardCap = Math.min(this.#budgetMs, CHUNK_UPLOAD_HARD_CAP_MS);
      const target = Math.min(hardCap, CHUNK_UPLOAD_TARGET_MS);
      const start = this.#sampleNow();
      while (this.#queue.length > 0) {
        if (this.#sampleNow() - start >= target) break;
        const pending = this.#queue.shift();
        if (!pending || pending.settled) continue;
        this.#active = pending;
        if (pending.cancelRequested) {
          this.#cancel(pending);
          this.#active = null;
          continue;
        }
        let sliceStart: number;
        try {
          sliceStart = this.#sampleNow();
        } catch {
          this.#fail(pending, uploadIssue("UPLOAD_FAILED", "Injected upload clock failed before a slice."));
          this.#active = null;
          break;
        }
        if (this.#disposed || pending.settled || pending.cancelRequested) {
          if (!pending.settled) this.#cancel(pending);
          this.#active = null;
          if (this.#disposed) break;
          continue;
        }
        let step: Readonly<ChunkUploadStepResult> | null = null;
        pending.executingSlice = true;
        try {
          step = captureStep(pending.job.runSlice(ownedClock), pending.job.ownerId);
          if (step.kind === "complete") {
            pending.ownershipTransferredToLease = true;
            pending.transferredLease = step.lease;
          }
        } catch {
          this.#fail(pending, uploadIssue(
            "UPLOAD_FAILED",
            "Chunk upload slice failed.",
          ));
        } finally {
          pending.executingSlice = false;
        }
        let sliceEnd: number;
        try {
          sliceEnd = this.#sampleNow();
        } catch {
          this.#fail(pending, uploadIssue("UPLOAD_FAILED", "Injected upload clock failed after a slice."));
          this.#active = null;
          break;
        }
        const duration = sliceEnd - sliceStart;
        const aggregateDuration = sliceEnd - start;
        if (duration > CHUNK_UPLOAD_WARNING_MS || aggregateDuration > CHUNK_UPLOAD_WARNING_MS) {
          this.#event(
            "issue",
            "slice-warning",
            pending.job.token.chunkId,
            pending.job.token.requestId,
            ownedClock.frame,
            Math.max(duration, aggregateDuration),
          );
        }
        if (duration > pending.job.maximumSliceMs && !pending.settled) {
          this.#fail(pending, uploadIssue(
            "UPLOAD_HARD_CAP_EXCEEDED",
            `Chunk upload slice took ${duration} ms, exceeding its declared ${pending.job.maximumSliceMs} ms upper bound.`,
          ));
          this.#active = null;
          break;
        }
        if ((duration > hardCap || aggregateDuration > hardCap) && !pending.settled) {
          this.#fail(pending, uploadIssue(
            "UPLOAD_HARD_CAP_EXCEEDED",
            `Chunk upload work reached ${aggregateDuration} ms with a ${duration} ms slice, exceeding the ${hardCap} ms hard cap.`,
          ));
          this.#active = null;
          break;
        }
        if (pending.settled || !step) {
          this.#active = null;
          continue;
        }
        if (pending.cancelRequested) {
          this.#cancel(pending);
          this.#active = null;
          continue;
        }
        if (step.uploadedBytes > pending.job.byteLength - pending.uploadedBytes) {
          this.#fail(pending, uploadIssue("UPLOAD_FAILED", "Chunk upload reported more bytes than its declared payload."));
          this.#active = null;
          continue;
        }
        pending.uploadedBytes += step.uploadedBytes;
        this.#totalUploadedBytes += step.uploadedBytes;
        this.#event("upload", "slice", pending.job.token.chunkId, pending.job.token.requestId, ownedClock.frame, step.uploadedBytes);
        if (step.kind === "complete") {
          if (pending.uploadedBytes !== pending.job.byteLength) {
            this.#fail(pending, uploadIssue("UPLOAD_FAILED", "Completed upload byte count differs from the declared payload."));
          } else {
            this.#complete(pending, step.lease);
          }
        } else if (pending.uploadedBytes >= pending.job.byteLength) {
          this.#fail(pending, uploadIssue("UPLOAD_FAILED", "Pending upload exhausted its declared payload without a lease."));
        } else {
          this.#queue.push(pending);
        }
        this.#active = null;
        if (this.#sampleNow() - start >= hardCap) break;
      }
    } finally {
      this.#active = null;
      this.#flushing = false;
      const resolve = this.#resolveFlushDrain;
      this.#resolveFlushDrain = null;
      resolve?.();
    }
  }

  pendingCount(): number {
    return this.#queue.length + (this.#active && !this.#active.settled ? 1 : 0);
  }

  snapshot(): Readonly<ChunkUploadQueueSnapshot> {
    return Object.freeze({
      initialized: this.#initialized,
      disposed: this.#disposed,
      pending: this.pendingCount(),
      activeJobId: this.#active?.job.id ?? null,
      completed: this.#completed,
      cancelled: this.#cancelled,
      failed: this.#failed,
      totalUploadedBytes: this.#totalUploadedBytes,
      orphanLeaseCount: this.#orphanLeases.size,
      orphanJobCount: this.#orphanJobs.size,
      orphanOwnerIds: Object.freeze([...new Set([
        ...[...this.#orphanLeases].map((lease) => lease.ownerId),
        ...[...this.#orphanJobs].map((job) => job.ownerId),
      ])].sort()),
      cleanupFailureCount: this.#cleanupFailureCount,
      events: Object.freeze(this.#events.map((event) => Object.freeze({ ...event }))),
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    const deferred = deferredVoid();
    this.#disposePromise = deferred.promise;
    void this.#runDispose().then(deferred.resolve, deferred.reject);
    return this.#disposePromise;
  }

  async #runDispose(): Promise<void> {
    this.#disposed = true;
    const pending = this.#queue.splice(0, this.#queue.length);
    if (this.#active && !pending.includes(this.#active)) {
      this.#active.cancelRequested = true;
      pending.push(this.#active);
    }
    for (const entry of pending) {
      if (entry.executingSlice) await entry.ticket.result;
      else this.#cancel(entry);
    }
    await this.#flushDrain;
    await Promise.all([
      ...this.#jobCleanupInFlight.values(),
      ...this.#leaseCleanupInFlight.values(),
    ]);
    this.#active = null;
    this.#initialized = false;
    await Promise.all([
      ...[...this.#orphanJobs].map((job) => this.#cancelJobForCleanup(job)),
      ...[...this.#orphanLeases].map((lease) => this.#disposeLease(lease)),
    ]);
    if (this.#orphanJobs.size > 0 || this.#orphanLeases.size > 0) {
      throw new Error(
        `Chunk upload queue retained ${this.#orphanJobs.size} job(s) and ${this.#orphanLeases.size} GPU lease(s) after bounded cleanup.`,
      );
    }
  }

  #sampleNow(): number {
    const value = this.#now();
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new RangeError("Injected upload clock returned an invalid timestamp.");
    if (value < this.#lastClockSample) throw new RangeError("Injected upload clock moved backwards.");
    this.#lastClockSample = value;
    return value;
  }

  #complete(pending: PendingUpload, lease: ChunkGpuLease): void {
    if (pending.settled) return;
    pending.settled = true;
    this.#knownIds.delete(pending.job.id);
    this.#completed += 1;
    pending.resolve(Object.freeze({
      kind: "complete",
      jobId: pending.job.id,
      ownerId: pending.job.ownerId,
      lease,
    }));
    this.#event("upload", "complete", pending.job.token.chunkId, pending.job.token.requestId, null, pending.uploadedBytes);
  }

  #cancel(pending: PendingUpload): Promise<boolean> {
    if (pending.settled) return pending.cleanupPromise ?? Promise.resolve(true);
    pending.settled = true;
    const cleanup = this.#beginPendingCleanup(pending);
    this.#cancelled += 1;
    pending.resolve(Object.freeze({ kind: "cancelled", jobId: pending.job.id, ownerId: pending.job.ownerId }));
    this.#event("upload", "cancelled", pending.job.token.chunkId, pending.job.token.requestId, null, null);
    return cleanup;
  }

  #fail(pending: PendingUpload, failure: Readonly<ChunkIssue>): Promise<boolean> {
    if (pending.settled) return pending.cleanupPromise ?? Promise.resolve(true);
    pending.settled = true;
    const cleanup = this.#beginPendingCleanup(pending);
    this.#failed += 1;
    pending.resolve(Object.freeze({
      kind: "failed",
      jobId: pending.job.id,
      ownerId: pending.job.ownerId,
      issue: Object.freeze({ ...failure }),
    }));
    this.#event("issue", "failed", pending.job.token.chunkId, pending.job.token.requestId, null, failure.detail);
    return cleanup;
  }

  #beginPendingCleanup(pending: PendingUpload): Promise<boolean> {
    if (pending.cleanupPromise) return pending.cleanupPromise;
    const deferred = deferredBoolean();
    pending.cleanupPromise = deferred.promise;
    void this.#cleanupPendingOwnership(pending).then(deferred.resolve, () => deferred.resolve(false));
    return deferred.promise;
  }

  #disposeLease(lease: ChunkGpuLease): Promise<boolean> {
    const current = this.#leaseCleanupInFlight.get(lease);
    if (current) return current;
    const deferred = deferredBoolean();
    this.#leaseCleanupInFlight.set(lease, deferred.promise);
    void this.#runDisposeLease(lease).then(deferred.resolve, () => deferred.resolve(false));
    void deferred.promise.finally(() => {
      if (this.#leaseCleanupInFlight.get(lease) === deferred.promise) this.#leaseCleanupInFlight.delete(lease);
    });
    return deferred.promise;
  }

  async #runDisposeLease(lease: ChunkGpuLease): Promise<boolean> {
    this.#orphanLeases.add(lease);
    try {
      await lease.dispose();
      this.#orphanLeases.delete(lease);
      return true;
    } catch {
      this.#cleanupFailureCount += 1;
      this.#event("issue", "lease-dispose-failed", null, null, null, this.#orphanLeases.size);
      return false;
    }
  }

  #cancelJobForCleanup(job: CapturedUploadJob): Promise<boolean> {
    const current = this.#jobCleanupInFlight.get(job);
    if (current) return current;
    this.#orphanJobs.add(job);
    const deferred = deferredBoolean();
    this.#jobCleanupInFlight.set(job, deferred.promise);
    void this.#runCancelJobForCleanup(job).then(deferred.resolve, () => deferred.resolve(false));
    void deferred.promise.finally(() => {
      if (this.#jobCleanupInFlight.get(job) === deferred.promise) this.#jobCleanupInFlight.delete(job);
    });
    return deferred.promise;
  }

  async #runCancelJobForCleanup(job: CapturedUploadJob): Promise<boolean> {
    try {
      await job.cancel();
      this.#orphanJobs.delete(job);
      this.#knownIds.delete(job.id);
      return true;
    } catch {
      this.#cleanupFailureCount += 1;
      this.#event("issue", "job-cancel-failed", job.token.chunkId, job.token.requestId, null, this.#orphanJobs.size);
      return false;
    }
  }

  async #cleanupPendingOwnership(pending: PendingUpload): Promise<boolean> {
    if (pending.ownershipTransferredToLease && pending.transferredLease) {
      const lease = pending.transferredLease;
      await this.#disposeLease(lease);
      const complete = !this.#orphanLeases.has(lease);
      if (complete) this.#knownIds.delete(pending.job.id);
      return complete;
    }
    return this.#cancelJobForCleanup(pending.job);
  }

  #event(
    kind: ChunkRuntimeEvent["kind"],
    name: string,
    chunkId: ChunkRuntimeEvent["chunkId"],
    requestId: number | null,
    frame: number | null,
    value: ChunkRuntimeEvent["value"],
  ): void {
    this.#sequence += 1;
    this.#events.push(Object.freeze({ sequence: this.#sequence, kind, name, chunkId, requestId, frame, value }));
    if (this.#events.length > MAX_CHUNK_TELEMETRY_EVENTS) this.#events.shift();
  }
}
