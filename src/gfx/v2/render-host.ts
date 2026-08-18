import {
  type BackendRuntimeEvent,
  type JourneyRenderSnapshot,
  type RenderHostDependencies,
  type RenderHostEvent,
  type RenderHostLifecycle,
  type RenderHostProbeEvent,
  type RenderHostProbeSnapshot,
  type RenderPass,
  type RenderPassRecorder,
  type RenderQualityProfile,
  type RenderViewport,
  type Unsubscribe,
  type VisualClock,
} from "./contracts";
import { hostError, lifecycleError, type RenderHostError } from "./errors";

class FramePassRecorder implements RenderPassRecorder {
  readonly #passes: RenderPass[] = [];

  get passes(): readonly RenderPass[] {
    return Object.freeze(this.#passes.slice());
  }

  record(pass: RenderPass): void {
    if (!pass.name.trim() || !pass.kind.trim()) {
      throw new TypeError("A render pass requires non-empty name and kind fields.");
    }
    this.#passes.push(Object.freeze({ ...pass }));
  }

  draw(name: string, scene: unknown, camera: unknown, kind = "scene"): void {
    this.record({ name, kind, scene, camera });
  }
}

function freezeSnapshot(snapshot: JourneyRenderSnapshot): JourneyRenderSnapshot {
  const pulses = snapshot.pulses.map((pulse) => Object.freeze({
    id: pulse.id,
    journeyTime: pulse.journeyTime,
    x: pulse.x,
    y: pulse.y,
    phase: pulse.phase,
    source: pulse.source,
    value: pulse.value,
  }));

  return Object.freeze({
    seed: snapshot.seed,
    storyTime: snapshot.storyTime,
    phase: snapshot.phase,
    shotId: snapshot.shotId,
    position: Object.freeze({ x: snapshot.position.x, y: snapshot.position.y }),
    velocity: Object.freeze({ x: snapshot.velocity.x, y: snapshot.velocity.y }),
    pulses: Object.freeze(pulses),
    answerAt: snapshot.answerAt,
    finished: snapshot.finished,
  });
}

function freezeQuality(profile: Readonly<RenderQualityProfile>): Readonly<RenderQualityProfile> {
  return Object.freeze({
    tier: profile.tier,
    pixelRatio: profile.pixelRatio,
    uploadBudgetMs: profile.uploadBudgetMs,
    features: Object.freeze({ ...profile.features }),
  });
}

function freezeViewport(viewport: RenderViewport): RenderViewport {
  if (viewport.width <= 0 || viewport.height <= 0 || viewport.pixelRatio <= 0) {
    throw new RangeError("Render viewport dimensions and pixel ratio must be positive.");
  }
  return Object.freeze({
    width: viewport.width,
    height: viewport.height,
    pixelRatio: viewport.pixelRatio,
  });
}

/**
 * Owns the sole animation loop and all graphics lifecycle transitions. It never
 * exposes a renderer object and never mutates simulation state.
 */
export class RenderHost {
  readonly #dependencies: RenderHostDependencies;
  #lifecycle: RenderHostLifecycle = "new";
  #snapshot: JourneyRenderSnapshot | null = null;
  #viewport: RenderViewport | null = null;
  #quality: Readonly<RenderQualityProfile> | null = null;
  #initializePromise: Promise<void> | null = null;
  #disposePromise: Promise<void> | null = null;
  #cleanupPromise: Promise<readonly unknown[]> | null = null;
  #failurePromise: Promise<void> | null = null;
  #framePromise: Promise<void> | null = null;
  #backendUnsubscribe: Unsubscribe | null = null;
  #qualityUnsubscribe: Unsubscribe | null = null;
  #initializedFeatures: number[] = [];
  #backendStarted = false;
  #materialsStarted = false;
  #uploadsStarted = false;
  #resourcesStarted = false;
  #frame = 0;
  #firstFrameAtMs: number | null = null;
  #lastFrameAtMs: number | null = null;
  #terminalError: RenderHostError | null = null;
  #probeEvents: RenderHostProbeEvent[] = [];
  #probeListeners = new Set<() => void>();
  #nextProbeEventId = 1;
  #frameCallbacks = 0;
  #submittedFrames = 0;
  #droppedFrames = 0;
  #backendEvents = 0;
  #failures = 0;

  constructor(dependencies: RenderHostDependencies) {
    this.#dependencies = dependencies;
  }

  get state(): RenderHostLifecycle {
    return this.#lifecycle;
  }

  get error(): RenderHostError | null {
    return this.#terminalError;
  }

  get journeySnapshot(): JourneyRenderSnapshot | null {
    return this.#snapshot;
  }

  subscribe(listener: () => void): Unsubscribe {
    this.#probeListeners.add(listener);
    return () => this.#probeListeners.delete(listener);
  }

  getSnapshot(): RenderHostProbeSnapshot {
    let resources;
    try {
      resources = this.#dependencies.backend.snapshotResources();
    } catch {
      resources = this.#dependencies.resources.snapshot();
    }
    return Object.freeze({
      lifecycle: this.#lifecycle,
      loopRunning: this.#dependencies.frameLoop.running,
      qualityTier: this.#quality?.tier ?? null,
      journey: this.#snapshot
        ? Object.freeze({
            seed: this.#snapshot.seed,
            storyTime: this.#snapshot.storyTime,
            shotId: this.#snapshot.shotId,
          })
        : null,
      backend: Object.freeze({ ...this.#dependencies.backend.facts }),
      resources: Object.freeze({ ...resources }),
      counters: Object.freeze({
        frameCallbacks: this.#frameCallbacks,
        submittedFrames: this.#submittedFrames,
        droppedFrames: this.#droppedFrames,
        backendEvents: this.#backendEvents,
        failures: this.#failures,
      }),
      events: Object.freeze(this.#probeEvents.map((event) => Object.freeze({ ...event }))),
      error: this.#terminalError
        ? Object.freeze({
            code: this.#terminalError.code,
            message: this.#terminalError.message,
            lifecycle: this.#terminalError.lifecycle,
          })
        : null,
    });
  }

  initialize(snapshot: JourneyRenderSnapshot, viewport: RenderViewport): Promise<void> {
    if (this.#lifecycle === "ready") return Promise.resolve();
    if (this.#initializePromise) return this.#initializePromise;
    if (this.#lifecycle !== "new") {
      return Promise.reject(lifecycleError("initialize", this.#lifecycle));
    }

    this.#snapshot = freezeSnapshot(snapshot);
    this.#viewport = freezeViewport(viewport);
    this.#initializePromise = this.#performInitialize();
    return this.#initializePromise;
  }

  setSnapshot(snapshot: JourneyRenderSnapshot): void {
    if (this.#lifecycle === "disposed" || this.#lifecycle === "failed") {
      throw lifecycleError("set a snapshot", this.#lifecycle);
    }
    this.#snapshot = freezeSnapshot(snapshot);
    this.#notifyProbeListeners();
  }

  async setQuality(profile: Readonly<RenderQualityProfile>): Promise<void> {
    if (this.#lifecycle !== "ready") throw lifecycleError("set quality", this.#lifecycle);
    await this.#applyQuality(freezeQuality(profile));
    this.#notifyProbeListeners();
  }

  async resize(viewport: RenderViewport): Promise<void> {
    if (this.#lifecycle !== "ready") throw lifecycleError("resize", this.#lifecycle);
    const frozen = freezeViewport(viewport);
    await this.#dependencies.backend.resize(frozen);
    this.#viewport = frozen;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#lifecycle === "disposed") return Promise.resolve();
    if (this.#lifecycle === "failed") return this.#failurePromise ?? Promise.resolve();

    this.#disposePromise = this.#performDispose();
    return this.#disposePromise;
  }

  async whenIdle(): Promise<void> {
    await this.#framePromise?.catch(() => undefined);
    await this.#failurePromise?.catch(() => undefined);
  }

  async #performInitialize(): Promise<void> {
    this.#transition("initializing");
    const serviceContext = Object.freeze({
      backend: this.#dependencies.backend,
      observer: this.#dependencies.observer,
    });

    try {
      this.#backendUnsubscribe = this.#dependencies.backend.subscribeEvents(
        (event) => this.#onBackendEvent(event),
      );

      this.#backendStarted = true;
      await this.#dependencies.backend.initialize({ viewport: this.#viewport! });
      this.#assertInitializing();

      this.#resourcesStarted = true;
      await this.#dependencies.resources.initialize(serviceContext);
      this.#assertInitializing();

      this.#uploadsStarted = true;
      await this.#dependencies.uploads.initialize(serviceContext);
      this.#assertInitializing();

      this.#materialsStarted = true;
      await this.#dependencies.materials.initialize(serviceContext);
      this.#assertInitializing();

      const featureContext = Object.freeze({
        backend: this.#dependencies.backend,
        materials: this.#dependencies.materials,
        uploads: this.#dependencies.uploads,
        resources: this.#dependencies.resources,
        observer: this.#dependencies.observer,
      });
      for (let index = 0; index < this.#dependencies.features.length; index += 1) {
        this.#initializedFeatures.push(index);
        await this.#dependencies.features[index].initialize(featureContext);
        this.#assertInitializing();
      }

      this.#quality = freezeQuality(this.#dependencies.qualityProvider.getProfile());
      await this.#applyQuality(this.#quality);
      this.#assertInitializing();
      const warmupRecorder = new FramePassRecorder();
      for (const feature of this.#dependencies.features) feature.render(warmupRecorder);
      const uniqueWarmupPasses = new Map<string, RenderPass>();
      for (const pass of [
        ...this.#dependencies.materials.warmupPasses(),
        ...warmupRecorder.passes,
      ]) {
        uniqueWarmupPasses.set(`${pass.kind}:${pass.name}`, pass);
      }
      await this.#dependencies.backend.precompile([...uniqueWarmupPasses.values()]);
      this.#assertInitializing();
      this.#qualityUnsubscribe = this.#dependencies.qualityProvider.subscribe((profile) => {
        if (this.#lifecycle !== "ready") return;
        void this.#applyQuality(freezeQuality(profile)).catch((error: unknown) => {
          this.#beginFailure("FRAME_FAILED", "Quality update failed.", error, "frame-error");
        });
      });

      this.#transition("ready");
      this.#dependencies.frameLoop.start((nowMs) => this.#onFrame(nowMs));
    } catch (error: unknown) {
      const wrapped = hostError(
        "INITIALIZATION_FAILED",
        "RenderHost initialization failed.",
        this.#lifecycle,
        error,
      );
      this.#terminalError = wrapped;
      this.#observe({ kind: "initialization-error", error: wrapped });
      if (this.#lifecycle !== "failed") this.#transition("failed");
      const cleanup = this.#cleanup().then(() => undefined);
      this.#failurePromise = cleanup;
      await cleanup;
      throw wrapped;
    }
  }

  async #performDispose(): Promise<void> {
    if (this.#lifecycle === "initializing") {
      await this.#initializePromise?.catch(() => undefined);
      if (this.state === "failed") return;
    }
    if (this.#lifecycle !== "new" && this.#lifecycle !== "ready") {
      if (this.#lifecycle === "disposed" || this.#lifecycle === "failed") return;
      throw lifecycleError("dispose", this.#lifecycle);
    }

    this.#transition("disposing");
    await this.#framePromise?.catch(() => undefined);
    const failures = await this.#cleanup();
    if (failures.length > 0) {
      const wrapped = hostError(
        "DISPOSAL_FAILED",
        `RenderHost disposal failed in ${failures.length} cleanup operation(s).`,
        this.#lifecycle,
        new AggregateError(failures),
      );
      this.#terminalError = wrapped;
      this.#observe({ kind: "disposal-error", error: wrapped });
      this.#transition("failed");
      throw wrapped;
    }
    this.#transition("disposed");
  }

  #onFrame(nowMs: number): void {
    this.#frameCallbacks += 1;
    if (this.#lifecycle !== "ready" || this.#framePromise) {
      this.#droppedFrames += 1;
      this.#notifyProbeListeners();
      return;
    }
    const operation = this.#renderFrame(nowMs);
    this.#framePromise = operation;
    void operation
      .catch((error: unknown) => {
        this.#beginFailure("FRAME_FAILED", "Render frame failed.", error, "frame-error");
      })
      .finally(() => {
        if (this.#framePromise === operation) this.#framePromise = null;
      });
  }

  async #renderFrame(nowMs: number): Promise<void> {
    const snapshot = this.#snapshot;
    if (!snapshot) throw new Error("RenderHost has no journey snapshot.");

    const firstFrameAtMs = this.#firstFrameAtMs ?? nowMs;
    const previousFrameAtMs = this.#lastFrameAtMs ?? nowMs;
    const clock: VisualClock = Object.freeze({
      frame: this.#frame,
      nowMs,
      deltaSeconds: Math.max(0, nowMs - previousFrameAtMs) / 1000,
      elapsedSeconds: Math.max(0, nowMs - firstFrameAtMs) / 1000,
    });
    this.#firstFrameAtMs = firstFrameAtMs;
    this.#lastFrameAtMs = nowMs;
    this.#frame += 1;

    await this.#dependencies.uploads.flush(clock);
    for (const feature of this.#dependencies.features) feature.update(snapshot, clock);

    const recorder = new FramePassRecorder();
    for (const feature of this.#dependencies.features) feature.render(recorder);
    await this.#dependencies.backend.render(recorder.passes);
    this.#submittedFrames += 1;
    this.#notifyProbeListeners();
  }

  async #applyQuality(profile: Readonly<RenderQualityProfile>): Promise<void> {
    this.#quality = profile;
    await this.#dependencies.materials.quality(profile);
    for (const feature of this.#dependencies.features) feature.quality(profile);
  }

  #onBackendEvent(event: BackendRuntimeEvent): void {
    this.#backendEvents += 1;
    this.#observe({ kind: "backend-event", event });
    this.#beginFailure(
      "BACKEND_RUNTIME_FAILED",
      `Graphics backend reported ${event.kind}.`,
      event.error,
      "frame-error",
    );
  }

  #beginFailure(
    code: "FRAME_FAILED" | "BACKEND_RUNTIME_FAILED",
    message: string,
    cause: unknown,
    observerKind: "frame-error",
  ): void {
    if (this.#lifecycle === "failed" || this.#lifecycle === "disposed") return;
    if (this.#failurePromise) return;
    const wrapped = hostError(code, message, this.#lifecycle, cause);
    this.#terminalError = wrapped;
    this.#failures += 1;
    this.#observe({ kind: observerKind, error: wrapped });
    this.#transition("failed");
    if (this.#lifecycle !== "initializing") {
      this.#failurePromise = this.#cleanup().then(() => undefined);
    }
  }

  #cleanup(): Promise<readonly unknown[]> {
    if (this.#cleanupPromise) return this.#cleanupPromise;
    this.#cleanupPromise = this.#performCleanup();
    return this.#cleanupPromise;
  }

  async #performCleanup(): Promise<readonly unknown[]> {
    const failures: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error: unknown) {
        failures.push(error);
      }
    };

    this.#dependencies.frameLoop.stop();
    this.#qualityUnsubscribe?.();
    this.#qualityUnsubscribe = null;
    this.#backendUnsubscribe?.();
    this.#backendUnsubscribe = null;

    const activeFrame = this.#framePromise;
    if (activeFrame) await activeFrame.catch(() => undefined);

    for (const index of this.#initializedFeatures.slice().reverse()) {
      await attempt(() => this.#dependencies.features[index].dispose());
    }
    this.#initializedFeatures = [];

    if (this.#materialsStarted) await attempt(() => this.#dependencies.materials.dispose());
    if (this.#uploadsStarted) await attempt(() => this.#dependencies.uploads.dispose());
    if (this.#resourcesStarted) await attempt(() => this.#dependencies.resources.dispose());
    if (this.#backendStarted) await attempt(() => this.#dependencies.backend.dispose());

    this.#materialsStarted = false;
    this.#uploadsStarted = false;
    this.#resourcesStarted = false;
    this.#backendStarted = false;
    return Object.freeze(failures.slice());
  }

  #transition(next: RenderHostLifecycle): void {
    const from = this.#lifecycle;
    this.#lifecycle = next;
    this.#observe({ kind: "lifecycle", from, to: next });
  }

  #observe(event: RenderHostEvent): void {
    this.#probeEvents.push(Object.freeze({
      id: this.#nextProbeEventId,
      kind: event.kind,
      detail: this.#eventDetail(event),
    }));
    this.#nextProbeEventId += 1;
    if (this.#probeEvents.length > 128) this.#probeEvents.shift();
    try {
      this.#dependencies.observer.observe(Object.freeze(event));
    } catch {
      // Diagnostics must never change renderer lifecycle or simulation behavior.
    }
    this.#notifyProbeListeners();
  }

  #eventDetail(event: RenderHostEvent): string {
    if (event.kind === "lifecycle") return `${event.from}->${event.to}`;
    if (event.kind === "backend-event") return event.event.kind;
    return event.error instanceof Error ? event.error.message : String(event.error);
  }

  #notifyProbeListeners(): void {
    for (const listener of this.#probeListeners) {
      try {
        listener();
      } catch {
        // Probe subscribers are diagnostic only.
      }
    }
  }

  #assertInitializing(): void {
    if (this.#lifecycle !== "initializing") {
      throw this.#terminalError ?? lifecycleError("continue initialization", this.#lifecycle);
    }
  }
}
