import type {
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import type {
  RenderMaterialLibrary,
  RenderPass,
  RenderQualityProfile,
  RendererApi,
} from "../contracts";
import type {
  WorldMaterialDescriptor,
  WorldMaterialFamily,
} from "../../../world/v2";

export const TSL_MATERIAL_VARIANT_IDS = Object.freeze([
  "webgpu-full",
  "webgpu-lean",
  "webgl2-full",
  "webgl2-lean",
] as const);

export type TslMaterialVariantId = (typeof TSL_MATERIAL_VARIANT_IDS)[number];

export type OwnedTslMaterial = MeshStandardNodeMaterial | MeshPhysicalNodeMaterial;

export interface TslMaterialHandle {
  readonly id: string;
  readonly family: WorldMaterialFamily;
  readonly variantId: TslMaterialVariantId;
  /** Borrowed renderer object. Only the library may mutate or dispose it. */
  readonly material: OwnedTslMaterial;
}

export interface TslMaterialVariantManifestEntry {
  readonly family: WorldMaterialFamily;
  readonly descriptorId: string;
  readonly variantId: TslMaterialVariantId;
  readonly warmupPassName: string;
}

export interface TslMaterialLibrarySnapshot {
  readonly state: "new" | "initializing" | "ready" | "disposing" | "disposed" | "failed";
  readonly actualApi: RendererApi | null;
  readonly activeVariantId: TslMaterialVariantId | null;
  readonly createdMaterials: number;
  readonly disposedMaterials: number;
  readonly ownedMaterials: number;
  readonly ownedGeometry: 0 | 1;
  readonly warmupPasses: number;
  readonly variants: readonly TslMaterialVariantId[];
}

export interface TslMaterialLibrary extends RenderMaterialLibrary {
  resolve(family: WorldMaterialFamily): Readonly<TslMaterialHandle>;
  variantManifest(): readonly Readonly<TslMaterialVariantManifestEntry>[];
  snapshot(): Readonly<TslMaterialLibrarySnapshot>;
}

export interface TslMaterialFactoryContext {
  readonly descriptor: Readonly<WorldMaterialDescriptor>;
  readonly variantId: TslMaterialVariantId;
}

export type TslMaterialFactory = (
  context: Readonly<TslMaterialFactoryContext>,
) => OwnedTslMaterial;

export interface CreateTslMaterialLibraryOptions {
  readonly descriptors?: unknown;
  /**
   * Legacy diagnostic seam. Returned objects have no library ownership provenance,
   * so initialization rejects them fail-closed after bounded best-effort cleanup.
   */
  readonly createMaterial?: TslMaterialFactory;
}

export interface TslMaterialWarmupPlan {
  readonly profiles: readonly Readonly<RenderQualityProfile>[];
  readonly passes: readonly Readonly<RenderPass>[];
}
