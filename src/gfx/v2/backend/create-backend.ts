import { HalfFloatType, REVISION, WebGPURenderer } from "three/webgpu";
import {
  ThreeRenderBackendAdapter,
  type NavigatorAdapterProbe,
  type ThreeBackendAdapter,
  type ThreeBackendRequest,
  type ThreeRendererPort,
} from "./backend-adapter";
import type { ThreeRenderPipelinePort } from "../pipeline/contracts";

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
  let attempted = false;
  try {
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
    attempted = true;
    const adapter = await gpu.requestAdapter();
    const info = adapter?.info;
    return Object.freeze({
      source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)",
      attempted,
      available: adapter !== null,
      vendor: info?.vendor || null,
      architecture: info?.architecture || null,
      device: info?.device || null,
      description: info?.description || null,
      error: null,
    });
  } catch {
    return Object.freeze({
      source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)",
      attempted,
      available: false,
      vendor: null,
      architecture: null,
      device: null,
      description: null,
      error: "navigator adapter probe failed",
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
  readonly pipeline?: ThreeRenderPipelinePort;
}

function ownOption<K extends keyof CreateThreeBackendOptions>(
  options: CreateThreeBackendOptions,
  key: K,
  required: boolean,
): CreateThreeBackendOptions[K] {
  const descriptor = Object.getOwnPropertyDescriptor(options, key);
  if (!descriptor) {
    if (required) throw new TypeError(`Three backend option ${key} must be an own data property.`);
    return undefined as CreateThreeBackendOptions[K];
  }
  if (!("value" in descriptor)) {
    throw new TypeError(`Three backend option ${key} must be an own data property.`);
  }
  return descriptor.value as CreateThreeBackendOptions[K];
}

/** Captures caller-owned configuration before the first asynchronous probe. */
export function captureCreateThreeBackendOptions(
  options: CreateThreeBackendOptions,
): Readonly<CreateThreeBackendOptions> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Three backend options must be an object.");
  }
  const canvas = ownOption(options, "canvas", true);
  const request = ownOption(options, "request", true);
  if (request !== "forced-webgl2" && request !== "webgpu-preferred") {
    throw new TypeError("Three backend request must be forced-webgl2 or webgpu-preferred.");
  }
  const lab = ownOption(options, "lab", false);
  const diagnosticsEnabled = ownOption(options, "diagnosticsEnabled", false);
  const antialias = ownOption(options, "antialias", false);
  const powerPreference = ownOption(options, "powerPreference", false);
  const pipeline = ownOption(options, "pipeline", false);
  if (lab !== undefined && typeof lab !== "boolean") {
    throw new TypeError("Three backend lab must be boolean when provided.");
  }
  if (diagnosticsEnabled !== undefined && typeof diagnosticsEnabled !== "boolean") {
    throw new TypeError("Three backend diagnosticsEnabled must be boolean when provided.");
  }
  if (antialias !== undefined && typeof antialias !== "boolean") {
    throw new TypeError("Three backend antialias must be boolean when provided.");
  }
  if (
    powerPreference !== undefined
    && powerPreference !== "high-performance"
    && powerPreference !== "low-power"
  ) {
    throw new TypeError("Three backend powerPreference is invalid.");
  }
  return Object.freeze({
    canvas,
    request,
    ...(lab === undefined ? {} : { lab }),
    ...(diagnosticsEnabled === undefined ? {} : { diagnosticsEnabled }),
    ...(antialias === undefined ? {} : { antialias }),
    ...(powerPreference === undefined ? {} : { powerPreference }),
    ...(pipeline === undefined ? {} : { pipeline }),
  });
}

/** @internal Pure renderer option builder kept observable for compatibility tests. */
export function createThreeRendererOptions(options: Readonly<CreateThreeBackendOptions>) {
  return {
    canvas: options.canvas,
    forceWebGL: options.request === "forced-webgl2",
    antialias: options.antialias ?? (options.pipeline ? false : true),
    alpha: false,
    powerPreference: options.powerPreference ?? "high-performance",
    ...(options.pipeline ? { outputBufferType: HalfFloatType } : {}),
  };
}

export async function createThreeBackend(
  options: CreateThreeBackendOptions,
): Promise<ThreeBackendAdapter> {
  const captured = captureCreateThreeBackendOptions(options);
  const navigatorProbe = await probeNavigatorAdapter();
  return new ThreeRenderBackendAdapter({
    request: captured.request,
    lab: captured.lab ?? false,
    diagnosticsEnabled: captured.diagnosticsEnabled ?? false,
    threeRevision: REVISION,
    webgpuApiExposed: navigatorProbe.attempted,
    webgl2ApiAvailable: webgl2Available(),
    navigatorProbe,
    createRenderer: () => new WebGPURenderer(
      createThreeRendererOptions(captured),
    ) as unknown as ThreeRendererPort,
    pipeline: captured.pipeline,
  });
}
