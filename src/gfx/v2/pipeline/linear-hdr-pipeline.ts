import {
  ACESFilmicToneMapping,
  HalfFloatType,
  REVISION,
  RenderPipeline,
  SRGBColorSpace,
  type Camera,
  type Node,
  type Object3D,
  type WebGPURenderer,
} from "three/webgpu";
import {
  mix,
  mrt,
  output,
  pass,
  renderOutput,
  screenUV,
  uniform,
  vec2,
  velocity,
} from "three/tsl";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import type {
  FeatureInitContext,
  JourneyRenderSnapshot,
  RenderHistoryInvalidation,
  RenderPass,
  RenderPassRecorder,
  RenderQualityProfile,
  RenderViewport,
  RendererApi,
  VisualClock,
} from "../contracts";
import { GFX005_MATERIAL_WARMUP_KIND } from "../materials/tsl-material-library";
import {
  LINEAR_HDR_PIPELINE_PROFILE_IDS,
  type CreateLinearHdrPipelineOptions,
  type LinearHdrGraph,
  type LinearHdrGraphFactory,
  type LinearHdrGraphFactoryContext,
  type LinearHdrPipelineFeature,
  type LinearHdrPipelineProfile,
  type LinearHdrPipelineProfileId,
  type LinearHdrPipelineSnapshot,
} from "./contracts";
import { TemporalHistoryOwner } from "./temporal-history";
import { ownedAggregateError } from "./failures";

type PipelineRenderer = WebGPURenderer & {
  readonly info?: { readonly memory?: { readonly programs?: number } };
};

type ScenePassNode = ReturnType<typeof pass>;

type RuntimeSceneTopology = Readonly<{
  readonly scene: Object3D;
  readonly scenePass: ScenePassNode;
}>;

type GraphCleanupHandle = Readonly<{
  dispose(): ReturnType<LinearHdrGraph["dispose"]>;
}>;

const constructionCleanupByFailure = new WeakMap<object, GraphCleanupHandle>();
const intrinsicArrayIsArray = Array.isArray;
const intrinsicDefineProperty = Object.defineProperty;
const intrinsicFreeze = Object.freeze;
const intrinsicGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicGetPrototypeOf = Object.getPrototypeOf;
const intrinsicMapForEach = Map.prototype.forEach;
const intrinsicMapSize = intrinsicGetOwnPropertyDescriptor(Map.prototype, "size")!.get!;
const intrinsicNumberIsSafeInteger = Number.isSafeInteger;
const intrinsicReflectApply = Reflect.apply;
const intrinsicSetForEach = Set.prototype.forEach;
const intrinsicSetSize = intrinsicGetOwnPropertyDescriptor(Set.prototype, "size")!.get!;
const intrinsicWeakMapGet = WeakMap.prototype.get;
const intrinsicWeakMapSet = WeakMap.prototype.set;

function appendArrayValue<T>(target: T[], value: T): void {
  intrinsicDefineProperty(target, target.length, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

// three/src/renderers/common/RenderPipeline.js assigns these fields in its
// constructor. The last two assignments occur after NodeMaterial/QuadMesh
// allocation, so an inherited setter there would make the partial instance
// unreachable. Highest-risk late fields are checked first.
const RENDER_PIPELINE_CONSTRUCTOR_FIELDS = intrinsicFreeze([
  "_toneMapping",
  "_outputColorSpace",
  "_quadMesh",
  "_context",
  "renderer",
  "outputNode",
  "outputColorTransform",
  "needsUpdate",
] as const);
const AUDITED_THREE_REVISION = "185";

function assertRenderPipelineConstructorTopology(): void {
  if (REVISION !== AUDITED_THREE_REVISION) {
    throw new TypeError("The installed Three.js RenderPipeline revision is not audited.");
  }
  const pipelinePrototype = RenderPipeline.prototype as object;
  if (
    intrinsicGetPrototypeOf(pipelinePrototype) !== Object.prototype
    || intrinsicGetPrototypeOf(Object.prototype) !== null
  ) {
    throw new TypeError("RenderPipeline prototype topology changed before construction.");
  }
  // The audited package constructor creates all eight as own data fields. Any
  // inherited descriptor can intercept assignment, including late assignments
  // after the internal NodeMaterial and QuadMesh have already been allocated.
  const assertFieldsAbsent = (prototype: object): void => {
    for (let index = 0; index < RENDER_PIPELINE_CONSTRUCTOR_FIELDS.length; index += 1) {
      const field = RENDER_PIPELINE_CONSTRUCTOR_FIELDS[index]!;
      if (intrinsicGetOwnPropertyDescriptor(prototype, field) !== undefined) {
        throw new TypeError(`RenderPipeline prototype field ${field} changed before construction.`);
      }
    }
  };
  assertFieldsAbsent(pipelinePrototype);
  assertFieldsAbsent(Object.prototype);
}

const profileCatalog: Readonly<Record<LinearHdrPipelineProfileId, Readonly<LinearHdrPipelineProfile>>> =
  intrinsicFreeze(Object.fromEntries(LINEAR_HDR_PIPELINE_PROFILE_IDS.map((id) => {
    const webgpu = id.startsWith("webgpu-");
    const temporal = id.endsWith("-temporal");
    const tier = id.includes("-high-") || id === "webgl2-high-static"
      ? "high"
      : id.includes("-balanced-") || id === "webgl2-balanced-static"
        ? "balanced"
        : "low";
    return [id, intrinsicFreeze({
      id,
      actualApi: webgpu ? "WebGPU" : "WebGL2",
      tier,
      temporal,
      antiAliasing: temporal ? "temporal" : "fxaa",
      intermediateType: "half-float",
      toneMapping: "aces-filmic",
      outputColorSpace: "srgb",
      outputTransformCount: 1,
    })];
  })) as Record<LinearHdrPipelineProfileId, Readonly<LinearHdrPipelineProfile>>);

function profilesForApi(actualApi: RendererApi): readonly Readonly<LinearHdrPipelineProfile>[] {
  const profiles: Readonly<LinearHdrPipelineProfile>[] = [];
  for (let index = 0; index < LINEAR_HDR_PIPELINE_PROFILE_IDS.length; index += 1) {
    const profile = profileCatalog[LINEAR_HDR_PIPELINE_PROFILE_IDS[index]!]!;
    if (profile.actualApi === actualApi) appendArrayValue(profiles, profile);
  }
  return intrinsicFreeze(profiles);
}

function captureQualityRouting(profile: Readonly<RenderQualityProfile>): Readonly<{
  tier: RenderQualityProfile["tier"];
  temporal: boolean;
}> {
  if (typeof profile !== "object" || profile === null) {
    throw new TypeError("A render quality profile must be an object.");
  }
  const tierDescriptor = intrinsicGetOwnPropertyDescriptor(profile, "tier");
  if (!tierDescriptor || !("value" in tierDescriptor)) {
    throw new TypeError("Render quality tier must be an own data property.");
  }
  const tier = tierDescriptor.value;
  if (tier !== "low" && tier !== "balanced" && tier !== "high") {
    throw new TypeError("Unsupported render quality tier.");
  }
  const featuresDescriptor = intrinsicGetOwnPropertyDescriptor(profile, "features");
  if (!featuresDescriptor || !("value" in featuresDescriptor)) {
    throw new TypeError("Render quality features must be an own data property.");
  }
  const features = featuresDescriptor.value;
  if (typeof features !== "object" || features === null) {
    throw new TypeError("Render quality features must be an object.");
  }
  const descriptor = intrinsicGetOwnPropertyDescriptor(features, "temporal");
  if (!descriptor || !("value" in descriptor)) {
    return intrinsicFreeze({ tier, temporal: true });
  }
  return intrinsicFreeze({
    tier,
    temporal: descriptor.value !== false && descriptor.value !== "off",
  });
}

export function selectLinearHdrPipelineProfile(
  actualApi: RendererApi,
  profile: Readonly<RenderQualityProfile>,
): Readonly<LinearHdrPipelineProfile> {
  const { tier, temporal: temporalRequested } = captureQualityRouting(profile);
  if (actualApi === "WebGL2") return profileCatalog[`webgl2-${tier}-static`];
  if (tier === "low") return profileCatalog["webgpu-low-static"];
  const temporal = temporalRequested ? "temporal" : "static";
  return profileCatalog[`webgpu-${tier}-${temporal}`];
}

function captureViewport(viewport: Readonly<RenderViewport>): Readonly<RenderViewport> {
  const width = viewport.width;
  const height = viewport.height;
  const pixelRatio = viewport.pixelRatio;
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
    throw new RangeError("Pipeline viewport dimensions must be finite and positive.");
  }
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    throw new RangeError("Pipeline pixel ratio must be finite and positive.");
  }
  return intrinsicFreeze({ width, height, pixelRatio });
}

function sameViewport(
  left: Readonly<RenderViewport>,
  right: Readonly<RenderViewport>,
): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.pixelRatio === right.pixelRatio;
}

function ownPassField(
  pass: object,
  key: "name" | "kind" | "variant" | "scene" | "camera",
  optional = false,
): Readonly<{ present: boolean; value: unknown }> {
  const descriptor = intrinsicGetOwnPropertyDescriptor(pass, key);
  if (descriptor === undefined) {
    if (optional) return intrinsicFreeze({ present: false, value: undefined });
    throw new TypeError(`Pipeline pass ${key} must be an own data property.`);
  }
  if (!("value" in descriptor)) {
    throw new TypeError(`Pipeline pass ${key} must be an own data property.`);
  }
  return intrinsicFreeze({ present: true, value: descriptor.value });
}

function assertOpaquePassField(value: unknown, label: "scene" | "camera"): void {
  if (
    value != null
    && (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new TypeError(`Pipeline pass ${label} must be an opaque object when present.`);
  }
}

function capturePipelinePasses(
  passes: readonly Readonly<RenderPass>[],
): readonly Readonly<RenderPass>[] {
  if (!intrinsicArrayIsArray(passes)) {
    throw new TypeError("A Linear HDR pass inventory must be an array.");
  }
  const lengthDescriptor = intrinsicGetOwnPropertyDescriptor(passes, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)) {
    throw new TypeError("A Linear HDR pass inventory length must be an own data property.");
  }
  const length = lengthDescriptor.value;
  if (!intrinsicNumberIsSafeInteger(length) || length < 0 || length > 256) {
    throw new RangeError("A Linear HDR pass inventory accepts at most 256 passes.");
  }
  const captured: Readonly<RenderPass>[] = [];
  for (let index = 0; index < length; index += 1) {
    const slot = intrinsicGetOwnPropertyDescriptor(passes, String(index));
    if (!slot || !("value" in slot)) {
      throw new TypeError("Linear HDR pass inventories must contain dense own data slots.");
    }
    const source = slot.value;
    if (
      ((typeof source !== "object" || source === null) && typeof source !== "function")
    ) {
      throw new TypeError("A Linear HDR pass must be an object.");
    }
    const pass = source as object;
    const name = ownPassField(pass, "name").value;
    const kind = ownPassField(pass, "kind").value;
    const variant = ownPassField(pass, "variant", true);
    const scene = ownPassField(pass, "scene", true).value;
    const camera = ownPassField(pass, "camera", true).value;
    assertOpaquePassField(scene, "scene");
    assertOpaquePassField(camera, "camera");
    const capturedName = signatureField(name as string, "name");
    const capturedKind = signatureField(kind as string, "kind");
    const capturedVariant = variant.value === undefined
      ? undefined
      : signatureField(variant.value as string, "variant");
    appendArrayValue(captured, intrinsicFreeze({
      name: capturedName,
      kind: capturedKind,
      variant: capturedVariant,
      scene,
      camera,
    }));
  }
  return intrinsicFreeze(captured);
}

function drawablePasses(passes: readonly Readonly<RenderPass>[]): readonly Readonly<RenderPass>[] {
  const drawable: Readonly<RenderPass>[] = [];
  for (let index = 0; index < passes.length; index += 1) {
    const candidate = passes[index]!;
    if (
      candidate.scene != null
      && candidate.camera != null
      && candidate.kind !== GFX005_MATERIAL_WARMUP_KIND
    ) {
      appendArrayValue(drawable, candidate);
    }
  }
  return intrinsicFreeze(drawable);
}

function materialWarmupPasses(
  passes: readonly Readonly<RenderPass>[],
): readonly Readonly<RenderPass>[] {
  const inventory: Readonly<RenderPass>[] = [];
  for (let index = 0; index < passes.length; index += 1) {
    const candidate = passes[index]!;
    if (candidate.kind !== GFX005_MATERIAL_WARMUP_KIND) continue;
    if (candidate.scene == null || candidate.camera == null) {
      throw new TypeError(`Material warm-up pass ${candidate.name} requires a scene and camera.`);
    }
    appendArrayValue(inventory, candidate);
  }
  return intrinsicFreeze(inventory);
}

function rendererPrograms(renderer: unknown): number | null {
  try {
    const value = (renderer as PipelineRenderer).info?.memory?.programs;
    return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
  } catch {
    return null;
  }
}

function objectIdentity(value: unknown, identities: WeakMap<object, number>, next: { value: number }): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object" && typeof value !== "function") {
    throw new TypeError("A captured pipeline identity must be opaque.");
  }
  const object = value as object;
  let identity = intrinsicReflectApply(intrinsicWeakMapGet, identities, [object]) as number | undefined;
  if (identity === undefined) {
    identity = next.value;
    next.value += 1;
    intrinsicReflectApply(intrinsicWeakMapSet, identities, [object, identity]);
  }
  return `object:${identity}`;
}

function passSignature(
  passes: readonly Readonly<RenderPass>[],
  identities: WeakMap<object, number>,
  next: { value: number },
): string {
  if (passes.length > 256) throw new RangeError("A pipeline signature accepts at most 256 passes.");
  let encoded = `passes:${passes.length};`;
  for (let index = 0; index < passes.length; index += 1) {
    const candidate = passes[index]!;
    const fields = [
      signatureField(candidate.kind, "kind"),
      signatureField(candidate.name, "name"),
      candidate.variant === undefined
        ? "variant:absent"
        : `variant:value:${signatureField(candidate.variant, "variant")}`,
      objectIdentity(candidate.scene, identities, next),
      objectIdentity(candidate.camera, identities, next),
    ];
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      const field = fields[fieldIndex]!;
      encoded += `${field.length}:${field}`;
    }
  }
  return encoded;
}

function signatureField(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new RangeError(`Pipeline pass ${label} must contain from 1 through 256 UTF-16 code units.`);
  }
  return value;
}

function ownGraphData(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`Linear HDR graph ${key} must be an own data property.`);
  }
  return descriptor.value;
}

type CapturedGraphMethod = (this: object, ...args: unknown[]) => unknown;

function captureGraphMethod(source: object, key: string): CapturedGraphMethod {
  let current: object | null = source;
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`Linear HDR graph ${key} must be a data method.`);
      }
      return descriptor.value as CapturedGraphMethod;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new TypeError(`Linear HDR graph ${key} method is missing or too deep.`);
}

function captureLinearHdrGraph(
  candidate: unknown,
  expectedProfile: Readonly<LinearHdrPipelineProfile>,
  expectedPassSignature: string,
  capturedDispose?: CapturedGraphMethod,
): LinearHdrGraph {
  if ((typeof candidate !== "object" || candidate === null) && typeof candidate !== "function") {
    throw new TypeError("A graph factory must return an object.");
  }
  const source = candidate as object;
  // Capture every callback before the graph enters pipeline ownership. No
  // caller getter is invoked later, and post-return method mutation is inert.
  const dispose = capturedDispose ?? captureGraphMethod(source, "dispose");
  const precompile = captureGraphMethod(source, "precompile");
  const setHistoryWeight = captureGraphMethod(source, "setHistoryWeight");
  const resize = captureGraphMethod(source, "resize");
  const render = captureGraphMethod(source, "render");
  const returnedProfile = ownGraphData(source, "profile");
  if ((typeof returnedProfile !== "object" || returnedProfile === null)) {
    throw new TypeError("A graph factory must return a graph with a profile object.");
  }
  const returnedProfileId = ownGraphData(returnedProfile, "id");
  const returnedPassSignature = ownGraphData(source, "passSignature");
  const depthOwned = ownGraphData(source, "depthOwned");
  const velocityOwned = ownGraphData(source, "velocityOwned");
  const historyOwned = ownGraphData(source, "historyOwned");
  if (returnedProfileId !== expectedProfile.id) {
    throw new TypeError(`A graph factory returned the wrong profile for ${expectedProfile.id}.`);
  }
  if (returnedPassSignature !== expectedPassSignature) {
    throw new TypeError(`A graph factory returned the wrong pass signature for ${expectedProfile.id}.`);
  }
  if (
    depthOwned !== true
    || velocityOwned !== expectedProfile.temporal
    || historyOwned !== expectedProfile.temporal
  ) {
    throw new TypeError(`A graph factory returned inconsistent ownership for ${expectedProfile.id}.`);
  }
  return intrinsicFreeze({
    profile: expectedProfile,
    passSignature: expectedPassSignature,
    depthOwned: true,
    velocityOwned: expectedProfile.temporal,
    historyOwned: expectedProfile.temporal,
    async precompile() {
      const events = await intrinsicReflectApply(precompile, source, []);
      if (!Number.isSafeInteger(events) || (events as number) < 0) {
        throw new TypeError("A Linear HDR graph must report a non-negative safe compile count.");
      }
      return events as number;
    },
    setHistoryWeight(weight: number) {
      return intrinsicReflectApply(setHistoryWeight, source, [weight]) as ReturnType<
        LinearHdrGraph["setHistoryWeight"]
      >;
    },
    resize(viewport: Readonly<RenderViewport>) {
      return intrinsicReflectApply(resize, source, [viewport]) as ReturnType<
        LinearHdrGraph["resize"]
      >;
    },
    render() {
      return intrinsicReflectApply(render, source, []) as ReturnType<LinearHdrGraph["render"]>;
    },
    dispose() {
      return intrinsicReflectApply(dispose, source, []) as ReturnType<LinearHdrGraph["dispose"]>;
    },
  });
}

function assertThreeScenePass(candidate: Readonly<RenderPass>): {
  scene: Object3D;
  camera: Camera;
} {
  const scene = candidate.scene as Partial<Object3D> | null;
  const camera = candidate.camera as Partial<Camera> | null;
  if (!scene || scene.isObject3D !== true || !camera || camera.isCamera !== true) {
    throw new TypeError(`Pipeline pass ${candidate.name} requires a Three.js scene and camera.`);
  }
  return { scene: scene as Object3D, camera: camera as Camera };
}

function captureRenderPipelineConstructorRenderer(renderer: PipelineRenderer): PipelineRenderer {
  const captured: PipelineRenderer = Object.create(null);
  const fields = ["toneMapping", "outputColorSpace"] as const;
  for (let index = 0; index < fields.length; index += 1) {
    const key = fields[index]!;
    const descriptor = Object.getOwnPropertyDescriptor(renderer, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`The Linear HDR renderer ${key} must be an own data property.`);
    }
    Object.defineProperty(captured, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  // RenderPipeline's constructor only snapshots these two fields. Supplying an
  // owned data-only facade prevents a caller Proxy get trap from throwing after
  // the constructor has allocated its internal NodeMaterial/quad.
  intrinsicFreeze(captured);
  return captured;
}

class PendingGraphResources {
  readonly #scenePasses = new Set<ScenePassNode>();
  #pipeline: RenderPipeline | null = null;
  readonly cleanup: GraphCleanupHandle = intrinsicFreeze({
    dispose: () => this.dispose(),
  });

  get hasPending(): boolean {
    return intrinsicReflectApply(intrinsicSetSize, this.#scenePasses, []) > 0
      || this.#pipeline !== null;
  }

  adoptScenePass(scenePass: ScenePassNode): void {
    this.#scenePasses.add(scenePass);
  }

  adoptPipeline(pipeline: RenderPipeline): void {
    if (this.#pipeline !== null) {
      throw new Error("A Linear HDR graph cannot own multiple render pipelines.");
    }
    this.#pipeline = pipeline;
  }

  disposeScenePass(scenePass: ScenePassNode): void {
    if (!this.#scenePasses.has(scenePass)) return;
    scenePass.dispose();
    this.#scenePasses.delete(scenePass);
  }

  dispose(): void {
    const failures: unknown[] = [];
    const scenePasses: ScenePassNode[] = [];
    intrinsicReflectApply(intrinsicSetForEach, this.#scenePasses, [(scenePass: ScenePassNode) => {
      appendArrayValue(scenePasses, scenePass);
    }]);
    for (let index = 0; index < scenePasses.length; index += 1) {
      const scenePass = scenePasses[index]!;
      try {
        this.disposeScenePass(scenePass);
      } catch (error: unknown) {
        appendArrayValue(failures, error);
      }
    }
    if (this.#pipeline) {
      try {
        this.#pipeline.dispose();
        this.#pipeline = null;
      } catch (error: unknown) {
        appendArrayValue(failures, error);
      }
    }
    if (failures.length > 0) {
      throw ownedAggregateError(failures, "Linear HDR graph disposal failed.");
    }
  }
}

class LinearHdrGraphConstructionFailure extends AggregateError {
  readonly cleanup: GraphCleanupHandle;

  constructor(primaryFailure: unknown, cleanup: GraphCleanupHandle) {
    const evidence = ownedAggregateError(
      [primaryFailure],
      "Linear HDR graph construction failed.",
    );
    super(evidence.errors, evidence.message);
    this.name = "LinearHdrGraphConstructionFailure";
    this.cleanup = cleanup;
    intrinsicFreeze(this.errors);
    constructionCleanupByFailure.set(this, cleanup);
    intrinsicFreeze(this);
  }
}

function graphConstructionFailure(
  primaryFailure: unknown,
  resources: PendingGraphResources,
): AggregateError {
  if (!resources.hasPending) {
    return ownedAggregateError([primaryFailure], "Linear HDR graph construction failed.");
  }
  return new LinearHdrGraphConstructionFailure(primaryFailure, resources.cleanup);
}

function constructionCleanup(error: unknown): GraphCleanupHandle | null {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return null;
  return constructionCleanupByFailure.get(error as object) ?? null;
}

function createScenePassNode(
  input: Readonly<{ scene: Object3D; camera: Camera }>,
  viewport: Readonly<RenderViewport>,
  resources: PendingGraphResources,
): ScenePassNode {
  const scenePass = pass(input.scene, input.camera, {
    type: HalfFloatType,
    depthBuffer: true,
    samples: 0,
  });
  resources.adoptScenePass(scenePass);
  scenePass.setSize(
    Math.floor(viewport.width * viewport.pixelRatio),
    Math.floor(viewport.height * viewport.pixelRatio),
  );
  return scenePass;
}

function configureTemporalTarget(scenePass: ScenePassNode): void {
  scenePass.setMRT(mrt({ output, velocity }));
  scenePass.getTextureNode("depth");
  scenePass.getTextureNode("velocity");
}

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve } as const;
}

async function compileScenePassSafely(
  renderer: PipelineRenderer,
  scenePass: ScenePassNode,
): Promise<void> {
  const renderTarget = renderer.getRenderTarget();
  const currentMrt = renderer.getMRT();
  const failures: unknown[] = [];
  try {
    await scenePass.compileAsync(renderer);
  } catch (error: unknown) {
    appendArrayValue(failures, error);
  }
  try {
    renderer.setRenderTarget(renderTarget);
  } catch (error: unknown) {
    appendArrayValue(failures, error);
  }
  try {
    renderer.setMRT(currentMrt);
  } catch (error: unknown) {
    appendArrayValue(failures, error);
  }
  if (failures.length > 0) {
    throw ownedAggregateError(failures, "Linear HDR scene-pass compilation failed.");
  }
}

function cloneMaterialWarmupMesh(candidate: Readonly<RenderPass>): Object3D {
  const { scene } = assertThreeScenePass(candidate);
  let clone: Object3D | null = null;
  scene.traverse((object) => {
    if (clone === null && (object as { isMesh?: boolean }).isMesh === true) {
      clone = object.clone();
      clone.name = `gfx005-runtime-warmup:${candidate.name}:${candidate.variant ?? "absent"}`;
      clone.frustumCulled = false;
    }
  });
  if (clone === null) {
    throw new TypeError(`Material warm-up pass ${candidate.name} must contain a mesh.`);
  }
  return clone;
}

async function compileMaterialInRuntimeTopologies(
  renderer: PipelineRenderer,
  topologies: readonly RuntimeSceneTopology[],
  candidate: Readonly<RenderPass>,
): Promise<void> {
  const failures: unknown[] = [];
  for (let index = 0; index < topologies.length; index += 1) {
    const topology = topologies[index]!;
    let clone: Object3D | null = null;
    try {
      clone = cloneMaterialWarmupMesh(candidate);
      topology.scene.add(clone);
      await compileScenePassSafely(renderer, topology.scenePass);
    } catch (error: unknown) {
      appendArrayValue(failures, error);
    } finally {
      if (clone?.parent === topology.scene) {
        try {
          topology.scene.remove(clone);
        } catch (error: unknown) {
          appendArrayValue(failures, error);
        }
      }
    }
  }
  if (failures.length > 0) {
    throw ownedAggregateError(failures, "Runtime material topology warm-up failed.");
  }
}

class ThreeLinearHdrGraph implements LinearHdrGraph {
  readonly profile: Readonly<LinearHdrPipelineProfile>;
  readonly passSignature: string;
  readonly depthOwned = true as const;
  readonly velocityOwned: boolean;
  readonly historyOwned: boolean;
  readonly #renderer: PipelineRenderer;
  #pipeline: RenderPipeline | null;
  readonly #resources: PendingGraphResources;
  readonly #scenePasses: ScenePassNode[];
  #runtimeTopologies: readonly RuntimeSceneTopology[];
  readonly #historyWeight = uniform(0);
  #viewport: Readonly<RenderViewport>;
  #materialWarmupPasses: readonly Readonly<RenderPass>[];
  #disposeRequested = false;
  #disposed = false;

  constructor(context: Readonly<LinearHdrGraphFactoryContext>) {
    this.profile = context.profile;
    this.passSignature = context.passSignature;
    this.velocityOwned = context.profile.temporal;
    this.historyOwned = context.profile.temporal;
    this.#renderer = context.renderer as PipelineRenderer;
    this.#viewport = captureViewport(context.viewport);
    let capturedPasses: readonly Readonly<{ scene: Object3D; camera: Camera }>[];
    let materialWarmupPasses: readonly Readonly<RenderPass>[];
    let constructorRenderer: PipelineRenderer;
    try {
      const captured: Readonly<{ scene: Object3D; camera: Camera }>[] = [];
      for (let index = 0; index < context.passes.length; index += 1) {
        appendArrayValue(captured, intrinsicFreeze({
          ...assertThreeScenePass(context.passes[index]!),
        }));
      }
      capturedPasses = intrinsicFreeze(captured);
      if (capturedPasses.length === 0) {
        throw new Error("A Linear HDR graph requires at least one drawable scene pass.");
      }
      constructorRenderer = captureRenderPipelineConstructorRenderer(this.#renderer);
      const materials: Readonly<RenderPass>[] = [];
      for (let index = 0; index < context.materialWarmupPasses.length; index += 1) {
        appendArrayValue(materials, context.materialWarmupPasses[index]!);
      }
      materialWarmupPasses = intrinsicFreeze(materials);
    } catch (error: unknown) {
      throw ownedAggregateError([error], "Linear HDR graph construction failed.");
    }
    const resources = new PendingGraphResources();
    const scenePasses: ScenePassNode[] = [];
    const runtimeTopologies: RuntimeSceneTopology[] = [];
    let renderPipeline: RenderPipeline | null = null;
    try {
      // Construct the output pipeline before any render target. A constructor
      // failure therefore cannot strand a scene-pass target, while successful
      // acquisition is registered before any later configuration can throw.
      assertRenderPipelineConstructorTopology();
      renderPipeline = new RenderPipeline(constructorRenderer);
      resources.adoptPipeline(renderPipeline);
      renderPipeline.renderer = this.#renderer;
      renderPipeline.outputColorTransform = false;
      for (let index = 0; index < capturedPasses.length; index += 1) {
        const captured = capturedPasses[index]!;
        const scenePass = createScenePassNode(captured, this.#viewport, resources);
        appendArrayValue(scenePasses, scenePass);
        appendArrayValue(runtimeTopologies, intrinsicFreeze({
          scene: captured.scene,
          scenePass,
        }));
      }
      const primary = scenePasses[0]!;
      let composite: Node<"vec4"> = primary;
      if (context.profile.temporal) {
        configureTemporalTarget(primary);
        const velocityTexture = primary.getTextureNode("velocity");
        const historyTexture = primary.getPreviousTextureNode("output");
        const historyUv = screenUV.sub(velocityTexture.xy.mul(vec2(0.5, -0.5)));
        composite = mix(primary, historyTexture.sample(historyUv), this.#historyWeight);
      }
      for (let index = 1; index < scenePasses.length; index += 1) {
        const layer = scenePasses[index]!;
        composite = mix(composite, layer, layer.a);
      }
      // This is the only output transform in production v2. RenderPipeline's
      // automatic transform is disabled so ACES and sRGB cannot be applied twice.
      const transformed = renderOutput(composite, ACESFilmicToneMapping, SRGBColorSpace);
      // Three's TSL FXAA consumes display-referred sRGB, so it follows the one
      // explicit output transform while RenderPipeline's implicit transform
      // remains disabled.
      const finalOutput = context.profile.temporal
        ? transformed
        : fxaa(transformed) as unknown as Node<"vec4">;
      renderPipeline.outputNode = finalOutput;
      renderPipeline.needsUpdate = true;
      this.#scenePasses = scenePasses;
      this.#resources = resources;
      this.#runtimeTopologies = intrinsicFreeze(runtimeTopologies);
      this.#pipeline = renderPipeline;
      this.#materialWarmupPasses = materialWarmupPasses;
    } catch (error: unknown) {
      throw graphConstructionFailure(error, resources);
    }
  }

  async precompile(): Promise<number> {
    this.#assertLive();
    let events = 0;
    for (let index = 0; index < this.#scenePasses.length; index += 1) {
      const scenePass = this.#scenePasses[index]!;
      await compileScenePassSafely(this.#renderer, scenePass);
      events += 1;
    }
    const materialInventory = this.#materialWarmupPasses;
    this.#materialWarmupPasses = intrinsicFreeze([]);
    for (let index = 0; index < materialInventory.length; index += 1) {
      const candidate = materialInventory[index]!;
      let temporaryPass: ScenePassNode | null = null;
      const failures: unknown[] = [];
      try {
        temporaryPass = createScenePassNode(
          assertThreeScenePass(candidate),
          this.#viewport,
          this.#resources,
        );
        if (this.profile.temporal) configureTemporalTarget(temporaryPass);
        await compileScenePassSafely(this.#renderer, temporaryPass);
        events += 1;
        await compileMaterialInRuntimeTopologies(
          this.#renderer,
          this.#runtimeTopologies,
          candidate,
        );
        events += this.#runtimeTopologies.length;
      } catch (error: unknown) {
        appendArrayValue(failures, error);
      } finally {
        if (temporaryPass) {
          try {
            this.#resources.disposeScenePass(temporaryPass);
          } catch (error: unknown) {
            appendArrayValue(failures, error);
          }
        }
      }
      if (failures.length > 0) {
        throw ownedAggregateError(failures, "Material topology warm-up failed.");
      }
    }
    this.#historyWeight.value = 0;
    this.#pipeline!.render();
    return events + 1;
  }

  setHistoryWeight(weight: number): void {
    this.#assertLive();
    this.#historyWeight.value = weight;
  }

  resize(viewport: Readonly<RenderViewport>): void {
    this.#assertLive();
    this.#viewport = viewport;
    const width = Math.floor(viewport.width * viewport.pixelRatio);
    const height = Math.floor(viewport.height * viewport.pixelRatio);
    for (let index = 0; index < this.#scenePasses.length; index += 1) {
      this.#scenePasses[index]!.setSize(width, height);
    }
  }

  render(): void {
    this.#assertLive();
    this.#pipeline!.render();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposeRequested = true;
    this.#materialWarmupPasses = intrinsicFreeze([]);
    this.#runtimeTopologies = intrinsicFreeze([]);
    this.#resources.dispose();
    this.#scenePasses.length = 0;
    this.#pipeline = null;
    this.#disposed = true;
  }

  #assertLive(): void {
    if (this.#disposeRequested || this.#disposed) {
      throw new Error("The Linear HDR graph is disposing or disposed.");
    }
  }
}

export const createThreeLinearHdrGraph: LinearHdrGraphFactory = (context) => (
  new ThreeLinearHdrGraph(context)
);

type PendingResizeTransaction = {
  readonly viewport: Readonly<RenderViewport>;
  readonly completedProfileIds: Set<LinearHdrPipelineProfileId>;
};

export class ProductionLinearHdrPipeline implements LinearHdrPipelineFeature {
  readonly id = "gfx005-linear-hdr-pipeline" as const;
  readonly #graphFactory: LinearHdrGraphFactory;
  readonly #history: TemporalHistoryOwner;
  readonly #graphs = new Map<LinearHdrPipelineProfileId, LinearHdrGraph>();
  readonly #invalidGraphCleanup = new Set<GraphCleanupHandle>();
  readonly #graphSources = new WeakSet<object>();
  readonly #identities = new WeakMap<object, number>();
  readonly #nextIdentity = { value: 1 };
  #state: LinearHdrPipelineSnapshot["state"] = "new";
  #renderer: unknown = null;
  #actualApi: RendererApi | null = null;
  #viewport: Readonly<RenderViewport> | null = null;
  #activeProfile: Readonly<LinearHdrPipelineProfile> | null = null;
  #warmedSignature: string | null = null;
  #warmedMaterialSignature: string | null = null;
  #compileEvents = 0;
  #compileEventsAtReady: number | null = null;
  #runtimeCompileEvents = 0;
  #programCountAtReady: number | null = null;
  #programGrowthAfterReady = 0;
  #disposedGraphs = 0;
  #disposePromise: Promise<void> | null = null;
  #disposeRequested = false;
  #activeOperations = 0;
  #operationDrain: ReturnType<typeof deferredVoid> | null = null;
  #pendingResize: PendingResizeTransaction | null = null;
  #externalGraphCallbackDepth = 0;
  #exclusiveOperation:
    | "attach"
    | "history"
    | "precompile"
    | "quality"
    | "resize"
    | "submit"
    | null = null;

  constructor(options: CreateLinearHdrPipelineOptions = {}) {
    this.#graphFactory = options.graphFactory ?? createThreeLinearHdrGraph;
    this.#history = new TemporalHistoryOwner(options.temporalHistoryWeight);
  }

  attachBackend(
    renderer: unknown,
    actualApi: "webgpu" | "webgl2",
    viewport: Readonly<RenderViewport>,
  ): void {
    // Publish exclusive admission before inspecting any caller-owned value.
    // A viewport accessor can reenter every public mutator, including attach
    // and disposal, so no backend/history field may be committed before the
    // capture and post-capture lifecycle gate both complete.
    const release = this.#beginOperation("attach a backend", "attach");
    try {
      if (this.#state !== "new") {
        throw new Error(`Cannot attach a backend while the Linear HDR pipeline is ${this.#state}.`);
      }
      if ((typeof renderer !== "object" || renderer === null) && typeof renderer !== "function") {
        throw new TypeError("The Linear HDR pipeline requires a renderer object.");
      }
      if (actualApi !== "webgpu" && actualApi !== "webgl2") {
        throw new TypeError("The Linear HDR pipeline requires a recognized backend API.");
      }
      const capturedRenderer = renderer;
      const capturedApi: RendererApi = actualApi === "webgpu" ? "WebGPU" : "WebGL2";
      const capturedViewport = captureViewport(viewport);
      const capturedProfile = profileCatalog[
        capturedApi === "WebGPU" ? "webgpu-balanced-temporal" : "webgl2-balanced-static"
      ];
      if (this.#disposeRequested) {
        throw new Error("Cannot attach a backend after Linear HDR pipeline disposal was requested.");
      }
      if (this.#state !== "new") {
        throw new Error(`Cannot attach a backend while the Linear HDR pipeline is ${this.#state}.`);
      }
      if (this.#activeOperations !== 1 || this.#exclusiveOperation !== "attach") {
        throw new Error("Cannot attach a backend after its exclusive admission was lost.");
      }
      this.#history.initialize(capturedViewport);
      this.#renderer = capturedRenderer;
      this.#actualApi = capturedApi;
      this.#viewport = capturedViewport;
      this.#activeProfile = capturedProfile;
      this.#state = "attached";
    } finally {
      release();
    }
  }

  initialize(context: FeatureInitContext): Promise<void>;
  async initialize(): Promise<void> {
    if (this.#state !== "attached") {
      throw new Error(`Cannot initialize the pipeline feature while ${this.#state}.`);
    }
  }

  warmupPasses(profiles: readonly Readonly<RenderQualityProfile>[]): readonly RenderPass[];
  warmupPasses(): readonly RenderPass[] {
    if (this.#state !== "attached") {
      throw new Error(`Cannot describe pipeline warm-up while ${this.#state}.`);
    }
    return intrinsicFreeze([]);
  }

  update(frame: JourneyRenderSnapshot, clock: VisualClock): void;
  update(): void {}

  render(recorder: RenderPassRecorder): void;
  render(): void {}

  quality(profile: Readonly<RenderQualityProfile>): void {
    if (this.#externalGraphCallbackDepth !== 0) {
      throw new Error("Cannot select pipeline quality reentrantly from a graph callback.");
    }
    const release = this.#beginOperation("select pipeline quality", "quality");
    try {
      if (this.#state !== "attached" && this.#state !== "warming" && this.#state !== "ready") {
        throw new Error(`Cannot select pipeline quality while ${this.#state}.`);
      }
      this.#assertNoIncompleteResize("select pipeline quality");
      const candidate = selectLinearHdrPipelineProfile(this.#actualApi!, profile);
      if (this.#disposeRequested) {
        throw new Error("Cannot select pipeline quality after disposal was requested.");
      }
      if (this.#state !== "attached" && this.#state !== "warming" && this.#state !== "ready") {
        throw new Error(`Cannot select pipeline quality while ${this.#state}.`);
      }
      this.#assertNoIncompleteResize("select pipeline quality");
      if (this.#state === "ready" && !this.#graphs.has(candidate.id)) {
        throw new Error(`Pipeline profile ${candidate.id} was not warmed before ready.`);
      }
      this.#activeProfile = candidate;
    } finally {
      release();
    }
  }

  invalidateHistory(event: Readonly<RenderHistoryInvalidation>): void {
    if (this.#externalGraphCallbackDepth !== 0) {
      throw new Error("Cannot invalidate pipeline history reentrantly from a graph callback.");
    }
    if (this.#state === "disposed" || this.#state === "disposing" || this.#state === "failed") return;
    const release = this.#beginOperation("invalidate pipeline history", "history");
    try {
      if (this.#state !== "attached" && this.#state !== "warming" && this.#state !== "ready") {
        throw new Error(`Cannot invalidate pipeline history while ${this.#state}.`);
      }
      this.#assertNoIncompleteResize("invalidate pipeline history");
      const reason = event.reason;
      if (this.#disposeRequested) {
        throw new Error("Cannot invalidate pipeline history after disposal was requested.");
      }
      if (this.#state !== "attached" && this.#state !== "warming" && this.#state !== "ready") {
        throw new Error(`Cannot invalidate pipeline history while ${this.#state}.`);
      }
      if (this.#activeOperations !== 1 || this.#exclusiveOperation !== "history") {
        throw new Error("Cannot invalidate pipeline history after its exclusive admission was lost.");
      }
      this.#assertNoIncompleteResize("invalidate pipeline history");
      this.#history.invalidate(reason);
    } finally {
      release();
    }
  }

  async resize(viewport: Readonly<RenderViewport>): Promise<void> {
    if (this.#externalGraphCallbackDepth !== 0) {
      throw new Error("Cannot resize the Linear HDR pipeline reentrantly from a graph callback.");
    }
    const release = this.#beginResizeOperation();
    try {
      if (this.#state !== "attached" && this.#state !== "warming" && this.#state !== "ready") {
        throw new Error(`Cannot resize the Linear HDR pipeline while ${this.#state}.`);
      }
      const next = captureViewport(viewport);
      if (this.#disposeRequested) {
        throw new Error("Cannot resize after Linear HDR pipeline disposal was requested.");
      }
      if (this.#state !== "attached" && this.#state !== "warming" && this.#state !== "ready") {
        throw new Error(`Cannot resize the Linear HDR pipeline while ${this.#state}.`);
      }
      if (this.#activeOperations !== 1) {
        throw new Error(
          "Cannot resize while another Linear HDR pipeline operation started during viewport capture.",
        );
      }
      let transaction = this.#pendingResize;
      if (transaction) {
        if (!sameViewport(transaction.viewport, next)) {
          throw new Error(
            "Cannot change the Linear HDR resize target while a prior resize is incomplete.",
          );
        }
      } else {
        if (sameViewport(this.#viewport!, next)) return;
        transaction = {
          viewport: next,
          completedProfileIds: new Set<LinearHdrPipelineProfileId>(),
        };
        this.#pendingResize = transaction;
      }
      const graphEntries: Array<readonly [LinearHdrPipelineProfileId, LinearHdrGraph]> = [];
      intrinsicReflectApply(intrinsicMapForEach, this.#graphs, [(
        graph: LinearHdrGraph,
        profileId: LinearHdrPipelineProfileId,
      ) => {
        appendArrayValue(graphEntries, [profileId, graph] as const);
      }]);
      for (let index = 0; index < graphEntries.length; index += 1) {
        const entry = graphEntries[index]!;
        const profileId = entry[0];
        const graph = entry[1];
        if (transaction.completedProfileIds.has(profileId)) continue;
        await this.#invokeGraphCallback(() => graph.resize(transaction.viewport));
        transaction.completedProfileIds.add(profileId);
      }
      if (!this.#history.resize(transaction.viewport)) {
        throw new Error("A completed Linear HDR resize did not advance temporal history.");
      }
      this.#viewport = transaction.viewport;
      if (this.#pendingResize === transaction) this.#pendingResize = null;
    } finally {
      release();
    }
  }

  async precompile(passes: readonly Readonly<RenderPass>[]): Promise<void> {
    if (this.#externalGraphCallbackDepth !== 0) {
      throw new Error("Cannot precompile the Linear HDR pipeline reentrantly from a graph callback.");
    }
    // Pass arrays and pass records are caller-owned. Publish exclusive
    // admission before filter/iterator/property access so a hostile getter
    // cannot start a nested frame or quality/history transaction.
    const release = this.#beginOperation("precompile", "precompile");
    try {
      this.#assertNoIncompleteResize("precompile the Linear HDR pipeline");
      if (this.#state !== "attached" && this.#state !== "ready") {
        throw new Error(`Cannot precompile the Linear HDR pipeline while ${this.#state}.`);
      }
      const admittedState = this.#state;
      let capturedPasses: readonly Readonly<RenderPass>[];
      try {
        capturedPasses = capturePipelinePasses(passes);
      } catch (error: unknown) {
        if (admittedState === "attached") {
          throw ownedAggregateError([error], "Linear HDR pipeline warm-up failed.");
        }
        throw error;
      }
      this.#assertExclusiveOperation("precompile", admittedState);
      this.#assertNoIncompleteResize("precompile the Linear HDR pipeline");
      await this.#performPrecompile(capturedPasses);
    } finally {
      release();
    }
  }

  async #performPrecompile(passes: readonly Readonly<RenderPass>[]): Promise<void> {
    if (this.#state === "ready") {
      const signature = passSignature(drawablePasses(passes), this.#identities, this.#nextIdentity);
      const materialSignature = passSignature(
        materialWarmupPasses(passes),
        this.#identities,
        this.#nextIdentity,
      );
      this.#assertExclusiveOperation("precompile", "ready");
      if (
        signature !== this.#warmedSignature
        || materialSignature !== this.#warmedMaterialSignature
      ) {
        throw new Error("A post-ready pipeline precompile attempted an unwarmed pass graph.");
      }
      return;
    }
    if (this.#state !== "attached") {
      throw new Error(`Cannot precompile the Linear HDR pipeline while ${this.#state}.`);
    }
    this.#state = "warming";
    try {
      const materialInventory = materialWarmupPasses(passes);
      const runtimePasses = drawablePasses(passes);
      if (runtimePasses.length === 0) {
        throw new Error("Pipeline warm-up requires at least one non-material drawable pass.");
      }
      const signature = passSignature(runtimePasses, this.#identities, this.#nextIdentity);
      const materialSignature = passSignature(
        materialInventory,
        this.#identities,
        this.#nextIdentity,
      );
      this.#assertExclusiveOperation("precompile", "warming");
      const profiles = profilesForApi(this.#actualApi!);
      for (let profileIndex = 0; profileIndex < profiles.length; profileIndex += 1) {
        const profile = profiles[profileIndex]!;
        let graphSource: LinearHdrGraph;
        try {
          graphSource = this.#graphFactory(intrinsicFreeze({
            renderer: this.#renderer,
            profile,
            materialWarmupPasses: materialInventory,
            passes: runtimePasses,
            passSignature: signature,
            viewport: this.#viewport!,
          }));
        } catch (factoryError: unknown) {
          const cleanup = constructionCleanup(factoryError);
          if (cleanup) this.#invalidGraphCleanup.add(cleanup);
          throw factoryError;
        }
        if (
          (typeof graphSource !== "object" || graphSource === null)
          && typeof graphSource !== "function"
        ) {
          throw new TypeError("A graph factory must return an object.");
        }
        if (this.#graphSources.has(graphSource as object)) {
          throw new Error("A graph factory returned the same graph identity for multiple profiles.");
        }
        const source = graphSource as object;
        const disposeMethod = captureGraphMethod(source, "dispose");
        let graph: LinearHdrGraph;
        try {
          graph = captureLinearHdrGraph(graphSource, profile, signature, disposeMethod);
        } catch (validationError: unknown) {
          const cleanup = intrinsicFreeze({
            dispose: () => intrinsicReflectApply(disposeMethod, source, []) as ReturnType<
              LinearHdrGraph["dispose"]
            >,
          });
          this.#invalidGraphCleanup.add(cleanup);
          throw ownedAggregateError([validationError], "Invalid Linear HDR graph rejected.");
        }
        this.#graphSources.add(graphSource as object);
        this.#graphs.set(profile.id, graph);
        this.#compileEvents += await this.#invokeGraphCallback(() => graph.precompile());
      }
      this.#warmedSignature = signature;
      this.#warmedMaterialSignature = materialSignature;
      this.#compileEventsAtReady = this.#compileEvents;
      this.#programCountAtReady = rendererPrograms(this.#renderer);
      if (!this.#disposeRequested) this.#state = "ready";
    } catch (error: unknown) {
      this.#state = "failed";
      const failures: unknown[] = [error];
      try {
        await this.#disposeGraphs();
      } catch (cleanupError: unknown) {
        appendArrayValue(failures, cleanupError);
      }
      throw ownedAggregateError(failures, "Linear HDR pipeline warm-up failed.");
    }
  }

  async submit(passes: readonly Readonly<RenderPass>[]): Promise<void> {
    if (this.#externalGraphCallbackDepth !== 0) {
      throw new Error("Cannot submit a Linear HDR frame reentrantly from a graph callback.");
    }
    // A frame owns history validity and graph rendering. Reserve it before any
    // caller-owned pass-array or pass-field access so nested work cannot win
    // admission while the outer frame is still being described.
    const release = this.#beginOperation("submit", "submit");
    try {
      this.#assertNoIncompleteResize("submit a Linear HDR frame");
      if (this.#state !== "ready") {
        throw new Error(`Cannot submit a Linear HDR frame while ${this.#state}.`);
      }
      const capturedPasses = capturePipelinePasses(passes);
      this.#assertExclusiveOperation("submit", "ready");
      this.#assertNoIncompleteResize("submit a Linear HDR frame");
      await this.#performSubmit(capturedPasses);
    } finally {
      release();
    }
  }

  async #performSubmit(passes: readonly Readonly<RenderPass>[]): Promise<void> {
    if (this.#state !== "ready") {
      throw new Error(`Cannot submit a Linear HDR frame while ${this.#state}.`);
    }
    const runtimePasses = drawablePasses(passes);
    const signature = passSignature(runtimePasses, this.#identities, this.#nextIdentity);
    this.#assertExclusiveOperation("submit", "ready");
    this.#assertNoIncompleteResize("submit a Linear HDR frame");
    if (signature !== this.#warmedSignature) {
      throw new Error("A runtime Linear HDR frame did not match the warmed pass graph.");
    }
    const graph = this.#graphs.get(this.#activeProfile!.id);
    if (!graph) throw new Error(`Pipeline profile ${this.#activeProfile!.id} was not warmed.`);
    const frame = this.#history.beginFrame();
    let success = false;
    try {
      await this.#invokeGraphCallback(
        () => graph.setHistoryWeight(this.#activeProfile!.temporal ? frame.blendWeight : 0),
      );
      await this.#invokeGraphCallback(() => graph.render());
      const programs = rendererPrograms(this.#renderer);
      if (
        programs !== null
        && this.#programCountAtReady !== null
        && programs > this.#programCountAtReady
      ) {
        this.#programGrowthAfterReady = Math.max(
          this.#programGrowthAfterReady,
          programs - this.#programCountAtReady,
        );
        throw new Error("Renderer program count grew after the Linear HDR pipeline became ready.");
      }
      success = true;
    } finally {
      this.#history.completeFrame(success);
    }
  }

  snapshot(): Readonly<LinearHdrPipelineSnapshot> {
    const history = this.#history.snapshot();
    const active = this.#activeProfile;
    const warmedProfileIds: LinearHdrPipelineProfileId[] = [];
    let velocityOwned = false;
    let historyOwned = false;
    intrinsicReflectApply(intrinsicMapForEach, this.#graphs, [(
      graph: LinearHdrGraph,
      profileId: LinearHdrPipelineProfileId,
    ) => {
      appendArrayValue(warmedProfileIds, profileId);
      velocityOwned ||= graph.velocityOwned;
      historyOwned ||= graph.historyOwned;
    }]);
    const graphCount = intrinsicReflectApply(intrinsicMapSize, this.#graphs, []);
    const invalidGraphCleanupCount = intrinsicReflectApply(
      intrinsicSetSize,
      this.#invalidGraphCleanup,
      [],
    );
    return intrinsicFreeze({
      state: this.#state,
      actualApi: this.#actualApi,
      activeProfileId: active?.id ?? null,
      warmedProfileIds: intrinsicFreeze(warmedProfileIds),
      graphCount,
      compileEvents: this.#compileEvents,
      compileEventsAtReady: this.#compileEventsAtReady,
      runtimeCompileEvents: this.#runtimeCompileEvents,
      programCountAtReady: this.#programCountAtReady,
      programGrowthAfterReady: this.#programGrowthAfterReady,
      outputTransformCount: graphCount > 0 ? 1 : 0,
      intermediateType: "half-float",
      depthOwned: graphCount > 0,
      velocityOwned,
      historyOwned,
      historyGeneration: history.generation,
      historyValid: history.valid,
      pendingHistoryResets: history.pendingReasons,
      historyResetCounts: history.resetCounts,
      disposedGraphs: this.#disposedGraphs,
      cleanupPendingGraphs: this.#state === "failed" || this.#state === "disposing"
        ? graphCount + invalidGraphCleanupCount
        : 0,
    });
  }

  dispose(): Promise<void> {
    if (this.#externalGraphCallbackDepth !== 0) {
      return Promise.reject(new Error(
        "Cannot dispose the Linear HDR pipeline reentrantly from a graph callback.",
      ));
    }
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposeRequested = true;
    const attempt = this.#performDispose().catch((error: unknown) => {
      // Concurrent callers share one attempt, but a rejected attempt must not
      // permanently strand a cleanup obligation. Only a successful terminal
      // disposal remains memoized for later idempotent calls.
      if (this.#disposePromise === attempt) this.#disposePromise = null;
      throw error;
    });
    this.#disposePromise = attempt;
    return attempt;
  }

  async #performDispose(): Promise<void> {
    if (this.#state === "disposed") return;
    this.#state = "disposing";
    await this.#waitForOperations();
    this.#state = "disposing";
    this.#pendingResize = null;
    const failures: unknown[] = [];
    try {
      await this.#disposeGraphs();
    } catch (error: unknown) {
      appendArrayValue(failures, error);
    }
    this.#history.dispose();
    this.#renderer = null;
    this.#viewport = null;
    this.#state = failures.length === 0 ? "disposed" : "failed";
    if (failures.length > 0) {
      throw ownedAggregateError(failures, "Linear HDR pipeline disposal failed.");
    }
  }

  async #disposeGraphs(): Promise<void> {
    const failures: unknown[] = [];
    const graphs: Array<readonly [LinearHdrPipelineProfileId, LinearHdrGraph]> = [];
    intrinsicReflectApply(intrinsicMapForEach, this.#graphs, [(
      graph: LinearHdrGraph,
      profileId: LinearHdrPipelineProfileId,
    ) => {
      appendArrayValue(graphs, [profileId, graph] as const);
    }]);
    for (let index = 0; index < graphs.length; index += 1) {
      const entry = graphs[index]!;
      const profileId = entry[0];
      const graph = entry[1];
      try {
        await this.#invokeGraphCallback(() => graph.dispose());
        if (this.#graphs.get(profileId) === graph) this.#graphs.delete(profileId);
        this.#disposedGraphs += 1;
      } catch (error: unknown) {
        appendArrayValue(failures, error);
      }
    }
    const cleanupHandles: GraphCleanupHandle[] = [];
    intrinsicReflectApply(intrinsicSetForEach, this.#invalidGraphCleanup, [(
      cleanup: GraphCleanupHandle,
    ) => {
      appendArrayValue(cleanupHandles, cleanup);
    }]);
    for (let index = 0; index < cleanupHandles.length; index += 1) {
      const cleanup = cleanupHandles[index]!;
      try {
        await this.#invokeGraphCallback(() => cleanup.dispose());
        this.#invalidGraphCleanup.delete(cleanup);
      } catch (error: unknown) {
        appendArrayValue(failures, error);
      }
    }
    if (failures.length > 0) {
      throw ownedAggregateError(failures, "Linear HDR graph disposal failed.");
    }
  }

  #beginOperation(
    operation: string,
    exclusive:
      | "attach"
      | "history"
      | "precompile"
      | "quality"
      | "resize"
      | "submit"
      | null = null,
  ): () => void {
    if (this.#disposeRequested) {
      throw new Error(`Cannot ${operation} after Linear HDR pipeline disposal was requested.`);
    }
    if (exclusive !== null) {
      if (this.#activeOperations !== 0) {
        if (exclusive === "quality" && this.#pendingResize !== null) {
          throw new Error("Cannot select pipeline quality while a Linear HDR resize is incomplete.");
        }
        if (this.#exclusiveOperation === "resize") {
          if (this.#pendingResize !== null) {
            throw new Error(`Cannot ${operation} while a Linear HDR resize is incomplete.`);
          }
          throw new Error(`Cannot ${operation} while pipeline resize is active.`);
        }
        throw new Error(`Cannot ${operation} while another Linear HDR pipeline operation is active.`);
      }
      this.#exclusiveOperation = exclusive;
    } else if (this.#exclusiveOperation !== null) {
      if (this.#exclusiveOperation === "resize" && this.#pendingResize !== null) {
        throw new Error(`Cannot ${operation} while a Linear HDR resize is incomplete.`);
      }
      throw new Error(`Cannot ${operation} while pipeline ${this.#exclusiveOperation} is active.`);
    }
    this.#activeOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (exclusive !== null && this.#exclusiveOperation === exclusive) {
        this.#exclusiveOperation = null;
      }
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0 && this.#operationDrain) {
        const drain = this.#operationDrain;
        this.#operationDrain = null;
        drain.resolve();
      }
    };
  }

  #invokeGraphCallback<T>(callback: () => T): T {
    this.#externalGraphCallbackDepth += 1;
    try {
      return callback();
    } finally {
      this.#externalGraphCallbackDepth -= 1;
    }
  }

  #beginResizeOperation(): () => void {
    if (this.#disposeRequested) {
      throw new Error("Cannot resize after Linear HDR pipeline disposal was requested.");
    }
    if (this.#activeOperations !== 0) {
      throw new Error("Cannot resize while another Linear HDR pipeline operation is active.");
    }
    return this.#beginOperation("resize", "resize");
  }

  #assertNoIncompleteResize(operation: string): void {
    if (this.#pendingResize !== null) {
      throw new Error(`Cannot ${operation} while a Linear HDR resize is incomplete.`);
    }
  }

  #assertExclusiveOperation(
    exclusive: "precompile" | "submit",
    expectedState: "attached" | "ready" | "warming",
  ): void {
    if (this.#disposeRequested) {
      throw new Error(`Cannot ${exclusive} after Linear HDR pipeline disposal was requested.`);
    }
    if (this.#state !== expectedState) {
      throw new Error(`Cannot ${exclusive} the Linear HDR pipeline while ${this.#state}.`);
    }
    if (this.#activeOperations !== 1 || this.#exclusiveOperation !== exclusive) {
      throw new Error(`Cannot ${exclusive} after its exclusive admission was lost.`);
    }
  }

  #waitForOperations(): Promise<void> {
    if (this.#activeOperations === 0) return Promise.resolve();
    this.#operationDrain ??= deferredVoid();
    return this.#operationDrain.promise;
  }
}

export function createLinearHdrPipeline(
  options: CreateLinearHdrPipelineOptions = {},
): LinearHdrPipelineFeature {
  return new ProductionLinearHdrPipeline(options);
}
