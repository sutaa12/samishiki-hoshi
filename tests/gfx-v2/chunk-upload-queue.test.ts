import { describe, expect, it, vi } from "vitest";
import type {
  RenderQualityProfile,
  RenderOperationClock,
  RenderServiceInitializationContext,
} from "../../src/gfx/v2/contracts";
import {
  CHUNK_UPLOAD_HARD_CAP_MS,
  CHUNK_UPLOAD_WARNING_MS,
  type ChunkGpuLease,
  type ChunkUploadJob,
} from "../../src/gfx/v2/chunks/contracts";
import { chunkOwnerId } from "../../src/gfx/v2/chunks/chunk-manager";
import { IncrementalChunkUploadQueue } from "../../src/gfx/v2/chunks/upload-queue";
import { makeChunkGenerationToken } from "../../src/gfx/v2/chunks/worker-client";
import type { GfxOperationalEventInput } from "../../src/gfx/v2/telemetry";

const PLAN_DIGEST = "world-plan-v1:75d93cbb8e0580cd";
const PROFILE: Readonly<RenderQualityProfile> = Object.freeze({
  tier: "high",
  pixelRatio: 1,
  uploadBudgetMs: 4,
  features: Object.freeze({}),
});
const CLOCK: Readonly<RenderOperationClock> = Object.freeze({
  frame: 1,
  nowMs: 16,
  deltaSeconds: 1 / 60,
  elapsedSeconds: 1 / 60,
  storyTime: 73.25,
});
const CONTEXT = Object.freeze({
  backend: {},
  observer: {},
  viewport: Object.freeze({ width: 1280, height: 720, pixelRatio: 1 }),
}) as RenderServiceInitializationContext;

function token(requestId: number) {
  return makeChunkGenerationToken({
    planDigest: PLAN_DIGEST,
    chunkId: "S08",
    epoch: 1,
    requestId,
  });
}

function leaseFor(ownerId: string, dispose: () => void | Promise<void> = vi.fn()): ChunkGpuLease {
  return {
    ownerId,
    ownership: {
      ownerId,
      geometries: 1,
      textures: 0,
      renderTargets: 0,
      nodes: 1,
      objects: 1,
      bytes: 8,
    },
    dispose,
  };
}

function job(options: {
  readonly requestId: number;
  readonly now: { value: number };
  readonly durations?: readonly number[];
  readonly bytes?: number;
  readonly maximumSliceMs?: number;
  readonly cancel?: () => void | Promise<void>;
  readonly dispose?: () => void | Promise<void>;
}): ChunkUploadJob {
  const generationToken = token(options.requestId);
  const ownerId = chunkOwnerId(generationToken);
  const totalBytes = options.bytes ?? 8;
  const durations = [...(options.durations ?? [0.4, 0.4])];
  let uploaded = 0;
  return {
    id: `upload-${options.requestId}`,
    ownerId,
    token: generationToken,
    byteLength: totalBytes,
    maximumSliceMs: options.maximumSliceMs ?? 1,
    runSlice() {
      options.now.value += durations.shift() ?? 0.1;
      const bytes = Math.min(4, totalBytes - uploaded);
      uploaded += bytes;
      return uploaded === totalBytes
        ? { kind: "complete", uploadedBytes: bytes, lease: leaseFor(ownerId, options.dispose) }
        : { kind: "pending", uploadedBytes: bytes };
    },
    cancel: options.cancel ?? (() => undefined),
  };
}

describe("GFX-004 incremental upload queue", () => {
  it("reports each executed upload slice against its frame without trusting the observer", async () => {
    const time = { value: 0 };
    const events: unknown[] = [];
    const queue = new IncrementalChunkUploadQueue(
      () => time.value,
      (event) => events.push(event),
    );
    queue.initialize(CONTEXT);
    const ticket = queue.enqueue(job({
      requestId: 0,
      now: time,
      durations: [0.4],
      bytes: 4,
    }));

    await queue.flush(CLOCK, PROFILE);
    expect(await ticket.result).toMatchObject({ kind: "complete" });
    expect(events).toEqual([expect.objectContaining({
      kind: "upload",
      name: "chunk-s08-0-upload-slice",
      startedAtMs: 0,
      durationMs: 0.4,
      frameId: 1,
      storyTime: 73.25,
      success: true,
      affectsStoryTime: true,
    })]);
    expect(Object.isFrozen(events[0])).toBe(true);

    const hostileTime = { value: 0 };
    const hostileRef: { current: IncrementalChunkUploadQueue | null } = { current: null };
    let nestedDispose: Promise<void> | null = null;
    const hostile = new IncrementalChunkUploadQueue(
      () => hostileTime.value,
      () => {
        nestedDispose = hostileRef.current?.dispose() ?? null;
        throw new Error("telemetry observer failed");
      },
    );
    hostileRef.current = hostile;
    hostile.initialize(CONTEXT);
    const hostileTicket = hostile.enqueue(job({
      requestId: 99,
      now: hostileTime,
      durations: [0.4],
      bytes: 4,
    }));
    await expect(hostile.flush(CLOCK, PROFILE)).resolves.toBeUndefined();
    expect(await hostileTicket.result).toMatchObject({ kind: "complete" });
    await nestedDispose;
    expect(hostile.snapshot().disposed).toBe(false);
    await hostile.dispose();
  });

  it("keeps upload correlation on canonical story time across seek, restart, and pause", async () => {
    const time = { value: 0 };
    const events: Readonly<GfxOperationalEventInput>[] = [];
    const queue = new IncrementalChunkUploadQueue(
      () => time.value,
      (event) => events.push(event),
    );
    queue.initialize(CONTEXT);
    const low = Object.freeze({
      tier: "low" as const,
      pixelRatio: 0.75,
      uploadBudgetMs: 2,
      features: Object.freeze({}),
    });
    const frames = Object.freeze([
      Object.freeze({ ...CLOCK, frame: 10, nowMs: 4_000, elapsedSeconds: 4, storyTime: 73.25 }),
      Object.freeze({ ...CLOCK, frame: 11, nowMs: 4_016, elapsedSeconds: 4.016, storyTime: 142.5 }),
      Object.freeze({ ...CLOCK, frame: 12, nowMs: 4_032, elapsedSeconds: 4.032, storyTime: 0 }),
      Object.freeze({ ...CLOCK, frame: 13, nowMs: 5_032, elapsedSeconds: 5.032, storyTime: 0 }),
    ]) satisfies readonly Readonly<RenderOperationClock>[];

    for (let index = 0; index < frames.length; index += 1) {
      const ticket = queue.enqueue(job({
        requestId: 60 + index,
        now: time,
        durations: [0.1],
        bytes: 4,
      }));
      await queue.flush(frames[index]!, index % 2 === 0 ? PROFILE : low);
      expect(await ticket.result).toMatchObject({ kind: "complete" });
    }

    expect(events.map((event) => ({
      frameId: event.frameId,
      storyTime: event.storyTime,
    }))).toEqual([
      { frameId: 10, storyTime: 73.25 },
      { frameId: 11, storyTime: 142.5 },
      { frameId: 12, storyTime: 0 },
      { frameId: 13, storyTime: 0 },
    ]);
    expect(queue.snapshot()).toMatchObject({ completed: 4, pending: 0, failed: 0 });
    await queue.dispose();
  });

  it("uses bounded incremental FIFO slices and completes without ownership retention", async () => {
    const time = { value: 0 };
    const queue = new IncrementalChunkUploadQueue(() => time.value);
    queue.initialize(CONTEXT);
    queue.quality(PROFILE);
    const first = queue.enqueue(job({ requestId: 1, now: time }));
    const second = queue.enqueue(job({ requestId: 2, now: time }));

    await queue.flush(CLOCK, PROFILE);
    expect(queue.pendingCount()).toBeGreaterThan(0);
    await queue.flush({ ...CLOCK, frame: 2 }, PROFILE);
    const results = await Promise.all([first.result, second.result]);
    expect(results.map((entry) => entry.kind)).toEqual(["complete", "complete"]);
    expect(queue.snapshot()).toMatchObject({ pending: 0, completed: 2, failed: 0 });
    expect(Object.isFrozen(queue.snapshot().events)).toBe(true);
  });

  it("stops scheduling near one millisecond and records two/four millisecond thresholds", async () => {
    const time = { value: 0 };
    const queue = new IncrementalChunkUploadQueue(() => time.value);
    queue.initialize(CONTEXT);
    const tickets = [1, 2, 3].map((requestId) => queue.enqueue(job({
      requestId,
      now: time,
      durations: [0.6],
      bytes: 4,
    })));
    await queue.flush(CLOCK, PROFILE);
    expect(queue.pendingCount()).toBe(1);
    await queue.flush({ ...CLOCK, frame: 2 }, PROFILE);
    await Promise.all(tickets.map((entry) => entry.result));

    const warningTime = { value: 0 };
    const warningQueue = new IncrementalChunkUploadQueue(() => warningTime.value);
    warningQueue.initialize(CONTEXT);
    const warning = warningQueue.enqueue(job({ requestId: 10, now: warningTime, durations: [CHUNK_UPLOAD_WARNING_MS + 0.1], bytes: 4 }));
    await warningQueue.flush(CLOCK, PROFILE);
    expect(await warning.result).toMatchObject({ kind: "failed", issue: { code: "UPLOAD_HARD_CAP_EXCEEDED" } });
    expect(warningQueue.snapshot().events.some((entry) => entry.name === "slice-warning")).toBe(true);

    const hardTime = { value: 0 };
    const dispose = vi.fn();
    const hardQueue = new IncrementalChunkUploadQueue(() => hardTime.value);
    hardQueue.initialize(CONTEXT);
    const hard = hardQueue.enqueue(job({ requestId: 11, now: hardTime, durations: [CHUNK_UPLOAD_HARD_CAP_MS + 0.1], bytes: 4, dispose }));
    await hardQueue.flush(CLOCK, PROFILE);
    expect(await hard.result).toMatchObject({ kind: "failed", issue: { code: "UPLOAD_HARD_CAP_EXCEEDED" } });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(hardQueue.pendingCount()).toBe(0);
  });

  it("fails below the global warning threshold when a job exceeds its declared slice bound", async () => {
    const time = { value: 0 };
    const cancel = vi.fn();
    const disposeLease = vi.fn();
    const queue = new IncrementalChunkUploadQueue(() => time.value);
    queue.initialize(CONTEXT);
    const ticket = queue.enqueue(job({
      requestId: 12,
      now: time,
      durations: [1.9],
      bytes: 4,
      maximumSliceMs: 0.1,
      cancel,
      dispose: disposeLease,
    }));

    await expect(queue.flush(CLOCK, PROFILE)).resolves.toBeUndefined();
    expect(await ticket.result).toMatchObject({
      kind: "failed",
      issue: {
        code: "UPLOAD_HARD_CAP_EXCEEDED",
        detail: "Chunk upload slice took 1.9 ms, exceeding its declared 0.1 ms upper bound.",
      },
    });
    expect(queue.snapshot().events.some((entry) => entry.name === "slice-warning")).toBe(false);
    expect(disposeLease).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    const disposal = queue.dispose();
    expect(queue.dispose()).toBe(disposal);
    await expect(disposal).resolves.toBeUndefined();
    expect(disposeLease).toHaveBeenCalledTimes(1);
  });

  it("releases the reentry latch when the initial clock sample throws", async () => {
    const time = { value: 0 };
    let calls = 0;
    const queue = new IncrementalChunkUploadQueue(() => {
      calls += 1;
      if (calls === 1) throw new Error("clock fault");
      return time.value;
    });
    queue.initialize(CONTEXT);
    const ticket = queue.enqueue(job({ requestId: 20, now: time, bytes: 4 }));
    await expect(queue.flush(CLOCK, PROFILE)).rejects.toThrow(/clock fault/);
    await expect(queue.flush(CLOCK, PROFILE)).resolves.toBeUndefined();
    expect((await ticket.result).kind).toBe("complete");
  });

  it("captures caller clock and quality data once without ordinary property reads", async () => {
    const time = { value: 0 };
    let ordinaryReads = 0;
    let clockDescriptors = 0;
    let profileDescriptors = 0;
    const ownedClock = new Proxy({ ...CLOCK }, {
      get() {
        ordinaryReads += 1;
        throw new Error("ordinary clock reads are forbidden");
      },
      getOwnPropertyDescriptor(target, key) {
        clockDescriptors += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const ownedProfile = new Proxy({ ...PROFILE }, {
      get() {
        ordinaryReads += 1;
        throw new Error("ordinary profile reads are forbidden");
      },
      getOwnPropertyDescriptor(target, key) {
        profileDescriptors += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const queue = new IncrementalChunkUploadQueue(() => time.value);
    queue.initialize(CONTEXT);
    const ticket = queue.enqueue(job({ requestId: 22, now: time, bytes: 4 }));

    await expect(queue.flush(ownedClock, ownedProfile)).resolves.toBeUndefined();
    expect((await ticket.result).kind).toBe("complete");
    expect(ordinaryReads).toBe(0);
    expect(clockDescriptors).toBe(5);
    expect(profileDescriptors).toBe(4);
  });

  it("rejects accessor story time and blocks ownership mutation during clock capture", async () => {
    const time = { value: 0 };
    const queue = new IncrementalChunkUploadQueue(() => time.value);
    queue.initialize(CONTEXT);
    const first = queue.enqueue(job({ requestId: 70, now: time, bytes: 4 }));
    const nestedFailures: unknown[] = [];
    let attemptedReentry = false;
    const reentrantClock = new Proxy({ ...CLOCK }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "storyTime" && !attemptedReentry) {
          attemptedReentry = true;
          try {
            queue.enqueue(job({ requestId: 71, now: time, bytes: 4 }));
          } catch (error: unknown) {
            nestedFailures.push(error);
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    await expect(queue.flush(reentrantClock, PROFILE)).resolves.toBeUndefined();
    expect(await first.result).toMatchObject({ kind: "complete" });
    expect(nestedFailures).toHaveLength(1);
    expect(nestedFailures[0]).toMatchObject({
      message: expect.stringMatching(/operation-clock capture/),
    });
    expect(queue.snapshot()).toMatchObject({ completed: 1, pending: 0 });

    const second = queue.enqueue(job({ requestId: 72, now: time, bytes: 4 }));
    let getterCalls = 0;
    const accessorClock = { ...CLOCK } as Record<string, unknown>;
    Object.defineProperty(accessorClock, "storyTime", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 99;
      },
    });
    await expect(queue.flush(
      accessorClock as unknown as RenderOperationClock,
      PROFILE,
    )).rejects.toThrow(/data property/);
    expect(getterCalls).toBe(0);
    expect(queue.snapshot()).toMatchObject({ completed: 1, pending: 1 });
    await expect(queue.flush({ ...CLOCK, frame: 2 }, PROFILE)).resolves.toBeUndefined();
    expect(await second.result).toMatchObject({ kind: "complete" });
    expect(queue.snapshot()).toMatchObject({ completed: 2, pending: 0, orphanJobCount: 0 });
    await queue.dispose();
  });

  it("disposes a completed lease and settles the ticket when the post-run clock sample fails", async () => {
    const hostile = new Proxy({}, {
      get() {
        throw new Error("must not inspect hostile clock error");
      },
      getPrototypeOf() {
        throw new Error("must not inspect hostile clock prototype");
      },
    });
    let calls = 0;
    let time = 0;
    const dispose = vi.fn();
    const queue = new IncrementalChunkUploadQueue(() => {
      calls += 1;
      if (calls === 4) throw hostile;
      return time;
    });
    queue.initialize(CONTEXT);
    const generationToken = token(21);
    const ownerId = chunkOwnerId(generationToken);
    const ticket = queue.enqueue({
      id: "upload-21",
      ownerId,
      token: generationToken,
      byteLength: 4,
      maximumSliceMs: 1,
      runSlice() {
        time += 0.2;
        return { kind: "complete", uploadedBytes: 4, lease: leaseFor(ownerId, dispose) };
      },
      cancel() {},
    });
    await expect(queue.flush(CLOCK, PROFILE)).resolves.toBeUndefined();
    expect(await ticket.result).toMatchObject({ kind: "failed", issue: { detail: "Injected upload clock failed after a slice." } });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount()).toBe(0);
    await expect(queue.flush(CLOCK, PROFILE)).resolves.toBeUndefined();
  });

  it("rejects accessor jobs without invoking them and contains hostile run/cancel failures", async () => {
    const time = { value: 0 };
    const queue = new IncrementalChunkUploadQueue(() => time.value);
    queue.initialize(CONTEXT);
    let getterCalls = 0;
    const accessor = { ...job({ requestId: 30, now: time }) } as Record<string, unknown>;
    Object.defineProperty(accessor, "runSlice", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return () => ({ kind: "pending", uploadedBytes: 1 });
      },
    });
    expect(() => queue.enqueue(accessor as unknown as ChunkUploadJob)).toThrow(/data property/);
    expect(getterCalls).toBe(0);

    const hostile = new Proxy({}, {
      get() {
        throw new Error("secondary trap");
      },
      getPrototypeOf() {
        throw new Error("secondary prototype trap");
      },
    });
    const generationToken = token(31);
    const ownerId = chunkOwnerId(generationToken);
    const ticket = queue.enqueue({
      id: "upload-31",
      ownerId,
      token: generationToken,
      byteLength: 4,
      maximumSliceMs: 1,
      runSlice() {
        throw hostile;
      },
      cancel() {
        throw hostile;
      },
    });
    await queue.flush(CLOCK, PROFILE);
    expect(await ticket.result).toMatchObject({
      kind: "failed",
      issue: { code: "UPLOAD_FAILED", detail: "Chunk upload slice failed." },
    });
  });

  it("cancels queued ownership exactly once and leaves zero pending work on dispose", async () => {
    const time = { value: 0 };
    const cancel = vi.fn();
    const queue = new IncrementalChunkUploadQueue(() => time.value);
    queue.initialize(CONTEXT);
    const pending = queue.enqueue(job({ requestId: 40, now: time, cancel }));
    await queue.cancelOwner(pending.ownerId);
    expect(await pending.result).toMatchObject({ kind: "cancelled" });
    expect(cancel).toHaveBeenCalledTimes(1);

    const otherCancel = vi.fn();
    const other = queue.enqueue(job({ requestId: 41, now: time, cancel: otherCancel }));
    await queue.dispose();
    expect(await other.result).toMatchObject({ kind: "cancelled" });
    expect(otherCancel).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount()).toBe(0);
    await expect(queue.dispose()).resolves.toBeUndefined();
  });

  it("settles a failed frame without awaiting cleanup and drains one in-flight job obligation on dispose", async () => {
    const time = { value: 0 };
    let release!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { release = resolve; });
    const cancel = vi.fn(() => cleanupGate);
    const queue = new IncrementalChunkUploadQueue(() => time.value);
    queue.initialize(CONTEXT);
    const generationToken = token(50);
    const ownerId = chunkOwnerId(generationToken);
    const ticket = queue.enqueue({
      id: "upload-50",
      ownerId,
      token: generationToken,
      byteLength: 4,
      maximumSliceMs: 1,
      runSlice() {
        throw new Error("primary slice failure");
      },
      cancel,
    });

    await expect(queue.flush(CLOCK, PROFILE)).resolves.toBeUndefined();
    expect(await ticket.result).toMatchObject({ kind: "failed", issue: { detail: "Chunk upload slice failed." } });
    expect(queue.snapshot()).toMatchObject({ orphanJobCount: 1, cleanupFailureCount: 0 });
    const disposal = queue.dispose();
    let disposed = false;
    void disposal.then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    release();
    await expect(disposal).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(queue.snapshot().orphanJobCount).toBe(0);
  });

  it("reserves a failed job incarnation until a final retry and reports persistent cleanup", async () => {
    const time = { value: 0 };
    let cancelCalls = 0;
    const retryQueue = new IncrementalChunkUploadQueue(() => time.value);
    retryQueue.initialize(CONTEXT);
    const firstJob = job({
      requestId: 51,
      now: time,
      cancel: () => {
        cancelCalls += 1;
        if (cancelCalls === 1) throw new Error("first cleanup fails");
      },
    });
    const first = retryQueue.enqueue(firstJob);
    await expect(retryQueue.cancelOwner(first.ownerId)).rejects.toThrow(/retained a cleanup obligation/);
    expect(await first.result).toMatchObject({ kind: "cancelled" });
    expect(() => retryQueue.enqueue(firstJob)).toThrow(/Duplicate chunk upload job id/);
    await expect(retryQueue.dispose()).resolves.toBeUndefined();
    expect(cancelCalls).toBe(2);

    const persistentQueue = new IncrementalChunkUploadQueue(() => time.value);
    persistentQueue.initialize(CONTEXT);
    const persistent = persistentQueue.enqueue(job({
      requestId: 52,
      now: time,
      cancel: () => { throw new Error("persistent cleanup failure"); },
    }));
    await expect(persistentQueue.cancelOwner(persistent.ownerId)).rejects.toThrow(/retained a cleanup obligation/);
    const dispose = persistentQueue.dispose();
    expect(persistentQueue.dispose()).toBe(dispose);
    await expect(dispose).rejects.toThrow(/retained 1 job/);
    expect(persistentQueue.snapshot()).toMatchObject({ orphanJobCount: 1, cleanupFailureCount: 2 });
  });

  it("cleans a captured complete lease only, retries it on dispose, and never cancels the former job", async () => {
    let calls = 0;
    let clockCalls = 0;
    const cancel = vi.fn();
    const dispose = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error("lease cleanup needs retry");
    });
    const queue = new IncrementalChunkUploadQueue(() => {
      clockCalls += 1;
      if (clockCalls === 4) throw new Error("post-run clock failure");
      return 0;
    });
    queue.initialize(CONTEXT);
    const ticket = queue.enqueue(job({ requestId: 53, now: { value: 0 }, bytes: 4, cancel, dispose }));
    await expect(queue.flush(CLOCK, PROFILE)).resolves.toBeUndefined();
    expect(await ticket.result).toMatchObject({ kind: "failed" });
    expect(cancel).not.toHaveBeenCalled();
    expect(queue.snapshot()).toMatchObject({ orphanLeaseCount: 1, orphanJobCount: 0, cleanupFailureCount: 1 });
    await expect(queue.dispose()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("applies warning and hard-cap thresholds to aggregate frame work", async () => {
    const warningSamples = [0, 0, 1.8, 2.1, 2.1];
    const warningQueue = new IncrementalChunkUploadQueue(() => warningSamples.shift() ?? 2.1);
    warningQueue.initialize(CONTEXT);
    const warning = warningQueue.enqueue(job({ requestId: 54, now: { value: 0 }, bytes: 4 }));
    await warningQueue.flush(CLOCK, PROFILE);
    expect((await warning.result).kind).toBe("complete");
    expect(warningQueue.snapshot().events.some((event) => event.name === "slice-warning" && event.value === 2.1)).toBe(true);

    const time = { value: 0 };
    const hardQueue = new IncrementalChunkUploadQueue(() => time.value);
    hardQueue.initialize(CONTEXT);
    const first = hardQueue.enqueue(job({ requestId: 55, now: time, durations: [0.9], bytes: 4 }));
    const second = hardQueue.enqueue(job({ requestId: 56, now: time, durations: [3.9], bytes: 4 }));
    await hardQueue.flush(CLOCK, PROFILE);
    expect((await first.result).kind).toBe("complete");
    expect(await second.result).toMatchObject({ kind: "failed", issue: { code: "UPLOAD_HARD_CAP_EXCEEDED" } });
  });

  it.each(["cancel-owner", "dispose"] as const)(
    "does not run a slice after the slice-start clock reenters %s",
    async (mode) => {
      let clockCalls = 0;
      let ownerId = "";
      let reentrantOperation: Promise<void> | null = null;
      const runSlice = vi.fn();
      const cancel = vi.fn();
      const disposeLease = vi.fn();
      const queue: IncrementalChunkUploadQueue = new IncrementalChunkUploadQueue(() => {
        clockCalls += 1;
        if (clockCalls === 3) {
          reentrantOperation = mode === "cancel-owner"
            ? queue.cancelOwner(ownerId)
            : queue.dispose();
        }
        return 0;
      });
      queue.initialize(CONTEXT);
      const generationToken = token(mode === "cancel-owner" ? 60 : 61);
      ownerId = chunkOwnerId(generationToken);
      runSlice.mockReturnValue({
        kind: "complete",
        uploadedBytes: 4,
        lease: leaseFor(ownerId, disposeLease),
      });
      const ticket = queue.enqueue({
        id: `upload-${mode}`,
        ownerId,
        token: generationToken,
        byteLength: 4,
        maximumSliceMs: 1,
        runSlice,
        cancel,
      });

      await expect(queue.flush(CLOCK, PROFILE)).resolves.toBeUndefined();
      expect(await ticket.result).toMatchObject({ kind: "cancelled", ownerId });
      if (!reentrantOperation) throw new Error("Expected the clock to reenter queue ownership.");
      await expect(reentrantOperation).resolves.toBeUndefined();
      expect(runSlice).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(disposeLease).not.toHaveBeenCalled();
      expect(queue.snapshot()).toMatchObject({
        pending: 0,
        orphanJobCount: 0,
        orphanLeaseCount: 0,
        cleanupFailureCount: 0,
      });
      const disposal = queue.dispose();
      expect(queue.dispose()).toBe(disposal);
      await expect(disposal).resolves.toBeUndefined();
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it("serializes reentrant disposal after runSlice transfers ownership to its lease", async () => {
    let now = 0;
    const cancel = vi.fn();
    const disposeLease = vi.fn();
    const queue = new IncrementalChunkUploadQueue(() => now);
    queue.initialize(CONTEXT);
    const generationToken = token(57);
    const ownerId = chunkOwnerId(generationToken);
    let disposal: Promise<void> | null = null;
    const ticket = queue.enqueue({
      id: "upload-57",
      ownerId,
      token: generationToken,
      byteLength: 4,
      maximumSliceMs: 1,
      runSlice() {
        disposal = queue.dispose();
        now += 0.1;
        return { kind: "complete", uploadedBytes: 4, lease: leaseFor(ownerId, disposeLease) };
      },
      cancel,
    });
    await queue.flush(CLOCK, PROFILE);
    expect(await ticket.result).toMatchObject({ kind: "cancelled" });
    if (!disposal) throw new Error("Expected reentrant disposal to be captured.");
    await expect(disposal).resolves.toBeUndefined();
    expect(disposeLease).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(queue.snapshot()).toMatchObject({ orphanLeaseCount: 0, orphanJobCount: 0 });
  });

  it("publishes cleanup ownership before reentrant job and lease callbacks", async () => {
    const jobTime = { value: 0 };
    const jobQueue = new IncrementalChunkUploadQueue(() => jobTime.value);
    jobQueue.initialize(CONTEXT);
    let jobDisposal: Promise<void> | null = null;
    const cancel = vi.fn(() => {
      jobDisposal = jobQueue.dispose();
    });
    const jobTicket = jobQueue.enqueue(job({ requestId: 58, now: jobTime, cancel }));
    await expect(jobQueue.cancelOwner(jobTicket.ownerId)).resolves.toBeUndefined();
    if (!jobDisposal) throw new Error("Expected job cleanup to reenter disposal.");
    expect(jobQueue.dispose()).toBe(jobDisposal);
    await expect(jobDisposal).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(jobQueue.snapshot()).toMatchObject({ orphanJobCount: 0, cleanupFailureCount: 0 });

    const leaseTime = { value: 0 };
    const leaseQueue = new IncrementalChunkUploadQueue(() => leaseTime.value);
    leaseQueue.initialize(CONTEXT);
    let leaseDisposal: Promise<void> | null = null;
    const disposeLease = vi.fn(() => {
      leaseDisposal = leaseQueue.dispose();
    });
    const leaseTicket = leaseQueue.enqueue(job({
      requestId: 59,
      now: leaseTime,
      durations: [0.2],
      bytes: 4,
      maximumSliceMs: 0.1,
      dispose: disposeLease,
    }));
    await leaseQueue.flush(CLOCK, PROFILE);
    expect((await leaseTicket.result).kind).toBe("failed");
    if (!leaseDisposal) throw new Error("Expected lease cleanup to reenter disposal.");
    expect(leaseQueue.dispose()).toBe(leaseDisposal);
    await expect(leaseDisposal).resolves.toBeUndefined();
    expect(disposeLease).toHaveBeenCalledTimes(1);
    expect(leaseQueue.snapshot()).toMatchObject({ orphanLeaseCount: 0, cleanupFailureCount: 0 });
  });
});
