import {
  ACESFilmicToneMapping,
  BoxGeometry,
  HalfFloatType,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  RenderPipeline,
  Scene,
  SRGBColorSpace,
} from "three/webgpu";
import { pass as tslPass } from "three/tsl";
import { describe, expect, it, vi } from "vitest";
import {
  RENDER_HISTORY_INVALIDATION_REASONS,
  type FeatureInitContext,
  type RenderHistoryInvalidation,
  type RenderPass,
  type RenderQualityProfile,
  type RenderViewport,
} from "../../src/gfx/v2/contracts";
import { GFX005_MATERIAL_WARMUP_KIND } from "../../src/gfx/v2/materials/tsl-material-library";
import {
  ProductionLinearHdrPipeline,
  createThreeLinearHdrGraph,
  selectLinearHdrPipelineProfile,
} from "../../src/gfx/v2/pipeline/linear-hdr-pipeline";
import type {
  LinearHdrGraph,
  LinearHdrGraphFactory,
  LinearHdrGraphFactoryContext,
} from "../../src/gfx/v2/pipeline/contracts";
import { ownedAggregateError } from "../../src/gfx/v2/pipeline/failures";
import { WORLD_MATERIAL_FAMILIES } from "../../src/world/v2";

const viewport = Object.freeze({ width: 800, height: 450, pixelRatio: 1 });

function quality(
  tier: RenderQualityProfile["tier"],
  temporal: boolean | "off" = true,
): RenderQualityProfile {
  return Object.freeze({
    tier,
    pixelRatio: 1,
    uploadBudgetMs: 4,
    features: Object.freeze({ temporal }),
  });
}

type FakeGraph = LinearHdrGraph & {
  precompile: ReturnType<typeof vi.fn<() => Promise<number>>>;
  setHistoryWeight: ReturnType<typeof vi.fn<(weight: number) => void | Promise<void>>>;
  resize: ReturnType<typeof vi.fn<(next: typeof viewport) => Promise<void>>>;
  render: ReturnType<typeof vi.fn<() => Promise<void>>>;
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function graphHarness(options: {
  failPrecompileAt?: number;
  precompileGate?: Readonly<{ index: number; promise: Promise<void> }>;
  resizeGate?: Readonly<{ index: number; promise: Promise<void> }>;
  disposeFailure?: unknown;
  failResizeOnceAt?: number;
} = {}): {
  readonly contexts: LinearHdrGraphFactoryContext[];
  readonly graphs: FakeGraph[];
  readonly factory: LinearHdrGraphFactory;
} {
  const contexts: LinearHdrGraphFactoryContext[] = [];
  const graphs: FakeGraph[] = [];
  const factory: LinearHdrGraphFactory = (context) => {
    contexts.push(context);
    const index = graphs.length;
    let resizeFailed = false;
    const graph: FakeGraph = {
      profile: context.profile,
      passSignature: context.passSignature,
      depthOwned: true,
      velocityOwned: context.profile.temporal,
      historyOwned: context.profile.temporal,
      precompile: vi.fn(async () => {
        if (options.precompileGate?.index === index) await options.precompileGate.promise;
        if (options.failPrecompileAt === index) throw new Error(`precompile ${index} failed`);
        return context.passes.length + context.materialWarmupPasses.length + 1;
      }),
      setHistoryWeight: vi.fn(),
      resize: vi.fn(async () => {
        if (options.resizeGate?.index === index) await options.resizeGate.promise;
        if (options.failResizeOnceAt === index && !resizeFailed) {
          resizeFailed = true;
          throw new Error(`resize ${index} failed once`);
        }
      }),
      render: vi.fn(async () => undefined),
      dispose: vi.fn(async () => {
        if (options.disposeFailure !== undefined) throw options.disposeFailure;
      }),
    };
    graphs.push(graph);
    return graph;
  };
  return { contexts, graphs, factory };
}

function renderer(programs = 8) {
  return {
    compileAsync: vi.fn(async () => undefined),
    info: { memory: { programs } },
  };
}

function deferredVoid() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject } as const;
}

function topologyRenderer(programs = 0, failCompileAt?: number) {
  let renderTarget: unknown = null;
  let mrt: unknown = null;
  const targetDisposals = new WeakMap<object, ReturnType<typeof vi.fn>>();
  const compiled: Array<Readonly<{
    scene: unknown;
    target: unknown;
    mrt: unknown;
    meshCount: number;
  }>> = [];
  let compileCalls = 0;
  const raw = {
    toneMapping: ACESFilmicToneMapping,
    outputColorSpace: SRGBColorSpace,
    xr: { enabled: false },
    info: { memory: { programs } },
    getRenderTarget: vi.fn(() => renderTarget),
    getMRT: vi.fn(() => mrt),
    setRenderTarget: vi.fn((next: unknown) => { renderTarget = next; }),
    setMRT: vi.fn((next: unknown) => { mrt = next; }),
    compileAsync: vi.fn(async (scene: unknown) => {
      compileCalls += 1;
      let meshCount = 0;
      const traverse = (scene as { traverse?: (visit: (object: unknown) => void) => void })?.traverse;
      traverse?.call(scene, (object: unknown) => {
        if ((object as { isMesh?: boolean }).isMesh === true) meshCount += 1;
      });
      const target = renderTarget as object | null;
      if (target && !targetDisposals.has(target)) {
        const listener = vi.fn();
        (target as { addEventListener(type: string, callback: () => void): void })
          .addEventListener("dispose", listener);
        targetDisposals.set(target, listener);
      }
      compiled.push(Object.freeze({ scene, target: renderTarget, mrt, meshCount }));
      raw.info.memory.programs += 1;
      if (compileCalls === failCompileAt) throw new Error("runtime topology compile failed");
    }),
    render: vi.fn(),
  };
  return { raw, compiled, targetDisposals } as const;
}

function containsNodeType(root: unknown, expected: string): boolean {
  const queue: unknown[] = [root];
  const seen = new Set<object>();
  for (let inspected = 0; queue.length > 0 && inspected < 512; inspected += 1) {
    const value = queue.shift();
    if ((typeof value !== "object" || value === null) && typeof value !== "function") continue;
    const object = value as object;
    if (seen.has(object)) continue;
    seen.add(object);
    if ((object as { constructor?: { name?: string } }).constructor?.name === expected) return true;
    for (const key of Reflect.ownKeys(object).slice(0, 64)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && "value" in descriptor) queue.push(descriptor.value);
    }
  }
  return false;
}

function runtimePass(variant?: string): RenderPass {
  return Object.freeze({
    name: "world",
    kind: "opaque-pbr",
    ...(variant === undefined ? {} : { variant }),
    scene: {},
    camera: {},
  });
}

function materialPass(
  family = "water",
  variant = "webgpu-full",
): RenderPass {
  return Object.freeze({
    name: `gfx005-material:${family}`,
    kind: GFX005_MATERIAL_WARMUP_KIND,
    variant,
    scene: {},
    camera: {},
  });
}

function historyEvent(reason: RenderHistoryInvalidation["reason"]): RenderHistoryInvalidation {
  return Object.freeze({
    reason,
    previousShotId: "S20",
    nextShotId: "S21",
    storyTime: 161,
  });
}

describe("GFX-005 Linear HDR pipeline", () => {
  it("constructs the real TSL depth/velocity/history graph without a raw shader path", async () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    const profile = selectLinearHdrPipelineProfile("WebGPU", quality("high"));
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: {
        toneMapping: ACESFilmicToneMapping,
        outputColorSpace: SRGBColorSpace,
      },
      profile,
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{ name: "world", kind: "opaque-pbr", scene, camera }]),
      passSignature: "real-tsl-graph",
      viewport,
    }));

    expect(graph).toMatchObject({
      depthOwned: true,
      velocityOwned: true,
      historyOwned: true,
      passSignature: "real-tsl-graph",
    });
    await graph.dispose();
  });

  it("constructs RenderPipeline from an owned renderer snapshot without Proxy get traps", async () => {
    const target = topologyRenderer().raw;
    const constructorFieldGet = vi.fn(() => {
      throw new Error("renderer constructor field get must not run");
    });
    const rendererProxy = new Proxy(target, {
      get(source, key, receiver) {
        if (key === "toneMapping" || key === "outputColorSpace") {
          return constructorFieldGet();
        }
        return Reflect.get(source, key, receiver) as unknown;
      },
    });
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: rendererProxy,
      profile: selectLinearHdrPipelineProfile("WebGPU", quality("high")),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{
        name: "world",
        kind: "opaque-pbr",
        scene: new Scene(),
        camera: new PerspectiveCamera(),
      }]),
      passSignature: "owned-renderer-constructor-snapshot",
      viewport,
    }));

    expect(constructorFieldGet).not.toHaveBeenCalled();
    await graph.dispose();
    expect(constructorFieldGet).not.toHaveBeenCalled();
  });

  it("compiles material inventory through the actual WebGPU HalfFloat velocity MRT then drops it", async () => {
    const runtimeScene = new Scene();
    const materialScene = new Scene();
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    materialScene.add(new Mesh(geometry, material));
    const probe = topologyRenderer();
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGPU", quality("high")),
      materialWarmupPasses: Object.freeze([{
        name: "gfx005-material:water",
        kind: GFX005_MATERIAL_WARMUP_KIND,
        variant: "webgpu-full",
        scene: materialScene,
        camera,
      }]),
      passes: Object.freeze([{ name: "world", kind: "opaque-pbr", scene: runtimeScene, camera }]),
      passSignature: "actual-temporal-material-topology",
      viewport,
    }));

    await expect(graph.precompile()).resolves.toBe(4);
    const materialCompile = probe.compiled.find((entry) => entry.scene === materialScene)!;
    const runtimeCompiles = probe.compiled.filter((entry) => entry.scene === runtimeScene);
    const target = materialCompile.target as {
      texture: { type: number };
      textures: Array<{ name: string }>;
    };
    const materialMrt = materialCompile.mrt as {
      isMRTNode?: boolean;
      has(name: string): boolean;
    };
    expect(target.texture.type).toBe(HalfFloatType);
    expect(target.textures.map((texture) => texture.name)).toEqual(["output", "velocity"]);
    expect(materialMrt.isMRTNode).toBe(true);
    expect(materialMrt.has("output")).toBe(true);
    expect(materialMrt.has("velocity")).toBe(true);
    expect(runtimeCompiles.map((entry) => entry.meshCount)).toEqual([0, 1]);
    expect(runtimeCompiles[1]?.target).toBe(runtimeCompiles[0]?.target);
    expect(runtimeCompiles[1]?.mrt).toBe(runtimeCompiles[0]?.mrt);
    expect(runtimeScene.children).toEqual([]);
    expect(probe.targetDisposals.get(target as unknown as object)).toHaveBeenCalledOnce();
    expect(probe.raw.render).toHaveBeenCalledOnce();

    await graph.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("builds a real TSL FXAA node for every non-temporal fallback graph", async () => {
    const probe = topologyRenderer();
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGL2", quality("high")),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{
        name: "world",
        kind: "opaque-pbr",
        scene: new Scene(),
        camera: new PerspectiveCamera(50, 1, 0.1, 100),
      }]),
      passSignature: "actual-static-fxaa",
      viewport,
    }));

    await graph.precompile();
    const quad = probe.raw.render.mock.calls[0]?.[0] as {
      material?: { fragmentNode?: unknown };
    };
    expect(containsNodeType(quad.material?.fragmentNode, "FXAANode")).toBe(true);
    await graph.dispose();
  });

  it("removes temporary runtime-scene material clones when topology compilation fails", async () => {
    const runtimeScene = new Scene();
    const materialScene = new Scene();
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    materialScene.add(new Mesh(geometry, material));
    const probe = topologyRenderer(0, 3);
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGL2", quality("low", false)),
      materialWarmupPasses: Object.freeze([{
        name: "gfx005-material:water",
        kind: GFX005_MATERIAL_WARMUP_KIND,
        variant: "webgl2-lean",
        scene: materialScene,
        camera,
      }]),
      passes: Object.freeze([{ name: "world", kind: "opaque-pbr", scene: runtimeScene, camera }]),
      passSignature: "failed-runtime-material-topology",
      viewport,
    }));

    await expect(graph.precompile()).rejects.toThrow(/Material topology warm-up failed/);
    expect(probe.compiled.map((entry) => entry.meshCount)).toEqual([0, 1, 1]);
    expect(runtimeScene.children).toEqual([]);
    await graph.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("publishes attach admission before viewport access and commits only the outer backend", async () => {
    const harness = graphHarness();
    const outerRenderer = renderer();
    const nestedRenderer = renderer();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    const nestedWidth = vi.fn(() => 320);
    const nestedViewport = { height: 180, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(nestedViewport, "width", {
      enumerable: true,
      get: nestedWidth,
    });
    let nestedFailure: unknown;
    const outerWidth = vi.fn(() => {
      try {
        pipeline.attachBackend(
          nestedRenderer,
          "webgl2",
          nestedViewport as unknown as RenderViewport,
        );
      } catch (error: unknown) {
        nestedFailure = error;
      }
      return 800;
    });
    const outerViewport = { height: 450, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(outerViewport, "width", {
      enumerable: true,
      get: outerWidth,
    });

    pipeline.attachBackend(
      outerRenderer,
      "webgpu",
      outerViewport as unknown as RenderViewport,
    );
    expect(outerWidth).toHaveBeenCalledOnce();
    expect(nestedWidth).not.toHaveBeenCalled();
    expect(nestedFailure).toMatchObject({ message: expect.stringMatching(/operation is active/) });
    expect(pipeline.snapshot()).toMatchObject({
      state: "attached",
      actualApi: "WebGPU",
      activeProfileId: "webgpu-balanced-temporal",
      historyGeneration: 1,
      historyResetCounts: { initialization: 1, resize: 0 },
    });

    await pipeline.initialize({} as FeatureInitContext);
    await pipeline.precompile([runtimePass()]);
    expect(harness.contexts.every((context) => context.renderer === outerRenderer)).toBe(true);
    expect(harness.contexts.every((context) => context.viewport.width === 800)).toBe(true);
    await expect(pipeline.resize({ width: 320, height: 180, pixelRatio: 1 }))
      .resolves.toBeUndefined();
    expect(pipeline.snapshot()).toMatchObject({
      state: "ready",
      actualApi: "WebGPU",
      historyResetCounts: { initialization: 1, resize: 1 },
    });
    await pipeline.dispose();
  });

  it("fences every mutator before its caller-owned attach input is inspected", async () => {
    const pipeline = new ProductionLinearHdrPipeline();
    const nestedViewportGet = vi.fn(() => 320);
    const nestedViewport = { height: 180, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(nestedViewport, "width", {
      enumerable: true,
      get: nestedViewportGet,
    });
    const tierGet = vi.fn(() => "high" as const);
    const nestedQuality = { features: Object.freeze({ temporal: true }) } as Record<string, unknown>;
    Object.defineProperty(nestedQuality, "tier", { enumerable: true, get: tierGet });
    const passGets = vi.fn(() => { throw new Error("nested pass inspection must not run"); });
    const hostilePasses = new Proxy([], { get: passGets });
    const reasonGet = vi.fn(() => "resize" as const);
    const hostileHistoryEvent = {} as Record<string, unknown>;
    Object.defineProperty(hostileHistoryEvent, "reason", { enumerable: true, get: reasonGet });
    const failures: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    const outerViewport = { height: 450, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(outerViewport, "width", {
      enumerable: true,
      get() {
        try {
          pipeline.quality(nestedQuality as unknown as RenderQualityProfile);
        } catch (error: unknown) {
          failures.push(error);
        }
        try {
          pipeline.invalidateHistory(
            hostileHistoryEvent as unknown as RenderHistoryInvalidation,
          );
        } catch (error: unknown) {
          failures.push(error);
        }
        pending.push(pipeline.resize(nestedViewport as unknown as RenderViewport).catch(
          (error: unknown) => error,
        ));
        pending.push(pipeline.precompile(
          hostilePasses as unknown as readonly RenderPass[],
        ).catch((error: unknown) => error));
        pending.push(pipeline.submit(
          hostilePasses as unknown as readonly RenderPass[],
        ).catch((error: unknown) => error));
        return 800;
      },
    });

    pipeline.attachBackend(
      renderer(),
      "webgpu",
      outerViewport as unknown as RenderViewport,
    );
    failures.push(...await Promise.all(pending));
    expect(failures).toHaveLength(5);
    expect(failures.every((failure) => (
      failure instanceof Error && /attach|operation is active/.test(failure.message)
    ))).toBe(true);
    expect(nestedViewportGet).not.toHaveBeenCalled();
    expect(tierGet).not.toHaveBeenCalled();
    expect(reasonGet).not.toHaveBeenCalled();
    expect(passGets).not.toHaveBeenCalled();
    expect(pipeline.snapshot()).toMatchObject({
      state: "attached",
      actualApi: "WebGPU",
      activeProfileId: "webgpu-balanced-temporal",
      historyGeneration: 1,
    });
    await pipeline.dispose();
  });

  it("aborts attach without partial history when a viewport accessor requests disposal", async () => {
    const pipeline = new ProductionLinearHdrPipeline();
    let disposal: Promise<void> | null = null;
    const widthGet = vi.fn(() => {
      disposal = pipeline.dispose();
      return 800;
    });
    const hostileViewport = { height: 450, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(hostileViewport, "width", { enumerable: true, get: widthGet });

    expect(() => pipeline.attachBackend(
      renderer(),
      "webgpu",
      hostileViewport as unknown as RenderViewport,
    )).toThrow(/disposal was requested|pipeline is disposing/);
    expect(widthGet).toHaveBeenCalledOnce();
    await expect(disposal).resolves.toBeUndefined();
    expect(pipeline.snapshot()).toMatchObject({
      state: "disposed",
      actualApi: null,
      activeProfileId: null,
      historyGeneration: 0,
      historyResetCounts: { initialization: 0, resize: 0 },
      graphCount: 0,
    });
  });

  it("releases attach admission after caller capture throws", async () => {
    const pipeline = new ProductionLinearHdrPipeline();
    const captureFailure = new Error("attach viewport capture failed");
    const widthGet = vi.fn(() => { throw captureFailure; });
    const hostileViewport = { height: 450, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(hostileViewport, "width", { enumerable: true, get: widthGet });

    expect(() => pipeline.attachBackend(
      renderer(),
      "webgpu",
      hostileViewport as unknown as RenderViewport,
    )).toThrow(captureFailure);
    expect(widthGet).toHaveBeenCalledOnce();
    expect(pipeline.snapshot()).toMatchObject({
      state: "new",
      actualApi: null,
      activeProfileId: null,
      historyGeneration: 0,
    });
    expect(() => pipeline.attachBackend(renderer(), "webgl2", viewport)).not.toThrow();
    expect(pipeline.snapshot()).toMatchObject({
      state: "attached",
      actualApi: "WebGL2",
      activeProfileId: "webgl2-balanced-static",
      historyGeneration: 1,
    });
    await pipeline.dispose();
  });

  it("keeps the renderer opaque and captures one coherent viewport before attach commit", async () => {
    const harness = graphHarness();
    const rawRenderer = renderer();
    const rendererGets = vi.fn((target: typeof rawRenderer, property: PropertyKey, receiver: unknown) => (
      Reflect.get(target, property, receiver)
    ));
    const rendererPrototypeGets = vi.fn((target: typeof rawRenderer) => Reflect.getPrototypeOf(target));
    const rendererOwnKeys = vi.fn((target: typeof rawRenderer) => Reflect.ownKeys(target));
    const opaqueRenderer = new Proxy(rawRenderer, {
      get: rendererGets,
      getPrototypeOf: rendererPrototypeGets,
      ownKeys: rendererOwnKeys,
    });
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    const readOrder: string[] = [];
    let reentrantSnapshot: ReturnType<typeof pipeline.snapshot> | null = null;
    const capturedViewport = {} as Record<string, unknown>;
    for (const [property, value] of [
      ["width", 800],
      ["height", 450],
      ["pixelRatio", 1],
    ] as const) {
      Object.defineProperty(capturedViewport, property, {
        enumerable: true,
        get: vi.fn(() => {
          readOrder.push(property);
          if (property === "width") reentrantSnapshot = pipeline.snapshot();
          return value;
        }),
      });
    }

    pipeline.attachBackend(
      opaqueRenderer,
      "webgpu",
      capturedViewport as unknown as RenderViewport,
    );
    expect(readOrder).toEqual(["width", "height", "pixelRatio"]);
    expect(reentrantSnapshot).toMatchObject({
      state: "new",
      actualApi: null,
      activeProfileId: null,
      historyGeneration: 0,
      pendingHistoryResets: [],
    });
    expect(rendererGets).not.toHaveBeenCalled();
    expect(rendererPrototypeGets).not.toHaveBeenCalled();
    expect(rendererOwnKeys).not.toHaveBeenCalled();

    await pipeline.initialize({} as FeatureInitContext);
    await pipeline.precompile([runtimePass()]);
    expect(harness.contexts.every((context) => context.renderer === opaqueRenderer)).toBe(true);
    expect(harness.contexts.every((context) => context.viewport === harness.contexts[0]!.viewport))
      .toBe(true);
    await pipeline.dispose();
  });

  it("rejects invalid API and revoked viewport inputs without stranding attach admission", async () => {
    const pipeline = new ProductionLinearHdrPipeline();
    const widthGet = vi.fn(() => 800);
    const untouchedViewport = { height: 450, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(untouchedViewport, "width", { enumerable: true, get: widthGet });
    expect(() => pipeline.attachBackend(
      renderer(),
      "vulkan" as unknown as "webgpu",
      untouchedViewport as unknown as RenderViewport,
    )).toThrow(/recognized backend API/);
    expect(widthGet).not.toHaveBeenCalled();
    expect(pipeline.snapshot()).toMatchObject({
      state: "new",
      actualApi: null,
      historyGeneration: 0,
    });

    const revoked = Proxy.revocable({ width: 800, height: 450, pixelRatio: 1 }, {});
    revoked.revoke();
    expect(() => pipeline.attachBackend(
      renderer(),
      "webgpu",
      revoked.proxy,
    )).toThrow(TypeError);
    expect(pipeline.snapshot()).toMatchObject({
      state: "new",
      actualApi: null,
      activeProfileId: null,
      historyGeneration: 0,
    });

    expect(() => pipeline.attachBackend(renderer(), "webgl2", viewport)).not.toThrow();
    expect(pipeline.snapshot()).toMatchObject({
      state: "attached",
      actualApi: "WebGL2",
      activeProfileId: "webgl2-balanced-static",
      historyGeneration: 1,
    });
    await pipeline.dispose();
  });

  it("admits precompile before pass-array inspection and fences every nested mutator", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const nestedPassDescriptorGets = vi.fn(() => {
      throw new Error("nested passes must not be inspected");
    });
    const nestedPasses = new Proxy([], { getOwnPropertyDescriptor: nestedPassDescriptorGets });
    const nestedTierGet = vi.fn(() => "high" as const);
    const nestedQuality = { features: Object.freeze({ temporal: true }) } as Record<string, unknown>;
    Object.defineProperty(nestedQuality, "tier", { enumerable: true, get: nestedTierGet });
    const nestedWidthGet = vi.fn(() => 320);
    const nestedViewport = { height: 180, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(nestedViewport, "width", { enumerable: true, get: nestedWidthGet });
    const nestedReasonGet = vi.fn(() => "resize" as const);
    const nestedEvent = {} as Record<string, unknown>;
    Object.defineProperty(nestedEvent, "reason", { enumerable: true, get: nestedReasonGet });
    const nestedAttachWidthGet = vi.fn(() => 320);
    const nestedAttachViewport = { height: 180, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(nestedAttachViewport, "width", {
      enumerable: true,
      get: nestedAttachWidthGet,
    });
    const failures: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    let triggerNested = true;
    const outerPasses = new Proxy([runtimePass()], {
      getOwnPropertyDescriptor(target, property) {
        if (triggerNested) {
          triggerNested = false;
          try {
            pipeline.quality(nestedQuality as unknown as RenderQualityProfile);
          } catch (error: unknown) {
            failures.push(error);
          }
          try {
            pipeline.invalidateHistory(nestedEvent as unknown as RenderHistoryInvalidation);
          } catch (error: unknown) {
            failures.push(error);
          }
          try {
            pipeline.attachBackend(
              renderer(),
              "webgl2",
              nestedAttachViewport as unknown as RenderViewport,
            );
          } catch (error: unknown) {
            failures.push(error);
          }
          pending.push(pipeline.resize(
            nestedViewport as unknown as RenderViewport,
          ).catch((error: unknown) => error));
          pending.push(pipeline.precompile(
            nestedPasses as unknown as readonly RenderPass[],
          ).catch((error: unknown) => error));
          pending.push(pipeline.submit(
            nestedPasses as unknown as readonly RenderPass[],
          ).catch((error: unknown) => error));
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    await expect(pipeline.precompile(outerPasses)).resolves.toBeUndefined();
    failures.push(...await Promise.all(pending));
    expect(failures).toHaveLength(6);
    expect(failures.every((failure) => (
      failure instanceof Error && /operation is active|precompile is active/.test(failure.message)
    ))).toBe(true);
    expect(nestedPassDescriptorGets).not.toHaveBeenCalled();
    expect(nestedTierGet).not.toHaveBeenCalled();
    expect(nestedWidthGet).not.toHaveBeenCalled();
    expect(nestedReasonGet).not.toHaveBeenCalled();
    expect(nestedAttachWidthGet).not.toHaveBeenCalled();
    expect(harness.graphs.every((graph) => graph.precompile.mock.calls.length === 1)).toBe(true);
    expect(harness.graphs.every((graph) => graph.render.mock.calls.length === 0)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      state: "ready",
      actualApi: "WebGPU",
      activeProfileId: "webgpu-balanced-temporal",
      historyGeneration: 1,
      historyValid: false,
    });
    await pipeline.dispose();
  });

  it("admits submit before pass-field inspection and rejects a nested frame pre-mutation", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const warmed = runtimePass();
    await pipeline.precompile([warmed]);
    let nestedSubmit: Promise<void> | null = null;
    let triggerNested = true;
    const sceneDescriptorGet = vi.fn((target: RenderPass, property: PropertyKey) => {
      if (property === "scene" && triggerNested) {
        triggerNested = false;
        nestedSubmit = pipeline.submit([warmed]);
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    });
    const outer = new Proxy(warmed, { getOwnPropertyDescriptor: sceneDescriptorGet });

    await expect(pipeline.submit([outer])).resolves.toBeUndefined();
    await expect(nestedSubmit).rejects.toThrow(/operation is active|submit is active/);
    expect(sceneDescriptorGet).toHaveBeenCalledTimes(5);
    const active = harness.graphs.find(
      (graph) => graph.profile.id === "webgpu-balanced-temporal",
    )!;
    expect(active.render).toHaveBeenCalledOnce();
    expect(pipeline.snapshot()).toMatchObject({
      state: "ready",
      historyValid: true,
      programGrowthAfterReady: 0,
    });
    await pipeline.dispose();
  });

  it("aborts a pass-field submit after its getter requests disposal", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const warmed = runtimePass();
    await pipeline.precompile([warmed]);
    let disposal: Promise<void> | null = null;
    const sceneDescriptorGet = vi.fn((target: RenderPass, property: PropertyKey) => {
      if (property === "scene") disposal = pipeline.dispose();
      return Reflect.getOwnPropertyDescriptor(target, property);
    });
    const hostile = new Proxy(warmed, { getOwnPropertyDescriptor: sceneDescriptorGet });

    await expect(pipeline.submit([hostile]))
      .rejects.toThrow(/disposal was requested|pipeline is disposing/);
    expect(sceneDescriptorGet).toHaveBeenCalledTimes(5);
    await expect(disposal).resolves.toBeUndefined();
    expect(harness.graphs.every((graph) => graph.render.mock.calls.length === 0)).toBe(true);
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      state: "disposed",
      historyValid: false,
      cleanupPendingGraphs: 0,
    });
  });

  it("rejects pass accessors, sparse arrays, and oversized inventories without hidden work", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const base = runtimePass();
    const sceneGetter = vi.fn(() => base.scene);
    const accessorPass = {
      name: base.name,
      kind: base.kind,
      camera: base.camera,
    } as Record<string, unknown>;
    Object.defineProperty(accessorPass, "scene", { enumerable: true, get: sceneGetter });
    const accessorFailure = await pipeline.precompile([
      accessorPass as unknown as RenderPass,
    ]).catch((error: unknown) => error);
    expect(accessorFailure).toBeInstanceOf(AggregateError);
    expect(JSON.stringify((accessorFailure as AggregateError).errors))
      .toContain("scene must be an own data property");
    expect(sceneGetter).not.toHaveBeenCalled();

    const sparse = [base] as RenderPass[];
    sparse.length = 2;
    const sparseFailure = await pipeline.precompile(sparse).catch((error: unknown) => error);
    expect(JSON.stringify((sparseFailure as AggregateError).errors)).toContain("dense own data slots");
    const oversizedFailure = await pipeline.precompile(
      new Array<RenderPass>(257).fill(base),
    ).catch((error: unknown) => error);
    expect(JSON.stringify((oversizedFailure as AggregateError).errors)).toContain("at most 256 passes");
    const slotGetter = vi.fn(() => base);
    const accessorSlots: RenderPass[] = [];
    Object.defineProperty(accessorSlots, "0", { enumerable: true, get: slotGetter });
    const slotFailure = await pipeline.precompile(accessorSlots).catch(
      (error: unknown) => error,
    );
    expect(JSON.stringify((slotFailure as AggregateError).errors)).toContain("dense own data slots");
    expect(slotGetter).not.toHaveBeenCalled();
    expect(harness.contexts).toEqual([]);
    expect(pipeline.snapshot()).toMatchObject({
      state: "attached",
      graphCount: 0,
      historyGeneration: 1,
    });

    const descriptorCounts = new Map<PropertyKey, number>();
    const capturedOnce = new Proxy(base, {
      getOwnPropertyDescriptor(target, property) {
        descriptorCounts.set(property, (descriptorCounts.get(property) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const ignored = Object.freeze({ name: "metadata", kind: "telemetry" });
    const prototypeMethod = vi.fn(() => {
      throw new Error("caller array prototype methods must not run");
    });
    const inventory = [ignored, capturedOnce];
    Object.setPrototypeOf(inventory, Object.create(Array.prototype, {
      filter: { configurable: true, get: prototypeMethod },
      map: { configurable: true, get: prototypeMethod },
      [Symbol.iterator]: { configurable: true, get: prototypeMethod },
    }));
    await expect(pipeline.precompile(inventory)).resolves.toBeUndefined();
    expect(prototypeMethod).not.toHaveBeenCalled();
    expect(Object.fromEntries(descriptorCounts)).toEqual({
      name: 1,
      kind: 1,
      variant: 1,
      scene: 1,
      camera: 1,
    });
    expect(harness.graphs.every((graph) => graph.precompile.mock.calls.length === 1)).toBe(true);
    expect(harness.contexts.every((context) => context.passes.length === 1)).toBe(true);
    await pipeline.dispose();
  });

  it("warms every WebGPU profile plus explicit material passes before ready", async () => {
    const harness = graphHarness();
    const raw = renderer();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(raw, "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    pipeline.quality(quality("balanced"));
    expect(pipeline.warmupPasses([quality("low"), quality("balanced"), quality("high")])).toEqual([]);
    const pass = runtimePass();
    const materialInventory = WORLD_MATERIAL_FAMILIES.flatMap((family) => [
      materialPass(family, "webgpu-full"),
      materialPass(family, "webgpu-lean"),
    ]);
    await pipeline.precompile([...materialInventory, pass]);

    expect(raw.compileAsync).not.toHaveBeenCalled();
    expect(harness.contexts.map((context) => context.profile.id)).toEqual([
      "webgpu-high-temporal",
      "webgpu-high-static",
      "webgpu-balanced-temporal",
      "webgpu-balanced-static",
      "webgpu-low-static",
    ]);
    expect(harness.contexts.every((context) => context.passes.length === 1)).toBe(true);
    expect(harness.contexts.every((context) => context.materialWarmupPasses.length === 14)).toBe(true);
    expect(harness.contexts.every((context) => (
      new Set(context.materialWarmupPasses.map((candidate) => (
        `${candidate.name}/${candidate.variant}`
      ))).size === 14
    ))).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      state: "ready",
      actualApi: "WebGPU",
      activeProfileId: "webgpu-balanced-temporal",
      graphCount: 5,
      compileEvents: 80,
      compileEventsAtReady: 80,
      runtimeCompileEvents: 0,
      programCountAtReady: 8,
      outputTransformCount: 1,
      intermediateType: "half-float",
      depthOwned: true,
      velocityOwned: true,
      historyOwned: true,
    });
    await pipeline.dispose();
  });

  it("warms every material/profile combination before a dynamic material can enter the scene", async () => {
    const raw = renderer(0);
    const compiled = new Set<string>();
    const activated = materialPass();
    const factory: LinearHdrGraphFactory = (context) => ({
      profile: context.profile,
      passSignature: context.passSignature,
      depthOwned: true,
      velocityOwned: context.profile.temporal,
      historyOwned: context.profile.temporal,
      async precompile() {
        let events = 1;
        for (const candidate of context.materialWarmupPasses) {
          const key = `${context.profile.id}/${candidate.name}/${candidate.variant ?? "absent"}`;
          if (!compiled.has(key)) {
            compiled.add(key);
            raw.info.memory.programs += 1;
            events += 1;
          }
        }
        return events;
      },
      setHistoryWeight() {},
      resize() {},
      async render() {
        const key = `${context.profile.id}/${activated.name}/${activated.variant ?? "absent"}`;
        if (!compiled.has(key)) raw.info.memory.programs += 1;
      },
      async dispose() {},
    });
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: factory });
    pipeline.attachBackend(raw, "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    pipeline.quality(quality("high"));
    const pass = runtimePass();
    await pipeline.precompile([activated, pass]);

    expect(compiled.size).toBe(5);
    expect([...compiled].every((key) => key.includes("gfx005-material:water/webgpu-full")))
      .toBe(true);
    await expect(pipeline.submit([pass])).resolves.toBeUndefined();
    expect(pipeline.snapshot()).toMatchObject({
      programCountAtReady: 5,
      programGrowthAfterReady: 0,
      runtimeCompileEvents: 0,
    });
    await pipeline.dispose();
  });

  it("forces every WebGL2 quality tier onto a non-temporal fallback", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgl2", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    pipeline.quality(quality("high", true));
    const pass = runtimePass();
    await pipeline.precompile([pass]);

    expect(harness.contexts.map((context) => context.profile.id)).toEqual([
      "webgl2-high-static",
      "webgl2-balanced-static",
      "webgl2-low-static",
    ]);
    expect(harness.graphs.every((graph) => !graph.velocityOwned && !graph.historyOwned)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      activeProfileId: "webgl2-high-static",
      graphCount: 3,
      velocityOwned: false,
      historyOwned: false,
    });
    pipeline.quality(quality("low", true));
    expect(pipeline.snapshot().activeProfileId).toBe("webgl2-low-static");
    await pipeline.dispose();
  });

  it("uses invalid history at weight zero, then reuses it without compiling", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    pipeline.quality(quality("high"));
    const pass = runtimePass();
    await pipeline.precompile([pass]);
    const active = harness.graphs.find((graph) => graph.profile.id === "webgpu-high-temporal")!;

    await pipeline.submit([pass]);
    await pipeline.submit([pass]);
    expect(active.setHistoryWeight.mock.calls).toEqual([[0], [0.1]]);
    expect(active.render).toHaveBeenCalledTimes(2);
    expect(pipeline.snapshot()).toMatchObject({
      historyValid: true,
      runtimeCompileEvents: 0,
      compileEvents: pipeline.snapshot().compileEventsAtReady,
    });
    await pipeline.dispose();
  });

  it("supports all nine reset reasons and deduplicates the backend/feature double path", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass = runtimePass();
    await pipeline.precompile([pass]);

    for (const reason of RENDER_HISTORY_INVALIDATION_REASONS) {
      pipeline.invalidateHistory(historyEvent(reason));
      pipeline.invalidateHistory(historyEvent(reason));
    }
    const before = pipeline.snapshot();
    expect(Object.keys(before.historyResetCounts)).toEqual(RENDER_HISTORY_INVALIDATION_REASONS);
    expect(Object.values(before.historyResetCounts)).toEqual(new Array(9).fill(1));
    expect(new Set(before.pendingHistoryResets)).toEqual(new Set(RENDER_HISTORY_INVALIDATION_REASONS));

    await pipeline.submit([pass]);
    expect(pipeline.snapshot().pendingHistoryResets).toEqual([]);
    await pipeline.dispose();
  });

  it("admits history invalidation before reason access and fences every nested mutator", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass = runtimePass();
    await pipeline.precompile([pass]);
    const tierGet = vi.fn(() => "high" as const);
    const nestedQuality = { features: Object.freeze({ temporal: true }) } as Record<string, unknown>;
    Object.defineProperty(nestedQuality, "tier", { enumerable: true, get: tierGet });
    const widthGet = vi.fn(() => 1024);
    const nestedViewport = { height: 576, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(nestedViewport, "width", { enumerable: true, get: widthGet });
    const passGets = vi.fn(() => { throw new Error("nested passes must not be inspected"); });
    const hostilePasses = new Proxy([], { get: passGets });
    const nestedReasonGet = vi.fn(() => "resize" as const);
    const nestedEvent = {} as Record<string, unknown>;
    Object.defineProperty(nestedEvent, "reason", { enumerable: true, get: nestedReasonGet });
    const failures: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    const outerReasonGet = vi.fn(() => {
      try {
        pipeline.quality(nestedQuality as unknown as RenderQualityProfile);
      } catch (error: unknown) {
        failures.push(error);
      }
      try {
        pipeline.invalidateHistory(nestedEvent as unknown as RenderHistoryInvalidation);
      } catch (error: unknown) {
        failures.push(error);
      }
      pending.push(pipeline.resize(nestedViewport as unknown as RenderViewport).catch(
        (error: unknown) => error,
      ));
      pending.push(pipeline.precompile(
        hostilePasses as unknown as readonly RenderPass[],
      ).catch((error: unknown) => error));
      pending.push(pipeline.submit(
        hostilePasses as unknown as readonly RenderPass[],
      ).catch((error: unknown) => error));
      return "camera-discontinuity" as const;
    });
    const outerEvent = {} as Record<string, unknown>;
    Object.defineProperty(outerEvent, "reason", { enumerable: true, get: outerReasonGet });

    pipeline.invalidateHistory(outerEvent as unknown as RenderHistoryInvalidation);
    failures.push(...await Promise.all(pending));
    expect(failures).toHaveLength(5);
    expect(failures.every((failure) => (
      failure instanceof Error && /operation is active|history is active/.test(failure.message)
    ))).toBe(true);
    expect(outerReasonGet).toHaveBeenCalledOnce();
    expect(tierGet).not.toHaveBeenCalled();
    expect(widthGet).not.toHaveBeenCalled();
    expect(passGets).not.toHaveBeenCalled();
    expect(nestedReasonGet).not.toHaveBeenCalled();
    expect(harness.graphs.every((graph) => graph.resize.mock.calls.length === 0)).toBe(true);
    expect(harness.graphs.every((graph) => graph.render.mock.calls.length === 0)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      activeProfileId: "webgpu-balanced-temporal",
      historyResetCounts: { "camera-discontinuity": 1, resize: 0 },
    });
    await pipeline.dispose();
  });

  it("aborts history invalidation when its reason accessor requests disposal", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    await pipeline.precompile([runtimePass()]);
    let disposal: Promise<void> | null = null;
    const reasonGet = vi.fn(() => {
      disposal = pipeline.dispose();
      return "camera-discontinuity" as const;
    });
    const event = {} as Record<string, unknown>;
    Object.defineProperty(event, "reason", { enumerable: true, get: reasonGet });

    expect(() => pipeline.invalidateHistory(
      event as unknown as RenderHistoryInvalidation,
    )).toThrow(/disposal was requested|pipeline is disposing/);
    expect(reasonGet).toHaveBeenCalledOnce();
    await expect(disposal).resolves.toBeUndefined();
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      state: "disposed",
      historyResetCounts: { "camera-discontinuity": 0 },
      cleanupPendingGraphs: 0,
    });
  });

  it("releases history invalidation admission after reason capture throws", async () => {
    const pipeline = new ProductionLinearHdrPipeline();
    pipeline.attachBackend(renderer(), "webgl2", viewport);
    const captureFailure = new Error("history reason capture failed");
    const reasonGet = vi.fn(() => { throw captureFailure; });
    const event = {} as Record<string, unknown>;
    Object.defineProperty(event, "reason", { enumerable: true, get: reasonGet });

    expect(() => pipeline.invalidateHistory(
      event as unknown as RenderHistoryInvalidation,
    )).toThrow(captureFailure);
    expect(reasonGet).toHaveBeenCalledOnce();
    expect(() => pipeline.invalidateHistory(historyEvent("camera-discontinuity"))).not.toThrow();
    expect(pipeline.snapshot()).toMatchObject({
      state: "attached",
      historyResetCounts: { "camera-discontinuity": 1 },
    });
    await pipeline.dispose();
  });

  it("treats absent variants and an explicit default string as distinct warmed graphs", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgl2", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const absent = runtimePass();
    await pipeline.precompile([absent]);
    await pipeline.submit([absent]);
    await expect(pipeline.submit([runtimePass("default")])).rejects.toThrow(/did not match/);
    await pipeline.dispose();
  });

  it("requires the exact material inventory on every post-ready precompile", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass = runtimePass();
    const material = materialPass();
    await pipeline.precompile([material, pass]);
    await expect(pipeline.precompile([material, pass])).resolves.toBeUndefined();
    await expect(pipeline.precompile([{
      ...material,
      variant: "webgpu-lean",
    }, pass])).rejects.toThrow(/unwarmed pass graph/);
    await expect(pipeline.precompile([pass])).rejects.toThrow(/unwarmed pass graph/);
    expect(harness.graphs.every((graph) => graph.precompile.mock.calls.length === 1)).toBe(true);
    await pipeline.dispose();
  });

  it("uses an injective tuple encoding when pass fields contain former delimiter bytes", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgl2", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const scene = {};
    const camera = {};
    const warmed: RenderPass = Object.freeze({
      name: "c",
      kind: "a\u001fb",
      scene,
      camera,
    });
    const formerAlias: RenderPass = Object.freeze({
      name: "b\u001fc",
      kind: "a",
      scene,
      camera,
    });
    await pipeline.precompile([warmed]);
    await pipeline.submit([warmed]);
    await expect(pipeline.submit([formerAlias])).rejects.toThrow(/did not match/);
    await pipeline.dispose();
  });

  it("keeps pass signatures injective when Array prototype JSON hooks are poisoned", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgl2", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const warmed = runtimePass();
    const formerAlias = Object.freeze({ ...warmed, scene: {} });
    const priorToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const priorPrototypeVariant = Object.getOwnPropertyDescriptor(Object.prototype, "variant");
    const poisonedToJson = vi.fn(() => ["aliased"]);
    const prototypeVariantGetter = vi.fn(() => "prototype-variant");
    Object.defineProperty(Array.prototype, "toJSON", {
      configurable: true,
      value: poisonedToJson,
      writable: true,
    });
    Object.defineProperty(Object.prototype, "variant", {
      configurable: true,
      get: prototypeVariantGetter,
    });
    try {
      await pipeline.precompile([warmed]);
      await pipeline.submit([warmed]);
      await expect(pipeline.submit([formerAlias])).rejects.toThrow(/did not match/);
      expect(poisonedToJson).not.toHaveBeenCalled();
      expect(prototypeVariantGetter).not.toHaveBeenCalled();
    } finally {
      if (priorToJson) {
        Object.defineProperty(Array.prototype, "toJSON", priorToJson);
      } else {
        Reflect.deleteProperty(Array.prototype, "toJSON");
      }
      if (priorPrototypeVariant) {
        Object.defineProperty(Object.prototype, "variant", priorPrototypeVariant);
      } else {
        Reflect.deleteProperty(Object.prototype, "variant");
      }
      await pipeline.dispose();
    }
  });

  it("does not consume poisoned Array prototype iteration after pass capture", async () => {
    let graphCount = 0;
    let renderCount = 0;
    let disposeCount = 0;
    const factory: LinearHdrGraphFactory = (context) => {
      graphCount += 1;
      return {
        profile: context.profile,
        passSignature: context.passSignature,
        depthOwned: true,
        velocityOwned: context.profile.temporal,
        historyOwned: context.profile.temporal,
        async precompile() { return 1; },
        setHistoryWeight() {},
        resize() {},
        render() { renderCount += 1; },
        dispose() { disposeCount += 1; },
      };
    };
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const source = runtimePass();
    const mapDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "map")!;
    const sliceDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "slice")!;
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    )!;
    let mapAccesses = 0;
    let sliceAccesses = 0;
    let iteratorCalls = 0;
    const mapAccess = () => {
      mapAccesses += 1;
      return mapDescriptor.value;
    };
    const sliceAccess = () => {
      sliceAccesses += 1;
      return sliceDescriptor.value;
    };
    const emptyIterator = () => {
      iteratorCalls += 1;
      return { next: () => ({ done: true as const, value: undefined }) };
    };
    let poisonInstalled = false;
    const hostile = new Proxy(source, {
      getOwnPropertyDescriptor(target, property) {
        if (!poisonInstalled) {
          poisonInstalled = true;
          Object.defineProperty(Array.prototype, "map", {
            configurable: true,
            get: mapAccess,
          });
          Object.defineProperty(Array.prototype, "slice", {
            configurable: true,
            get: sliceAccess,
          });
          Object.defineProperty(Array.prototype, Symbol.iterator, {
            configurable: true,
            value: emptyIterator,
            writable: true,
          });
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    try {
      await pipeline.precompile([hostile]);
    } finally {
      Object.defineProperty(Array.prototype, "map", mapDescriptor);
      Object.defineProperty(Array.prototype, "slice", sliceDescriptor);
      Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor);
    }
    expect(poisonInstalled).toBe(true);
    expect(mapAccesses).toBe(0);
    expect(sliceAccesses).toBe(0);
    expect(iteratorCalls).toBe(0);
    expect(pipeline.snapshot()).toMatchObject({ state: "ready", graphCount: 5 });
    expect(graphCount).toBe(5);
    await expect(pipeline.submit([source])).resolves.toBeUndefined();
    expect(renderCount).toBe(1);
    await pipeline.dispose();
    expect(disposeCount).toBe(5);
  });

  it("rejects a new runtime graph and post-ready program growth instead of compiling", async () => {
    const harness = graphHarness();
    const raw = renderer();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(raw, "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass = runtimePass();
    await pipeline.precompile([pass]);
    await expect(pipeline.submit([{ ...pass, scene: {} }])).rejects.toThrow(/did not match/);
    raw.info.memory.programs = 9;
    await expect(pipeline.submit([pass])).rejects.toThrow(/program count grew/);
    expect(pipeline.snapshot()).toMatchObject({
      runtimeCompileEvents: 0,
      programGrowthAfterReady: 1,
    });
    await pipeline.dispose();
  });

  it("applies backend and feature resize/dispose paths exactly once", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    await pipeline.precompile([runtimePass()]);
    const resized = Object.freeze({ width: 1024, height: 576, pixelRatio: 1.25 });

    await pipeline.resize(resized);
    await pipeline.resize(resized);
    pipeline.invalidateHistory(historyEvent("resize"));
    expect(harness.graphs.every((graph) => graph.resize.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot().historyResetCounts.resize).toBe(1);

    const first = pipeline.dispose();
    const second = pipeline.dispose();
    expect(second).toBe(first);
    await first;
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({ state: "disposed", disposedGraphs: 5 });
  });

  it("retries an incomplete five-profile resize without duplicating its history reset", async () => {
    const harness = graphHarness({ failResizeOnceAt: 2 });
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass = runtimePass();
    await pipeline.precompile([pass]);
    const resized = Object.freeze({ width: 1024, height: 576, pixelRatio: 1.25 });

    await expect(pipeline.resize(resized)).rejects.toThrow(/resize 2 failed once/);
    expect(harness.graphs.map((graph) => graph.resize.mock.calls.length)).toEqual([
      1,
      1,
      1,
      0,
      0,
    ]);
    expect(pipeline.snapshot()).toMatchObject({
      state: "ready",
      activeProfileId: "webgpu-balanced-temporal",
      historyResetCounts: { resize: 0 },
    });
    expect(() => pipeline.quality(quality("high"))).toThrow(/resize is incomplete/);
    await expect(pipeline.precompile([pass])).rejects.toThrow(/resize is incomplete/);
    await expect(pipeline.submit([pass])).rejects.toThrow(/resize is incomplete/);
    await expect(pipeline.resize({ ...resized, width: 1280 })).rejects.toThrow(
      /target.*incomplete/,
    );
    expect(pipeline.snapshot().historyResetCounts.resize).toBe(0);

    await expect(pipeline.resize({ ...resized })).resolves.toBeUndefined();
    expect(harness.graphs.map((graph) => graph.resize.mock.calls.length)).toEqual([
      1,
      1,
      2,
      1,
      1,
    ]);
    for (const graph of harness.graphs) {
      for (const [target] of graph.resize.mock.calls) expect(target).toEqual(resized);
    }
    expect(pipeline.snapshot().historyResetCounts.resize).toBe(1);
    pipeline.quality(quality("high"));
    await expect(pipeline.precompile([pass])).resolves.toBeUndefined();
    await expect(pipeline.submit([pass])).resolves.toBeUndefined();
    const active = harness.graphs.find((graph) => graph.profile.id === "webgpu-high-temporal")!;
    expect(active.render).toHaveBeenCalledOnce();
    expect(pipeline.snapshot()).toMatchObject({
      state: "ready",
      activeProfileId: "webgpu-high-temporal",
      historyResetCounts: { resize: 1 },
    });
    await pipeline.dispose();
  });

  it("snapshots resize graphs without a caller-poisoned Map iterator", async () => {
    const resizeCounts = new Map<string, number>();
    const factory: LinearHdrGraphFactory = (context) => ({
      profile: context.profile,
      passSignature: context.passSignature,
      depthOwned: true,
      velocityOwned: context.profile.temporal,
      historyOwned: context.profile.temporal,
      async precompile() { return 1; },
      setHistoryWeight() {},
      resize() {
        resizeCounts.set(
          context.profile.id,
          (resizeCounts.get(context.profile.id) ?? 0) + 1,
        );
      },
      render() {},
      dispose() {},
    });
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    await pipeline.precompile([runtimePass()]);
    const mapIteratorDescriptor = Object.getOwnPropertyDescriptor(Map.prototype, Symbol.iterator)!;
    const arrayIteratorDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    )!;
    let mapIteratorCalls = 0;
    let arrayIteratorCalls = 0;
    let widthReads = 0;
    let poisonInstalled = false;
    const widthGet = () => {
      widthReads += 1;
      poisonInstalled = true;
      Object.defineProperty(Map.prototype, Symbol.iterator, {
        configurable: true,
        value: () => {
          mapIteratorCalls += 1;
          return { next: () => ({ done: true as const, value: undefined }) };
        },
        writable: true,
      });
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        value: () => {
          arrayIteratorCalls += 1;
          return { next: () => ({ done: true as const, value: undefined }) };
        },
        writable: true,
      });
      return 1024;
    };
    const hostileViewport = { height: 576, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(hostileViewport, "width", { enumerable: true, get: widthGet });
    try {
      await pipeline.resize(hostileViewport as unknown as RenderViewport);
    } finally {
      Object.defineProperty(Map.prototype, Symbol.iterator, mapIteratorDescriptor);
      Object.defineProperty(Array.prototype, Symbol.iterator, arrayIteratorDescriptor);
    }
    expect(poisonInstalled).toBe(true);
    expect(widthReads).toBe(1);
    expect(mapIteratorCalls).toBe(0);
    expect(arrayIteratorCalls).toBe(0);
    expect([...resizeCounts.values()]).toEqual([1, 1, 1, 1, 1]);
    expect(pipeline.snapshot()).toMatchObject({
      state: "ready",
      graphCount: 5,
      historyResetCounts: { resize: 1 },
    });
    await pipeline.dispose();
  });

  it("fences operations and drains disposal across an asynchronous graph resize", async () => {
    const gate = deferredVoid();
    const harness = graphHarness({ resizeGate: { index: 2, promise: gate.promise } });
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass = runtimePass();
    await pipeline.precompile([pass]);
    const resized = Object.freeze({ width: 1024, height: 576, pixelRatio: 1.25 });

    const resizing = pipeline.resize(resized);
    await vi.waitFor(() => expect(harness.graphs[2]?.resize).toHaveBeenCalledOnce());
    expect(() => pipeline.quality(quality("high"))).toThrow(/resize is incomplete/);
    await expect(pipeline.precompile([pass])).rejects.toThrow(/resize is incomplete/);
    await expect(pipeline.submit([pass])).rejects.toThrow(/resize is incomplete/);
    await expect(pipeline.resize({ ...resized, width: 1280 })).rejects.toThrow(
      /operation is active/,
    );
    expect(pipeline.snapshot().historyResetCounts.resize).toBe(0);

    const disposal = pipeline.dispose();
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 0)).toBe(true);
    gate.resolve();
    await resizing;
    await disposal;
    expect(harness.graphs.every((graph) => graph.resize.mock.calls.length === 1)).toBe(true);
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      state: "disposed",
      historyResetCounts: { resize: 1 },
    });
  });

  it("drains a rejected asynchronous resize before disposing every graph", async () => {
    const gate = deferredVoid();
    const harness = graphHarness({ resizeGate: { index: 2, promise: gate.promise } });
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    await pipeline.precompile([runtimePass()]);
    const resized = Object.freeze({ width: 1024, height: 576, pixelRatio: 1.25 });

    const resizing = pipeline.resize(resized);
    await vi.waitFor(() => expect(harness.graphs[2]?.resize).toHaveBeenCalledOnce());
    const disposal = pipeline.dispose();
    gate.reject(new Error("async resize rejected"));

    await expect(resizing).rejects.toThrow("async resize rejected");
    await expect(disposal).resolves.toBeUndefined();
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      state: "disposed",
      historyResetCounts: { resize: 0 },
      cleanupPendingGraphs: 0,
    });
  });

  it("rejects owner disposal reentry from graph resize without claiming disposal", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    await pipeline.precompile([runtimePass()]);
    const resized = Object.freeze({ width: 1024, height: 576, pixelRatio: 1.25 });
    harness.graphs[0]!.resize.mockImplementationOnce(async () => {
      await pipeline.dispose();
    });

    await expect(pipeline.resize(resized)).rejects.toThrow(/reentrantly from a graph callback/);
    expect(pipeline.snapshot()).toMatchObject({
      state: "ready",
      historyResetCounts: { resize: 0 },
      disposedGraphs: 0,
    });
    await expect(pipeline.resize({ ...resized })).resolves.toBeUndefined();
    await expect(pipeline.dispose()).resolves.toBeUndefined();
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("rejects a graph callback that reenters frame submission", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    pipeline.quality(quality("high"));
    const pass = runtimePass();
    await pipeline.precompile([pass]);
    const active = harness.graphs.find((graph) => graph.profile.id === "webgpu-high-temporal")!;
    active.render.mockImplementationOnce(async () => {
      await pipeline.submit([pass]);
    });

    await expect(pipeline.submit([pass])).rejects.toThrow(/reentrantly from a graph callback/);
    expect(active.render).toHaveBeenCalledOnce();
    await expect(pipeline.submit([pass])).resolves.toBeUndefined();
    expect(active.render).toHaveBeenCalledTimes(2);
    await pipeline.dispose();
  });

  it("retains and retries a graph whose disposer rejects owner disposal reentry", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    await pipeline.precompile([runtimePass()]);
    harness.graphs[0]!.dispose.mockImplementationOnce(async () => {
      await pipeline.dispose();
    });

    await expect(pipeline.dispose()).rejects.toThrow(/pipeline disposal failed/);
    expect(pipeline.snapshot()).toMatchObject({
      state: "failed",
      disposedGraphs: 4,
      cleanupPendingGraphs: 1,
    });
    await expect(pipeline.dispose()).resolves.toBeUndefined();
    expect(harness.graphs[0]!.dispose).toHaveBeenCalledTimes(2);
    expect(harness.graphs.slice(1).every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({ state: "disposed", cleanupPendingGraphs: 0 });
  });

  it("rejects resize before mutation while precompile or submit is active", async () => {
    const precompileGate = deferredVoid();
    const harness = graphHarness({
      precompileGate: { index: 0, promise: precompileGate.promise },
    });
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass = runtimePass();
    const resized = Object.freeze({ width: 1024, height: 576, pixelRatio: 1.25 });

    const warming = pipeline.precompile([pass]);
    await vi.waitFor(() => expect(harness.graphs[0]?.precompile).toHaveBeenCalledOnce());
    await expect(pipeline.resize(resized)).rejects.toThrow(/operation is active/);
    expect(harness.graphs.every((graph) => graph.resize.mock.calls.length === 0)).toBe(true);
    expect(pipeline.snapshot().historyResetCounts.resize).toBe(0);
    precompileGate.resolve();
    await warming;

    pipeline.quality(quality("high"));
    const active = harness.graphs.find((graph) => graph.profile.id === "webgpu-high-temporal")!;
    const submitGate = deferredVoid();
    active.render.mockImplementation(async () => submitGate.promise);
    const submitting = pipeline.submit([pass]);
    await vi.waitFor(() => expect(active.render).toHaveBeenCalledOnce());
    await expect(pipeline.resize(resized)).rejects.toThrow(/operation is active/);
    expect(harness.graphs.every((graph) => graph.resize.mock.calls.length === 0)).toBe(true);
    expect(pipeline.snapshot().historyResetCounts.resize).toBe(0);

    submitGate.resolve();
    await submitting;
    await pipeline.dispose();
  });

  it("rejects a submit started reentrantly by a resize viewport accessor", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass = runtimePass();
    await pipeline.precompile([pass]);
    let reentrantSubmit: Promise<void> | null = null;
    const widthGetter = vi.fn(() => {
      reentrantSubmit = pipeline.submit([pass]);
      return 1024;
    });
    const hostileViewport = { height: 576, pixelRatio: 1.25 } as Record<string, unknown>;
    Object.defineProperty(hostileViewport, "width", { enumerable: true, get: widthGetter });

    await expect(pipeline.resize(hostileViewport as unknown as typeof viewport))
      .resolves.toBeUndefined();
    expect(widthGetter).toHaveBeenCalledOnce();
    await expect(reentrantSubmit).rejects.toThrow(/resize is incomplete|pipeline resize is active/);
    expect(harness.graphs.every((graph) => graph.resize.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot().historyResetCounts.resize).toBe(1);
    await pipeline.dispose();
  });

  it("aborts resize after a viewport accessor requests disposal", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    await pipeline.precompile([runtimePass()]);
    let disposal: Promise<void> | null = null;
    const widthGetter = vi.fn(() => {
      disposal = pipeline.dispose();
      return 1024;
    });
    const hostileViewport = { height: 576, pixelRatio: 1.25 } as Record<string, unknown>;
    Object.defineProperty(hostileViewport, "width", { enumerable: true, get: widthGetter });

    await expect(
      pipeline.resize(hostileViewport as unknown as typeof viewport),
    ).rejects.toThrow(/disposal was requested/);
    expect(widthGetter).toHaveBeenCalledOnce();
    expect(harness.graphs.every((graph) => graph.resize.mock.calls.length === 0)).toBe(true);
    expect(pipeline.snapshot().historyResetCounts.resize).toBe(0);
    await expect(disposal).resolves.toBeUndefined();
    expect(pipeline.snapshot().state).toBe("disposed");
  });

  it("captures quality descriptors without getters and fences reentrant mutations", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass = runtimePass();
    await pipeline.precompile([pass]);
    const resized = Object.freeze({ width: 1024, height: 576, pixelRatio: 1.25 });
    const tierGetter = vi.fn(() => "high" as const);
    const accessorProfile = { ...quality("balanced") } as Record<string, unknown>;
    Object.defineProperty(accessorProfile, "tier", { enumerable: true, get: tierGetter });
    expect(() => pipeline.quality(
      accessorProfile as unknown as RenderQualityProfile,
    )).toThrow(/tier must be an own data property/);
    expect(tierGetter).not.toHaveBeenCalled();

    const featuresGetter = vi.fn(() => Object.freeze({ temporal: true }));
    const accessorFeatures = { tier: "high" } as Record<string, unknown>;
    Object.defineProperty(accessorFeatures, "features", {
      enumerable: true,
      get: featuresGetter,
    });
    expect(() => pipeline.quality(
      accessorFeatures as unknown as RenderQualityProfile,
    )).toThrow(/features must be an own data property/);
    expect(featuresGetter).not.toHaveBeenCalled();

    const ordinaryGets = vi.fn(() => { throw new Error("ordinary get must not run"); });
    const features = new Proxy(Object.freeze({ temporal: true }), {
      get: ordinaryGets,
      getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
    });
    const source = Object.freeze({ ...quality("high"), features });
    const asyncFailures: Promise<unknown>[] = [];
    let nestedQualityFailure: unknown = null;
    let attacked = false;
    const hostile = new Proxy(source, {
      get: ordinaryGets,
      getOwnPropertyDescriptor(target, key) {
        if (!attacked && key === "tier") {
          attacked = true;
          asyncFailures.push(pipeline.resize(resized).catch((error: unknown) => error));
          asyncFailures.push(pipeline.precompile([pass]).catch((error: unknown) => error));
          asyncFailures.push(pipeline.submit([pass]).catch((error: unknown) => error));
          try {
            pipeline.quality(quality("low"));
          } catch (error: unknown) {
            nestedQualityFailure = error;
          }
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(() => pipeline.quality(hostile)).not.toThrow();
    const failures = await Promise.all(asyncFailures);
    expect(failures).toHaveLength(3);
    expect(failures.every((error) => (
      error instanceof Error && /operation is active|quality is active/.test(error.message)
    ))).toBe(true);
    expect(nestedQualityFailure).toMatchObject({ message: expect.stringMatching(/operation is active/) });
    expect(ordinaryGets).not.toHaveBeenCalled();
    expect(harness.graphs.every((graph) => graph.resize.mock.calls.length === 0)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      activeProfileId: "webgpu-high-temporal",
      historyResetCounts: { resize: 0 },
    });
    await pipeline.dispose();
  });

  it("aborts quality commit when descriptor inspection requests disposal", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    await pipeline.precompile([runtimePass()]);
    const source = quality("high");
    let disposal: Promise<void> | null = null;
    let attacked = false;
    const hostile = new Proxy(source, {
      getOwnPropertyDescriptor(target, key) {
        if (!attacked && key === "tier") {
          attacked = true;
          disposal = pipeline.dispose();
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(() => pipeline.quality(hostile)).toThrow(/disposal was requested/);
    await expect(disposal).resolves.toBeUndefined();
    expect(pipeline.snapshot()).toMatchObject({
      state: "disposed",
      activeProfileId: "webgpu-balanced-temporal",
    });
  });

  it("awaits an asynchronous history-weight callback before render and disposal", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    pipeline.quality(quality("high"));
    const pass = runtimePass();
    await pipeline.precompile([pass]);
    const active = harness.graphs.find((graph) => graph.profile.id === "webgpu-high-temporal")!;
    const gate = deferredVoid();
    active.setHistoryWeight.mockImplementationOnce(() => gate.promise);

    const submitting = pipeline.submit([pass]);
    await vi.waitFor(() => expect(active.setHistoryWeight).toHaveBeenCalledOnce());
    expect(active.render).not.toHaveBeenCalled();
    const disposal = pipeline.dispose();
    expect(active.dispose).not.toHaveBeenCalled();

    gate.resolve();
    await submitting;
    await disposal;
    expect(active.render).toHaveBeenCalledOnce();
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("unwinds partial warm-up and freezes copied failure evidence without cycles", async () => {
    const external = new Error("dispose failed") as Error & { cause?: unknown };
    external.cause = external;
    const harness = graphHarness({ failPrecompileAt: 1, disposeFailure: external });
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);

    const failure = await pipeline.precompile([runtimePass()]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen((failure as AggregateError).errors)).toBe(true);
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
    external.message = "mutated later";
    const evidence = JSON.stringify((failure as AggregateError).errors);
    expect(evidence).toContain("dispose failed");
    expect(evidence).not.toContain("mutated later");
    expect(pipeline.snapshot()).toMatchObject({
      state: "failed",
      graphCount: 2,
      cleanupPendingGraphs: 2,
    });
    const disposal = pipeline.dispose();
    await expect(disposal).rejects.toThrow(/pipeline disposal failed/);
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 2)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      state: "failed",
      graphCount: 2,
      cleanupPendingGraphs: 2,
    });
  });

  it("captures custom graph data and methods before ownership without invoking accessors", async () => {
    const profileGetter = vi.fn(() => {
      throw new Error("profile getter must not run");
    });
    const renderGetter = vi.fn(() => {
      throw new Error("render getter must not run");
    });
    const invalidDispose = vi.fn(async () => undefined);
    const invalid = {
      passSignature: "invalid",
      depthOwned: true,
      velocityOwned: true,
      historyOwned: true,
      async precompile() { return 1; },
      setHistoryWeight() {},
      resize() {},
      dispose: invalidDispose,
    } as Record<string, unknown>;
    Object.defineProperty(invalid, "profile", { enumerable: true, get: profileGetter });
    Object.defineProperty(invalid, "render", { enumerable: true, get: renderGetter });
    const pipeline = new ProductionLinearHdrPipeline({
      graphFactory: () => invalid as unknown as LinearHdrGraph,
    });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);

    await expect(pipeline.precompile([runtimePass()])).rejects.toThrow(/warm-up failed/);
    expect(renderGetter).not.toHaveBeenCalled();
    expect(profileGetter).not.toHaveBeenCalled();
    expect(invalidDispose).toHaveBeenCalledOnce();
    expect(pipeline.snapshot()).toMatchObject({
      state: "failed",
      graphCount: 0,
      cleanupPendingGraphs: 0,
    });

    const profileOnlyGetter = vi.fn(() => {
      throw new Error("profile getter must not run");
    });
    const profileDispose = vi.fn(async () => undefined);
    const invalidProfile = {
      passSignature: "invalid",
      depthOwned: true,
      velocityOwned: true,
      historyOwned: true,
      async precompile() { return 1; },
      setHistoryWeight() {},
      resize() {},
      async render() {},
      dispose: profileDispose,
    } as Record<string, unknown>;
    Object.defineProperty(invalidProfile, "profile", {
      enumerable: true,
      get: profileOnlyGetter,
    });
    const profilePipeline = new ProductionLinearHdrPipeline({
      graphFactory: () => invalidProfile as unknown as LinearHdrGraph,
    });
    profilePipeline.attachBackend(renderer(), "webgpu", viewport);
    await profilePipeline.initialize({} as FeatureInitContext);
    await expect(profilePipeline.precompile([runtimePass()])).rejects.toThrow(/warm-up failed/);
    expect(profileOnlyGetter).not.toHaveBeenCalled();
    expect(profileDispose).toHaveBeenCalledOnce();
    expect(profilePipeline.snapshot()).toMatchObject({
      state: "failed",
      cleanupPendingGraphs: 0,
    });
  });

  it("invokes captured graph methods without consulting own or inherited call getters", async () => {
    const callGetter = vi.fn(() => () => 1);
    const precompileCalls = new Map<string, number>();
    const weightCalls = new Map<string, number>();
    const resizeCalls = new Map<string, number>();
    const renderCalls = new Map<string, number>();
    const disposeCalls = new Map<string, number>();
    let graphIndex = 0;
    const increment = (counts: Map<string, number>, id: string): void => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    };
    const factory: LinearHdrGraphFactory = (context) => {
      const index = graphIndex;
      graphIndex += 1;
      const id = context.profile.id;
      const precompile = async () => { increment(precompileCalls, id); return 1; };
      const setHistoryWeight = () => { increment(weightCalls, id); };
      const resize = () => { increment(resizeCalls, id); };
      const render = () => { increment(renderCalls, id); };
      const dispose = () => { increment(disposeCalls, id); };
      const methods = [precompile, setHistoryWeight, resize, render, dispose];
      for (let methodIndex = 0; methodIndex < methods.length; methodIndex += 1) {
        const method = methods[methodIndex]!;
        if (index % 2 === 0) {
          Object.defineProperty(method, "call", { configurable: true, get: callGetter });
        } else {
          Object.setPrototypeOf(method, Object.create(Function.prototype, {
            call: { configurable: true, get: callGetter },
          }));
        }
      }
      return {
        profile: context.profile,
        passSignature: context.passSignature,
        depthOwned: true,
        velocityOwned: context.profile.temporal,
        historyOwned: context.profile.temporal,
        precompile,
        setHistoryWeight,
        resize,
        render,
        dispose,
      };
    };
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass = runtimePass();
    await pipeline.precompile([pass]);
    await pipeline.submit([pass]);
    await pipeline.resize({ width: 1024, height: 576, pixelRatio: 1 });
    await pipeline.dispose();

    expect(callGetter).not.toHaveBeenCalled();
    expect([...precompileCalls.values()]).toEqual([1, 1, 1, 1, 1]);
    expect([...weightCalls.values()]).toEqual([1]);
    expect([...resizeCalls.values()]).toEqual([1, 1, 1, 1, 1]);
    expect([...renderCalls.values()]).toEqual([1]);
    expect([...disposeCalls.values()]).toEqual([1, 1, 1, 1, 1]);
    expect(pipeline.snapshot()).toMatchObject({
      state: "disposed",
      graphCount: 0,
      disposedGraphs: 5,
      cleanupPendingGraphs: 0,
    });
  });

  it("uses captured custom graph callbacks after the factory object is mutated", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    pipeline.quality(quality("high"));
    const pass = runtimePass();
    await pipeline.precompile([pass]);
    const active = harness.graphs.find((graph) => graph.profile.id === "webgpu-high-temporal")!;
    const capturedRender = active.render;
    const replacement = vi.fn(async () => {
      throw new Error("mutated callback must not run");
    });
    active.render = replacement;

    await expect(pipeline.submit([pass])).resolves.toBeUndefined();
    expect(capturedRender).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    await pipeline.dispose();
  });

  it("rejects a graph identity aliased across profiles and disposes it only once", async () => {
    let shared: LinearHdrGraph | null = null;
    const dispose = vi.fn(async () => undefined);
    const factory: LinearHdrGraphFactory = (context) => {
      shared ??= {
        profile: context.profile,
        passSignature: context.passSignature,
        depthOwned: true,
        velocityOwned: context.profile.temporal,
        historyOwned: context.profile.temporal,
        async precompile() { return 1; },
        setHistoryWeight() {},
        resize() {},
        async render() {},
        dispose,
      };
      return shared;
    };
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);

    await expect(pipeline.precompile([runtimePass()])).rejects.toThrow(/warm-up failed/);
    expect(dispose).toHaveBeenCalledOnce();
    expect(pipeline.snapshot()).toMatchObject({ state: "failed", graphCount: 0 });
  });

  it("drains an active precompile before graph disposal and keeps dispose identity stable", async () => {
    const gate = deferredVoid();
    const harness = graphHarness({ precompileGate: { index: 0, promise: gate.promise } });
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);

    const warming = pipeline.precompile([runtimePass()]);
    expect(harness.graphs).toHaveLength(1);
    const first = pipeline.dispose();
    const second = pipeline.dispose();
    expect(second).toBe(first);
    expect(pipeline.snapshot().state).toBe("disposing");
    expect(harness.graphs[0]!.dispose).not.toHaveBeenCalled();
    gate.resolve();
    await warming;
    await first;
    expect(harness.graphs).toHaveLength(5);
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({ state: "disposed", disposedGraphs: 5 });
  });

  it("retains a graph whose warm-up cleanup failed and retries it without false-zero evidence", async () => {
    let disposeAttempts = 0;
    const graphDispose = vi.fn(async () => {
      disposeAttempts += 1;
      if (disposeAttempts === 1) throw new Error("first graph cleanup failed");
    });
    const factory: LinearHdrGraphFactory = (context) => ({
      profile: context.profile,
      passSignature: context.passSignature,
      depthOwned: true,
      velocityOwned: context.profile.temporal,
      historyOwned: context.profile.temporal,
      async precompile() {
        throw new Error("warm-up failed before ready");
      },
      setHistoryWeight() {},
      resize() {},
      async render() {},
      dispose: graphDispose,
    });
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);

    await expect(pipeline.precompile([runtimePass()])).rejects.toThrow(/warm-up failed/);
    expect(graphDispose).toHaveBeenCalledOnce();
    expect(pipeline.snapshot()).toMatchObject({
      state: "failed",
      graphCount: 1,
      cleanupPendingGraphs: 1,
      disposedGraphs: 0,
    });

    const first = pipeline.dispose();
    const second = pipeline.dispose();
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(graphDispose).toHaveBeenCalledTimes(2);
    expect(pipeline.snapshot()).toMatchObject({
      state: "disposed",
      graphCount: 0,
      cleanupPendingGraphs: 0,
      disposedGraphs: 1,
    });
  });

  it("conveys direct constructor cleanup ownership in a frozen retryable failure", () => {
    const prototypeProbe = tslPass(new Scene(), new PerspectiveCamera());
    const passPrototype = Object.getPrototypeOf(prototypeProbe) as {
      dispose(): void;
      setSize(width: number, height: number): void;
    };
    prototypeProbe.dispose();
    const originalPassDispose = passPrototype.dispose;
    const setSize = vi.spyOn(passPrototype, "setSize").mockImplementation(() => {
      throw new Error("direct setSize construction failed");
    });
    let passDisposeAttempts = 0;
    const passDispose = vi.spyOn(passPrototype, "dispose").mockImplementation(function (
      this: typeof passPrototype,
    ) {
      passDisposeAttempts += 1;
      if (passDisposeAttempts === 1) throw new Error("direct first cleanup failed");
      originalPassDispose.call(this);
    });
    const renderPipelineDispose = vi.spyOn(RenderPipeline.prototype, "dispose");
    try {
      const failure = (() => {
        try {
          createThreeLinearHdrGraph(Object.freeze({
            renderer: topologyRenderer().raw,
            profile: selectLinearHdrPipelineProfile("WebGPU", quality("high")),
            materialWarmupPasses: Object.freeze([]),
            passes: Object.freeze([{
              name: "world",
              kind: "opaque-pbr",
              scene: new Scene(),
              camera: new PerspectiveCamera(),
            }]),
            passSignature: "direct-construction-failure",
            viewport,
          }));
          throw new Error("construction unexpectedly succeeded");
        } catch (error: unknown) {
          return error as AggregateError & { readonly cleanup?: { dispose(): void } };
        }
      })();
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.name).toBe("LinearHdrGraphConstructionFailure");
      expect(JSON.stringify(failure.errors)).toContain("direct setSize construction failed");
      expect(Object.isFrozen(failure)).toBe(true);
      expect(failure.cleanup).toBeDefined();
      expect(Object.isFrozen(failure.cleanup)).toBe(true);
      expect(passDispose).not.toHaveBeenCalled();
      expect(renderPipelineDispose).not.toHaveBeenCalled();

      expect(() => failure.cleanup?.dispose()).toThrow(/graph disposal failed/);
      expect(passDispose).toHaveBeenCalledOnce();
      expect(renderPipelineDispose).toHaveBeenCalledOnce();
      expect(() => failure.cleanup?.dispose()).not.toThrow();
      expect(passDispose).toHaveBeenCalledTimes(2);
      expect(renderPipelineDispose).toHaveBeenCalledOnce();
      expect(() => failure.cleanup?.dispose()).not.toThrow();
      expect(passDispose).toHaveBeenCalledTimes(2);
    } finally {
      setSize.mockRestore();
      passDispose.mockRestore();
      renderPipelineDispose.mockRestore();
    }
  });

  it("retains a partially constructed setSize target until pipeline disposal retries it", async () => {
    const prototypeProbe = tslPass(new Scene(), new PerspectiveCamera());
    const passPrototype = Object.getPrototypeOf(prototypeProbe) as {
      dispose(): void;
      setSize(width: number, height: number): void;
    };
    prototypeProbe.dispose();
    const originalPassDispose = passPrototype.dispose;
    const setSize = vi.spyOn(passPrototype, "setSize").mockImplementation(() => {
      throw new Error("scene-pass setSize failed");
    });
    let passDisposeAttempts = 0;
    const passDispose = vi.spyOn(passPrototype, "dispose").mockImplementation(function (
      this: typeof passPrototype,
    ) {
      passDisposeAttempts += 1;
      if (passDisposeAttempts <= 2) {
        throw new Error(`construction cleanup attempt ${passDisposeAttempts} failed`);
      }
      originalPassDispose.call(this);
    });
    const renderPipelineDispose = vi.spyOn(RenderPipeline.prototype, "dispose");
    const pipeline = new ProductionLinearHdrPipeline();
    pipeline.attachBackend(topologyRenderer().raw, "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass: RenderPass = Object.freeze({
      name: "world",
      kind: "opaque-pbr",
      scene: new Scene(),
      camera: new PerspectiveCamera(),
    });
    try {
      const failure = await pipeline.precompile([pass]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      const evidence = JSON.stringify((failure as AggregateError).errors);
      expect(evidence).toContain("scene-pass setSize failed");
      expect(evidence).toContain("construction cleanup attempt 1 failed");
      expect(setSize).toHaveBeenCalledOnce();
      expect(passDispose).toHaveBeenCalledOnce();
      expect(renderPipelineDispose).toHaveBeenCalledOnce();
      expect(pipeline.snapshot()).toMatchObject({
        state: "failed",
        graphCount: 0,
        cleanupPendingGraphs: 1,
        disposedGraphs: 0,
      });

      const failedAttempt = pipeline.dispose();
      const concurrentFailedAttempt = pipeline.dispose();
      expect(concurrentFailedAttempt).toBe(failedAttempt);
      await expect(failedAttempt).rejects.toThrow(/pipeline disposal failed/);
      expect(passDispose).toHaveBeenCalledTimes(2);
      expect(renderPipelineDispose).toHaveBeenCalledOnce();
      expect(pipeline.snapshot()).toMatchObject({
        state: "failed",
        graphCount: 0,
        cleanupPendingGraphs: 1,
        disposedGraphs: 0,
      });

      const successfulRetry = pipeline.dispose();
      const concurrentSuccessfulRetry = pipeline.dispose();
      expect(successfulRetry).not.toBe(failedAttempt);
      expect(concurrentSuccessfulRetry).toBe(successfulRetry);
      await expect(successfulRetry).resolves.toBeUndefined();
      expect(passDispose).toHaveBeenCalledTimes(3);
      expect(renderPipelineDispose).toHaveBeenCalledOnce();
      expect(pipeline.snapshot()).toMatchObject({
        state: "disposed",
        graphCount: 0,
        cleanupPendingGraphs: 0,
        disposedGraphs: 0,
      });
      expect(pipeline.dispose()).toBe(successfulRetry);
      await expect(pipeline.dispose()).resolves.toBeUndefined();
      expect(passDispose).toHaveBeenCalledTimes(3);
    } finally {
      setSize.mockRestore();
      passDispose.mockRestore();
      renderPipelineDispose.mockRestore();
    }
  });

  it("rejects hostile renderer construction fields before allocating a pipeline or target", async () => {
    const prototypeProbe = tslPass(new Scene(), new PerspectiveCamera());
    const passPrototype = Object.getPrototypeOf(prototypeProbe) as {
      dispose(): void;
      setSize(width: number, height: number): void;
    };
    prototypeProbe.dispose();
    const setSize = vi.spyOn(passPrototype, "setSize");
    const passDispose = vi.spyOn(passPrototype, "dispose");
    const renderPipelineDispose = vi.spyOn(RenderPipeline.prototype, "dispose");
    const probe = topologyRenderer();
    const toneMappingGetter = vi.fn(() => ACESFilmicToneMapping);
    Object.defineProperty(probe.raw, "toneMapping", {
      configurable: true,
      enumerable: true,
      get: toneMappingGetter,
    });
    const pipeline = new ProductionLinearHdrPipeline();
    pipeline.attachBackend(probe.raw, "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    try {
      const failure = await pipeline.precompile([Object.freeze({
        name: "world",
        kind: "opaque-pbr",
        scene: new Scene(),
        camera: new PerspectiveCamera(),
      })]).catch((error: unknown) => error);
      expect(JSON.stringify((failure as AggregateError).errors)).toContain(
        "renderer toneMapping must be an own data property",
      );
      expect(toneMappingGetter).not.toHaveBeenCalled();
      expect(setSize).not.toHaveBeenCalled();
      expect(passDispose).not.toHaveBeenCalled();
      expect(renderPipelineDispose).not.toHaveBeenCalled();
      expect(pipeline.snapshot()).toMatchObject({
        state: "failed",
        cleanupPendingGraphs: 0,
        disposedGraphs: 0,
      });
      await expect(pipeline.dispose()).resolves.toBeUndefined();
      expect(pipeline.snapshot().state).toBe("disposed");
    } finally {
      setSize.mockRestore();
      passDispose.mockRestore();
      renderPipelineDispose.mockRestore();
    }
  });

  it("rejects a late RenderPipeline _toneMapping accessor before constructor allocation", async () => {
    const prototypeProbe = tslPass(new Scene(), new PerspectiveCamera());
    const passPrototype = Object.getPrototypeOf(prototypeProbe) as {
      dispose(): void;
      setSize(width: number, height: number): void;
    };
    prototypeProbe.dispose();
    const setSize = vi.spyOn(passPrototype, "setSize");
    const passDispose = vi.spyOn(passPrototype, "dispose");
    const rendererSetter = vi.fn();
    const toneMappingGetter = vi.fn(() => ACESFilmicToneMapping);
    const toneMappingSetter = vi.fn(() => {
      throw new Error("late RenderPipeline _toneMapping setter ran");
    });
    const rendererDescriptor = Object.getOwnPropertyDescriptor(RenderPipeline.prototype, "renderer");
    const toneMappingDescriptor = Object.getOwnPropertyDescriptor(
      RenderPipeline.prototype,
      "_toneMapping",
    );
    Object.defineProperty(RenderPipeline.prototype, "renderer", {
      configurable: true,
      set: rendererSetter,
    });
    Object.defineProperty(RenderPipeline.prototype, "_toneMapping", {
      configurable: true,
      get: toneMappingGetter,
      set: toneMappingSetter,
    });
    const pipeline = new ProductionLinearHdrPipeline();
    pipeline.attachBackend(topologyRenderer().raw, "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    try {
      const failure = await pipeline.precompile([Object.freeze({
        name: "world",
        kind: "opaque-pbr",
        scene: new Scene(),
        camera: new PerspectiveCamera(),
      })]).catch((error: unknown) => error);
      expect(JSON.stringify((failure as AggregateError).errors)).toContain(
        "RenderPipeline prototype field _toneMapping changed before construction",
      );
      expect(rendererSetter).not.toHaveBeenCalled();
      expect(toneMappingGetter).not.toHaveBeenCalled();
      expect(toneMappingSetter).not.toHaveBeenCalled();
      expect(setSize).not.toHaveBeenCalled();
      expect(passDispose).not.toHaveBeenCalled();
      expect(pipeline.snapshot()).toMatchObject({
        state: "failed",
        cleanupPendingGraphs: 0,
        disposedGraphs: 0,
      });
      await expect(pipeline.dispose()).resolves.toBeUndefined();
    } finally {
      if (rendererDescriptor) {
        Object.defineProperty(RenderPipeline.prototype, "renderer", rendererDescriptor);
      } else {
        delete (RenderPipeline.prototype as { renderer?: unknown }).renderer;
      }
      if (toneMappingDescriptor) {
        Object.defineProperty(RenderPipeline.prototype, "_toneMapping", toneMappingDescriptor);
      } else {
        delete (RenderPipeline.prototype as { _toneMapping?: unknown })._toneMapping;
      }
      setSize.mockRestore();
      passDispose.mockRestore();
    }
  });

  it("rejects a RenderPipeline _toneMapping accessor installed before module import", async () => {
    vi.resetModules();
    const freshThree = await import("three/webgpu");
    const freshTsl = await import("three/tsl");
    const pipelinePrototype = freshThree.RenderPipeline.prototype;
    const toneMappingDescriptor = Object.getOwnPropertyDescriptor(
      pipelinePrototype,
      "_toneMapping",
    );
    const toneMappingGetter = vi.fn(() => ACESFilmicToneMapping);
    const toneMappingSetter = vi.fn(() => {
      throw new Error("pre-import late _toneMapping setter ran");
    });
    Object.defineProperty(pipelinePrototype, "_toneMapping", {
      configurable: true,
      get: toneMappingGetter,
      set: toneMappingSetter,
    });
    const passProbe = freshTsl.pass(
      new freshThree.Scene(),
      new freshThree.PerspectiveCamera(),
    );
    const passPrototype = Object.getPrototypeOf(passProbe) as {
      dispose(): void;
      setSize(width: number, height: number): void;
    };
    passProbe.dispose();
    const setSize = vi.spyOn(passPrototype, "setSize");
    try {
      const freshPipeline = await import("../../src/gfx/v2/pipeline/linear-hdr-pipeline");
      expect(freshPipeline.ProductionLinearHdrPipeline).not.toBe(ProductionLinearHdrPipeline);
      const pipeline = new freshPipeline.ProductionLinearHdrPipeline();
      pipeline.attachBackend(topologyRenderer().raw, "webgpu", viewport);
      await pipeline.initialize({} as FeatureInitContext);
      const failure = await pipeline.precompile([Object.freeze({
        name: "world",
        kind: "opaque-pbr",
        scene: new freshThree.Scene(),
        camera: new freshThree.PerspectiveCamera(),
      })]).catch((error: unknown) => error);

      expect(JSON.stringify((failure as AggregateError).errors)).toContain(
        "RenderPipeline prototype field _toneMapping changed before construction",
      );
      expect(toneMappingGetter).not.toHaveBeenCalled();
      expect(toneMappingSetter).not.toHaveBeenCalled();
      expect(setSize).not.toHaveBeenCalled();
      expect(pipeline.snapshot()).toMatchObject({
        state: "failed",
        cleanupPendingGraphs: 0,
        disposedGraphs: 0,
      });
      await expect(pipeline.dispose()).resolves.toBeUndefined();
    } finally {
      if (toneMappingDescriptor) {
        Object.defineProperty(pipelinePrototype, "_toneMapping", toneMappingDescriptor);
      } else {
        delete (pipelinePrototype as { _toneMapping?: unknown })._toneMapping;
      }
      setSize.mockRestore();
      vi.resetModules();
    }
  });

  it("latches precompile, submit, and resize admission while draining an async frame", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    pipeline.quality(quality("high"));
    const pass = runtimePass();
    await pipeline.precompile([pass]);
    const active = harness.graphs.find((graph) => graph.profile.id === "webgpu-high-temporal")!;
    const gate = deferredVoid();
    active.render.mockImplementation(async () => gate.promise);

    const submitting = pipeline.submit([pass]);
    const disposal = pipeline.dispose();
    await expect(pipeline.precompile([pass])).rejects.toThrow(/disposal was requested/);
    await expect(pipeline.submit([pass])).rejects.toThrow(/disposal was requested/);
    await expect(pipeline.resize(viewport)).rejects.toThrow(/disposal was requested/);
    expect(active.dispose).not.toHaveBeenCalled();
    gate.resolve();
    await submitting;
    await disposal;
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot().state).toBe("disposed");
  });

  it("retries only pending Three graph resources after an individual disposal failure", async () => {
    const prototypeProbe = tslPass(new Scene(), new PerspectiveCamera());
    const passPrototype = Object.getPrototypeOf(prototypeProbe) as { dispose(): void };
    prototypeProbe.dispose();
    const constructorDispose = vi.spyOn(passPrototype, "dispose");
    const rendererProbe = topologyRenderer();
    try {
      expect(() => createThreeLinearHdrGraph(Object.freeze({
        renderer: rendererProbe.raw,
        profile: selectLinearHdrPipelineProfile("WebGPU", quality("high")),
        materialWarmupPasses: Object.freeze([]),
        passes: Object.freeze([
          {
            name: "valid",
            kind: "opaque-pbr",
            scene: new Scene(),
            camera: new PerspectiveCamera(),
          },
          { name: "invalid", kind: "opaque-pbr", scene: {}, camera: {} },
        ]),
        passSignature: "partial-construction",
        viewport,
      }))).toThrow(/graph construction failed/);
      expect(constructorDispose).not.toHaveBeenCalled();
    } finally {
      constructorDispose.mockRestore();
    }

    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: rendererProbe.raw,
      profile: selectLinearHdrPipelineProfile("WebGPU", quality("high")),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([
        {
          name: "first",
          kind: "opaque-pbr",
          scene: new Scene(),
          camera: new PerspectiveCamera(),
        },
        {
          name: "second",
          kind: "opaque-pbr",
          scene: new Scene(),
          camera: new PerspectiveCamera(),
        },
      ]),
      passSignature: "partial-disposal",
      viewport,
    }));
    await graph.precompile();
    const firstTarget = rendererProbe.compiled[0]!.target as object;
    const secondTarget = rendererProbe.compiled[1]!.target as object;
    const firstTargetDispose = rendererProbe.targetDisposals.get(firstTarget)!;
    const secondTargetDispose = rendererProbe.targetDisposals.get(secondTarget)!;
    const originalPassDispose = passPrototype.dispose;
    let passDisposals = 0;
    const passDispose = vi.spyOn(passPrototype, "dispose").mockImplementation(function (
      this: typeof passPrototype,
    ) {
      passDisposals += 1;
      if (passDisposals === 1) throw new Error("first pass dispose failed before cleanup");
      originalPassDispose.call(this);
    });
    const pipelineDispose = vi.spyOn(RenderPipeline.prototype, "dispose");
    try {
      expect(() => graph.dispose()).toThrow(/graph disposal failed/);
      expect(passDispose).toHaveBeenCalledTimes(2);
      expect(pipelineDispose).toHaveBeenCalledOnce();
      expect(firstTargetDispose).not.toHaveBeenCalled();
      expect(secondTargetDispose).toHaveBeenCalledOnce();
      expect(() => graph.dispose()).not.toThrow();
      expect(passDispose).toHaveBeenCalledTimes(3);
      expect(pipelineDispose).toHaveBeenCalledOnce();
      expect(firstTargetDispose).toHaveBeenCalledOnce();
      expect(secondTargetDispose).toHaveBeenCalledOnce();
      expect(() => graph.dispose()).not.toThrow();
      expect(passDispose).toHaveBeenCalledTimes(3);
      expect(pipelineDispose).toHaveBeenCalledOnce();
    } finally {
      passDispose.mockRestore();
      pipelineDispose.mockRestore();
    }
  });

  it("retains a failed Three RenderPipeline cleanup without redisposing scene targets", async () => {
    const probe = topologyRenderer();
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGPU", quality("high")),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{
        name: "world",
        kind: "opaque-pbr",
        scene: new Scene(),
        camera: new PerspectiveCamera(),
      }]),
      passSignature: "pipeline-disposal-retry",
      viewport,
    }));
    await graph.precompile();
    const sceneTarget = probe.compiled[0]!.target as object;
    const targetDispose = probe.targetDisposals.get(sceneTarget)!;
    const prototypeProbe = tslPass(new Scene(), new PerspectiveCamera());
    const passPrototype = Object.getPrototypeOf(prototypeProbe) as { dispose(): void };
    prototypeProbe.dispose();
    const passDispose = vi.spyOn(passPrototype, "dispose");
    const originalPipelineDispose = RenderPipeline.prototype.dispose;
    let pipelineAttempts = 0;
    const pipelineDispose = vi.spyOn(RenderPipeline.prototype, "dispose").mockImplementation(function (
      this: RenderPipeline,
    ) {
      pipelineAttempts += 1;
      if (pipelineAttempts === 1) throw new Error("pipeline cleanup failed before release");
      originalPipelineDispose.call(this);
    });
    try {
      expect(() => graph.dispose()).toThrow(/graph disposal failed/);
      expect(passDispose).toHaveBeenCalledOnce();
      expect(targetDispose).toHaveBeenCalledOnce();
      expect(pipelineDispose).toHaveBeenCalledOnce();
      expect(() => graph.dispose()).not.toThrow();
      expect(passDispose).toHaveBeenCalledOnce();
      expect(targetDispose).toHaveBeenCalledOnce();
      expect(pipelineDispose).toHaveBeenCalledTimes(2);
      expect(() => graph.dispose()).not.toThrow();
      expect(passDispose).toHaveBeenCalledOnce();
      expect(pipelineDispose).toHaveBeenCalledTimes(2);
    } finally {
      passDispose.mockRestore();
      pipelineDispose.mockRestore();
    }
  });

  it("selects only closed profiles and never lets arbitrary feature keys become variants", () => {
    const getter = vi.fn(() => "off");
    const features = {} as Record<string, boolean | number | string>;
    Object.defineProperty(features, "temporal", { enumerable: true, get: getter });
    const hostile = Object.freeze({ ...quality("high"), features });
    expect(selectLinearHdrPipelineProfile("WebGPU", hostile).id).toBe("webgpu-high-temporal");
    expect(getter).not.toHaveBeenCalled();
    expect(selectLinearHdrPipelineProfile("WebGPU", quality("high", "off")).id)
      .toBe("webgpu-high-static");
    expect(selectLinearHdrPipelineProfile("WebGL2", quality("high", true)).id)
      .toBe("webgl2-high-static");
  });

  it("bounds pass-signature fields before allocating an unbounded canonical key", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgl2", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const failure = await pipeline.precompile([{
      ...runtimePass(),
      name: "x".repeat(257),
    }]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(JSON.stringify((failure as AggregateError).errors)).toContain("1 through 256");
    await pipeline.dispose();
  });

  it("marks pipeline failure-list truncation with frozen owned evidence", () => {
    const failure = ownedAggregateError(
      Array.from({ length: 19 }, (_, index) => ({ message: `failure ${index}` })),
      "bounded pipeline failures",
    );
    expect(failure.errors).toHaveLength(16);
    expect(failure.errors.at(-1)).toMatchObject({
      kind: "truncated",
      value: "4 additional failures omitted",
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.errors)).toBe(true);
  });

  it("copies and freezes nested AggregateError members", () => {
    const nested = new Error("nested pipeline original");
    const external = new AggregateError([nested], "external pipeline aggregate");
    const failure = ownedAggregateError([external], "captured pipeline aggregate");
    nested.message = "nested pipeline mutated";
    external.errors[0] = new Error("pipeline replacement");

    const evidence = JSON.stringify(failure.errors);
    expect(evidence).toContain("nested pipeline original");
    expect(evidence).not.toContain("nested pipeline mutated");
    expect(evidence).not.toContain("pipeline replacement");
    const snapshot = failure.errors[0] as { errors?: readonly unknown[] };
    expect(Object.isFrozen(snapshot.errors)).toBe(true);
  });

  it("hard-bounds and truthfully snapshots every pipeline failure evidence path", () => {
    const walk = (failure: AggregateError) => {
      const fields = [failure.message];
      const nodes: object[] = [failure, failure.errors];
      const pending: unknown[] = [...failure.errors];
      while (pending.length > 0) {
        const current = pending.pop();
        if (typeof current !== "object" || current === null) continue;
        nodes.push(current);
        for (const key of ["value", "name", "message", "code"] as const) {
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
            fields.push(descriptor.value);
          }
        }
        const cause = Object.getOwnPropertyDescriptor(current, "cause");
        if (cause && "value" in cause) pending.push(cause.value);
        const errors = Object.getOwnPropertyDescriptor(current, "errors");
        if (errors && "value" in errors && Array.isArray(errors.value)) {
          nodes.push(errors.value);
          pending.push(...errors.value);
        }
      }
      return { fields, nodes } as const;
    };

    for (const length of [255, 256, 257]) {
      const messageFailure = ownedAggregateError([], "m".repeat(length));
      const primitiveFailure = ownedAggregateError(["p".repeat(length)], "");
      expect(messageFailure.message.length).toBeLessThanOrEqual(256);
      expect((primitiveFailure.errors[0] as { value?: string }).value?.length)
        .toBeLessThanOrEqual(256);
      if (length <= 256) {
        expect(messageFailure.message).toBe("m".repeat(length));
      } else {
        expect(messageFailure.message).toContain("[truncated ");
        expect(primitiveFailure.errors[0]).toMatchObject({ textTruncated: true });
      }
    }

    for (const total of [4_095, 4_096, 4_097]) {
      const inputs = Array.from({ length: 16 }, (_, index) => (
        "x".repeat(index < 15 ? 256 : total - (15 * 256))
      ));
      const failure = ownedAggregateError(inputs, "");
      const retainedUnits = walk(failure).fields.reduce((sum, value) => sum + value.length, 0);
      expect(retainedUnits).toBe(Math.min(total, 4_096));
      if (total > 4_096) {
        expect(failure.errors.at(-1)).toMatchObject({ textTruncated: true });
      }
    }

    const chargedRoots = Array.from({ length: 5 }, () => ({
      name: "n".repeat(256),
      message: "m".repeat(256),
      code: "c".repeat(256),
    }));
    const fixedTextPrimitives: readonly unknown[] = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    const mixedBudgetFailure = ownedAggregateError(
      [...chargedRoots, ...fixedTextPrimitives],
      "a".repeat(256),
    );
    expect(walk(mixedBudgetFailure).fields.reduce((sum, value) => sum + value.length, 0))
      .toBe(4_096);
    expect(mixedBudgetFailure.errors.slice(5)).toHaveLength(11);
    for (const snapshot of mixedBudgetFailure.errors.slice(5)) {
      expect(snapshot).toMatchObject({ textTruncated: true });
      expect(snapshot).not.toHaveProperty("value");
    }

    const huge = "P".repeat(2_000_000);
    const hugeBigInt = BigInt(`1${"0".repeat(2_000)}`);
    const composite = {
      name: huge,
      message: huge,
      code: huge,
      cause: huge,
      errors: [huge, Symbol(huge), hugeBigInt, huge, huge],
    };
    const nestedAggregate = new AggregateError(
      [huge, Symbol(huge), hugeBigInt, huge, huge],
      huge,
      { cause: huge },
    );
    const hugeFailure = ownedAggregateError(
      [nestedAggregate, composite, huge, Symbol(huge), hugeBigInt],
      huge,
    );
    const hugeWalk = walk(hugeFailure);
    expect(Math.max(...hugeWalk.fields.map((value) => value.length))).toBeLessThanOrEqual(256);
    expect(hugeWalk.fields.reduce((sum, value) => sum + value.length, 0))
      .toBeLessThanOrEqual(4_096);
    const hugeSerialized = JSON.stringify({
      message: hugeFailure.message,
      errors: hugeFailure.errors,
    });
    expect(hugeSerialized.length).toBeLessThan(50_000);
    expect(hugeSerialized).toContain("[truncated ");
    expect(hugeSerialized).toContain("bigint omitted beyond 128 decimal digits");
    expect(hugeSerialized).not.toContain("P".repeat(257));
    for (const node of hugeWalk.nodes) expect(Object.isFrozen(node)).toBe(true);

    const bigintFailure = ownedAggregateError([
      BigInt("9".repeat(128)),
      BigInt(`1${"0".repeat(128)}`),
      BigInt(`-1${"0".repeat(128)}`),
    ], "");
    expect(bigintFailure.errors[0]).toMatchObject({ value: "9".repeat(128) });
    expect(bigintFailure.errors[1]).toMatchObject({
      value: "[bigint omitted beyond 128 decimal digits]",
    });
    expect(bigintFailure.errors[2]).toMatchObject({
      value: "-[bigint omitted beyond 128 decimal digits]",
    });

    const sixteen = ownedAggregateError(Array.from({ length: 16 }, () => "root"), "");
    const seventeen = ownedAggregateError(Array.from({ length: 17 }, () => "root"), "");
    expect(sixteen.errors).toHaveLength(16);
    expect(seventeen.errors).toHaveLength(16);
    expect(seventeen.errors.at(-1)).toMatchObject({ value: "2 additional failures omitted" });

    const widthFour = ownedAggregateError([
      new AggregateError(Array.from({ length: 4 }, () => new Error("nested")), "four"),
    ], "");
    const widthFive = ownedAggregateError([
      new AggregateError(Array.from({ length: 5 }, () => new Error("nested")), "five"),
    ], "");
    expect((widthFour.errors[0] as { errors: readonly unknown[] }).errors).toHaveLength(4);
    expect((widthFive.errors[0] as { errors: readonly unknown[] }).errors.at(-1)).toMatchObject({
      value: "1 additional nested failures omitted",
    });

    const depthThree = { message: "depth three" } as { message: string; cause?: unknown };
    const depthTwo = { message: "depth two", cause: depthThree };
    const depthOne = { message: "depth one", cause: depthTwo };
    const depthRoot = { message: "depth root", cause: depthOne };
    const depthSnapshot = ownedAggregateError([depthRoot], "").errors[0] as {
      cause: { cause: { cause: { kind: string } } };
    };
    expect(depthSnapshot.cause.cause.cause.kind).toBe("truncated");

    const shared = { message: "shared pipeline occurrence" };
    const slots = new Array<unknown>(4);
    slots[0] = shared;
    const accessor = vi.fn(() => shared);
    Object.defineProperty(slots, "2", { configurable: true, get: accessor });
    slots[3] = shared;
    const external = new AggregateError([], "slot source");
    Object.defineProperty(external, "errors", { configurable: true, value: slots });
    const occurrenceFailure = ownedAggregateError([shared, shared, external], "");
    const nestedSlots = (occurrenceFailure.errors[2] as { errors: readonly unknown[] }).errors;
    expect(occurrenceFailure.errors.slice(0, 2)).toEqual([
      expect.objectContaining({ message: "shared pipeline occurrence" }),
      expect.objectContaining({ message: "shared pipeline occurrence" }),
    ]);
    expect(nestedSlots).toEqual([
      expect.objectContaining({ message: "shared pipeline occurrence" }),
      expect.objectContaining({ type: "missing-failure-slot" }),
      expect.objectContaining({ type: "accessor-failure-slot" }),
      expect.objectContaining({ message: "shared pipeline occurrence" }),
    ]);
    expect(accessor).not.toHaveBeenCalled();
    const self: { message: string; cause?: unknown } = { message: "self" };
    self.cause = self;
    expect((ownedAggregateError([self], "").errors[0] as { cause: unknown }).cause)
      .toMatchObject({ kind: "cycle" });

    const fanout = (depth: number): { message: string; cause?: unknown; errors?: unknown[] } => {
      const node: { message: string; cause?: unknown; errors?: unknown[] } = {
        message: `fanout ${depth}`,
      };
      if (depth > 0) {
        node.cause = fanout(depth - 1);
        node.errors = Array.from({ length: 4 }, () => fanout(depth - 1));
      }
      return node;
    };
    const fanoutFailure = ownedAggregateError(
      Array.from({ length: 16 }, () => fanout(4)),
      "fanout",
    );
    const fanoutWalk = walk(fanoutFailure);
    expect(fanoutWalk.nodes.filter((node) => (
      (node as { type?: string }).type === "evidence-budget"
    ))).toHaveLength(1);
    expect(fanoutWalk.nodes.filter((node) => "kind" in node)).toHaveLength(256);
    expect(fanoutWalk.fields.reduce((sum, value) => sum + value.length, 0))
      .toBeLessThanOrEqual(4_096);
    expect(JSON.stringify(fanoutFailure.errors).length).toBeLessThan(50_000);

    shared.message = "mutated after capture";
    slots[0] = { message: "replacement" };
    expect(JSON.stringify(occurrenceFailure.errors)).toContain("shared pipeline occurrence");
    expect(JSON.stringify(occurrenceFailure.errors)).not.toContain("mutated after capture");
    expect(JSON.stringify(occurrenceFailure.errors)).not.toContain("replacement");
  });
});
