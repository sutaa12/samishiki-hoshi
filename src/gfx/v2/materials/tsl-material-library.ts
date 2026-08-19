import {
  AmbientLight,
  BoxGeometry,
  Material,
  Mesh,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Scene,
} from "three/webgpu";
import { float, vec3 } from "three/tsl";
import type {
  RenderPass,
  RenderQualityProfile,
  RenderServiceInitializationContext,
  RendererApi,
} from "../contracts";
import {
  WORLD_MATERIAL_FAMILIES,
  WORLD_MATERIAL_LIBRARY,
  type WorldMaterialDescriptor,
  type WorldMaterialFamily,
  type WorldMaterialShadingModel,
} from "../../../world/v2";
import {
  type CreateTslMaterialLibraryOptions,
  type OwnedTslMaterial,
  type TslMaterialFactory,
  type TslMaterialHandle,
  type TslMaterialLibrary,
  type TslMaterialLibrarySnapshot,
  type TslMaterialVariantId,
  type TslMaterialVariantManifestEntry,
} from "./contracts";
import {
  reachableTslMaterialVariants,
  selectTslMaterialVariant,
} from "./variant-catalog";
import { ownedAggregateError } from "./failures";

const trustedArrayIsArray = Array.isArray;
const trustedArrayPrototype = Array.prototype;
const trustedNumberIsInteger = Number.isInteger;
const trustedObjectDefineProperty = Object.defineProperty;
const trustedObjectFreeze = Object.freeze;
const trustedObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const trustedObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const trustedObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols;
const trustedObjectGetPrototypeOf = Object.getPrototypeOf;
const trustedObjectPrototype = Object.prototype;
const trustedReflectApply = Reflect.apply;
const trustedSetHas = Set.prototype.has;
const trustedString = String;

export const GFX005_MATERIAL_WARMUP_KIND = "gfx005-material-warmup";

const descriptorKeys = Object.freeze([
  "id",
  "family",
  "shadingModel",
  "baseColorLinearPermille",
  "roughnessPermille",
  "metalnessPermille",
  "transmissionPermille",
  "emissionLinearPermille",
] as const);

const shadingModels = new Set<WorldMaterialShadingModel>([
  "dielectric",
  "conductor",
  "transmissive-dielectric",
  "emissive-dielectric",
]);

function ownData(record: object, key: string): unknown {
  const descriptor = trustedObjectGetOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError(`Material descriptor ${key} must be an enumerable own data property.`);
  }
  return descriptor.value;
}

function capturePermilleTuple(
  value: unknown,
  label: string,
  length: 2 | 3,
): readonly number[] {
  if (!trustedArrayIsArray(value) || trustedObjectGetPrototypeOf(value) !== trustedArrayPrototype) {
    throw new TypeError(`${label} must be a plain dense array.`);
  }
  const names = trustedObjectGetOwnPropertyNames(value);
  if (names.length !== length + 1) {
    throw new TypeError(`${label} must not be sparse or contain extra properties.`);
  }
  for (let index = 0; index < length; index += 1) {
    if (names[index] !== trustedString(index)) {
      throw new TypeError(`${label} must not be sparse or contain extra properties.`);
    }
  }
  if (names[length] !== "length") {
    throw new TypeError(`${label} must not be sparse or contain extra properties.`);
  }
  if (trustedObjectGetOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must not contain symbol properties.`);
  }
  const result: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const indexName = trustedString(index);
    const entry = ownData(value, indexName);
    if (!trustedNumberIsInteger(entry) || (entry as number) < 0 || (entry as number) > 1000) {
      throw new RangeError(`${label}[${index}] must be an integer from 0 through 1000.`);
    }
    trustedObjectDefineProperty(result, indexName, {
      configurable: true,
      enumerable: true,
      value: entry,
      writable: true,
    });
  }
  if (length === 2 && result[0]! > result[1]!) {
    throw new RangeError(`${label} minimum must not exceed its maximum.`);
  }
  return trustedObjectFreeze(result);
}

function captureDescriptor(
  value: unknown,
  expectedFamily: WorldMaterialFamily,
): Readonly<WorldMaterialDescriptor> {
  if (
    typeof value !== "object"
    || value === null
    || trustedObjectGetPrototypeOf(value) !== trustedObjectPrototype
  ) {
    throw new TypeError("Material descriptors must be plain objects.");
  }
  const record = value as object;
  const names = trustedObjectGetOwnPropertyNames(record);
  let namesCanonical = names.length === descriptorKeys.length;
  for (let nameIndex = 0; namesCanonical && nameIndex < names.length; nameIndex += 1) {
    let recognized = false;
    for (let keyIndex = 0; keyIndex < descriptorKeys.length; keyIndex += 1) {
      if (names[nameIndex] === descriptorKeys[keyIndex]) {
        recognized = true;
        break;
      }
    }
    if (!recognized) namesCanonical = false;
  }
  if (!namesCanonical || trustedObjectGetOwnPropertySymbols(record).length !== 0) {
    throw new TypeError("Material descriptors must contain only the canonical fields.");
  }
  const id = ownData(record, "id");
  const family = ownData(record, "family");
  const shadingModel = ownData(record, "shadingModel");
  if (family !== expectedFamily || id !== `material:${expectedFamily}`) {
    throw new TypeError(`Expected canonical material descriptor ${expectedFamily}.`);
  }
  if (
    typeof shadingModel !== "string"
    || !trustedReflectApply(trustedSetHas, shadingModels, [shadingModel])
  ) {
    throw new TypeError(`Material ${expectedFamily} has an unsupported shading model.`);
  }
  const baseColorLinearPermille = capturePermilleTuple(
    ownData(record, "baseColorLinearPermille"),
    `${expectedFamily}.baseColorLinearPermille`,
    3,
  ) as readonly [number, number, number];
  const roughnessPermille = capturePermilleTuple(
    ownData(record, "roughnessPermille"),
    `${expectedFamily}.roughnessPermille`,
    2,
  ) as readonly [number, number];
  const metalnessPermille = capturePermilleTuple(
    ownData(record, "metalnessPermille"),
    `${expectedFamily}.metalnessPermille`,
    2,
  ) as readonly [number, number];
  const transmissionPermille = capturePermilleTuple(
    ownData(record, "transmissionPermille"),
    `${expectedFamily}.transmissionPermille`,
    2,
  ) as readonly [number, number];
  const emissionLinearPermille = capturePermilleTuple(
    ownData(record, "emissionLinearPermille"),
    `${expectedFamily}.emissionLinearPermille`,
    2,
  ) as readonly [number, number];
  return trustedObjectFreeze({
    id: id as string,
    family: family as WorldMaterialFamily,
    shadingModel: shadingModel as WorldMaterialShadingModel,
    baseColorLinearPermille,
    roughnessPermille,
    metalnessPermille,
    transmissionPermille,
    emissionLinearPermille,
  });
}

export function captureWorldMaterialLibrary(
  source: unknown,
): readonly Readonly<WorldMaterialDescriptor>[] {
  if (!trustedArrayIsArray(source) || trustedObjectGetPrototypeOf(source) !== trustedArrayPrototype) {
    throw new TypeError("The world material library must be a plain dense array.");
  }
  const lengthDescriptor = trustedObjectGetOwnPropertyDescriptor(source, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (length !== WORLD_MATERIAL_FAMILIES.length) {
    throw new RangeError(`The world material library requires exactly ${WORLD_MATERIAL_FAMILIES.length} entries.`);
  }
  const names = trustedObjectGetOwnPropertyNames(source);
  if (names.length !== WORLD_MATERIAL_FAMILIES.length + 1) {
    throw new TypeError("The world material library must be dense and contain no extra properties.");
  }
  for (let index = 0; index < WORLD_MATERIAL_FAMILIES.length; index += 1) {
    if (names[index] !== trustedString(index)) {
      throw new TypeError("The world material library must be dense and contain no extra properties.");
    }
  }
  if (names[WORLD_MATERIAL_FAMILIES.length] !== "length") {
    throw new TypeError("The world material library must be dense and contain no extra properties.");
  }
  if (trustedObjectGetOwnPropertySymbols(source).length !== 0) {
    throw new TypeError("The world material library must not contain symbol properties.");
  }
  const captured: Readonly<WorldMaterialDescriptor>[] = [];
  for (let index = 0; index < WORLD_MATERIAL_FAMILIES.length; index += 1) {
    const indexName = trustedString(index);
    trustedObjectDefineProperty(captured, indexName, {
      configurable: true,
      enumerable: true,
      value: captureDescriptor(ownData(source, indexName), WORLD_MATERIAL_FAMILIES[index]!),
      writable: true,
    });
  }
  return trustedObjectFreeze(captured);
}

function midpoint(range: readonly [number, number]): number {
  return (range[0] + range[1]) / 2000;
}

function defaultMaterialFactory(
  descriptor: Readonly<WorldMaterialDescriptor>,
  variantId: TslMaterialVariantId,
): OwnedTslMaterial {
  const transmission = midpoint(descriptor.transmissionPermille);
  const needsPhysical = descriptor.shadingModel === "transmissive-dielectric"
    || descriptor.family === "foliage"
    || transmission > 0;
  const material = needsPhysical
    ? new MeshPhysicalNodeMaterial()
    : new MeshStandardNodeMaterial();
  const [red, green, blue] = descriptor.baseColorLinearPermille.map((entry) => entry / 1000);
  const lean = variantId.endsWith("-lean");
  const roughness = midpoint(descriptor.roughnessPermille);
  const metalness = midpoint(descriptor.metalnessPermille);
  const emission = midpoint(descriptor.emissionLinearPermille) * (lean ? 0.72 : 1);
  material.name = `gfx005:${descriptor.family}:${variantId}`;
  material.colorNode = vec3(red!, green!, blue!);
  material.roughnessNode = float(Math.min(1, roughness + (lean ? 0.08 : 0)));
  material.metalnessNode = float(metalness);
  material.emissiveNode = vec3(red!, green!, blue!).mul(emission);
  material.toneMapped = false;
  material.userData.gfx005 = Object.freeze({
    family: descriptor.family,
    variantId,
    colorSpace: "linear",
    baseColorLinear: Object.freeze([red!, green!, blue!]),
    roughness,
    metalness,
    transmission,
    emission,
  });
  if (material instanceof MeshPhysicalNodeMaterial) {
    material.transmissionNode = float(lean ? transmission * 0.65 : transmission);
    material.ior = descriptor.family === "water" ? 1.333 : 1.45;
    material.thickness = lean ? 0.02 : 0.08;
  }
  return material;
}

type CapturedMaterialDisposal = Readonly<{
  readonly target: object;
  readonly dispose: (() => void) | null;
  readonly ownershipVerified: boolean;
  readonly attempted: boolean;
}>;

const trustedThreeMaterialDispose = Material.prototype.dispose;

function captureUnverifiedFactoryOwnership(value: unknown): CapturedMaterialDisposal | null {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return null;
  }
  const target = value as object;
  const descriptor = Object.getOwnPropertyDescriptor(target, "dispose");
  const dispose = descriptor && "value" in descriptor && typeof descriptor.value === "function"
    ? descriptor.value
    : null;
  return Object.freeze({
    target,
    dispose: dispose
      ? () => trustedReflectApply(dispose, target, [])
      : null,
    ownershipVerified: false,
    attempted: false,
  });
}

function libraryOwnedThreeDisposal(target: OwnedTslMaterial): CapturedMaterialDisposal {
  return Object.freeze({
    target,
    dispose: () => trustedReflectApply(trustedThreeMaterialDispose, target, []),
    ownershipVerified: true,
    attempted: false,
  });
}

function actualApiFrom(context: RenderServiceInitializationContext): RendererApi {
  const actualApi = context.backend.facts.actualApi;
  if (actualApi !== "WebGPU" && actualApi !== "WebGL2") {
    throw new Error("The TSL material library requires an initialized backend with an actual API.");
  }
  return actualApi;
}

function captureQualityTier(
  profile: Readonly<RenderQualityProfile>,
): RenderQualityProfile["tier"] {
  if (typeof profile !== "object" || profile === null) {
    throw new TypeError("A render quality profile must be an object.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(profile, "tier");
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError("Render quality tier must be an own data property.");
  }
  const tier = descriptor.value;
  if (tier !== "low" && tier !== "balanced" && tier !== "high") {
    throw new TypeError("Unsupported render quality tier.");
  }
  return tier;
}

type QualityAdmission = {
  valid: boolean;
};

export class ProductionTslMaterialLibrary implements TslMaterialLibrary {
  readonly #descriptors: readonly Readonly<WorldMaterialDescriptor>[];
  readonly #customFactory: TslMaterialFactory | null;
  readonly #materials = new Map<TslMaterialVariantId, Map<WorldMaterialFamily, Readonly<TslMaterialHandle>>>();
  readonly #warmupPasses: RenderPass[] = [];
  readonly #manifest: TslMaterialVariantManifestEntry[] = [];
  readonly #ownedMaterials = new Map<object, CapturedMaterialDisposal>();
  #warmupGeometry: BoxGeometry | null = null;
  #state: TslMaterialLibrarySnapshot["state"] = "new";
  #actualApi: RendererApi | null = null;
  #activeVariantId: TslMaterialVariantId | null = null;
  #createdMaterials = 0;
  #disposedMaterials = 0;
  #initializePromise: Promise<void> | null = null;
  #disposePromise: Promise<void> | null = null;
  #disposeRequested = false;
  #qualityAdmission: QualityAdmission | null = null;

  constructor(options: CreateTslMaterialLibraryOptions = {}) {
    this.#descriptors = captureWorldMaterialLibrary(options.descriptors ?? WORLD_MATERIAL_LIBRARY);
    this.#customFactory = options.createMaterial ?? null;
  }

  initialize(context: RenderServiceInitializationContext): Promise<void> {
    if (this.#initializePromise) return this.#initializePromise;
    if (this.#state !== "new" || this.#disposeRequested) {
      return Promise.reject(new Error(`Cannot initialize TSL materials while ${this.#state}.`));
    }
    this.#state = "initializing";
    let resolveInitialization!: () => void;
    let rejectInitialization!: (error: unknown) => void;
    const initialization = new Promise<void>((resolve, reject) => {
      resolveInitialization = resolve;
      rejectInitialization = reject;
    });
    this.#initializePromise = initialization;
    void this.#performInitialize(context).then(resolveInitialization, rejectInitialization);
    return initialization;
  }

  async #performInitialize(context: RenderServiceInitializationContext): Promise<void> {
    try {
      this.#assertInitializationNotDisposed();
      const actualApi = actualApiFrom(context);
      this.#assertInitializationNotDisposed();
      this.#actualApi = actualApi;
      const variants = reachableTslMaterialVariants(actualApi);
      this.#activeVariantId = variants[0]!;
      this.#warmupGeometry = new BoxGeometry(0.01, 0.01, 0.01);
      const camera = new PerspectiveCamera(50, 1, 0.01, 2);
      camera.position.z = 0.2;
      for (const variantId of variants) {
        const familyMaterials = new Map<WorldMaterialFamily, Readonly<TslMaterialHandle>>();
        for (const descriptor of this.#descriptors) {
          const factoryContext = Object.freeze({ descriptor, variantId });
          if (this.#customFactory) {
            const candidate: unknown = this.#customFactory(factoryContext);
            let ownership: CapturedMaterialDisposal | null;
            try {
              ownership = captureUnverifiedFactoryOwnership(candidate);
            } catch (error: unknown) {
              if (
                candidate !== null
                && (typeof candidate === "object" || typeof candidate === "function")
              ) {
                this.#claimMaterial(Object.freeze({
                  target: candidate,
                  dispose: null,
                  ownershipVerified: false,
                  attempted: false,
                }));
              }
              throw error;
            }
            if (ownership) this.#claimMaterial(ownership);
            this.#assertInitializationNotDisposed();
            throw new TypeError(
              "Custom material factory outputs are unsupported because native ownership provenance cannot be verified.",
            );
          }
          const material = defaultMaterialFactory(descriptor, variantId);
          this.#claimMaterial(libraryOwnedThreeDisposal(material));
          const handle = Object.freeze({
            id: `${descriptor.id}:${variantId}`,
            family: descriptor.family,
            variantId,
            material,
          });
          familyMaterials.set(descriptor.family, handle);
          const scene = new Scene();
          scene.name = `gfx005-material-warmup:${descriptor.family}:${variantId}`;
          scene.add(new Mesh(this.#warmupGeometry, material), new AmbientLight(0xffffff, 1));
          this.#assertInitializationNotDisposed();
          const warmupPassName = `gfx005-material:${descriptor.family}`;
          this.#warmupPasses.push(Object.freeze({
            name: warmupPassName,
            kind: GFX005_MATERIAL_WARMUP_KIND,
            variant: variantId,
            scene,
            camera,
          }));
          this.#manifest.push(Object.freeze({
            family: descriptor.family,
            descriptorId: descriptor.id,
            variantId,
            warmupPassName,
          }));
        }
        this.#materials.set(variantId, familyMaterials);
      }
      this.#assertInitializationNotDisposed();
      this.#state = "ready";
    } catch (error: unknown) {
      this.#state = "failed";
      const failures: unknown[] = [error];
      try {
        await this.#disposeOwnedResources();
      } catch (cleanupError: unknown) {
        failures.push(cleanupError);
      }
      throw ownedAggregateError(failures, "TSL material initialization failed.");
    }
  }

  warmupPasses(profiles?: readonly Readonly<RenderQualityProfile>[]): readonly RenderPass[];
  warmupPasses(): readonly RenderPass[] {
    this.#assertReady("read material warm-up passes");
    return Object.freeze(this.#warmupPasses.slice());
  }

  quality(profile: Readonly<RenderQualityProfile>): void {
    this.#assertReady("select material quality");
    const admission: QualityAdmission = { valid: true };
    this.#qualityAdmission = admission;
    try {
      const tier = captureQualityTier(profile);
      if (
        this.#qualityAdmission !== admission
        || !admission.valid
        || this.#state !== "ready"
        || this.#disposeRequested
      ) {
        throw new Error("Material quality selection lost exclusive admission.");
      }
      const capturedProfile: Readonly<RenderQualityProfile> = Object.freeze({
        tier,
        pixelRatio: 1,
        uploadBudgetMs: 0,
        features: Object.freeze({}),
      });
      this.#activeVariantId = selectTslMaterialVariant(this.#actualApi!, capturedProfile);
    } finally {
      if (this.#qualityAdmission === admission) this.#qualityAdmission = null;
    }
  }

  resolve(family: WorldMaterialFamily): Readonly<TslMaterialHandle> {
    this.#assertReady("resolve a material");
    if (!WORLD_MATERIAL_FAMILIES.includes(family)) {
      throw new TypeError(`Unknown world material family: ${String(family)}.`);
    }
    const handle = this.#materials.get(this.#activeVariantId!)?.get(family);
    if (!handle) throw new Error(`Material ${family}/${this.#activeVariantId} was not warmed.`);
    return handle;
  }

  variantManifest(): readonly Readonly<TslMaterialVariantManifestEntry>[] {
    this.#assertReady("read the material variant manifest");
    return Object.freeze(this.#manifest.slice());
  }

  snapshot(): Readonly<TslMaterialLibrarySnapshot> {
    return Object.freeze({
      state: this.#state,
      actualApi: this.#actualApi,
      activeVariantId: this.#activeVariantId,
      createdMaterials: this.#createdMaterials,
      disposedMaterials: this.#disposedMaterials,
      ownedMaterials: this.#ownedMaterials.size,
      ownedGeometry: this.#warmupGeometry === null ? 0 : 1,
      warmupPasses: this.#warmupPasses.length,
      variants: Object.freeze([...this.#materials.keys()]),
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposeRequested = true;
    if (this.#qualityAdmission) this.#qualityAdmission.valid = false;
    if (
      this.#state === "new"
      || this.#state === "ready"
      || this.#state === "failed"
    ) {
      this.#state = "disposing";
    }
    this.#disposePromise = this.#performDispose();
    return this.#disposePromise;
  }

  async #performDispose(): Promise<void> {
    await this.#initializePromise?.catch(() => undefined);
    if (this.#state === "disposed") return;
    this.#state = "disposing";
    try {
      await this.#disposeOwnedResources();
      this.#state = "disposed";
    } catch (error: unknown) {
      this.#state = "failed";
      if (this.#ownedMaterials.size > 0 || this.#warmupGeometry !== null) {
        this.#disposePromise = null;
      }
      throw error;
    }
  }

  async #disposeOwnedResources(): Promise<void> {
    const failures: unknown[] = [];
    for (const [target, material] of [...this.#ownedMaterials]) {
      if (!material.ownershipVerified) {
        if (!material.attempted && material.dispose) {
          this.#ownedMaterials.set(target, Object.freeze({
            ...material,
            attempted: true,
          }));
          try {
            material.dispose();
          } catch (error: unknown) {
            failures.push(error);
          }
        }
        failures.push(new Error(
          "Material ownership remains unresolved because Three.js brand inspection did not complete.",
        ));
        continue;
      }
      if (!material.dispose) {
        failures.push(new Error("Verified material ownership is missing its disposal callback."));
        continue;
      }
      try {
        material.dispose();
        this.#disposedMaterials += 1;
        this.#ownedMaterials.delete(target);
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    try {
      this.#warmupGeometry?.dispose();
      this.#warmupGeometry = null;
    } catch (error: unknown) {
      failures.push(error);
    }
    this.#warmupPasses.length = 0;
    this.#manifest.length = 0;
    this.#materials.clear();
    if (failures.length > 0) throw ownedAggregateError(failures, "TSL material disposal failed.");
  }

  #claimMaterial(disposal: CapturedMaterialDisposal): void {
    if (this.#ownedMaterials.has(disposal.target)) {
      throw new Error("The material factory returned the same owned material twice.");
    }
    this.#ownedMaterials.set(disposal.target, disposal);
    this.#createdMaterials += 1;
  }

  #assertReady(operation: string): void {
    if (this.#qualityAdmission) {
      this.#qualityAdmission.valid = false;
      throw new Error(
        `Cannot ${operation} while TSL material quality selection is active.`,
      );
    }
    if (this.#state !== "ready" || this.#disposeRequested) {
      throw new Error(`Cannot ${operation} while TSL materials are ${this.#state}.`);
    }
  }

  #assertInitializationNotDisposed(): void {
    if (this.#disposeRequested) {
      throw new Error("TSL material initialization was interrupted by disposal.");
    }
  }
}

export function createTslMaterialLibrary(
  options: CreateTslMaterialLibraryOptions = {},
): TslMaterialLibrary {
  return new ProductionTslMaterialLibrary(options);
}
