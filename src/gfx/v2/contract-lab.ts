import {
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
  TorusGeometry,
  type BufferGeometry,
  type Material,
} from "three/webgpu";
import { color, mix, positionLocal } from "three/tsl";
import { createThreeBackend } from "./backend/create-backend";
import type {
  JourneyRenderSnapshot,
  RenderEventObserver,
  RenderFeature,
  RenderFrameLoop,
  RenderHostEvent,
  RenderHostProbeSnapshot,
  RenderMaterialLibrary,
  RenderPassRecorder,
  RenderQualityProfile,
  RenderQualityProvider,
  RenderResourceRegistry,
  RenderUploadQueue,
  RenderViewport,
  Unsubscribe,
  VisualClock,
} from "./contracts";
import type {
  ThreeBackendAdapter,
  ThreeBackendLifecycleSnapshot,
  ThreeBackendRequest,
  ThreeBackendFacts,
} from "./backend/backend-adapter";
import { RenderHost } from "./render-host";

export const GFX_CONTRACT_REPLAY_HASH = "09780631";

const CONTRACT_SNAPSHOT: JourneyRenderSnapshot = {
  seed: 778,
  storyTime: 12,
  phase: "LIFE",
  shotId: "S03",
  position: { x: 0.25, y: -0.5 },
  velocity: { x: 0.1, y: 0.2 },
  pulses: [{
    id: 1,
    journeyTime: 5,
    x: 0.14,
    y: -0.51,
    phase: "LIFE",
    source: "player",
    value: 953532373,
  }],
  answerAt: null,
  finished: false,
};

const HIGH_PROFILE: RenderQualityProfile = {
  tier: "high",
  pixelRatio: 1.5,
  uploadBudgetMs: 4,
  features: Object.freeze({ temporal: false, contractLab: true }),
};

class BrowserFrameLoop implements RenderFrameLoop {
  running = false;
  starts = 0;
  stops = 0;
  ticks = 0;
  #requestId: number | null = null;
  #callback: ((nowMs: number) => void) | null = null;

  start(callback: (nowMs: number) => void): void {
    if (this.running) throw new Error("The RenderHost already owns an active frame loop.");
    this.running = true;
    this.starts += 1;
    this.#callback = callback;
    const tick = (nowMs: number) => {
      if (!this.running || this.#callback === null) return;
      this.ticks += 1;
      this.#callback(nowMs);
      this.#requestId = requestAnimationFrame(tick);
    };
    this.#requestId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.running) this.stops += 1;
    this.running = false;
    this.#callback = null;
    if (this.#requestId !== null) cancelAnimationFrame(this.#requestId);
    this.#requestId = null;
  }

  snapshot() {
    return Object.freeze({ running: this.running, starts: this.starts, stops: this.stops, ticks: this.ticks });
  }
}

type NodeMaterialProbe = Material & {
  readonly isNodeMaterial?: boolean;
  readonly colorNode?: unknown;
  readonly emissiveNode?: unknown;
  readonly positionNode?: unknown;
};

class ContractSceneFeature implements RenderFeature {
  readonly id = "gfx-contract-scene";
  readonly #scene = new Scene();
  readonly #camera = new PerspectiveCamera(42, 1, 0.1, 40);
  readonly #animated: Mesh[] = [];
  #disposed = false;

  constructor() {
    this.#scene.background = new Color(0x030713);
    this.#camera.position.set(0, 0.2, 5.2);

    const heroMaterial = new MeshStandardNodeMaterial({ roughness: 0.24, metalness: 0.12 });
    const height = positionLocal.y.mul(0.45).add(0.5).clamp(0, 1);
    heroMaterial.colorNode = mix(color(0x29c9de), color(0xcfa9ff), height);
    heroMaterial.emissiveNode = color(0x173d69).mul(0.09);
    const hero = new Mesh(new IcosahedronGeometry(1.04, 5), heroMaterial);
    hero.scale.set(0.8, 1.08, 0.8);

    const ringMaterial = new MeshBasicNodeMaterial({ transparent: true, opacity: 0.34, side: DoubleSide });
    ringMaterial.colorNode = mix(color(0x70e4ff), color(0xd9a9ff), height);
    const ring = new Mesh(new TorusGeometry(1.62, 0.026, 12, 128), ringMaterial);
    ring.rotation.set(0.8, 0.2, 0.3);

    this.#scene.add(hero, ring);
    this.#animated.push(hero, ring);
    this.#scene.add(new AmbientLight(0x6ba4d8, 1.7));
    const key = new DirectionalLight(0xffe4cf, 4.1);
    key.position.set(2.8, 3.6, 4.4);
    this.#scene.add(key);
  }

  async initialize(): Promise<void> {}

  update(frame: JourneyRenderSnapshot, clock: VisualClock): void {
    const phase = frame.storyTime * 0.01;
    this.#animated[0].rotation.set(clock.elapsedSeconds * 0.1, clock.elapsedSeconds * 0.22 + phase, 0.05);
    this.#animated[1].rotation.z = 0.3 + clock.elapsedSeconds * 0.075;
  }

  render(recorder: RenderPassRecorder): void {
    recorder.draw("gfx-contract-main", this.#scene, this.#camera);
  }

  quality(): void {}

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    this.#scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      geometries.add(object.geometry);
      const entries = Array.isArray(object.material) ? object.material : [object.material];
      entries.forEach((material) => materials.add(material));
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.#scene.clear();
    this.#animated.length = 0;
  }

  snapshotEvidence() {
    const materials = new Set<Material>();
    let objects = 0;
    this.#scene.traverse((object) => {
      if (object !== this.#scene) objects += 1;
      if (!(object instanceof Mesh)) return;
      const entries = Array.isArray(object.material) ? object.material : [object.material];
      entries.forEach((material) => materials.add(material));
    });
    const nodes = [...materials].filter((material) => (material as NodeMaterialProbe).isNodeMaterial === true);
    const assigned = nodes.filter((material) => {
      const probe = material as NodeMaterialProbe;
      return probe.colorNode != null || probe.emissiveNode != null || probe.positionNode != null;
    });
    return Object.freeze({
      disposed: this.#disposed,
      objects,
      materials: materials.size,
      nodeMaterials: nodes.length,
      nodeMaterialsWithAssignedNodes: assigned.length,
    });
  }
}

class FixedQualityProvider implements RenderQualityProvider {
  readonly #listeners = new Set<(profile: Readonly<RenderQualityProfile>) => void>();
  getProfile(): Readonly<RenderQualityProfile> { return HIGH_PROFILE; }
  subscribe(listener: (profile: Readonly<RenderQualityProfile>) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

function viewportFor(canvas: HTMLCanvasElement): RenderViewport {
  return Object.freeze({
    width: Math.max(1, Math.round(canvas.clientWidth || 960)),
    height: Math.max(1, Math.round(canvas.clientHeight || 720)),
    pixelRatio: Math.min(window.devicePixelRatio || 1, HIGH_PROFILE.pixelRatio),
  });
}

export interface GfxContractSnapshot {
  readonly generation: number;
  readonly replayHash: typeof GFX_CONTRACT_REPLAY_HASH;
  readonly host: Readonly<RenderHostProbeSnapshot>;
  readonly backendFacts: Readonly<ThreeBackendFacts>;
  readonly backendLifecycle: Readonly<ThreeBackendLifecycleSnapshot>;
  readonly frameLoop: Readonly<{ running: boolean; starts: number; stops: number; ticks: number }>;
  readonly scene: Readonly<{
    disposed: boolean;
    objects: number;
    materials: number;
    nodeMaterials: number;
    nodeMaterialsWithAssignedNodes: number;
  }>;
  readonly runtime: Readonly<{
    resizeListenerActive: boolean;
    resizeCalls: number;
    subscribers: number;
    disposeCalls: number;
  }>;
  readonly observedEvents: readonly string[];
}

export interface GfxContractRuntime {
  getSnapshot(): Readonly<GfxContractSnapshot>;
  subscribe(listener: () => void): Unsubscribe;
  dispose(): Promise<Readonly<GfxContractSnapshot>>;
  diagnostics: ThreeBackendAdapter["diagnostics"];
}

export async function createGfxContractRuntime(options: {
  readonly canvas: HTMLCanvasElement;
  readonly request: ThreeBackendRequest;
  readonly qa: boolean;
  readonly generation: number;
}): Promise<GfxContractRuntime> {
  const backend = await createThreeBackend({
    canvas: options.canvas,
    request: options.request,
    lab: true,
    diagnosticsEnabled: options.qa,
  });
  const frameLoop = new BrowserFrameLoop();
  const feature = new ContractSceneFeature();
  const observedEvents: string[] = [];
  const observer: RenderEventObserver = {
    observe(event: RenderHostEvent) {
      observedEvents.push(event.kind);
      if (observedEvents.length > 128) observedEvents.shift();
    },
  };
  const materials: RenderMaterialLibrary = {
    initialize: () => undefined,
    warmupPasses: () => [],
    quality: () => undefined,
    dispose: () => undefined,
  };
  const uploads: RenderUploadQueue = {
    initialize: () => undefined,
    flush: () => undefined,
    pendingCount: () => 0,
    dispose: () => undefined,
  };
  const resources: RenderResourceRegistry = {
    initialize: () => undefined,
    snapshot: () => backend.snapshotResources(),
    dispose: () => undefined,
  };
  const host = new RenderHost({
    backend,
    frameLoop,
    features: [feature],
    materials,
    uploads,
    resources,
    qualityProvider: new FixedQualityProvider(),
    observer,
  });

  const listeners = new Set<() => void>();
  let resizeListenerActive = false;
  let resizeCalls = 0;
  let disposeCalls = 0;
  let disposePromise: Promise<Readonly<GfxContractSnapshot>> | null = null;

  const notify = () => listeners.forEach((listener) => listener());
  const detachResize = () => {
    if (!resizeListenerActive) return;
    window.removeEventListener("resize", onResize);
    resizeListenerActive = false;
  };
  const onResize = () => {
    if (host.state !== "ready") return;
    resizeCalls += 1;
    void host.resize(viewportFor(options.canvas)).then(notify).catch(() => undefined);
  };
  const unsubscribeHost = host.subscribe(() => {
    if (host.state === "failed" || host.state === "disposed") {
      detachResize();
      window.setTimeout(() => {
        void host.whenIdle().then(() => {
          unsubscribeHost();
          notify();
        });
      }, 0);
    }
    notify();
  });

  try {
    await host.initialize(CONTRACT_SNAPSHOT, viewportFor(options.canvas));
    window.addEventListener("resize", onResize);
    resizeListenerActive = true;
  } catch (error: unknown) {
    unsubscribeHost();
    detachResize();
    throw error;
  }

  const getSnapshot = (): Readonly<GfxContractSnapshot> => Object.freeze({
    generation: options.generation,
    replayHash: GFX_CONTRACT_REPLAY_HASH,
    host: host.getSnapshot(),
    backendFacts: backend.facts,
    backendLifecycle: backend.snapshotLifecycle(),
    frameLoop: frameLoop.snapshot(),
    scene: feature.snapshotEvidence(),
    runtime: Object.freeze({
      resizeListenerActive,
      resizeCalls,
      subscribers: listeners.size,
      disposeCalls,
    }),
    observedEvents: Object.freeze(observedEvents.slice()),
  });

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposeCalls += 1;
      if (disposePromise) return disposePromise.then(() => getSnapshot());
      disposePromise = (async () => {
        detachResize();
        unsubscribeHost();
        await host.dispose();
        listeners.clear();
        return getSnapshot();
      })();
      return disposePromise;
    },
    diagnostics: backend.diagnostics,
  };
}
