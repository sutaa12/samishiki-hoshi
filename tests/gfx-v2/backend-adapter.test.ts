import { describe, expect, it, vi } from "vitest";
import {
  ThreeRenderBackendAdapter,
  type ThreeRendererPort,
} from "../../src/gfx/v2/backend/backend-adapter";
import type { BackendRuntimeEvent, RenderPass } from "../../src/gfx/v2/contracts";

const viewport = { width: 800, height: 450, pixelRatio: 1 } as const;
const probe = {
  source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)",
  attempted: true,
  available: true,
  vendor: "test-vendor",
  architecture: "test-architecture",
  device: null,
  description: null,
  error: null,
} as const;

function fakeRenderer(actual: "webgpu" | "webgl2" = "webgl2"): ThreeRendererPort & {
  calls: string[];
  disposed: boolean;
} {
  const calls: string[] = [];
  const backend = actual === "webgpu"
    ? { isWebGPUBackend: true, compatibilityMode: false, dispose() { calls.push("backend.dispose"); } }
    : { isWebGLBackend: true, compatibilityMode: false, dispose() { calls.push("backend.dispose"); } };
  return {
    calls,
    disposed: false,
    backend,
    info: {
      memory: {
        attributes: 4,
        geometries: 2,
        indexAttributes: 2,
        indirectStorageAttributes: 0,
        programs: 2,
        readbackBuffers: 0,
        renderTargets: 1,
        storageAttributes: 0,
        textures: 1,
        total: 4096,
        uniformBuffers: 2,
      },
    },
    onError: () => undefined,
    onDeviceLost: () => undefined,
    async init() { calls.push("init"); },
    setPixelRatio(value) { calls.push(`pixelRatio:${value}`); },
    setSize(width, height) { calls.push(`size:${width}x${height}`); },
    async compileAsync() { calls.push("compile"); },
    render() { calls.push("render"); },
    dispose() {
      calls.push("dispose");
      this.disposed = true;
      this.info = {
        memory: {
          attributes: 0,
          geometries: 0,
          indexAttributes: 0,
          indirectStorageAttributes: 0,
          programs: 0,
          readbackBuffers: 0,
          renderTargets: 0,
          storageAttributes: 0,
          textures: 0,
          total: 0,
          uniformBuffers: 0,
        },
      };
      this.backend?.dispose?.();
    },
  };
}

function adapter(renderer: ThreeRendererPort, request: "forced-webgl2" | "webgpu-preferred" = "forced-webgl2") {
  return new ThreeRenderBackendAdapter({
    request,
    lab: true,
    diagnosticsEnabled: true,
    threeRevision: "185",
    webgpuApiExposed: true,
    webgl2ApiAvailable: true,
    navigatorProbe: probe,
    createRenderer: () => renderer,
    now: () => 42,
  });
}

describe("GFX-002 Three backend adapter", () => {
  it("captures constructor options instead of retaining caller-owned configuration", async () => {
    const renderer = fakeRenderer();
    const unexpectedRenderer = fakeRenderer("webgpu");
    const mutableProbe = { ...probe };
    const options = {
      request: "forced-webgl2" as "forced-webgl2" | "webgpu-preferred",
      lab: true,
      diagnosticsEnabled: true,
      threeRevision: "185",
      webgpuApiExposed: true,
      webgl2ApiAvailable: true,
      navigatorProbe: mutableProbe,
      createRenderer: () => renderer,
      now: () => 42,
    };
    const backend = new ThreeRenderBackendAdapter(options);
    options.request = "webgpu-preferred";
    options.diagnosticsEnabled = false;
    options.createRenderer = () => unexpectedRenderer;
    (mutableProbe as { vendor: string | null }).vendor = "mutated-vendor";

    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);
    await backend.initialize({ viewport });
    backend.diagnostics.emitDeviceLost(new Error("captured diagnostics policy"));

    expect(renderer.calls).toContain("init");
    expect(unexpectedRenderer.calls).not.toContain("init");
    expect(backend.facts).toMatchObject({
      requestedPolicy: "forced-webgl2",
      requestedApi: "WebGL2",
      navigatorProbe: { vendor: "test-vendor" },
    });
    expect(listener).toHaveBeenCalledOnce();
    await backend.dispose();
  });

  it("keeps requested, actual, API exposure, probe, compatibility, and lab facts distinct", async () => {
    const renderer = fakeRenderer("webgl2");
    const backend = adapter(renderer, "webgpu-preferred");
    await backend.initialize({ viewport });

    expect(backend.facts).toMatchObject({
      requestedApi: "WebGPU",
      actualApi: "WebGL2",
      requestedPolicy: "webgpu-preferred",
      fallback: true,
      actualAuthority: "renderer.backend flags observed after init",
      webgpuApiExposed: true,
      webgl2ApiAvailable: true,
      navigatorProbe: { source: expect.stringContaining("not renderer identity") },
      compatibilityMode: false,
      lab: { enabled: true, diagnosticsEnabled: true, performanceAccepted: false },
    });

    await backend.dispose();
    expect(backend.facts.compatibilityMode).toBe(false);
  });

  it("precompiles and renders only drawable passes before idempotent zero-resource disposal", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const traverse = vi.fn(() => { throw new Error("scene.traverse must not be invoked"); });
    const scene = { children: [{}], traverse };
    const passes: RenderPass[] = [
      { name: "warmup", kind: "warmup" },
      { name: "scene", kind: "scene", scene, camera: {} },
    ];
    await backend.initialize({ viewport });
    await backend.precompile(passes);
    await backend.render(passes);
    expect(backend.snapshotResources()).toMatchObject({
      geometries: 2,
      textures: 1,
      renderTargets: 1,
      programs: 2,
      objects: 2,
    });
    expect(backend.snapshotLifecycle()).toMatchObject({
      resourceCounterProvenance: "live-renderer-info",
      rendererMemoryComplete: true,
      rendererMemory: { geometries: 2, programs: 2, totalBytes: 4096 },
      appOwnership: { renderPasses: 2, sceneObjects: 2, eventSubscribers: 0 },
    });
    expect(traverse).not.toHaveBeenCalled();
    expect(renderer.calls).toEqual([
      "init",
      "pixelRatio:1",
      "size:800x450",
      "pixelRatio:1",
      "size:800x450",
      "compile",
      "render",
    ]);

    const first = backend.dispose();
    const second = backend.dispose();
    expect(first).toBe(second);
    await first;
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "disposed",
      eventBridgeActive: false,
      disposeCalls: 2,
      rendererDisposeInvoked: true,
      rendererDisposeCompleted: true,
      backendDisposeInstrumented: true,
      backendDisposeInvoked: true,
      backendDisposeCompleted: true,
      resourceCounterProvenance: "post-renderer-dispose-observation",
      threeInfoResetObserved: true,
      rendererMemoryComplete: true,
      appOwnership: { renderPasses: 0, sceneObjects: 0, eventSubscribers: 0 },
      aggregateCounterAvailability: { nodes: false, pendingUploads: false },
      lastLiveResources: { geometries: 2, programs: 2, objects: 2 },
      resourcesBeforeRendererDispose: { geometries: 2, programs: 2, objects: 2 },
      resources: {
        geometries: 0,
        textures: 0,
        renderTargets: 0,
        programs: 0,
        objects: 0,
        subscribers: 0,
      },
    });
  });

  it("returns unavailable nested telemetry without recursion during live and disposal sampling", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const scene: { children: unknown[] } = { children: [{}] };
    const pass: RenderPass = { name: "scene", kind: "scene", scene, camera: {} };
    await backend.initialize({ viewport });
    await backend.render([pass]);

    const stableMemory = renderer.info!.memory!;
    const nestedSnapshots: ReturnType<typeof backend.snapshotLifecycle>[] = [];
    let infoReads = 0;
    let childReads = 0;
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() {
        infoReads += 1;
        nestedSnapshots.push(backend.snapshotLifecycle());
        return { memory: stableMemory };
      },
    });
    Object.defineProperty(scene, "children", {
      configurable: true,
      get() {
        childReads += 1;
        nestedSnapshots.push(backend.snapshotLifecycle());
        return [{}];
      },
    });

    const live = backend.snapshotLifecycle();
    expect(live).toMatchObject({
      state: "ready",
      resourceCounterProvenance: "live-renderer-info",
      rendererMemoryComplete: true,
      appOwnership: { sceneObjects: 2 },
      resources: { objects: 2, geometries: 2 },
    });
    expect(infoReads).toBe(1);
    expect(childReads).toBe(1);
    expect(nestedSnapshots).toHaveLength(2);
    for (const nested of nestedSnapshots) {
      expect(nested).toMatchObject({
        resourceCounterProvenance: "unavailable",
        rendererMemoryComplete: false,
        appOwnership: { sceneObjects: 0 },
        resources: {
          geometries: 0,
          textures: 0,
          renderTargets: 0,
          programs: 0,
          objects: 0,
        },
      });
    }

    renderer.dispose = () => {
      renderer.calls.push("dispose");
      renderer.disposed = true;
      renderer.backend?.dispose?.();
    };
    await expect(backend.dispose()).resolves.toBeUndefined();
    expect(infoReads).toBe(3);
    expect(childReads).toBe(2);
    expect(nestedSnapshots).toHaveLength(5);
    expect(nestedSnapshots.slice(2)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: "disposing",
        resourceCounterProvenance: "unavailable",
        rendererMemoryComplete: false,
      }),
    ]));
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "disposed",
      retainedFailureReferences: 0,
    });
  });

  it("builds lifecycle memory, resource, and scene counters from one telemetry capture", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const scene: { children: unknown[] } = { children: [] };
    const pass: RenderPass = { name: "scene", kind: "scene", scene, camera: {} };
    await backend.initialize({ viewport });
    await backend.render([pass]);

    let infoReads = 0;
    let childReads = 0;
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() {
        infoReads += 1;
        const sample = infoReads * 10;
        return {
          memory: {
            attributes: sample + 1,
            geometries: sample + 2,
            indexAttributes: sample + 3,
            indirectStorageAttributes: sample + 4,
            programs: sample + 5,
            readbackBuffers: sample + 6,
            renderTargets: sample + 7,
            storageAttributes: sample + 8,
            textures: sample + 9,
            total: sample + 10,
            uniformBuffers: sample + 11,
          },
        };
      },
    });
    Object.defineProperty(scene, "children", {
      configurable: true,
      get() {
        childReads += 1;
        return Array.from({ length: childReads }, () => ({}));
      },
    });

    const snapshot = backend.snapshotLifecycle();
    expect(infoReads).toBe(1);
    expect(childReads).toBe(1);
    expect(snapshot.rendererMemory).toMatchObject({
      geometries: 12,
      programs: 15,
      renderTargets: 17,
      textures: 19,
    });
    expect(snapshot.resources).toMatchObject({
      geometries: snapshot.rendererMemory.geometries,
      programs: snapshot.rendererMemory.programs,
      renderTargets: snapshot.rendererMemory.renderTargets,
      textures: snapshot.rendererMemory.textures,
      objects: 2,
    });
    expect(snapshot.appOwnership.sceneObjects).toBe(snapshot.resources.objects);

    renderer.dispose = () => {
      renderer.calls.push("dispose");
      renderer.backend?.dispose?.();
    };
    await backend.dispose();
  });

  it("defers dispose reentered from scene telemetry without mixing lifecycle evidence", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const scene: { children: unknown[] } = { children: [] };
    const pass: RenderPass = { name: "scene", kind: "scene", scene, camera: {} };
    await backend.initialize({ viewport });
    await backend.render([pass]);

    const reentrantDisposals: Promise<void>[] = [];
    let childReads = 0;
    Object.defineProperty(scene, "children", {
      configurable: true,
      get() {
        childReads += 1;
        reentrantDisposals.push(backend.dispose(), backend.dispose());
        return [];
      },
    });

    const observed = backend.snapshotLifecycle();
    expect(observed).toMatchObject({
      state: "ready",
      disposeCalls: 0,
      rendererDisposeInvoked: false,
      rendererDisposeCompleted: false,
      backendDisposeInvoked: false,
      backendDisposeCompleted: false,
      resourceCounterProvenance: "live-renderer-info",
      rendererMemoryComplete: true,
      appOwnership: { renderPasses: 1, sceneObjects: 1 },
      resources: { objects: 1, geometries: 2 },
    });
    expect(renderer.disposed).toBe(false);
    expect(reentrantDisposals).toHaveLength(2);
    expect(reentrantDisposals[1]).toBe(reentrantDisposals[0]);

    const outsideDispose = backend.dispose();
    expect(outsideDispose).toBe(reentrantDisposals[0]);
    await expect(outsideDispose).resolves.toBeUndefined();
    expect(childReads).toBe(2);
    expect(reentrantDisposals.every((promise) => promise === outsideDispose)).toBe(true);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "disposed",
      rendererDisposeInvoked: true,
      rendererDisposeCompleted: true,
      backendDisposeInvoked: true,
      backendDisposeCompleted: true,
      retainedFailureReferences: 0,
      resourceCounterProvenance: "post-renderer-dispose-observation",
    });
  });

  it("uses a deferred dispose promise as an immediate admission gate without deadlock", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const scene: { children: unknown[] } = { children: [] };
    const originalPass: RenderPass = {
      name: "original-scene",
      kind: "scene",
      scene,
      camera: {},
    };
    await backend.initialize({ viewport });
    await backend.render([originalPass]);

    let requestedDispose: Promise<void> | null = null;
    Object.defineProperty(scene, "children", {
      configurable: true,
      get() {
        requestedDispose = backend.dispose();
        return [];
      },
    });
    const requestSnapshot = backend.snapshotLifecycle();
    expect(requestSnapshot).toMatchObject({
      state: "ready",
      disposeCalls: 0,
      renderCalls: 1,
      precompileCalls: 0,
      resizeCalls: 0,
      appOwnership: { renderPasses: 1, eventSubscribers: 0 },
    });
    expect(requestedDispose).not.toBeNull();

    const gatedRendererRender = vi.fn(async () => {
      await requestedDispose!;
    });
    const gatedCompile = vi.fn(async () => undefined);
    renderer.render = gatedRendererRender;
    renderer.compileAsync = gatedCompile;
    const replacementPass: RenderPass = {
      name: "must-not-start",
      kind: "scene",
      scene: {},
      camera: {},
    };
    const rejectedRender = backend.render([replacementPass]).catch(
      (error: unknown) => error,
    );
    const rejectedPrecompile = backend.precompile([replacementPass]).catch(
      (error: unknown) => error,
    );
    expect(() => backend.resize({ width: 900, height: 600, pixelRatio: 2 })).toThrow(
      "Cannot resize Three backend after disposal was requested.",
    );
    const lateListener = vi.fn<(event: BackendRuntimeEvent) => void>();
    const rejectedSubscription = backend.subscribeEvents(lateListener);

    const admissionSnapshot = backend.snapshotLifecycle();
    expect(admissionSnapshot).toMatchObject({
      state: "ready",
      renderCalls: 1,
      precompileCalls: 0,
      resizeCalls: 0,
      appOwnership: { renderPasses: 1, eventSubscribers: 0 },
    });
    expect(admissionSnapshot.resources.objects).toBe(1);
    rejectedSubscription();
    expect(gatedRendererRender).not.toHaveBeenCalled();
    expect(gatedCompile).not.toHaveBeenCalled();
    expect(lateListener).not.toHaveBeenCalled();

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const boundedCompletion = Promise.race([
      Promise.all([requestedDispose!, rejectedRender, rejectedPrecompile]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("deferred disposal deadlocked")), 250);
      }),
    ]);
    const [, renderFailure, precompileFailure] = await boundedCompletion;
    if (timeout !== null) clearTimeout(timeout);
    expect(renderFailure).toMatchObject({
      message: "Cannot render Three backend after disposal was requested.",
    });
    expect(precompileFailure).toMatchObject({
      message: "Cannot precompile Three backend after disposal was requested.",
    });
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "disposed",
      retainedFailureReferences: 0,
    });
  });

  it("rejects initialize inside and outside telemetry once deferred disposal is requested", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const initialization = backend.initialize({ viewport });
    await initialization;
    const scene: { children: unknown[] } = { children: [] };
    const pass: RenderPass = { name: "scene", kind: "scene", scene, camera: {} };
    await backend.render([pass]);

    let requestedDispose: Promise<void> | null = null;
    let insideInitialize: Promise<unknown> | null = null;
    let reenter = true;
    Object.defineProperty(scene, "children", {
      configurable: true,
      get() {
        if (reenter) {
          requestedDispose = backend.dispose();
          insideInitialize = backend.initialize({ viewport }).catch(
            (error: unknown) => error,
          );
        }
        return [];
      },
    });

    const observed = backend.snapshotLifecycle();
    reenter = false;
    expect(observed).toMatchObject({
      state: "ready",
      initializeCalls: 1,
      disposeCalls: 0,
      renderCalls: 1,
      appOwnership: { renderPasses: 1 },
    });
    expect(requestedDispose).not.toBeNull();
    expect(insideInitialize).not.toBeNull();
    const outsideInitialize = backend.initialize({ viewport }).catch(
      (error: unknown) => error,
    );
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "ready",
      initializeCalls: 1,
      renderCalls: 1,
      appOwnership: { renderPasses: 1 },
    });
    expect(renderer.calls.filter((call) => call === "init")).toHaveLength(1);

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const boundedCompletion = Promise.race([
      Promise.all([requestedDispose!, insideInitialize!, outsideInitialize]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("initialize/dispose gate deadlocked")), 250);
      }),
    ]);
    const [, insideFailure, outsideFailure] = await boundedCompletion;
    if (timeout !== null) clearTimeout(timeout);
    expect(insideFailure).toMatchObject({
      message: "Cannot initialize Three backend after disposal was requested.",
    });
    expect(outsideFailure).toMatchObject({
      message: "Cannot initialize Three backend after disposal was requested.",
    });
    expect(insideInitialize).not.toBe(initialization);
    expect(outsideInitialize).not.toBe(initialization);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "disposed",
      initializeCalls: 1,
      retainedFailureReferences: 0,
    });
  });

  it("revokes an unsubscribed listener immediately inside a telemetry getter", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    const unsubscribe = backend.subscribeEvents(listener);
    const scene: { children: unknown[] } = { children: [] };
    const pass: RenderPass = { name: "scene", kind: "scene", scene, camera: {} };
    await backend.initialize({ viewport });
    await backend.render([pass]);

    const diagnostic = new Error("same-stack diagnostic after unsubscribe");
    let reenter = true;
    Object.defineProperty(scene, "children", {
      configurable: true,
      get() {
        if (reenter) {
          unsubscribe();
          backend.diagnostics.emitRendererError(diagnostic);
        }
        return [];
      },
    });

    const observed = backend.snapshotLifecycle();
    reenter = false;
    expect(observed).toMatchObject({
      state: "ready",
      retainedFailureReferences: 0,
      appOwnership: { eventSubscribers: 1 },
      resources: { subscribers: 1 },
    });
    expect(listener).not.toHaveBeenCalled();
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "ready",
      retainedFailureReferences: 2,
      appOwnership: { eventSubscribers: 0 },
      resources: { subscribers: 0 },
    });
    await backend.dispose();
    expect(backend.snapshotLifecycle().retainedFailureReferences).toBe(0);
  });

  it("keeps other public mutations outside a telemetry observation transaction", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const initialization = backend.initialize({ viewport });
    await initialization;
    expect(backend.initialize({ viewport })).toBe(initialization);
    const scene: { children: unknown[] } = { children: [] };
    const pass: RenderPass = { name: "scene", kind: "scene", scene, camera: {} };
    await backend.render([pass]);

    const diagnosticFailure = new Error("deferred telemetry diagnostic");
    const lateListener = vi.fn<(event: BackendRuntimeEvent) => void>();
    let reentrantInitialize: Promise<void> | null = null;
    let resizeFailure: unknown = null;
    let renderFailure: Promise<unknown> | null = null;
    let precompileFailure: Promise<unknown> | null = null;
    let reenter = true;
    Object.defineProperty(scene, "children", {
      configurable: true,
      get() {
        if (reenter) {
          reentrantInitialize = backend.initialize({ viewport });
          try {
            backend.resize({ width: 900, height: 600, pixelRatio: 2 });
          } catch (error: unknown) {
            resizeFailure = error;
          }
          renderFailure = backend.render([]).catch((error: unknown) => error);
          precompileFailure = backend.precompile([]).catch((error: unknown) => error);
          backend.subscribeEvents(lateListener);
          backend.diagnostics.emitRendererError(diagnosticFailure);
        }
        return [];
      },
    });

    const observed = backend.snapshotLifecycle();
    reenter = false;
    expect(observed).toMatchObject({
      state: "ready",
      initializeCalls: 2,
      renderCalls: 1,
      precompileCalls: 0,
      resizeCalls: 0,
      retainedFailureReferences: 0,
      appOwnership: { eventSubscribers: 0 },
    });
    expect(reentrantInitialize).toBe(initialization);
    expect(resizeFailure).toMatchObject({
      message: "Cannot resize Three backend while renderer telemetry observation is active.",
    });
    await expect(renderFailure).resolves.toMatchObject({
      message: "Cannot render Three backend while renderer telemetry observation is active.",
    });
    await expect(precompileFailure).resolves.toMatchObject({
      message: "Cannot precompile Three backend while renderer telemetry observation is active.",
    });
    await Promise.resolve();
    expect(lateListener).not.toHaveBeenCalled();
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "ready",
      initializeCalls: 2,
      renderCalls: 1,
      precompileCalls: 0,
      resizeCalls: 0,
      retainedFailureReferences: 2,
      appOwnership: { eventSubscribers: 0 },
    });
    await backend.dispose();
    expect(backend.snapshotLifecycle().retainedFailureReferences).toBe(0);
  });

  it("bounds corrupt scene child fanout and still completes terminal disposal", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const scene = { children: new Array<unknown>(200_001) };
    const pass: RenderPass = { name: "corrupt-scene", kind: "scene", scene, camera: {} };
    await backend.initialize({ viewport });

    await expect(backend.render([pass])).rejects.toThrow(
      "Scene telemetry exceeded 200000 child references.",
    );
    await expect(backend.dispose()).rejects.toMatchObject({
      message: "Scene telemetry exceeded 200000 child references.",
    });
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      retainedFailureReferences: 0,
      appOwnership: { renderPasses: 0, sceneObjects: 0, eventSubscribers: 0 },
    });
  });

  it("drains concurrent renderer operations before one idempotent disposal", async () => {
    const renderer = fakeRenderer();
    let releaseCompile!: () => void;
    let releaseRender!: () => void;
    const compileGate = new Promise<void>((resolve) => { releaseCompile = resolve; });
    const renderGate = new Promise<void>((resolve) => { releaseRender = resolve; });
    renderer.compileAsync = async () => {
      renderer.calls.push("compile.start");
      await compileGate;
      renderer.calls.push("compile.end");
    };
    renderer.render = async () => {
      renderer.calls.push("render.start");
      await renderGate;
      renderer.calls.push("render.end");
    };
    const backend = adapter(renderer);
    const pass = { name: "scene", kind: "scene", scene: {}, camera: {} };
    await backend.initialize({ viewport });

    const compiling = backend.precompile([pass]);
    const rendering = backend.render([pass]);
    await vi.waitFor(() => {
      expect(renderer.calls).toContain("compile.start");
      expect(renderer.calls).toContain("render.start");
    });

    const firstDispose = backend.dispose();
    const secondDispose = backend.dispose();
    expect(secondDispose).toBe(firstDispose);
    expect(backend.snapshotLifecycle().state).toBe("disposing");
    expect(renderer.disposed).toBe(false);

    const renderStartsWhileDisposing = renderer.calls.filter(
      (call) => call === "render.start",
    ).length;
    await expect(backend.render([pass])).rejects.toThrow("while disposing");
    expect(renderer.calls.filter((call) => call === "render.start")).toHaveLength(
      renderStartsWhileDisposing,
    );

    releaseRender();
    await rendering;
    expect(renderer.disposed).toBe(false);
    releaseCompile();
    await compiling;
    await firstDispose;

    expect(renderer.calls.filter((call) => call === "dispose")).toHaveLength(1);
    expect(renderer.calls.filter((call) => call === "backend.dispose")).toHaveLength(1);
    expect(renderer.calls.indexOf("render.end")).toBeLessThan(renderer.calls.indexOf("dispose"));
    expect(renderer.calls.indexOf("compile.end")).toBeLessThan(renderer.calls.indexOf("dispose"));
    expect(backend.snapshotLifecycle().state).toBe("disposed");

    const renderStartsAfterDispose = renderer.calls.filter(
      (call) => call === "render.start",
    ).length;
    await expect(backend.render([pass])).rejects.toThrow("while disposed");
    expect(renderer.calls.filter((call) => call === "render.start")).toHaveLength(
      renderStartsAfterDispose,
    );
  });

  it("drains a resize that requests disposal before touching the renderer again", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    let reentrantDispose: Promise<void> | null = null;
    let disposedAtResizeSetSize: boolean | null = null;
    renderer.setPixelRatio = (value) => {
      renderer.calls.push(`pixelRatio:${value}`);
      if (value === 2) reentrantDispose = backend.dispose();
    };
    renderer.setSize = (width, height) => {
      renderer.calls.push(`size:${width}x${height}`);
      if (width === 900) disposedAtResizeSetSize = renderer.disposed;
    };
    await backend.initialize({ viewport });

    backend.resize({ width: 900, height: 600, pixelRatio: 2 });

    expect(reentrantDispose).not.toBeNull();
    expect(disposedAtResizeSetSize).toBe(false);
    expect(renderer.disposed).toBe(false);
    await reentrantDispose!;
    expect(renderer.disposed).toBe(true);
    expect(renderer.calls.indexOf("size:900x600")).toBeLessThan(
      renderer.calls.indexOf("dispose"),
    );
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "disposed",
      resizeCalls: 1,
      rendererDisposeCompleted: true,
    });
  });

  it("publishes late structured events and detaches the bridge during disposal", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);
    await backend.initialize({ viewport });

    renderer.onDeviceLost(new Error("test loss"));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      kind: "device-lost",
      occurredAtMs: 42,
    }));
    await backend.dispose();
    renderer.onDeviceLost(new Error("late ignored"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing event subscriber so terminal events still reach later listeners", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const laterListener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(() => { throw new Error("observer failed"); });
    backend.subscribeEvents(laterListener);
    await backend.initialize({ viewport });

    expect(() => renderer.onDeviceLost(new Error("device lost"))).not.toThrow();
    expect(laterListener).toHaveBeenCalledWith(expect.objectContaining({ kind: "device-lost" }));
    await backend.dispose();
  });

  it("chains Three renderer device-loss handling before publishing the adapter event", async () => {
    const renderer = fakeRenderer();
    const originalDeviceLost = vi.fn<(error: unknown) => void>();
    renderer.onDeviceLost = originalDeviceLost;
    const backend = adapter(renderer);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);
    await backend.initialize({ viewport });

    const loss = new Error("device lost");
    renderer.onDeviceLost(loss);
    expect(originalDeviceLost).toHaveBeenCalledOnce();
    expect(originalDeviceLost).toHaveBeenCalledWith(loss);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ kind: "device-lost", error: loss }));

    await backend.dispose();
    renderer.onDeviceLost(new Error("late internal notification"));
    expect(originalDeviceLost).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("reinstalls the event bridge when renderer initialization replaces its callback", async () => {
    const renderer = fakeRenderer();
    const replacement = vi.fn<(error: unknown) => void>();
    renderer.init = async () => {
      renderer.calls.push("init");
      renderer.onDeviceLost = replacement;
    };
    const backend = adapter(renderer);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);
    await backend.initialize({ viewport });

    const loss = new Error("post-init device loss");
    renderer.onDeviceLost(loss);
    expect(replacement).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ kind: "device-lost", error: loss }));
    expect(backend.snapshotLifecycle().eventBridgeActive).toBe(true);

    await backend.dispose();
    renderer.onDeviceLost(new Error("late internal loss"));
    expect(replacement).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("leaves a callback untouched when acquiring it throws and restores the other channel", async () => {
    const renderer = fakeRenderer();
    const readFailure = new Error("onError getter failed");
    const originalDeviceLost = vi.fn<(error: unknown) => void>();
    renderer.onDeviceLost = originalDeviceLost;
    const throwingDescriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: false,
      get: () => { throw readFailure; },
      set: () => undefined,
    };
    Object.defineProperty(renderer, "onError", throwingDescriptor);
    const backend = adapter(renderer);

    await expect(backend.initialize({ viewport })).rejects.toBe(readFailure);

    expect(Object.getOwnPropertyDescriptor(renderer, "onError")).toEqual(throwingDescriptor);
    expect(renderer.onDeviceLost).toBe(originalDeviceLost);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      rendererDisposeCompleted: true,
    });
  });

  it("does not restore over a channel whose descriptor installation never acquired it", async () => {
    const renderer = fakeRenderer();
    const originalOnError = renderer.onError;
    const installFailure = new Error("onError descriptor rejected");
    let onErrorDefinitions = 0;
    const rendererPort = new Proxy(renderer, {
      defineProperty(target, property, descriptor) {
        if (property === "onError") {
          onErrorDefinitions += 1;
          throw installFailure;
        }
        return Reflect.defineProperty(target, property, descriptor);
      },
    }) as ThreeRendererPort;
    const backend = adapter(rendererPort);

    await expect(backend.initialize({ viewport })).rejects.toBe(installFailure);

    expect(onErrorDefinitions).toBe(1);
    expect(renderer.onError).toBe(originalOnError);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      rendererDisposeCompleted: true,
    });
  });

  it("fails closed when a successful installation trap does not acquire the channel", async () => {
    const renderer = fakeRenderer();
    const originalOnError = renderer.onError;
    let onErrorDefinitions = 0;
    const rendererPort = new Proxy(renderer, {
      defineProperty(target, property, descriptor) {
        if (property === "onError") {
          onErrorDefinitions += 1;
          return true;
        }
        return Reflect.defineProperty(target, property, descriptor);
      },
    }) as ThreeRendererPort;
    const backend = adapter(rendererPort);

    await expect(backend.initialize({ viewport })).rejects.toThrow(
      "onError installation postcondition was not satisfied",
    );

    expect(onErrorDefinitions).toBe(1);
    expect(renderer.onError).toBe(originalOnError);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      rendererDisposeCompleted: true,
    });
  });

  it("restores a transformed descriptor acquired by a successful installation trap", async () => {
    const renderer = fakeRenderer();
    const originalOnError = vi.fn<(error: unknown) => void>();
    renderer.onError = originalOnError;
    const originalOnErrorDescriptor = Object.getOwnPropertyDescriptor(renderer, "onError");
    let onErrorDefinitions = 0;
    let transformedBridge: ((error: unknown) => void) | null = null;
    const rendererPort = new Proxy(renderer, {
      defineProperty(target, property, descriptor) {
        if (property === "onError") {
          onErrorDefinitions += 1;
          if (onErrorDefinitions === 1) {
            transformedBridge = descriptor.get?.call(target) as (error: unknown) => void;
            return Reflect.defineProperty(target, property, {
              configurable: true,
              enumerable: descriptor.enumerable,
              value: transformedBridge,
              writable: true,
            });
          }
        }
        return Reflect.defineProperty(target, property, descriptor);
      },
    }) as ThreeRendererPort;
    const backend = adapter(rendererPort);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);

    await expect(backend.initialize({ viewport })).rejects.toThrow(
      "onError installation postcondition was not satisfied",
    );

    expect(onErrorDefinitions).toBe(2);
    expect(Object.getOwnPropertyDescriptor(renderer, "onError")).toEqual(
      originalOnErrorDescriptor,
    );
    expect(rendererPort.onError).toBe(originalOnError);
    expect(transformedBridge).not.toBeNull();
    transformedBridge!(new Error("revoked transformed callback"));
    expect(originalOnError).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    rendererPort.onError(new Error("restored original callback"));
    expect(originalOnError).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      rendererDisposeCompleted: true,
      appOwnership: { eventSubscribers: 0 },
    });
  });

  it("restores a channel when a throwing installation trap acquired its descriptor", async () => {
    const renderer = fakeRenderer();
    const originalOnErrorDescriptor = Object.getOwnPropertyDescriptor(renderer, "onError");
    const installFailure = new Error("onError installed and then rejected");
    let onErrorDefinitions = 0;
    const rendererPort = new Proxy(renderer, {
      defineProperty(target, property, descriptor) {
        if (property === "onError") {
          onErrorDefinitions += 1;
          const installed = Reflect.defineProperty(target, property, descriptor);
          if (onErrorDefinitions === 1) throw installFailure;
          return installed;
        }
        return Reflect.defineProperty(target, property, descriptor);
      },
    }) as ThreeRendererPort;
    const backend = adapter(rendererPort);

    await expect(backend.initialize({ viewport })).rejects.toBe(installFailure);

    expect(onErrorDefinitions).toBe(2);
    expect(Object.getOwnPropertyDescriptor(renderer, "onError")).toEqual(
      originalOnErrorDescriptor,
    );
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      rendererDisposeCompleted: true,
    });
  });

  it("restores a transformed descriptor acquired before an installation trap throws", async () => {
    const renderer = fakeRenderer();
    const originalOnError = vi.fn<(error: unknown) => void>();
    renderer.onError = originalOnError;
    const originalOnErrorDescriptor = Object.getOwnPropertyDescriptor(renderer, "onError");
    const installFailure = new Error("onError transformed and then rejected");
    let onErrorDefinitions = 0;
    let transformedBridge: ((error: unknown) => void) | null = null;
    const rendererPort = new Proxy(renderer, {
      defineProperty(target, property, descriptor) {
        if (property === "onError") {
          onErrorDefinitions += 1;
          if (onErrorDefinitions === 1) {
            transformedBridge = descriptor.get?.call(target) as (error: unknown) => void;
            Reflect.defineProperty(target, property, {
              configurable: true,
              enumerable: descriptor.enumerable,
              value: transformedBridge,
              writable: true,
            });
            throw installFailure;
          }
        }
        return Reflect.defineProperty(target, property, descriptor);
      },
    }) as ThreeRendererPort;
    const backend = adapter(rendererPort);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);

    await expect(backend.initialize({ viewport })).rejects.toBe(installFailure);

    expect(onErrorDefinitions).toBe(2);
    expect(Object.getOwnPropertyDescriptor(renderer, "onError")).toEqual(
      originalOnErrorDescriptor,
    );
    expect(rendererPort.onError).toBe(originalOnError);
    expect(transformedBridge).not.toBeNull();
    transformedBridge!(new Error("revoked transformed callback"));
    expect(originalOnError).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    rendererPort.onError(new Error("restored original callback"));
    expect(originalOnError).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      rendererDisposeCompleted: true,
      appOwnership: { eventSubscribers: 0 },
    });
  });

  it("revokes captured and installed callbacks before a restoration failure", async () => {
    const renderer = fakeRenderer();
    const originalOnError = vi.fn<(error: unknown) => void>();
    renderer.onError = originalOnError;
    const restoreFailure = new Error("onError restoration failed");
    let onErrorDefinitions = 0;
    const rendererPort = new Proxy(renderer, {
      defineProperty(target, property, descriptor) {
        if (property === "onError") {
          onErrorDefinitions += 1;
          if (onErrorDefinitions === 3) throw restoreFailure;
        }
        return Reflect.defineProperty(target, property, descriptor);
      },
    }) as ThreeRendererPort;
    const backend = adapter(rendererPort);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);
    await backend.initialize({ viewport });
    const capturedBridge = rendererPort.onError;

    const disposalFailure = await backend.dispose().catch((error: unknown) => error) as Error;
    expect(disposalFailure).not.toBe(restoreFailure);
    expect(disposalFailure).toMatchObject({ message: restoreFailure.message });
    expect(Object.isFrozen(disposalFailure)).toBe(true);
    const strandedBridge = rendererPort.onError;
    expect(() => capturedBridge(new Error("captured callback after disposal"))).not.toThrow();
    expect(() => strandedBridge(new Error("stranded callback after disposal"))).not.toThrow();

    expect(onErrorDefinitions).toBe(3);
    expect(originalOnError).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      appOwnership: { eventSubscribers: 0 },
    });
  });

  it("fails honestly and revokes both channels when restore and delete traps are no-ops", async () => {
    const renderer = fakeRenderer();
    const originalOnError = vi.fn<(error: unknown) => void>();
    const inheritedDeviceLost = vi.fn<(error: unknown) => void>();
    renderer.onError = originalOnError;
    Reflect.deleteProperty(renderer, "onDeviceLost");
    Object.setPrototypeOf(renderer, { onDeviceLost: inheritedDeviceLost });
    let onErrorDefinitions = 0;
    let onDeviceLostDeletes = 0;
    const rendererPort = new Proxy(renderer, {
      defineProperty(target, property, descriptor) {
        if (property === "onError") {
          onErrorDefinitions += 1;
          if (onErrorDefinitions === 3) return true;
        }
        return Reflect.defineProperty(target, property, descriptor);
      },
      deleteProperty(target, property) {
        if (property === "onDeviceLost") {
          onDeviceLostDeletes += 1;
          return true;
        }
        return Reflect.deleteProperty(target, property);
      },
    }) as ThreeRendererPort;
    const backend = adapter(rendererPort);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);
    await backend.initialize({ viewport });

    const failure = await backend.dispose().catch((error: unknown) => error) as AggregateError;
    const strandedOnError = rendererPort.onError;
    const strandedDeviceLost = rendererPort.onDeviceLost;
    expect(() => strandedOnError(new Error("stranded renderer error"))).not.toThrow();
    expect(() => strandedDeviceLost(new Error("stranded device loss"))).not.toThrow();

    expect(failure).toBeInstanceOf(AggregateError);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.errors)).toBe(true);
    expect(failure.errors.map((error) => (error as Error).message)).toEqual([
      "Renderer event callback onError restoration postcondition was not satisfied.",
      "Renderer event callback onDeviceLost removal postcondition was not satisfied.",
    ]);
    expect(onErrorDefinitions).toBe(3);
    expect(onDeviceLostDeletes).toBe(1);
    expect(originalOnError).not.toHaveBeenCalled();
    expect(inheritedDeviceLost).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      appOwnership: { eventSubscribers: 0 },
    });
  });

  it("delivers one event to the listener snapshot even when an earlier listener unsubscribes it", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const later = vi.fn<(event: BackendRuntimeEvent) => void>();
    let unsubscribeLater: () => void = () => undefined;
    backend.subscribeEvents(() => unsubscribeLater());
    unsubscribeLater = backend.subscribeEvents(later);
    await backend.initialize({ viewport });

    renderer.onError(new Error("renderer error"));
    expect(later).toHaveBeenCalledOnce();
    renderer.onError(new Error("second renderer error"));
    expect(later).toHaveBeenCalledOnce();
    await backend.dispose();
  });

  it("stops multi-pass rendering after the first bridged renderer failure", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const renderError = new Error("first pass renderer failure");
    let renderCalls = 0;
    renderer.render = () => {
      renderCalls += 1;
      if (renderCalls === 1) renderer.onError(renderError);
    };
    const passes: RenderPass[] = [
      { name: "first", kind: "scene", scene: {}, camera: {} },
      { name: "second", kind: "scene", scene: {}, camera: {} },
    ];
    await backend.initialize({ viewport });

    await expect(backend.render(passes)).rejects.toBe(renderError);
    expect(renderCalls).toBe(1);
    await backend.dispose();
  });

  it("stops multi-pass precompile after the first bridged device loss", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const deviceLoss = new Error("first compile device loss");
    let compileCalls = 0;
    renderer.compileAsync = async () => {
      compileCalls += 1;
      if (compileCalls === 1) renderer.onDeviceLost(deviceLoss);
    };
    const passes: RenderPass[] = [
      { name: "first", kind: "scene", scene: {}, camera: {} },
      { name: "second", kind: "scene", scene: {}, camera: {} },
    ];
    await backend.initialize({ viewport });

    await expect(backend.precompile(passes)).rejects.toBe(deviceLoss);
    expect(compileCalls).toBe(1);
    await backend.dispose();
  });

  it("rejects empty render and precompile without mutating evidence after a latched fault", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    const failure = new Error("latched renderer failure");
    renderer.onError(failure);

    await expect(backend.render([])).rejects.toBe(failure);
    await expect(backend.precompile([])).rejects.toBe(failure);
    expect(backend.snapshotLifecycle()).toMatchObject({
      renderCalls: 0,
      precompileCalls: 0,
      appOwnership: { renderPasses: 0 },
    });
    await backend.dispose();
  });

  it("refuses subscribers added reentrantly after the first runtime fault is latched", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const late = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(() => {
      backend.subscribeEvents(late);
    });
    await backend.initialize({ viewport });

    renderer.onDeviceLost(new Error("terminal loss"));
    expect(late).not.toHaveBeenCalled();
    expect(backend.snapshotLifecycle().appOwnership.eventSubscribers).toBe(1);
    renderer.onError(new Error("later error"));
    expect(late).not.toHaveBeenCalled();
    await backend.dispose();
  });

  it("invokes backend disposal once when renderer disposal also schedules it", async () => {
    const renderer = fakeRenderer();
    let nativeBackendDisposeCalls = 0;
    renderer.backend!.dispose = () => {
      nativeBackendDisposeCalls += 1;
    };
    renderer.dispose = () => {
      renderer.calls.push("dispose");
      queueMicrotask(() => renderer.backend!.dispose!());
    };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });

    await backend.dispose();
    await Promise.resolve();
    expect(nativeBackendDisposeCalls).toBe(1);
    expect(backend.snapshotLifecycle()).toMatchObject({
      backendDisposeInvoked: true,
      backendDisposeCompleted: true,
    });
  });

  it("does not double-call a native backend disposer captured before instrumentation", async () => {
    const renderer = fakeRenderer();
    let nativeDisposeCalls = 0;
    renderer.backend!.dispose = () => {
      nativeDisposeCalls += 1;
    };
    const capturedNativeDispose = renderer.backend!.dispose;
    renderer.dispose = () => {
      capturedNativeDispose!();
    };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    const capturedInstrumentedDispose = renderer.backend!.dispose!;

    await expect(backend.dispose()).rejects.toThrow(
      "without an observable backend disposal call",
    );
    expect(nativeDisposeCalls).toBe(1);
    capturedInstrumentedDispose();
    expect(nativeDisposeCalls).toBe(1);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      backendDisposeInvoked: false,
      backendDisposeCompleted: false,
    });
  });

  it("retains a backend disposal error even when renderer disposal swallows it", async () => {
    const renderer = fakeRenderer();
    const backendDisposeError = new Error("native backend disposal failed");
    renderer.backend!.dispose = () => {
      throw backendDisposeError;
    };
    renderer.dispose = () => {
      try {
        renderer.backend!.dispose!();
      } catch {
        // Reproduces a renderer that catches its backend cleanup rejection.
      }
    };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });

    const firstDispose = backend.dispose();
    const repeatedDispose = backend.dispose();
    expect(repeatedDispose).toBe(firstDispose);
    await expect(firstDispose).rejects.toMatchObject({ message: backendDisposeError.message });
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      rendererDisposeCompleted: true,
      backendDisposeInvoked: true,
      backendDisposeCompleted: false,
      retainedFailureReferences: 0,
    });
  });

  it("snapshots a swallowed native backend error before a microtask mutates it", async () => {
    const renderer = fakeRenderer();
    const nativeFailure = new Error("native backend failure before mutation");
    renderer.backend!.dispose = () => {
      queueMicrotask(() => {
        nativeFailure.message = "native backend failure after mutation";
      });
      throw nativeFailure;
    };
    renderer.dispose = () => {
      try {
        renderer.backend!.dispose!();
      } catch {
        // The wrapper must preserve evidence even when Three swallows it.
      }
    };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });

    const failure = await backend.dispose().catch((error: unknown) => error) as Error;
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBe(nativeFailure);
    expect(failure.message).toBe("native backend failure before mutation");
    expect(Object.isFrozen(failure)).toBe(true);
    expect(nativeFailure.message).toBe("native backend failure after mutation");
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      backendDisposeInvoked: true,
      backendDisposeCompleted: false,
      retainedFailureReferences: 0,
    });
  });

  it("carries pre-cleanup native failure evidence into one stable adapter disposal", async () => {
    const renderer = fakeRenderer();
    const nativeFailure = new Error("pre-cleanup native failure before mutation");
    renderer.backend!.dispose = () => {
      queueMicrotask(() => {
        nativeFailure.message = "pre-cleanup native failure after mutation";
      });
      throw nativeFailure;
    };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });

    let directFailure: unknown = null;
    try {
      renderer.backend!.dispose!();
    } catch (error: unknown) {
      directFailure = error;
    }
    expect(directFailure).toBe(nativeFailure);
    await Promise.resolve();
    expect(nativeFailure.message).toBe("pre-cleanup native failure after mutation");
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "ready",
      backendDisposeInvoked: true,
      backendDisposeCompleted: false,
      retainedFailureReferences: 1,
    });

    const disposal = backend.dispose();
    const repeatedDisposal = backend.dispose();
    expect(repeatedDisposal).toBe(disposal);
    const failure = await disposal.catch((error: unknown) => error) as Error;
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBe(nativeFailure);
    expect(failure.message).toBe("pre-cleanup native failure before mutation");
    expect(Object.isFrozen(failure)).toBe(true);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      rendererDisposeCompleted: true,
      backendDisposeInvoked: true,
      backendDisposeCompleted: false,
      retainedFailureReferences: 0,
    });
  });

  it.each([null, undefined] as const)(
    "preserves a pre-cleanup native %s failure with an explicit presence flag",
    async (sentinel) => {
      const renderer = fakeRenderer();
      renderer.backend!.dispose = () => { throw sentinel; };
      const backend = adapter(renderer);
      await backend.initialize({ viewport });

      let directRejected = false;
      let directFailure: unknown = "not thrown";
      try {
        renderer.backend!.dispose!();
      } catch (error: unknown) {
        directRejected = true;
        directFailure = error;
      }
      expect(directRejected).toBe(true);
      expect(directFailure).toBe(sentinel);
      expect(backend.snapshotLifecycle().retainedFailureReferences).toBe(1);

      const firstDispose = backend.dispose();
      const secondDispose = backend.dispose();
      expect(secondDispose).toBe(firstDispose);
      let disposalRejected = false;
      let disposalFailure: unknown = "not rejected";
      try {
        await firstDispose;
      } catch (error: unknown) {
        disposalRejected = true;
        disposalFailure = error;
      }
      expect(disposalRejected).toBe(true);
      expect(disposalFailure).toBe(sentinel);
      expect(backend.snapshotLifecycle()).toMatchObject({
        state: "failed",
        backendDisposeInvoked: true,
        backendDisposeCompleted: false,
        retainedFailureReferences: 0,
      });
    },
  );

  it("records one native propagation and a later independent reuse as two occurrences", async () => {
    const renderer = fakeRenderer();
    const stableMemory = renderer.info!.memory!;
    const nativeFailure = new Error("shared native and telemetry failure");
    renderer.backend!.dispose = () => { throw nativeFailure; };
    renderer.dispose = () => {
      renderer.calls.push("dispose");
      renderer.backend!.dispose!();
    };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    let infoReads = 0;
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() {
        infoReads += 1;
        if (infoReads === 1) renderer.backend!.dispose!();
        if (infoReads === 2) throw nativeFailure;
        return { memory: stableMemory };
      },
    });

    const failure = await backend.dispose().catch((error: unknown) => error) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors.map((error) => (error as Error).message)).toEqual([
      nativeFailure.message,
      nativeFailure.message,
    ]);
    expect(failure.errors[0]).not.toBe(nativeFailure);
    expect(failure.errors[1]).not.toBe(nativeFailure);
    expect(infoReads).toBe(2);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      backendDisposeInvoked: true,
      backendDisposeCompleted: false,
      retainedFailureReferences: 0,
    });
  });

  it("keeps an initial-telemetry native throw as the sole primary failure", async () => {
    const renderer = fakeRenderer();
    const stableMemory = renderer.info!.memory!;
    const nativeFailure = new Error("initial telemetry native primary");
    renderer.backend!.dispose = () => { throw nativeFailure; };
    renderer.dispose = () => {
      renderer.calls.push("dispose");
      renderer.backend!.dispose!();
    };
    let infoReads = 0;
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() {
        infoReads += 1;
        if (infoReads === 1) renderer.backend!.dispose!();
        return { memory: stableMemory };
      },
    });
    const backend = adapter(renderer);

    const initialization = backend.initialize({ viewport });
    const repeatedInitialization = backend.initialize({ viewport });
    expect(repeatedInitialization).toBe(initialization);
    await expect(initialization).rejects.toBe(nativeFailure);
    expect(infoReads).toBe(3);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      backendDisposeInvoked: true,
      backendDisposeCompleted: false,
      retainedFailureReferences: 0,
    });
  });

  it("defers reentrant disposal until hostile native evidence capture is published", async () => {
    const renderer = fakeRenderer();
    const hostileFailure = new Error();
    let messageReads = 0;
    let reentrantDispose: Promise<void> | null = null;
    Object.defineProperty(hostileFailure, "message", {
      configurable: true,
      get() {
        messageReads += 1;
        reentrantDispose = backend.dispose();
        return "hostile native message before publication";
      },
    });
    renderer.backend!.dispose = () => { throw hostileFailure; };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });

    let directFailure: unknown = null;
    try {
      renderer.backend!.dispose!();
    } catch (error: unknown) {
      directFailure = error;
    }
    expect(directFailure).toBe(hostileFailure);
    expect(messageReads).toBe(1);
    expect(reentrantDispose).not.toBeNull();
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "ready",
      disposeCalls: 1,
      retainedFailureReferences: 1,
      backendDisposeInvoked: true,
      backendDisposeCompleted: false,
    });
    const repeatedDispose = backend.dispose();
    expect(repeatedDispose).toBe(reentrantDispose);

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const boundedFailure = Promise.race([
      reentrantDispose!.then(
        () => ({ resolved: true as const, error: null as unknown }),
        (error: unknown) => ({ resolved: false as const, error }),
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("hostile evidence disposal deadlocked")), 250);
      }),
    ]);
    const outcome = await boundedFailure;
    if (timeout !== null) clearTimeout(timeout);
    expect(outcome.resolved).toBe(false);
    expect(outcome.error).toMatchObject({
      message: "hostile native message before publication",
    });
    expect(Object.isFrozen(outcome.error)).toBe(true);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      retainedFailureReferences: 0,
      backendDisposeInvoked: true,
      backendDisposeCompleted: false,
    });
  });

  it("preserves own primitive AggregateError causes for empty and nonempty evidence", async () => {
    const snapshotAggregate = async (source: AggregateError): Promise<AggregateError> => {
      const renderer = fakeRenderer();
      renderer.dispose = () => { throw source; };
      const backend = adapter(renderer);
      await backend.initialize({ viewport });
      const failure = await backend.dispose().catch((error: unknown) => error) as AggregateError;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(Object.isFrozen(failure)).toBe(true);
      expect(Object.isFrozen(failure.errors)).toBe(true);
      expect(backend.snapshotLifecycle()).toMatchObject({
        state: "failed",
        retainedFailureReferences: 0,
      });
      return failure;
    };

    const absent = await snapshotAggregate(new AggregateError([], "absent cause"));
    expect(Object.prototype.hasOwnProperty.call(absent, "cause")).toBe(false);

    const primitiveCauses: readonly unknown[] = [
      undefined,
      null,
      Number.NaN,
      -0,
      +0,
      42,
      "",
      "nonempty cause",
    ];
    for (const cause of primitiveCauses) {
      for (const nonempty of [false, true]) {
        const sourceEntry = new Error("aggregate entry");
        const source = new AggregateError(
          nonempty ? [sourceEntry] : [],
          "primitive cause",
          { cause },
        );
        const failure = await snapshotAggregate(source);
        expect(Object.prototype.hasOwnProperty.call(failure, "cause")).toBe(true);
        expect(Object.is(failure.cause, cause)).toBe(true);
        expect(failure.errors).toHaveLength(nonempty ? 1 : 0);
        if (nonempty) {
          expect(failure.errors[0]).not.toBe(sourceEntry);
          expect(Object.isFrozen(failure.errors[0])).toBe(true);
        }
      }
    }
  });

  it("keeps AggregateError subtype and primitive cause when error details are invalid", async () => {
    const snapshotAggregate = async (source: AggregateError): Promise<AggregateError> => {
      const renderer = fakeRenderer();
      renderer.dispose = () => { throw source; };
      const backend = adapter(renderer);
      await backend.initialize({ viewport });
      const firstDisposal = backend.dispose();
      expect(backend.dispose()).toBe(firstDisposal);
      const failure = await firstDisposal.catch((error: unknown) => error) as AggregateError;
      expect(backend.snapshotLifecycle()).toMatchObject({
        state: "failed",
        retainedFailureReferences: 0,
      });
      return failure;
    };

    const tooWide = new AggregateError(
      Array.from({ length: 257 }, (_, index) => new Error(`wide ${index}`)),
      "too-wide aggregate",
      { cause: -0 },
    );
    const infiniteLength = new AggregateError([], "infinite aggregate", { cause: Number.NaN });
    Object.defineProperty(infiniteLength, "errors", {
      configurable: true,
      value: new Proxy([], {
        get(target, property, receiver) {
          if (property === "length") return Number.POSITIVE_INFINITY;
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    const throwingLength = new AggregateError([], "throwing aggregate", { cause: undefined });
    Object.defineProperty(throwingLength, "errors", {
      configurable: true,
      value: new Proxy([], {
        get(target, property, receiver) {
          if (property === "length") throw new Error("hostile errors length");
          return Reflect.get(target, property, receiver);
        },
      }),
    });

    for (const [source, cause] of [
      [tooWide, -0],
      [infiniteLength, Number.NaN],
      [throwingLength, undefined],
    ] as const) {
      const failure = await snapshotAggregate(source);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(Object.is(failure, source)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(failure, "cause")).toBe(true);
      expect(Object.is(failure.cause, cause)).toBe(true);
      expect(failure.errors).toHaveLength(1);
      expect(failure.errors[0]).toBeInstanceOf(Error);
      expect((failure.errors[0] as Error).message).toBe(
        "Aggregate failure details were invalid or exceeded the snapshot width limit.",
      );
      expect(Object.isFrozen(failure.errors[0])).toBe(true);
      expect(Object.isFrozen(failure.errors)).toBe(true);
      expect(Object.isFrozen(failure)).toBe(true);
    }
  });

  it("detaches object, function, and accessor AggregateError causes without reading them", async () => {
    const snapshotAggregate = async (source: AggregateError): Promise<AggregateError> => {
      const renderer = fakeRenderer();
      renderer.dispose = () => { throw source; };
      const backend = adapter(renderer);
      await backend.initialize({ viewport });
      const failure = await backend.dispose().catch((error: unknown) => error) as AggregateError;
      expect(backend.snapshotLifecycle().retainedFailureReferences).toBe(0);
      return failure;
    };

    const objectCause: { self?: unknown } = {};
    objectCause.self = objectCause;
    const functionCause = () => objectCause;
    const objectFailure = await snapshotAggregate(new AggregateError(
      [],
      "object cause",
      { cause: objectCause },
    ));
    const functionFailure = await snapshotAggregate(new AggregateError(
      [],
      "function cause",
      { cause: functionCause },
    ));
    let accessorReads = 0;
    const accessorSource = new AggregateError([], "accessor cause");
    Object.defineProperty(accessorSource, "cause", {
      configurable: true,
      get() {
        accessorReads += 1;
        return accessorSource;
      },
    });
    const accessorFailure = await snapshotAggregate(accessorSource);

    for (const [failure, rawCause, expectedMessage] of [
      [objectFailure, objectCause, "Aggregate failure cause object was detached."],
      [functionFailure, functionCause, "Aggregate failure cause object was detached."],
      [accessorFailure, accessorSource, "Aggregate failure cause accessor was detached."],
    ] as const) {
      expect(Object.prototype.hasOwnProperty.call(failure, "cause")).toBe(true);
      expect(failure.cause).toBeInstanceOf(Error);
      expect(Object.is(failure.cause, rawCause)).toBe(false);
      expect((failure.cause as Error).message).toBe(expectedMessage);
      expect(Object.isFrozen(failure.cause)).toBe(true);
      expect(Object.isFrozen(failure)).toBe(true);
      expect(Object.isFrozen(failure.errors)).toBe(true);
    }
    expect(accessorReads).toBe(0);
  });

  it("charges aggregate causes to one bounded cleanup evidence budget", async () => {
    let accessorReads = 0;
    const explosive = (label: string): unknown => {
      let graph: unknown = new Error(`${label} cause-bearing leaf`);
      for (let depth = 0; depth < 8; depth += 1) {
        const aggregate = new AggregateError(
          Array.from({ length: 32 }, () => graph),
          `${label} cause-bearing fanout ${depth}`,
          { cause: depth },
        );
        if (depth % 4 === 1) {
          Object.defineProperty(aggregate, "cause", {
            configurable: true,
            value: { label, depth, graph },
          });
        } else if (depth % 4 === 2) {
          Object.defineProperty(aggregate, "cause", {
            configurable: true,
            value: () => graph,
          });
        } else if (depth % 4 === 3) {
          Object.defineProperty(aggregate, "cause", {
            configurable: true,
            get() {
              accessorReads += 1;
              return graph;
            },
          });
        }
        graph = aggregate;
      }
      return graph;
    };

    const renderer = fakeRenderer();
    const beforeTelemetry = explosive("before telemetry");
    const rendererFailure = explosive("renderer dispose");
    const afterTelemetry = explosive("after telemetry");
    renderer.dispose = () => { throw rendererFailure; };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    let infoReads = 0;
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() {
        infoReads += 1;
        throw infoReads === 1 ? beforeTelemetry : afterTelemetry;
      },
    });

    const disposal = backend.dispose();
    expect(backend.dispose()).toBe(disposal);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const failure = await Promise.race([
      disposal.then(
        () => { throw new Error("cause-bearing cleanup unexpectedly resolved"); },
        (error: unknown) => error,
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("cause-bearing cleanup deadlocked")), 250);
      }),
    ]).finally(() => {
      if (timeout !== null) clearTimeout(timeout);
    });

    const pending: unknown[] = [failure];
    let evidenceNodes = 0;
    let aggregateCauseNodes = 0;
    let totalBudgetMarkers = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      evidenceNodes += 1;
      if (current instanceof AggregateError) {
        pending.push(...current.errors);
        if (Object.prototype.hasOwnProperty.call(current, "cause")) {
          aggregateCauseNodes += 1;
          pending.push(current.cause);
        }
      } else if (current instanceof Error) {
        if (current.message.includes("total node limit")) totalBudgetMarkers += 1;
        if (Object.prototype.hasOwnProperty.call(current, "cause")) {
          pending.push(current.cause);
        }
      }
    }

    expect(infoReads).toBe(2);
    expect(accessorReads).toBe(0);
    expect(aggregateCauseNodes).toBeGreaterThan(0);
    expect(totalBudgetMarkers).toBeGreaterThan(0);
    expect(evidenceNodes).toBeLessThanOrEqual(2_100);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      retainedFailureReferences: 0,
    });
  });

  it("bounds shared-child failure fanout with one total snapshot budget", async () => {
    const renderer = fakeRenderer();
    const explosive = (label: string): unknown => {
      let graph: unknown = new Error(`${label} shared failure leaf`);
      for (let depth = 0; depth < 8; depth += 1) {
        graph = new AggregateError(
          Array.from({ length: 32 }, () => graph),
          `${label} shared fanout level ${depth}`,
        );
      }
      return graph;
    };
    const beforeTelemetry = explosive("before telemetry");
    const rendererFailure = explosive("renderer dispose");
    const afterTelemetry = explosive("after telemetry");
    renderer.dispose = () => { throw rendererFailure; };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    let infoReads = 0;
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() {
        infoReads += 1;
        throw infoReads === 1 ? beforeTelemetry : afterTelemetry;
      },
    });

    const failure = await backend.dispose().catch((error: unknown) => error);
    const pending: unknown[] = [failure];
    let evidenceNodes = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      evidenceNodes += 1;
      if (current instanceof AggregateError) pending.push(...current.errors);
      else if (current instanceof Error && Object.prototype.hasOwnProperty.call(current, "cause")) {
        pending.push(current.cause);
      }
    }

    expect(evidenceNodes).toBeLessThanOrEqual(2_100);
    expect(infoReads).toBe(2);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      retainedFailureReferences: 0,
    });
  });

  it("treats renderer throw null as a real cleanup failure", async () => {
    const renderer = fakeRenderer();
    renderer.dispose = () => { throw null; };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });

    const outcome = await backend.dispose().then(
      () => ({ resolved: true as const, error: null as unknown }),
      (error: unknown) => ({ resolved: false as const, error }),
    );
    expect(outcome).toEqual({ resolved: false, error: null });
    expect(backend.snapshotLifecycle().state).toBe("failed");
  });

  it("treats swallowed backend throw undefined as a real cleanup failure", async () => {
    const renderer = fakeRenderer();
    renderer.backend!.dispose = () => { throw undefined; };
    renderer.dispose = () => {
      try {
        renderer.backend!.dispose!();
      } catch {
        // The adapter must retain the instrumented failure independently.
      }
    };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });

    const outcome = await backend.dispose().then(
      () => ({ resolved: true as const, error: null as unknown }),
      (error: unknown) => ({ resolved: false as const, error }),
    );
    expect(outcome).toEqual({ resolved: false, error: undefined });
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      backendDisposeInvoked: true,
      backendDisposeCompleted: false,
    });
  });

  it("distinguishes negative and positive zero cleanup occurrences", async () => {
    const renderer = fakeRenderer();
    renderer.backend!.dispose = () => { throw +0; };
    renderer.dispose = () => {
      try {
        renderer.backend!.dispose!();
      } catch {
        throw -0;
      }
    };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });

    const failure = await backend.dispose().catch((error: unknown) => error) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toHaveLength(2);
    expect(Object.is(failure.errors[0], +0)).toBe(true);
    expect(Object.is(failure.errors[1], -0)).toBe(true);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      retainedFailureReferences: 0,
    });
  });

  it("uses SameValue semantics to deduplicate a propagated NaN cleanup failure", async () => {
    const renderer = fakeRenderer();
    renderer.backend!.dispose = () => { throw Number.NaN; };
    renderer.dispose = () => {
      try {
        renderer.backend!.dispose!();
      } catch {
        throw Number.NaN;
      }
    };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });

    let rejected = false;
    let failure: unknown = null;
    try {
      await backend.dispose();
    } catch (error: unknown) {
      rejected = true;
      failure = error;
    }
    expect(rejected).toBe(true);
    expect(Object.is(failure, Number.NaN)).toBe(true);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      retainedFailureReferences: 0,
    });
  });

  it("returns stable initialize and dispose promises during synchronous renderer reentry", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    let reentrantInitialize: Promise<void> | null = null;
    let reentrantDispose: Promise<void> | null = null;
    renderer.init = async () => {
      reentrantInitialize = backend.initialize({ viewport });
    };
    const originalDispose = renderer.dispose.bind(renderer);
    renderer.dispose = () => {
      reentrantDispose = backend.dispose();
      originalDispose();
    };
    const initialization = backend.initialize({ viewport });
    expect(reentrantInitialize).toBe(initialization);
    await initialization;
    const disposal = backend.dispose();
    expect(reentrantDispose).toBe(disposal);
    await disposal;
    expect(backend.snapshotLifecycle()).toMatchObject({ state: "disposed", disposeCalls: 2 });
  });

  it("preserves non-zero renderer counters instead of self-attesting zero after a leaky dispose", async () => {
    const renderer = fakeRenderer();
    renderer.dispose = function disposeWithoutRelease() {
      this.calls.push("dispose-without-release");
      this.disposed = true;
    };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    await expect(backend.dispose()).rejects.toThrow(
      "without an observable backend disposal call",
    );

    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      rendererDisposeInvoked: true,
      rendererDisposeCompleted: true,
      backendDisposeInvoked: false,
      backendDisposeCompleted: false,
      resourceCounterProvenance: "post-renderer-dispose-observation",
      threeInfoResetObserved: false,
      resources: {
        geometries: 2,
        textures: 1,
        renderTargets: 1,
        programs: 2,
      },
    });
  });

  it("rejects initialize after disposal instead of returning a stale fulfilled promise", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    await backend.dispose();

    await expect(backend.initialize({ viewport })).rejects.toThrow("while disposed");
    expect(renderer.calls.filter((call) => call === "init")).toHaveLength(1);
    expect(backend.snapshotLifecycle().state).toBe("disposed");
  });

  it("clears all ownership and preserves counters when renderer disposal throws", async () => {
    const renderer = fakeRenderer();
    let disposeAttempts = 0;
    renderer.dispose = () => {
      disposeAttempts += 1;
      throw new Error("dispose failed");
    };
    const backend = adapter(renderer);
    backend.subscribeEvents(() => undefined);
    await backend.initialize({ viewport });

    const first = backend.dispose();
    const second = backend.dispose();
    expect(first).toBe(second);
    await expect(first).rejects.toThrow("dispose failed");
    await expect(second).rejects.toThrow("dispose failed");
    expect(disposeAttempts).toBe(1);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      rendererDisposeInvoked: true,
      rendererDisposeCompleted: false,
      backendDisposeCompleted: false,
      resources: {
        geometries: 2,
        textures: 1,
        renderTargets: 1,
        programs: 2,
        subscribers: 0,
      },
    });
    await expect(backend.initialize({ viewport })).rejects.toThrow("while failed");
  });

  it("does not treat Three-style zeroed counters as release proof when backend disposal throws", async () => {
    const renderer = fakeRenderer();
    renderer.backend!.dispose = () => { throw new Error("GPU backend cleanup failed"); };
    const backend = adapter(renderer);
    await backend.initialize({ viewport });

    await expect(backend.dispose()).rejects.toThrow("GPU backend cleanup failed");
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      rendererDisposeInvoked: true,
      rendererDisposeCompleted: false,
      backendDisposeInstrumented: true,
      backendDisposeInvoked: true,
      backendDisposeCompleted: false,
      resourceCounterProvenance: "post-renderer-dispose-observation",
      threeInfoResetObserved: true,
      resourcesBeforeRendererDispose: { geometries: 2, programs: 2 },
      resources: { geometries: 0, programs: 0 },
    });
  });

  it("disposes and clears subscribers after partial initialization failure", async () => {
    const renderer = fakeRenderer();
    renderer.init = async () => { throw new Error("init failed"); };
    const backend = adapter(renderer);
    backend.subscribeEvents(() => undefined);

    await expect(backend.initialize({ viewport })).rejects.toThrow("init failed");
    expect(renderer.disposed).toBe(true);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      resources: { subscribers: 0 },
    });
  });

  it("preserves both initialization and cleanup errors while releasing references", async () => {
    const renderer = fakeRenderer();
    renderer.init = async () => { throw new Error("init failed"); };
    renderer.dispose = () => { throw new Error("cleanup failed"); };
    const backend = adapter(renderer);
    backend.subscribeEvents(() => undefined);

    const failure = await backend.initialize({ viewport }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen((failure as AggregateError).errors)).toBe(true);
    expect((failure as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual(["init failed", "cleanup failed"]);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      rendererDisposeInvoked: true,
      resources: { subscribers: 0, geometries: 2, programs: 2 },
    });
    await expect(backend.dispose()).resolves.toBeUndefined();
    await expect(backend.initialize({ viewport })).rejects.toThrow("while failed");
  });

  it("snapshots a mutable cyclic init-cleanup suffix at ingress while preserving the primary", async () => {
    const renderer = fakeRenderer();
    const primary = new Error("primary initialization provenance");
    const mutableLeaf = new Error("cleanup leaf before mutation");
    const cleanup = new AggregateError([mutableLeaf], "cyclic cleanup before mutation");
    cleanup.errors.push(cleanup);
    renderer.init = async () => { throw primary; };
    renderer.dispose = () => {
      queueMicrotask(() => {
        mutableLeaf.message = "cleanup leaf after mutation";
        cleanup.message = "cyclic cleanup after mutation";
        cleanup.errors.splice(0, cleanup.errors.length, new Error("replacement"));
      });
      throw cleanup;
    };
    const backend = adapter(renderer);

    const initialization = backend.initialize({ viewport });
    const repeatedInitialization = backend.initialize({ viewport });
    expect(repeatedInitialization).toBe(initialization);
    const failure = await initialization.catch((error: unknown) => error) as AggregateError;

    expect(failure).toBeInstanceOf(AggregateError);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.errors)).toBe(true);
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(primary);
    const cleanupSnapshot = failure.errors[1] as AggregateError;
    expect(cleanupSnapshot).toBeInstanceOf(AggregateError);
    expect(cleanupSnapshot).not.toBe(cleanup);
    expect(cleanupSnapshot.message).toBe("cyclic cleanup before mutation");
    expect(Object.isFrozen(cleanupSnapshot)).toBe(true);
    expect(Object.isFrozen(cleanupSnapshot.errors)).toBe(true);
    expect((cleanupSnapshot.errors[0] as Error).message).toBe(
      "cleanup leaf before mutation",
    );
    expect((cleanupSnapshot.errors[1] as Error).message).toBe(
      "Cyclic backend failure evidence was sanitized.",
    );
    expect(mutableLeaf.message).toBe("cleanup leaf after mutation");
    expect(cleanup.message).toBe("cyclic cleanup after mutation");
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      retainedFailureReferences: 0,
    });
  });

  it("preserves repeated object cleanup occurrences at their individual ingress states", async () => {
    const renderer = fakeRenderer();
    const primary = new Error("repeated cleanup primary");
    const recurring = new Error("resource failure before renderer disposal");
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() { throw recurring; },
    });
    renderer.init = async () => { throw primary; };
    renderer.dispose = () => {
      recurring.message = "resource failure after renderer disposal";
      renderer.backend?.dispose?.();
    };
    const backend = adapter(renderer);

    const failure = await backend.initialize({ viewport }).catch(
      (error: unknown) => error,
    ) as AggregateError;

    expect(failure.errors).toHaveLength(3);
    expect(failure.errors[0]).toBe(primary);
    expect((failure.errors[1] as Error).message).toBe(
      "resource failure before renderer disposal",
    );
    expect((failure.errors[2] as Error).message).toBe(
      "resource failure after renderer disposal",
    );
    expect(failure.errors[1]).not.toBe(recurring);
    expect(failure.errors[2]).not.toBe(recurring);
    expect(backend.snapshotLifecycle().retainedFailureReferences).toBe(0);
  });

  it("shares one bounded evidence budget across every init-cleanup occurrence", async () => {
    const renderer = fakeRenderer();
    const primary = new Error("bounded initialization primary");
    const explosive = (label: string): unknown => {
      let graph: unknown = new Error(`${label} leaf`);
      for (let depth = 0; depth < 8; depth += 1) {
        graph = new AggregateError(
          Array.from({ length: 32 }, () => graph),
          `${label} fanout ${depth}`,
        );
      }
      return graph;
    };
    const beforeTelemetry = explosive("before telemetry");
    const rendererCleanup = explosive("renderer cleanup");
    const afterTelemetry = explosive("after telemetry");
    let infoReads = 0;
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() {
        infoReads += 1;
        throw infoReads === 1 ? beforeTelemetry : afterTelemetry;
      },
    });
    renderer.init = async () => { throw primary; };
    renderer.dispose = () => { throw rendererCleanup; };
    const backend = adapter(renderer);

    const failure = await backend.initialize({ viewport }).catch(
      (error: unknown) => error,
    ) as AggregateError;
    const pending: unknown[] = [failure];
    let evidenceNodes = 0;
    let totalBudgetMarkers = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      evidenceNodes += 1;
      if (current instanceof AggregateError) pending.push(...current.errors);
      else if (current instanceof Error) {
        if (current.message.includes("total node limit")) totalBudgetMarkers += 1;
        if (Object.prototype.hasOwnProperty.call(current, "cause")) {
          pending.push(current.cause);
        }
      }
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toHaveLength(4);
    expect(failure.errors[0]).toBe(primary);
    expect(infoReads).toBe(2);
    expect(totalBudgetMarkers).toBeGreaterThan(0);
    expect(evidenceNodes).toBeLessThanOrEqual(2_100);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      retainedFailureReferences: 0,
      resourceCounterProvenance: "unavailable",
    });
  });

  it("keeps concurrent disposal failed when initialization cleanup fails", async () => {
    const renderer = fakeRenderer();
    let rejectInitialize!: (error: unknown) => void;
    renderer.init = () => new Promise<void>((_resolve, reject) => {
      rejectInitialize = reject;
    });
    renderer.dispose = () => { throw new Error("concurrent cleanup failed"); };
    const backend = adapter(renderer);

    const initialization = backend.initialize({ viewport }).catch((error: unknown) => error);
    const disposal = backend.dispose().catch((error: unknown) => error);
    rejectInitialize(new Error("concurrent init failed"));

    const initializationError = await initialization;
    const disposalResult = await disposal;
    expect(initializationError).toBeInstanceOf(AggregateError);
    expect((initializationError as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual(["concurrent init failed", "concurrent cleanup failed"]);
    expect(disposalResult).toBeUndefined();
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      disposeCalls: 1,
      resources: { subscribers: 0 },
    });
  });

  it("does not double-dispose when initialization cleanup synchronously reenters disposal", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    let reentrantDispose: Promise<void> | null = null;
    let rendererDisposeCalls = 0;
    renderer.init = async () => { throw new Error("init failed"); };
    const originalDispose = renderer.dispose.bind(renderer);
    renderer.dispose = () => {
      rendererDisposeCalls += 1;
      reentrantDispose = backend.dispose();
      originalDispose();
    };

    await expect(backend.initialize({ viewport })).rejects.toThrow("init failed");
    expect(reentrantDispose).not.toBeNull();
    await expect(reentrantDispose).resolves.toBeUndefined();
    expect(rendererDisposeCalls).toBe(1);
    expect(renderer.calls.filter((call) => call === "backend.dispose")).toHaveLength(1);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      disposeCalls: 1,
      rendererDisposeInvoked: true,
      backendDisposeInvoked: true,
    });
  });

  it("rejects subscriptions reentered from terminal renderer-info reads", async () => {
    const renderer = fakeRenderer();
    const memory = renderer.info!.memory!;
    const terminalListener = vi.fn<(event: BackendRuntimeEvent) => void>();
    let infoReads = 0;
    const backend = adapter(renderer);
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() {
        infoReads += 1;
        if (infoReads >= 2) backend.subscribeEvents(terminalListener);
        return { memory };
      },
    });
    renderer.init = async () => { throw new Error("init failed"); };
    renderer.dispose = () => {
      renderer.calls.push("dispose");
      renderer.disposed = true;
      renderer.backend?.dispose?.();
    };
    backend.subscribeEvents(() => undefined);

    await expect(backend.initialize({ viewport })).rejects.toThrow("init failed");
    expect(infoReads).toBe(2);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      appOwnership: { eventSubscribers: 0 },
      resources: { subscribers: 0 },
    });
    backend.diagnostics.emitDeviceLost(new Error("ignored terminal event"));
    expect(terminalListener).not.toHaveBeenCalled();
  });

  it("preserves identical pre- and post-dispose telemetry failures as two occurrences", async () => {
    const renderer = fakeRenderer();
    renderer.dispose = () => renderer.backend?.dispose?.();
    const backend = adapter(renderer);
    backend.subscribeEvents(() => undefined);
    await backend.initialize({ viewport });
    const resourceError = new Error("resource snapshot failed");
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() { throw resourceError; },
    });

    const failure = await backend.dispose().catch((error: unknown) => error) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors.map((error) => (error as Error).message)).toEqual([
      "resource snapshot failed",
      "resource snapshot failed",
    ]);
    expect(failure.errors[0]).not.toBe(resourceError);
    expect(failure.errors[1]).not.toBe(resourceError);
    expect(Object.isFrozen(failure.errors[0])).toBe(true);
    expect(Object.isFrozen(failure.errors[1])).toBe(true);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      rendererDisposeInvoked: true,
      backendDisposeCompleted: true,
      resourceCounterProvenance: "unavailable",
      resources: { subscribers: 0 },
    });
    await expect(backend.initialize({ viewport })).rejects.toThrow("while failed");
  });

  it("preserves init, dispose, and resource-snapshot errors without retaining listeners", async () => {
    const renderer = fakeRenderer();
    renderer.init = async () => { throw new Error("primary init failed"); };
    renderer.dispose = () => { throw new Error("secondary dispose failed"); };
    const resourceError = new Error("tertiary snapshot failed");
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() { throw resourceError; },
    });
    const backend = adapter(renderer);
    backend.subscribeEvents(() => undefined);

    const failure = await backend.initialize({ viewport }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual([
        "primary init failed",
        "tertiary snapshot failed",
        "secondary dispose failed",
        "tertiary snapshot failed",
      ]);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      resourceCounterProvenance: "unavailable",
      resources: { subscribers: 0 },
    });
  });

  it("preserves distinct pre- and post-dispose resource read failures", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    const beforeError = new Error("before-dispose telemetry failed");
    const afterError = new Error("after-dispose telemetry failed");
    let reads = 0;
    renderer.dispose = () => renderer.backend?.dispose?.();
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() {
        reads += 1;
        throw reads === 1 ? beforeError : afterError;
      },
    });

    const failure = await backend.dispose().catch((error: unknown) => error) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.errors)).toBe(true);
    expect(failure.errors).toEqual([beforeError, afterError]);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      resourceCounterProvenance: "unavailable",
      appOwnership: { eventSubscribers: 0 },
    });
  });

  it("rejects renderer-factory failure as terminal and keeps disposal idempotent", async () => {
    const backend = new ThreeRenderBackendAdapter({
      request: "forced-webgl2",
      lab: true,
      diagnosticsEnabled: true,
      threeRevision: "185",
      webgpuApiExposed: true,
      webgl2ApiAvailable: true,
      navigatorProbe: probe,
      createRenderer: () => { throw new Error("factory failed"); },
    });

    await expect(backend.initialize({ viewport })).rejects.toThrow("factory failed");
    const first = backend.dispose();
    const second = backend.dispose();
    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      rendererDisposeInvoked: false,
      backendDisposeInstrumented: false,
      resourceCounterProvenance: "unavailable",
      resources: { subscribers: 0 },
    });
  });

  it("does not retain subscribers added after a terminal failure", async () => {
    const renderer = fakeRenderer();
    renderer.init = async () => { throw new Error("init failed"); };
    const backend = adapter(renderer);
    await expect(backend.initialize({ viewport })).rejects.toThrow("init failed");

    const unsubscribe = backend.subscribeEvents(() => undefined);
    expect(backend.snapshotLifecycle().resources.subscribers).toBe(0);
    unsubscribe();
    expect(backend.snapshotLifecycle().resources.subscribers).toBe(0);
  });

  it("captures a device-loss callback fired during renderer initialization", async () => {
    const renderer = fakeRenderer();
    const loss = new Error("device lost during init");
    renderer.init = async () => {
      renderer.calls.push("init");
      renderer.onDeviceLost(loss);
    };
    const backend = adapter(renderer);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);

    await expect(backend.initialize({ viewport })).rejects.toBe(loss);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      kind: "device-lost",
      error: loss,
    }));
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      rendererDisposeInvoked: true,
      retainedFailureReferences: 0,
      appOwnership: { eventSubscribers: 0 },
    });
  });

  it("chains an init-installed wrapper without duplicating the adapter event", async () => {
    const renderer = fakeRenderer();
    const original = vi.fn<(error: unknown) => void>();
    const replacement = vi.fn<(error: unknown) => void>();
    renderer.onDeviceLost = original;
    renderer.init = async () => {
      renderer.calls.push("init");
      const prior = renderer.onDeviceLost;
      renderer.onDeviceLost = (error) => {
        replacement(error);
        prior(error);
      };
    };
    const backend = adapter(renderer);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);
    await backend.initialize({ viewport });

    const loss = new Error("wrapped loss");
    renderer.onDeviceLost(loss);
    expect(replacement).toHaveBeenCalledOnce();
    expect(original).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    await backend.dispose();
    renderer.onDeviceLost(new Error("late restored original"));
    expect(replacement).toHaveBeenCalledOnce();
    expect(original).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("preserves two init-installed callback wrappers in assignment order", async () => {
    const renderer = fakeRenderer();
    const original = vi.fn<(error: unknown) => void>();
    const first = vi.fn<(error: unknown) => void>();
    const second = vi.fn<(error: unknown) => void>();
    renderer.onError = original;
    renderer.init = async () => {
      renderer.calls.push("init");
      const beforeFirst = renderer.onError;
      renderer.onError = (error) => {
        first(error);
        beforeFirst(error);
      };
      const beforeSecond = renderer.onError;
      renderer.onError = (error) => {
        second(error);
        beforeSecond(error);
      };
    };
    const backend = adapter(renderer);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);
    await backend.initialize({ viewport });

    const failure = new Error("double wrapped renderer error");
    renderer.onError(failure);
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    expect(original).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0].error).toBe(failure);
    await backend.dispose();
  });

  it("captures pass fields once and stops before submission when an accessor faults", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    const loss = new Error("pass accessor device loss");
    const pass = {
      get name() { return "faulting-pass"; },
      get kind() { return "scene"; },
      get scene() {
        renderer.onDeviceLost(loss);
        return {};
      },
      get camera() { return {}; },
    } as RenderPass;

    await expect(backend.render([pass])).rejects.toBe(loss);
    expect(renderer.calls).not.toContain("render");
    expect(backend.snapshotLifecycle()).toMatchObject({
      renderCalls: 0,
      appOwnership: { renderPasses: 0 },
    });
    await backend.dispose();
  });

  it("captures each pass payload exactly once in authored-field order", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    const order: string[] = [];
    const payload = { channel: "depth" };
    const pass = {
      get name() { order.push("name"); return "payload-pass"; },
      get kind() { order.push("kind"); return "scene"; },
      get scene() { order.push("scene"); return {}; },
      get camera() { order.push("camera"); return {}; },
      get payload() { order.push("payload"); return payload; },
    } as RenderPass;

    await backend.render([pass]);

    expect(order).toEqual(["name", "kind", "scene", "camera", "payload"]);
    await backend.dispose();
  });

  it("rejects malformed public adapter passes before renderer work", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    await backend.initialize({ viewport });

    await expect(backend.precompile([{ name: "valid", kind: " " }])).rejects.toThrow(
      "A render pass requires non-empty name and kind fields.",
    );

    expect(renderer.calls).not.toContain("compile");
    expect(backend.snapshotLifecycle()).toMatchObject({
      precompileCalls: 0,
      appOwnership: { renderPasses: 0 },
    });
    await backend.dispose();
  });

  it("validates pass identity fields before reading later fields and gives the runtime latch priority", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    const nameReads: string[] = [];
    const invalidName = {
      get name() { nameReads.push("name"); return " "; },
      get kind() { nameReads.push("kind"); return "scene"; },
      get scene() { nameReads.push("scene"); return {}; },
      get camera() { nameReads.push("camera"); return {}; },
      get payload() { nameReads.push("payload"); return {}; },
    } as RenderPass;
    await expect(backend.render([invalidName])).rejects.toThrow(
      "A render pass requires non-empty name and kind fields.",
    );
    expect(nameReads).toEqual(["name"]);

    const kindReads: string[] = [];
    const invalidKind = {
      get name() { kindReads.push("name"); return "valid"; },
      get kind() { kindReads.push("kind"); return ""; },
      get scene() { kindReads.push("scene"); return {}; },
      get camera() { kindReads.push("camera"); return {}; },
      get payload() { kindReads.push("payload"); return {}; },
    } as RenderPass;
    await expect(backend.precompile([invalidKind])).rejects.toThrow(
      "A render pass requires non-empty name and kind fields.",
    );
    expect(kindReads).toEqual(["name", "kind"]);

    const runtimeFailure = new Error("runtime failure from name getter");
    const faultReads: string[] = [];
    const faultingName = {
      get name() {
        faultReads.push("name");
        renderer.onError(runtimeFailure);
        return "";
      },
      get kind() { faultReads.push("kind"); return "scene"; },
      get scene() { faultReads.push("scene"); return {}; },
      get camera() { faultReads.push("camera"); return {}; },
      get payload() { faultReads.push("payload"); return {}; },
    } as RenderPass;
    await expect(backend.render([faultingName])).rejects.toBe(runtimeFailure);
    expect(faultReads).toEqual(["name"]);
    expect(backend.snapshotLifecycle()).toMatchObject({
      renderCalls: 0,
      precompileCalls: 0,
      appOwnership: { renderPasses: 0 },
    });
    await backend.dispose();
  });

  it("stops viewport camera updates immediately after the first camera faults", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    const loss = new Error("camera update device loss");
    const secondProjection = vi.fn();
    const firstCamera = {
      get isPerspectiveCamera() {
        renderer.onDeviceLost(loss);
        return true;
      },
      aspect: 1,
      updateProjectionMatrix: vi.fn(),
    };
    const secondCamera = {
      isPerspectiveCamera: true,
      aspect: 1,
      updateProjectionMatrix: secondProjection,
    };

    await expect(backend.precompile([
      { name: "first", kind: "scene", scene: {}, camera: firstCamera },
      { name: "second", kind: "scene", scene: {}, camera: secondCamera },
    ])).rejects.toBe(loss);
    expect(firstCamera.aspect).toBe(1);
    expect(secondProjection).not.toHaveBeenCalled();
    expect(renderer.calls).not.toContain("compile");
    await backend.dispose();
  });

  it("clears attempted backend facts when initialization fails after detection", async () => {
    const renderer = fakeRenderer("webgpu");
    renderer.setPixelRatio = () => {
      throw new Error("viewport failed after backend detection");
    };
    const backend = adapter(renderer, "webgpu-preferred");

    await expect(backend.initialize({ viewport })).rejects.toThrow(
      "viewport failed after backend detection",
    );
    expect(backend.facts).toMatchObject({
      actualApi: null,
      actualAuthority: null,
      compatibilityMode: null,
    });
  });

  it("reuses one cached terminal operation error for a non-Error renderer fault", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    backend.diagnostics.emitDeviceLost(null);

    const first = await backend.render([]).catch((error: unknown) => error);
    const second = await backend.precompile([]).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    expect(second).toBe(first);
    expect(backend.snapshotLifecycle()).toMatchObject({
      renderCalls: 0,
      precompileCalls: 0,
      appOwnership: { renderPasses: 0 },
    });
    await backend.dispose();
  });

  it("preserves repeated primitive resource-read failures from separate phases", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    renderer.dispose = () => renderer.backend?.dispose?.();
    Object.defineProperty(renderer, "info", {
      configurable: true,
      get() { throw undefined; },
    });

    let rejected = false;
    let rejection: unknown = null;
    try {
      await backend.dispose();
    } catch (error: unknown) {
      rejected = true;
      rejection = error;
    }
    expect(rejected).toBe(true);
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([undefined, undefined]);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      resourceCounterProvenance: "unavailable",
    });
  });

  it("detaches the backend-dispose instrumentation closure after observation", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    const instrumented = renderer.backend!.dispose;

    await backend.dispose();
    const terminalDispose = renderer.backend!.dispose;
    expect(terminalDispose).not.toBe(instrumented);
    terminalDispose?.();
    expect(renderer.calls.filter((call) => call === "backend.dispose")).toHaveLength(1);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "disposed",
      backendDisposeInvoked: true,
      backendDisposeCompleted: true,
    });
  });

  it("severs a backend replacement that chains the dispose instrumentation", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    await backend.initialize({ viewport });
    const instrumented = renderer.backend!.dispose!;
    const replacement = vi.fn(() => instrumented());
    renderer.backend!.dispose = replacement;

    await backend.dispose();
    const terminalDispose = renderer.backend!.dispose;
    expect(replacement).toHaveBeenCalledOnce();
    expect(terminalDispose).not.toBe(replacement);
    expect(terminalDispose).not.toBe(instrumented);
    terminalDispose?.();
    expect(replacement).toHaveBeenCalledOnce();
    expect(renderer.calls.filter((call) => call === "backend.dispose")).toHaveLength(1);
  });

  it("detaches instrumentation when a backend setter installs it and then throws", async () => {
    const renderer = fakeRenderer();
    const backendPort = renderer.backend!;
    const nativeDispose = backendPort.dispose!;
    const assignmentFailure = new Error("dispose setter failed after assignment");
    const assigned: Array<() => void> = [];
    let storedDispose = nativeDispose;
    Object.defineProperty(backendPort, "dispose", {
      configurable: true,
      get: () => storedDispose,
      set: (value: () => void) => {
        assigned.push(value);
        storedDispose = value;
        throw assignmentFailure;
      },
    });
    const backend = adapter(renderer);

    const initializationFailure = await backend.initialize({ viewport })
      .catch((error: unknown) => error);
    expect(initializationFailure).toBeInstanceOf(AggregateError);
    expect(assigned.length).toBeGreaterThanOrEqual(2);
    const instrumented = assigned[0];
    expect(instrumented).toBeTypeOf("function");
    expect(storedDispose).not.toBe(instrumented);
    storedDispose();
    expect(renderer.calls.filter((call) => call === "backend.dispose")).toHaveLength(1);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      rendererDisposeInvoked: true,
      backendDisposeInvoked: true,
      backendDisposeCompleted: true,
    });
  });

  it("reconciles a camera first introduced by a render pass before submission", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const cameraA = {
      isPerspectiveCamera: true,
      aspect: 1,
      updateProjectionMatrix: vi.fn(),
    };
    const cameraB = {
      isPerspectiveCamera: true,
      aspect: 1,
      updateProjectionMatrix: vi.fn(() => renderer.calls.push("cameraB.update")),
    };
    renderer.render = () => { renderer.calls.push("render"); };
    await backend.initialize({ viewport });
    await backend.precompile([{ name: "a", kind: "scene", scene: {}, camera: cameraA }]);

    await backend.render([{ name: "b", kind: "scene", scene: {}, camera: cameraB }]);

    expect(cameraB.aspect).toBeCloseTo(800 / 450);
    expect(cameraB.updateProjectionMatrix).toHaveBeenCalledOnce();
    expect(renderer.calls.indexOf("cameraB.update")).toBeLessThan(renderer.calls.indexOf("render"));
    await backend.dispose();
  });

  it("repairs a cached camera aspect that feature code mutates between submissions", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const camera = {
      isPerspectiveCamera: true,
      aspect: 1,
      updateProjectionMatrix: vi.fn(() => renderer.calls.push("camera.update")),
    };
    const pass = { name: "camera", kind: "scene", scene: {}, camera };
    renderer.render = () => { renderer.calls.push("render"); };
    await backend.initialize({ viewport });
    await backend.precompile([pass]);
    expect(camera.aspect).toBeCloseTo(800 / 450);
    camera.updateProjectionMatrix.mockClear();
    renderer.calls.length = 0;
    camera.aspect = 0.5;

    await backend.render([pass]);

    expect(camera.aspect).toBeCloseTo(800 / 450);
    expect(camera.updateProjectionMatrix).toHaveBeenCalledOnce();
    expect(renderer.calls.indexOf("camera.update")).toBeLessThan(renderer.calls.indexOf("render"));
    await backend.dispose();
  });

  it("delivers an opaque Proxy fault even when instanceof triggers a prototype trap", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);
    await backend.initialize({ viewport });
    const trapError = new Error("prototype trap");
    const opaque = new Proxy({}, {
      getPrototypeOf() { throw trapError; },
    });

    expect(() => backend.diagnostics.emitDeviceLost(opaque)).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0].kind).toBe("device-lost");
    expect(listener.mock.calls[0]?.[0].error).toBe(opaque);
    const operationFailure = await backend.render([]).catch((error: unknown) => error);
    expect(operationFailure).toBeInstanceOf(Error);
    expect((operationFailure as Error).cause === opaque).toBe(true);
    expect(backend.snapshotLifecycle().retainedFailureReferences).toBeGreaterThan(0);
    await backend.dispose();
    expect(backend.snapshotLifecycle().retainedFailureReferences).toBe(0);
  });

  it("claims the first backend fault before its event clock can emit reentrantly", async () => {
    const renderer = fakeRenderer();
    const first = new Error("first device loss");
    const nested = new Error("clock-reentrant renderer error");
    const holder: { backend?: ThreeRenderBackendAdapter } = {};
    const backend = new ThreeRenderBackendAdapter({
      request: "forced-webgl2",
      lab: true,
      diagnosticsEnabled: true,
      threeRevision: "185",
      webgpuApiExposed: true,
      webgl2ApiAvailable: true,
      navigatorProbe: probe,
      createRenderer: () => renderer,
      now: () => {
        holder.backend?.diagnostics.emitRendererError(nested);
        return 42;
      },
    });
    holder.backend = backend;
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);
    await backend.initialize({ viewport });

    expect(() => backend.diagnostics.emitDeviceLost(first)).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      kind: "device-lost",
      error: first,
      occurredAtMs: 42,
    }));
    await expect(backend.render([])).rejects.toBe(first);
    await backend.dispose();
    expect(backend.snapshotLifecycle().retainedFailureReferences).toBe(0);
  });

  it("fails closed and preserves evidence when the backend event clock throws", async () => {
    const renderer = fakeRenderer();
    const clockFailure = new Error("event clock failed");
    const backend = new ThreeRenderBackendAdapter({
      request: "forced-webgl2",
      lab: true,
      diagnosticsEnabled: true,
      threeRevision: "185",
      webgpuApiExposed: true,
      webgl2ApiAvailable: true,
      navigatorProbe: probe,
      createRenderer: () => renderer,
      now: () => { throw clockFailure; },
    });
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);
    await backend.initialize({ viewport });
    const loss = new Error("device lost");

    expect(() => renderer.onDeviceLost(loss)).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0].kind).toBe("device-lost");
    expect(listener.mock.calls[0]?.[0].occurredAtMs).toBe(0);
    const operationFailure = await backend.render([]).catch((error: unknown) => error);
    expect(operationFailure).toBeInstanceOf(Error);
    expect(listener.mock.calls[0]?.[0].error).toBe(operationFailure);
    expect((operationFailure as Error).cause).toBeInstanceOf(AggregateError);
    const clockEvidence = (operationFailure as Error).cause as AggregateError;
    expect(Object.isFrozen(clockEvidence)).toBe(true);
    expect(Object.isFrozen(clockEvidence.errors)).toBe(true);
    expect(clockEvidence.errors).toEqual([
      loss,
      clockFailure,
    ]);
    await backend.dispose();
  });
});
