import { describe, expect, it } from "vitest";
import type {
  FeatureInitContext,
  JourneyRenderSnapshot,
  RenderQualityProfile,
  VisualClock,
} from "../../src/gfx/v2/contracts";
import type { WorldChunkRenderFeature } from "../../src/gfx/v2/chunks";
import {
  FoundationConstructionAdmission,
  FoundationConstructionCleanupOwner,
  assertFoundationHostReady,
  immutableFoundationCleanupFailure,
  type FoundationFailureSnapshot,
} from "../../src/gfx/v2/integration/foundation-construction-owner";
import { LogicalChunkResourceRegistry } from "../../src/gfx/v2/integration/logical-resource-registry";
import { PooledWorldChunkFeature } from "../../src/gfx/v2/integration/pooled-world-chunk-feature";
import { RuntimeCleanupTombstone } from "../../src/gfx/v2/integration/runtime-cleanup-tombstone";
import type { ProductionThreeChunkUploader } from "../../src/gfx/v2/integration/three-chunk-uploader";

const QUALITY: Readonly<RenderQualityProfile> = Object.freeze({
  tier: "high",
  pixelRatio: 1,
  uploadBudgetMs: 4,
  features: Object.freeze({ temporal: true }),
});

const CLOCK: Readonly<VisualClock> = Object.freeze({
  frame: 1,
  nowMs: 16,
  deltaSeconds: 0.016,
  elapsedSeconds: 0.016,
});

const FRAME = Object.freeze({ shotId: "S08" }) as Readonly<JourneyRenderSnapshot>;

function ownership(ownerId: string) {
  return {
    ownerId,
    geometries: 0,
    textures: 0,
    renderTargets: 0,
    nodes: 0,
    objects: 8,
    bytes: 0,
  };
}

describe("LogicalChunkResourceRegistry", () => {
  it("copies logical ownership, rejects malformed or duplicate owners, and releases to terminal zero", async () => {
    const registry = new LogicalChunkResourceRegistry();
    registry.initialize();
    const source = ownership("chunk:S08:1");
    registry.adopt(source);
    source.ownerId = "mutated";
    source.objects = 99;

    expect(registry.snapshotEvidence()).toMatchObject({
      initialized: true,
      disposed: false,
      owners: 1,
      adopted: 1,
      released: 0,
      bytes: 0,
      resources: { objects: 8 },
    });
    expect(() => registry.adopt(ownership("chunk:S08:1"))).toThrow(/already exists/i);
    expect(() => registry.adopt({ ...ownership("bad"), bytes: -0 })).toThrow(/non-negative safe integer/i);

    registry.releaseOwner("chunk:S08:1");
    expect(registry.snapshotEvidence()).toMatchObject({ owners: 0, released: 1 });
    const firstDispose = registry.dispose();
    expect(registry.dispose()).toBe(firstDispose);
    await firstDispose;
    expect(registry.snapshotEvidence()).toMatchObject({
      initialized: false,
      disposed: true,
      owners: 0,
      bytes: 0,
      resources: { objects: 0 },
    });
  });

  it("fails closed with the retained owner count instead of claiming disposal", async () => {
    const registry = new LogicalChunkResourceRegistry();
    registry.initialize();
    registry.adopt(ownership("chunk:S21:7"));
    const firstDispose = registry.dispose();
    expect(registry.dispose()).toBe(firstDispose);
    await expect(firstDispose).rejects.toThrow(/retained 1 owner/i);
    expect(registry.snapshotEvidence()).toMatchObject({
      initialized: true,
      disposed: false,
      owners: 1,
      resources: { objects: 8 },
    });
  });

  it("captures caller ownership through own data descriptors without invoking getters", () => {
    const registry = new LogicalChunkResourceRegistry();
    registry.initialize();
    const descriptorReads = new Map<PropertyKey, number>();
    let ordinaryReads = 0;
    const source = ownership("chunk:S14:3");
    const proxied = new Proxy(source, {
      get() {
        ordinaryReads += 1;
        throw new Error("ordinary access must not run");
      },
      getOwnPropertyDescriptor(target, key) {
        descriptorReads.set(key, (descriptorReads.get(key) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    registry.adopt(proxied);
    expect(ordinaryReads).toBe(0);
    for (const key of [
      "ownerId",
      "geometries",
      "textures",
      "renderTargets",
      "nodes",
      "objects",
      "bytes",
    ]) {
      expect(descriptorReads.get(key)).toBe(1);
    }

    let getterReads = 0;
    const accessor = { ...ownership("chunk:S15:4") };
    Object.defineProperty(accessor, "objects", {
      enumerable: true,
      get() {
        getterReads += 1;
        return 8;
      },
    });
    expect(() => registry.adopt(accessor)).toThrow(/own data property/i);
    expect(getterReads).toBe(0);
  });
});

describe("PooledWorldChunkFeature", () => {
  it("orders pool acquisition, runtime detach, quality, and reverse cleanup", async () => {
    const calls: string[] = [];
    const inner = {
      initialize: async () => { calls.push("inner.initialize"); },
      warmupPasses: () => Object.freeze([]),
      update: () => { calls.push("inner.update"); },
      render: () => { calls.push("inner.render"); },
      quality: () => { calls.push("inner.quality"); },
      resize: () => undefined,
      invalidateHistory: () => undefined,
      dispose: async () => { calls.push("inner.dispose"); },
    } as unknown as WorldChunkRenderFeature;
    const uploader = {
      initializePool: () => { calls.push("pool.initialize"); },
      beginRuntime: () => { calls.push("pool.beginRuntime"); },
      quality: () => { calls.push("pool.quality"); },
      dispose: async () => { calls.push("pool.dispose"); },
    } as unknown as ProductionThreeChunkUploader;
    const feature = new PooledWorldChunkFeature(inner, uploader);

    const initialize = feature.initialize({} as FeatureInitContext);
    expect(feature.initialize({} as FeatureInitContext)).toBe(initialize);
    await initialize;
    expect(calls).toEqual(["pool.initialize", "inner.initialize"]);

    feature.update(FRAME, CLOCK);
    feature.quality(QUALITY);
    expect(calls.slice(2)).toEqual([
      "pool.beginRuntime",
      "inner.update",
      "pool.quality",
      "inner.quality",
    ]);

    const firstDispose = feature.dispose();
    expect(feature.dispose()).toBe(firstDispose);
    await firstDispose;
    expect(calls.slice(-2)).toEqual(["inner.dispose", "pool.dispose"]);
  });

  it("always releases the pool and publishes immutable cleanup evidence when both owners fail", async () => {
    const innerFailure = new Error("inner cleanup");
    const poolFailure = new Error("pool cleanup");
    const calls: string[] = [];
    const inner = {
      initialize: async () => undefined,
      warmupPasses: () => Object.freeze([]),
      update: () => undefined,
      render: () => undefined,
      quality: () => undefined,
      resize: () => undefined,
      invalidateHistory: () => undefined,
      dispose: async () => {
        calls.push("inner.dispose");
        throw innerFailure;
      },
    } as unknown as WorldChunkRenderFeature;
    const uploader = {
      initializePool: () => undefined,
      beginRuntime: () => undefined,
      quality: () => undefined,
      dispose: async () => {
        calls.push("pool.dispose");
        throw poolFailure;
      },
    } as unknown as ProductionThreeChunkUploader;
    const feature = new PooledWorldChunkFeature(inner, uploader);

    let rejection: unknown;
    try {
      await feature.dispose();
    } catch (error: unknown) {
      rejection = error;
    }
    expect(calls).toEqual(["inner.dispose", "pool.dispose"]);
    expect(rejection).toBeInstanceOf(AggregateError);
    const aggregate = rejection as AggregateError;
    expect(aggregate.errors).toEqual([innerFailure, poolFailure]);
    expect(Object.isFrozen(aggregate.errors)).toBe(true);
    expect(Object.isFrozen(aggregate)).toBe(true);
  });
});

describe("RuntimeCleanupTombstone", () => {
  it("blocks replacement construction while an exact stale runtime cleanup remains failed", async () => {
    const failure = new Error("worker termination failed");
    const failedDispose = Promise.reject(failure);
    failedDispose.catch(() => undefined);
    let disposeCalls = 0;
    const staleRuntime = {
      dispose() {
        disposeCalls += 1;
        return failedDispose;
      },
    };
    const owner = new RuntimeCleanupTombstone<typeof staleRuntime>();

    await expect(owner.dispose(staleRuntime)).rejects.toBe(failure);
    expect(owner.retained()).toBe(staleRuntime);
    let replacementConstructions = 0;
    await expect(owner.drain().then(() => {
      replacementConstructions += 1;
    })).rejects.toBe(failure);
    expect(replacementConstructions).toBe(0);
    expect(owner.retained()).toBe(staleRuntime);
    expect(disposeCalls).toBe(2);
  });

  it("clears only after successful stable cleanup and then permits replacement", async () => {
    const dispose = Promise.resolve();
    const runtime = { dispose: () => dispose };
    const owner = new RuntimeCleanupTombstone<typeof runtime>();
    await owner.dispose(runtime);
    expect(owner.retained()).toBeNull();
    await owner.drain();
  });
});

function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => { throw new Error("Expected a rejected construction operation."); },
    (error: unknown) => error,
  );
}

describe("FoundationConstructionAdmission", () => {
  it("retains the exact failed pre-Host owner and blocks the next acquisition with the stable rejection", async () => {
    const admission = new FoundationConstructionAdmission<FoundationConstructionCleanupOwner>();
    const rawWorkerFailure = new Error("worker termination failed");
    const rawPrimary = new Error("backend acquisition failed");
    let workerOwner: { dispose(): Promise<void> } | null = {
      dispose: async () => { throw rawWorkerFailure; },
    };
    let successfulOwner: { dispose(): Promise<void> } | null = {
      dispose: async () => undefined,
    };
    let cleanupCalls = 0;
    let acquisitions = 0;
    let cleanupEvidence: AggregateError | null = null;
    let exactOwner: FoundationConstructionCleanupOwner | null = null;

    const first = admission.run(async (gate) => {
      const owner = new FoundationConstructionCleanupOwner(async () => {
        cleanupCalls += 1;
        const failures: unknown[] = [];
        const worker = workerOwner;
        if (worker) {
          try {
            await worker.dispose();
            if (workerOwner === worker) workerOwner = null;
          } catch (error: unknown) {
            failures.push(error);
          }
        }
        const successful = successfulOwner;
        if (successful) {
          await successful.dispose();
          if (successfulOwner === successful) successfulOwner = null;
        }
        if (failures.length > 0) {
          cleanupEvidence = immutableFoundationCleanupFailure(failures, "pre-Host cleanup failed");
          throw cleanupEvidence;
        }
      });
      exactOwner = owner;
      gate.publish(owner);
      acquisitions += 1;
      try {
        throw rawPrimary;
      } catch (error: unknown) {
        try {
          await owner.dispose();
          gate.transfer(owner);
        } catch (cleanupError: unknown) {
          throw immutableFoundationCleanupFailure([error, cleanupError], "construction failed");
        }
        throw error;
      }
    });

    const publicFailure = await rejectedValue(first);
    expect(publicFailure).toBeInstanceOf(AggregateError);
    expect(publicFailure).not.toBe(rawPrimary);
    expect((publicFailure as AggregateError).errors).not.toContain(rawPrimary);
    expect(admission.retained()).toBe(exactOwner);
    expect(workerOwner).not.toBeNull();
    expect(successfulOwner).toBeNull();
    expect(Number(workerOwner !== null) + Number(successfulOwner !== null)).toBe(1);
    expect(cleanupCalls).toBe(1);

    const retained = admission.retained();
    if (!retained) throw new Error("Expected the failed construction owner to remain retained.");
    const stableCleanup = retained.dispose();
    expect(retained.dispose()).toBe(stableCleanup);
    const replay = await rejectedValue(stableCleanup);
    expect(replay).toBe(cleanupEvidence);

    const second = admission.run(async () => {
      acquisitions += 1;
      return "replacement";
    });
    await expect(second).rejects.toBe(cleanupEvidence);
    expect(acquisitions).toBe(1);
    expect(cleanupCalls).toBe(1);
    expect(admission.retained()).toBe(exactOwner);
  });

  it("retains only the exact Host rollback owner and never directly double-disposes its dependencies", async () => {
    const admission = new FoundationConstructionAdmission<FoundationConstructionCleanupOwner>();
    const rawHostFailure = new Error("Host GPU cleanup failed");
    const stableHostFailure = Promise.reject(rawHostFailure);
    stableHostFailure.catch(() => undefined);
    let hostDisposeCalls = 0;
    let directDependencyDisposeCalls = 0;
    const host = {
      dispose() {
        hostDisposeCalls += 1;
        return stableHostFailure;
      },
    };
    let hostOwner: typeof host | null = host;
    let duplicateDependencyOwner: { dispose(): Promise<void> } | null = {
      dispose: async () => { directDependencyDisposeCalls += 1; },
    };
    let successfulSceneOwner: { clear(): void } | null = { clear: () => undefined };
    let cleanupEvidence: AggregateError | null = null;
    let factoryCalls = 0;

    const first = admission.run(async (gate) => {
      const owner = new FoundationConstructionCleanupOwner(async () => {
        const failures: unknown[] = [];
        const exactHost = hostOwner;
        if (exactHost) {
          try {
            await exactHost.dispose();
            if (hostOwner === exactHost) hostOwner = null;
          } catch (error: unknown) {
            failures.push(error);
          }
          // Host owns this dependency; the construction closure drops its alias
          // without invoking the dependency disposer a second time.
          duplicateDependencyOwner = null;
        }
        const scene = successfulSceneOwner;
        if (scene) {
          scene.clear();
          if (successfulSceneOwner === scene) successfulSceneOwner = null;
        }
        if (failures.length > 0) {
          cleanupEvidence = immutableFoundationCleanupFailure(failures, "Host rollback failed");
          throw cleanupEvidence;
        }
      });
      gate.publish(owner);
      factoryCalls += 1;
      try {
        throw new Error("Host initialize failed");
      } catch (error: unknown) {
        try {
          await owner.dispose();
          gate.transfer(owner);
        } catch (cleanupError: unknown) {
          throw immutableFoundationCleanupFailure([error, cleanupError], "Host construction failed");
        }
        throw error;
      }
    });

    await expect(first).rejects.toBeInstanceOf(AggregateError);
    expect(admission.retained()).not.toBeNull();
    expect(hostOwner).toBe(host);
    expect(duplicateDependencyOwner).toBeNull();
    expect(successfulSceneOwner).toBeNull();
    expect(
      Number(hostOwner !== null)
      + Number(duplicateDependencyOwner !== null)
      + Number(successfulSceneOwner !== null),
    ).toBe(1);
    expect(directDependencyDisposeCalls).toBe(0);
    expect(hostDisposeCalls).toBe(1);

    const second = admission.run(async () => {
      factoryCalls += 1;
      return "replacement";
    });
    await expect(second).rejects.toBe(cleanupEvidence);
    expect(factoryCalls).toBe(1);
    expect(hostDisposeCalls).toBe(1);
  });

  it("clears a clean failed attempt and permits a serialized retry", async () => {
    const admission = new FoundationConstructionAdmission<FoundationConstructionCleanupOwner>();
    const primary = new Error("cleanly rolled back acquisition");
    let cleanupCalls = 0;
    let replacementCalls = 0;

    const first = admission.run(async (gate) => {
      const owner = new FoundationConstructionCleanupOwner(async () => { cleanupCalls += 1; });
      gate.publish(owner);
      try {
        throw primary;
      } catch (error: unknown) {
        await owner.dispose();
        gate.transfer(owner);
        throw error;
      }
    });
    await expect(first).rejects.toBe(primary);
    expect(admission.retained()).toBeNull();

    const second = admission.run(async (gate) => {
      const owner = new FoundationConstructionCleanupOwner(async () => undefined);
      gate.publish(owner);
      replacementCalls += 1;
      gate.transfer(owner);
      return "ready";
    });
    await expect(second).resolves.toBe("ready");
    expect(cleanupCalls).toBe(1);
    expect(replacementCalls).toBe(1);
  });

  it("does not enter attempt B while deferred attempt A still owns construction admission", async () => {
    const admission = new FoundationConstructionAdmission<FoundationConstructionCleanupOwner>();
    let releaseA!: () => void;
    const holdA = new Promise<void>((resolve) => { releaseA = resolve; });
    let announceA!: () => void;
    const startedA = new Promise<void>((resolve) => { announceA = resolve; });
    let aStarted = false;
    let bStarted = false;

    const attemptA = admission.run(async (gate) => {
      const owner = new FoundationConstructionCleanupOwner(async () => undefined);
      gate.publish(owner);
      aStarted = true;
      announceA();
      await holdA;
      gate.transfer(owner);
      return "A";
    });
    const attemptB = admission.run(async (gate) => {
      const owner = new FoundationConstructionCleanupOwner(async () => undefined);
      gate.publish(owner);
      bStarted = true;
      gate.transfer(owner);
      return "B";
    });

    await startedA;
    expect(aStarted).toBe(true);
    expect(bStarted).toBe(false);
    releaseA();
    await expect(attemptA).resolves.toBe("A");
    await expect(attemptB).resolves.toBe("B");
  });

  it("rejects and rolls back when the Host fails during deferred viewport reconciliation", async () => {
    const admission = new FoundationConstructionAdmission<FoundationConstructionCleanupOwner>();
    const lateFailure = new Error("backend device lost during reconcile");
    let hostState = "ready";
    let hostError: unknown = null;
    let hostDisposeCalls = 0;
    let hostOwner: { readonly state: string; readonly error: unknown; dispose(): Promise<void> } | null;
    const host = {
      get state() { return hostState; },
      get error() { return hostError; },
      async dispose() {
        hostDisposeCalls += 1;
        hostState = "disposed";
        hostError = null;
      },
    };
    hostOwner = host;
    let resizeActive = false;
    let resizeDetachCalls = 0;
    let qualityOwner: object | null = {};
    let sceneOwner: object | null = {};
    let runtimeReturned = false;
    let factoryCalls = 0;
    let announceReconcile!: () => void;
    const reconcileEntered = new Promise<void>((resolve) => { announceReconcile = resolve; });
    let releaseReconcile!: () => void;
    const reconcile = new Promise<void>((resolve) => { releaseReconcile = resolve; });

    const attempt = admission.run(async (gate) => {
      const owner = new FoundationConstructionCleanupOwner(async () => {
        const exactHost = hostOwner;
        if (resizeActive) {
          resizeActive = false;
          resizeDetachCalls += 1;
        }
        if (exactHost) {
          await exactHost.dispose();
          if (hostOwner === exactHost) hostOwner = null;
        }
        qualityOwner = null;
        sceneOwner = null;
      });
      gate.publish(owner);
      factoryCalls += 1;
      try {
        assertFoundationHostReady(host, "initialization");
        resizeActive = true;
        assertFoundationHostReady(host, "resize listener binding");
        announceReconcile();
        await reconcile;
        assertFoundationHostReady(host, "viewport reconciliation");
        runtimeReturned = true;
        gate.transfer(owner);
        return Object.freeze({ ready: true });
      } catch (error: unknown) {
        await owner.dispose();
        gate.transfer(owner);
        throw immutableFoundationCleanupFailure(
          [error],
          "GFX foundation construction failed after clean rollback.",
        );
      }
    });

    await reconcileEntered;
    hostState = "failed";
    hostError = lateFailure;
    releaseReconcile();
    const publicFailure = await rejectedValue(attempt);

    expect(publicFailure).toBeInstanceOf(AggregateError);
    expect(publicFailure).not.toBe(lateFailure);
    expect((publicFailure as AggregateError).errors).not.toContain(lateFailure);
    expect(runtimeReturned).toBe(false);
    expect(hostDisposeCalls).toBe(1);
    expect(hostState).toBe("disposed");
    expect(hostOwner).toBeNull();
    expect(resizeActive).toBe(false);
    expect(resizeDetachCalls).toBe(1);
    expect(qualityOwner).toBeNull();
    expect(sceneOwner).toBeNull();
    expect(admission.retained()).toBeNull();

    const retry = admission.run(async (gate) => {
      const owner = new FoundationConstructionCleanupOwner(async () => undefined);
      gate.publish(owner);
      factoryCalls += 1;
      gate.transfer(owner);
      return "retry-ready";
    });
    await expect(retry).resolves.toBe("retry-ready");
    expect(factoryCalls).toBe(2);
  });
});

describe("immutableFoundationCleanupFailure", () => {
  it("detaches mutable, cyclic, and hostile evidence under one global node budget", () => {
    let getterReads = 0;
    const hostile = {};
    Object.defineProperty(hostile, "message", {
      enumerable: true,
      get() {
        getterReads += 1;
        return "must not execute";
      },
    });
    let hostileDescriptorReads = 0;
    const opaqueProxy = new Proxy({}, {
      getOwnPropertyDescriptor() {
        hostileDescriptorReads += 1;
        throw new Error("hostile descriptor trap");
      },
    });
    const child = new Error("child-before");
    const mutable = new AggregateError([child], "mutable-root") as AggregateError & { cause?: unknown };
    Object.defineProperty(mutable, "cause", {
      configurable: true,
      value: mutable,
      writable: true,
    });
    const makeTree = (depth: number): AggregateError => new AggregateError(
      depth === 0
        ? [new Error("leaf")]
        : Array.from({ length: 8 }, () => makeTree(depth - 1)),
      `tree-${depth}`,
    );
    const wideTree = makeTree(3);

    const evidence = immutableFoundationCleanupFailure(
      [mutable, hostile, opaqueProxy, wideTree],
      "bounded construction cleanup",
    );
    const beforeMutation = JSON.stringify(evidence.errors);
    child.message = "child-after";
    mutable.errors.push(new Error("late mutation"));
    mutable.cause = new Error("late cause");

    expect(getterReads).toBe(0);
    expect(hostileDescriptorReads).toBe(1);
    expect(JSON.stringify(evidence.errors)).toBe(beforeMutation);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.errors)).toBe(true);
    expect(evidence.errors).not.toContain(mutable);
    expect(evidence.errors).not.toContain(child);

    const snapshots = evidence.errors as readonly FoundationFailureSnapshot[];
    expect(snapshots.some((snapshot) => snapshot.kind === "uninspectable")).toBe(true);
    let observedGlobalLimit = false;
    let observedNodes = 0;
    const visit = (snapshot: FoundationFailureSnapshot) => {
      observedNodes += 1;
      expect(Object.isFrozen(snapshot)).toBe(true);
      if (snapshot.type === "global-node-budget") observedGlobalLimit = true;
      if (snapshot.cause) visit(snapshot.cause);
      if (snapshot.errors) expect(Object.isFrozen(snapshot.errors)).toBe(true);
      for (const nested of snapshot.errors ?? []) visit(nested);
    };
    for (const snapshot of snapshots) visit(snapshot);
    expect(observedGlobalLimit).toBe(true);
    expect(observedNodes).toBeLessThanOrEqual(160);
  });
});
