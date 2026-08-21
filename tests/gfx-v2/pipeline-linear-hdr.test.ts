import {
  ACESFilmicToneMapping,
  BoxGeometry,
  ColorManagement,
  Group,
  HalfFloatType,
  Mesh,
  MeshStandardNodeMaterial,
  NoToneMapping,
  NodeUpdateType,
  type Object3D,
  PassNode,
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
  type RenderCompileStepDescriptor,
  type RenderCompileStepPhase,
  type RenderCompileStepRunner,
  type RenderHistoryInvalidation,
  type RenderPass,
  type RenderPrecompileReceipt,
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
  precompile: ReturnType<typeof vi.fn<(
    runner: RenderCompileStepRunner,
  ) => Promise<Readonly<RenderPrecompileReceipt>>>>;
  setHistoryWeight: ReturnType<typeof vi.fn<(weight: number) => void | Promise<void>>>;
  resize: ReturnType<typeof vi.fn<(next: typeof viewport) => Promise<void>>>;
  render: ReturnType<typeof vi.fn<() => Promise<void>>>;
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

const immediateCompileRunner: RenderCompileStepRunner = Object.freeze({
  async run(
    descriptor: Readonly<RenderCompileStepDescriptor>,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    void descriptor;
    await operation();
  },
});

function precompile(
  pipeline: ProductionLinearHdrPipeline,
  passes: readonly Readonly<RenderPass>[],
  runner: RenderCompileStepRunner = immediateCompileRunner,
): Promise<Readonly<RenderPrecompileReceipt>> {
  return pipeline.precompile(passes, runner);
}

function phaseCounts(
  plan: readonly Readonly<RenderCompileStepDescriptor>[],
): Readonly<Record<RenderCompileStepPhase, number>> {
  const counts: Record<RenderCompileStepPhase, number> = {
    "runtime-object": 0,
    "material-isolated": 0,
    "material-runtime-topology": 0,
    "output-first-use": 0,
  };
  for (let index = 0; index < plan.length; index += 1) {
    counts[plan[index]!.phase] += 1;
  }
  return Object.freeze(counts);
}

function harnessCompilePlan(
  context: Readonly<LinearHdrGraphFactoryContext>,
): readonly Readonly<RenderCompileStepDescriptor>[] {
  const profileId = context.profile.id;
  const plan: Readonly<RenderCompileStepDescriptor>[] = [];
  for (let passIndex = 0; passIndex < context.passes.length; passIndex += 1) {
    plan.push(Object.freeze({
      id: `linear-hdr:${profileId}:runtime:p${passIndex}:o0`,
      phase: "runtime-object",
      profileId,
    }));
  }
  for (let materialIndex = 0; materialIndex < context.materialWarmupPasses.length; materialIndex += 1) {
    plan.push(Object.freeze({
      id: `linear-hdr:${profileId}:material-isolated:m${materialIndex}`,
      phase: "material-isolated",
      profileId,
    }));
  }
  for (let materialIndex = 0; materialIndex < context.materialWarmupPasses.length; materialIndex += 1) {
    for (let topologyIndex = 0; topologyIndex < context.passes.length; topologyIndex += 1) {
      plan.push(Object.freeze({
        id: `linear-hdr:${profileId}:material-runtime:m${materialIndex}:t${topologyIndex}`,
        phase: "material-runtime-topology",
        profileId,
      }));
    }
  }
  plan.push(Object.freeze({
    id: `linear-hdr:${profileId}:output:update`,
    phase: "output-first-use",
    profileId,
  }));
  plan.push(Object.freeze({
    id: `linear-hdr:${profileId}:output:compile`,
    phase: "output-first-use",
    profileId,
  }));
  plan.push(Object.freeze({
    id: `linear-hdr:${profileId}:output:draw`,
    phase: "output-first-use",
    profileId,
  }));
  return Object.freeze(plan);
}

async function completeHarnessCompilePlan(
  context: Readonly<LinearHdrGraphFactoryContext>,
  runner: RenderCompileStepRunner,
  operation: (
    descriptor: Readonly<RenderCompileStepDescriptor>,
    index: number,
  ) => void | Promise<void> = () => undefined,
): Promise<Readonly<RenderPrecompileReceipt>> {
  const plan = harnessCompilePlan(context);
  for (let index = 0; index < plan.length; index += 1) {
    const descriptor = plan[index]!;
    await runner.run(descriptor, () => operation(descriptor, index));
  }
  return Object.freeze({
    plannedSteps: plan.length,
    completedSteps: plan.length,
    phaseCounts: phaseCounts(plan),
  });
}

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
      precompile: vi.fn(async (runner: RenderCompileStepRunner) => {
        if (options.precompileGate?.index === index) await options.precompileGate.promise;
        if (options.failPrecompileAt === index) throw new Error(`precompile ${index} failed`);
        return completeHarnessCompilePlan(context, runner);
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
    targetScene: unknown;
    target: unknown;
    mrt: unknown;
    meshCount: number;
    fragmentNode: unknown;
  }>> = [];
  const rendered: Array<Readonly<{
    scene: unknown;
    camera: unknown;
    target: unknown;
    mrt: unknown;
    autoClear: unknown;
    transparent: unknown;
    opaque: unknown;
    toneMapping: unknown;
    outputColorSpace: unknown;
    xrEnabled: unknown;
    visibleMeshCount: number;
  }>> = [];
  let compileCalls = 0;
  const raw = {
    toneMapping: ACESFilmicToneMapping,
    outputColorSpace: SRGBColorSpace,
    xr: { enabled: false },
    autoClear: true,
    transparent: true,
    opaque: true,
    contextNode: null as unknown,
    info: { memory: { programs } },
    getOutputRenderTarget: vi.fn(() => null),
    getDrawingBufferSize: vi.fn((target: { set(width: number, height: number): unknown }) => (
      target.set(viewport.width, viewport.height)
    )),
    getRenderTarget: vi.fn(() => renderTarget),
    getMRT: vi.fn(() => mrt),
    setRenderTarget: vi.fn((next: unknown) => { renderTarget = next; }),
    setMRT: vi.fn((next: unknown) => { mrt = next; }),
    compileAsync: vi.fn(async (scene: unknown, _camera: unknown, targetScene: unknown) => {
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
      const fragmentNode = (scene as { material?: { fragmentNode?: unknown } }).material?.fragmentNode;
      compiled.push(Object.freeze({
        scene,
        targetScene,
        target: renderTarget,
        mrt,
        meshCount,
        fragmentNode,
      }));
      raw.info.memory.programs += 1;
      if (compileCalls === failCompileAt) throw new Error("runtime topology compile failed");
    }),
    render: vi.fn((scene: unknown, camera: unknown) => {
      let visibleMeshCount = 0;
      const traverse = (scene as { traverse?: (visit: (object: unknown) => void) => void })?.traverse;
      traverse?.call(scene, (object: unknown) => {
        const candidate = object as {
          isMesh?: boolean;
          visible?: boolean;
          material?: { visible?: boolean };
        };
        if (
          candidate.isMesh === true
          && candidate.visible !== false
          && candidate.material?.visible !== false
        ) visibleMeshCount += 1;
      });
      rendered.push(Object.freeze({
        scene,
        camera,
        target: renderTarget,
        mrt,
        autoClear: raw.autoClear,
        transparent: raw.transparent,
        opaque: raw.opaque,
        toneMapping: raw.toneMapping,
        outputColorSpace: raw.outputColorSpace,
        xrEnabled: raw.xr.enabled,
        visibleMeshCount,
      }));
    }),
  };
  return { raw, compiled, rendered, targetDisposals } as const;
}

function findNodeType(root: unknown, expected: string): object | undefined {
  const queue: unknown[] = [root];
  const seen = new Set<object>();
  for (let inspected = 0; queue.length > 0 && inspected < 512; inspected += 1) {
    const value = queue.shift();
    if ((typeof value !== "object" || value === null) && typeof value !== "function") continue;
    const object = value as object;
    if (seen.has(object)) continue;
    seen.add(object);
    if ((object as { constructor?: { name?: string } }).constructor?.name === expected) return object;
    for (const key of Reflect.ownKeys(object).slice(0, 64)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && "value" in descriptor) queue.push(descriptor.value);
    }
  }
  return undefined;
}

function findNodeTypes(root: unknown, expected: string): readonly object[] {
  const queue: unknown[] = [root];
  const seen = new Set<object>();
  const matches: object[] = [];
  for (let inspected = 0; queue.length > 0 && inspected < 4096; inspected += 1) {
    const value = queue.shift();
    if ((typeof value !== "object" || value === null) && typeof value !== "function") continue;
    const object = value as object;
    if (seen.has(object)) continue;
    seen.add(object);
    if ((object as { constructor?: { name?: string } }).constructor?.name === expected) {
      matches.push(object);
    }
    for (const key of Reflect.ownKeys(object).slice(0, 64)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && "value" in descriptor) queue.push(descriptor.value);
    }
  }
  return matches;
}

function containsNodeType(root: unknown, expected: string): boolean {
  return findNodeType(root, expected) !== undefined;
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
    const renderer = topologyRenderer().raw;
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer,
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

    await expect(graph.precompile(immediateCompileRunner)).resolves.toEqual({
      plannedSteps: 6,
      completedSteps: 6,
      phaseCounts: {
        "runtime-object": 0,
        "material-isolated": 1,
        "material-runtime-topology": 1,
        "output-first-use": 4,
      },
    });
    const materialCompile = probe.compiled.find((entry) => entry.targetScene === materialScene)!;
    const runtimeCompile = probe.compiled.find((entry) => entry.targetScene === runtimeScene)!;
    const outputCompile = probe.compiled.find((entry) => entry.targetScene === undefined)!;
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
    expect([materialCompile.meshCount, runtimeCompile.meshCount, outputCompile.meshCount])
      .toEqual([1, 1, 1]);
    expect(materialCompile.scene).toBe(materialScene.children[0]);
    expect(runtimeCompile.target).not.toBeNull();
    expect(runtimeCompile.mrt).not.toBeNull();
    expect(outputCompile).toMatchObject({ target: null, mrt: null });
    expect(outputCompile.fragmentNode).toBeDefined();
    expect(runtimeScene.children).toEqual([]);
    expect(probe.targetDisposals.get(target as unknown as object)).toHaveBeenCalledOnce();
    expect(probe.raw.render).toHaveBeenCalledTimes(2);

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

    await graph.precompile(immediateCompileRunner);
    const quad = probe.raw.render.mock.calls.at(-1)?.[0] as {
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
    const probe = topologyRenderer(0, 2);
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

    await expect(graph.precompile(immediateCompileRunner))
      .rejects.toThrow(/Runtime material topology warm-up failed/);
    expect(probe.compiled.map((entry) => entry.meshCount)).toEqual([1, 1]);
    expect(runtimeScene.children).toEqual([]);
    await graph.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("compiles one temporarily hidden drawable against its real scene and restores every gate", async () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    camera.layers.set(3);
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    material.visible = false;
    const mesh = new Mesh(geometry, material);
    mesh.visible = false;
    mesh.frustumCulled = true;
    mesh.layers.set(6);
    scene.add(mesh);
    const probe = topologyRenderer();
    const priorTarget = Object.freeze({ id: "prior-target" });
    const priorMrt = Object.freeze({ id: "prior-mrt" });
    probe.raw.setRenderTarget(priorTarget);
    probe.raw.setMRT(priorMrt);
    probe.raw.autoClear = false;
    probe.raw.transparent = false;
    probe.raw.opaque = false;
    probe.raw.xr.enabled = true;
    const attempted: Readonly<RenderCompileStepDescriptor>[] = [];
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGPU", quality("high")),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{ name: "world", kind: "opaque-pbr", scene, camera }]),
      passSignature: "atomic-one-object",
      viewport,
    }));

    const receipt = await graph.precompile(Object.freeze({
      async run(
        descriptor: Readonly<RenderCompileStepDescriptor>,
        operation: () => void | Promise<void>,
      ) {
        attempted.push(descriptor);
        await operation();
      },
    }));

    expect(receipt).toEqual({
      plannedSteps: 6,
      completedSteps: 6,
      phaseCounts: {
        "runtime-object": 2,
        "material-isolated": 0,
        "material-runtime-topology": 0,
        "output-first-use": 4,
      },
    });
    expect(attempted.map((descriptor) => descriptor.id)).toEqual([
      "linear-hdr:webgpu-high-temporal:runtime:p0:o0",
      "linear-hdr:webgpu-high-temporal:output:update",
      "linear-hdr:webgpu-high-temporal:output:compile",
      "linear-hdr:webgpu-high-temporal:runtime-draw:p0:o0",
      "linear-hdr:webgpu-high-temporal:output:pass-draw:p0",
      "linear-hdr:webgpu-high-temporal:output:draw",
    ]);
    expect(probe.raw.compileAsync).toHaveBeenCalledTimes(2);
    expect(probe.raw.compileAsync).toHaveBeenNthCalledWith(1, mesh, camera, scene);
    expect(probe.compiled[0]).toMatchObject({ scene: mesh, targetScene: scene, meshCount: 1 });
    expect(probe.compiled[0]!.target).not.toBe(priorTarget);
    expect(probe.compiled[0]!.mrt).not.toBe(priorMrt);
    const outputCompile = probe.compiled[1]!;
    const runtimeDraw = probe.rendered.find((entry) => entry.scene === scene)!;
    const outputDraw = probe.rendered.find((entry) => entry.scene === outputCompile.scene)!;
    expect(probe.raw.compileAsync).toHaveBeenNthCalledWith(
      2,
      outputCompile.scene,
      outputDraw.camera,
    );
    expect(outputCompile).toMatchObject({ targetScene: undefined, target: null, mrt: null, meshCount: 1 });
    expect(outputCompile.fragmentNode).toBeDefined();
    expect(runtimeDraw).toEqual(expect.objectContaining({
      scene,
      camera,
      target: probe.compiled[0]!.target,
      mrt: probe.compiled[0]!.mrt,
      autoClear: true,
      transparent: true,
      opaque: true,
      toneMapping: NoToneMapping,
      outputColorSpace: ColorManagement.workingColorSpace,
      xrEnabled: false,
      visibleMeshCount: 1,
    }));
    expect(outputDraw).toEqual(expect.objectContaining({
      scene: outputCompile.scene,
      target: null,
      mrt: null,
    }));
    expect(probe.raw.getRenderTarget()).toBe(priorTarget);
    expect(probe.raw.getMRT()).toBe(priorMrt);
    expect(mesh.visible).toBe(false);
    expect(mesh.frustumCulled).toBe(true);
    expect(mesh.layers.mask).toBe(1 << 6);
    expect(material.visible).toBe(false);
    expect(probe.raw.autoClear).toBe(false);
    expect(probe.raw.transparent).toBe(false);
    expect(probe.raw.opaque).toBe(false);
    expect(probe.raw.xr.enabled).toBe(true);

    await graph.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("draws a nested drawable as one atomic step without also drawing its drawable ancestor", async () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    camera.layers.set(3);
    const parentGeometry = new BoxGeometry(1, 1, 1);
    const childGeometry = new BoxGeometry(0.5, 0.5, 0.5);
    const sharedMaterial = new MeshStandardNodeMaterial();
    const parent = new Mesh(parentGeometry, sharedMaterial);
    parent.name = "nested-parent";
    parent.layers.set(5);
    const child = new Mesh(childGeometry, sharedMaterial);
    child.name = "nested-child";
    child.layers.set(6);
    parent.add(child);
    scene.add(parent);
    const originalParentVisible = Object.getOwnPropertyDescriptor(parent, "visible");
    const originalParentLayerMask = Object.getOwnPropertyDescriptor(parent.layers, "mask");
    const originalChildVisible = Object.getOwnPropertyDescriptor(child, "visible");
    const originalChildLayerMask = Object.getOwnPropertyDescriptor(child.layers, "mask");
    const originalMaterialVisible = Object.getOwnPropertyDescriptor(sharedMaterial, "visible");
    const probe = topologyRenderer();
    const baseRender = probe.raw.render.getMockImplementation();
    const atomicRuntimeDraws: string[][] = [];
    probe.raw.render.mockImplementation((renderScene: unknown, renderCamera: unknown) => {
      if (renderScene === scene && renderCamera === camera) {
        const visible: string[] = [];
        scene.traverseVisible((object) => {
          const candidate = object as Object3D & {
            readonly isMesh?: boolean;
            readonly material?: { readonly visible?: boolean };
          };
          if (
            candidate.isMesh === true
            && candidate.material?.visible !== false
            && candidate.layers.test(camera.layers)
          ) visible.push(candidate.name);
        });
        atomicRuntimeDraws.push(visible);
      }
      baseRender?.(renderScene, renderCamera);
    });
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGL2", quality("high", false)),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{ name: "world", kind: "opaque-pbr", scene, camera }]),
      passSignature: "nested-atomic-runtime-draw",
      viewport,
    }));

    const receipt = await graph.precompile(immediateCompileRunner);

    expect(receipt).toEqual({
      plannedSteps: 8,
      completedSteps: 8,
      phaseCounts: {
        "runtime-object": 4,
        "material-isolated": 0,
        "material-runtime-topology": 0,
        "output-first-use": 4,
      },
    });
    expect(atomicRuntimeDraws.slice(0, 2)).toEqual([
      ["nested-parent"],
      ["nested-child"],
    ]);
    expect(Object.getOwnPropertyDescriptor(parent, "visible")).toEqual(originalParentVisible);
    expect(Object.getOwnPropertyDescriptor(parent.layers, "mask")).toEqual(originalParentLayerMask);
    expect(Object.getOwnPropertyDescriptor(child, "visible")).toEqual(originalChildVisible);
    expect(Object.getOwnPropertyDescriptor(child.layers, "mask")).toEqual(originalChildLayerMask);
    expect(Object.getOwnPropertyDescriptor(sharedMaterial, "visible")).toEqual(originalMaterialVisible);

    await graph.dispose();
    parentGeometry.dispose();
    childGeometry.dispose();
    sharedMaterial.dispose();
  });

  it("uses renderer operations captured before runner yields without later method lookup", async () => {
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    scene.add(new Mesh(geometry, material));
    const probe = topologyRenderer();
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGL2", quality("high", false)),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{
        name: "world",
        kind: "opaque-pbr",
        scene,
        camera: new PerspectiveCamera(),
      }]),
      passSignature: "captured-renderer-operations",
      viewport,
    }));
    const lateLookup = vi.fn(() => {
      throw new Error("captured renderer methods must not be looked up again");
    });
    for (const key of [
      "getRenderTarget",
      "getMRT",
      "setRenderTarget",
      "setMRT",
      "getOutputRenderTarget",
      "getDrawingBufferSize",
      "compileAsync",
    ] as const) {
      Object.defineProperty(probe.raw, key, {
        configurable: true,
        get: lateLookup,
      });
    }

    await expect(graph.precompile(immediateCompileRunner)).resolves.toMatchObject({
      plannedSteps: 6,
      completedSteps: 6,
    });
    expect(lateLookup).not.toHaveBeenCalled();
    expect(probe.compiled).toHaveLength(2);
    expect(probe.compiled[1]).toMatchObject({ targetScene: undefined, target: null, mrt: null });
    await graph.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("captures renderer callbacks with import-time Object reflection intrinsics", async () => {
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    scene.add(new Mesh(geometry, material));
    const probe = topologyRenderer();
    const ownDescriptor = Object.getOwnPropertyDescriptor(Object, "getOwnPropertyDescriptor")!;
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(Object, "getPrototypeOf")!;
    const reflectionPoison = vi.fn(() => {
      throw new Error("live Object reflection methods must not run");
    });
    let graph: LinearHdrGraph | undefined;

    Reflect.defineProperty(Object, "getOwnPropertyDescriptor", {
      ...ownDescriptor,
      value: reflectionPoison,
    });
    Reflect.defineProperty(Object, "getPrototypeOf", {
      ...prototypeDescriptor,
      value: reflectionPoison,
    });
    try {
      graph = createThreeLinearHdrGraph(Object.freeze({
        renderer: probe.raw,
        profile: selectLinearHdrPipelineProfile("WebGL2", quality("high", false)),
        materialWarmupPasses: Object.freeze([]),
        passes: Object.freeze([{
          name: "world",
          kind: "opaque-pbr",
          scene,
          camera: new PerspectiveCamera(),
        }]),
        passSignature: "captured-object-reflection-intrinsics",
        viewport,
      }));
    } finally {
      Reflect.defineProperty(Object, "getOwnPropertyDescriptor", ownDescriptor);
      Reflect.defineProperty(Object, "getPrototypeOf", prototypeDescriptor);
    }

    expect(reflectionPoison).not.toHaveBeenCalled();
    await expect(graph!.precompile(immediateCompileRunner)).resolves.toMatchObject({
      plannedSteps: 6,
      completedSteps: 6,
    });
    await graph!.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("pins the audited RenderPipeline update and render methods before runner yields", async () => {
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    scene.add(new Mesh(geometry, material));
    const probe = topologyRenderer();
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGL2", quality("high", false)),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{
        name: "world",
        kind: "opaque-pbr",
        scene,
        camera: new PerspectiveCamera(),
      }]),
      passSignature: "captured-output-methods",
      viewport,
    }));
    const updateDescriptor = Object.getOwnPropertyDescriptor(RenderPipeline.prototype, "_update")!;
    const renderDescriptor = Object.getOwnPropertyDescriptor(RenderPipeline.prototype, "render")!;
    const passUpdateDescriptor = Object.getOwnPropertyDescriptor(PassNode.prototype, "updateBefore")!;
    const lateOutputLookup = vi.fn(() => {
      throw new Error("captured RenderPipeline methods must not be looked up again");
    });
    Object.defineProperty(RenderPipeline.prototype, "_update", {
      ...updateDescriptor,
      value: lateOutputLookup,
    });
    Object.defineProperty(RenderPipeline.prototype, "render", {
      ...renderDescriptor,
      value: lateOutputLookup,
    });
    Object.defineProperty(PassNode.prototype, "updateBefore", {
      ...passUpdateDescriptor,
      value: lateOutputLookup,
    });
    try {
      await expect(graph.precompile(immediateCompileRunner)).resolves.toMatchObject({
        plannedSteps: 6,
        completedSteps: 6,
      });
    } finally {
      Object.defineProperty(RenderPipeline.prototype, "_update", updateDescriptor);
      Object.defineProperty(RenderPipeline.prototype, "render", renderDescriptor);
      Object.defineProperty(PassNode.prototype, "updateBefore", passUpdateDescriptor);
    }

    expect(lateOutputLookup).not.toHaveBeenCalled();
    expect(probe.compiled[1]).toMatchObject({ targetScene: undefined, target: null, mrt: null });
    expect(probe.raw.render).toHaveBeenCalledTimes(3);
    await graph.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("suppresses the captured scene pass only during the split output-quad draw", async () => {
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    scene.add(new Mesh(geometry, material));
    const probe = topologyRenderer();
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGL2", quality("high", false)),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{
        name: "world",
        kind: "opaque-pbr",
        scene,
        camera: new PerspectiveCamera(),
      }]),
      passSignature: "split-output-pass-gate",
      viewport,
    }));
    let scenePass: object | undefined;
    let originalType: PropertyDescriptor | undefined;
    let outputDrawType: PropertyDescriptor | undefined;
    const baseRender = probe.raw.render.getMockImplementation();
    probe.raw.render.mockImplementation((renderScene: unknown, camera: unknown) => {
      if ((renderScene as { isQuadMesh?: boolean }).isQuadMesh === true && scenePass) {
        outputDrawType = Object.getOwnPropertyDescriptor(scenePass, "updateBeforeType");
      }
      baseRender?.(renderScene, camera);
    });

    await graph.precompile(Object.freeze({
      async run(
        descriptor: Readonly<RenderCompileStepDescriptor>,
        operation: () => void | Promise<void>,
      ) {
        await operation();
        if (descriptor.id.endsWith(":output:compile")) {
          scenePass = findNodeType(probe.compiled.at(-1)!.fragmentNode, "PassNode");
          originalType = Object.getOwnPropertyDescriptor(scenePass!, "updateBeforeType");
        }
      },
    }));

    expect(originalType).toMatchObject({ value: NodeUpdateType.FRAME });
    expect(outputDrawType).toEqual({ ...originalType, value: NodeUpdateType.NONE });
    expect(Object.getOwnPropertyDescriptor(scenePass!, "updateBeforeType")).toEqual(originalType);
    expect(probe.rendered.filter((entry) => entry.scene === scene)).toHaveLength(2);
    expect(probe.rendered.at(-1)!.scene).not.toBe(scene);

    await graph.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("refreshes every captured scene pass exactly once before each submitted output frame", async () => {
    const firstScene = new Scene();
    const secondScene = new Scene();
    const firstCamera = new PerspectiveCamera();
    const secondCamera = new PerspectiveCamera();
    const geometry = new BoxGeometry(1, 1, 1);
    const firstMaterial = new MeshStandardNodeMaterial();
    const secondMaterial = new MeshStandardNodeMaterial();
    const firstMesh = new Mesh(geometry, firstMaterial);
    const secondMesh = new Mesh(geometry, secondMaterial);
    firstMesh.visible = false;
    firstScene.add(firstMesh);
    secondScene.add(secondMesh);
    const firstPass: RenderPass = Object.freeze({
      name: "world",
      kind: "opaque-pbr",
      scene: firstScene,
      camera: firstCamera,
    });
    const secondPass: RenderPass = Object.freeze({
      name: "atmosphere",
      kind: "transparent-forward",
      scene: secondScene,
      camera: secondCamera,
    });
    const probe = topologyRenderer();
    const pipeline = new ProductionLinearHdrPipeline();
    pipeline.attachBackend(probe.raw, "webgl2", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    pipeline.quality(quality("high", false));
    await precompile(pipeline, [firstPass, secondPass]);
    const outputCompile = probe.compiled.find((entry) => entry.targetScene === undefined)!;
    const scenePasses = findNodeTypes(outputCompile.fragmentNode, "PassNode");
    const originalTypes = scenePasses.map((scenePass) => (
      Object.getOwnPropertyDescriptor(scenePass, "updateBeforeType")
    ));
    const outputDrawTypes: Array<readonly (PropertyDescriptor | undefined)[]> = [];
    const baseRender = probe.raw.render.getMockImplementation();
    probe.raw.render.mockImplementation((scene: unknown, camera: unknown) => {
      if (scene === outputCompile.scene) {
        outputDrawTypes.push(scenePasses.map((scenePass) => (
          Object.getOwnPropertyDescriptor(scenePass, "updateBeforeType")
        )));
      }
      baseRender?.(scene, camera);
    });
    const programsAtReady = probe.raw.info.memory.programs;
    probe.raw.render.mockClear();
    probe.rendered.length = 0;

    await pipeline.submit([firstPass, secondPass]);
    firstMesh.visible = true;
    secondMesh.visible = false;
    await pipeline.submit([firstPass, secondPass]);

    expect(probe.rendered.map((entry) => entry.scene)).toEqual([
      firstScene,
      secondScene,
      outputCompile.scene,
      firstScene,
      secondScene,
      outputCompile.scene,
    ]);
    expect(probe.rendered.map((entry) => entry.visibleMeshCount)).toEqual([0, 1, 1, 1, 0, 1]);
    expect(outputDrawTypes).toHaveLength(2);
    expect(outputDrawTypes.map((types) => types.map((descriptor) => descriptor?.value)))
      .toEqual([
        [NodeUpdateType.NONE, NodeUpdateType.NONE],
        [NodeUpdateType.NONE, NodeUpdateType.NONE],
      ]);
    expect(scenePasses).toHaveLength(2);
    expect(scenePasses.map((scenePass) => (
      Object.getOwnPropertyDescriptor(scenePass, "updateBeforeType")
    ))).toEqual(originalTypes);
    expect(probe.raw.info.memory.programs).toBe(programsAtReady);
    expect(pipeline.snapshot()).toMatchObject({
      state: "ready",
      programGrowthAfterReady: 0,
    });

    await pipeline.dispose();
    geometry.dispose();
    firstMaterial.dispose();
    secondMaterial.dispose();
  });

  it("restores runtime draw state after a failed scene refresh and permits an honest retry", async () => {
    const firstScene = new Scene();
    const secondScene = new Scene();
    const firstCamera = new PerspectiveCamera();
    const secondCamera = new PerspectiveCamera();
    const geometry = new BoxGeometry(1, 1, 1);
    const firstMaterial = new MeshStandardNodeMaterial();
    const secondMaterial = new MeshStandardNodeMaterial();
    firstScene.add(new Mesh(geometry, firstMaterial));
    secondScene.add(new Mesh(geometry, secondMaterial));
    const firstPass: RenderPass = Object.freeze({
      name: "world",
      kind: "opaque-pbr",
      scene: firstScene,
      camera: firstCamera,
    });
    const secondPass: RenderPass = Object.freeze({
      name: "atmosphere",
      kind: "transparent-forward",
      scene: secondScene,
      camera: secondCamera,
    });
    const probe = topologyRenderer();
    const pipeline = new ProductionLinearHdrPipeline();
    pipeline.attachBackend(probe.raw, "webgl2", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    pipeline.quality(quality("high", false));
    await precompile(pipeline, [firstPass, secondPass]);
    const outputCompile = probe.compiled.find((entry) => entry.targetScene === undefined)!;
    const scenePasses = findNodeTypes(outputCompile.fragmentNode, "PassNode");
    const originalTypes = scenePasses.map((scenePass) => (
      Object.getOwnPropertyDescriptor(scenePass, "updateBeforeType")
    ));
    const runtimeTargets = new Set(probe.compiled.filter((entry) => (
      entry.targetScene === firstScene || entry.targetScene === secondScene
    )).map((entry) => entry.target as object));
    const priorTarget = Object.freeze({ id: "runtime-frame-prior-target" });
    const priorMrt = Object.freeze({ id: "runtime-frame-prior-mrt" });
    const priorContext = Object.freeze({ id: "runtime-frame-prior-context" });
    probe.raw.setRenderTarget(priorTarget);
    probe.raw.setMRT(priorMrt);
    probe.raw.autoClear = false;
    probe.raw.transparent = false;
    probe.raw.opaque = false;
    probe.raw.contextNode = priorContext;
    probe.raw.xr.enabled = true;
    const priorToneMapping = probe.raw.toneMapping;
    const priorOutputColorSpace = probe.raw.outputColorSpace;
    const baseRender = probe.raw.render.getMockImplementation();
    let failSecondScene = true;
    probe.raw.render.mockImplementation((scene: unknown, camera: unknown) => {
      baseRender?.(scene, camera);
      if (failSecondScene && scene === secondScene) {
        throw new Error("runtime scene refresh failed once");
      }
    });
    probe.raw.render.mockClear();
    probe.rendered.length = 0;

    await expect(pipeline.submit([firstPass, secondPass]))
      .rejects.toThrow(/atomic scene-pass draw failed/);
    expect(probe.rendered.map((entry) => entry.scene)).toEqual([firstScene, secondScene]);
    expect(probe.raw.getRenderTarget()).toBe(priorTarget);
    expect(probe.raw.getMRT()).toBe(priorMrt);
    expect(probe.raw.autoClear).toBe(false);
    expect(probe.raw.transparent).toBe(false);
    expect(probe.raw.opaque).toBe(false);
    expect(probe.raw.contextNode).toBe(priorContext);
    expect(probe.raw.xr.enabled).toBe(true);
    expect(probe.raw.toneMapping).toBe(priorToneMapping);
    expect(probe.raw.outputColorSpace).toBe(priorOutputColorSpace);
    expect(scenePasses.map((scenePass) => (
      Object.getOwnPropertyDescriptor(scenePass, "updateBeforeType")
    ))).toEqual(originalTypes);
    expect(pipeline.snapshot()).toMatchObject({ state: "ready" });

    failSecondScene = false;
    await expect(pipeline.submit([firstPass, secondPass])).resolves.toBeUndefined();
    expect(probe.rendered.map((entry) => entry.scene)).toEqual([
      firstScene,
      secondScene,
      firstScene,
      secondScene,
      outputCompile.scene,
    ]);
    expect(scenePasses.map((scenePass) => (
      Object.getOwnPropertyDescriptor(scenePass, "updateBeforeType")
    ))).toEqual(originalTypes);
    expect(pipeline.snapshot()).toMatchObject({ state: "ready", programGrowthAfterReady: 0 });

    await pipeline.dispose();
    for (const target of runtimeTargets) {
      expect(probe.targetDisposals.get(target)).toHaveBeenCalledOnce();
    }
    geometry.dispose();
    firstMaterial.dispose();
    secondMaterial.dispose();
  });

  it("stops after the first failed atomic action and restores renderer and drawable state", async () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    const geometry = new BoxGeometry(1, 1, 1);
    const firstMaterial = new MeshStandardNodeMaterial();
    const secondMaterial = new MeshStandardNodeMaterial();
    const first = new Mesh(geometry, firstMaterial);
    const second = new Mesh(geometry, secondMaterial);
    second.visible = false;
    secondMaterial.visible = false;
    scene.add(first, second);
    const probe = topologyRenderer(0, 2);
    const priorTarget = Object.freeze({ id: "failure-prior-target" });
    const priorMrt = Object.freeze({ id: "failure-prior-mrt" });
    probe.raw.setRenderTarget(priorTarget);
    probe.raw.setMRT(priorMrt);
    const attempted: string[] = [];
    const completed: string[] = [];
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGL2", quality("high", false)),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{ name: "world", kind: "opaque-pbr", scene, camera }]),
      passSignature: "atomic-failure-stop",
      viewport,
    }));

    await expect(graph.precompile(Object.freeze({
      async run(
        descriptor: Readonly<RenderCompileStepDescriptor>,
        operation: () => void | Promise<void>,
      ) {
        attempted.push(descriptor.id);
        await operation();
        completed.push(descriptor.id);
      },
    }))).rejects.toThrow(/atomic drawable compilation failed/);
    expect(attempted).toEqual([
      "linear-hdr:webgl2-high-static:runtime:p0:o0",
      "linear-hdr:webgl2-high-static:runtime:p0:o1",
    ]);
    expect(completed).toEqual(["linear-hdr:webgl2-high-static:runtime:p0:o0"]);
    expect(probe.raw.render).not.toHaveBeenCalled();
    expect(probe.raw.getRenderTarget()).toBe(priorTarget);
    expect(probe.raw.getMRT()).toBe(priorMrt);
    expect(second.visible).toBe(false);
    expect(secondMaterial.visible).toBe(false);

    await graph.dispose();
    geometry.dispose();
    firstMaterial.dispose();
    secondMaterial.dispose();
  });

  it("stops at a failed output-quad compile and restores canvas state before cleanup", async () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    scene.add(new Mesh(geometry, material));
    const probe = topologyRenderer(0, 2);
    const priorTarget = Object.freeze({ id: "output-compile-prior-target" });
    const priorMrt = Object.freeze({ id: "output-compile-prior-mrt" });
    probe.raw.setRenderTarget(priorTarget);
    probe.raw.setMRT(priorMrt);
    const attempted: string[] = [];
    const completed: string[] = [];
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGL2", quality("high", false)),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{ name: "world", kind: "opaque-pbr", scene, camera }]),
      passSignature: "failed-output-compile",
      viewport,
    }));

    await expect(graph.precompile(Object.freeze({
      async run(
        descriptor: Readonly<RenderCompileStepDescriptor>,
        operation: () => void | Promise<void>,
      ) {
        attempted.push(descriptor.id);
        await operation();
        completed.push(descriptor.id);
      },
    }))).rejects.toThrow(/atomic drawable compilation failed/);
    expect(attempted).toEqual([
      "linear-hdr:webgl2-high-static:runtime:p0:o0",
      "linear-hdr:webgl2-high-static:output:update",
      "linear-hdr:webgl2-high-static:output:compile",
    ]);
    expect(completed).toEqual(attempted.slice(0, 2));
    expect(probe.compiled[1]).toMatchObject({ targetScene: undefined, target: null, mrt: null });
    expect(probe.raw.render).not.toHaveBeenCalled();
    expect(probe.raw.getRenderTarget()).toBe(priorTarget);
    expect(probe.raw.getMRT()).toBe(priorMrt);
    const runtimeTarget = probe.compiled[0]!.target as object;

    await graph.dispose();
    expect(probe.targetDisposals.get(runtimeTarget)).toHaveBeenCalledOnce();
    geometry.dispose();
    material.dispose();
  });

  it("stops at a failed atomic runtime draw and restores every temporary scene and renderer gate", async () => {
    const scene = new Scene();
    scene.visible = false;
    const ancestor = new Group();
    ancestor.visible = false;
    const camera = new PerspectiveCamera();
    camera.layers.set(3);
    const geometry = new BoxGeometry(1, 1, 1);
    const firstMaterial = new MeshStandardNodeMaterial();
    firstMaterial.visible = false;
    const secondMaterial = new MeshStandardNodeMaterial();
    secondMaterial.visible = false;
    const first = new Mesh(geometry, firstMaterial);
    first.visible = false;
    first.layers.set(6);
    const second = new Mesh(geometry, secondMaterial);
    second.visible = false;
    ancestor.add(first, second);
    scene.add(ancestor);
    const probe = topologyRenderer();
    const priorTarget = Object.freeze({ id: "runtime-draw-prior-target" });
    const priorMrt = Object.freeze({ id: "runtime-draw-prior-mrt" });
    probe.raw.setRenderTarget(priorTarget);
    probe.raw.setMRT(priorMrt);
    probe.raw.autoClear = false;
    probe.raw.transparent = false;
    probe.raw.opaque = false;
    probe.raw.xr.enabled = true;
    probe.raw.render.mockImplementation(() => {
      throw new Error("runtime object draw failed");
    });
    const attempted: string[] = [];
    const completed: string[] = [];
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGL2", quality("high", false)),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{ name: "world", kind: "opaque-pbr", scene, camera }]),
      passSignature: "failed-runtime-draw",
      viewport,
    }));

    await expect(graph.precompile(Object.freeze({
      async run(
        descriptor: Readonly<RenderCompileStepDescriptor>,
        operation: () => void | Promise<void>,
      ) {
        attempted.push(descriptor.id);
        await operation();
        completed.push(descriptor.id);
      },
    }))).rejects.toThrow(/atomic runtime draw failed/);
    expect(attempted).toEqual([
      "linear-hdr:webgl2-high-static:runtime:p0:o0",
      "linear-hdr:webgl2-high-static:runtime:p0:o1",
      "linear-hdr:webgl2-high-static:output:update",
      "linear-hdr:webgl2-high-static:output:compile",
      "linear-hdr:webgl2-high-static:runtime-draw:p0:o0",
    ]);
    expect(completed).toEqual(attempted.slice(0, 4));
    expect(probe.raw.getRenderTarget()).toBe(priorTarget);
    expect(probe.raw.getMRT()).toBe(priorMrt);
    expect(probe.raw.autoClear).toBe(false);
    expect(probe.raw.transparent).toBe(false);
    expect(probe.raw.opaque).toBe(false);
    expect(probe.raw.xr.enabled).toBe(true);
    expect(scene.visible).toBe(false);
    expect(ancestor.visible).toBe(false);
    expect(first.visible).toBe(false);
    expect(first.layers.mask).toBe(1 << 6);
    expect(firstMaterial.visible).toBe(false);
    expect(second.visible).toBe(false);
    expect(secondMaterial.visible).toBe(false);

    await graph.dispose();
    geometry.dispose();
    firstMaterial.dispose();
    secondMaterial.dispose();
  });

  it("restores pass, scene, renderer, target, and MRT state when the split scene-pass draw fails", async () => {
    const scene = new Scene();
    scene.name = "caller-scene-name";
    const camera = new PerspectiveCamera();
    camera.layers.set(4);
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    scene.add(new Mesh(geometry, material));
    const probe = topologyRenderer();
    const priorTarget = Object.freeze({ id: "pass-draw-prior-target" });
    const priorMrt = Object.freeze({ id: "pass-draw-prior-mrt" });
    const priorContext = Object.freeze({ id: "pass-draw-prior-context" });
    probe.raw.setRenderTarget(priorTarget);
    probe.raw.setMRT(priorMrt);
    probe.raw.autoClear = false;
    probe.raw.transparent = false;
    probe.raw.opaque = false;
    probe.raw.contextNode = priorContext;
    probe.raw.xr.enabled = true;
    const baseRender = probe.raw.render.getMockImplementation();
    let sceneDraws = 0;
    probe.raw.render.mockImplementation((renderScene: unknown, renderCamera: unknown) => {
      baseRender?.(renderScene, renderCamera);
      if (renderScene === scene) {
        sceneDraws += 1;
        if (sceneDraws === 2) throw new Error("split scene-pass draw failed");
      }
    });
    const attempted: string[] = [];
    const completed: string[] = [];
    let scenePass: object | undefined;
    let originalType: PropertyDescriptor | undefined;
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGL2", quality("high", false)),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{ name: "world", kind: "opaque-pbr", scene, camera }]),
      passSignature: "failed-split-pass-draw",
      viewport,
    }));

    await expect(graph.precompile(Object.freeze({
      async run(
        descriptor: Readonly<RenderCompileStepDescriptor>,
        operation: () => void | Promise<void>,
      ) {
        attempted.push(descriptor.id);
        await operation();
        completed.push(descriptor.id);
        if (descriptor.id.endsWith(":output:compile")) {
          scenePass = findNodeType(probe.compiled.at(-1)!.fragmentNode, "PassNode");
          originalType = Object.getOwnPropertyDescriptor(scenePass!, "updateBeforeType");
        }
      },
    }))).rejects.toThrow(/atomic scene-pass draw failed/);
    expect(attempted.at(-1)).toBe("linear-hdr:webgl2-high-static:output:pass-draw:p0");
    expect(completed.at(-1)).toBe("linear-hdr:webgl2-high-static:runtime-draw:p0:o0");
    expect(Object.getOwnPropertyDescriptor(scenePass!, "updateBeforeType")).toEqual(originalType);
    expect(probe.raw.getRenderTarget()).toBe(priorTarget);
    expect(probe.raw.getMRT()).toBe(priorMrt);
    expect(probe.raw.autoClear).toBe(false);
    expect(probe.raw.transparent).toBe(false);
    expect(probe.raw.opaque).toBe(false);
    expect(probe.raw.contextNode).toBe(priorContext);
    expect(probe.raw.xr.enabled).toBe(true);
    expect(scene.name).toBe("caller-scene-name");
    expect(scene.overrideMaterial).toBeNull();
    expect(camera.layers.mask).toBe(1 << 4);

    await graph.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("restores the caller target and MRT when the first output draw fails", async () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    scene.add(new Mesh(geometry, material));
    const probe = topologyRenderer();
    const priorTarget = Object.freeze({ id: "output-draw-prior-target" });
    const priorMrt = Object.freeze({ id: "output-draw-prior-mrt" });
    const priorToneMapping = probe.raw.toneMapping;
    const priorOutputColorSpace = probe.raw.outputColorSpace;
    probe.raw.xr.enabled = true;
    probe.raw.setRenderTarget(priorTarget);
    probe.raw.setMRT(priorMrt);
    let drawTarget: unknown;
    let drawMrt: unknown;
    probe.raw.render.mockImplementation(() => {
      if (probe.raw.getRenderTarget() !== null) return;
      drawTarget = probe.raw.getRenderTarget();
      drawMrt = probe.raw.getMRT();
      throw new Error("output draw failed");
    });
    const attempted: string[] = [];
    const completed: string[] = [];
    let scenePass: object | undefined;
    let originalType: PropertyDescriptor | undefined;
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGL2", quality("high", false)),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{ name: "world", kind: "opaque-pbr", scene, camera }]),
      passSignature: "failed-output-draw",
      viewport,
    }));

    await expect(graph.precompile(Object.freeze({
      async run(
        descriptor: Readonly<RenderCompileStepDescriptor>,
        operation: () => void | Promise<void>,
      ) {
        attempted.push(descriptor.id);
        await operation();
        completed.push(descriptor.id);
        if (descriptor.id.endsWith(":output:compile")) {
          scenePass = findNodeType(probe.compiled.at(-1)!.fragmentNode, "PassNode");
          originalType = Object.getOwnPropertyDescriptor(scenePass!, "updateBeforeType");
        }
      },
    }))).rejects.toThrow(/output first-use draw failed/);
    expect(attempted.at(-1)).toBe("linear-hdr:webgl2-high-static:output:draw");
    expect(completed.at(-1)).toBe("linear-hdr:webgl2-high-static:output:pass-draw:p0");
    expect(drawTarget).toBeNull();
    expect(drawMrt).toBeNull();
    expect(probe.raw.getRenderTarget()).toBe(priorTarget);
    expect(probe.raw.getMRT()).toBe(priorMrt);
    expect(probe.raw.toneMapping).toBe(priorToneMapping);
    expect(probe.raw.outputColorSpace).toBe(priorOutputColorSpace);
    expect(probe.raw.xr.enabled).toBe(true);
    expect(Object.getOwnPropertyDescriptor(scenePass!, "updateBeforeType")).toEqual(originalType);

    await graph.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("fails closed rather than drawing an unplanned equal-count scene replacement", async () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    const first = new Mesh(geometry, material);
    const plannedSecond = new Mesh(geometry, material);
    const unplannedReplacement = new Mesh(geometry, material);
    scene.add(first, plannedSecond);
    const probe = topologyRenderer();
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGL2", quality("high", false)),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{ name: "world", kind: "opaque-pbr", scene, camera }]),
      passSignature: "owned-identity-plan",
      viewport,
    }));
    let steps = 0;
    const failure = await graph.precompile(Object.freeze({
      async run(
        _descriptor: Readonly<RenderCompileStepDescriptor>,
        operation: () => void | Promise<void>,
      ) {
        await operation();
        steps += 1;
        if (steps === 1) {
          scene.remove(plannedSecond);
          scene.add(unplannedReplacement);
        }
      },
    })).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(JSON.stringify((failure as AggregateError).errors)).toContain("bounded path");
    expect(probe.compiled.filter((entry) => entry.targetScene === scene).map((entry) => entry.scene))
      .toEqual([first, plannedSecond]);
    expect(probe.compiled.some((entry) => entry.scene === unplannedReplacement)).toBe(false);
    expect(probe.rendered.some((entry) => entry.scene === unplannedReplacement)).toBe(false);
    await graph.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("rejects multi-material group topology before any runner or renderer action", async () => {
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    const firstMaterial = new MeshStandardNodeMaterial();
    const secondMaterial = new MeshStandardNodeMaterial();
    scene.add(new Mesh(geometry, [firstMaterial, secondMaterial]));
    const probe = topologyRenderer();
    const failure = (() => {
      try {
        createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGPU", quality("high")),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{
        name: "world",
        kind: "opaque-pbr",
        scene,
        camera: new PerspectiveCamera(),
      }]),
      passSignature: "unsupported-multi-material",
      viewport,
        }));
        return null;
      } catch (error: unknown) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(AggregateError);
    expect(JSON.stringify((failure as AggregateError).errors))
      .toContain("Multi-material drawable topology is unsupported");
    expect(probe.raw.compileAsync).not.toHaveBeenCalled();
    expect(probe.raw.render).not.toHaveBeenCalled();
    geometry.dispose();
    firstMaterial.dispose();
    secondMaterial.dispose();
  });

  it("rejects a sparse geometry group inventory before any renderer action", () => {
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    geometry.clearGroups();
    geometry.groups.length = 1;
    scene.add(new Mesh(geometry, material));
    const probe = topologyRenderer();

    const failure = (() => {
      try {
        createThreeLinearHdrGraph(Object.freeze({
          renderer: probe.raw,
          profile: selectLinearHdrPipelineProfile("WebGL2", quality("high", false)),
          materialWarmupPasses: Object.freeze([]),
          passes: Object.freeze([{
            name: "world",
            kind: "opaque-pbr",
            scene,
            camera: new PerspectiveCamera(),
          }]),
          passSignature: "unsupported-sparse-groups",
          viewport,
        }));
        return null;
      } catch (error: unknown) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(AggregateError);
    expect(JSON.stringify((failure as AggregateError).errors)).toContain("dense own data slots");
    expect(probe.raw.compileAsync).not.toHaveBeenCalled();
    expect(probe.raw.render).not.toHaveBeenCalled();
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
    await precompile(pipeline, [runtimePass()]);
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
        pending.push(precompile(
          pipeline,
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
    await precompile(pipeline, [runtimePass()]);
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
          pending.push(precompile(
            pipeline,
            nestedPasses as unknown as readonly RenderPass[],
          ).catch((error: unknown) => error));
          pending.push(pipeline.submit(
            nestedPasses as unknown as readonly RenderPass[],
          ).catch((error: unknown) => error));
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    await expect(precompile(pipeline, outerPasses)).resolves.toMatchObject({
      plannedSteps: 20,
      completedSteps: 20,
    });
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
    await precompile(pipeline, [warmed]);
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
    await precompile(pipeline, [warmed]);
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
    const accessorFailure = await precompile(pipeline, [
      accessorPass as unknown as RenderPass,
    ]).catch((error: unknown) => error);
    expect(accessorFailure).toBeInstanceOf(AggregateError);
    expect(JSON.stringify((accessorFailure as AggregateError).errors))
      .toContain("scene must be an own data property");
    expect(sceneGetter).not.toHaveBeenCalled();

    const sparse = [base] as RenderPass[];
    sparse.length = 2;
    const sparseFailure = await precompile(pipeline, sparse).catch((error: unknown) => error);
    expect(JSON.stringify((sparseFailure as AggregateError).errors)).toContain("dense own data slots");
    const oversizedFailure = await precompile(
      pipeline,
      new Array<RenderPass>(257).fill(base),
    ).catch((error: unknown) => error);
    expect(JSON.stringify((oversizedFailure as AggregateError).errors)).toContain("at most 256 passes");
    const slotGetter = vi.fn(() => base);
    const accessorSlots: RenderPass[] = [];
    Object.defineProperty(accessorSlots, "0", { enumerable: true, get: slotGetter });
    const slotFailure = await precompile(pipeline, accessorSlots).catch(
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
    await expect(precompile(pipeline, inventory)).resolves.toMatchObject({
      plannedSteps: 20,
      completedSteps: 20,
    });
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

  it("rejects an omitted compile runner before inspecting passes or constructing graphs", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const passInspection = vi.fn(() => {
      throw new Error("passes must remain uninspected without a runner");
    });
    const hostilePasses = new Proxy([runtimePass()], {
      getOwnPropertyDescriptor: passInspection,
    });

    const failure = await pipeline.precompile(
      hostilePasses,
      undefined as unknown as RenderCompileStepRunner,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(JSON.stringify((failure as AggregateError).errors)).toContain("runner must be an object");
    expect(passInspection).not.toHaveBeenCalled();
    expect(harness.contexts).toEqual([]);
    expect(pipeline.snapshot()).toMatchObject({ state: "attached", graphCount: 0 });

    await precompile(pipeline, [runtimePass()]);
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
    await precompile(pipeline, [...materialInventory, pass]);

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
      precompileSteps: 160,
      precompileStepsAtReady: 160,
      programCountAtReady: 8,
      outputTransformCount: 1,
      intermediateType: "half-float",
      depthOwned: true,
      velocityOwned: true,
      historyOwned: true,
    });
    await pipeline.dispose();
  });

  it.each([
    ["webgl2", [
      "webgl2-high-static",
      "webgl2-balanced-static",
      "webgl2-low-static",
    ], ["webgl2-high-static"], 88],
    ["webgpu", [
      "webgpu-high-temporal",
      "webgpu-high-static",
      "webgpu-balanced-temporal",
      "webgpu-balanced-static",
      "webgpu-low-static",
    ], ["webgpu-high-temporal", "webgpu-high-static"], 176],
  ] as const)(
    "returns the exact atomic %s production receipt and keeps it stable after ready",
    async (api, profileIds, representativeIds, expectedTotal) => {
      const runtimeScene = new Scene();
      const camera = new PerspectiveCamera(50, 1, 0.1, 100);
      const geometry = new BoxGeometry(1, 1, 1);
      const material = new MeshStandardNodeMaterial();
      for (let index = 0; index < 28; index += 1) {
        const mesh = new Mesh(geometry, material);
        mesh.name = `caller-authored-runtime-${index}`;
        runtimeScene.add(mesh);
      }
      const runtime: RenderPass = Object.freeze({
        name: "caller-authored-world-name",
        kind: "opaque-pbr",
        scene: runtimeScene,
        camera,
      });
      const materialInventory: RenderPass[] = [];
      for (let familyIndex = 0; familyIndex < WORLD_MATERIAL_FAMILIES.length; familyIndex += 1) {
        const family = WORLD_MATERIAL_FAMILIES[familyIndex]!;
        for (const variant of ["webgpu-full", "webgpu-lean"] as const) {
          const scene = new Scene();
          scene.add(new Mesh(geometry, material));
          materialInventory.push(Object.freeze({
            name: `caller-authored-material-${family}`,
            kind: GFX005_MATERIAL_WARMUP_KIND,
            variant,
            scene,
            camera,
          }));
        }
      }
      const passes = Object.freeze([...materialInventory, runtime]);
      const probe = topologyRenderer(7);
      const pipeline = new ProductionLinearHdrPipeline();
      pipeline.attachBackend(probe.raw, api, viewport);
      await pipeline.initialize({} as FeatureInitContext);
      const attempted: Readonly<RenderCompileStepDescriptor>[] = [];
      const completed: string[] = [];
      const runner: RenderCompileStepRunner = Object.freeze({
        async run(
          descriptor: Readonly<RenderCompileStepDescriptor>,
          operation: () => void | Promise<void>,
        ) {
          attempted.push(descriptor);
          await operation();
          completed.push(descriptor.id);
        },
      });

      const receipt = await precompile(pipeline, passes, runner);
      expect(receipt).toEqual({
        plannedSteps: expectedTotal,
        completedSteps: expectedTotal,
        phaseCounts: {
          "runtime-object": representativeIds.length * 56,
          "material-isolated": representativeIds.length * 14,
          "material-runtime-topology": representativeIds.length * 14,
          "output-first-use": representativeIds.length * 4,
        },
      });
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.isFrozen(receipt.phaseCounts)).toBe(true);
      expect(attempted).toHaveLength(expectedTotal);
      expect(completed).toEqual(attempted.map((descriptor) => descriptor.id));
      expect(new Set(completed).size).toBe(expectedTotal);
      expect(attempted.every((descriptor) => Object.isFrozen(descriptor))).toBe(true);

      const expectedIds: string[] = [];
      for (let profileIndex = 0; profileIndex < representativeIds.length; profileIndex += 1) {
        const profileId = representativeIds[profileIndex]!;
        for (let objectIndex = 0; objectIndex < 28; objectIndex += 1) {
          expectedIds.push(`linear-hdr:${profileId}:runtime:p0:o${objectIndex}`);
        }
        for (let materialIndex = 0; materialIndex < 14; materialIndex += 1) {
          expectedIds.push(`linear-hdr:${profileId}:material-isolated:m${materialIndex}`);
        }
        for (let materialIndex = 0; materialIndex < 14; materialIndex += 1) {
          expectedIds.push(`linear-hdr:${profileId}:material-runtime:m${materialIndex}:t0`);
        }
        expectedIds.push(`linear-hdr:${profileId}:output:update`);
        expectedIds.push(`linear-hdr:${profileId}:output:compile`);
        for (let objectIndex = 0; objectIndex < 28; objectIndex += 1) {
          expectedIds.push(`linear-hdr:${profileId}:runtime-draw:p0:o${objectIndex}`);
        }
        expectedIds.push(`linear-hdr:${profileId}:output:pass-draw:p0`);
        expectedIds.push(`linear-hdr:${profileId}:output:draw`);
      }
      expect(completed).toEqual(expectedIds);
      expect(completed.every((id) => !id.includes("caller-authored"))).toBe(true);
      expect(probe.raw.compileAsync)
        .toHaveBeenCalledTimes(representativeIds.length * 57);
      expect(probe.compiled.every((entry) => (
        entry.targetScene === runtimeScene
        || materialInventory.some((candidate) => candidate.scene === entry.targetScene)
        || entry.targetScene === undefined
      ))).toBe(true);

      const postReadyRun = vi.fn(async () => {
        throw new Error("post-ready runner must not execute");
      });
      await expect(precompile(pipeline, passes, { run: postReadyRun })).resolves.toBe(receipt);
      expect(postReadyRun).not.toHaveBeenCalled();
      const readySnapshot = pipeline.snapshot();
      expect(readySnapshot).toMatchObject({
        warmedProfileIds: profileIds,
        graphCount: representativeIds.length,
      });
      await pipeline.resize({ width: 1024, height: 576, pixelRatio: 1 });
      pipeline.invalidateHistory(historyEvent("restart-or-qa-seek"));
      for (let profileIndex = 0; profileIndex < profileIds.length; profileIndex += 1) {
        const profileId = profileIds[profileIndex]!;
        const tier = profileId.includes("high")
          ? "high"
          : profileId.includes("balanced") ? "balanced" : "low";
        pipeline.quality(quality(tier, profileId.endsWith("temporal")));
        expect(pipeline.snapshot().activeProfileId).toBe(profileId);
        await pipeline.submit([runtime]);
      }
      expect(pipeline.snapshot()).toMatchObject({
        precompileSteps: expectedTotal,
        precompileStepsAtReady: expectedTotal,
        programCountAtReady: readySnapshot.programCountAtReady,
        programGrowthAfterReady: 0,
      });
      expect(probe.raw.compileAsync)
        .toHaveBeenCalledTimes(representativeIds.length * 57);

      await pipeline.dispose();
      expect(pipeline.snapshot()).toMatchObject({
        state: "disposed",
        graphCount: 0,
        warmedProfileIds: [],
        disposedGraphs: representativeIds.length,
      });
      geometry.dispose();
      material.dispose();
    },
  );

  it.each([
    ["webgl2", 1],
    ["webgpu", 2],
  ] as const)(
    "resizes and disposes each unique default %s topology exactly once",
    async (api, expectedGraphs) => {
      const prototypeProbe = tslPass(new Scene(), new PerspectiveCamera());
      const passPrototype = Object.getPrototypeOf(prototypeProbe) as {
        setSize(width: number, height: number): void;
      };
      prototypeProbe.dispose();
      const setSize = vi.spyOn(passPrototype, "setSize");
      const renderPipelineDispose = vi.spyOn(RenderPipeline.prototype, "dispose");
      const geometry = new BoxGeometry(1, 1, 1);
      const material = new MeshStandardNodeMaterial();
      const scene = new Scene();
      scene.add(new Mesh(geometry, material));
      const pass: RenderPass = Object.freeze({
        name: "world",
        kind: "opaque-pbr",
        scene,
        camera: new PerspectiveCamera(),
      });
      const pipeline = new ProductionLinearHdrPipeline();
      pipeline.attachBackend(topologyRenderer().raw, api, viewport);
      await pipeline.initialize({} as FeatureInitContext);
      try {
        await precompile(pipeline, [pass]);
        expect(pipeline.snapshot().graphCount).toBe(expectedGraphs);
        setSize.mockClear();

        await pipeline.resize({ width: 960, height: 540, pixelRatio: 1 });
        expect(setSize).toHaveBeenCalledTimes(expectedGraphs);
        await pipeline.dispose();
        expect(renderPipelineDispose).toHaveBeenCalledTimes(expectedGraphs);
        expect(pipeline.snapshot()).toMatchObject({
          graphCount: 0,
          disposedGraphs: expectedGraphs,
        });
      } finally {
        await pipeline.dispose().catch(() => undefined);
        setSize.mockRestore();
        renderPipelineDispose.mockRestore();
        geometry.dispose();
        material.dispose();
      }
    },
  );

  it.each([
    ["webgl2", [
      "webgl2-high-static",
      "webgl2-balanced-static",
      "webgl2-low-static",
    ]],
    ["webgpu", [
      "webgpu-high-temporal",
      "webgpu-high-static",
      "webgpu-balanced-temporal",
      "webgpu-balanced-static",
      "webgpu-low-static",
    ]],
  ] as const)(
    "preserves distinct per-profile ownership for a custom %s graph factory",
    async (api, profileIds) => {
      const harness = graphHarness();
      const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
      pipeline.attachBackend(renderer(), api, viewport);
      await pipeline.initialize({} as FeatureInitContext);
      const receipt = await precompile(pipeline, [runtimePass()]);

      expect(harness.contexts.map((context) => context.profile.id)).toEqual(profileIds);
      expect(harness.graphs).toHaveLength(profileIds.length);
      expect(new Set(harness.graphs).size).toBe(profileIds.length);
      expect(receipt).toMatchObject({
        plannedSteps: profileIds.length * 4,
        completedSteps: profileIds.length * 4,
      });
      expect(pipeline.snapshot()).toMatchObject({
        warmedProfileIds: profileIds,
        graphCount: profileIds.length,
      });

      await pipeline.resize({ width: 960, height: 540, pixelRatio: 1 });
      expect(harness.graphs.every((graph) => graph.resize.mock.calls.length === 1)).toBe(true);
      await pipeline.dispose();
      expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
      expect(pipeline.snapshot().disposedGraphs).toBe(profileIds.length);
    },
  );

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
      async precompile(runner) {
        let materialIndex = 0;
        return completeHarnessCompilePlan(context, runner, (descriptor) => {
          if (descriptor.phase !== "material-isolated") return;
          const candidate = context.materialWarmupPasses[materialIndex]!;
          materialIndex += 1;
          const key = `${context.profile.id}/${candidate.name}/${candidate.variant ?? "absent"}`;
          if (!compiled.has(key)) {
            compiled.add(key);
            raw.info.memory.programs += 1;
          }
        });
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
    await precompile(pipeline, [activated, pass]);

    expect(compiled.size).toBe(5);
    expect([...compiled].every((key) => key.includes("gfx005-material:water/webgpu-full")))
      .toBe(true);
    await expect(pipeline.submit([pass])).resolves.toBeUndefined();
    expect(pipeline.snapshot()).toMatchObject({
      programCountAtReady: 5,
      programGrowthAfterReady: 0,
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
    await precompile(pipeline, [pass]);

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
    await precompile(pipeline, [pass]);
    const active = harness.graphs.find((graph) => graph.profile.id === "webgpu-high-temporal")!;

    await pipeline.submit([pass]);
    await pipeline.submit([pass]);
    expect(active.setHistoryWeight.mock.calls).toEqual([[0], [0.1]]);
    expect(active.render).toHaveBeenCalledTimes(2);
    expect(pipeline.snapshot()).toMatchObject({
      historyValid: true,
      precompileSteps: pipeline.snapshot().precompileStepsAtReady,
    });
    await pipeline.dispose();
  });

  it("supports all nine reset reasons and deduplicates the backend/feature double path", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass = runtimePass();
    await precompile(pipeline, [pass]);

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
    await precompile(pipeline, [pass]);
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
      pending.push(precompile(
        pipeline,
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
    await precompile(pipeline, [runtimePass()]);
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
    await precompile(pipeline, [absent]);
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
    await precompile(pipeline, [material, pass]);
    await expect(precompile(pipeline, [material, pass])).resolves.toMatchObject({
      plannedSteps: 30,
      completedSteps: 30,
    });
    await expect(precompile(pipeline, [{
      ...material,
      variant: "webgpu-lean",
    }, pass])).rejects.toThrow(/unwarmed pass graph/);
    await expect(precompile(pipeline, [pass])).rejects.toThrow(/unwarmed pass graph/);
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
    await precompile(pipeline, [warmed]);
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
    await precompile(pipeline, [warmed]);
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
        precompile(runner) { return completeHarnessCompilePlan(context, runner); },
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
      await precompile(pipeline, [hostile]);
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
    await precompile(pipeline, [pass]);
    await expect(pipeline.submit([{ ...pass, scene: {} }])).rejects.toThrow(/did not match/);
    raw.info.memory.programs = 9;
    await expect(pipeline.submit([pass])).rejects.toThrow(/program count grew/);
    expect(pipeline.snapshot()).toMatchObject({
      programGrowthAfterReady: 1,
    });
    await pipeline.dispose();
  });

  it("applies backend and feature resize/dispose paths exactly once", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    await precompile(pipeline, [runtimePass()]);
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
    await precompile(pipeline, [pass]);
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
    await expect(precompile(pipeline, [pass])).rejects.toThrow(/resize is incomplete/);
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
    await expect(precompile(pipeline, [pass])).resolves.toMatchObject({
      plannedSteps: 20,
      completedSteps: 20,
    });
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
      precompile(runner) { return completeHarnessCompilePlan(context, runner); },
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
    await precompile(pipeline, [runtimePass()]);
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

  it("fails closed with one retryable disposal rejection during an unsettled graph resize", async () => {
    const gate = deferredVoid();
    const entered = deferredVoid();
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    const pass = runtimePass();
    await precompile(pipeline, [pass]);
    harness.graphs[2]!.resize.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
    });
    const resized = Object.freeze({ width: 1024, height: 576, pixelRatio: 1.25 });

    const resizing = pipeline.resize(resized);
    await entered.promise;
    expect(() => pipeline.quality(quality("high"))).toThrow(/resize is incomplete/);
    await expect(precompile(pipeline, [pass])).rejects.toThrow(/resize is incomplete/);
    await expect(pipeline.submit([pass])).rejects.toThrow(/resize is incomplete/);
    await expect(pipeline.resize({ ...resized, width: 1280 })).rejects.toThrow(
      /operation is active/,
    );
    expect(pipeline.snapshot().historyResetCounts.resize).toBe(0);

    const blockedDisposal = pipeline.dispose();
    const concurrentBlockedDisposal = pipeline.dispose();
    expect(concurrentBlockedDisposal).toBe(blockedDisposal);
    await expect(blockedDisposal).rejects.toThrow(/graph callback is unsettled; retry/);
    await expect(concurrentBlockedDisposal).rejects.toThrow(/graph callback is unsettled; retry/);
    expect(pipeline.snapshot()).toMatchObject({
      state: "ready",
      graphCount: 5,
      disposedGraphs: 0,
      historyResetCounts: { resize: 0 },
    });
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 0)).toBe(true);
    gate.resolve();
    await resizing;
    expect(harness.graphs.every((graph) => graph.resize.mock.calls.length === 1)).toBe(true);

    const terminalDisposal = pipeline.dispose();
    const concurrentTerminalDisposal = pipeline.dispose();
    expect(terminalDisposal).not.toBe(blockedDisposal);
    expect(concurrentTerminalDisposal).toBe(terminalDisposal);
    await terminalDisposal;
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      state: "disposed",
      historyResetCounts: { resize: 1 },
    });
  });

  it("rejects post-yield owner disposal from graph resize without claiming ownership", async () => {
    const ownerAttemptReady = deferredVoid();
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    await precompile(pipeline, [runtimePass()]);
    const resized = Object.freeze({ width: 1024, height: 576, pixelRatio: 1.25 });
    let ownerDisposal: Promise<void> | null = null;
    harness.graphs[0]!.resize.mockImplementationOnce(async () => {
      await 0;
      ownerDisposal = pipeline.dispose();
      ownerAttemptReady.resolve();
      await ownerDisposal;
    });

    const resizing = pipeline.resize(resized);
    await ownerAttemptReady.promise;
    const concurrentExternalDisposal = pipeline.dispose();
    expect(concurrentExternalDisposal).toBe(ownerDisposal);
    await expect(ownerDisposal).rejects.toThrow(/graph callback is unsettled; retry/);
    await expect(concurrentExternalDisposal).rejects.toThrow(/graph callback is unsettled; retry/);
    await expect(resizing).rejects.toThrow(/graph callback is unsettled; retry/);
    expect(pipeline.snapshot()).toMatchObject({
      state: "ready",
      graphCount: 5,
      disposedGraphs: 0,
      historyResetCounts: { resize: 0 },
      cleanupPendingGraphs: 0,
    });
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 0)).toBe(true);

    await expect(pipeline.resize(resized)).resolves.toBeUndefined();
    const terminalDisposal = pipeline.dispose();
    expect(terminalDisposal).not.toBe(ownerDisposal);
    await expect(terminalDisposal).resolves.toBeUndefined();
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({ state: "disposed", disposedGraphs: 5 });
  });

  it("rejects owner disposal reentry from graph resize without claiming disposal", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    await precompile(pipeline, [runtimePass()]);
    const resized = Object.freeze({ width: 1024, height: 576, pixelRatio: 1.25 });
    let synchronousOwnerDisposal: Promise<void> | null = null;
    harness.graphs[0]!.resize.mockImplementationOnce(async () => {
      synchronousOwnerDisposal = pipeline.dispose();
      await synchronousOwnerDisposal;
    });

    await expect(pipeline.resize(resized)).rejects.toThrow(/reentrantly from a graph callback/);
    await expect(synchronousOwnerDisposal).rejects.toThrow(/reentrantly from a graph callback/);
    expect(pipeline.snapshot()).toMatchObject({
      state: "ready",
      historyResetCounts: { resize: 0 },
      disposedGraphs: 0,
    });
    await expect(pipeline.resize({ ...resized })).resolves.toBeUndefined();
    const terminalDisposal = pipeline.dispose();
    expect(terminalDisposal).not.toBe(synchronousOwnerDisposal);
    await expect(terminalDisposal).resolves.toBeUndefined();
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("rejects a graph callback that reenters frame submission", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    pipeline.quality(quality("high"));
    const pass = runtimePass();
    await precompile(pipeline, [pass]);
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
    await precompile(pipeline, [runtimePass()]);
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

  it("breaks a post-yield graph disposer cycle without replacing the terminal owner", async () => {
    const ownerAttemptReady = deferredVoid();
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    await precompile(pipeline, [runtimePass()]);
    let ownerDisposal: Promise<void> | null = null;
    harness.graphs[0]!.dispose.mockImplementationOnce(async () => {
      await 0;
      ownerDisposal = pipeline.dispose();
      ownerAttemptReady.resolve();
      await ownerDisposal;
    });

    const terminalOwner = pipeline.dispose();
    const concurrentTerminalOwner = pipeline.dispose();
    expect(concurrentTerminalOwner).toBe(terminalOwner);
    await ownerAttemptReady.promise;
    const ambiguousExternalDisposal = pipeline.dispose();
    expect(ambiguousExternalDisposal).toBe(ownerDisposal);
    expect(ambiguousExternalDisposal).not.toBe(terminalOwner);
    await expect(ownerDisposal).rejects.toThrow(/graph callback is unsettled; retry/);
    await expect(ambiguousExternalDisposal).rejects.toThrow(/graph callback is unsettled; retry/);
    await expect(terminalOwner).rejects.toThrow(/pipeline disposal failed/);
    expect(pipeline.snapshot()).toMatchObject({
      state: "failed",
      graphCount: 1,
      disposedGraphs: 4,
      cleanupPendingGraphs: 1,
    });

    const retryOwner = pipeline.dispose();
    const concurrentRetryOwner = pipeline.dispose();
    expect(retryOwner).not.toBe(terminalOwner);
    expect(retryOwner).not.toBe(ownerDisposal);
    expect(concurrentRetryOwner).toBe(retryOwner);
    await expect(retryOwner).resolves.toBeUndefined();
    expect(harness.graphs[0]!.dispose).toHaveBeenCalledTimes(2);
    expect(harness.graphs.slice(1).every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      state: "disposed",
      graphCount: 0,
      disposedGraphs: 5,
      cleanupPendingGraphs: 0,
    });
    expect(pipeline.dispose()).toBe(retryOwner);
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

    const warming = precompile(pipeline, [pass]);
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
    await precompile(pipeline, [pass]);
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
    await precompile(pipeline, [runtimePass()]);
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
    await precompile(pipeline, [pass]);
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
          asyncFailures.push(precompile(pipeline, [pass]).catch((error: unknown) => error));
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
    await precompile(pipeline, [runtimePass()]);
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

  it("awaits asynchronous history weight and requires disposal retry after it settles", async () => {
    const harness = graphHarness();
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);
    pipeline.quality(quality("high"));
    const pass = runtimePass();
    await precompile(pipeline, [pass]);
    const active = harness.graphs.find((graph) => graph.profile.id === "webgpu-high-temporal")!;
    const gate = deferredVoid();
    active.setHistoryWeight.mockImplementationOnce(() => gate.promise);

    const submitting = pipeline.submit([pass]);
    await vi.waitFor(() => expect(active.setHistoryWeight).toHaveBeenCalledOnce());
    expect(active.render).not.toHaveBeenCalled();
    const blockedDisposal = pipeline.dispose();
    const concurrentBlockedDisposal = pipeline.dispose();
    expect(concurrentBlockedDisposal).toBe(blockedDisposal);
    await expect(blockedDisposal).rejects.toThrow(/graph callback is unsettled; retry/);
    await expect(concurrentBlockedDisposal).rejects.toThrow(/graph callback is unsettled; retry/);
    expect(active.dispose).not.toHaveBeenCalled();
    expect(pipeline.snapshot().state).toBe("ready");

    gate.resolve();
    await submitting;
    expect(active.render).toHaveBeenCalledOnce();
    const terminalDisposal = pipeline.dispose();
    expect(terminalDisposal).not.toBe(blockedDisposal);
    await terminalDisposal;
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 1)).toBe(true);
  });

  it("unwinds partial warm-up and freezes copied failure evidence without cycles", async () => {
    const external = new Error("dispose failed") as Error & { cause?: unknown };
    external.cause = external;
    const harness = graphHarness({ failPrecompileAt: 1, disposeFailure: external });
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);

    const failure = await precompile(pipeline, [runtimePass()]).catch((error: unknown) => error);
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
      graphCount: 5,
      cleanupPendingGraphs: 5,
    });
    const disposal = pipeline.dispose();
    await expect(disposal).rejects.toThrow(/pipeline disposal failed/);
    expect(harness.graphs.every((graph) => graph.dispose.mock.calls.length === 2)).toBe(true);
    expect(pipeline.snapshot()).toMatchObject({
      state: "failed",
      graphCount: 5,
      cleanupPendingGraphs: 5,
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

    await expect(precompile(pipeline, [runtimePass()])).rejects.toThrow(/warm-up failed/);
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
    await expect(precompile(profilePipeline, [runtimePass()])).rejects.toThrow(/warm-up failed/);
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
      const precompile = async (runner: RenderCompileStepRunner) => {
        increment(precompileCalls, id);
        return completeHarnessCompilePlan(context, runner);
      };
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
    await precompile(pipeline, [pass]);
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
    await precompile(pipeline, [pass]);
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
        precompile(runner) { return completeHarnessCompilePlan(context, runner); },
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

    await expect(precompile(pipeline, [runtimePass()])).rejects.toThrow(/warm-up failed/);
    expect(dispose).toHaveBeenCalledOnce();
    expect(pipeline.snapshot()).toMatchObject({ state: "failed", graphCount: 0 });
  });

  it("keeps blocked and terminal disposal identities distinct across active precompile", async () => {
    const gate = deferredVoid();
    const harness = graphHarness({ precompileGate: { index: 0, promise: gate.promise } });
    const pipeline = new ProductionLinearHdrPipeline({ graphFactory: harness.factory });
    pipeline.attachBackend(renderer(), "webgpu", viewport);
    await pipeline.initialize({} as FeatureInitContext);

    const warming = precompile(pipeline, [runtimePass()]);
    expect(harness.graphs).toHaveLength(5);
    const blockedDisposal = pipeline.dispose();
    const concurrentBlockedDisposal = pipeline.dispose();
    expect(concurrentBlockedDisposal).toBe(blockedDisposal);
    await expect(blockedDisposal).rejects.toThrow(/graph callback is unsettled; retry/);
    await expect(concurrentBlockedDisposal).rejects.toThrow(/graph callback is unsettled; retry/);
    expect(pipeline.snapshot().state).toBe("warming");
    expect(harness.graphs[0]!.dispose).not.toHaveBeenCalled();
    gate.resolve();
    await warming;
    expect(harness.graphs).toHaveLength(5);
    const terminalDisposal = pipeline.dispose();
    const concurrentTerminalDisposal = pipeline.dispose();
    expect(terminalDisposal).not.toBe(blockedDisposal);
    expect(concurrentTerminalDisposal).toBe(terminalDisposal);
    expect(pipeline.snapshot().state).toBe("disposing");
    await terminalDisposal;
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

    await expect(precompile(pipeline, [runtimePass()])).rejects.toThrow(/warm-up failed/);
    expect(graphDispose).toHaveBeenCalledTimes(5);
    expect(pipeline.snapshot()).toMatchObject({
      state: "failed",
      graphCount: 1,
      cleanupPendingGraphs: 1,
      disposedGraphs: 4,
    });

    const first = pipeline.dispose();
    const second = pipeline.dispose();
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(graphDispose).toHaveBeenCalledTimes(6);
    expect(pipeline.snapshot()).toMatchObject({
      state: "disposed",
      graphCount: 0,
      cleanupPendingGraphs: 0,
      disposedGraphs: 5,
    });
  });

  it("conveys direct constructor cleanup ownership in a frozen retryable failure", () => {
    const previousPrepareStackTrace = Object.getOwnPropertyDescriptor(
      Error,
      "prepareStackTrace",
    );
    const prepareStackTrace = vi.fn(() => "S".repeat(2_000_000));
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
      Object.defineProperty(Error, "prepareStackTrace", {
        configurable: true,
        writable: true,
        value: prepareStackTrace,
      });
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
      expect(Object.getOwnPropertyDescriptor(failure, "stack")).toMatchObject({
        configurable: false,
        enumerable: false,
        value: undefined,
        writable: false,
      });
      expect(failure.stack).toBeUndefined();
      expect(prepareStackTrace).not.toHaveBeenCalled();
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
      if (previousPrepareStackTrace) {
        Object.defineProperty(Error, "prepareStackTrace", previousPrepareStackTrace);
      } else {
        Reflect.deleteProperty(Error, "prepareStackTrace");
      }
      setSize.mockRestore();
      passDispose.mockRestore();
      renderPipelineDispose.mockRestore();
    }
    expect(Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"))
      .toEqual(previousPrepareStackTrace);
  });

  it("publishes and cleans a second construction failure after its exposed prototype is poisoned", async () => {
    const prototypeProbe = tslPass(new Scene(), new PerspectiveCamera());
    const passPrototype = Object.getPrototypeOf(prototypeProbe) as {
      dispose(): void;
      setSize(width: number, height: number): void;
    };
    prototypeProbe.dispose();
    const originalPassDispose = passPrototype.dispose;
    const originalPipelineDispose = RenderPipeline.prototype.dispose;
    let setSizeAttempts = 0;
    const setSize = vi.spyOn(passPrototype, "setSize").mockImplementation(() => {
      setSizeAttempts += 1;
      throw new Error(`prototype poisoning setSize ${setSizeAttempts}`);
    });
    const disposedPasses: object[] = [];
    const passDispose = vi.spyOn(passPrototype, "dispose").mockImplementation(function (
      this: typeof passPrototype,
    ) {
      disposedPasses.push(this);
      originalPassDispose.call(this);
    });
    const disposedPipelines: object[] = [];
    const renderPipelineDispose = vi.spyOn(RenderPipeline.prototype, "dispose")
      .mockImplementation(function (this: RenderPipeline) {
        disposedPipelines.push(this);
        originalPipelineDispose.call(this);
      });
    const prototypeTrap = vi.fn(() => {
      throw new Error("construction failure prototype trap invoked");
    });
    let exposedPrototype: object | null = null;
    const priorDescriptors: Array<readonly [PropertyKey, PropertyDescriptor | undefined]> = [];
    try {
      const createDirectFailure = () => {
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
            passSignature: "prototype-poison-first",
            viewport,
          }));
          throw new Error("construction unexpectedly succeeded");
        } catch (error: unknown) {
          return error as AggregateError & { readonly cleanup: { dispose(): void } };
        }
      };
      const firstFailure = createDirectFailure();
      expect(firstFailure.name).toBe("LinearHdrGraphConstructionFailure");
      expect(Object.isFrozen(firstFailure)).toBe(true);
      expect(firstFailure.stack).toBeUndefined();
      exposedPrototype = Object.getPrototypeOf(firstFailure) as object;
      for (const key of ["name", "cleanup", "stack", "message", "errors"] as const) {
        priorDescriptors.push([key, Object.getOwnPropertyDescriptor(exposedPrototype, key)]);
        Object.defineProperty(exposedPrototype, key, {
          configurable: true,
          get: prototypeTrap,
          set: prototypeTrap,
        });
      }

      const pipeline = new ProductionLinearHdrPipeline({ graphFactory: createThreeLinearHdrGraph });
      pipeline.attachBackend(topologyRenderer().raw, "webgpu", viewport);
      await pipeline.initialize({} as FeatureInitContext);
      let secondFailure: AggregateError | null = null;
      try {
        await precompile(pipeline, [Object.freeze({
          name: "world",
          kind: "opaque-pbr",
          scene: new Scene(),
          camera: new PerspectiveCamera(),
        })]);
      } catch (error: unknown) {
        secondFailure = error as AggregateError;
      }
      if (!secondFailure) throw new Error("second construction unexpectedly succeeded");

      expect(secondFailure).toBeInstanceOf(AggregateError);
      expect(Object.isFrozen(secondFailure)).toBe(true);
      expect(Object.isFrozen(secondFailure.errors)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(secondFailure, "stack")).toBeUndefined();
      expect(secondFailure.stack).toBeUndefined();
      expect(JSON.stringify(secondFailure.errors)).toContain("prototype poisoning setSize 2");
      expect(JSON.stringify(secondFailure.errors)).toContain("LinearHdrGraphConstructionFailure");
      expect(prototypeTrap).not.toHaveBeenCalled();
      expect(disposedPasses).toHaveLength(1);
      expect(disposedPipelines).toHaveLength(1);

      firstFailure.cleanup.dispose();
      firstFailure.cleanup.dispose();
      await pipeline.dispose();
      expect(disposedPasses).toHaveLength(2);
      expect(disposedPipelines).toHaveLength(2);
      expect(new Set(disposedPasses).size).toBe(2);
      expect(new Set(disposedPipelines).size).toBe(2);
      expect(prototypeTrap).not.toHaveBeenCalled();
    } finally {
      if (exposedPrototype) {
        for (let index = priorDescriptors.length - 1; index >= 0; index -= 1) {
          const [key, descriptor] = priorDescriptors[index]!;
          if (descriptor) Object.defineProperty(exposedPrototype, key, descriptor);
          else Reflect.deleteProperty(exposedPrototype, key);
        }
      }
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
      const failure = await precompile(pipeline, [pass]).catch((error: unknown) => error);
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
      const failure = await precompile(pipeline, [Object.freeze({
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
      const failure = await precompile(pipeline, [Object.freeze({
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
      const failure = await precompile(pipeline, [Object.freeze({
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
    await precompile(pipeline, [pass]);
    const active = harness.graphs.find((graph) => graph.profile.id === "webgpu-high-temporal")!;
    const gate = deferredVoid();
    active.render.mockImplementation(async () => gate.promise);

    const submitting = pipeline.submit([pass]);
    const disposal = pipeline.dispose();
    await expect(precompile(pipeline, [pass])).rejects.toThrow(/disposal was requested/);
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

    const firstScene = new Scene();
    const secondScene = new Scene();
    const disposalGeometry = new BoxGeometry(1, 1, 1);
    const disposalMaterial = new MeshStandardNodeMaterial();
    firstScene.add(new Mesh(disposalGeometry, disposalMaterial));
    secondScene.add(new Mesh(disposalGeometry, disposalMaterial));
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: rendererProbe.raw,
      profile: selectLinearHdrPipelineProfile("WebGPU", quality("high")),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([
        {
          name: "first",
          kind: "opaque-pbr",
          scene: firstScene,
          camera: new PerspectiveCamera(),
        },
        {
          name: "second",
          kind: "opaque-pbr",
          scene: secondScene,
          camera: new PerspectiveCamera(),
        },
      ]),
      passSignature: "partial-disposal",
      viewport,
    }));
    await graph.precompile(immediateCompileRunner);
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
      disposalGeometry.dispose();
      disposalMaterial.dispose();
    }
  });

  it("retains a failed Three RenderPipeline cleanup without redisposing scene targets", async () => {
    const probe = topologyRenderer();
    const scene = new Scene();
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardNodeMaterial();
    scene.add(new Mesh(geometry, material));
    const graph = createThreeLinearHdrGraph(Object.freeze({
      renderer: probe.raw,
      profile: selectLinearHdrPipelineProfile("WebGPU", quality("high")),
      materialWarmupPasses: Object.freeze([]),
      passes: Object.freeze([{
        name: "world",
        kind: "opaque-pbr",
        scene,
        camera: new PerspectiveCamera(),
      }]),
      passSignature: "pipeline-disposal-retry",
      viewport,
    }));
    await graph.precompile(immediateCompileRunner);
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
      geometry.dispose();
      material.dispose();
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
    const failure = await precompile(pipeline, [{
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

  it("removes the live V8 stack from the final frozen failure wrapper", () => {
    const previousPrepareStackTrace = Object.getOwnPropertyDescriptor(
      Error,
      "prepareStackTrace",
    );
    const prepareStackTrace = vi.fn(() => "S".repeat(2_000_000));
    try {
      Object.defineProperty(Error, "prepareStackTrace", {
        configurable: true,
        writable: true,
        value: prepareStackTrace,
      });
      const failure = ownedAggregateError([], "stackless failure wrapper");

      expect(failure).toBeInstanceOf(AggregateError);
      expect(Object.getOwnPropertyDescriptor(failure, "stack")).toBeUndefined();
      expect(failure.stack).toBeUndefined();
      expect(prepareStackTrace).not.toHaveBeenCalled();
      expect(Object.isFrozen(failure)).toBe(true);
      expect(Object.isFrozen(failure.errors)).toBe(true);
    } finally {
      if (previousPrepareStackTrace) {
        Object.defineProperty(Error, "prepareStackTrace", previousPrepareStackTrace);
      } else {
        Reflect.deleteProperty(Error, "prepareStackTrace");
      }
    }
    expect(Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"))
      .toEqual(previousPrepareStackTrace);
  });

  it("drops forced huge nested stacks while preserving bounded detached evidence", () => {
    const previousPrepareStackTrace = Object.getOwnPropertyDescriptor(
      Error,
      "prepareStackTrace",
    );
    const huge = "N".repeat(2_000_000);
    const prepareStackTrace = vi.fn(() => huge);
    try {
      Object.defineProperty(Error, "prepareStackTrace", {
        configurable: true,
        writable: true,
        value: prepareStackTrace,
      });
      const rawLeaf = new Error(huge);
      const getterZero = vi.fn(() => rawLeaf);
      const rawEntries = new Array<unknown>(4);
      Object.defineProperty(rawEntries, "0", {
        configurable: true,
        get: getterZero,
      });
      rawEntries[1] = rawLeaf;
      rawEntries[2] = rawLeaf;
      const rawNested = new AggregateError([], "raw nested", { cause: rawLeaf });
      Object.defineProperty(rawNested, "errors", {
        configurable: true,
        value: rawEntries,
        writable: true,
      });
      rawEntries[3] = rawNested;
      expect(rawLeaf.stack).toHaveLength(2_000_000);
      expect(rawNested.stack).toHaveLength(2_000_000);

      const failure = ownedAggregateError([rawNested, -0], huge);
      const root = failure.errors[0] as {
        readonly cause: object;
        readonly errors: readonly unknown[];
      };
      expect(failure).toBeInstanceOf(AggregateError);
      expect(Object.getOwnPropertyDescriptor(failure, "stack")).toBeUndefined();
      expect(failure.stack).toBeUndefined();
      expect(prepareStackTrace).toHaveBeenCalledTimes(2);
      expect(getterZero).not.toHaveBeenCalled();
      expect(root.errors[0]).toMatchObject({
        kind: "uninspectable",
        type: "accessor-failure-slot",
      });
      expect(root.errors[1]).toEqual(root.errors[2]);
      expect(root.errors[1]).not.toBe(root.errors[2]);
      expect(root.errors[3]).toMatchObject({ kind: "cycle", type: "object" });
      expect(Object.is((failure.errors[1] as { value: number }).value, -0)).toBe(true);

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
      expect(fields.reduce((sum, value) => sum + value.length, 0))
        .toBeLessThanOrEqual(4_096);
      for (const node of nodes) {
        expect(Object.getOwnPropertyDescriptor(node, "stack")).toBeUndefined();
        expect(Object.isFrozen(node)).toBe(true);
      }

      const captured = JSON.stringify({ message: failure.message, errors: failure.errors });
      rawLeaf.message = "mutated leaf";
      rawNested.message = "mutated aggregate";
      rawEntries[1] = new Error("replacement");
      expect(JSON.stringify({ message: failure.message, errors: failure.errors })).toBe(captured);
    } finally {
      if (previousPrepareStackTrace) {
        Object.defineProperty(Error, "prepareStackTrace", previousPrepareStackTrace);
      } else {
        Reflect.deleteProperty(Error, "prepareStackTrace");
      }
    }
    expect(Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"))
      .toEqual(previousPrepareStackTrace);
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
