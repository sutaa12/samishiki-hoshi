import { describe, expect, it, vi } from "vitest";
import {
  ThreeRenderBackendAdapter,
  type ThreeRendererPort,
} from "../../src/gfx/v2/backend/backend-adapter";
import type { BackendRuntimeEvent, RenderPass } from "../../src/gfx/v2/contracts";

const viewport = { width: 800, height: 450, pixelRatio: 1 } as const;
const probe = {
  source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)",
  attempted: true,
  available: true,
  vendor: "test-vendor",
  architecture: "test-architecture",
  device: null,
  description: null,
  error: null,
} as const;

function fakeRenderer(actual: "webgpu" | "webgl2" = "webgl2"): ThreeRendererPort & {
  calls: string[];
  disposed: boolean;
} {
  const calls: string[] = [];
  return {
    calls,
    disposed: false,
    backend: actual === "webgpu" ? { isWebGPUBackend: true } : { isWebGLBackend: true },
    info: { memory: { geometries: 2, textures: 1, renderTargets: 1 }, programs: [1, 2] },
    onError: () => undefined,
    onDeviceLost: () => undefined,
    async init() { calls.push("init"); },
    setPixelRatio(value) { calls.push(`pixelRatio:${value}`); },
    setSize(width, height) { calls.push(`size:${width}x${height}`); },
    async compileAsync() { calls.push("compile"); },
    render() { calls.push("render"); },
    dispose() { calls.push("dispose"); this.disposed = true; },
  };
}

function adapter(renderer: ThreeRendererPort, request: "forced-webgl2" | "webgpu-preferred" = "forced-webgl2") {
  return new ThreeRenderBackendAdapter({
    request,
    lab: true,
    diagnosticsEnabled: true,
    threeRevision: "185",
    webgpuApiExposed: true,
    webgl2ApiAvailable: true,
    navigatorProbe: probe,
    createRenderer: () => renderer,
    now: () => 42,
  });
}

describe("GFX-002 Three backend adapter", () => {
  it("keeps requested, actual, API exposure, probe, compatibility, and lab facts distinct", async () => {
    const renderer = fakeRenderer("webgl2");
    const backend = adapter(renderer, "webgpu-preferred");
    await backend.initialize({ viewport });

    expect(backend.facts).toMatchObject({
      requestedApi: "WebGPU",
      actualApi: "WebGL2",
      requestedPolicy: "webgpu-preferred",
      fallback: true,
      actualAuthority: "renderer.backend flags observed after init",
      webgpuApiExposed: true,
      webgl2ApiAvailable: true,
      navigatorProbe: { source: expect.stringContaining("not renderer identity") },
      lab: { enabled: true, diagnosticsEnabled: true, performanceAccepted: false },
    });
  });

  it("precompiles and renders only drawable passes before idempotent zero-resource disposal", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const scene = { traverse(callback: (value: unknown) => void) { callback(this); callback({}); } };
    const passes: RenderPass[] = [
      { name: "warmup", kind: "warmup" },
      { name: "scene", kind: "scene", scene, camera: {} },
    ];
    await backend.initialize({ viewport });
    await backend.precompile(passes);
    await backend.render(passes);
    expect(backend.snapshotResources()).toMatchObject({
      geometries: 2,
      textures: 1,
      renderTargets: 1,
      programs: 2,
      objects: 2,
    });
    expect(renderer.calls).toEqual([
      "init",
      "pixelRatio:1",
      "size:800x450",
      "pixelRatio:1",
      "size:800x450",
      "compile",
      "render",
    ]);

    const first = backend.dispose();
    const second = backend.dispose();
    expect(first).toBe(second);
    await first;
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "disposed",
      eventBridgeActive: false,
      disposeCalls: 2,
      resources: {
        geometries: 0,
        textures: 0,
        renderTargets: 0,
        programs: 0,
        objects: 0,
        subscribers: 0,
      },
    });
  });

  it("publishes late structured events and detaches the bridge during disposal", async () => {
    const renderer = fakeRenderer();
    const backend = adapter(renderer);
    const listener = vi.fn<(event: BackendRuntimeEvent) => void>();
    backend.subscribeEvents(listener);
    await backend.initialize({ viewport });

    renderer.onDeviceLost(new Error("test loss"));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      kind: "device-lost",
      occurredAtMs: 42,
    }));
    await backend.dispose();
    renderer.onDeviceLost(new Error("late ignored"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("disposes and clears subscribers after partial initialization failure", async () => {
    const renderer = fakeRenderer();
    renderer.init = async () => { throw new Error("init failed"); };
    const backend = adapter(renderer);
    backend.subscribeEvents(() => undefined);

    await expect(backend.initialize({ viewport })).rejects.toThrow("init failed");
    expect(renderer.disposed).toBe(true);
    expect(backend.snapshotLifecycle()).toMatchObject({
      state: "failed",
      eventBridgeActive: false,
      resources: { subscribers: 0 },
    });
  });
});
