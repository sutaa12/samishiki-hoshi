import type {
  BackendInitializationContext,
  BackendRuntimeEvent,
  RenderBackendAdapter,
  RenderBackendFacts,
  RenderPass,
  RenderResourceSnapshot,
  RenderViewport,
  Unsubscribe,
} from "../contracts";

export type ThreeBackendRequest = "forced-webgl2" | "webgpu-preferred";
export type ThreeActualBackend = "webgl2" | "webgpu";

export interface NavigatorAdapterProbe {
  readonly source: "navigator.gpu.requestAdapter (diagnostic only; not renderer identity)";
  readonly attempted: boolean;
  readonly available: boolean;
  readonly vendor: string | null;
  readonly architecture: string | null;
  readonly device: string | null;
  readonly description: string | null;
  readonly error: string | null;
}

export interface ThreeBackendFacts extends RenderBackendFacts {
  readonly requestedPolicy: ThreeBackendRequest;
  readonly actualAuthority: "renderer.backend flags observed after init" | null;
  readonly webgpuApiExposed: boolean;
  readonly webgl2ApiAvailable: boolean;
  readonly navigatorProbe: Readonly<NavigatorAdapterProbe>;
  readonly compatibilityMode: string | null;
  readonly lab: Readonly<{
    enabled: boolean;
    diagnosticsEnabled: boolean;
    threeRevision: string;
    performanceAccepted: false;
  }>;
}

export interface ThreeBackendLifecycleSnapshot {
  readonly state: "new" | "initializing" | "ready" | "disposing" | "disposed" | "failed";
  readonly eventBridgeActive: boolean;
  readonly initializeCalls: number;
  readonly precompileCalls: number;
  readonly renderCalls: number;
  readonly resizeCalls: number;
  readonly disposeCalls: number;
  readonly resources: Readonly<RenderResourceSnapshot>;
}

type RendererBackendProbe = {
  readonly isWebGPUBackend?: boolean;
  readonly isWebGLBackend?: boolean;
  readonly compatibilityMode?: string;
};

type RendererInfoProbe = {
  readonly memory?: {
    readonly geometries?: number;
    readonly textures?: number;
    readonly renderTargets?: number;
  };
  readonly programs?: readonly unknown[];
};

export interface ThreeRendererPort {
  backend?: RendererBackendProbe;
  info?: RendererInfoProbe;
  onError: (error: unknown) => void;
  onDeviceLost: (error: unknown) => void;
  init(): Promise<void>;
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  compileAsync(scene: unknown, camera: unknown): Promise<void>;
  render(scene: unknown, camera: unknown): void | Promise<void>;
  dispose(): void;
}

export interface ThreeBackendAdapterOptions {
  readonly request: ThreeBackendRequest;
  readonly lab: boolean;
  readonly diagnosticsEnabled: boolean;
  readonly threeRevision: string;
  readonly webgpuApiExposed: boolean;
  readonly webgl2ApiAvailable: boolean;
  readonly navigatorProbe: Readonly<NavigatorAdapterProbe>;
  readonly createRenderer: () => ThreeRendererPort;
  readonly now?: () => number;
}

export interface ThreeBackendAdapter extends RenderBackendAdapter {
  readonly facts: Readonly<ThreeBackendFacts>;
  snapshotLifecycle(): Readonly<ThreeBackendLifecycleSnapshot>;
  diagnostics: Readonly<{
    emitRendererError(error: unknown): void;
    emitDeviceLost(error: unknown): void;
  }>;
}

function emptyResources(subscribers = 0): RenderResourceSnapshot {
  return {
    geometries: 0,
    textures: 0,
    renderTargets: 0,
    programs: 0,
    nodes: 0,
    objects: 0,
    subscribers,
    pendingUploads: 0,
  };
}

function actualBackend(renderer: ThreeRendererPort): ThreeActualBackend {
  if (renderer.backend?.isWebGPUBackend === true) return "webgpu";
  if (renderer.backend?.isWebGLBackend === true) return "webgl2";
  throw new Error("Renderer initialized without an observable WebGPU or WebGL2 backend flag.");
}

function passObjects(passes: readonly RenderPass[]): number {
  const roots = new Set<unknown>();
  for (const pass of passes) if (pass.scene != null) roots.add(pass.scene);
  let count = 0;
  for (const root of roots) {
    const candidate = root as { traverse?: (callback: (value: unknown) => void) => void };
    if (typeof candidate.traverse === "function") {
      candidate.traverse(() => {
        count += 1;
      });
    } else {
      count += 1;
    }
  }
  return count;
}

function isDrawablePass(pass: RenderPass): pass is RenderPass & { scene: unknown; camera: unknown } {
  return pass.scene != null && pass.camera != null;
}

/**
 * Backend implementation with the raw Three renderer held in a private field.
 * RenderHost is the sole animation-loop owner; this adapter never starts one.
 */
export class ThreeRenderBackendAdapter implements ThreeBackendAdapter {
  readonly #options: ThreeBackendAdapterOptions;
  readonly #listeners = new Set<(event: BackendRuntimeEvent) => void>();
  readonly #now: () => number;
  #renderer: ThreeRendererPort | null = null;
  #state: ThreeBackendLifecycleSnapshot["state"] = "new";
  #eventBridgeActive = false;
  #initializePromise: Promise<void> | null = null;
  #disposePromise: Promise<void> | null = null;
  #viewport: RenderViewport | null = null;
  #passes: readonly RenderPass[] = [];
  #initializeCalls = 0;
  #precompileCalls = 0;
  #renderCalls = 0;
  #resizeCalls = 0;
  #disposeCalls = 0;
  #actual: ThreeActualBackend | null = null;

  constructor(options: ThreeBackendAdapterOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
  }

  get facts(): Readonly<ThreeBackendFacts> {
    return Object.freeze({
      requestedApi: this.#options.request === "forced-webgl2" ? "WebGL2" : "WebGPU",
      actualApi: this.#actual === "webgpu" ? "WebGPU" : this.#actual === "webgl2" ? "WebGL2" : null,
      adapter: null,
      device: null,
      fallback: this.#options.request === "webgpu-preferred" && this.#actual === "webgl2",
      requestedPolicy: this.#options.request,
      actualAuthority: this.#actual === null ? null : "renderer.backend flags observed after init",
      webgpuApiExposed: this.#options.webgpuApiExposed,
      webgl2ApiAvailable: this.#options.webgl2ApiAvailable,
      navigatorProbe: this.#options.navigatorProbe,
      compatibilityMode: this.#renderer?.backend?.compatibilityMode ?? null,
      lab: Object.freeze({
        enabled: this.#options.lab,
        diagnosticsEnabled: this.#options.diagnosticsEnabled,
        threeRevision: this.#options.threeRevision,
        performanceAccepted: false,
      }),
    });
  }

  initialize(context: BackendInitializationContext): Promise<void> {
    this.#initializeCalls += 1;
    if (this.#state === "ready") return Promise.resolve();
    if (this.#initializePromise) return this.#initializePromise;
    if (this.#state !== "new") {
      return Promise.reject(new Error(`Cannot initialize Three backend while ${this.#state}.`));
    }
    this.#initializePromise = this.#performInitialize(context);
    return this.#initializePromise;
  }

  async #performInitialize(context: BackendInitializationContext): Promise<void> {
    this.#state = "initializing";
    const renderer = this.#options.createRenderer();
    this.#renderer = renderer;
    renderer.onError = (error) => this.#emit("renderer-error", error);
    renderer.onDeviceLost = (error) => this.#emit("device-lost", error);
    this.#eventBridgeActive = true;
    try {
      await renderer.init();
      this.#actual = actualBackend(renderer);
      this.#viewport = context.viewport;
      this.#applyViewport(context.viewport);
      this.#state = "ready";
    } catch (error: unknown) {
      this.#state = "failed";
      this.#detachRendererEvents(renderer);
      renderer.dispose();
      this.#renderer = null;
      this.#actual = null;
      this.#listeners.clear();
      throw error;
    }
  }

  resize(viewport: RenderViewport): void {
    this.#assertReady("resize");
    this.#resizeCalls += 1;
    this.#viewport = viewport;
    this.#applyViewport(viewport);
  }

  async precompile(passes: readonly RenderPass[]): Promise<void> {
    this.#assertReady("precompile");
    this.#precompileCalls += 1;
    this.#passes = Object.freeze(passes.slice());
    if (this.#viewport) this.#applyViewport(this.#viewport);
    for (const pass of passes) {
      if (isDrawablePass(pass)) await this.#renderer!.compileAsync(pass.scene, pass.camera);
    }
  }

  async render(passes: readonly RenderPass[]): Promise<void> {
    this.#assertReady("render");
    this.#renderCalls += 1;
    this.#passes = Object.freeze(passes.slice());
    for (const pass of passes) {
      if (isDrawablePass(pass)) await this.#renderer!.render(pass.scene, pass.camera);
    }
  }

  subscribeEvents(listener: (event: BackendRuntimeEvent) => void): Unsubscribe {
    if (this.#state === "disposed") return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshotResources(): Readonly<RenderResourceSnapshot> {
    const renderer = this.#renderer;
    if (!renderer || this.#state === "disposed" || this.#state === "failed") {
      return Object.freeze(emptyResources(this.#listeners.size));
    }
    return Object.freeze({
      geometries: renderer.info?.memory?.geometries ?? 0,
      textures: renderer.info?.memory?.textures ?? 0,
      renderTargets: renderer.info?.memory?.renderTargets ?? 0,
      programs: renderer.info?.programs?.length ?? 0,
      nodes: 0,
      objects: passObjects(this.#passes),
      subscribers: this.#listeners.size,
      pendingUploads: 0,
    });
  }

  snapshotLifecycle(): Readonly<ThreeBackendLifecycleSnapshot> {
    return Object.freeze({
      state: this.#state,
      eventBridgeActive: this.#eventBridgeActive,
      initializeCalls: this.#initializeCalls,
      precompileCalls: this.#precompileCalls,
      renderCalls: this.#renderCalls,
      resizeCalls: this.#resizeCalls,
      disposeCalls: this.#disposeCalls,
      resources: this.snapshotResources(),
    });
  }

  dispose(): Promise<void> {
    this.#disposeCalls += 1;
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    this.#disposePromise = this.#performDispose();
    return this.#disposePromise;
  }

  async #performDispose(): Promise<void> {
    if (this.#state === "initializing") await this.#initializePromise?.catch(() => undefined);
    if (this.#state === "disposed") return;
    this.#state = "disposing";
    const renderer = this.#renderer;
    if (renderer) {
      this.#detachRendererEvents(renderer);
      renderer.dispose();
    }
    this.#renderer = null;
    this.#passes = [];
    this.#listeners.clear();
    this.#state = "disposed";
  }

  get diagnostics(): ThreeBackendAdapter["diagnostics"] {
    return Object.freeze({
      emitRendererError: (error: unknown) => {
        if (!this.#options.diagnosticsEnabled) return;
        this.#emit("renderer-error", error);
      },
      emitDeviceLost: (error: unknown) => {
        if (!this.#options.diagnosticsEnabled) return;
        this.#emit("device-lost", error);
      },
    });
  }

  #emit(kind: BackendRuntimeEvent["kind"], error: unknown): void {
    if (!this.#eventBridgeActive) return;
    const event = Object.freeze({ kind, error, occurredAtMs: this.#now() });
    for (const listener of this.#listeners) listener(event);
  }

  #detachRendererEvents(renderer: ThreeRendererPort): void {
    renderer.onError = () => undefined;
    renderer.onDeviceLost = () => undefined;
    this.#eventBridgeActive = false;
  }

  #applyViewport(viewport: RenderViewport): void {
    const renderer = this.#renderer;
    if (!renderer) return;
    renderer.setPixelRatio(viewport.pixelRatio);
    renderer.setSize(viewport.width, viewport.height, false);
    for (const pass of this.#passes) {
      const camera = pass.camera as {
        isPerspectiveCamera?: boolean;
        aspect?: number;
        updateProjectionMatrix?: () => void;
      } | undefined;
      if (camera?.isPerspectiveCamera === true) {
        camera.aspect = viewport.width / viewport.height;
        camera.updateProjectionMatrix?.();
      }
    }
  }

  #assertReady(operation: string): void {
    if (this.#state !== "ready" || !this.#renderer) {
      throw new Error(`Cannot ${operation} Three backend while ${this.#state}.`);
    }
  }
}
