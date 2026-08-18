import type {
  RenderQualityProfile,
  RenderResourceRegistry,
  VisualClock,
} from "../contracts";
import {
  STORY_CHUNK_IDS,
  type StoryChunkId,
  type WorldPlan,
} from "../../../world/v2/contracts";
import {
  CHUNK_ISSUE_CODES,
  MAX_CHUNK_GENERATION_CONCURRENCY,
  MAX_CHUNK_TELEMETRY_EVENTS,
  MAX_CHUNK_WORKER_INBOX,
  type ChunkGenerationToken,
  type ChunkGpuLease,
  type ChunkIssue,
  type ChunkLifecycleSnapshot,
  type ChunkManagerLike,
  type ChunkRuntimeEvent,
  type ChunkRuntimeSnapshot,
  type ChunkUploadJob,
  type ChunkUploadQueueLike,
  type ChunkUploadResult,
  type ChunkUploader,
  type ChunkWindowRole,
  type ChunkWorkerClientLike,
  type GeneratedChunkPayload,
} from "./contracts";
import {
  createAbsentChunkSnapshot,
  failChunkSnapshot,
  transitionChunkSnapshot,
  updateChunkWindowRole,
} from "./state-machine";
import { makeChunkGenerationToken, tokensEqual } from "./worker-client";

interface ChunkRecord {
  snapshot: Readonly<ChunkLifecycleSnapshot>;
  token: Readonly<ChunkGenerationToken> | null;
  payload: Readonly<GeneratedChunkPayload> | null;
  lease: ChunkGpuLease | null;
  focusVersion: number;
}

interface UploadInboxEntry {
  readonly token: Readonly<ChunkGenerationToken>;
  readonly result: Readonly<ChunkUploadResult>;
}

interface ResourceInboxEntry {
  readonly token: Readonly<ChunkGenerationToken>;
  readonly lease: ChunkGpuLease;
  readonly adopted: boolean;
}

interface LeaseCleanupState {
  adopted: boolean;
  releaseComplete: boolean;
  disposeComplete: boolean;
}

type ResourceAdopt = NonNullable<RenderResourceRegistry["adopt"]>;
type ResourceReleaseOwner = NonNullable<RenderResourceRegistry["releaseOwner"]>;

export interface ChunkManagerOptions {
  readonly plan: Readonly<WorldPlan>;
  readonly worker: ChunkWorkerClientLike;
  readonly uploads: ChunkUploadQueueLike;
  readonly uploader: ChunkUploader;
  readonly resources: RenderResourceRegistry;
  readonly generationConcurrency?: number;
}

function runtimeIssue(
  code: ChunkIssue["code"],
  detail: string,
  chunkId?: StoryChunkId,
): Readonly<ChunkIssue> {
  return Object.freeze({
    code,
    path: chunkId ? `$.chunks.${chunkId}` : "$",
    detail: detail.slice(0, 512),
    ...(chunkId ? { chunkId } : {}),
  });
}

export function chunkOwnerId(token: Readonly<ChunkGenerationToken>): string {
  return `chunk-${token.chunkId.toLowerCase()}-${token.epoch}-${token.requestId}`;
}

function assertStoryChunkId(value: unknown): asserts value is StoryChunkId {
  if (typeof value !== "string" || !(STORY_CHUNK_IDS as readonly string[]).includes(value)) {
    throw new RangeError(`Unknown story chunk: ${String(value)}.`);
  }
}

interface CapturedUploadTicket {
  readonly id: string;
  readonly ownerId: string;
  readonly result: Promise<Readonly<ChunkUploadResult>>;
}

function ownDataValue(input: unknown, key: string, label: string): unknown {
  if (typeof input !== "object" || input === null) throw new TypeError(`${label} must be an object.`);
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(input, key);
  } catch {
    throw new TypeError(`${label}.${key} could not be inspected.`);
  }
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${label}.${key} must be an enumerable data property.`);
  }
  return descriptor.value;
}

function captureResourceMethod(
  resources: RenderResourceRegistry,
  key: "adopt",
): ResourceAdopt | null;
function captureResourceMethod(
  resources: RenderResourceRegistry,
  key: "releaseOwner",
): ResourceReleaseOwner | null;
function captureResourceMethod(
  resources: RenderResourceRegistry,
  key: "adopt" | "releaseOwner",
): ResourceAdopt | ResourceReleaseOwner | null {
  let owner: object | null = resources;
  for (let depth = 0; depth < 8 && owner !== null; depth += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(owner, key);
    } catch {
      throw new TypeError(`Render resource registry ${key} could not be inspected.`);
    }
    if (descriptor) {
      if (!("value" in descriptor)) {
        throw new TypeError(`Render resource registry ${key} must be a data method.`);
      }
      if (descriptor.value === undefined) return null;
      if (typeof descriptor.value !== "function") {
        throw new TypeError(`Render resource registry ${key} must be a function when present.`);
      }
      return descriptor.value as ResourceAdopt | ResourceReleaseOwner;
    }
    try {
      owner = Reflect.getPrototypeOf(owner);
    } catch {
      throw new TypeError(`Render resource registry ${key} prototype could not be inspected.`);
    }
  }
  if (owner !== null) throw new TypeError("Render resource registry prototype chain is too deep.");
  return null;
}

function captureUploadTicket(input: unknown): CapturedUploadTicket {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Chunk upload ticket must be an object.");
  }
  let keys: readonly (string | symbol)[];
  let prototype: object | null;
  try {
    keys = Reflect.ownKeys(input);
    prototype = Reflect.getPrototypeOf(input);
  } catch {
    throw new TypeError("Chunk upload ticket shape could not be inspected.");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Chunk upload ticket must use a plain or null prototype.");
  }
  const expected = new Set(["id", "ownerId", "result"]);
  if (keys.length !== expected.size || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    throw new TypeError("Chunk upload ticket has unexpected or missing properties.");
  }
  const id = ownDataValue(input, "id", "Chunk upload ticket");
  const ownerId = ownDataValue(input, "ownerId", "Chunk upload ticket");
  const result = ownDataValue(input, "result", "Chunk upload ticket");
  if (typeof id !== "string" || id.length < 1 || id.length > 128) {
    throw new TypeError("Chunk upload ticket id is invalid.");
  }
  if (typeof ownerId !== "string" || ownerId.length < 1 || ownerId.length > 128) {
    throw new TypeError("Chunk upload ticket owner is invalid.");
  }
  if (typeof result !== "object" || result === null) {
    throw new TypeError("Chunk upload ticket result must be a promise.");
  }
  return Object.freeze({ id, ownerId, result: result as Promise<Readonly<ChunkUploadResult>> });
}

function captureUploadResult(
  input: unknown,
  ticket: CapturedUploadTicket,
  token: Readonly<ChunkGenerationToken>,
): Readonly<ChunkUploadResult> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Chunk upload result must be an object.");
  }
  const kind = ownDataValue(input, "kind", "Chunk upload result");
  const expectedKeys = kind === "complete"
    ? ["kind", "jobId", "ownerId", "lease"]
    : kind === "cancelled"
      ? ["kind", "jobId", "ownerId"]
      : kind === "failed"
        ? ["kind", "jobId", "ownerId", "issue"]
        : [];
  let keys: readonly (string | symbol)[];
  let prototype: object | null;
  try {
    keys = Reflect.ownKeys(input);
    prototype = Reflect.getPrototypeOf(input);
  } catch {
    throw new TypeError("Chunk upload result shape could not be inspected.");
  }
  const expected = new Set(expectedKeys);
  if (
    expectedKeys.length === 0
    || (prototype !== Object.prototype && prototype !== null)
    || keys.length !== expected.size
    || keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new TypeError("Chunk upload result has unexpected structure.");
  }
  const jobId = ownDataValue(input, "jobId", "Chunk upload result");
  const ownerId = ownDataValue(input, "ownerId", "Chunk upload result");
  if (jobId !== ticket.id || ownerId !== ticket.ownerId) {
    throw new TypeError("Chunk upload result differs from its ticket identity.");
  }
  if (kind === "complete") {
    const lease = ownDataValue(input, "lease", "Chunk upload result");
    if (ownDataValue(lease, "ownerId", "Chunk GPU lease") !== ticket.ownerId) {
      throw new TypeError("Chunk upload lease differs from its ticket owner.");
    }
    return Object.freeze({ kind, jobId: ticket.id, ownerId: ticket.ownerId, lease: lease as ChunkGpuLease });
  }
  if (kind === "cancelled") {
    return Object.freeze({ kind, jobId: ticket.id, ownerId: ticket.ownerId });
  }
  const rawIssue = ownDataValue(input, "issue", "Chunk upload result");
  const code = ownDataValue(rawIssue, "code", "Chunk upload issue");
  const path = ownDataValue(rawIssue, "path", "Chunk upload issue");
  const detail = ownDataValue(rawIssue, "detail", "Chunk upload issue");
  if (
    typeof code !== "string"
    || !(CHUNK_ISSUE_CODES as readonly string[]).includes(code)
    || typeof path !== "string"
    || path.length < 1
    || path.length > 512
    || typeof detail !== "string"
    || detail.length < 1
    || detail.length > 512
  ) {
    throw new TypeError("Chunk upload failure issue is malformed.");
  }
  return Object.freeze({
    kind: "failed",
    jobId: ticket.id,
    ownerId: ticket.ownerId,
    issue: runtimeIssue(code as ChunkIssue["code"], detail, token.chunkId),
  });
}

function captureQualityProfile(input: Readonly<RenderQualityProfile>): Readonly<RenderQualityProfile> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Render quality profile must be an object.");
  }
  let keys: readonly (string | symbol)[];
  let prototype: object | null;
  try {
    keys = Reflect.ownKeys(input);
    prototype = Reflect.getPrototypeOf(input);
  } catch {
    throw new TypeError("Render quality profile shape could not be inspected.");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Render quality profile must use a plain or null prototype.");
  }
  const expected = new Set(["tier", "pixelRatio", "uploadBudgetMs", "features"]);
  if (keys.length !== expected.size || keys.some((key) => typeof key !== "string" || !expected.has(key))) {
    throw new TypeError("Render quality profile has unexpected or missing properties.");
  }
  const tier = ownDataValue(input, "tier", "Render quality profile");
  const pixelRatio = ownDataValue(input, "pixelRatio", "Render quality profile");
  const uploadBudgetMs = ownDataValue(input, "uploadBudgetMs", "Render quality profile");
  const features = ownDataValue(input, "features", "Render quality profile");
  if (tier !== "low" && tier !== "balanced" && tier !== "high") {
    throw new TypeError("Render quality tier is invalid.");
  }
  if (typeof pixelRatio !== "number" || !Number.isFinite(pixelRatio) || pixelRatio <= 0 || Object.is(pixelRatio, -0)) {
    throw new TypeError("Render quality pixel ratio is invalid.");
  }
  if (typeof uploadBudgetMs !== "number" || !Number.isFinite(uploadBudgetMs) || uploadBudgetMs <= 0 || Object.is(uploadBudgetMs, -0)) {
    throw new TypeError("Render quality upload budget is invalid.");
  }
  if (typeof features !== "object" || features === null || Array.isArray(features)) {
    throw new TypeError("Render quality features must be an object.");
  }
  let featureKeys: readonly (string | symbol)[];
  let featurePrototype: object | null;
  try {
    featureKeys = Reflect.ownKeys(features);
    featurePrototype = Reflect.getPrototypeOf(features);
  } catch {
    throw new TypeError("Render quality features could not be inspected.");
  }
  if ((featurePrototype !== Object.prototype && featurePrototype !== null) || featureKeys.length > 128) {
    throw new TypeError("Render quality features are not a bounded plain object.");
  }
  const ownedFeatures: Record<string, boolean | number | string> = {};
  for (const key of featureKeys) {
    if (typeof key !== "string" || key.length < 1 || key.length > 128) {
      throw new TypeError("Render quality feature key is invalid.");
    }
    const value = ownDataValue(features, key, "Render quality features");
    if (typeof value !== "boolean" && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new TypeError("Render quality feature value is invalid.");
    }
    ownedFeatures[key] = value;
  }
  return Object.freeze({
    tier,
    pixelRatio,
    uploadBudgetMs,
    features: Object.freeze(ownedFeatures),
  });
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

export class ChunkManager implements ChunkManagerLike {
  readonly #worker: ChunkWorkerClientLike;
  readonly #uploads: ChunkUploadQueueLike;
  readonly #uploader: ChunkUploader;
  readonly #resources: RenderResourceRegistry;
  readonly #resourceAdopt: ResourceAdopt | null;
  readonly #resourceReleaseOwner: ResourceReleaseOwner | null;
  readonly #generationConcurrency: number;
  readonly #records = new Map<StoryChunkId, ChunkRecord>();
  readonly #epochs = new Map<StoryChunkId, number>();
  readonly #events: Readonly<ChunkRuntimeEvent>[] = [];
  readonly #uploadInbox: UploadInboxEntry[] = [];
  readonly #resourceInbox: ResourceInboxEntry[] = [];
  readonly #operations = new Set<Promise<void>>();
  readonly #ownedLeases = new Set<ChunkGpuLease>();
  readonly #detachedUploadOwners = new Set<string>();
  readonly #leaseCleanup = new Map<ChunkGpuLease, LeaseCleanupState>();
  readonly #leaseCleanupInFlight = new Map<ChunkGpuLease, Promise<boolean>>();
  readonly #leaseActive = new Map<ChunkGpuLease, boolean | null>();
  readonly #cleanupFailures: Readonly<ChunkIssue>[] = [];
  #sourcePlan: Readonly<WorldPlan> | null;
  #plan: Readonly<WorldPlan> | null = null;
  #planDigest: string | null = null;
  #initialized = false;
  #disposed = false;
  #focusChunkId: StoryChunkId | null = null;
  #focusVersion = 0;
  #requestId = 0;
  #sequence = 0;
  #updateActive = false;
  #initializePromise: Promise<void> | null = null;
  #disposePromise: Promise<void> | null = null;
  #qualityProfile: Readonly<RenderQualityProfile> | null = null;

  constructor(options: Readonly<ChunkManagerOptions>) {
    this.#sourcePlan = options.plan;
    this.#worker = options.worker;
    this.#uploads = options.uploads;
    this.#uploader = options.uploader;
    this.#resources = options.resources;
    this.#resourceAdopt = captureResourceMethod(this.#resources, "adopt");
    this.#resourceReleaseOwner = captureResourceMethod(this.#resources, "releaseOwner");
    if ((this.#resourceAdopt === null) !== (this.#resourceReleaseOwner === null)) {
      throw new TypeError("Render resource registry adopt and releaseOwner must be provided together.");
    }
    const concurrency = options.generationConcurrency ?? MAX_CHUNK_GENERATION_CONCURRENCY;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
      throw new RangeError("Chunk generation concurrency must be between one and four.");
    }
    this.#generationConcurrency = concurrency;
    for (const chunkId of STORY_CHUNK_IDS) {
      this.#records.set(chunkId, {
        snapshot: createAbsentChunkSnapshot(chunkId),
        token: null,
        payload: null,
        lease: null,
        focusVersion: -1,
      });
      this.#epochs.set(chunkId, 0);
    }
  }

  initialize(): Promise<void> {
    if (this.#initializePromise) return this.#initializePromise;
    if (this.#disposed) {
      this.#initializePromise = Promise.reject(new Error("Cannot initialize a disposed chunk manager."));
      return this.#initializePromise;
    }
    const deferred = deferredVoid();
    this.#initializePromise = deferred.promise;
    void this.#runInitialize().then(deferred.resolve, deferred.reject);
    return this.#initializePromise;
  }

  setFocus(chunkId: StoryChunkId): void {
    assertStoryChunkId(chunkId);
    if (this.#disposed) return;
    if (this.#focusChunkId === chunkId) return;
    this.#focusChunkId = chunkId;
    this.#focusVersion += 1;
  }

  quality(profile: Readonly<RenderQualityProfile>): void {
    if (this.#disposed) return;
    const owned = captureQualityProfile(profile);
    this.#qualityProfile = owned;
    for (const record of this.#records.values()) {
      if (record.snapshot.state !== "active" || !record.lease?.quality) continue;
      try {
        record.lease.quality(owned);
      } catch {
        this.#failLeaseRecord(record, record.lease, "Resident chunk quality switch failed.", null);
      }
    }
  }

  update(clock: VisualClock): void {
    if (!this.#initialized || this.#disposed || !this.#planDigest || !this.#plan || this.#updateActive) return;
    this.#updateActive = true;
    try {
      this.#drainWorker(clock);
      this.#drainUploads(clock);
      this.#drainResources(clock);
      const roles = this.#desiredRoles();
      this.#retireUndesired(roles, clock);
      this.#ensureDesired(roles, clock);
      this.#startUploads(roles, clock);
      this.#startGeneration(roles, clock);
      this.#assertGpuBound();
    } finally {
      this.#updateActive = false;
    }
  }

  snapshot(): Readonly<ChunkRuntimeSnapshot> {
    const roles = this.#desiredRoles();
    const chunks = STORY_CHUNK_IDS.map((chunkId) => Object.freeze({ ...this.#record(chunkId).snapshot }));
    const activeChunkIds = chunks.filter((chunk) => chunk.state === "active").map((chunk) => chunk.chunkId);
    const placeholderChunkIds = chunks.filter((chunk) => chunk.placeholder && roles.has(chunk.chunkId)).map((chunk) => chunk.chunkId);
    return Object.freeze({
      initialized: this.#initialized,
      disposed: this.#disposed,
      planDigest: this.#planDigest,
      focusChunkId: this.#focusChunkId,
      desiredChunkIds: Object.freeze(STORY_CHUNK_IDS.filter((chunkId) => roles.has(chunkId))),
      activeChunkIds: Object.freeze(activeChunkIds),
      placeholderChunkIds: Object.freeze(placeholderChunkIds),
      gpuOwnedCount: this.#gpuOwnerCount(),
      generatingCount: chunks.filter((chunk) => chunk.state === "generating").length,
      workerInboxCount: this.#worker.pendingReplyCount() + this.#uploadInbox.length + this.#resourceInbox.length,
      uploadQueue: this.#uploads.snapshot(),
      chunks: Object.freeze(chunks),
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

  async #runInitialize(): Promise<void> {
    const source = this.#sourcePlan;
    if (!source) throw new Error("Chunk manager has no world plan to initialize.");
    const snapshot = await this.#worker.initialize(source);
    if (this.#disposed) throw new Error("Chunk manager was disposed during initialization.");
    this.#plan = snapshot.plan;
    this.#planDigest = snapshot.digest;
    this.#sourcePlan = null;
    this.#initialized = true;
    this.#event("worker", "ready", null, null, null, snapshot.digest);
  }

  async #runDispose(): Promise<void> {
    this.#disposed = true;
    const failures: unknown[] = [];
    const disposeWorkerEarly = !this.#initialized;
    if (disposeWorkerEarly) {
      try {
        await this.#worker.dispose();
      } catch {
        failures.push(new Error("Chunk worker disposal failed."));
      }
    }
    for (const record of this.#records.values()) {
      if (record.token && record.snapshot.state === "generating") {
        try {
          this.#worker.cancel(record.token);
        } catch {
          failures.push(new Error("Chunk generation cancellation failed during disposal."));
        }
      }
      if (record.token) {
        try {
          await this.#uploads.cancelOwner(chunkOwnerId(record.token));
        } catch {
          failures.push(new Error("Chunk upload cancellation failed during disposal."));
        }
      }
    }
    try {
      await this.#drainOperations();
    } catch {
      failures.push(new Error("Chunk manager operation drain exceeded its bounded fixed point."));
    }
    for (const ownerId of [...this.#detachedUploadOwners]) {
      await this.#cancelAcceptedUploadOwner(ownerId, null);
      if (this.#detachedUploadOwners.has(ownerId)) {
        failures.push(new Error("Detached chunk upload ownership remained after disposal."));
      }
    }
    for (const entry of this.#uploadInbox.splice(0)) {
      if (entry.result.kind === "complete") this.#ownLease(entry.result.lease);
    }
    for (const entry of this.#resourceInbox.splice(0)) this.#ownLease(entry.lease);
    for (const lease of [...this.#ownedLeases]) {
      this.#setLeaseActive(lease, false, null, null);
      if (!await this.#cleanupLease(lease, null, null)) {
        failures.push(new Error("Chunk lease cleanup remained incomplete during disposal."));
      }
    }
    try {
      await this.#drainOperations();
    } catch {
      failures.push(new Error("Chunk manager final operation drain exceeded its bounded fixed point."));
    }
    if (!disposeWorkerEarly) {
      try {
        await this.#worker.dispose();
      } catch {
        failures.push(new Error("Chunk worker disposal failed."));
      }
    }
    for (const record of this.#records.values()) {
      record.payload = null;
      record.lease = null;
      if (record.snapshot.state !== "disposed" && record.snapshot.state !== "failed" && record.snapshot.state !== "absent") {
        if (record.snapshot.state !== "retiring") {
          record.snapshot = transitionChunkSnapshot(record.snapshot, "retiring", {
            role: null,
            subphase: "none",
          });
        }
        record.snapshot = transitionChunkSnapshot(record.snapshot, "disposed", {
          role: null,
          subphase: "none",
          gpuSlotOwned: false,
        });
      }
    }
    this.#plan = null;
    this.#sourcePlan = null;
    this.#initialized = false;
    if (this.#cleanupFailures.length > 0) {
      failures.push(new Error(`${this.#cleanupFailures.length} earlier chunk cleanup failure(s) were recorded.`));
    }
    if (failures.length > 0) throw new Error(`Chunk manager disposal failed in ${failures.length} bounded cleanup channel(s).`);
  }

  #record(chunkId: StoryChunkId): ChunkRecord {
    const record = this.#records.get(chunkId);
    if (!record) throw new Error(`Missing chunk record for ${chunkId}.`);
    return record;
  }

  #desiredRoles(): ReadonlyMap<StoryChunkId, ChunkWindowRole> {
    const roles = new Map<StoryChunkId, ChunkWindowRole>();
    if (!this.#focusChunkId) return roles;
    const index = STORY_CHUNK_IDS.indexOf(this.#focusChunkId);
    const entries: readonly [number, ChunkWindowRole][] = [
      [-1, "behind"],
      [0, "current"],
      [1, "ahead-1"],
      [2, "ahead-2"],
    ];
    for (const [offset, role] of entries) {
      const chunkId = STORY_CHUNK_IDS[index + offset];
      if (chunkId) roles.set(chunkId, role);
    }
    return roles;
  }

  #priority(roles: ReadonlyMap<StoryChunkId, ChunkWindowRole>): readonly StoryChunkId[] {
    const rank: Readonly<Record<ChunkWindowRole, number>> = {
      current: 0,
      "ahead-1": 1,
      "ahead-2": 2,
      behind: 3,
    };
    return Object.freeze([...roles.keys()].sort((left, right) => rank[roles.get(left)!] - rank[roles.get(right)!]));
  }

  #ensureDesired(roles: ReadonlyMap<StoryChunkId, ChunkWindowRole>, clock: VisualClock): void {
    for (const chunkId of this.#priority(roles)) {
      const role = roles.get(chunkId)!;
      const record = this.#record(chunkId);
      if (record.snapshot.state === "disposed" || record.snapshot.state === "failed" || record.snapshot.state === "absent") {
        if (record.focusVersion === this.#focusVersion) continue;
        const epoch = (this.#epochs.get(chunkId) ?? 0) + 1;
        this.#epochs.set(chunkId, epoch);
        this.#requestId += 1;
        if (!Number.isSafeInteger(this.#requestId)) throw new RangeError("Chunk request id exhausted the safe-integer range.");
        const token = makeChunkGenerationToken({
          planDigest: this.#planDigest!,
          chunkId,
          epoch,
          requestId: this.#requestId,
        });
        const absent = createAbsentChunkSnapshot(chunkId);
        record.snapshot = transitionChunkSnapshot(absent, "queued", {
          role,
          subphase: "planned",
          epoch,
          requestId: token.requestId,
          issue: null,
          placeholder: false,
        });
        record.token = token;
        record.payload = null;
        record.lease = null;
        record.focusVersion = this.#focusVersion;
        this.#event("state", "queued", chunkId, token.requestId, clock.frame, role);
      } else if (record.snapshot.role !== role) {
        record.snapshot = updateChunkWindowRole(record.snapshot, role);
      }
    }
  }

  #retireUndesired(roles: ReadonlyMap<StoryChunkId, ChunkWindowRole>, clock: VisualClock): void {
    for (const chunkId of STORY_CHUNK_IDS) {
      if (roles.has(chunkId)) continue;
      const record = this.#record(chunkId);
      const state = record.snapshot.state;
      if (state === "queued" || state === "generating" || state === "generated") {
        if (state === "generating" && record.token) this.#worker.cancel(record.token);
        record.payload = null;
        record.snapshot = transitionChunkSnapshot(record.snapshot, "retiring", {
          role: null,
          subphase: "none",
        });
        record.snapshot = transitionChunkSnapshot(record.snapshot, "disposed", {
          role: null,
          subphase: "none",
          gpuSlotOwned: false,
        });
        this.#event("state", "disposed", chunkId, record.token?.requestId ?? null, clock.frame, "window-exit");
      } else if (state === "uploading") {
        record.snapshot = transitionChunkSnapshot(record.snapshot, "retiring", { role: null, subphase: "none" });
        if (record.token) this.#track(this.#uploads.cancelOwner(chunkOwnerId(record.token)));
      } else if (state === "active") {
        if (record.token && record.lease) {
          if (!this.#setLeaseActive(record.lease, false, chunkId, record.token.requestId)) {
            this.#failLeaseRecord(record, record.lease, "Chunk visual deactivation failed.", clock.frame);
          } else {
            record.snapshot = transitionChunkSnapshot(record.snapshot, "retiring", { role: null, subphase: "none" });
            this.#beginRelease(record, record.token, record.lease);
          }
        }
      } else if (state === "failed" && (record.snapshot.role !== null || record.snapshot.placeholder)) {
        record.snapshot = Object.freeze({
          ...record.snapshot,
          role: null,
          updateMode: "live",
          placeholder: false,
        });
      }
    }
  }

  #startGeneration(roles: ReadonlyMap<StoryChunkId, ChunkWindowRole>, clock: VisualClock): void {
    let available = this.#generationConcurrency
      - [...this.#records.values()].filter((record) => record.snapshot.state === "generating").length;
    for (const chunkId of this.#priority(roles)) {
      if (available <= 0) break;
      const record = this.#record(chunkId);
      if (record.snapshot.state !== "queued" || !record.token) continue;
      try {
        record.snapshot = transitionChunkSnapshot(record.snapshot, "generating", { subphase: "worker" });
        this.#worker.generate(record.token);
        available -= 1;
        this.#event("worker", "generate", chunkId, record.token.requestId, clock.frame, null);
      } catch {
        this.#failRecord(record, runtimeIssue(
          "GENERATION_FAILED",
          "Generation request failed.",
          chunkId,
        ), true, clock);
      }
    }
  }

  #startUploads(roles: ReadonlyMap<StoryChunkId, ChunkWindowRole>, clock: VisualClock): void {
    for (const chunkId of this.#priority(roles)) {
      const record = this.#record(chunkId);
      if (record.snapshot.state !== "generated" || !record.token || !record.payload) continue;
      if (this.#gpuOwnerCount() >= 4) {
        if (this.#cleanupFailures.length > 0 || this.#detachedUploadOwners.size > 0) {
          this.#failRecord(record, runtimeIssue(
            "RESOURCE_RELEASE_FAILED",
            "No GPU slot is available because prior ownership cleanup failed.",
            chunkId,
          ), true, clock);
          continue;
        }
        break;
      }
      let job: Readonly<ChunkUploadJob> | null = null;
      let ownershipTransferred = false;
      const rollbackOwners = new Set<string>();
      const payloadBytes = record.payload.manifest.byteLength;
      try {
        job = this.#uploader.createUploadJob(record.payload, record.token);
        const expectedOwner = chunkOwnerId(record.token);
        rollbackOwners.add(expectedOwner);
        if (ownDataValue(job, "ownerId", "Chunk upload job") !== expectedOwner) {
          throw new TypeError(`Upload job owner must be ${expectedOwner}.`);
        }
        const rawTicket = this.#uploads.enqueue(job);
        ownershipTransferred = true;
        const ticket = captureUploadTicket(rawTicket);
        if (ticket.ownerId !== expectedOwner) {
          throw new TypeError(`Upload job owner must be ${expectedOwner}.`);
        }
        const token = record.token;
        const delivery = Reflect.apply(Promise.prototype.then, ticket.result, [
          (rawResult: unknown) => {
            let result: Readonly<ChunkUploadResult>;
            try {
              result = captureUploadResult(rawResult, ticket, token);
            } catch {
              result = Object.freeze({
                kind: "failed" as const,
                jobId: ticket.id,
                ownerId: ticket.ownerId,
                issue: runtimeIssue("UPLOAD_FAILED", "Upload result validation failed.", token.chunkId),
              });
              this.#track(this.#cancelAcceptedUploadOwner(expectedOwner, token));
            }
            if (result.kind === "complete") this.#ownLease(result.lease);
            if (this.#uploadInbox.length >= MAX_CHUNK_WORKER_INBOX) {
              if (result.kind === "complete") this.#track(this.#disposeOrphanLease(result.lease));
              return;
            }
            this.#uploadInbox.push(Object.freeze({ token, result }));
          },
          () => {
            const result = Object.freeze({
              kind: "failed" as const,
              jobId: ticket.id,
              ownerId: ticket.ownerId,
              issue: runtimeIssue("UPLOAD_FAILED", "Upload result promise rejected.", token.chunkId),
            });
            this.#track(this.#cancelAcceptedUploadOwner(expectedOwner, token));
            this.#uploadInbox.push(Object.freeze({ token, result }));
          },
        ]) as Promise<void>;
        this.#track(delivery);
        record.snapshot = transitionChunkSnapshot(record.snapshot, "uploading", {
          subphase: "gpu-upload-pending",
          gpuSlotOwned: true,
        });
        record.payload = null;
        this.#event("upload", "pending", chunkId, token.requestId, clock.frame, payloadBytes);
      } catch {
        if (job && !ownershipTransferred) {
          this.#track(this.#rollbackRejectedUploadJob(job, record.token));
        } else if (ownershipTransferred) {
          for (const ownerId of rollbackOwners) {
            this.#detachedUploadOwners.add(ownerId);
            this.#track(this.#cancelAcceptedUploadOwner(ownerId, record.token));
          }
        }
        this.#failRecord(record, runtimeIssue(
          "UPLOAD_FAILED",
          "Upload job creation failed.",
          chunkId,
        ), true, clock);
      }
    }
  }

  #drainWorker(clock: VisualClock): void {
    for (const reply of this.#worker.drainReplies()) {
      if (reply.kind === "failed" && !reply.token) {
        this.#event("issue", reply.issue.code, null, null, clock.frame, reply.issue.detail);
        for (const record of this.#records.values()) {
          if (record.snapshot.state !== "generating") continue;
          this.#failRecord(record, runtimeIssue(
            reply.issue.code,
            "Worker-wide generation failure.",
            record.snapshot.chunkId,
          ), true, clock);
        }
        continue;
      }
      if (!reply.token) continue;
      const record = this.#record(reply.token.chunkId);
      if (!tokensEqual(record.token, reply.token) || record.snapshot.state !== "generating") {
        this.#event("worker", "stale-reply", reply.token.chunkId, reply.token.requestId, clock.frame, reply.kind);
        continue;
      }
      if (reply.kind === "failed") {
        this.#failRecord(record, reply.issue, true, clock);
        continue;
      }
      record.snapshot = transitionChunkSnapshot(record.snapshot, "generated", { subphase: "validating" });
      record.payload = reply.payload;
      this.#event("worker", "generated", reply.token.chunkId, reply.token.requestId, clock.frame, reply.payload.contentDigest);
    }
  }

  #drainUploads(clock: VisualClock): void {
    for (const entry of this.#uploadInbox.splice(0, this.#uploadInbox.length)) {
      const record = this.#record(entry.token.chunkId);
      const current = tokensEqual(record.token, entry.token);
      if (!current || (record.snapshot.state !== "uploading" && record.snapshot.state !== "retiring")) {
        if (entry.result.kind === "complete") this.#track(this.#disposeOrphanLease(entry.result.lease));
        this.#event("upload", "stale-result", entry.token.chunkId, entry.token.requestId, clock.frame, entry.result.kind);
        continue;
      }
      if (entry.result.kind !== "complete") {
        if (record.snapshot.state === "retiring") {
          record.snapshot = transitionChunkSnapshot(record.snapshot, "disposed", {
            gpuSlotOwned: false,
            subphase: "none",
          });
        } else {
          const failure = entry.result.kind === "failed"
            ? entry.result.issue
            : runtimeIssue("GENERATION_CANCELLED", "Chunk upload was cancelled.", entry.token.chunkId);
          this.#failRecord(record, failure, true, clock);
        }
        continue;
      }
      const lease = entry.result.lease;
      if (record.snapshot.state === "retiring") {
        this.#beginRelease(record, entry.token, lease);
        continue;
      }
      if (!this.#alignCurrentDesiredRole(record, entry.token)) {
        this.#retireBeforeActivation(record, entry.token, lease);
        continue;
      }
      if (!this.#prepareLease(record, entry.token, lease, clock.frame)) continue;
      const adopt = this.#resourceAdopt;
      if (!this.#alignCurrentDesiredRole(record, entry.token)) {
        this.#retireBeforeActivation(record, entry.token, lease);
        continue;
      }
      if (!adopt) {
        if (!this.#setLeaseActive(lease, true, entry.token.chunkId, entry.token.requestId)) {
          this.#failLeaseRecord(record, lease, "Chunk visual activation failed.", clock.frame);
          continue;
        }
        record.lease = lease;
        record.snapshot = transitionChunkSnapshot(record.snapshot, "active", { subphase: "none" });
        this.#event("state", "active", entry.token.chunkId, entry.token.requestId, clock.frame, null);
        continue;
      }
      this.#cleanupState(lease).adopted = true;
      const operation = Promise.resolve()
        .then(() => adopt.call(this.#resources, lease.ownership))
        .then(
          () => this.#resourceInbox.push(Object.freeze({ token: entry.token, lease, adopted: true })),
          () => this.#resourceInbox.push(Object.freeze({ token: entry.token, lease, adopted: false })),
        )
        .then(() => undefined);
      this.#track(operation);
    }
  }

  #drainResources(clock: VisualClock): void {
    for (const entry of this.#resourceInbox.splice(0, this.#resourceInbox.length)) {
      const record = this.#record(entry.token.chunkId);
      const current = tokensEqual(record.token, entry.token);
      if (current && record.snapshot.state === "retiring") {
        this.#beginRelease(record, entry.token, entry.lease);
        continue;
      }
      if (!current || record.snapshot.state !== "uploading") {
        this.#track(this.#disposeOrphanLease(entry.lease));
        continue;
      }
      if (!this.#alignCurrentDesiredRole(record, entry.token)) {
        this.#retireBeforeActivation(record, entry.token, entry.lease);
        continue;
      }
      if (!entry.adopted) {
        this.#track(this.#disposeOrphanLease(entry.lease));
        this.#failRecord(record, runtimeIssue(
          "UPLOAD_FAILED",
          "Resource adoption failed.",
          entry.token.chunkId,
        ), true, clock);
        continue;
      }
      if (!this.#setLeaseActive(entry.lease, true, entry.token.chunkId, entry.token.requestId)) {
        this.#failLeaseRecord(record, entry.lease, "Chunk visual activation failed.", clock.frame);
        continue;
      }
      record.lease = entry.lease;
      record.snapshot = transitionChunkSnapshot(record.snapshot, "active", { subphase: "none" });
      this.#event("state", "active", entry.token.chunkId, entry.token.requestId, clock.frame, null);
    }
  }

  async #rollbackRejectedUploadJob(
    job: Readonly<ChunkUploadJob>,
    token: Readonly<ChunkGenerationToken>,
  ): Promise<void> {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(job, "cancel");
    } catch {
      this.#recordCleanupFailure("Rejected upload job cancel descriptor failed.", token.chunkId, token.requestId);
      return;
    }
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
      this.#recordCleanupFailure("Rejected upload job has no capturable cancel function.", token.chunkId, token.requestId);
      return;
    }
    try {
      await Reflect.apply(descriptor.value, job, []);
      this.#event("upload", "rejected-job-rolled-back", token.chunkId, token.requestId, null, null);
    } catch {
      this.#recordCleanupFailure("Rejected upload job rollback failed.", token.chunkId, token.requestId);
    }
  }

  async #cancelAcceptedUploadOwner(
    ownerId: string,
    token: Readonly<ChunkGenerationToken> | null,
  ): Promise<void> {
    try {
      await this.#uploads.cancelOwner(ownerId);
      this.#detachedUploadOwners.delete(ownerId);
    } catch {
      this.#recordCleanupFailure(
        "Accepted upload owner rollback failed.",
        token?.chunkId ?? null,
        token?.requestId ?? null,
      );
    }
  }

  #beginRelease(record: ChunkRecord, token: Readonly<ChunkGenerationToken>, lease: ChunkGpuLease): void {
    const operation = Promise.resolve()
      .then(() => this.#cleanupLease(lease, token.chunkId, token.requestId))
      .then((complete) => {
        if (!complete) throw new Error("Chunk resource release failed.");
      })
      .then(
        () => {
          if (!tokensEqual(record.token, token) || record.snapshot.state !== "retiring") return;
          record.lease = null;
          record.snapshot = transitionChunkSnapshot(record.snapshot, "disposed", {
            gpuSlotOwned: false,
            subphase: "none",
          });
          this.#event("resource", "disposed", token.chunkId, token.requestId, null, null);
        },
        () => {
          if (!tokensEqual(record.token, token) || record.snapshot.state !== "retiring") return;
          record.snapshot = transitionChunkSnapshot(record.snapshot, "failed", {
            gpuSlotOwned: false,
            subphase: "placeholder",
            placeholder: true,
            issue: runtimeIssue(
              "RESOURCE_RELEASE_FAILED",
              "Chunk resource release failed.",
              token.chunkId,
            ),
          });
        },
      );
    this.#track(operation);
  }

  async #disposeOrphanLease(lease: ChunkGpuLease): Promise<void> {
    this.#ownLease(lease);
    if (!await this.#cleanupLease(lease, null, null)) {
      throw new Error("Orphan chunk lease cleanup failed.");
    }
  }

  #cleanupState(lease: ChunkGpuLease): LeaseCleanupState {
    const current = this.#leaseCleanup.get(lease);
    if (current) return current;
    const created: LeaseCleanupState = {
      adopted: false,
      releaseComplete: false,
      disposeComplete: false,
    };
    this.#leaseCleanup.set(lease, created);
    return created;
  }

  #ownLease(lease: ChunkGpuLease): void {
    this.#ownedLeases.add(lease);
    this.#cleanupState(lease);
    if (!this.#leaseActive.has(lease)) this.#leaseActive.set(lease, null);
  }

  #prepareLease(
    record: ChunkRecord,
    token: Readonly<ChunkGenerationToken>,
    lease: ChunkGpuLease,
    frame: number,
  ): boolean {
    if (!this.#setLeaseActive(lease, false, token.chunkId, token.requestId)) {
      this.#failLeaseRecord(record, lease, "Chunk visual initialization failed.", frame);
      return false;
    }
    if (this.#qualityProfile && lease.quality) {
      try {
        lease.quality(this.#qualityProfile);
      } catch {
        this.#failLeaseRecord(record, lease, "Chunk quality initialization failed.", frame);
        return false;
      }
    }
    return true;
  }

  #alignCurrentDesiredRole(
    record: ChunkRecord,
    token: Readonly<ChunkGenerationToken>,
  ): boolean {
    if (!tokensEqual(record.token, token)) return false;
    const desiredRole = this.#desiredRoles().get(token.chunkId);
    if (!desiredRole) return false;
    if (record.snapshot.role !== desiredRole) {
      record.snapshot = updateChunkWindowRole(record.snapshot, desiredRole);
    }
    return true;
  }

  #retireBeforeActivation(
    record: ChunkRecord,
    token: Readonly<ChunkGenerationToken>,
    lease: ChunkGpuLease,
  ): void {
    if (!tokensEqual(record.token, token)) {
      this.#track(this.#disposeOrphanLease(lease));
      return;
    }
    if (record.snapshot.state === "uploading") {
      record.snapshot = transitionChunkSnapshot(record.snapshot, "retiring", {
        role: null,
        subphase: "none",
      });
    }
    if (record.snapshot.state === "retiring") {
      this.#beginRelease(record, token, lease);
      return;
    }
    this.#track(this.#disposeOrphanLease(lease));
  }

  #setLeaseActive(
    lease: ChunkGpuLease,
    active: boolean,
    chunkId: StoryChunkId | null,
    requestId: number | null,
  ): boolean {
    this.#ownLease(lease);
    if (this.#leaseActive.get(lease) === active) return true;
    try {
      lease.setActive?.(active);
      this.#leaseActive.set(lease, active);
      return true;
    } catch {
      this.#recordCleanupFailure(
        active ? "Chunk visual activation failed." : "Chunk visual deactivation failed.",
        chunkId,
        requestId,
      );
      return false;
    }
  }

  #failLeaseRecord(
    record: ChunkRecord,
    lease: ChunkGpuLease,
    detail: string,
    frame: number | null,
  ): void {
    const issue = runtimeIssue("UPLOAD_FAILED", detail, record.snapshot.chunkId);
    record.payload = null;
    record.lease = null;
    record.snapshot = failChunkSnapshot(record.snapshot, issue, true);
    this.#event("issue", issue.code, record.snapshot.chunkId, record.token?.requestId ?? null, frame, issue.detail);
    this.#event("placeholder", "enabled", record.snapshot.chunkId, record.token?.requestId ?? null, frame, true);
    this.#track(this.#disposeOrphanLease(lease));
  }

  #cleanupLease(
    lease: ChunkGpuLease,
    chunkId: StoryChunkId | null,
    requestId: number | null,
  ): Promise<boolean> {
    const current = this.#leaseCleanupInFlight.get(lease);
    if (current) return current;
    const deferred = deferredBoolean();
    this.#leaseCleanupInFlight.set(lease, deferred.promise);
    void this.#runCleanupLease(lease, chunkId, requestId).then(deferred.resolve, () => deferred.resolve(false));
    void deferred.promise.finally(() => {
      if (this.#leaseCleanupInFlight.get(lease) === deferred.promise) this.#leaseCleanupInFlight.delete(lease);
    });
    return deferred.promise;
  }

  async #runCleanupLease(
    lease: ChunkGpuLease,
    chunkId: StoryChunkId | null,
    requestId: number | null,
  ): Promise<boolean> {
    this.#ownLease(lease);
    const state = this.#cleanupState(lease);
    this.#setLeaseActive(lease, false, chunkId, requestId);
    if (!state.releaseComplete) {
      const releaseOwner = this.#resourceReleaseOwner;
      if (!state.adopted || !releaseOwner) {
        state.releaseComplete = true;
      } else {
        try {
          await releaseOwner.call(this.#resources, lease.ownerId);
          state.releaseComplete = true;
        } catch {
          this.#recordCleanupFailure("Logical chunk resource release failed.", chunkId, requestId);
        }
      }
    }
    if (!state.disposeComplete) {
      try {
        await lease.dispose();
        state.disposeComplete = true;
      } catch {
        this.#recordCleanupFailure("Chunk GPU lease disposal failed.", chunkId, requestId);
      }
    }
    const complete = state.releaseComplete && state.disposeComplete;
    if (complete) {
      this.#ownedLeases.delete(lease);
      this.#leaseCleanup.delete(lease);
      this.#leaseActive.delete(lease);
    }
    return complete;
  }

  #failRecord(
    record: ChunkRecord,
    issue: Readonly<ChunkIssue>,
    placeholder: boolean,
    clock: VisualClock,
  ): void {
    record.payload = null;
    record.lease = null;
    record.snapshot = failChunkSnapshot(record.snapshot, issue, placeholder);
    this.#event("issue", issue.code, record.snapshot.chunkId, record.token?.requestId ?? null, clock.frame, issue.detail);
    if (placeholder) this.#event("placeholder", "enabled", record.snapshot.chunkId, record.token?.requestId ?? null, clock.frame, true);
  }

  #assertGpuBound(): void {
    const count = this.#gpuOwnerCount();
    if (count > 4) throw new Error(`Chunk GPU ownership exceeded four slots: ${count}.`);
  }

  #gpuOwnerCount(): number {
    const ownerIds = new Set<string>();
    for (const record of this.#records.values()) {
      if (record.snapshot.gpuSlotOwned && record.token) ownerIds.add(chunkOwnerId(record.token));
    }
    for (const lease of this.#ownedLeases) ownerIds.add(lease.ownerId);
    for (const ownerId of this.#detachedUploadOwners) ownerIds.add(ownerId);
    for (const ownerId of this.#uploads.snapshot().orphanOwnerIds) ownerIds.add(ownerId);
    return ownerIds.size;
  }

  #track(operation: Promise<unknown>): void {
    const tracked = Promise.resolve(operation).then(() => undefined, () => undefined);
    this.#operations.add(tracked);
    void tracked.finally(() => this.#operations.delete(tracked));
  }

  async #drainOperations(): Promise<void> {
    for (let turn = 0; turn < 256 && this.#operations.size > 0; turn += 1) {
      await Promise.allSettled([...this.#operations]);
    }
    if (this.#operations.size > 0) {
      throw new Error("Chunk manager cleanup operations did not reach a bounded fixed point.");
    }
  }

  #recordCleanupFailure(
    detail: string,
    chunkId: StoryChunkId | null,
    requestId: number | null,
  ): void {
    const failure = runtimeIssue("RESOURCE_RELEASE_FAILED", detail, chunkId ?? undefined);
    if (this.#cleanupFailures.length < 64) this.#cleanupFailures.push(failure);
    this.#event("issue", "cleanup-failed", chunkId, requestId, null, detail);
  }

  #event(
    kind: ChunkRuntimeEvent["kind"],
    name: string,
    chunkId: StoryChunkId | null,
    requestId: number | null,
    frame: number | null,
    value: ChunkRuntimeEvent["value"],
  ): void {
    this.#sequence += 1;
    this.#events.push(Object.freeze({ sequence: this.#sequence, kind, name, chunkId, requestId, frame, value }));
    if (this.#events.length > MAX_CHUNK_TELEMETRY_EVENTS) this.#events.shift();
  }
}
