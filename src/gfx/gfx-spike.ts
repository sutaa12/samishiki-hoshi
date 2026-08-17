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
import {
  canCreateWebGL2Context,
  collectGfxTelemetry,
  type GfxRequestedBackend,
  type GfxTelemetry,
} from "./telemetry";

export type GfxSpikeRuntime = {
  telemetry: GfxTelemetry;
  dispose: () => Promise<void>;
};

function disposeScene(scene: Scene): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    const entries = Array.isArray(object.material) ? object.material : [object.material];
    entries.forEach((entry) => materials.add(entry));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
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
  const notes: string[] = [];
  const { scene, camera, animated } = makeScene();
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
  renderer.onDeviceLost = (info) => {
    notes.push(`device-lost:${info.api}:${info.reason ?? "unknown"}`);
  };
  renderer.onError = (message) => {
    notes.push(`backend-error:${typeof message === "string" ? message : "unknown"}`);
  };

  const resize = () => {
    const width = Math.max(1, options.canvas.clientWidth || 640);
    const height = Math.max(1, options.canvas.clientHeight || 480);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  try {
    resize();
    window.addEventListener("resize", resize);

    const initStartedAt = performance.now();
    await renderer.init();
    const initMs = performance.now() - initStartedAt;

    const compileStartedAt = performance.now();
    await renderer.compileAsync(scene, camera);
    const compileMs = performance.now() - compileStartedAt;

    const firstRenderStartedAt = performance.now();
    renderer.render(scene, camera);
    const firstRenderMs = performance.now() - firstRenderStartedAt;

    const telemetry = collectGfxTelemetry({
      renderer,
      requestedBackend,
      webgl2ApiAvailable,
      initMs,
      compileMs,
      firstRenderMs,
      notes,
    });

    const animationStartedAt = performance.now();
    await renderer.setAnimationLoop((timestamp) => {
      const elapsed = (timestamp - animationStartedAt) / 1000;
      animated[0].rotation.set(elapsed * 0.11, elapsed * 0.23, elapsed * 0.07);
      animated[1].rotation.z = 0.28 + elapsed * 0.08;
      animated[2].rotation.z = -0.18 - elapsed * 0.055;
      renderer.render(scene, camera);
    });

    let disposed = false;
    return {
      telemetry,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        window.removeEventListener("resize", resize);
        await renderer.setAnimationLoop(null);
        disposeScene(scene);
        await renderer.dispose();
      },
    };
  } catch (error) {
    window.removeEventListener("resize", resize);
    disposeScene(scene);
    await renderer.dispose();
    throw error;
  }
}
