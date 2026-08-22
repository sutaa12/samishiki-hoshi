import {
  ACESFilmicToneMapping,
  ColorManagement,
  HalfFloatType,
  Mesh,
  NoToneMapping,
  NodeUpdateType,
  Object3D,
  PassNode,
  REVISION,
  RenderPipeline,
  SRGBColorSpace,
  type Camera,
  type Node,
  type BufferGeometry,
  type Material,
  type Scene,
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
  RenderCompileStepDescriptor,
  RenderCompileStepPhase,
  RenderCompileStepRunner,
  RenderHistoryInvalidation,
  RenderOperationClock,
  RenderPass,
  RenderPassRecorder,
  RenderPrecompileReceipt,
  RenderQualityProfile,
  RenderViewport,
  RendererApi,
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
  readonly scene: Scene;
  readonly camera: Camera;
  readonly renderTarget: unknown;
  readonly mrt: unknown;
  readonly transparent: boolean;
  readonly opaque: boolean;
  readonly drawables: readonly Object3D[];
  readonly passSource: object;
  readonly passUpdateBeforeType: Readonly<PropertyDescriptor>;
  updatePass(renderer: object): void;
}>;

type CapturedRendererOperations = Readonly<{
  getRenderTarget(): unknown;
  getMRT(): unknown;
  setRenderTarget(target: unknown): void;
  setMRT(mrt: unknown): void;
  getOutputRenderTarget(): unknown;
  getDrawingBufferSize(target: unknown): unknown;
  compileAsync(object: Object3D, camera: Camera, targetScene?: Scene): Promise<void>;
  render(scene: Scene, camera: Camera): void;
}>;

type OutputFirstUseTopology = Readonly<{
  readonly quad: Object3D;
  readonly camera: Camera;
  update(): void;
  render(): void;
}>;

type MaterialWarmupTopology = Readonly<{
  readonly pass: Readonly<RenderPass>;
  readonly drawable: Object3D;
}>;

type CapturedLinearHdrGraph = LinearHdrGraph & Readonly<{
  readonly compilePlan: readonly Readonly<RenderCompileStepDescriptor>[];
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
const intrinsicNumberIsInteger = Number.isInteger;
const intrinsicNumberIsSafeInteger = Number.isSafeInteger;
const intrinsicObject3DAdd = Object3D.prototype.add;
const intrinsicObject3DRemove = Object3D.prototype.remove;
const intrinsicReflectApply = Reflect.apply;
const intrinsicSetAdd = Set.prototype.add;
const intrinsicSetForEach = Set.prototype.forEach;
const intrinsicSetHas = Set.prototype.has;
const intrinsicSetSize = intrinsicGetOwnPropertyDescriptor(Set.prototype, "size")!.get!;
const intrinsicStringCharCodeAt = String.prototype.charCodeAt;
const intrinsicWeakSetAdd = WeakSet.prototype.add;
const intrinsicWeakSetHas = WeakSet.prototype.has;
const intrinsicWeakMapGet = WeakMap.prototype.get;
const intrinsicWeakMapSet = WeakMap.prototype.set;
const auditedRenderPipelineRender = intrinsicGetOwnPropertyDescriptor(
  RenderPipeline.prototype,
  "render",
)?.value;
const auditedRenderPipelineUpdate = intrinsicGetOwnPropertyDescriptor(
  RenderPipeline.prototype,
  "_update",
)?.value;
const auditedPassNodeUpdateBefore = intrinsicGetOwnPropertyDescriptor(
  PassNode.prototype,
  "updateBefore",
)?.value;
const auditedWorkingColorSpace = ColorManagement.workingColorSpace;

function compilePhaseCounts(): Record<RenderCompileStepPhase, number> {
  return {
    "runtime-object": 0,
    "material-isolated": 0,
    "material-runtime-topology": 0,
    "output-first-use": 0,
  };
}

function compileReceipt(
  plannedSteps: number,
  completedSteps: number,
  phaseCounts: Readonly<Record<RenderCompileStepPhase, number>>,
): Readonly<RenderPrecompileReceipt> {
  return intrinsicFreeze({
    plannedSteps,
    completedSteps,
    phaseCounts: intrinsicFreeze({
      "runtime-object": phaseCounts["runtime-object"],
      "material-isolated": phaseCounts["material-isolated"],
      "material-runtime-topology": phaseCounts["material-runtime-topology"],
      "output-first-use": phaseCounts["output-first-use"],
    }),
  });
}

function compileDescriptor(
  profileId: LinearHdrPipelineProfileId,
  phase: RenderCompileStepPhase,
  suffix: string,
): Readonly<RenderCompileStepDescriptor> {
  return intrinsicFreeze({
    id: `linear-hdr:${profileId}:${suffix}`,
    phase,
    profileId,
  });
}

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

function ownDataValue(source: object, key: PropertyKey, label: string): unknown {
  const descriptor = intrinsicGetOwnPropertyDescriptor(source, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`${label} must be an own data property.`);
  }
  return descriptor.value;
}

function ownDenseArrayLength(candidate: unknown, label: string, maximum: number): number {
  if (!intrinsicArrayIsArray(candidate)) {
    throw new TypeError(`${label} must be an array.`);
  }
  const length = ownDataValue(candidate, "length", `${label} length`);
  if (!intrinsicNumberIsSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) {
    throw new RangeError(`${label} accepts at most ${maximum} entries.`);
  }
  return length as number;
}

function objectFlag(object: object, key: string): boolean {
  const descriptor = intrinsicGetOwnPropertyDescriptor(object, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.value === true;
}

function isThreeObject3D(candidate: unknown): candidate is Object3D {
  return (
    (typeof candidate === "object" && candidate !== null)
    || typeof candidate === "function"
  ) && objectFlag(candidate as object, "isObject3D");
}

function isDrawableObject(object: Object3D): boolean {
  if (objectFlag(object, "isLineLoop")) {
    throw new TypeError("LineLoop runtime topology is unsupported for atomic compilation.");
  }
  return objectFlag(object, "isMesh")
    || objectFlag(object, "isLine")
    || objectFlag(object, "isPoints")
    || objectFlag(object, "isSprite");
}

function assertSingleCompileTopology(object: Object3D): void {
  const material = ownDataValue(object, "material", "A drawable material");
  if (intrinsicArrayIsArray(material)) {
    throw new TypeError("Multi-material drawable topology is unsupported for atomic compilation.");
  }
  const geometry = ownDataValue(object, "geometry", "A drawable geometry");
  if (typeof geometry !== "object" || geometry === null) {
    throw new TypeError("A drawable geometry must be an object.");
  }
  const groups = ownDataValue(geometry, "groups", "A drawable geometry group inventory");
  // A scalar material produces one renderer item even when geometry groups
  // exist. Material arrays are rejected above because groups can then expand
  // one requested object into multiple hidden renderer compile actions.
  const groupCount = ownDenseArrayLength(groups, "A drawable geometry group inventory", 4096);
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const descriptor = intrinsicGetOwnPropertyDescriptor(groups, String(groupIndex));
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("Drawable geometry group inventories must contain dense own data slots.");
    }
  }
}

function captureReachableDrawables(scene: Object3D): readonly Object3D[] {
  const pending: Object3D[] = [];
  const drawables: Object3D[] = [];
  const seen = new WeakSet<object>();
  let inspected = 0;
  appendArrayValue(pending, scene);
  while (pending.length > 0) {
    inspected += 1;
    if (inspected > 8192) throw new RangeError("A runtime scene accepts at most 8192 objects.");
    const pendingIndex = pending.length - 1;
    const objectDescriptor = intrinsicGetOwnPropertyDescriptor(pending, String(pendingIndex));
    if (!objectDescriptor || !("value" in objectDescriptor)) {
      throw new TypeError("A runtime scene traversal stack must contain dense own data slots.");
    }
    pending.length = pendingIndex;
    const object = objectDescriptor.value as Object3D;
    if (intrinsicReflectApply(intrinsicWeakSetHas, seen, [object]) as boolean) {
      throw new TypeError("A runtime scene must be an acyclic Object3D tree.");
    }
    intrinsicReflectApply(intrinsicWeakSetAdd, seen, [object]);
    if (isDrawableObject(object)) {
      assertSingleCompileTopology(object);
      appendArrayValue(drawables, object);
    }
    const children = ownDataValue(object, "children", "An Object3D child inventory");
    const childCount = ownDenseArrayLength(children, "An Object3D child inventory", 8192);
    for (let childIndex = childCount - 1; childIndex >= 0; childIndex -= 1) {
      const childDescriptor = intrinsicGetOwnPropertyDescriptor(children, String(childIndex));
      if (!childDescriptor || !("value" in childDescriptor)) {
        throw new TypeError("Object3D child inventories must contain dense own data slots.");
      }
      const child = childDescriptor.value;
      if (!isThreeObject3D(child)) {
        throw new TypeError("Object3D child inventories may only contain Object3D values.");
      }
      appendArrayValue(pending, child);
    }
  }
  return intrinsicFreeze(drawables);
}

function fallbackRuntimeDrawableCounts(
  passes: readonly Readonly<RenderPass>[],
): readonly number[] {
  const counts: number[] = [];
  for (let index = 0; index < passes.length; index += 1) {
    // Custom graph factories retain the former one-runtime-action-per-pass
    // seam. The production graph publishes its exact, graph-owned drawable
    // inventory instead of using this fallback.
    appendArrayValue(counts, 1);
  }
  return intrinsicFreeze(counts);
}

function appendProfileCompilePlan(
  plan: Readonly<RenderCompileStepDescriptor>[],
  profileId: LinearHdrPipelineProfileId,
  runtimeDrawableCounts: readonly number[],
  materialCount: number,
  includeRuntimeDraws = false,
): void {
  for (let passIndex = 0; passIndex < runtimeDrawableCounts.length; passIndex += 1) {
    const drawableCount = runtimeDrawableCounts[passIndex]!;
    for (let objectIndex = 0; objectIndex < drawableCount; objectIndex += 1) {
      appendArrayValue(plan, compileDescriptor(
        profileId,
        "runtime-object",
        `runtime:p${passIndex}:o${objectIndex}`,
      ));
    }
  }
  for (let materialIndex = 0; materialIndex < materialCount; materialIndex += 1) {
    appendArrayValue(plan, compileDescriptor(
      profileId,
      "material-isolated",
      `material-isolated:m${materialIndex}`,
    ));
  }
  for (let materialIndex = 0; materialIndex < materialCount; materialIndex += 1) {
    for (let topologyIndex = 0; topologyIndex < runtimeDrawableCounts.length; topologyIndex += 1) {
      appendArrayValue(plan, compileDescriptor(
        profileId,
        "material-runtime-topology",
        `material-runtime:m${materialIndex}:t${topologyIndex}`,
      ));
    }
  }
  appendArrayValue(plan, compileDescriptor(profileId, "output-first-use", "output:update"));
  appendArrayValue(plan, compileDescriptor(profileId, "output-first-use", "output:compile"));
  if (includeRuntimeDraws) {
    for (let passIndex = 0; passIndex < runtimeDrawableCounts.length; passIndex += 1) {
      const drawableCount = runtimeDrawableCounts[passIndex]!;
      for (let objectIndex = 0; objectIndex < drawableCount; objectIndex += 1) {
        appendArrayValue(plan, compileDescriptor(
          profileId,
          "runtime-object",
          `runtime-draw:p${passIndex}:o${objectIndex}`,
        ));
      }
    }
    for (let passIndex = 0; passIndex < runtimeDrawableCounts.length; passIndex += 1) {
      appendArrayValue(plan, compileDescriptor(
        profileId,
        "output-first-use",
        `output:pass-draw:p${passIndex}`,
      ));
    }
  }
  appendArrayValue(plan, compileDescriptor(profileId, "output-first-use", "output:draw"));
}

function fallbackCompilePlan(
  profileId: LinearHdrPipelineProfileId,
  runtimePasses: readonly Readonly<RenderPass>[],
  materials: readonly Readonly<RenderPass>[],
): readonly Readonly<RenderCompileStepDescriptor>[] {
  const plan: Readonly<RenderCompileStepDescriptor>[] = [];
  appendProfileCompilePlan(
    plan,
    profileId,
    fallbackRuntimeDrawableCounts(runtimePasses),
    materials.length,
  );
  return intrinsicFreeze(plan);
}

function compilePlanPhaseCounts(
  plan: readonly Readonly<RenderCompileStepDescriptor>[],
): Readonly<Record<RenderCompileStepPhase, number>> {
  const counts = compilePhaseCounts();
  for (let index = 0; index < plan.length; index += 1) {
    counts[plan[index]!.phase] += 1;
  }
  return intrinsicFreeze(counts);
}

function assertExpectedCompileDescriptor(
  candidate: Readonly<RenderCompileStepDescriptor>,
  expected: Readonly<RenderCompileStepDescriptor>,
): void {
  const id = ownDataValue(candidate, "id", "A compile descriptor id");
  const phase = ownDataValue(candidate, "phase", "A compile descriptor phase");
  const profileId = ownDataValue(candidate, "profileId", "A compile descriptor profileId");
  if (id !== expected.id || phase !== expected.phase || profileId !== expected.profileId) {
    throw new Error("A Linear HDR graph emitted a compile step outside its frozen plan.");
  }
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
  const descriptor = intrinsicGetOwnPropertyDescriptor(source, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`Linear HDR graph ${key} must be an own data property.`);
  }
  return descriptor.value;
}

type CapturedGraphMethod = (this: object, ...args: unknown[]) => unknown;

function captureGraphMethod(source: object, key: string): CapturedGraphMethod {
  let current: object | null = source;
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    const descriptor = intrinsicGetOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`Linear HDR graph ${key} must be a data method.`);
      }
      return descriptor.value as CapturedGraphMethod;
    }
    current = intrinsicGetPrototypeOf(current) as object | null;
  }
  throw new TypeError(`Linear HDR graph ${key} method is missing or too deep.`);
}

function captureAuditedRenderPipelineMethod(
  source: RenderPipeline,
  key: "render" | "_update",
  auditedMethod: unknown,
): CapturedGraphMethod {
  if (intrinsicGetPrototypeOf(source) !== RenderPipeline.prototype) {
    throw new TypeError("RenderPipeline instance topology changed before output capture.");
  }
  if (intrinsicGetOwnPropertyDescriptor(source, key) !== undefined) {
    throw new TypeError(`RenderPipeline ${key} must not be shadowed by an own property.`);
  }
  const descriptor = intrinsicGetOwnPropertyDescriptor(RenderPipeline.prototype, key);
  if (
    !descriptor
    || !("value" in descriptor)
    || typeof descriptor.value !== "function"
    || descriptor.value !== auditedMethod
  ) {
    throw new TypeError(`RenderPipeline ${key} no longer matches the audited Three.js method.`);
  }
  return descriptor.value as CapturedGraphMethod;
}

function captureOutputFirstUseTopology(
  renderPipeline: RenderPipeline,
): OutputFirstUseTopology {
  const quad = ownDataValue(
    renderPipeline,
    "_quadMesh",
    "The RenderPipeline output quad",
  );
  if (!isThreeObject3D(quad) || !objectFlag(quad, "isQuadMesh")) {
    throw new TypeError("The RenderPipeline output quad must be an owned QuadMesh Object3D.");
  }
  const drawables = captureReachableDrawables(quad);
  if (drawables.length !== 1 || drawables[0] !== quad) {
    throw new TypeError("The RenderPipeline output quad must contain exactly one drawable.");
  }
  const camera = ownDataValue(quad, "camera", "The RenderPipeline output quad camera");
  if (!isThreeObject3D(camera) || !objectFlag(camera, "isCamera")) {
    throw new TypeError("The RenderPipeline output quad camera must be an owned Camera Object3D.");
  }
  const update = captureAuditedRenderPipelineMethod(
    renderPipeline,
    "_update",
    auditedRenderPipelineUpdate,
  );
  const render = captureAuditedRenderPipelineMethod(
    renderPipeline,
    "render",
    auditedRenderPipelineRender,
  );
  const updateOperation = (): void => {
    intrinsicReflectApply(update, renderPipeline, []);
  };
  // RenderPipeline.render() performs an ordinary `this._update()` lookup. Pin
  // that lookup to the audited r185 method before any runner yield can mutate
  // the public prototype between the explicit update and first-use draw steps.
  intrinsicDefineProperty(renderPipeline, "_update", {
    configurable: false,
    enumerable: false,
    value: updateOperation,
    writable: false,
  });
  return intrinsicFreeze({
    quad,
    camera: camera as Camera,
    update: updateOperation,
    render(): void {
      intrinsicReflectApply(render, renderPipeline, []);
    },
  });
}

function captureScenePassUpdate(
  scenePass: ScenePassNode,
): Readonly<Pick<
  RuntimeSceneTopology,
  "passSource" | "passUpdateBeforeType" | "updatePass"
>> {
  if (intrinsicGetPrototypeOf(scenePass) !== PassNode.prototype) {
    throw new TypeError("Scene-pass instance topology changed before draw capture.");
  }
  if (intrinsicGetOwnPropertyDescriptor(scenePass, "updateBefore") !== undefined) {
    throw new TypeError("Scene-pass updateBefore must not be shadowed by an own property.");
  }
  const updateDescriptor = intrinsicGetOwnPropertyDescriptor(PassNode.prototype, "updateBefore");
  if (
    !updateDescriptor
    || !("value" in updateDescriptor)
    || typeof updateDescriptor.value !== "function"
    || updateDescriptor.value !== auditedPassNodeUpdateBefore
  ) {
    throw new TypeError("Scene-pass updateBefore no longer matches the audited Three.js method.");
  }
  const updateBeforeType = intrinsicGetOwnPropertyDescriptor(scenePass, "updateBeforeType");
  if (
    !updateBeforeType
    || !("value" in updateBeforeType)
    || updateBeforeType.value !== NodeUpdateType.FRAME
  ) {
    throw new TypeError("Scene-pass updateBeforeType must be an owned FRAME data property.");
  }
  intrinsicFreeze(updateBeforeType);
  return intrinsicFreeze({
    passSource: scenePass,
    passUpdateBeforeType: updateBeforeType,
    updatePass(renderer: object): void {
      intrinsicReflectApply(updateDescriptor.value, scenePass, [{ renderer }]);
    },
  });
}

function captureCompileRunner(candidate: unknown): RenderCompileStepRunner {
  if ((typeof candidate !== "object" || candidate === null) && typeof candidate !== "function") {
    throw new TypeError("A render compile step runner must be an object.");
  }
  const source = candidate as object;
  const run = captureGraphMethod(source, "run");
  return intrinsicFreeze({
    async run(
      descriptor: Readonly<RenderCompileStepDescriptor>,
      operation: () => void | Promise<void>,
    ): Promise<void> {
      await intrinsicReflectApply(run, source, [descriptor, operation]);
    },
  });
}

function captureRendererOperations(renderer: PipelineRenderer): CapturedRendererOperations {
  const source = renderer as object;
  const getRenderTarget = captureGraphMethod(source, "getRenderTarget");
  const getMRT = captureGraphMethod(source, "getMRT");
  const setRenderTarget = captureGraphMethod(source, "setRenderTarget");
  const setMRT = captureGraphMethod(source, "setMRT");
  const getOutputRenderTarget = captureGraphMethod(source, "getOutputRenderTarget");
  const getDrawingBufferSize = captureGraphMethod(source, "getDrawingBufferSize");
  const compileAsync = captureGraphMethod(source, "compileAsync");
  const render = captureGraphMethod(source, "render");
  return intrinsicFreeze({
    getRenderTarget(): unknown {
      return intrinsicReflectApply(getRenderTarget, source, []);
    },
    getMRT(): unknown {
      return intrinsicReflectApply(getMRT, source, []);
    },
    setRenderTarget(target: unknown): void {
      intrinsicReflectApply(setRenderTarget, source, [target]);
    },
    setMRT(mrt: unknown): void {
      intrinsicReflectApply(setMRT, source, [mrt]);
    },
    getOutputRenderTarget(): unknown {
      return intrinsicReflectApply(getOutputRenderTarget, source, []);
    },
    getDrawingBufferSize(target: unknown): unknown {
      return intrinsicReflectApply(getDrawingBufferSize, source, [target]);
    },
    async compileAsync(object: Object3D, camera: Camera, targetScene?: Scene): Promise<void> {
      if (targetScene === undefined) {
        await intrinsicReflectApply(compileAsync, source, [object, camera]);
        return;
      }
      await intrinsicReflectApply(compileAsync, source, [object, camera, targetScene]);
    },
    render(scene: Scene, camera: Camera): void {
      intrinsicReflectApply(render, source, [scene, camera]);
    },
  });
}

async function runCompileStep(
  runner: RenderCompileStepRunner,
  descriptor: Readonly<RenderCompileStepDescriptor>,
  operation: () => void | Promise<void>,
): Promise<void> {
  let operationCalls = 0;
  let operationCompleted = false;
  await runner.run(descriptor, async () => {
    operationCalls += 1;
    if (operationCalls !== 1) {
      throw new Error("A render compile runner invoked one operation more than once.");
    }
    await operation();
    operationCompleted = true;
  });
  if (operationCalls !== 1 || !operationCompleted) {
    throw new Error("A render compile runner must await exactly one completed operation.");
  }
}

function captureCompileReceipt(candidate: unknown, label: string): Readonly<RenderPrecompileReceipt> {
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError(`${label} must be an object.`);
  }
  const plannedSteps = ownDataValue(candidate, "plannedSteps", `${label} plannedSteps`);
  const completedSteps = ownDataValue(candidate, "completedSteps", `${label} completedSteps`);
  if (!intrinsicNumberIsSafeInteger(plannedSteps) || (plannedSteps as number) < 0) {
    throw new TypeError(`${label} plannedSteps must be a non-negative safe integer.`);
  }
  if (!intrinsicNumberIsSafeInteger(completedSteps) || (completedSteps as number) < 0) {
    throw new TypeError(`${label} completedSteps must be a non-negative safe integer.`);
  }
  const candidateCounts = ownDataValue(candidate, "phaseCounts", `${label} phaseCounts`);
  if (typeof candidateCounts !== "object" || candidateCounts === null) {
    throw new TypeError(`${label} phaseCounts must be an object.`);
  }
  const counts = compilePhaseCounts();
  const phases = [
    "runtime-object",
    "material-isolated",
    "material-runtime-topology",
    "output-first-use",
  ] as const;
  let phaseTotal = 0;
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index]!;
    const count = ownDataValue(candidateCounts, phase, `${label} ${phase} count`);
    if (!intrinsicNumberIsSafeInteger(count) || (count as number) < 0) {
      throw new TypeError(`${label} ${phase} count must be a non-negative safe integer.`);
    }
    counts[phase] = count as number;
    phaseTotal += count as number;
  }
  if (phaseTotal !== completedSteps) {
    throw new TypeError(`${label} phase counts must sum to completedSteps.`);
  }
  if ((completedSteps as number) > (plannedSteps as number)) {
    throw new TypeError(`${label} completedSteps cannot exceed plannedSteps.`);
  }
  return compileReceipt(plannedSteps as number, completedSteps as number, counts);
}

function isBoundedInternalToken(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 96) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = intrinsicReflectApply(intrinsicStringCharCodeAt, value, [index]) as number;
    if (
      (code < 48 || code > 57)
      && (code < 97 || code > 122)
      && code !== 45
      && code !== 58
    ) return false;
  }
  return true;
}

function captureCompilePlan(
  candidate: unknown,
  expectedProfileId: LinearHdrPipelineProfileId,
): readonly Readonly<RenderCompileStepDescriptor>[] {
  const length = ownDenseArrayLength(candidate, "A Linear HDR compile plan", 16384);
  const plan: Readonly<RenderCompileStepDescriptor>[] = [];
  for (let index = 0; index < length; index += 1) {
    const slot = intrinsicGetOwnPropertyDescriptor(candidate, String(index));
    if (!slot || !("value" in slot) || typeof slot.value !== "object" || slot.value === null) {
      throw new TypeError("A Linear HDR compile plan must contain dense descriptor data slots.");
    }
    const descriptor = slot.value as object;
    const id = ownDataValue(descriptor, "id", "A compile descriptor id");
    const phase = ownDataValue(descriptor, "phase", "A compile descriptor phase");
    const profileId = ownDataValue(descriptor, "profileId", "A compile descriptor profileId");
    if (!isBoundedInternalToken(id)) {
      throw new TypeError("A compile descriptor id must be a bounded internal token.");
    }
    if (
      phase !== "runtime-object"
      && phase !== "material-isolated"
      && phase !== "material-runtime-topology"
      && phase !== "output-first-use"
    ) {
      throw new TypeError("A compile descriptor phase is unsupported.");
    }
    if (profileId !== expectedProfileId) {
      throw new TypeError("A compile descriptor must identify its graph profile.");
    }
    appendArrayValue(plan, intrinsicFreeze({ id, phase, profileId }));
  }
  return intrinsicFreeze(plan);
}

function captureLinearHdrGraph(
  candidate: unknown,
  expectedProfile: Readonly<LinearHdrPipelineProfile>,
  expectedPassSignature: string,
  fallbackPlan: readonly Readonly<RenderCompileStepDescriptor>[],
  capturedDispose?: CapturedGraphMethod,
): CapturedLinearHdrGraph {
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
  const compilePlanDescriptor = intrinsicGetOwnPropertyDescriptor(source, "compilePlan");
  const compilePlan = compilePlanDescriptor === undefined
    ? fallbackPlan
    : "value" in compilePlanDescriptor
      ? captureCompilePlan(compilePlanDescriptor.value, expectedProfile.id)
      : (() => { throw new TypeError("A Linear HDR graph compilePlan must be an own data property."); })();
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
    compilePlan,
    async precompile(runner: RenderCompileStepRunner) {
      const receipt = await intrinsicReflectApply(precompile, source, [runner]);
      return captureCompileReceipt(receipt, "A Linear HDR graph precompile receipt");
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
  scene: Scene;
  camera: Camera;
} {
  const scene = candidate.scene;
  const camera = candidate.camera;
  if (
    ((typeof scene !== "object" || scene === null) && typeof scene !== "function")
    || !objectFlag(scene as object, "isScene")
    || ((typeof camera !== "object" || camera === null) && typeof camera !== "function")
    || !objectFlag(camera as object, "isCamera")
  ) {
    throw new TypeError(`Pipeline pass ${candidate.name} requires a Three.js scene and camera.`);
  }
  return { scene: scene as Scene, camera: camera as Camera };
}

function captureRenderPipelineConstructorRenderer(renderer: PipelineRenderer): PipelineRenderer {
  const captured: PipelineRenderer = Object.create(null);
  const fields = ["toneMapping", "outputColorSpace"] as const;
  for (let index = 0; index < fields.length; index += 1) {
    const key = fields[index]!;
    const descriptor = intrinsicGetOwnPropertyDescriptor(renderer, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`The Linear HDR renderer ${key} must be an own data property.`);
    }
    intrinsicDefineProperty(captured, key, {
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
  declare readonly cleanup: GraphCleanupHandle;

  constructor(primaryFailure: unknown, cleanup: GraphCleanupHandle) {
    const evidence = ownedAggregateError(
      [primaryFailure],
      "Linear HDR graph construction failed.",
    );
    super(evidence.errors, evidence.message);
    intrinsicDefineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: undefined,
      writable: true,
    });
    intrinsicDefineProperty(this, "name", {
      configurable: true,
      enumerable: true,
      value: "LinearHdrGraphConstructionFailure",
      writable: true,
    });
    intrinsicDefineProperty(this, "cleanup", {
      configurable: true,
      enumerable: true,
      value: cleanup,
      writable: true,
    });
    const ownedErrors = intrinsicGetOwnPropertyDescriptor(this, "errors")!.value as unknown[];
    intrinsicFreeze(ownedErrors);
    intrinsicReflectApply(intrinsicWeakMapSet, constructionCleanupByFailure, [this, cleanup]);
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
  return intrinsicReflectApply(
    intrinsicWeakMapGet,
    constructionCleanupByFailure,
    [error as object],
  ) as GraphCleanupHandle | undefined ?? null;
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

type TemporaryDataMutation = Readonly<{
  readonly source: object;
  readonly key: PropertyKey;
  readonly descriptor: PropertyDescriptor;
}>;

function temporarilyReplaceOwnData(
  source: object,
  key: PropertyKey,
  value: unknown,
  label: string,
  mutations: TemporaryDataMutation[],
): void {
  const descriptor = intrinsicGetOwnPropertyDescriptor(source, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`${label} must be an own data property.`);
  }
  if (descriptor.value === value) return;
  intrinsicDefineProperty(source, key, { ...descriptor, value });
  appendArrayValue(mutations, intrinsicFreeze({ source, key, descriptor }));
}

function captureOwnDataForRestoration(
  source: object,
  key: PropertyKey,
  label: string,
  mutations: TemporaryDataMutation[],
): PropertyDescriptor {
  const descriptor = intrinsicGetOwnPropertyDescriptor(source, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`${label} must be an own data property.`);
  }
  appendArrayValue(mutations, intrinsicFreeze({ source, key, descriptor }));
  return descriptor;
}

function restoreTemporaryData(
  mutations: TemporaryDataMutation[],
  failures: unknown[],
): void {
  for (let index = mutations.length - 1; index >= 0; index -= 1) {
    const mutation = mutations[index]!;
    try {
      intrinsicDefineProperty(mutation.source, mutation.key, mutation.descriptor);
    } catch (error: unknown) {
      appendArrayValue(failures, error);
    }
  }
}

function prepareDrawableForAtomicCompile(
  object: Object3D,
  camera: Camera,
  mutations: TemporaryDataMutation[],
): void {
  assertSingleCompileTopology(object);
  temporarilyReplaceOwnData(object, "visible", true, "A drawable visibility", mutations);
  temporarilyReplaceOwnData(
    object,
    "frustumCulled",
    false,
    "A drawable frustum flag",
    mutations,
  );
  const material = ownDataValue(object, "material", "A drawable material");
  if (typeof material !== "object" || material === null) {
    throw new TypeError("A drawable material must be an object.");
  }
  temporarilyReplaceOwnData(material, "visible", true, "A drawable material visibility", mutations);
  const objectLayers = ownDataValue(object, "layers", "A drawable layer state");
  const cameraLayers = ownDataValue(camera, "layers", "A compile camera layer state");
  if (
    typeof objectLayers !== "object"
    || objectLayers === null
    || typeof cameraLayers !== "object"
    || cameraLayers === null
  ) {
    throw new TypeError("Drawable and camera layer states must be objects.");
  }
  const cameraMask = ownDataValue(cameraLayers, "mask", "A compile camera layer mask");
  if (!intrinsicNumberIsInteger(cameraMask) || cameraMask === 0) {
    throw new TypeError("A compile camera must expose a non-zero integer layer mask.");
  }
  temporarilyReplaceOwnData(
    objectLayers,
    "mask",
    cameraMask,
    "A drawable layer mask",
    mutations,
  );

  // Renderer.compileAsync traverses descendants of its first argument. Hide
  // direct child roots for this one operation so the runner step corresponds
  // to exactly one renderer-facing drawable compile.
  const children = ownDataValue(object, "children", "A drawable child inventory");
  const childCount = ownDenseArrayLength(children, "A drawable child inventory", 8192);
  for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
    const childDescriptor = intrinsicGetOwnPropertyDescriptor(children, String(childIndex));
    if (!childDescriptor || !("value" in childDescriptor) || !isThreeObject3D(childDescriptor.value)) {
      throw new TypeError("Drawable child inventories must contain dense Object3D data slots.");
    }
    temporarilyReplaceOwnData(
      childDescriptor.value,
      "visible",
      false,
      "A drawable child visibility",
      mutations,
    );
  }
}

async function compileDrawableSafely(
  renderer: CapturedRendererOperations,
  renderPassTarget: unknown,
  renderPassMrt: unknown,
  object: Object3D,
  camera: Camera,
  targetScene?: Scene,
): Promise<void> {
  const renderTarget = renderer.getRenderTarget();
  const currentMrt = renderer.getMRT();
  const mutations: TemporaryDataMutation[] = [];
  const failures: unknown[] = [];
  try {
    renderer.setRenderTarget(renderPassTarget);
    renderer.setMRT(renderPassMrt);
    prepareDrawableForAtomicCompile(object, camera, mutations);
    await renderer.compileAsync(object, camera, targetScene);
  } catch (error: unknown) {
    appendArrayValue(failures, error);
  }
  for (let index = mutations.length - 1; index >= 0; index -= 1) {
    const mutation = mutations[index]!;
    try {
      intrinsicDefineProperty(mutation.source, mutation.key, mutation.descriptor);
    } catch (error: unknown) {
      appendArrayValue(failures, error);
    }
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
    throw ownedAggregateError(failures, "Linear HDR atomic drawable compilation failed.");
  }
}

function prepareRuntimeObjectForAtomicDraw(
  topology: RuntimeSceneTopology,
  selected: Object3D,
  mutations: TemporaryDataMutation[],
): void {
  for (let index = 0; index < topology.drawables.length; index += 1) {
    const drawable = topology.drawables[index]!;
    if (drawable === selected) continue;
    temporarilyReplaceOwnData(
      drawable,
      "visible",
      false,
      "A non-selected runtime drawable visibility",
      mutations,
    );
  }
  let ancestor = ownDataValue(selected, "parent", "A runtime drawable parent");
  let depth = 0;
  while (ancestor !== topology.scene) {
    depth += 1;
    if (depth > 8192 || !isThreeObject3D(ancestor)) {
      throw new TypeError("A runtime drawable must have a bounded path to its captured scene.");
    }
    temporarilyReplaceOwnData(
      ancestor,
      "visible",
      true,
      "A runtime drawable ancestor visibility",
      mutations,
    );
    if (isDrawableObject(ancestor)) {
      // A visible drawable ancestor must remain traversable so Three can reach
      // the selected descendant, but it must not contribute a second render
      // item to this atomic step. A zero layer mask suppresses only the
      // ancestor's own draw while preserving descendant traversal. This also
      // works when ancestor and descendant share one material instance.
      const ancestorLayers = ownDataValue(
        ancestor,
        "layers",
        "A runtime drawable ancestor layer state",
      );
      if (typeof ancestorLayers !== "object" || ancestorLayers === null) {
        throw new TypeError("A runtime drawable ancestor layer state must be an object.");
      }
      temporarilyReplaceOwnData(
        ancestorLayers,
        "mask",
        0,
        "A runtime drawable ancestor layer mask",
        mutations,
      );
    }
    ancestor = ownDataValue(ancestor, "parent", "A runtime drawable ancestor parent");
  }
  temporarilyReplaceOwnData(
    topology.scene,
    "visible",
    true,
    "A runtime scene visibility",
    mutations,
  );
  prepareDrawableForAtomicCompile(selected, topology.camera, mutations);
}

function drawRuntimeObjectSafely(
  rendererSource: PipelineRenderer,
  renderer: CapturedRendererOperations,
  topology: RuntimeSceneTopology,
  selected: Object3D,
): void {
  const renderTarget = renderer.getRenderTarget();
  const currentMrt = renderer.getMRT();
  const mutations: TemporaryDataMutation[] = [];
  const failures: unknown[] = [];
  try {
    renderer.setRenderTarget(topology.renderTarget);
    renderer.setMRT(topology.mrt);
    temporarilyReplaceOwnData(
      rendererSource,
      "toneMapping",
      NoToneMapping,
      "Renderer tone mapping",
      mutations,
    );
    temporarilyReplaceOwnData(
      rendererSource,
      "outputColorSpace",
      auditedWorkingColorSpace,
      "Renderer output color space",
      mutations,
    );
    temporarilyReplaceOwnData(
      rendererSource,
      "autoClear",
      true,
      "Renderer auto-clear state",
      mutations,
    );
    temporarilyReplaceOwnData(
      rendererSource,
      "transparent",
      topology.transparent,
      "Renderer transparent state",
      mutations,
    );
    temporarilyReplaceOwnData(
      rendererSource,
      "opaque",
      topology.opaque,
      "Renderer opaque state",
      mutations,
    );
    const xr = ownDataValue(rendererSource, "xr", "Renderer XR state");
    if (typeof xr !== "object" || xr === null) {
      throw new TypeError("Renderer XR state must be an object.");
    }
    temporarilyReplaceOwnData(xr, "enabled", false, "Renderer XR enabled state", mutations);
    prepareRuntimeObjectForAtomicDraw(topology, selected, mutations);
    renderer.render(topology.scene, topology.camera);
  } catch (error: unknown) {
    appendArrayValue(failures, error);
  }
  for (let index = mutations.length - 1; index >= 0; index -= 1) {
    const mutation = mutations[index]!;
    try {
      intrinsicDefineProperty(mutation.source, mutation.key, mutation.descriptor);
    } catch (error: unknown) {
      appendArrayValue(failures, error);
    }
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
    throw ownedAggregateError(failures, "Linear HDR atomic runtime draw failed.");
  }
}

function drawScenePassSafely(
  rendererSource: PipelineRenderer,
  renderer: CapturedRendererOperations,
  topology: RuntimeSceneTopology,
): void {
  const renderTarget = renderer.getRenderTarget();
  const currentMrt = renderer.getMRT();
  const mutations: TemporaryDataMutation[] = [];
  const failures: unknown[] = [];
  try {
    temporarilyReplaceOwnData(
      rendererSource,
      "toneMapping",
      NoToneMapping,
      "Renderer tone mapping",
      mutations,
    );
    temporarilyReplaceOwnData(
      rendererSource,
      "outputColorSpace",
      auditedWorkingColorSpace,
      "Renderer output color space",
      mutations,
    );
    const xr = ownDataValue(rendererSource, "xr", "Renderer XR state");
    if (typeof xr !== "object" || xr === null) {
      throw new TypeError("Renderer XR state must be an object.");
    }
    temporarilyReplaceOwnData(xr, "enabled", false, "Renderer XR enabled state", mutations);

    const autoClear = captureOwnDataForRestoration(
      rendererSource,
      "autoClear",
      "Renderer auto-clear state",
      mutations,
    ).value;
    const transparent = captureOwnDataForRestoration(
      rendererSource,
      "transparent",
      "Renderer transparent state",
      mutations,
    ).value;
    const opaque = captureOwnDataForRestoration(
      rendererSource,
      "opaque",
      "Renderer opaque state",
      mutations,
    ).value;
    const contextNode = captureOwnDataForRestoration(
      rendererSource,
      "contextNode",
      "Renderer context node",
      mutations,
    ).value;
    captureOwnDataForRestoration(topology.scene, "name", "Runtime scene name", mutations);
    captureOwnDataForRestoration(
      topology.scene,
      "overrideMaterial",
      "Runtime scene override material",
      mutations,
    );
    const cameraLayers = ownDataValue(topology.camera, "layers", "Runtime camera layer state");
    if (typeof cameraLayers !== "object" || cameraLayers === null) {
      throw new TypeError("A runtime camera layer state must be an object.");
    }
    captureOwnDataForRestoration(cameraLayers, "mask", "Runtime camera layer mask", mutations);

    const passRenderer: {
      xr: unknown;
      autoClear: unknown;
      transparent: unknown;
      opaque: unknown;
      contextNode: unknown;
      getOutputRenderTarget(): unknown;
      getDrawingBufferSize(target: unknown): unknown;
      getRenderTarget(): unknown;
      getMRT(): unknown;
      setRenderTarget(target: unknown): void;
      setMRT(mrt: unknown): void;
      render(scene: Scene, camera: Camera): void;
    } = {
      xr,
      autoClear,
      transparent,
      opaque,
      contextNode,
      getOutputRenderTarget: renderer.getOutputRenderTarget,
      getDrawingBufferSize: renderer.getDrawingBufferSize,
      getRenderTarget: renderer.getRenderTarget,
      getMRT: renderer.getMRT,
      setRenderTarget: renderer.setRenderTarget,
      setMRT: renderer.setMRT,
      render(scene: Scene, camera: Camera): void {
        const renderMutations: TemporaryDataMutation[] = [];
        const renderFailures: unknown[] = [];
        try {
          temporarilyReplaceOwnData(
            rendererSource,
            "autoClear",
            passRenderer.autoClear,
            "Renderer auto-clear state",
            renderMutations,
          );
          temporarilyReplaceOwnData(
            rendererSource,
            "transparent",
            passRenderer.transparent,
            "Renderer transparent state",
            renderMutations,
          );
          temporarilyReplaceOwnData(
            rendererSource,
            "opaque",
            passRenderer.opaque,
            "Renderer opaque state",
            renderMutations,
          );
          temporarilyReplaceOwnData(
            rendererSource,
            "contextNode",
            passRenderer.contextNode,
            "Renderer context node",
            renderMutations,
          );
          renderer.render(scene, camera);
        } catch (error: unknown) {
          appendArrayValue(renderFailures, error);
        }
        restoreTemporaryData(renderMutations, renderFailures);
        if (renderFailures.length > 0) {
          throw ownedAggregateError(renderFailures, "Linear HDR captured scene-pass render failed.");
        }
      },
    };
    topology.updatePass(passRenderer);
  } catch (error: unknown) {
    appendArrayValue(failures, error);
  }
  restoreTemporaryData(mutations, failures);
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
    throw ownedAggregateError(failures, "Linear HDR atomic scene-pass draw failed.");
  }
}

function suppressScenePassUpdate(
  topology: RuntimeSceneTopology,
  mutations: TemporaryDataMutation[],
): void {
  const expected = topology.passUpdateBeforeType;
  const current = intrinsicGetOwnPropertyDescriptor(topology.passSource, "updateBeforeType");
  if (
    !current
    || !("value" in current)
    || current.value !== expected.value
    || current.configurable !== expected.configurable
    || current.enumerable !== expected.enumerable
    || current.writable !== expected.writable
  ) {
    throw new TypeError("Scene-pass updateBeforeType changed after audited capture.");
  }
  appendArrayValue(mutations, intrinsicFreeze({
    source: topology.passSource,
    key: "updateBeforeType",
    descriptor: expected,
  }));
  intrinsicDefineProperty(topology.passSource, "updateBeforeType", {
    configurable: expected.configurable,
    enumerable: expected.enumerable,
    value: NodeUpdateType.NONE,
    writable: expected.writable,
  });
}

function renderOutputSafely(
  rendererSource: PipelineRenderer,
  renderer: CapturedRendererOperations,
  render: () => void,
  runtimeTopologies?: readonly RuntimeSceneTopology[],
): void {
  const renderTarget = renderer.getRenderTarget();
  const currentMrt = renderer.getMRT();
  const rendererState: TemporaryDataMutation[] = [];
  const captureRendererState = (source: object, key: PropertyKey, label: string): void => {
    const descriptor = intrinsicGetOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`${label} must be an own data property.`);
    }
    appendArrayValue(rendererState, intrinsicFreeze({ source, key, descriptor }));
  };
  captureRendererState(rendererSource, "toneMapping", "Renderer tone mapping");
  captureRendererState(rendererSource, "outputColorSpace", "Renderer output color space");
  const xr = ownDataValue(rendererSource, "xr", "Renderer XR state");
  if (typeof xr !== "object" || xr === null) {
    throw new TypeError("Renderer XR state must be an object.");
  }
  captureRendererState(xr, "enabled", "Renderer XR enabled state");
  const failures: unknown[] = [];
  try {
    renderer.setRenderTarget(null);
    renderer.setMRT(null);
    for (let index = 0; index < (runtimeTopologies?.length ?? 0); index += 1) {
      suppressScenePassUpdate(runtimeTopologies![index]!, rendererState);
    }
    render();
  } catch (error: unknown) {
    appendArrayValue(failures, error);
  }
  restoreTemporaryData(rendererState, failures);
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
    throw ownedAggregateError(failures, "Linear HDR output first-use draw failed.");
  }
}

function cloneMaterialWarmupDrawable(candidate: MaterialWarmupTopology): Object3D {
  if (!objectFlag(candidate.drawable, "isMesh")) {
    throw new TypeError("Material warm-up topology requires a Mesh drawable.");
  }
  const geometry = ownDataValue(
    candidate.drawable,
    "geometry",
    "A material warm-up geometry",
  ) as BufferGeometry;
  const material = ownDataValue(
    candidate.drawable,
    "material",
    "A material warm-up material",
  ) as Material;
  const clone = new Mesh(geometry, material);
  clone.name = `gfx005-runtime-warmup:${candidate.pass.name}:${candidate.pass.variant ?? "absent"}`;
  clone.frustumCulled = false;
  assertSingleCompileTopology(clone);
  return clone;
}

class ThreeLinearHdrGraph implements LinearHdrGraph {
  readonly profile: Readonly<LinearHdrPipelineProfile>;
  readonly passSignature: string;
  readonly compilePlan: readonly Readonly<RenderCompileStepDescriptor>[];
  readonly depthOwned = true as const;
  readonly velocityOwned: boolean;
  readonly historyOwned: boolean;
  readonly #renderer: PipelineRenderer;
  readonly #rendererOperations: CapturedRendererOperations;
  #outputFirstUseTopology: OutputFirstUseTopology | null;
  readonly #resources: PendingGraphResources;
  readonly #scenePasses: ScenePassNode[];
  #runtimeTopologies: readonly RuntimeSceneTopology[];
  readonly #historyWeight = uniform(0);
  #viewport: Readonly<RenderViewport>;
  #materialWarmupTopologies: readonly MaterialWarmupTopology[];
  #disposeRequested = false;
  #disposed = false;

  constructor(context: Readonly<LinearHdrGraphFactoryContext>) {
    this.profile = context.profile;
    this.passSignature = context.passSignature;
    this.velocityOwned = context.profile.temporal;
    this.historyOwned = context.profile.temporal;
    this.#renderer = context.renderer as PipelineRenderer;
    this.#viewport = captureViewport(context.viewport);
    let capturedPasses: readonly Readonly<{ scene: Scene; camera: Camera }>[];
    let materialWarmupTopologies: readonly MaterialWarmupTopology[];
    let constructorRenderer: PipelineRenderer;
    let rendererOperations: CapturedRendererOperations;
    try {
      const captured: Readonly<{ scene: Scene; camera: Camera }>[] = [];
      for (let index = 0; index < context.passes.length; index += 1) {
        appendArrayValue(captured, intrinsicFreeze({
          ...assertThreeScenePass(context.passes[index]!),
        }));
      }
      capturedPasses = intrinsicFreeze(captured);
      if (capturedPasses.length === 0) {
        throw new Error("A Linear HDR graph requires at least one drawable scene pass.");
      }
      rendererOperations = captureRendererOperations(this.#renderer);
      constructorRenderer = captureRenderPipelineConstructorRenderer(this.#renderer);
      const materials: MaterialWarmupTopology[] = [];
      for (let index = 0; index < context.materialWarmupPasses.length; index += 1) {
        const candidate = context.materialWarmupPasses[index]!;
        const { scene } = assertThreeScenePass(candidate);
        const drawables = captureReachableDrawables(scene);
        if (drawables.length !== 1) {
          throw new TypeError(`Material warm-up pass ${candidate.name} must contain one drawable.`);
        }
        appendArrayValue(materials, intrinsicFreeze({
          pass: candidate,
          drawable: drawables[0]!,
        }));
      }
      materialWarmupTopologies = intrinsicFreeze(materials);
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
      const outputFirstUseTopology = captureOutputFirstUseTopology(renderPipeline);
      for (let index = 0; index < capturedPasses.length; index += 1) {
        const captured = capturedPasses[index]!;
        const scenePass = scenePasses[index]!;
        const getMrt = captureGraphMethod(scenePass, "getMRT");
        const passUpdate = captureScenePassUpdate(scenePass);
        const transparent = ownDataValue(scenePass, "transparent", "A scene-pass transparent gate");
        const opaque = ownDataValue(scenePass, "opaque", "A scene-pass opaque gate");
        if (typeof transparent !== "boolean" || typeof opaque !== "boolean") {
          throw new TypeError("Scene-pass draw gates must be booleans.");
        }
        appendArrayValue(runtimeTopologies, intrinsicFreeze({
          scene: captured.scene,
          camera: captured.camera,
          renderTarget: ownDataValue(scenePass, "renderTarget", "A scene-pass render target"),
          mrt: intrinsicReflectApply(getMrt, scenePass, []),
          transparent,
          opaque,
          drawables: captureReachableDrawables(captured.scene),
          passSource: passUpdate.passSource,
          passUpdateBeforeType: passUpdate.passUpdateBeforeType,
          updatePass: passUpdate.updatePass,
        }));
      }
      this.#scenePasses = scenePasses;
      this.#resources = resources;
      this.#rendererOperations = rendererOperations;
      this.#runtimeTopologies = intrinsicFreeze(runtimeTopologies);
      this.#outputFirstUseTopology = outputFirstUseTopology;
      this.#materialWarmupTopologies = materialWarmupTopologies;
      const compilePlan: Readonly<RenderCompileStepDescriptor>[] = [];
      const runtimeDrawableCounts: number[] = [];
      for (let index = 0; index < runtimeTopologies.length; index += 1) {
        appendArrayValue(runtimeDrawableCounts, runtimeTopologies[index]!.drawables.length);
      }
      appendProfileCompilePlan(
        compilePlan,
        this.profile.id,
        runtimeDrawableCounts,
        materialWarmupTopologies.length,
        true,
      );
      this.compilePlan = intrinsicFreeze(compilePlan);
    } catch (error: unknown) {
      throw graphConstructionFailure(error, resources);
    }
  }

  async precompile(
    candidateRunner: RenderCompileStepRunner,
  ): Promise<Readonly<RenderPrecompileReceipt>> {
    this.#assertLive();
    const runner = captureCompileRunner(candidateRunner);
    const plan = this.compilePlan;
    const materialInventory = this.#materialWarmupTopologies;
    const phaseCounts = compilePhaseCounts();
    let completedSteps = 0;
    let planIndex = 0;
    const execute = async (operation: () => void | Promise<void>): Promise<void> => {
      const descriptor = plan[planIndex];
      if (!descriptor) throw new Error("A Linear HDR graph exceeded its compile plan.");
      await runCompileStep(runner, descriptor, operation);
      phaseCounts[descriptor.phase] += 1;
      completedSteps += 1;
      planIndex += 1;
    };

    for (let topologyIndex = 0; topologyIndex < this.#runtimeTopologies.length; topologyIndex += 1) {
      const topology = this.#runtimeTopologies[topologyIndex]!;
      for (let objectIndex = 0; objectIndex < topology.drawables.length; objectIndex += 1) {
        const drawable = topology.drawables[objectIndex]!;
        await execute(() => compileDrawableSafely(
          this.#rendererOperations,
          topology.renderTarget,
          topology.mrt,
          drawable,
          topology.camera,
          topology.scene,
        ));
      }
    }
    this.#materialWarmupTopologies = intrinsicFreeze([]);
    for (let index = 0; index < materialInventory.length; index += 1) {
      const candidate = materialInventory[index]!;
      let temporaryPass: ScenePassNode | null = null;
      const failures: unknown[] = [];
      try {
        temporaryPass = createScenePassNode(
          assertThreeScenePass(candidate.pass),
          this.#viewport,
          this.#resources,
        );
        if (this.profile.temporal) configureTemporalTarget(temporaryPass);
        const { scene, camera } = assertThreeScenePass(candidate.pass);
        const temporaryGetMrt = captureGraphMethod(temporaryPass, "getMRT");
        const temporaryTarget = ownDataValue(
          temporaryPass,
          "renderTarget",
          "A temporary scene-pass render target",
        );
        const temporaryMrt = intrinsicReflectApply(temporaryGetMrt, temporaryPass, []);
        await execute(() => compileDrawableSafely(
          this.#rendererOperations,
          temporaryTarget,
          temporaryMrt,
          candidate.drawable,
          camera,
          scene,
        ));
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
    for (let materialIndex = 0; materialIndex < materialInventory.length; materialIndex += 1) {
      const candidate = materialInventory[materialIndex]!;
      for (let topologyIndex = 0; topologyIndex < this.#runtimeTopologies.length; topologyIndex += 1) {
        const topology = this.#runtimeTopologies[topologyIndex]!;
        let clone: Object3D | null = null;
        const failures: unknown[] = [];
        try {
          clone = cloneMaterialWarmupDrawable(candidate);
          intrinsicReflectApply(intrinsicObject3DAdd, topology.scene, [clone]);
          await execute(() => compileDrawableSafely(
            this.#rendererOperations,
            topology.renderTarget,
            topology.mrt,
            clone!,
            topology.camera,
            topology.scene,
          ));
        } catch (error: unknown) {
          appendArrayValue(failures, error);
        } finally {
          if (clone && ownDataValue(clone, "parent", "A temporary clone parent") === topology.scene) {
            try {
              intrinsicReflectApply(intrinsicObject3DRemove, topology.scene, [clone]);
            } catch (error: unknown) {
              appendArrayValue(failures, error);
            }
          }
        }
        if (failures.length > 0) {
          throw ownedAggregateError(failures, "Runtime material topology warm-up failed.");
        }
      }
    }
    this.#historyWeight.value = 0;
    const output = this.#outputFirstUseTopology!;
    await execute(() => output.update());
    await execute(() => compileDrawableSafely(
      this.#rendererOperations,
      null,
      null,
      output.quad,
      output.camera,
    ));
    for (let topologyIndex = 0; topologyIndex < this.#runtimeTopologies.length; topologyIndex += 1) {
      const topology = this.#runtimeTopologies[topologyIndex]!;
      for (let objectIndex = 0; objectIndex < topology.drawables.length; objectIndex += 1) {
        await execute(() => drawRuntimeObjectSafely(
          this.#renderer,
          this.#rendererOperations,
          topology,
          topology.drawables[objectIndex]!,
        ));
      }
    }
    for (let topologyIndex = 0; topologyIndex < this.#runtimeTopologies.length; topologyIndex += 1) {
      await execute(() => drawScenePassSafely(
        this.#renderer,
        this.#rendererOperations,
        this.#runtimeTopologies[topologyIndex]!,
      ));
    }
    await execute(() => renderOutputSafely(
      this.#renderer,
      this.#rendererOperations,
      output.render,
      this.#runtimeTopologies,
    ));
    if (completedSteps !== plan.length || planIndex !== plan.length) {
      throw new Error("A Linear HDR graph did not complete its full compile plan.");
    }
    return compileReceipt(plan.length, completedSteps, phaseCounts);
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
    const runtimeTopologies = this.#runtimeTopologies;
    for (let index = 0; index < runtimeTopologies.length; index += 1) {
      drawScenePassSafely(
        this.#renderer,
        this.#rendererOperations,
        runtimeTopologies[index]!,
      );
    }
    renderOutputSafely(
      this.#renderer,
      this.#rendererOperations,
      this.#outputFirstUseTopology!.render,
      runtimeTopologies,
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposeRequested = true;
    this.#materialWarmupTopologies = intrinsicFreeze([]);
    this.#runtimeTopologies = intrinsicFreeze([]);
    this.#resources.dispose();
    this.#scenePasses.length = 0;
    this.#outputFirstUseTopology = null;
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
  readonly completedGraphs: Set<LinearHdrGraph>;
};

function captureOutputExposure(value: number): number {
  if (!Number.isFinite(value) || value < 0.25 || value > 4) {
    throw new RangeError("Linear HDR output exposure must be finite and between 0.25 and 4.");
  }
  return value;
}

function applyOutputExposure(renderer: unknown, exposure: number): void {
  if ((typeof renderer !== "object" || renderer === null) && typeof renderer !== "function") {
    throw new Error("Cannot apply Linear HDR output exposure without an attached renderer.");
  }
  const descriptor = intrinsicGetOwnPropertyDescriptor(renderer, "toneMappingExposure");
  if (!descriptor || !("value" in descriptor) || descriptor.writable !== true) {
    throw new TypeError("Renderer toneMappingExposure must be a writable own data property.");
  }
  intrinsicDefineProperty(renderer, "toneMappingExposure", {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    value: exposure,
    writable: descriptor.writable,
  });
}

export class ProductionLinearHdrPipeline implements LinearHdrPipelineFeature {
  readonly id = "gfx005-linear-hdr-pipeline" as const;
  readonly #graphFactory: LinearHdrGraphFactory;
  readonly #deduplicateProfileTopologies: boolean;
  readonly #history: TemporalHistoryOwner;
  readonly #graphs = new Map<LinearHdrPipelineProfileId, CapturedLinearHdrGraph>();
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
  #precompileSteps = 0;
  #precompileStepsAtReady: number | null = null;
  #precompileReceipt: Readonly<RenderPrecompileReceipt> | null = null;
  #programCountAtReady: number | null = null;
  #programGrowthAfterReady = 0;
  #exposure = 1;
  #disposedGraphs = 0;
  #disposePromise: Promise<void> | null = null;
  #disposeRequested = false;
  #activeOperations = 0;
  #operationDrain: ReturnType<typeof deferredVoid> | null = null;
  #pendingResize: PendingResizeTransaction | null = null;
  #externalGraphCallbackDepth = 0;
  #unsettledGraphCallbacks = 0;
  #unsettledGraphDisposeRejection: Promise<void> | null = null;
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
    this.#deduplicateProfileTopologies = options.graphFactory === undefined;
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

  update(frame: JourneyRenderSnapshot, clock: RenderOperationClock): void;
  update(): void {}

  render(recorder: RenderPassRecorder): void;
  render(): void {}

  setExposure(exposure: number): void {
    if (this.#state !== "ready" || this.#disposeRequested) {
      throw new Error(`Cannot set Linear HDR output exposure while ${this.#state}.`);
    }
    const captured = captureOutputExposure(exposure);
    applyOutputExposure(this.#renderer, captured);
    this.#exposure = captured;
  }

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
          completedGraphs: new Set<LinearHdrGraph>(),
        };
        this.#pendingResize = transaction;
      }
      const graphs: LinearHdrGraph[] = [];
      const scheduled = new Set<LinearHdrGraph>();
      intrinsicReflectApply(intrinsicMapForEach, this.#graphs, [(
        graph: LinearHdrGraph,
      ) => {
        if (intrinsicReflectApply(intrinsicSetHas, scheduled, [graph]) as boolean) return;
        intrinsicReflectApply(intrinsicSetAdd, scheduled, [graph]);
        appendArrayValue(graphs, graph);
      }]);
      for (let index = 0; index < graphs.length; index += 1) {
        const graph = graphs[index]!;
        if (intrinsicReflectApply(
          intrinsicSetHas,
          transaction.completedGraphs,
          [graph],
        ) as boolean) continue;
        await this.#invokeGraphCallback(() => graph.resize(transaction.viewport));
        intrinsicReflectApply(intrinsicSetAdd, transaction.completedGraphs, [graph]);
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

  async precompile(
    passes: readonly Readonly<RenderPass>[],
    candidateRunner: RenderCompileStepRunner,
  ): Promise<Readonly<RenderPrecompileReceipt>> {
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
      let runner: RenderCompileStepRunner;
      try {
        runner = captureCompileRunner(candidateRunner);
        capturedPasses = capturePipelinePasses(passes);
      } catch (error: unknown) {
        if (admittedState === "attached") {
          throw ownedAggregateError([error], "Linear HDR pipeline warm-up failed.");
        }
        throw error;
      }
      this.#assertExclusiveOperation("precompile", admittedState);
      this.#assertNoIncompleteResize("precompile the Linear HDR pipeline");
      return await this.#performPrecompile(capturedPasses, runner);
    } finally {
      release();
    }
  }

  async #performPrecompile(
    passes: readonly Readonly<RenderPass>[],
    runner: RenderCompileStepRunner,
  ): Promise<Readonly<RenderPrecompileReceipt>> {
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
      if (!this.#precompileReceipt) {
        throw new Error("A ready Linear HDR pipeline is missing its precompile receipt.");
      }
      return this.#precompileReceipt;
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
      const graphsInOrder: CapturedLinearHdrGraph[] = [];
      let temporalGraph: CapturedLinearHdrGraph | null = null;
      let staticGraph: CapturedLinearHdrGraph | null = null;
      for (let profileIndex = 0; profileIndex < profiles.length; profileIndex += 1) {
        const profile = profiles[profileIndex]!;
        const matchingGraph = this.#deduplicateProfileTopologies
          ? profile.temporal ? temporalGraph : staticGraph
          : null;
        if (matchingGraph !== null) {
          this.#graphs.set(profile.id, matchingGraph);
          continue;
        }
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
        let graph: CapturedLinearHdrGraph;
        try {
          graph = captureLinearHdrGraph(
            graphSource,
            profile,
            signature,
            fallbackCompilePlan(profile.id, runtimePasses, materialInventory),
            disposeMethod,
          );
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
        if (this.#deduplicateProfileTopologies) {
          if (profile.temporal) temporalGraph = graph;
          else staticGraph = graph;
        }
        appendArrayValue(graphsInOrder, graph);
      }

      // Every graph has now published an owned, exact inventory. Freeze the
      // aggregate plan before the first runner call, then validate every graph
      // callback against that plan in order.
      const fullPlan: Readonly<RenderCompileStepDescriptor>[] = [];
      const descriptorIds = new Set<string>();
      for (let graphIndex = 0; graphIndex < graphsInOrder.length; graphIndex += 1) {
        const graphPlan = graphsInOrder[graphIndex]!.compilePlan;
        for (let stepIndex = 0; stepIndex < graphPlan.length; stepIndex += 1) {
          const descriptor = graphPlan[stepIndex]!;
          if (intrinsicReflectApply(intrinsicSetHas, descriptorIds, [descriptor.id]) as boolean) {
            throw new Error(`Duplicate Linear HDR compile descriptor ${descriptor.id}.`);
          }
          intrinsicReflectApply(intrinsicSetAdd, descriptorIds, [descriptor.id]);
          appendArrayValue(fullPlan, descriptor);
        }
      }
      intrinsicFreeze(fullPlan);
      const phaseCounts = compilePhaseCounts();
      let completedSteps = 0;
      let nextPlanIndex = 0;
      const validatingRunner: RenderCompileStepRunner = intrinsicFreeze({
        run: async (
          descriptor: Readonly<RenderCompileStepDescriptor>,
          operation: () => void | Promise<void>,
        ): Promise<void> => {
          const expected = fullPlan[nextPlanIndex];
          if (!expected) throw new Error("A Linear HDR graph exceeded the aggregate compile plan.");
          assertExpectedCompileDescriptor(descriptor, expected);
          await runCompileStep(runner, expected, operation);
          phaseCounts[expected.phase] += 1;
          completedSteps += 1;
          nextPlanIndex += 1;
          this.#precompileSteps = completedSteps;
        },
      });
      for (let graphIndex = 0; graphIndex < graphsInOrder.length; graphIndex += 1) {
        const graph = graphsInOrder[graphIndex]!;
        const beforeCompleted = completedSteps;
        const beforePhaseCounts = { ...phaseCounts };
        const graphReceipt = await this.#invokeGraphCallback(
          () => graph.precompile(validatingRunner),
        );
        const expectedGraphCounts = compilePlanPhaseCounts(graph.compilePlan);
        const graphCompletedDelta = completedSteps - beforeCompleted;
        if (
          graphReceipt.plannedSteps !== graph.compilePlan.length
          || graphReceipt.completedSteps !== graphCompletedDelta
          || graphCompletedDelta !== graph.compilePlan.length
          || graphReceipt.phaseCounts["runtime-object"]
            !== phaseCounts["runtime-object"] - beforePhaseCounts["runtime-object"]
          || graphReceipt.phaseCounts["material-isolated"]
            !== phaseCounts["material-isolated"] - beforePhaseCounts["material-isolated"]
          || graphReceipt.phaseCounts["material-runtime-topology"]
            !== phaseCounts["material-runtime-topology"]
              - beforePhaseCounts["material-runtime-topology"]
          || graphReceipt.phaseCounts["output-first-use"]
            !== phaseCounts["output-first-use"] - beforePhaseCounts["output-first-use"]
          || graphReceipt.phaseCounts["runtime-object"] !== expectedGraphCounts["runtime-object"]
          || graphReceipt.phaseCounts["material-isolated"] !== expectedGraphCounts["material-isolated"]
          || graphReceipt.phaseCounts["material-runtime-topology"]
            !== expectedGraphCounts["material-runtime-topology"]
          || graphReceipt.phaseCounts["output-first-use"] !== expectedGraphCounts["output-first-use"]
        ) {
          throw new Error("A Linear HDR graph receipt did not match its runner calls and frozen plan.");
        }
      }
      if (nextPlanIndex !== fullPlan.length || completedSteps !== fullPlan.length) {
        throw new Error("The Linear HDR pipeline did not complete its aggregate compile plan.");
      }
      this.#warmedSignature = signature;
      this.#warmedMaterialSignature = materialSignature;
      this.#precompileStepsAtReady = this.#precompileSteps;
      this.#precompileReceipt = compileReceipt(fullPlan.length, completedSteps, phaseCounts);
      this.#programCountAtReady = rendererPrograms(this.#renderer);
      if (!this.#disposeRequested) this.#state = "ready";
      return this.#precompileReceipt;
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
    const uniqueGraphs = new Set<LinearHdrGraph>();
    let velocityOwned = false;
    let historyOwned = false;
    intrinsicReflectApply(intrinsicMapForEach, this.#graphs, [(
      graph: LinearHdrGraph,
      profileId: LinearHdrPipelineProfileId,
    ) => {
      appendArrayValue(warmedProfileIds, profileId);
      if (intrinsicReflectApply(intrinsicSetHas, uniqueGraphs, [graph]) as boolean) return;
      intrinsicReflectApply(intrinsicSetAdd, uniqueGraphs, [graph]);
      velocityOwned ||= graph.velocityOwned;
      historyOwned ||= graph.historyOwned;
    }]);
    const graphCount = intrinsicReflectApply(intrinsicSetSize, uniqueGraphs, []) as number;
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
      precompileSteps: this.#precompileSteps,
      precompileStepsAtReady: this.#precompileStepsAtReady,
      programCountAtReady: this.#programCountAtReady,
      programGrowthAfterReady: this.#programGrowthAfterReady,
      exposure: this.#exposure,
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
    // JavaScript does not expose browser-portable async provenance: after a
    // graph callback yields, an owner reentry and an ordinary external caller
    // are indistinguishable. Allowing either call to own disposal would let the
    // callback await disposal while disposal awaits the callback's operation.
    // Fail closed only for that ambiguous window, without claiming disposal or
    // resolving cleanup. All callers in one window share the same rejection;
    // after every callback settles they may retry and receive the real terminal
    // disposal promise.
    if (this.#unsettledGraphCallbacks !== 0) {
      this.#unsettledGraphDisposeRejection ??= Promise.reject(new Error(
        "Cannot dispose the Linear HDR pipeline while a graph callback is unsettled; retry after it settles.",
      ));
      return this.#unsettledGraphDisposeRejection;
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
    const graphs: LinearHdrGraph[] = [];
    const scheduled = new Set<LinearHdrGraph>();
    intrinsicReflectApply(intrinsicMapForEach, this.#graphs, [(
      graph: LinearHdrGraph,
    ) => {
      if (intrinsicReflectApply(intrinsicSetHas, scheduled, [graph]) as boolean) return;
      intrinsicReflectApply(intrinsicSetAdd, scheduled, [graph]);
      appendArrayValue(graphs, graph);
    }]);
    for (let index = 0; index < graphs.length; index += 1) {
      const graph = graphs[index]!;
      try {
        await this.#invokeGraphCallback(() => graph.dispose());
        const aliases: LinearHdrPipelineProfileId[] = [];
        intrinsicReflectApply(intrinsicMapForEach, this.#graphs, [(
          candidate: LinearHdrGraph,
          profileId: LinearHdrPipelineProfileId,
        ) => {
          if (candidate === graph) appendArrayValue(aliases, profileId);
        }]);
        for (let aliasIndex = 0; aliasIndex < aliases.length; aliasIndex += 1) {
          this.#graphs.delete(aliases[aliasIndex]!);
        }
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

  async #invokeGraphCallback<T>(callback: () => T): Promise<Awaited<T>> {
    this.#externalGraphCallbackDepth += 1;
    let result: T;
    try {
      result = callback();
    } finally {
      this.#externalGraphCallbackDepth -= 1;
    }
    const asynchronous = (
      (typeof result === "object" && result !== null)
      || typeof result === "function"
    );
    if (!asynchronous) return result as Awaited<T>;
    this.#unsettledGraphCallbacks += 1;
    try {
      return await result;
    } finally {
      this.#unsettledGraphCallbacks -= 1;
      if (this.#unsettledGraphCallbacks === 0) {
        this.#unsettledGraphDisposeRejection = null;
      }
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
