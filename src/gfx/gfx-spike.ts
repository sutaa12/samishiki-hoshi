import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  DoubleSide,
  IcosahedronGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  TorusGeometry,
  WebGPURenderer,
  type BufferGeometry,
  type Material,
} from "three/webgpu";
import { color, mix, positionLocal, time } from "three/tsl";
import { createGfxEventStore, type GfxRuntimeEvent } from "./event-store";
import {
  canCreateWebGL2Context,
  collectGfxTelemetry,
  collectResourceCounters,
  probeNavigatorWebGPUAdapter,
  type GfxRequestedBackend,
  type GfxResourceCounters,
  type GfxSceneEvidence,
  type GfxTelemetry,
} from "./telemetry";

export type GfxLifecycleProbe = {
  state: "running" | "disposing" | "disposed";
  animationLoopActive: boolean;
  resizeListenerActive: boolean;
  runtimeEventBridgeActive: boolean;
  runtimeSubscriberCount: number;
  animationFrameCount: number;
  resizeHandlerInvocationCount: number;
  resources: GfxResourceCounters;
};

export type GfxDisposeSnapshot = {
  state: "disposed";
  disposeCallCount: number;
  idempotentReplay: boolean;
  firstDisposedAtMs: number;
  durationMs: number;
  animationLoopActive: false;
  resizeListenerActive: false;
  runtimeEventBridgeActive: false;
  runtimeSubscriberCountAfter: 0;
  animationFrameCountAtStop: number;
  resizeHandlerInvocationCountAtStop: number;
  resourcesBefore: GfxResourceCounters;
  resourcesAfter: GfxResourceCounters;
  sceneObjectsBefore: number;
  sceneObjectsAfter: number;
  rendererDisposeInvoked: true;
};

export type GfxRuntimeSnapshot = {
  telemetry: GfxTelemetry;
  events: readonly GfxRuntimeEvent[];
  lifecycle: GfxLifecycleProbe;
  lastDispose: GfxDisposeSnapshot | null;
};

export type GfxSpikeRuntime = {
  telemetry: GfxTelemetry;
  getSnapshot: () => GfxRuntimeSnapshot;
  probeLifecycle: () => GfxLifecycleProbe;
  subscribe: (listener: () => void) => () => void;
  dispose: () => Promise<GfxDisposeSnapshot>;
  diagnostics: {
    emitRendererError: (error: unknown) => void;
    emitDeviceLost: (error: unknown) => void;
  };
};

type NodeMaterialProbe = Material & {
  isNodeMaterial?: boolean;
  colorNode?: unknown;
  emissiveNode?: unknown;
  positionNode?: unknown;
};

function sceneObjectCount(scene: Scene): number {
  let count = 0;
  scene.traverse((object) => {
    if (object !== scene) count += 1;
  });
  return count;
}

function sceneMaterials(scene: Scene): Set<Material> {
  const materials = new Set<Material>();
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const entries = Array.isArray(object.material) ? object.material : [object.material];
    entries.forEach((entry) => materials.add(entry));
  });
  return materials;
}

function observeSceneEvidence(scene: Scene): GfxSceneEvidence {
  const materials = sceneMaterials(scene);
  const nodeMaterials = [...materials].filter(
    (material) => (material as NodeMaterialProbe).isNodeMaterial === true,
  ) as NodeMaterialProbe[];
  const assigned = nodeMaterials.filter(
    (material) => material.colorNode != null || material.emissiveNode != null || material.positionNode != null,
  );
  return {
    uniqueMaterialCount: materials.size,
    nodeMaterialCount: nodeMaterials.length,
    nodeMaterialsWithAssignedNodes: assigned.length,
    nodeMaterialTypes: [...new Set(nodeMaterials.map((material) => material.type))].sort(),
  };
}

function disposeScene(scene: Scene): void {
  const geometries = new Set<BufferGeometry>();
  scene.traverse((object) => {
    if (object instanceof Mesh) geometries.add(object.geometry);
  });
  const materials = sceneMaterials(scene);
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  scene.clear();
}

function makeScene(): { scene: Scene; camera: PerspectiveCamera; animated: Mesh[] } {
  const scene = new Scene();
  scene.background = new Color(0x030713);

  const camera = new PerspectiveCamera(42, 1, 0.1, 40);
  camera.position.set(0, 0.25, 5.2);

  const dropletMaterial = new MeshStandardNodeMaterial({
    roughness: 0.25,
    metalness: 0.18,
  });
  const heightGradient = positionLocal.y.mul(0.48).add(0.5).clamp(0, 1);
  const pulse = time.mul(0.72).sin().mul(0.5).add(0.5);
  const blend = heightGradient.mul(0.72).add(pulse.mul(0.28)).clamp(0, 1);
  dropletMaterial.colorNode = mix(color(0x28b8d8), color(0xd8b2ff), blend);
  dropletMaterial.emissiveNode = color(0x163d68).mul(pulse.mul(0.16).add(0.04));

  const hero = new Mesh(new IcosahedronGeometry(1.05, 5), dropletMaterial);
  hero.scale.set(0.82, 1.08, 0.82);
  scene.add(hero);

  const ringMaterial = new MeshBasicNodeMaterial({
    transparent: true,
    opacity: 0.34,
    side: DoubleSide,
  });
  ringMaterial.colorNode = mix(color(0x65d9ff), color(0xd4a1ff), pulse);

  const ringA = new Mesh(new TorusGeometry(1.58, 0.026, 12, 128), ringMaterial);
  ringA.rotation.set(0.82, 0.2, 0.28);
  const ringB = new Mesh(new TorusGeometry(1.86, 0.018, 12, 128), ringMaterial);
  ringB.rotation.set(-0.42, 0.65, -0.18);
  scene.add(ringA, ringB);

  scene.add(new AmbientLight(0x6ba4d8, 1.8));
  const key = new DirectionalLight(0xffe4cf, 4.2);
  key.position.set(2.8, 3.6, 4.4);
  scene.add(key);
  const rim = new DirectionalLight(0x5e7dff, 2.6);
  rim.position.set(-3.2, -1.2, 2.1);
  scene.add(rim);

  return { scene, camera, animated: [hero, ringA, ringB] };
}

export async function createGfxSpike(options: {
  canvas: HTMLCanvasElement;
  forceWebGL: boolean;
}): Promise<GfxSpikeRuntime> {
  const requestedBackend: GfxRequestedBackend = options.forceWebGL
    ? "forced-webgl2"
    : "webgpu-preferred";
  const webgl2ApiAvailable = canCreateWebGL2Context();
  const webgpuProbe = await probeNavigatorWebGPUAdapter();
  const eventStore = createGfxEventStore();
  const runtimeListeners = new Set<() => void>();
  const { scene, camera, animated } = makeScene();
  const sceneEvidence = observeSceneEvidence(scene);
  const renderer = new WebGPURenderer({
    canvas: options.canvas,
    forceWebGL: options.forceWebGL,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  let lifecycleState: GfxLifecycleProbe["state"] = "running";
  let animationLoopActive = false;
  let resizeListenerActive = false;
  let runtimeEventBridgeActive = true;
  let animationFrameCount = 0;
  let resizeHandlerInvocationCount = 0;
  let lastDispose: GfxDisposeSnapshot | null = null;
  let disposeCallCount = 0;
  let disposeInFlight: Promise<GfxDisposeSnapshot> | null = null;

  const notify = () => runtimeListeners.forEach((listener) => listener());
  const unsubscribeEventBridge = eventStore.subscribe(notify);
  renderer.onDeviceLost = (info) => {
    eventStore.emit("device-lost", info);
  };
  renderer.onError = (error) => {
    eventStore.emit("renderer-error", error);
  };

  const applySize = () => {
    const width = Math.max(1, options.canvas.clientWidth || 640);
    const height = Math.max(1, options.canvas.clientHeight || 480);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const onResize = () => {
    resizeHandlerInvocationCount += 1;
    applySize();
  };

  const probeLifecycle = (): GfxLifecycleProbe => ({
    state: lifecycleState,
    animationLoopActive,
    resizeListenerActive,
    runtimeEventBridgeActive,
    runtimeSubscriberCount: runtimeListeners.size,
    animationFrameCount,
    resizeHandlerInvocationCount,
    resources: collectResourceCounters(renderer),
  });

  try {
    applySize();
    window.addEventListener("resize", onResize);
    resizeListenerActive = true;

    const initStartedAt = performance.now();
    await renderer.init();
    const initMs = performance.now() - initStartedAt;

    const compileStartedAt = performance.now();
    await renderer.compileAsync(scene, camera);
    const compileCompletedAt = performance.now();
    const firstRenderStartedAt = performance.now();
    renderer.render(scene, camera);
    const firstRenderMs = performance.now() - firstRenderStartedAt;

    const telemetry = collectGfxTelemetry({
      renderer,
      requestedBackend,
      webgl2ApiAvailable,
      webgpuApiExposed: webgpuProbe.apiExposed,
      navigatorAdapterProbe: webgpuProbe.probe,
      sceneEvidence,
      precompile: {
        method: "renderer.compileAsync(scene, camera)",
        completed: true,
        durationMs: Number((compileCompletedAt - compileStartedAt).toFixed(2)),
        completedAtMs: Number(compileCompletedAt.toFixed(2)),
        firstRenderStartedAtMs: Number(firstRenderStartedAt.toFixed(2)),
        completedBeforeFirstRender: compileCompletedAt <= firstRenderStartedAt,
      },
      initMs,
      firstRenderMs,
    });

    const animationStartedAt = performance.now();
    await renderer.setAnimationLoop((timestamp) => {
      animationFrameCount += 1;
      const elapsed = (timestamp - animationStartedAt) / 1000;
      animated[0].rotation.set(elapsed * 0.11, elapsed * 0.23, elapsed * 0.07);
      animated[1].rotation.z = 0.28 + elapsed * 0.08;
      animated[2].rotation.z = -0.18 - elapsed * 0.055;
      renderer.render(scene, camera);
    });
    animationLoopActive = true;

    const getSnapshot = (): GfxRuntimeSnapshot => ({
      telemetry,
      events: eventStore.getSnapshot(),
      lifecycle: probeLifecycle(),
      lastDispose,
    });

    const performFirstDispose = async (callNumber: number): Promise<GfxDisposeSnapshot> => {
      const startedAt = performance.now();
      lifecycleState = "disposing";
      notify();
      const resourcesBefore = collectResourceCounters(renderer);
      const objectsBefore = sceneObjectCount(scene);

      window.removeEventListener("resize", onResize);
      resizeListenerActive = false;
      await renderer.setAnimationLoop(null);
      animationLoopActive = false;
      renderer.onDeviceLost = () => undefined;
      renderer.onError = () => undefined;
      unsubscribeEventBridge();
      runtimeEventBridgeActive = false;
      const animationFrameCountAtStop = animationFrameCount;
      const resizeHandlerInvocationCountAtStop = resizeHandlerInvocationCount;

      disposeScene(scene);
      renderer.dispose();
      lifecycleState = "disposed";
      const snapshot: GfxDisposeSnapshot = {
        state: "disposed",
        disposeCallCount: callNumber,
        idempotentReplay: false,
        firstDisposedAtMs: Number(performance.now().toFixed(2)),
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
        animationLoopActive: false,
        resizeListenerActive: false,
        runtimeEventBridgeActive: false,
        runtimeSubscriberCountAfter: 0,
        animationFrameCountAtStop,
        resizeHandlerInvocationCountAtStop,
        resourcesBefore,
        resourcesAfter: collectResourceCounters(renderer),
        sceneObjectsBefore: objectsBefore,
        sceneObjectsAfter: sceneObjectCount(scene),
        rendererDisposeInvoked: true,
      };
      lastDispose = snapshot;
      notify();
      runtimeListeners.clear();
      return snapshot;
    };

    const dispose = async (): Promise<GfxDisposeSnapshot> => {
      disposeCallCount += 1;
      const callNumber = disposeCallCount;
      if (lifecycleState === "disposed" && lastDispose) {
        lastDispose = { ...lastDispose, disposeCallCount: callNumber, idempotentReplay: true };
        notify();
        return lastDispose;
      }
      if (disposeInFlight) {
        const first = await disposeInFlight;
        lastDispose = { ...first, disposeCallCount: callNumber, idempotentReplay: true };
        notify();
        return lastDispose;
      }
      disposeInFlight = performFirstDispose(callNumber);
      return disposeInFlight;
    };

    return {
      telemetry,
      getSnapshot,
      probeLifecycle,
      subscribe(listener) {
        runtimeListeners.add(listener);
        return () => runtimeListeners.delete(listener);
      },
      dispose,
      diagnostics: {
        emitRendererError(error) {
          (renderer.onError as (value: unknown) => void)(error);
        },
        emitDeviceLost(error) {
          (renderer.onDeviceLost as (value: unknown) => void)(error);
        },
      },
    };
  } catch (error) {
    window.removeEventListener("resize", onResize);
    resizeListenerActive = false;
    await renderer.setAnimationLoop(null);
    animationLoopActive = false;
    renderer.onDeviceLost = () => undefined;
    renderer.onError = () => undefined;
    unsubscribeEventBridge();
    runtimeEventBridgeActive = false;
    runtimeListeners.clear();
    disposeScene(scene);
    renderer.dispose();
    throw error;
  }
}
