import { describe, expect, it, vi } from "vitest";
import type {
  JourneyRenderSnapshot,
  RenderBackendAdapter,
  RenderCompileStepDescriptor,
  RenderCompileStepPhase,
  RenderCompileStepRunner,
  RenderFrameLoop,
  RenderHostDependencies,
  RenderPrecompileReceipt,
  RenderResourceSnapshot,
} from "../../src/gfx/v2/contracts";
import {
  RenderHost,
  createBrowserRenderWarmupScheduler,
} from "../../src/gfx/v2/render-host";
import { RollingGfxPerformanceTelemetry } from "../../src/gfx/v2/telemetry";

const JOURNEY = Object.freeze({
  seed: 6,
  storyTime: 0,
  phase: "LIFE",
  shotId: "S01",
  position: Object.freeze({ x: 0, y: 0 }),
  velocity: Object.freeze({ x: 0, y: 0 }),
  pulses: Object.freeze([]),
  answerAt: null,
  finished: false,
}) satisfies Readonly<JourneyRenderSnapshot>;

const ZERO_RESOURCES = Object.freeze({
  geometries: 0,
  textures: 0,
  renderTargets: 0,
  programs: 0,
  nodes: 0,
  objects: 0,
  subscribers: 0,
  pendingUploads: 0,
}) satisfies Readonly<RenderResourceSnapshot>;

const RUNTIME_0 = Object.freeze({
  id: "test:p0:o0",
  phase: "runtime-object",
  profileId: null,
}) satisfies Readonly<RenderCompileStepDescriptor>;
const MATERIAL_0 = Object.freeze({
  id: "test:p0:m0",
  phase: "material-isolated",
  profileId: "webgpu-high-temporal",
}) satisfies Readonly<RenderCompileStepDescriptor>;

function receipt(phases: readonly RenderCompileStepPhase[]): Readonly<RenderPrecompileReceipt> {
  const phaseCounts: Record<RenderCompileStepPhase, number> = {
    "runtime-object": 0,
    "material-isolated": 0,
    "material-runtime-topology": 0,
    "output-first-use": 0,
  };
  for (const phase of phases) phaseCounts[phase] += 1;
  return Object.freeze({
    plannedSteps: phases.length,
    completedSteps: phases.length,
    phaseCounts: Object.freeze(phaseCounts),
  });
}

class ProbeFrameLoop implements RenderFrameLoop {
  running = false;
  starts = 0;
  readonly log: string[];

  constructor(log: string[]) {
    this.log = log;
  }

  start(): void {
    this.log.push("loop.start");
    this.starts += 1;
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }
}

type HarnessOptions = Readonly<{
  precompile(runner: RenderCompileStepRunner): Promise<Readonly<RenderPrecompileReceipt>>;
  yieldToMain?: () => Promise<void>;
  now?: (() => number) | null;
  recordOperation?: () => void;
  log?: string[];
}>;

function harness(options: HarnessOptions) {
  const log = options.log ?? [];
  const frameLoop = new ProbeFrameLoop(log);
  const telemetry = new RollingGfxPerformanceTelemetry();
  let precompileCalls = 0;
  const cleanupCalls = {
    backend: 0,
    materials: 0,
    uploads: 0,
    resources: 0,
  };
  const backend: RenderBackendAdapter = {
    facts: Object.freeze({
      requestedApi: "WebGPU",
      actualApi: "WebGPU",
      adapter: "compile-test",
      device: "compile-test",
      fallback: false,
    }),
    async initialize(): Promise<void> {},
    resize(): void {},
    async precompile(_passes, runner): Promise<Readonly<RenderPrecompileReceipt>> {
      precompileCalls += 1;
      log.push("backend.precompile.start");
      const result = await options.precompile(runner);
      log.push("backend.precompile.end");
      return result;
    },
    render(): void {},
    subscribeEvents: () => () => undefined,
    snapshotResources: () => ZERO_RESOURCES,
    async dispose(): Promise<void> { cleanupCalls.backend += 1; },
  };
  const dependencies: RenderHostDependencies = {
    backend,
    frameLoop,
    warmupScheduler: {
      yieldToMain: options.yieldToMain ?? (async () => undefined),
    },
    features: [],
    materials: {
      initialize(): void {},
      warmupPasses: () => [],
      quality(): void {},
      dispose(): void { cleanupCalls.materials += 1; },
    },
    uploads: {
      initialize(): void {},
      flush(): void {},
      pendingCount: () => 0,
      dispose(): void { cleanupCalls.uploads += 1; },
    },
    resources: {
      initialize(): void {},
      snapshot: () => ZERO_RESOURCES,
      dispose(): void { cleanupCalls.resources += 1; },
    },
    qualityProvider: {
      getProfile: () => Object.freeze({
        tier: "high",
        pixelRatio: 1,
        uploadBudgetMs: 4,
        features: Object.freeze({}),
      }),
      subscribe: () => () => undefined,
    },
    observer: { observe(): void {} },
  };
  const instrumentation = options.now === null
    ? undefined
    : Object.freeze({
        telemetry: options.recordOperation === undefined
          ? telemetry
          : Object.freeze({
              recordFrame: telemetry.recordFrame.bind(telemetry),
              recordOperation: options.recordOperation,
            }),
        now: options.now ?? (() => 0),
      });
  const host = new RenderHost(dependencies, instrumentation);
  return {
    host,
    frameLoop,
    telemetry,
    log,
    cleanupCalls,
    precompileCalls: () => precompileCalls,
  };
}

describe("GFX-006 atomic compile warm-up", () => {
  it("times only actions, yields between steps, emits no aggregate event, and starts the loop later", async () => {
    const log: string[] = [];
    let now = 10;
    const test = harness({
      log,
      now: () => now,
      async yieldToMain(): Promise<void> {
        log.push("yield");
        now += 100;
      },
      async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
        await runner.run(RUNTIME_0, async () => {
          log.push("action-0");
          now += 7;
        });
        await runner.run(MATERIAL_0, async () => {
          log.push("action-1");
          now += 11;
        });
        return receipt(["runtime-object", "material-isolated"]);
      },
    });

    await test.host.initialize(JOURNEY, { width: 800, height: 450, pixelRatio: 1 });
    const compileEvents = test.telemetry.snapshot().events.filter((event) => event.kind === "compile");
    expect(compileEvents.map((event) => ({
      name: event.name,
      durationMs: event.durationMs,
      success: event.success,
    }))).toEqual([
      { name: "test:p0:o0", durationMs: 7, success: true },
      { name: "test:p0:m0", durationMs: 11, success: true },
    ]);
    expect(compileEvents.some((event) => event.name === "render-host-warmup")).toBe(false);
    expect(test.log).toEqual([
      "backend.precompile.start",
      "action-0",
      "yield",
      "action-1",
      "yield",
      "backend.precompile.end",
      "loop.start",
    ]);
    expect(test.precompileCalls()).toBe(1);
    expect(test.host.getSnapshot().compileWarmup).toEqual({
      planned: 2,
      started: 2,
      completed: 2,
      failed: 0,
      timingComplete: true,
      maxDuration: 11,
      overBudget: 0,
      budgetStatus: "pass",
      phaseCounts: {
        "runtime-object": 1,
        "material-isolated": 1,
        "material-runtime-topology": 0,
        "output-first-use": 0,
      },
    });
    await test.host.dispose();
  });

  it.each([null, undefined, -0, Number.NaN])(
    "records action failure, skips scheduler yield, and propagates a %s throw",
    async (failure) => {
      let yields = 0;
      let now = 1;
      const test = harness({
        now: () => now,
        yieldToMain: async () => { yields += 1; },
        async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
          await runner.run(RUNTIME_0, async () => {
            now += 3;
            throw failure;
          });
          return receipt(["runtime-object"]);
        },
      });

      await expect(test.host.initialize(
        JOURNEY,
        { width: 800, height: 450, pixelRatio: 1 },
      )).rejects.toBeInstanceOf(Error);
      expect(yields).toBe(0);
      expect(test.frameLoop.starts).toBe(0);
      expect(test.telemetry.snapshot().events.filter(
        (event) => event.kind === "compile",
      )).toMatchObject([{ durationMs: 3, success: false }]);
      expect(test.host.getSnapshot().compileWarmup).toMatchObject({
        planned: 1,
        started: 1,
        completed: 0,
        failed: 1,
        budgetStatus: "fail",
      });
    },
  );

  it.each([null, undefined, -0, Number.NaN])(
    "propagates a %s scheduler throw after recording a successful action",
    async (failure) => {
      const test = harness({
        now: () => 1,
        yieldToMain: async () => { throw failure; },
        async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
          await runner.run(RUNTIME_0, async () => undefined);
          return receipt(["runtime-object"]);
        },
      });

      await expect(test.host.initialize(
        JOURNEY,
        { width: 800, height: 450, pixelRatio: 1 },
      )).rejects.toBeInstanceOf(Error);
      expect(test.telemetry.snapshot().events.filter(
        (event) => event.kind === "compile",
      )).toMatchObject([{ durationMs: 0, success: true }]);
      expect(test.host.getSnapshot().compileWarmup).toMatchObject({
        started: 1,
        completed: 1,
        failed: 0,
        budgetStatus: "fail",
      });
    },
  );

  it("rejects synchronous scheduler disposal reentry without an initialization-disposal cycle", async () => {
    const owner: { host: RenderHost | null } = { host: null };
    let reentrantDispose: Promise<void> | null = null;
    const test = harness({
      now: () => 1,
      yieldToMain(): Promise<void> {
        if (owner.host === null) throw new Error("scheduler host was not installed");
        reentrantDispose = owner.host.dispose();
        return reentrantDispose;
      },
      async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
        await runner.run(RUNTIME_0, async () => undefined);
        return receipt(["runtime-object"]);
      },
    });
    const host = test.host;
    owner.host = host;

    await expect(host.initialize(
      JOURNEY,
      { width: 800, height: 450, pixelRatio: 1 },
    )).rejects.toMatchObject({ code: "INVALID_LIFECYCLE" });
    await expect(reentrantDispose).rejects.toMatchObject({ code: "INVALID_LIFECYCLE" });
    const terminalError = host.error;
    const terminalCleanup = host.dispose();
    await expect(terminalCleanup).resolves.toBeUndefined();
    expect(host.dispose()).toBe(terminalCleanup);
    expect(host.error).toBe(terminalError);
    expect(host.state).toBe("failed");
    expect(test.frameLoop).toMatchObject({ running: false, starts: 0 });
    expect(test.cleanupCalls).toEqual({
      backend: 1,
      materials: 1,
      uploads: 1,
      resources: 1,
    });
    expect(host.getSnapshot()).toMatchObject({
      lifecycle: "failed",
      loopRunning: false,
      compileWarmup: {
        planned: 1,
        started: 1,
        completed: 1,
        failed: 0,
        budgetStatus: "fail",
      },
      counters: {
        frameCallbacks: 0,
        submittedFrames: 0,
        pendingControlOperations: 0,
        retainedRawFailureCauses: 0,
        retainedIntermediateFailureSnapshots: 0,
      },
    });
  });

  it("rejects a hostile scheduler thenable without consulting its then accessor", async () => {
    let thenReads = 0;
    const hostileThenable = Object.defineProperty({}, "then", {
      get() {
        thenReads += 1;
        return () => undefined;
      },
    }) as unknown as Promise<void>;
    const test = harness({
      now: () => 1,
      yieldToMain: () => hostileThenable,
      async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
        await runner.run(RUNTIME_0, async () => undefined);
        return receipt(["runtime-object"]);
      },
    });

    await expect(test.host.initialize(
      JOURNEY,
      { width: 800, height: 450, pixelRatio: 1 },
    )).rejects.toMatchObject({ code: "INITIALIZATION_FAILED" });
    expect(thenReads).toBe(0);
    expect(test.host.state).toBe("failed");
    await expect(test.host.dispose()).resolves.toBeUndefined();
  });

  it("awaits a genuine scheduler Promise without consulting a shadowing then accessor", async () => {
    let thenReads = 0;
    const schedulerPromise = Object.defineProperty(Promise.resolve(), "then", {
      configurable: true,
      get() {
        thenReads += 1;
        throw new Error("shadowing then getter invoked");
      },
    });
    const test = harness({
      now: () => 1,
      yieldToMain: () => schedulerPromise,
      async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
        await runner.run(RUNTIME_0, async () => undefined);
        return receipt(["runtime-object"]);
      },
    });

    await test.host.initialize(JOURNEY, { width: 800, height: 450, pixelRatio: 1 });
    expect(thenReads).toBe(0);
    expect(test.host.state).toBe("ready");
    await test.host.dispose();
  });

  it("rejects duplicate, recursive, and concurrent runner actions without invoking rejected operations", async () => {
    for (const violation of ["duplicate", "recursive", "concurrent"] as const) {
      let rejectedOperationCalls = 0;
      const test = harness({
        now: () => 1,
        async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
          if (violation === "duplicate") {
            await runner.run(RUNTIME_0, async () => undefined);
            await runner.run(RUNTIME_0, async () => { rejectedOperationCalls += 1; });
          } else if (violation === "recursive") {
            await runner.run(RUNTIME_0, async () => {
              await runner.run(MATERIAL_0, async () => { rejectedOperationCalls += 1; });
            });
          } else {
            let release!: () => void;
            let entered!: () => void;
            const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const first = runner.run(RUNTIME_0, async () => {
              entered();
              await gate;
            });
            await enteredPromise;
            const second = runner.run(MATERIAL_0, async () => { rejectedOperationCalls += 1; });
            release();
            await first;
            await second;
          }
          return receipt(["runtime-object"]);
        },
      });
      await expect(test.host.initialize(
        JOURNEY,
        { width: 800, height: 450, pixelRatio: 1 },
      )).rejects.toBeInstanceOf(Error);
      expect(rejectedOperationCalls, violation).toBe(0);
      expect(test.frameLoop.starts, violation).toBe(0);
    }
  });

  it("owns descriptor inspection, rejects nested Proxy admission, and releases running after capture failure", async () => {
    const captureFailure = new Error("descriptor inspection failed");
    let nestedAttempt: Promise<void> | null = null;
    let nestedCalls = 0;
    let rejectedDescriptorCalls = 0;
    let recoveryCalls = 0;
    const test = harness({
      now: () => 1,
      async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
        let firstInspection = true;
        const hostileDescriptor = new Proxy(RUNTIME_0, {
          getOwnPropertyDescriptor(target, key) {
            if (firstInspection) {
              firstInspection = false;
              nestedAttempt = runner.run(MATERIAL_0, async () => { nestedCalls += 1; });
              throw captureFailure;
            }
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        });
        await runner.run(hostileDescriptor, async () => { rejectedDescriptorCalls += 1; })
          .catch(() => undefined);
        await nestedAttempt!.catch(() => undefined);
        await runner.run(RUNTIME_0, async () => { recoveryCalls += 1; });
        return receipt(["runtime-object"]);
      },
    });

    await expect(test.host.initialize(
      JOURNEY,
      { width: 800, height: 450, pixelRatio: 1 },
    )).rejects.toBeInstanceOf(Error);
    expect(nestedCalls).toBe(0);
    expect(rejectedDescriptorCalls).toBe(0);
    expect(recoveryCalls).toBe(1);
    expect(test.frameLoop.starts).toBe(0);
  });

  it("rejects an active fire-and-forget runner action and rejects later use without invoking it", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let capturedRunner: RenderCompileStepRunner | null = null;
    const test = harness({
      now: () => 1,
      async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
        capturedRunner = runner;
        void runner.run(RUNTIME_0, async () => {
          entered();
          await gate;
        }).catch(() => undefined);
        return receipt(["runtime-object"]);
      },
    });
    const initializing = test.host.initialize(
      JOURNEY,
      { width: 800, height: 450, pixelRatio: 1 },
    );
    await enteredPromise;
    release();
    await expect(initializing).rejects.toBeInstanceOf(Error);
    let lateCalls = 0;
    await expect(capturedRunner!.run(MATERIAL_0, async () => { lateCalls += 1; })).rejects.toThrow(
      /late action/,
    );
    expect(lateCalls).toBe(0);
    expect(test.frameLoop.starts).toBe(0);
  });

  it("rejects receipt mismatch but permits a settled late runner only as a rejected no-op", async () => {
    let capturedRunner: RenderCompileStepRunner | null = null;
    const mismatch = harness({
      now: () => 1,
      async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
        await runner.run(RUNTIME_0, async () => undefined);
        return receipt(["runtime-object", "material-isolated"]);
      },
    });
    await expect(mismatch.host.initialize(
      JOURNEY,
      { width: 800, height: 450, pixelRatio: 1 },
    )).rejects.toBeInstanceOf(Error);

    const success = harness({
      now: () => 1,
      async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
        capturedRunner = runner;
        await runner.run(RUNTIME_0, async () => undefined);
        return receipt(["runtime-object"]);
      },
    });
    await success.host.initialize(JOURNEY, { width: 800, height: 450, pixelRatio: 1 });
    let lateCalls = 0;
    await expect(capturedRunner!.run(MATERIAL_0, async () => { lateCalls += 1; })).rejects.toThrow(
      /late action/,
    );
    expect(lateCalls).toBe(0);
    expect(success.host.state).toBe("ready");
    await success.host.dispose();
  });

  it.each(["absent", "backwards"] as const)(
    "runs every action exactly once and reaches ready with unmeasured evidence when the clock is %s",
    async (clockKind) => {
      let now = 10;
      let actions = 0;
      const test = harness({
        now: clockKind === "absent" ? null : () => now,
        async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
          await runner.run(RUNTIME_0, async () => {
            actions += 1;
            if (clockKind === "backwards") now = 5;
          });
          return receipt(["runtime-object"]);
        },
      });

      await test.host.initialize(JOURNEY, { width: 800, height: 450, pixelRatio: 1 });
      expect(actions).toBe(1);
      expect(test.host.state).toBe("ready");
      expect(test.host.getSnapshot().compileWarmup).toMatchObject({
        planned: 1,
        started: 1,
        completed: 1,
        failed: 0,
        timingComplete: false,
        maxDuration: null,
        overBudget: 0,
        budgetStatus: "unmeasured",
      });
      await test.host.dispose();
    },
  );

  it("reaches ready but marks compile evidence unmeasured when the telemetry sink rejects it", async () => {
    let actionCalls = 0;
    const test = harness({
      now: () => 4,
      recordOperation: () => { throw new Error("telemetry sink failed"); },
      async precompile(runner): Promise<Readonly<RenderPrecompileReceipt>> {
        await runner.run(RUNTIME_0, async () => { actionCalls += 1; });
        return receipt(["runtime-object"]);
      },
    });

    await test.host.initialize(JOURNEY, { width: 800, height: 450, pixelRatio: 1 });
    expect(actionCalls).toBe(1);
    expect(test.host.state).toBe("ready");
    expect(test.telemetry.snapshot().events.filter((event) => event.kind === "compile")).toEqual([]);
    expect(test.host.getSnapshot().compileWarmup).toMatchObject({
      planned: 1,
      started: 1,
      completed: 1,
      failed: 0,
      timingComplete: false,
      maxDuration: 0,
      overBudget: 0,
      budgetStatus: "unmeasured",
    });
    await test.host.dispose();
  });

  it("uses scheduler.yield when safely available without consulting hostile getters", async () => {
    let schedulerGetterCalls = 0;
    let messageChannelCalls = 0;
    const scope = Object.defineProperties({}, {
      scheduler: {
        value: Object.defineProperty({}, "yield", {
          get() {
            schedulerGetterCalls += 1;
            return async () => undefined;
          },
        }),
      },
      MessageChannel: {
        value: class {
          constructor() {
            messageChannelCalls += 1;
          }
        },
      },
    });
    const scheduler = createBrowserRenderWarmupScheduler(scope);
    await expect(scheduler.yieldToMain()).rejects.toThrow(/scheduler is unavailable/);
    expect(schedulerGetterCalls).toBe(0);
    expect(messageChannelCalls).toBe(0);
  });

  it("captures Chromium-style prototype port getters and reads each port exactly once", async () => {
    const close1 = vi.fn(() => { throw new Error("port1 close failed"); });
    const close2 = vi.fn();
    let port1Reads = 0;
    let port2Reads = 0;
    class FakeMessageChannel {
      readonly #firstPort = {
        addEventListener(_kind: string, listener: () => void) {
          queueMicrotask(listener);
        },
        start() {},
        close: close1,
      };
      readonly #secondPort = {
        postMessage() {},
        close: close2,
      };

      get port1() {
        port1Reads += 1;
        return this.#firstPort;
      }

      get port2() {
        port2Reads += 1;
        return this.#secondPort;
      }
    }
    const scheduler = createBrowserRenderWarmupScheduler(Object.freeze({
      MessageChannel: FakeMessageChannel,
    }));

    await expect(scheduler.yieldToMain()).rejects.toThrow("port1 close failed");
    expect(port1Reads).toBe(1);
    expect(port2Reads).toBe(1);
    expect(close1).toHaveBeenCalledOnce();
    expect(close2).toHaveBeenCalledOnce();
  });

  it("ignores instance-shadowing port getters and preserves setup failure while closing both ports", async () => {
    const setupFailure = new Error("postMessage failed");
    const close1 = vi.fn(() => { throw new Error("port1 close failed"); });
    const close2 = vi.fn();
    let prototypePort1Reads = 0;
    let prototypePort2Reads = 0;
    let instanceGetterReads = 0;
    class FakeMessageChannel {
      readonly #firstPort = {
        addEventListener() {},
        start() {},
        close: close1,
      };
      readonly #secondPort = {
        postMessage() { throw setupFailure; },
        close: close2,
      };

      constructor() {
        Object.defineProperties(this, {
          port1: { get: () => { instanceGetterReads += 1; return null; } },
          port2: { get: () => { instanceGetterReads += 1; return null; } },
        });
      }

      get port1() {
        prototypePort1Reads += 1;
        return this.#firstPort;
      }

      get port2() {
        prototypePort2Reads += 1;
        return this.#secondPort;
      }
    }
    const scheduler = createBrowserRenderWarmupScheduler(Object.freeze({
      MessageChannel: FakeMessageChannel,
    }));

    await expect(scheduler.yieldToMain()).rejects.toBe(setupFailure);
    expect(instanceGetterReads).toBe(0);
    expect(prototypePort1Reads).toBe(1);
    expect(prototypePort2Reads).toBe(1);
    expect(close1).toHaveBeenCalledOnce();
    expect(close2).toHaveBeenCalledOnce();
  });
});
