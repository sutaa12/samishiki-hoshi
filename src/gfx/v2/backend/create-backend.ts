import { REVISION, WebGPURenderer } from "three/webgpu";
import {
  ThreeRenderBackendAdapter,
  type NavigatorAdapterProbe,
  type ThreeBackendAdapter,
  type ThreeBackendRequest,
  type ThreeRendererPort,
} from "./backend-adapter";

type NavigatorGpu = {
  requestAdapter(): Promise<{
    info?: {
      vendor?: string;
      architecture?: string;
      device?: string;
      description?: string;
    };
  } | null>;
};

function webgl2Available(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

async function probeNavigatorAdapter(): Promise<NavigatorAdapterProbe> {
  const gpu = (navigator as Navigator & { gpu?: NavigatorGpu }).gpu;
  if (!gpu) {
    return Object.freeze({
      source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)",
      attempted: false,
      available: false,
      vendor: null,
      architecture: null,
      device: null,
      description: null,
      error: null,
    });
  }
  try {
    const adapter = await gpu.requestAdapter();
    const info = adapter?.info;
    return Object.freeze({
      source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)",
      attempted: true,
      available: adapter !== null,
      vendor: info?.vendor || null,
      architecture: info?.architecture || null,
      device: info?.device || null,
      description: info?.description || null,
      error: null,
    });
  } catch (error: unknown) {
    return Object.freeze({
      source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)",
      attempted: true,
      available: false,
      vendor: null,
      architecture: null,
      device: null,
      description: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface CreateThreeBackendOptions {
  readonly canvas: HTMLCanvasElement;
  readonly request: ThreeBackendRequest;
  readonly lab?: boolean;
  readonly diagnosticsEnabled?: boolean;
  readonly antialias?: boolean;
  readonly powerPreference?: "high-performance" | "low-power";
}

export async function createThreeBackend(
  options: CreateThreeBackendOptions,
): Promise<ThreeBackendAdapter> {
  const navigatorProbe = await probeNavigatorAdapter();
  return new ThreeRenderBackendAdapter({
    request: options.request,
    lab: options.lab ?? false,
    diagnosticsEnabled: options.diagnosticsEnabled ?? false,
    threeRevision: REVISION,
    webgpuApiExposed: "gpu" in navigator && navigator.gpu != null,
    webgl2ApiAvailable: webgl2Available(),
    navigatorProbe,
    createRenderer: () => new WebGPURenderer({
      canvas: options.canvas,
      forceWebGL: options.request === "forced-webgl2",
      antialias: options.antialias ?? true,
      alpha: false,
      powerPreference: options.powerPreference ?? "high-performance",
    }) as unknown as ThreeRendererPort,
  });
}
