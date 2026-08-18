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

/** @internal Creates immutable contract-owned aggregate evidence. */
export function immutableGfxContractAggregate(
  errors: readonly unknown[],
  message?: string,
): AggregateError {
  const aggregate = new AggregateError([...errors], message);
  Object.freeze(aggregate.errors);
  return Object.freeze(aggregate);
}

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
      this.#requestId = this.running && this.#callback !== null
        ? requestAnimationFrame(tick)
        : null;
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

export class ContractSceneFeature implements RenderFeature {
  readonly id = "gfx-contract-scene";
  readonly #scene = new Scene();
  readonly #camera = new PerspectiveCamera(42, 1, 0.1, 40);
  readonly #animated: Mesh[] = [];
  readonly #ownedGeometries = new Set<BufferGeometry>();
  readonly #ownedMaterials = new Set<Material>();
  readonly #onOwnedAllocation: ((kind: "geometry" | "material", count: number) => void) | null;
  #createdGeometries = 0;
  #createdMaterials = 0;
  #disposedGeometries = 0;
  #disposedMaterials = 0;
  #disposeStarted = false;
  #disposeCompleted = false;

  constructor(
    onOwnedAllocation: ((kind: "geometry" | "material", count: number) => void) | null = null,
  ) {
    this.#onOwnedAllocation = onOwnedAllocation;
    this.#scene.background = new Color(0x030713);
    this.#camera.position.set(0, 0.2, 5.2);
  }

  async initialize(): Promise<void> {
    const heroMaterial = new MeshStandardNodeMaterial({ roughness: 0.24, metalness: 0.12 });
    this.#ownMaterial(heroMaterial);
    const height = positionLocal.y.mul(0.45).add(0.5).clamp(0, 1);
    heroMaterial.colorNode = mix(color(0x29c9de), color(0xcfa9ff), height);
    heroMaterial.emissiveNode = color(0x173d69).mul(0.09);
    const heroGeometry = this.#ownGeometry(new IcosahedronGeometry(1.04, 5));
    const hero = new Mesh(heroGeometry, heroMaterial);
    hero.scale.set(0.8, 1.08, 0.8);

    const ringMaterial = new MeshBasicNodeMaterial({ transparent: true, opacity: 0.34, side: DoubleSide });
    this.#ownMaterial(ringMaterial);
    ringMaterial.colorNode = mix(color(0x70e4ff), color(0xd9a9ff), height);
    const ringGeometry = this.#ownGeometry(new TorusGeometry(1.62, 0.026, 12, 128));
    const ring = new Mesh(ringGeometry, ringMaterial);
    ring.rotation.set(0.8, 0.2, 0.3);

    this.#scene.add(hero, ring);
    this.#animated.push(hero, ring);
    this.#scene.add(new AmbientLight(0x6ba4d8, 1.7));
    const key = new DirectionalLight(0xffe4cf, 4.1);
    key.position.set(2.8, 3.6, 4.4);
    this.#scene.add(key);
  }

  #ownGeometry<T extends BufferGeometry>(geometry: T): T {
    this.#ownedGeometries.add(geometry);
    this.#createdGeometries = this.#ownedGeometries.size;
    this.#onOwnedAllocation?.("geometry", this.#createdGeometries);
    return geometry;
  }

  #ownMaterial<T extends Material>(material: T): T {
    this.#ownedMaterials.add(material);
    this.#createdMaterials = this.#ownedMaterials.size;
    this.#onOwnedAllocation?.("material", this.#createdMaterials);
    return material;
  }

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
    if (this.#disposeStarted) return;
    this.#disposeStarted = true;
    const failures: unknown[] = [];
    for (const geometry of this.#ownedGeometries) {
      try {
        geometry.dispose();
        this.#disposedGeometries += 1;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    for (const material of this.#ownedMaterials) {
      try {
        material.dispose();
        this.#disposedMaterials += 1;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    this.#scene.clear();
    this.#animated.length = 0;
    this.#ownedGeometries.clear();
    this.#ownedMaterials.clear();
    this.#disposeCompleted = failures.length === 0;
    if (failures.length > 0) {
      throw immutableGfxContractAggregate(failures, "Contract scene disposal failed.");
    }
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
      disposeStarted: this.#disposeStarted,
      disposeCompleted: this.#disposeCompleted,
      createdGeometries: this.#createdGeometries,
      disposedGeometries: this.#disposedGeometries,
      createdMaterials: this.#createdMaterials,
      disposedMaterials: this.#disposedMaterials,
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

function sameViewport(left: RenderViewport, right: RenderViewport): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.pixelRatio === right.pixelRatio;
}

/** @internal Closes the resize-listener installation window before runtime handoff. */
export async function reconcileGfxContractViewport(
  initial: RenderViewport,
  current: RenderViewport,
  resize: (viewport: RenderViewport) => void | Promise<void>,
): Promise<boolean> {
  if (sameViewport(initial, current)) return false;
  await resize(current);
  return true;
}

/** @internal Tracks the detach obligation before listener installation can partially succeed. */
export function createGfxContractResizeBinding(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  listener: () => void,
): Readonly<{ active: boolean; attach(): void; detach(): void }> {
  let active = false;
  const relay: { listener: (() => void) | null } = { listener: null };
  const installedListener = () => relay.listener?.();
  return Object.freeze({
    get active() { return active; },
    attach() {
      if (active) return;
      // addEventListener can be instrumented to acquire the listener and then
      // throw. Publish the rollback obligation before invoking it.
      active = true;
      relay.listener = listener;
      target.addEventListener("resize", installedListener);
    },
    detach() {
      // Revoke application ownership before any fallible DOM removal. A host
      // that lies about removal may retain this wrapper, but never the runtime.
      relay.listener = null;
      if (!active) return;
      target.removeEventListener("resize", installedListener);
      active = false;
    },
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
    disposeStarted: boolean;
    disposeCompleted: boolean;
    createdGeometries: number;
    disposedGeometries: number;
    createdMaterials: number;
    disposedMaterials: number;
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

/** @internal Diagnostic subscriber isolation shared by live and terminal paths. */
export function notifyGfxContractSubscribers(listeners: ReadonlySet<() => void>): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Runtime subscribers are diagnostics and cannot alter lifecycle cleanup.
    }
  }
}

/** @internal Publishes one stable promise before any cleanup side effect runs. */
export function createStableGfxContractOperation<T>(operation: () => Promise<T>): Readonly<{
  active(): boolean;
  run(): Promise<T>;
}> {
  let promise: Promise<T> | null = null;
  return Object.freeze({
    active: () => promise !== null,
    run: () => {
      if (promise) return promise;
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (error: unknown) => void;
      promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      void Promise.resolve().then(operation).then(resolve, reject);
      return promise;
    },
  });
}

/** @internal Best-effort rollback for construction failures after host ownership begins. */
export async function rollbackGfxContractConstruction(
  host: Pick<RenderHost, "dispose">,
  unsubscribe: () => void,
  detach: () => void,
  constructionFailure?: unknown,
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  const constructionFailureProvided = arguments.length >= 4;
  const seen = new Set<unknown>();
  const hasIdentity = (value: unknown) => (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
  const attempt = async (
    operation: () => void | Promise<void>,
    suppressAuthoritativePrimary = false,
  ) => {
    try {
      await operation();
    } catch (error: unknown) {
      if (
        suppressAuthoritativePrimary
        && constructionFailureProvided
        && error === constructionFailure
      ) return;
      if (!hasIdentity(error) || !seen.has(error)) {
        if (hasIdentity(error)) seen.add(error);
        failures.push(error);
      }
    }
  };
  await attempt(unsubscribe);
  let detachNeedsRetry = false;
  try {
    await detach();
  } catch (error: unknown) {
    detachNeedsRetry = true;
    if (!hasIdentity(error) || !seen.has(error)) {
      if (hasIdentity(error)) seen.add(error);
      failures.push(error);
    }
  }
  // dispose() is the authoritative owner promise in every lifecycle,
  // including failed; whenIdle intentionally absorbs terminal rejections.
  await attempt(() => host.dispose(), true);
  if (detachNeedsRetry) await attempt(detach);
  return Object.freeze(failures.slice());
}

/** @internal Completes every runtime-owned cleanup step and delivers one final snapshot notification. */
export async function finalizeGfxContractRuntime(
  host: Pick<RenderHost, "dispose">,
  unsubscribe: () => void,
  detach: () => void,
  listeners: Set<() => void>,
): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  const seen = new Set<unknown>();
  const hasIdentity = (value: unknown) => (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
  const attempt = async (operation: () => void | Promise<void>) => {
    try {
      await operation();
    } catch (error: unknown) {
      if (!hasIdentity(error) || !seen.has(error)) {
        if (hasIdentity(error)) seen.add(error);
        failures.push(error);
      }
    }
  };
  const terminalListeners = new Set(listeners);

  await attempt(detach);
  await attempt(unsubscribe);
  await attempt(() => host.dispose());
  await attempt(detach);
  listeners.clear();
  notifyGfxContractSubscribers(terminalListeners);
  return Object.freeze(failures.slice());
}

export async function createGfxContractRuntime(options: {
  readonly canvas: HTMLCanvasElement;
  readonly request: ThreeBackendRequest;
  readonly qa: boolean;
  readonly generation: number;
}): Promise<GfxContractRuntime> {
  // Validate caller-owned layout data before constructing any feature resources.
  const initialViewport = viewportFor(options.canvas);
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
  let resizeCalls = 0;
  let disposeCalls = 0;
  let constructionComplete = false;
  let terminalCleanupScheduled = false;

  const notify = () => notifyGfxContractSubscribers(listeners);
  const onResize = () => {
    if (host.state !== "ready") return;
    resizeCalls += 1;
    void host.resize(viewportFor(options.canvas)).then(notify).catch(() => undefined);
  };
  const resizeBinding = createGfxContractResizeBinding(window, onResize);
  const detachResize = () => resizeBinding.detach();
  const getSnapshot = (): Readonly<GfxContractSnapshot> => Object.freeze({
    generation: options.generation,
    replayHash: GFX_CONTRACT_REPLAY_HASH,
    host: host.getSnapshot(),
    backendFacts: backend.facts,
    backendLifecycle: backend.snapshotLifecycle(),
    frameLoop: frameLoop.snapshot(),
    scene: feature.snapshotEvidence(),
    runtime: Object.freeze({
      resizeListenerActive: resizeBinding.active,
      resizeCalls,
      subscribers: listeners.size,
      disposeCalls,
    }),
    observedEvents: Object.freeze(observedEvents.slice()),
  });

  let unsubscribeHost: Unsubscribe = () => undefined;
  const disposal = createStableGfxContractOperation(async () => {
    disposeCalls += 1;
    const failures = await finalizeGfxContractRuntime(
      host,
      unsubscribeHost,
      detachResize,
      listeners,
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw immutableGfxContractAggregate(failures, "GFX contract runtime cleanup failed.");
    }
    return getSnapshot();
  });

  unsubscribeHost = host.subscribe(() => {
    if (host.state === "failed" || host.state === "disposed") {
      if (constructionComplete && !terminalCleanupScheduled) {
        terminalCleanupScheduled = true;
        void disposal.run().catch(() => undefined);
      }
      return;
    }
    notify();
  });

  try {
    await host.initialize(CONTRACT_SNAPSHOT, initialViewport);
    if (host.state !== "ready") {
      await host.dispose().catch(() => undefined);
      throw host.error ?? new Error(`GFX contract host settled as ${host.state}.`);
    }
    resizeBinding.attach();
    if (host.state !== "ready") {
      detachResize();
      await host.dispose().catch(() => undefined);
      throw host.error ?? new Error(`GFX contract host changed to ${host.state} while binding resize.`);
    }
    const reconciledViewport = viewportFor(options.canvas);
    if (await reconcileGfxContractViewport(
      initialViewport,
      reconciledViewport,
      (viewport) => host.resize(viewport),
    )) {
      resizeCalls += 1;
    }
    if (host.state !== "ready") {
      throw host.error
        ?? new Error(`GFX contract host changed to ${host.state} while reconciling viewport.`);
    }
    constructionComplete = true;
  } catch (error: unknown) {
    const rollbackFailures = await rollbackGfxContractConstruction(
      host,
      unsubscribeHost,
      detachResize,
      error,
    );
    if (rollbackFailures.length > 0) {
      throw immutableGfxContractAggregate(
        [error, ...rollbackFailures],
        "GFX contract construction failed and rollback also failed.",
      );
    }
    throw error;
  }

  return {
    getSnapshot,
    subscribe(listener) {
      if (disposal.active() || host.state === "disposed" || host.state === "failed") {
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: disposal.run,
    diagnostics: backend.diagnostics,
  };
}
