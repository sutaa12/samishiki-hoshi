import type { RenderQualityProfile, RendererApi } from "../contracts";
import {
  TSL_MATERIAL_VARIANT_IDS,
  type TslMaterialVariantId,
} from "./contracts";

const variants = new Set<string>(TSL_MATERIAL_VARIANT_IDS);

export function isTslMaterialVariantId(value: unknown): value is TslMaterialVariantId {
  return typeof value === "string" && variants.has(value);
}

export function reachableTslMaterialVariants(
  actualApi: RendererApi,
): readonly TslMaterialVariantId[] {
  return actualApi === "WebGPU"
    ? Object.freeze(["webgpu-full", "webgpu-lean"] as const)
    : Object.freeze(["webgl2-full", "webgl2-lean"] as const);
}

export function selectTslMaterialVariant(
  actualApi: RendererApi,
  profile: Readonly<RenderQualityProfile>,
): TslMaterialVariantId {
  const tier = profile.tier;
  if (tier !== "low" && tier !== "balanced" && tier !== "high") {
    throw new TypeError(`Unsupported render quality tier: ${String(tier)}.`);
  }
  const suffix = tier === "low" ? "lean" : "full";
  return `${actualApi === "WebGPU" ? "webgpu" : "webgl2"}-${suffix}` as TslMaterialVariantId;
}
