import type { WebGPURenderer } from "three/webgpu";

export type GfxRequestedBackend = "webgpu-preferred" | "forced-webgl2";
export type GfxActualBackend = "webgpu" | "webgl2";
export type GfxCapabilityTier = "capability-tier-0" | "capability-tier-1" | "capability-tier-2";

export type GfxResourceCounters = {
  geometries: number;
  attributes: number;
  indexAttributes: number;
  programs: number;
  textures: number;
  renderTargets: number;
  trackedBytes: number;
};

export type GfxNavigatorAdapterProbe = {
  source: "navigator.gpu.requestAdapter probe; not renderer adapter identity";
  available: boolean;
  durationMs: number;
  vendor: string | null;
  architecture: string | null;
  device: string | null;
  description: string | null;
  error: string | null;
};

export type GfxSceneEvidence = {
  uniqueMaterialCount: number;
  nodeMaterialCount: number;
  nodeMaterialsWithAssignedNodes: number;
  nodeMaterialTypes: string[];
};

export type GfxPrecompileEvidence = {
  method: "renderer.compileAsync(scene, camera)";
  completed: boolean;
  durationMs: number;
  completedAtMs: number;
  firstRenderStartedAtMs: number;
  completedBeforeFirstRender: boolean;
};

export type GfxTelemetry = {
  scope: "experimental-webgpu-lab-only";
  requestedBackend: GfxRequestedBackend;
  actualBackend: GfxActualBackend;
  actualBackendAuthority: "renderer.backend flags observed after init";
  fallbackUsed: boolean;
  capabilityTier: GfxCapabilityTier;
  tierBasis: string;
  webgpuApiExposed: boolean;
  webgpuAdapterProbeAvailable: boolean;
  navigatorAdapterProbe: GfxNavigatorAdapterProbe;
  webgl2ApiAvailable: boolean;
  sceneEvidence: GfxSceneEvidence;
  precompile: GfxPrecompileEvidence;
  initMs: number;
  firstRenderMs: number;
  drawCalls: number;
  triangles: number;
  resources: GfxResourceCounters;
  maxAnisotropy: number;
  compatibilityMode: boolean | null;
  features: string[];
  limits: Record<string, number | null>;
  backendIdentity: {
    source: "renderer WebGL2 context" | "renderer WebGPU device; adapter identity unavailable";
    vendor: string | null;
    renderer: string | null;
    version: string | null;
  };
};

type AdapterInfoProbe = {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
};

type AdapterProbe = { info?: AdapterInfoProbe };
type NavigatorGpuProbe = {
  requestAdapter: (options?: { powerPreference?: string; featureLevel?: string }) => Promise<AdapterProbe | null>;
};

type DeviceProbe = {
  features?: Iterable<string>;
  limits?: object;
};

type BackendProbe = {
  isWebGPUBackend?: boolean;
  isWebGLBackend?: boolean;
  compatibilityMode?: boolean | null;
  device?: DeviceProbe | null;
};

function readNumber(record: object | null | undefined, key: string): number | null {
  if (!record || !(key in record)) return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function probeNavigatorWebGPUAdapter(): Promise<{
  apiExposed: boolean;
  probe: GfxNavigatorAdapterProbe;
}> {
  const startedAt = performance.now();
  const gpu = (navigator as Navigator & { gpu?: NavigatorGpuProbe }).gpu;
  if (!gpu) {
    return {
      apiExposed: false,
      probe: {
        source: "navigator.gpu.requestAdapter probe; not renderer adapter identity",
        available: false,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
        vendor: null,
        architecture: null,
        device: null,
        description: null,
        error: "navigator.gpu is not exposed",
      },
    };
  }

  try {
    const adapter = await gpu.requestAdapter({
      powerPreference: "high-performance",
      featureLevel: "compatibility",
    });
    const info = adapter?.info;
    return {
      apiExposed: true,
      probe: {
        source: "navigator.gpu.requestAdapter probe; not renderer adapter identity",
        available: adapter !== null,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
        vendor: readString(info?.vendor),
        architecture: readString(info?.architecture),
        device: readString(info?.device),
        description: readString(info?.description),
        error: adapter === null ? "requestAdapter returned null" : null,
      },
    };
  } catch (error) {
    return {
      apiExposed: true,
      probe: {
        source: "navigator.gpu.requestAdapter probe; not renderer adapter identity",
        available: false,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
        vendor: null,
        architecture: null,
        device: null,
        description: null,
        error: errorMessage(error),
      },
    };
  }
}

export function canCreateWebGL2Context(): boolean {
  const probe = document.createElement("canvas");
  const context = probe.getContext("webgl2");
  if (!context) return false;
  context.getExtension("WEBGL_lose_context")?.loseContext();
  return true;
}

export function collectResourceCounters(renderer: WebGPURenderer): GfxResourceCounters {
  return {
    geometries: renderer.info.memory.geometries,
    attributes: renderer.info.memory.attributes,
    indexAttributes: renderer.info.memory.indexAttributes,
    programs: renderer.info.memory.programs,
    textures: renderer.info.memory.textures,
    renderTargets: renderer.info.memory.renderTargets,
    trackedBytes: renderer.info.memory.total,
  };
}

function webGlDetails(context: WebGL2RenderingContext): Pick<
  GfxTelemetry,
  "features" | "limits" | "backendIdentity" | "compatibilityMode"
> {
  const rendererInfo = context.getExtension("WEBGL_debug_renderer_info");
  const vendor = rendererInfo
    ? readString(context.getParameter(rendererInfo.UNMASKED_VENDOR_WEBGL))
    : readString(context.getParameter(context.VENDOR));
  const renderer = rendererInfo
    ? readString(context.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL))
    : readString(context.getParameter(context.RENDERER));

  return {
    features: [...(context.getSupportedExtensions() ?? [])].sort(),
    limits: {
      maxTextureDimension2D: context.getParameter(context.MAX_TEXTURE_SIZE) as number,
      maxCubeMapTextureDimension: context.getParameter(context.MAX_CUBE_MAP_TEXTURE_SIZE) as number,
      maxRenderbufferSize: context.getParameter(context.MAX_RENDERBUFFER_SIZE) as number,
      maxSamples: context.getParameter(context.MAX_SAMPLES) as number,
      maxVertexUniformVectors: context.getParameter(context.MAX_VERTEX_UNIFORM_VECTORS) as number,
    },
    backendIdentity: {
      source: "renderer WebGL2 context",
      vendor,
      renderer,
      version: readString(context.getParameter(context.VERSION)),
    },
    compatibilityMode: null,
  };
}

function webGpuDetails(backend: BackendProbe): Pick<
  GfxTelemetry,
  "features" | "limits" | "backendIdentity" | "compatibilityMode"
> {
  const device = backend.device;
  const limits = device?.limits;
  return {
    features: device?.features ? [...device.features].sort() : [],
    limits: {
      maxTextureDimension2D: readNumber(limits, "maxTextureDimension2D"),
      maxTextureArrayLayers: readNumber(limits, "maxTextureArrayLayers"),
      maxBindGroups: readNumber(limits, "maxBindGroups"),
      maxUniformBufferBindingSize: readNumber(limits, "maxUniformBufferBindingSize"),
      maxStorageBufferBindingSize: readNumber(limits, "maxStorageBufferBindingSize"),
    },
    backendIdentity: {
      source: "renderer WebGPU device; adapter identity unavailable",
      vendor: null,
      renderer: null,
      version: null,
    },
    compatibilityMode: backend.compatibilityMode ?? null,
  };
}

function capabilityTier(
  actualBackend: GfxActualBackend,
  compatibilityMode: boolean | null,
  limits: Record<string, number | null>,
): Pick<GfxTelemetry, "capabilityTier" | "tierBasis"> {
  const textureSize = limits.maxTextureDimension2D ?? 0;
  if (actualBackend === "webgpu") {
    if (compatibilityMode === false && textureSize >= 8192) {
      return {
        capabilityTier: "capability-tier-2",
        tierBasis: "Core WebGPU feature level with >=8192 2D texture limit; capability heuristic, not a hardware or performance benchmark.",
      };
    }
    return {
      capabilityTier: "capability-tier-1",
      tierBasis: "WebGPU compatibility feature level or a constrained texture limit; capability heuristic, not a performance benchmark.",
    };
  }

  const maxSamples = limits.maxSamples ?? 0;
  if (textureSize >= 8192 && maxSamples >= 4) {
    return {
      capabilityTier: "capability-tier-1",
      tierBasis: "WebGL2 with >=8192 2D texture limit and >=4 samples; capability heuristic, not a performance benchmark.",
    };
  }
  return {
    capabilityTier: "capability-tier-0",
    tierBasis: "WebGL2 baseline below the spike's tier-1 texture or sample heuristic; not a performance benchmark.",
  };
}

export function collectGfxTelemetry(options: {
  renderer: WebGPURenderer;
  requestedBackend: GfxRequestedBackend;
  webgl2ApiAvailable: boolean;
  webgpuApiExposed: boolean;
  navigatorAdapterProbe: GfxNavigatorAdapterProbe;
  sceneEvidence: GfxSceneEvidence;
  precompile: GfxPrecompileEvidence;
  initMs: number;
  firstRenderMs: number;
}): GfxTelemetry {
  const { renderer, requestedBackend } = options;
  const backend = renderer.backend as unknown as BackendProbe;
  const actualBackend: GfxActualBackend = backend.isWebGPUBackend === true
    ? "webgpu"
    : backend.isWebGLBackend === true
      ? "webgl2"
      : (() => {
          throw new Error("Initialized renderer did not expose a recognized WebGPU or WebGL2 backend.");
        })();
  const details = actualBackend === "webgpu"
    ? webGpuDetails(backend)
    : webGlDetails(renderer.getContext() as WebGL2RenderingContext);
  const tier = capabilityTier(actualBackend, details.compatibilityMode, details.limits);

  return {
    scope: "experimental-webgpu-lab-only",
    requestedBackend,
    actualBackend,
    actualBackendAuthority: "renderer.backend flags observed after init",
    fallbackUsed: requestedBackend === "webgpu-preferred" && actualBackend === "webgl2",
    ...tier,
    webgpuApiExposed: options.webgpuApiExposed,
    webgpuAdapterProbeAvailable: options.navigatorAdapterProbe.available,
    navigatorAdapterProbe: options.navigatorAdapterProbe,
    webgl2ApiAvailable: options.webgl2ApiAvailable,
    sceneEvidence: options.sceneEvidence,
    precompile: options.precompile,
    initMs: Number(options.initMs.toFixed(2)),
    firstRenderMs: Number(options.firstRenderMs.toFixed(2)),
    drawCalls: renderer.info.render.drawCalls,
    triangles: renderer.info.render.triangles,
    resources: collectResourceCounters(renderer),
    maxAnisotropy: renderer.getMaxAnisotropy(),
    ...details,
  };
}
