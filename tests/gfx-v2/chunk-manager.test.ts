import { describe, expect, it } from "vitest";
import type {
  RenderLogicalResourceOwnership,
  RenderOperationClock,
  RenderQualityProfile,
  RenderResourceRegistry,
  RenderResourceSnapshot,
  RenderServiceInitializationContext,
} from "../../src/gfx/v2/contracts";
import type { GfxOperationalEventInput, GfxTelemetrySink } from "../../src/gfx/v2/telemetry";
import { STORY_CHUNK_IDS, type StoryChunkId, type WorldPlan } from "../../src/world/v2/contracts";
import { createWorldGenerationContext } from "../../src/world/v2/seed-streams";
import { generateWorldPlan } from "../../src/world/v2/world-plan";
import {
  CHUNK_WORKER_PROTOCOL_VERSION,
  type ChunkGenerationToken,
  type ChunkGpuLease,
  type ChunkRuntimeSnapshot,
  type ChunkUploadJob,
  type ChunkUploadQueueLike,
  type ChunkUploadQueueSnapshot,
  type ChunkUploadTicket,
  type ChunkUploader,
  type ChunkWorkerClientLike,
  type ChunkWorkerFailedReply,
  type ChunkWorkerGeneratedReply,
  type GeneratedChunkPayload,
  type OwnedWorldPlanSnapshot,
} from "../../src/gfx/v2/chunks/contracts";
import { ChunkManager, chunkOwnerId } from "../../src/gfx/v2/chunks/chunk-manager";
import { IncrementalChunkUploadQueue } from "../../src/gfx/v2/chunks/upload-queue";
import { generateChunkPayload } from "../../src/gfx/v2/chunks/worker-kernel";
import { captureOwnedWorldPlan } from "../../src/gfx/v2/chunks/worker-protocol";

const WORLD_PLAN = generateWorldPlan(createWorldGenerationContext({ worldSeed: 20_260_818 }));
const PROFILE: Readonly<RenderQualityProfile> = Object.freeze({
  tier: "high",
  pixelRatio: 1,
  uploadBudgetMs: 4,
  features: Object.freeze({}),
});

interface DeferredVoid {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface Rejection {
  readonly value: unknown;
}

function deferredVoid(): DeferredVoid {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function clock(frame: number, storyTime = 70 + frame / 60): Readonly<RenderOperationClock> {
  return Object.freeze({
    frame,
    nowMs: frame * 16,
    deltaSeconds: 1 / 60,
    elapsedSeconds: frame / 60,
    storyTime,
  });
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

class ControlledWorker implements ChunkWorkerClientLike {
  readonly requested: Readonly<ChunkGenerationToken>[] = [];
  readonly cancelled: Readonly<ChunkGenerationToken>[] = [];
  initializeCalls = 0;
  disposeCalls = 0;
  #plan: Readonly<WorldPlan> | null = null;
  readonly #replies: Array<Readonly<ChunkWorkerGeneratedReply | ChunkWorkerFailedReply>> = [];
  readonly #initializeGate: Promise<void> | null;
  #shuffleState = 0x6d2b_79f5;

  constructor(initializeGate: Promise<void> | null = null) {
    this.#initializeGate = initializeGate;
  }

  initialize(plan: Readonly<WorldPlan>): Promise<Readonly<OwnedWorldPlanSnapshot>> {
    this.initializeCalls += 1;
    const captured = captureOwnedWorldPlan(plan);
    return (this.#initializeGate ?? Promise.resolve()).then(() => {
      this.#plan = captured.plan;
      return captured;
    });
  }

  generate(token: Readonly<ChunkGenerationToken>): void {
    (this.requested as Readonly<ChunkGenerationToken>[]).push(token);
  }

  cancel(token: Readonly<ChunkGenerationToken>): void {
    (this.cancelled as Readonly<ChunkGenerationToken>[]).push(token);
  }

  drainReplies(): readonly Readonly<ChunkWorkerGeneratedReply | ChunkWorkerFailedReply>[] {
    return this.#replies.splice(0, this.#replies.length);
  }

  pendingReplyCount(): number {
    return this.#replies.length;
  }

  completeNext(): Readonly<ChunkGenerationToken> {
    const token = (this.requested as Readonly<ChunkGenerationToken>[]).shift();
    if (!token) throw new Error("No controlled chunk request is pending.");
    this.#generated(token);
    return token;
  }

  completeAllShuffled(): void {
    const pending = (this.requested as Readonly<ChunkGenerationToken>[]).splice(
      0,
      this.requested.length,
    );
    for (let index = pending.length - 1; index > 0; index -= 1) {
      this.#shuffleState ^= this.#shuffleState << 13;
      this.#shuffleState ^= this.#shuffleState >>> 17;
      this.#shuffleState ^= this.#shuffleState << 5;
      const swapIndex = (this.#shuffleState >>> 0) % (index + 1);
      [pending[index], pending[swapIndex]] = [pending[swapIndex]!, pending[index]!];
    }
    for (const token of pending) this.#generated(token);
  }

  failRequestedChunk(chunkId: StoryChunkId): Readonly<ChunkGenerationToken> {
    const index = this.requested.findIndex((token) => token.chunkId === chunkId);
    if (index < 0) throw new Error(`No controlled request exists for ${chunkId}.`);
    const [token] = (this.requested as Readonly<ChunkGenerationToken>[]).splice(index, 1);
    if (!token) throw new Error(`Controlled request vanished for ${chunkId}.`);
    this.#replies.push(Object.freeze({
      kind: "failed",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      token,
      issue: Object.freeze({
        code: "GENERATION_FAILED",
        path: `$.chunks.${chunkId}`,
        detail: "Controlled generation failure.",
        chunkId,
      }),
    }));
    return token;
  }

  injectNullTokenFailure(): void {
    this.#replies.push(Object.freeze({
      kind: "failed",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      token: null,
      issue: Object.freeze({
        code: "WORKER_NOT_READY",
        path: "$",
        detail: "Controlled global worker failure.",
      }),
    }));
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    (this.requested as Readonly<ChunkGenerationToken>[]).splice(0);
    this.#replies.splice(0);
  }

  #generated(token: Readonly<ChunkGenerationToken>): void {
    if (!this.#plan) throw new Error("Controlled worker has no installed plan.");
    this.#replies.push(Object.freeze({
      kind: "generated",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      token,
      payload: generateChunkPayload(this.#plan, token),
    }));
  }
}

class TrackedResources implements RenderResourceRegistry {
  readonly owners = new Set<string>();
  readonly adoptCalls: string[] = [];
  readonly releaseCalls: string[] = [];
  readonly #trace: string[];
  readonly #adoptRejection: Rejection | null;
  readonly #adoptGate: Promise<void> | null;
  readonly #releaseRejection: Rejection | null;

  constructor(options: {
    readonly trace: string[];
    readonly adoptRejection?: Rejection;
    readonly adoptGate?: Promise<void>;
    readonly releaseRejection?: Rejection;
  }) {
    this.#trace = options.trace;
    this.#adoptRejection = options.adoptRejection ?? null;
    this.#adoptGate = options.adoptGate ?? null;
    this.#releaseRejection = options.releaseRejection ?? null;
  }

  initialize(context: RenderServiceInitializationContext): void {
    void context;
  }

  adopt(ownership: Readonly<RenderLogicalResourceOwnership>): void | Promise<void> {
    this.adoptCalls.push(ownership.ownerId);
    this.owners.add(ownership.ownerId);
    this.#trace.push(`adopt:${ownership.ownerId}`);
    if (this.#adoptRejection) return Promise.reject(this.#adoptRejection.value);
    if (this.#adoptGate) return this.#adoptGate;
  }

  releaseOwner(ownerId: string): void | Promise<void> {
    this.releaseCalls.push(ownerId);
    this.#trace.push(`release:${ownerId}`);
    if (this.#releaseRejection) return Promise.reject(this.#releaseRejection.value);
    this.owners.delete(ownerId);
  }

  snapshot(): Readonly<RenderResourceSnapshot> {
    return Object.freeze({
      geometries: this.owners.size,
      textures: 0,
      renderTargets: 0,
      programs: 0,
      nodes: this.owners.size,
      objects: this.owners.size,
      subscribers: 0,
      pendingUploads: 0,
    });
  }

  dispose(): void {
    this.owners.clear();
  }
}

class TrackedUploader implements ChunkUploader {
  readonly createdOwners: string[] = [];
  readonly payloadDigests: string[] = [];
  readonly disposeCalls: string[] = [];
  readonly cancelCalls: string[] = [];
  readonly qualityCalls: string[] = [];
  readonly activeCalls: string[] = [];
  onCreate: (() => void) | null = null;
  readonly #time: { value: number };
  readonly #trace: string[];
  readonly #disposeRejection: Rejection | null;

  constructor(options: {
    readonly time: { value: number };
    readonly trace: string[];
    readonly disposeRejection?: Rejection;
  }) {
    this.#time = options.time;
    this.#trace = options.trace;
    this.#disposeRejection = options.disposeRejection ?? null;
  }

  createUploadJob(
    payload: Readonly<GeneratedChunkPayload>,
    token: Readonly<ChunkGenerationToken>,
  ): Readonly<ChunkUploadJob> {
    const ownerId = chunkOwnerId(token);
    this.createdOwners.push(ownerId);
    this.payloadDigests.push(payload.contentDigest);
    this.#trace.push(`job:${ownerId}`);
    this.onCreate?.();
    const lease: ChunkGpuLease = {
      ownerId,
      ownership: {
        ownerId,
        geometries: 1,
        textures: 0,
        renderTargets: 0,
        nodes: 1,
        objects: 1,
        bytes: payload.manifest.byteLength,
      },
      quality: (profile) => {
        this.qualityCalls.push(`${ownerId}:${profile.tier}`);
        this.#trace.push(`quality:${ownerId}:${profile.tier}`);
      },
      setActive: (active) => {
        this.activeCalls.push(`${ownerId}:${String(active)}`);
        this.#trace.push(`active:${ownerId}:${String(active)}`);
      },
      dispose: () => {
        this.disposeCalls.push(ownerId);
        this.#trace.push(`dispose:${ownerId}`);
        if (this.#disposeRejection) return Promise.reject(this.#disposeRejection.value);
      },
    };
    return {
      id: `upload-${token.epoch}-${token.requestId}`,
      ownerId,
      token,
      byteLength: payload.manifest.byteLength,
      maximumSliceMs: 1,
      runSlice: () => {
        this.#time.value += 0.05;
        this.#trace.push(`upload:${ownerId}`);
        return {
          kind: "complete",
          uploadedBytes: payload.manifest.byteLength,
          lease,
        };
      },
      cancel: () => {
        this.cancelCalls.push(ownerId);
        this.#trace.push(`cancel-job:${ownerId}`);
      },
    };
  }
}

interface Harness {
  readonly manager: ChunkManager;
  readonly worker: ControlledWorker;
  readonly uploads: IncrementalChunkUploadQueue;
  readonly uploader: TrackedUploader;
  readonly resources: TrackedResources;
  readonly trace: string[];
  frame: number;
}

function createHarness(options: {
  readonly plan?: Readonly<WorldPlan>;
  readonly worker?: ControlledWorker;
  readonly adoptRejection?: Rejection;
  readonly adoptGate?: Promise<void>;
  readonly releaseRejection?: Rejection;
  readonly disposeRejection?: Rejection;
  readonly telemetry?: GfxTelemetrySink;
} = {}): Harness {
  const time = { value: 0 };
  const trace: string[] = [];
  const uploads = new IncrementalChunkUploadQueue(() => time.value);
  uploads.initialize({} as RenderServiceInitializationContext);
  uploads.quality(PROFILE);
  const worker = options.worker ?? new ControlledWorker();
  const resources = new TrackedResources({
    trace,
    ...(options.adoptRejection ? { adoptRejection: options.adoptRejection } : {}),
    ...(options.adoptGate ? { adoptGate: options.adoptGate } : {}),
    ...(options.releaseRejection ? { releaseRejection: options.releaseRejection } : {}),
  });
  const uploader = new TrackedUploader({
    time,
    trace,
    ...(options.disposeRejection ? { disposeRejection: options.disposeRejection } : {}),
  });
  const manager = new ChunkManager({
    plan: options.plan ?? WORLD_PLAN,
    worker,
    uploads,
    uploader,
    resources,
    generationConcurrency: 2,
    now: () => time.value,
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  });
  return { manager, worker, uploads, uploader, resources, trace, frame: 0 };
}

async function turn(harness: Harness, completeWorker = true): Promise<Readonly<ChunkRuntimeSnapshot>> {
  harness.frame += 1;
  const visualClock = clock(harness.frame);
  harness.manager.update(visualClock);
  if (completeWorker) harness.worker.completeAllShuffled();
  await harness.uploads.flush(visualClock, PROFILE);
  await drainMicrotasks();
  const snapshot = harness.manager.snapshot();
  expect(snapshot.gpuOwnedCount).toBeLessThanOrEqual(4);
  return snapshot;
}

async function driveDesiredToTerminal(harness: Harness): Promise<Readonly<ChunkRuntimeSnapshot>> {
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const snapshot = await turn(harness);
    const desired = snapshot.desiredChunkIds.map((chunkId) =>
      snapshot.chunks.find((chunk) => chunk.chunkId === chunkId),
    );
    if (
      desired.length > 0
      && desired.every((chunk) => chunk?.state === "active" || chunk?.state === "failed")
      && harness.uploads.pendingCount() === 0
      && harness.worker.requested.length === 0
      && harness.worker.pendingReplyCount() === 0
      && snapshot.workerInboxCount === 0
    ) {
      return snapshot;
    }
  }
  throw new Error("Controlled chunk manager did not settle in 48 turns.");
}

function chunk(snapshot: Readonly<ChunkRuntimeSnapshot>, chunkId: StoryChunkId) {
  const value = snapshot.chunks.find((candidate) => candidate.chunkId === chunkId);
  if (!value) throw new Error(`Missing chunk snapshot ${chunkId}.`);
  return value;
}

async function disposeCleanHarness(harness: Harness): Promise<void> {
  await harness.manager.dispose();
  await harness.uploads.dispose();
}

class RejectingUploadQueue implements ChunkUploadQueueLike {
  readonly cancelledOwners: string[] = [];

  enqueue(job: Readonly<ChunkUploadJob>): Readonly<ChunkUploadTicket> {
    void job;
    throw Object.freeze({ opaque: "enqueue rejection" });
  }

  async cancelOwner(ownerId: string): Promise<void> {
    this.cancelledOwners.push(ownerId);
  }

  snapshot(): Readonly<ChunkUploadQueueSnapshot> {
    return Object.freeze({
      initialized: true,
      disposed: false,
      pending: 0,
      activeJobId: null,
      completed: 0,
      cancelled: 0,
      failed: 0,
      totalUploadedBytes: 0,
      orphanLeaseCount: 0,
      orphanJobCount: 0,
      orphanOwnerIds: Object.freeze([]),
      cleanupFailureCount: 0,
      events: Object.freeze([]),
    });
  }

  pendingCount(): number {
    return 0;
  }
}

class MismatchedTicketQueue extends RejectingUploadQueue {
  override enqueue(job: Readonly<ChunkUploadJob>): Readonly<ChunkUploadTicket> {
    return Object.freeze({
      id: job.id,
      ownerId: "chunk-unrelated-live-owner",
      result: new Promise<never>(() => undefined),
    });
  }
}

describe("GFX-004 chunk manager", () => {
  it("reports successful lease activation on the exact update frame", async () => {
    const events: Readonly<GfxOperationalEventInput>[] = [];
    const harness = createHarness({
      telemetry: {
        recordFrame(): void {},
        recordOperation(event): void {
          events.push(event);
        },
      },
    });
    await harness.manager.initialize();
    harness.manager.setFocus("S08");
    await driveDesiredToTerminal(harness);

    const activations = events.filter((event) => event.kind === "activation");
    expect(activations.length).toBeGreaterThan(0);
    expect(activations.every((event) => (
      /^chunk-s\d{2}-\d+-lease-activation$/.test(event.name)
      && event.frameId !== null
      && event.storyTime === clock(event.frameId).storyTime
      && event.storyTime > 70
      && event.durationMs === 0
      && event.success
      && event.affectsStoryTime
      && Object.isFrozen(event)
    ))).toBe(true);
    await disposeCleanHarness(harness);
  });

  it("captures operation story time without getters or reentrant focus mutation", async () => {
    const harness = createHarness();
    await harness.manager.initialize();
    harness.manager.setFocus("S08");
    const nestedFailures: unknown[] = [];
    let attemptedReentry = false;
    const reentrantClock = new Proxy({ ...clock(1, 88.5) }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "storyTime" && !attemptedReentry) {
          attemptedReentry = true;
          try {
            harness.manager.setFocus("S24");
          } catch (error: unknown) {
            nestedFailures.push(error);
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    harness.manager.update(reentrantClock);
    expect(nestedFailures).toHaveLength(1);
    expect(nestedFailures[0]).toMatchObject({
      message: expect.stringMatching(/operation-clock capture/),
    });
    expect(harness.manager.snapshot().focusChunkId).toBe("S08");
    const before = harness.manager.snapshot();

    let getterCalls = 0;
    const accessorClock = { ...clock(2, 142) } as Record<string, unknown>;
    Object.defineProperty(accessorClock, "storyTime", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 142;
      },
    });
    expect(() => harness.manager.update(
      accessorClock as unknown as RenderOperationClock,
    )).toThrow(/data property/);
    expect(getterCalls).toBe(0);
    expect(harness.manager.snapshot()).toEqual(before);

    harness.manager.update(clock(2, 0));
    expect(harness.manager.snapshot().focusChunkId).toBe("S08");
    await disposeCleanHarness(harness);
  });

  it("captures telemetry without getters and blocks diagnostic callback mutation", async () => {
    const managerRef: { current: ChunkManager | null } = { current: null };
    const nestedFailures: unknown[] = [];
    const telemetry: GfxTelemetrySink = {
      recordFrame(): void {},
      recordOperation(): void {
        try {
          managerRef.current?.setFocus("S24");
        } catch (error: unknown) {
          nestedFailures.push(error);
        }
      },
    };
    const harness = createHarness({ telemetry });
    const manager = harness.manager;
    managerRef.current = manager;
    await manager.initialize();
    manager.setFocus("S08");
    await driveDesiredToTerminal(harness);
    expect(nestedFailures.length).toBeGreaterThan(0);
    expect(nestedFailures.every((error) => (
      error instanceof Error && /telemetry callback/.test(error.message)
    ))).toBe(true);
    expect(manager.snapshot().focusChunkId).toBe("S08");

    let getterCalls = 0;
    const hostileTelemetry = Object.defineProperty({ recordFrame(): void {} }, "recordOperation", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return () => undefined;
      },
    });
    const base = createHarness();
    expect(() => new ChunkManager({
      plan: WORLD_PLAN,
      worker: base.worker,
      uploads: base.uploads,
      uploader: base.uploader,
      resources: base.resources,
      telemetry: hostileTelemetry as unknown as GfxTelemetrySink,
    })).toThrow(/data method/);
    expect(getterCalls).toBe(0);
    await disposeCleanHarness(harness);
    await disposeCleanHarness(base);
  });

  it.each([
    { label: "adopt-only", missing: "releaseOwner" as const },
    { label: "release-only", missing: "adopt" as const },
  ])("rejects an independently optional $label resource registry", ({ missing }) => {
    const time = { value: 0 };
    const trace: string[] = [];
    const resources = new TrackedResources({ trace });
    Object.defineProperty(resources, missing, {
      configurable: false,
      enumerable: true,
      value: undefined,
    });
    expect(() => new ChunkManager({
      plan: WORLD_PLAN,
      worker: new ControlledWorker(),
      uploads: new RejectingUploadQueue(),
      uploader: new TrackedUploader({ time, trace }),
      resources,
      generationConcurrency: 1,
    })).toThrow(/adopt and releaseOwner must be provided together/);
    expect(resources.adoptCalls).toEqual([]);
    expect(resources.releaseCalls).toEqual([]);
  });

  it("uses the captured resource-method pair for stable adoption rollback", async () => {
    const harness = createHarness();
    Object.defineProperties(harness.resources, {
      adopt: { configurable: false, enumerable: true, value: undefined },
      releaseOwner: { configurable: false, enumerable: true, value: undefined },
    });
    await harness.manager.initialize();
    harness.manager.setFocus("S08");
    await driveDesiredToTerminal(harness);
    expect(harness.resources.adoptCalls).toHaveLength(4);

    harness.manager.setFocus("S09");
    await driveDesiredToTerminal(harness);
    expect(harness.resources.releaseCalls.length).toBeGreaterThan(0);
    await disposeCleanHarness(harness);
    expect(harness.resources.owners.size).toBe(0);
  });

  it("holds S07-S10 for S08, freezes behind, and retires before admitting a fifth lease", async () => {
    const harness = createHarness();
    await harness.manager.initialize();
    harness.manager.setFocus("S08");
    let snapshot = await driveDesiredToTerminal(harness);

    expect(snapshot.desiredChunkIds).toEqual(["S07", "S08", "S09", "S10"]);
    expect(snapshot.activeChunkIds).toEqual(["S07", "S08", "S09", "S10"]);
    expect(snapshot.gpuOwnedCount).toBe(4);
    expect(chunk(snapshot, "S07")).toMatchObject({
      role: "behind",
      updateMode: "frozen",
      state: "active",
    });
    expect(chunk(snapshot, "S08")).toMatchObject({ role: "current", updateMode: "live" });

    harness.manager.setFocus("S09");
    snapshot = await driveDesiredToTerminal(harness);
    expect(snapshot.desiredChunkIds).toEqual(["S08", "S09", "S10", "S11"]);
    expect(snapshot.activeChunkIds).toEqual(["S08", "S09", "S10", "S11"]);
    expect(snapshot.gpuOwnedCount).toBe(4);

    const retiredOwner = harness.uploader.createdOwners.find((ownerId) => ownerId.includes("s07"))!;
    const admittedOwner = harness.uploader.createdOwners.find((ownerId) => ownerId.includes("s11"))!;
    const releaseIndex = harness.trace.indexOf(`release:${retiredOwner}`);
    const disposeIndex = harness.trace.indexOf(`dispose:${retiredOwner}`);
    const fifthJobIndex = harness.trace.indexOf(`job:${admittedOwner}`);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(disposeIndex).toBeGreaterThan(releaseIndex);
    expect(fifthJobIndex).toBeGreaterThan(disposeIndex);

    await disposeCleanHarness(harness);
    expect(harness.resources.owners.size).toBe(0);
  });

  it("ignores stale shuffled replies and turns a null-token worker failure into terminal placeholders", async () => {
    const harness = createHarness();
    await harness.manager.initialize();
    harness.manager.setFocus("S01");
    await turn(harness, false);
    expect(harness.worker.requested.map((token) => token.chunkId)).toEqual(["S01", "S02"]);

    harness.manager.setFocus("S24");
    await turn(harness, false);
    expect(harness.worker.cancelled.map((token) => token.chunkId)).toEqual(expect.arrayContaining(["S01", "S02"]));
    harness.worker.injectNullTokenFailure();
    harness.worker.failRequestedChunk("S24");
    harness.worker.completeAllShuffled();

    const snapshot = await driveDesiredToTerminal(harness);
    expect(chunk(snapshot, "S24")).toMatchObject({
      state: "failed",
      placeholder: true,
      issue: { code: "WORKER_NOT_READY" },
    });
    expect(chunk(snapshot, "S23")).toMatchObject({
      state: "failed",
      placeholder: true,
      issue: { code: "WORKER_NOT_READY" },
    });
    expect(snapshot.placeholderChunkIds).toEqual(["S23", "S24"]);
    expect(snapshot.chunks.some((entry) =>
      snapshot.desiredChunkIds.includes(entry.chunkId)
      && ["queued", "generating", "generated", "uploading", "retiring"].includes(entry.state)
    )).toBe(false);
    expect(snapshot.events.some((event) => event.name === "stale-reply")).toBe(true);
    expect(snapshot.events.some((event) =>
      event.chunkId === null
      && event.name === "WORKER_NOT_READY"
      && event.value === "Controlled global worker failure."
    )).toBe(true);

    await disposeCleanHarness(harness);
  });

  it("cancels a captured upload job when queue admission throws opaquely", async () => {
    const time = { value: 0 };
    const trace: string[] = [];
    const worker = new ControlledWorker();
    const uploads = new RejectingUploadQueue();
    const resources = new TrackedResources({ trace });
    const uploader = new TrackedUploader({ time, trace });
    const manager = new ChunkManager({
      plan: WORLD_PLAN,
      worker,
      uploads,
      uploader,
      resources,
      generationConcurrency: 1,
    });
    await manager.initialize();
    manager.setFocus("S08");
    manager.update(clock(1));
    const token = worker.completeNext();
    manager.update(clock(2));
    await drainMicrotasks();

    const ownerId = chunkOwnerId(token);
    expect(chunk(manager.snapshot(), "S08")).toMatchObject({
      state: "failed",
      placeholder: true,
      issue: { code: "UPLOAD_FAILED" },
    });
    expect(uploader.cancelCalls.filter((owner) => owner === ownerId)).toHaveLength(1);
    expect(uploads.pendingCount()).toBe(0);

    await manager.dispose();
  });

  it.each([
    { label: "null", value: null },
    { label: "opaque object", value: Object.freeze({ reason: "opaque" }) },
  ])("fails closed and cleans partial ownership when adoption rejects with $label", async ({ value }) => {
    const harness = createHarness({ adoptRejection: { value } });
    await harness.manager.initialize();
    harness.manager.setFocus("S08");
    const snapshot = await driveDesiredToTerminal(harness);

    expect(chunk(snapshot, "S08")).toMatchObject({
      state: "failed",
      placeholder: true,
      issue: { code: "UPLOAD_FAILED", detail: "Resource adoption failed." },
    });
    expect(harness.resources.owners.size).toBe(0);
    expect(harness.uploader.disposeCalls.length).toBeGreaterThan(0);

    await disposeCleanHarness(harness);
  });

  it("terminates a retiring chunk after deferred adoption and requeues it on rapid return", async () => {
    const adoptionGate = deferredVoid();
    const harness = createHarness({ adoptGate: adoptionGate.promise });
    await harness.manager.initialize();
    harness.manager.setFocus("S08");

    let snapshot = harness.manager.snapshot();
    for (let iteration = 0; iteration < 8; iteration += 1) {
      snapshot = await turn(harness);
      if (chunk(snapshot, "S08").state === "uploading" && harness.resources.adoptCalls.length > 0) break;
    }
    const first = chunk(snapshot, "S08");
    expect(first).toMatchObject({ state: "uploading", role: "current", gpuSlotOwned: true });
    const firstRequestId = first.requestId;
    const firstOwner = harness.uploader.createdOwners.find((ownerId) => ownerId.includes("s08"));
    if (!firstOwner || firstRequestId === null) throw new Error("Expected the first S08 upload identity.");
    expect(harness.resources.adoptCalls).toContain(firstOwner);

    harness.manager.setFocus("S24");
    snapshot = await turn(harness, false);
    expect(chunk(snapshot, "S08")).toMatchObject({ state: "retiring", role: null });
    harness.manager.setFocus("S08");
    snapshot = await turn(harness, false);
    expect(chunk(snapshot, "S08")).toMatchObject({ state: "retiring", requestId: firstRequestId });

    adoptionGate.resolve();
    await drainMicrotasks();
    snapshot = await turn(harness, false);
    expect(chunk(snapshot, "S08")).toMatchObject({
      state: "disposed",
      role: "current",
      gpuSlotOwned: false,
      placeholder: false,
    });
    expect(harness.trace.indexOf(`release:${firstOwner}`)).toBeGreaterThanOrEqual(0);
    expect(harness.trace.indexOf(`dispose:${firstOwner}`)).toBeGreaterThan(
      harness.trace.indexOf(`release:${firstOwner}`),
    );
    expect(harness.uploader.activeCalls).not.toContain(`${firstOwner}:true`);
    expect(snapshot.gpuOwnedCount).toBeLessThanOrEqual(4);

    snapshot = await turn(harness, false);
    expect(["queued", "generating"]).toContain(chunk(snapshot, "S08").state);
    expect(chunk(snapshot, "S08").role).toBe("current");
    expect(chunk(snapshot, "S08").requestId).not.toBe(firstRequestId);
    snapshot = await driveDesiredToTerminal(harness);
    expect(chunk(snapshot, "S08").state).toBe("active");
    expect(snapshot.gpuOwnedCount).toBeLessThanOrEqual(4);

    await disposeCleanHarness(harness);
  });

  it("never activates deferred adoption delivered after focus moved outside the window", async () => {
    const adoptionGate = deferredVoid();
    const harness = createHarness({ adoptGate: adoptionGate.promise });
    await harness.manager.initialize();
    harness.manager.setFocus("S08");

    let snapshot = harness.manager.snapshot();
    for (let iteration = 0; iteration < 8; iteration += 1) {
      snapshot = await turn(harness);
      const owner = harness.uploader.createdOwners.find((ownerId) => ownerId.includes("s08"));
      if (owner && harness.resources.adoptCalls.includes(owner)) break;
    }
    const first = chunk(snapshot, "S08");
    const firstOwner = harness.uploader.createdOwners.find((ownerId) => ownerId.includes("s08"));
    if (!firstOwner || first.requestId === null) throw new Error("Expected pending S08 adoption.");
    const firstRequestId = first.requestId;
    expect(first).toMatchObject({ state: "uploading", role: "current", gpuSlotOwned: true });
    expect(harness.resources.adoptCalls).toContain(firstOwner);

    harness.manager.setFocus("S24");
    adoptionGate.resolve();
    await drainMicrotasks();
    snapshot = await turn(harness, false);

    expect(chunk(snapshot, "S08")).toMatchObject({
      state: "disposed",
      role: null,
      gpuSlotOwned: false,
      placeholder: false,
    });
    expect(harness.uploader.activeCalls).not.toContain(`${firstOwner}:true`);
    expect(harness.resources.releaseCalls.filter((ownerId) => ownerId === firstOwner)).toHaveLength(1);
    expect(harness.uploader.disposeCalls.filter((ownerId) => ownerId === firstOwner)).toHaveLength(1);
    expect(snapshot.gpuOwnedCount).toBeLessThanOrEqual(4);

    harness.manager.setFocus("S08");
    snapshot = await turn(harness, false);
    expect(["queued", "generating"]).toContain(chunk(snapshot, "S08").state);
    expect(chunk(snapshot, "S08").role).toBe("current");
    expect(chunk(snapshot, "S08").requestId).not.toBe(firstRequestId);
    snapshot = await driveDesiredToTerminal(harness);
    expect(chunk(snapshot, "S08").state).toBe("active");
    expect(snapshot.gpuOwnedCount).toBeLessThanOrEqual(4);

    await disposeCleanHarness(harness);
  });

  it("records both release and lease-dispose failures and exposes terminal disposal failure", async () => {
    const harness = createHarness({
      releaseRejection: { value: null },
      disposeRejection: { value: Object.freeze({ reason: "gpu fault" }) },
    });
    await harness.manager.initialize();
    harness.manager.setFocus("S08");
    await driveDesiredToTerminal(harness);

    harness.manager.setFocus("S09");
    await turn(harness);
    const snapshot = await turn(harness);
    expect(chunk(snapshot, "S07")).toMatchObject({
      state: "failed",
      issue: { code: "RESOURCE_RELEASE_FAILED" },
    });
    const cleanupEvents = snapshot.events.filter((event) => event.name === "cleanup-failed");
    expect(cleanupEvents.map((event) => event.value)).toEqual(expect.arrayContaining([
      "Logical chunk resource release failed.",
      "Chunk GPU lease disposal failed.",
    ]));
    expect(harness.resources.releaseCalls.length).toBeGreaterThan(0);
    expect(harness.uploader.disposeCalls.length).toBeGreaterThan(0);

    const firstDispose = harness.manager.dispose();
    const secondDispose = harness.manager.dispose();
    expect(secondDispose).toBe(firstDispose);
    await expect(firstDispose).rejects.toThrow(/bounded cleanup channel/);
    expect(harness.manager.snapshot()).toMatchObject({ disposed: true, gpuOwnedCount: 4 });
    expect(harness.resources.owners.size).toBe(4);
    await harness.uploads.dispose();
  });

  it("returns stable initialize/dispose promises under concurrent initialize-dispose", async () => {
    const gate = deferredVoid();
    const worker = new ControlledWorker(gate.promise);
    const harness = createHarness({ worker });
    const firstInitialize = harness.manager.initialize();
    const secondInitialize = harness.manager.initialize();
    expect(secondInitialize).toBe(firstInitialize);

    const firstDispose = harness.manager.dispose();
    const secondDispose = harness.manager.dispose();
    expect(secondDispose).toBe(firstDispose);
    await firstDispose;
    gate.resolve();
    await expect(firstInitialize).rejects.toThrow(/disposed during initialization/);
    expect(worker.initializeCalls).toBe(1);
    expect(worker.disposeCalls).toBe(1);
    expect(harness.manager.snapshot()).toMatchObject({ initialized: false, disposed: true });
    await harness.uploads.dispose();
  });

  it("switches prebuilt lease quality without regenerating payloads and activates only after adoption", async () => {
    const harness = createHarness();
    const low = Object.freeze({
      tier: "low" as const,
      pixelRatio: 0.75,
      uploadBudgetMs: 2,
      features: Object.freeze({ volumetrics: false }),
    });
    harness.manager.quality(low);
    await harness.manager.initialize();
    harness.manager.setFocus("S08");
    await driveDesiredToTerminal(harness);

    const owners = [...harness.uploader.createdOwners];
    const digests = [...harness.uploader.payloadDigests];
    expect(harness.uploader.qualityCalls).toEqual(owners.map((owner) => `${owner}:low`));
    for (const owner of owners) {
      expect(harness.uploader.activeCalls.filter((entry) => entry === `${owner}:false`)).toHaveLength(1);
      expect(harness.uploader.activeCalls.filter((entry) => entry === `${owner}:true`)).toHaveLength(1);
      expect(harness.trace.indexOf(`active:${owner}:false`)).toBeLessThan(harness.trace.indexOf(`adopt:${owner}`));
      expect(harness.trace.indexOf(`adopt:${owner}`)).toBeLessThan(harness.trace.indexOf(`active:${owner}:true`));
    }

    harness.manager.quality(PROFILE);
    expect(harness.uploader.qualityCalls).toHaveLength(owners.length * 2);
    expect(harness.uploader.qualityCalls).toEqual(expect.arrayContaining([
      ...owners.map((owner) => `${owner}:low`),
      ...owners.map((owner) => `${owner}:high`),
    ]));
    expect(harness.uploader.createdOwners).toEqual(owners);
    expect(harness.uploader.payloadDigests).toEqual(digests);
    await disposeCleanHarness(harness);
  });

  it("blocks synchronous uploader reentry and creates one job for each generation token", async () => {
    const harness = createHarness();
    await harness.manager.initialize();
    harness.uploader.onCreate = () => harness.manager.update(clock(9_999));
    harness.manager.setFocus("S08");
    await driveDesiredToTerminal(harness);
    expect(new Set(harness.uploader.createdOwners).size).toBe(harness.uploader.createdOwners.length);
    expect(harness.uploader.createdOwners).toHaveLength(4);
    expect(harness.manager.snapshot().gpuOwnedCount).toBe(4);
    await disposeCleanHarness(harness);
  });

  it("rolls an accepted malformed ticket back through only the canonical owner", async () => {
    const time = { value: 0 };
    const trace: string[] = [];
    const worker = new ControlledWorker();
    const uploads = new MismatchedTicketQueue();
    const resources = new TrackedResources({ trace });
    const uploader = new TrackedUploader({ time, trace });
    const manager = new ChunkManager({
      plan: WORLD_PLAN,
      worker,
      uploads,
      uploader,
      resources,
      generationConcurrency: 1,
    });
    await manager.initialize();
    manager.setFocus("S08");
    manager.update(clock(1));
    const generation = worker.completeNext();
    manager.update(clock(2));
    await drainMicrotasks();
    expect(uploads.cancelledOwners).toEqual([chunkOwnerId(generation)]);
    expect(uploads.cancelledOwners).not.toContain("chunk-unrelated-live-owner");
    expect(uploader.cancelCalls).toHaveLength(0);
    expect(chunk(manager.snapshot(), "S08")).toMatchObject({ state: "failed", placeholder: true });
    await manager.dispose();
  });

  it("leaves zero worker, upload, logical-resource, and GPU ownership after ten cycles", { timeout: 20_000 }, async () => {
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const harness = createHarness();
      await harness.manager.initialize();
      harness.manager.setFocus(STORY_CHUNK_IDS[4 + cycle]!);
      const active = await driveDesiredToTerminal(harness);
      expect(active.gpuOwnedCount).toBeGreaterThan(0);

      const firstDispose = harness.manager.dispose();
      expect(harness.manager.dispose()).toBe(firstDispose);
      await firstDispose;
      expect(harness.manager.snapshot()).toMatchObject({
        initialized: false,
        disposed: true,
        gpuOwnedCount: 0,
        workerInboxCount: 0,
      });
      expect(harness.worker.requested).toHaveLength(0);
      expect(harness.worker.pendingReplyCount()).toBe(0);
      expect(harness.worker.disposeCalls).toBe(1);
      expect(harness.uploads.pendingCount()).toBe(0);
      expect(harness.resources.owners.size).toBe(0);
      expect(harness.uploader.disposeCalls).toHaveLength(harness.uploader.createdOwners.length);
      await harness.uploads.dispose();
    }
  });
});
