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
  readonly compatibilityMode: boolean | null;
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
  readonly rendererDisposeInvoked: boolean;
  readonly rendererDisposeCompleted: boolean;
  readonly backendDisposeInstrumented: boolean;
  readonly backendDisposeInvoked: boolean;
  readonly backendDisposeCompleted: boolean;
  /** Internal raw failure/provenance references still retained by the adapter. */
  readonly retainedFailureReferences: number;
  readonly resourceCounterProvenance:
    | "live-renderer-info"
    | "post-renderer-dispose-observation"
    | "unavailable";
  readonly threeInfoResetObserved: boolean;
  readonly lastLiveResources: Readonly<RenderResourceSnapshot> | null;
  readonly resourcesBeforeRendererDispose: Readonly<RenderResourceSnapshot> | null;
  readonly rendererMemory: Readonly<ThreeRendererMemorySnapshot>;
  readonly rendererMemoryComplete: boolean;
  readonly appOwnership: Readonly<{
    renderPasses: number;
    sceneObjects: number;
    eventSubscribers: number;
  }>;
  readonly aggregateCounterAvailability: Readonly<{
    nodes: false;
    pendingUploads: false;
  }>;
  readonly resources: Readonly<RenderResourceSnapshot>;
}

type RendererBackendProbe = {
  readonly isWebGPUBackend?: boolean;
  readonly isWebGLBackend?: boolean;
  readonly compatibilityMode?: boolean;
  dispose?: () => void;
};

type RendererInfoProbe = {
  readonly memory?: {
    readonly attributes?: number;
    readonly geometries?: number;
    readonly indexAttributes?: number;
    readonly indirectStorageAttributes?: number;
    readonly programs?: number;
    readonly readbackBuffers?: number;
    readonly renderTargets?: number;
    readonly storageAttributes?: number;
    readonly textures?: number;
    readonly total?: number;
    readonly uniformBuffers?: number;
  };
};

export interface ThreeRendererMemorySnapshot {
  readonly attributes: number | null;
  readonly geometries: number | null;
  readonly indexAttributes: number | null;
  readonly indirectStorageAttributes: number | null;
  readonly programs: number | null;
  readonly readbackBuffers: number | null;
  readonly renderTargets: number | null;
  readonly storageAttributes: number | null;
  readonly textures: number | null;
  readonly totalBytes: number | null;
  readonly uniformBuffers: number | null;
}

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
  const maximumSceneObjects = 100_000;
  const maximumChildReferences = 200_000;
  const pending = [...roots];
  const visited = new Set<unknown>();
  let count = 0;
  let childReferences = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const hasIdentity = (typeof current === "object" && current !== null)
      || typeof current === "function";
    if (hasIdentity) {
      if (visited.has(current)) continue;
      visited.add(current);
    }
    count += 1;
    if (count > maximumSceneObjects) {
      throw new RangeError(`Scene telemetry exceeded ${maximumSceneObjects} unique objects.`);
    }
    if (!hasIdentity) continue;
    const children = (current as { readonly children?: unknown }).children;
    if (children === undefined || children === null) continue;
    if (!Array.isArray(children)) {
      throw new TypeError("Scene telemetry children must be an array when present.");
    }
    const length = children.length;
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError("Scene telemetry child count must be a non-negative safe integer.");
    }
    childReferences += length;
    if (childReferences > maximumChildReferences) {
      throw new RangeError(
        `Scene telemetry exceeded ${maximumChildReferences} child references.`,
      );
    }
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(children, index)) continue;
      pending.push(children[index]);
    }
  }
  return count;
}

function resourcesFromTelemetry(
  memory: Readonly<ThreeRendererMemorySnapshot>,
  sceneObjects: number,
  subscribers: number,
): RenderResourceSnapshot {
  return {
    geometries: memory.geometries ?? 0,
    textures: memory.textures ?? 0,
    renderTargets: memory.renderTargets ?? 0,
    programs: memory.programs ?? 0,
    nodes: 0,
    objects: sceneObjects,
    subscribers,
    pendingUploads: 0,
  };
}

function rendererMemory(renderer: ThreeRendererPort): ThreeRendererMemorySnapshot {
  const memory = renderer.info?.memory;
  if (!memory) throw new Error("Renderer memory telemetry is unavailable.");
  return {
    attributes: memory?.attributes ?? null,
    geometries: memory?.geometries ?? null,
    indexAttributes: memory?.indexAttributes ?? null,
    indirectStorageAttributes: memory?.indirectStorageAttributes ?? null,
    programs: memory?.programs ?? null,
    readbackBuffers: memory?.readbackBuffers ?? null,
    renderTargets: memory?.renderTargets ?? null,
    storageAttributes: memory?.storageAttributes ?? null,
    textures: memory?.textures ?? null,
    totalBytes: memory?.total ?? null,
    uniformBuffers: memory?.uniformBuffers ?? null,
  };
}

function unavailableRendererMemory(): ThreeRendererMemorySnapshot {
  return {
    attributes: null,
    geometries: null,
    indexAttributes: null,
    indirectStorageAttributes: null,
    programs: null,
    readbackBuffers: null,
    renderTargets: null,
    storageAttributes: null,
    textures: null,
    totalBytes: null,
    uniformBuffers: null,
  };
}

function isCompleteRendererMemory(memory: ThreeRendererMemorySnapshot): boolean {
  return Object.values(memory).every((value) => typeof value === "number");
}

type RendererTelemetrySample = Readonly<{
  available: boolean;
  rendererMemory: Readonly<ThreeRendererMemorySnapshot>;
  resources: Readonly<RenderResourceSnapshot>;
}>;

function captureRendererTelemetry(
  renderer: ThreeRendererPort,
  passes: readonly RenderPass[],
  subscribers: number,
): RendererTelemetrySample {
  // Renderer info and the scene graph may expose user-controlled getters. Read
  // each source exactly once, then derive every public counter from this one
  // captured sample so a mutating getter cannot produce contradictory fields.
  const memory = Object.freeze(rendererMemory(renderer));
  const sceneObjects = passObjects(passes);
  const resources = Object.freeze(
    resourcesFromTelemetry(memory, sceneObjects, subscribers),
  );
  return Object.freeze({
    available: true,
    rendererMemory: memory,
    resources,
  });
}

function unavailableRendererTelemetry(subscribers: number): RendererTelemetrySample {
  return Object.freeze({
    available: false,
    rendererMemory: Object.freeze(unavailableRendererMemory()),
    resources: Object.freeze(emptyResources(subscribers)),
  });
}

function telemetryReentrancyError(): Error {
  return new Error("Renderer telemetry sampling reentered before the active sample completed.");
}

function deferredVoid() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject } as const;
}

type ImmutableCauseSnapshot = Readonly<
  | { present: false }
  | { present: true; value: unknown }
>;

const absentImmutableCause: ImmutableCauseSnapshot = Object.freeze({ present: false });

function immutableAggregateError(
  errors: readonly unknown[],
  message?: string,
  cause: ImmutableCauseSnapshot = absentImmutableCause,
): AggregateError {
  const aggregate = cause.present
    ? new AggregateError([...errors], message, { cause: cause.value })
    : new AggregateError([...errors], message);
  Object.freeze(aggregate.errors);
  Object.freeze(aggregate);
  return aggregate;
}

function immutableAggregateCauseSnapshot(
  value: unknown,
  context: FailureSnapshotContext,
): ImmutableCauseSnapshot {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "cause");
  } catch {
    return Object.freeze({
      present: true,
      value: immutableFailureDetailMarker(
        context,
        "Aggregate failure cause inspection was detached.",
      ),
    });
  }
  if (!descriptor) return absentImmutableCause;
  if (!("value" in descriptor)) {
    return Object.freeze({
      present: true,
      value: immutableFailureDetailMarker(
        context,
        "Aggregate failure cause accessor was detached.",
      ),
    });
  }
  const cause = descriptor.value;
  const hasIdentity = (typeof cause === "object" && cause !== null)
    || typeof cause === "function";
  if (hasIdentity) {
    return Object.freeze({
      present: true,
      value: immutableFailureDetailMarker(
        context,
        "Aggregate failure cause object was detached.",
      ),
    });
  }
  return Object.freeze({
    present: true,
    value: claimFailureSnapshotNode(context)
      ? cause
      : immutableFailureLimitMarker(context),
  });
}

type FailureSnapshotContext = {
  readonly activePath: Set<unknown>;
  visitedNodes: number;
  readonly maximumNodes: number;
  limitMarker: Error | null;
};

function immutableFailureMarker(message: string): Error {
  const marker = new Error(message);
  Object.freeze(marker);
  return marker;
}

function failureSnapshotNodeCapacity(context: FailureSnapshotContext): boolean {
  // Reserve one slot for a shared terminal marker. Reusing that frozen marker
  // bounds both deep aggregate branches and later cleanup roots after the
  // shared evidence budget is exhausted.
  const reservedLimitMarker = context.limitMarker === null ? 1 : 0;
  return context.visitedNodes < context.maximumNodes - reservedLimitMarker;
}

function claimFailureSnapshotNode(context: FailureSnapshotContext): boolean {
  if (!failureSnapshotNodeCapacity(context)) return false;
  context.visitedNodes += 1;
  return true;
}

function immutableFailureLimitMarker(context: FailureSnapshotContext): Error {
  if (context.limitMarker !== null) return context.limitMarker;
  const marker = immutableFailureMarker(
    "Backend failure evidence exceeded the total node limit.",
  );
  context.limitMarker = marker;
  if (context.visitedNodes < context.maximumNodes) context.visitedNodes += 1;
  return marker;
}

function immutableFailureDetailMarker(
  context: FailureSnapshotContext,
  message: string,
): Error {
  return claimFailureSnapshotNode(context)
    ? immutableFailureMarker(message)
    : immutableFailureLimitMarker(context);
}

function immutableInvalidAggregateDetails(
  context: FailureSnapshotContext,
): readonly unknown[] {
  return Object.freeze([
    immutableFailureDetailMarker(
      context,
      "Aggregate failure details were invalid or exceeded the snapshot width limit.",
    ),
  ]);
}

function immutableFailureSnapshot(
  value: unknown,
  depth = 0,
  context: FailureSnapshotContext = {
    activePath: new Set(),
    visitedNodes: 0,
    maximumNodes: 2_048,
    limitMarker: null,
  },
): unknown {
  if (!claimFailureSnapshotNode(context)) return immutableFailureLimitMarker(context);
  const hasIdentity = (typeof value === "object" && value !== null)
    || typeof value === "function";
  if (!hasIdentity) return value;
  if (depth > 32 || context.activePath.has(value)) {
    return immutableFailureMarker(depth > 32
      ? "Backend failure evidence exceeded the snapshot depth limit."
      : "Cyclic backend failure evidence was sanitized.");
  }

  context.activePath.add(value);
  try {
    let isAggregate = false;
    let isError = false;
    try {
      isAggregate = value instanceof AggregateError;
      isError = value instanceof Error;
    } catch {
      return immutableFailureMarker("Opaque backend failure evidence was sanitized.");
    }

    let message = isAggregate
      ? "Backend operation failed with multiple errors."
      : "Backend operation failed.";
    try {
      const observed = (value as { readonly message?: unknown }).message;
      if (typeof observed === "string" && observed.length > 0) message = observed;
    } catch {
      // The safe snapshot intentionally keeps no reference to the source value.
    }

    if (isAggregate) {
      const cause = immutableAggregateCauseSnapshot(value, context);
      let entries: unknown;
      try {
        entries = (value as AggregateError).errors;
      } catch {
        return immutableAggregateError(
          immutableInvalidAggregateDetails(context),
          message,
          cause,
        );
      }
      try {
        if (!Array.isArray(entries)) {
          return immutableAggregateError(
            immutableInvalidAggregateDetails(context),
            message,
            cause,
          );
        }
        const length = entries.length;
        if (!Number.isSafeInteger(length) || length < 0 || length > 256) {
          return immutableAggregateError(
            immutableInvalidAggregateDetails(context),
            message,
            cause,
          );
        }
        const snapshots: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          if (!failureSnapshotNodeCapacity(context)) {
            snapshots.push(immutableFailureLimitMarker(context));
            break;
          }
          if (!Object.prototype.hasOwnProperty.call(entries, index)) continue;
          snapshots.push(immutableFailureSnapshot(entries[index], depth + 1, context));
        }
        return immutableAggregateError(snapshots, message, cause);
      } catch {
        return immutableAggregateError(
          immutableInvalidAggregateDetails(context),
          message,
          cause,
        );
      }
    }

    if (isError) {
      let causePresent = false;
      let cause: unknown;
      try {
        causePresent = Object.prototype.hasOwnProperty.call(value, "cause");
        if (causePresent) cause = (value as Error).cause;
      } catch {
        return immutableFailureMarker(`${message} (cause was sanitized)`);
      }
      const snapshot = causePresent
        ? new Error(message, { cause: immutableFailureSnapshot(cause, depth + 1, context) })
        : new Error(message);
      Object.freeze(snapshot);
      return snapshot;
    }

    return immutableFailureMarker("Opaque backend failure evidence was sanitized.");
  } finally {
    context.activePath.delete(value);
  }
}

type FailureOccurrenceTokens = {
  identities: WeakSet<object>;
  readonly primitives: unknown[];
};

const maximumFailurePrimitiveTokens = 32;

function createFailureOccurrenceTokens(): FailureOccurrenceTokens {
  return { identities: new WeakSet<object>(), primitives: [] };
}

function rememberFailureOccurrence(tokens: FailureOccurrenceTokens, error: unknown): void {
  const hasIdentity = (typeof error === "object" && error !== null)
    || typeof error === "function";
  if (hasIdentity) {
    tokens.identities.add(error as object);
  } else if (
    tokens.primitives.length < maximumFailurePrimitiveTokens
    && !tokens.primitives.some((token) => Object.is(token, error))
  ) {
    tokens.primitives.push(error);
  }
}

function consumeFailureOccurrence(tokens: FailureOccurrenceTokens, error: unknown): boolean {
  const hasIdentity = (typeof error === "object" && error !== null)
    || typeof error === "function";
  if (hasIdentity) {
    if (!tokens.identities.has(error as object)) return false;
    tokens.identities.delete(error as object);
    return true;
  }
  const index = tokens.primitives.findIndex((token) => Object.is(token, error));
  if (index < 0) return false;
  tokens.primitives.splice(index, 1);
  return true;
}

function clearFailureOccurrences(tokens: FailureOccurrenceTokens): void {
  tokens.identities = new WeakSet<object>();
  tokens.primitives.length = 0;
}

type CleanupFailureCollector = Readonly<{
  readonly length: number;
  add(error: unknown): void;
  addNativeBackend(error: unknown): void;
  consumeNativeBackend(error: unknown): boolean;
  clearNativeBackendOccurrences(): void;
  snapshots(): readonly unknown[];
  releaseRawReferences(): void;
}>;

function createCleanupFailureCollector(): CleanupFailureCollector {
  const nativeOccurrences = createFailureOccurrenceTokens();
  const immutableSnapshots: unknown[] = [];
  const context: FailureSnapshotContext = {
    activePath: new Set(),
    visitedNodes: 0,
    maximumNodes: 2_048,
    limitMarker: null,
  };
  const addSnapshot = (error: unknown) => {
    // Snapshot at the catch boundary, before any awaited cleanup stage can
    // give caller-owned errors an opportunity to mutate. One context bounds
    // the entire cleanup suffix rather than granting each error a new budget.
    immutableSnapshots.push(immutableFailureSnapshot(error, 0, context));
  };
  return {
    get length() {
      return immutableSnapshots.length;
    },
    add(error: unknown) {
      addSnapshot(error);
    },
    addNativeBackend(error: unknown) {
      rememberFailureOccurrence(nativeOccurrences, error);
      addSnapshot(error);
    },
    consumeNativeBackend(error: unknown) {
      return consumeFailureOccurrence(nativeOccurrences, error);
    },
    clearNativeBackendOccurrences() {
      clearFailureOccurrences(nativeOccurrences);
    },
    snapshots() {
      return Object.freeze([...immutableSnapshots]);
    },
    releaseRawReferences() {
      clearFailureOccurrences(nativeOccurrences);
      context.activePath.clear();
      context.limitMarker = null;
    },
  };
}

function telemetryMutationError(operation: string): Error {
  return new Error(
    `Cannot ${operation} while renderer telemetry observation is active.`,
  );
}

type RendererEventCallback = (error: unknown) => void;
type RendererEventProperty = "onError" | "onDeviceLost";

type RendererEventBridgeNode = {
  listener: RendererEventCallback | null;
};

type RendererEventRelay = {
  renderer: ThreeRendererPort | null;
  emit: RendererEventCallback | null;
  dispatching: boolean;
  currentBridge: RendererEventCallback;
  replace: (listener: unknown) => void;
  readonly nodes: Set<RendererEventBridgeNode>;
};

type RendererEventChannel = {
  readonly property: RendererEventProperty;
  readonly kind: BackendRuntimeEvent["kind"];
  originalDescriptor: PropertyDescriptor | undefined;
  originalDescriptorCaptured: boolean;
  restoreRequired: boolean;
  relay: RendererEventRelay | null;
};

function createRendererEventBridge(
  relay: RendererEventRelay,
  listener: unknown,
): RendererEventCallback {
  const node: RendererEventBridgeNode = {
    listener: typeof listener === "function" ? listener as RendererEventCallback : null,
  };
  relay.nodes.add(node);
  return (error: unknown) => {
    const renderer = relay.renderer;
    const currentListener = node.listener;
    if (!renderer || !currentListener) return;
    const outermost = !relay.dispatching;
    if (outermost) relay.dispatching = true;
    try {
      currentListener.call(renderer, error);
    } finally {
      if (outermost) {
        try {
          relay.emit?.(error);
        } finally {
          relay.dispatching = false;
        }
      }
    }
  };
}

function createRendererEventRelay(
  renderer: ThreeRendererPort,
  listener: unknown,
  emit: RendererEventCallback,
): RendererEventRelay {
  const relay: RendererEventRelay = {
    renderer,
    emit,
    dispatching: false,
    currentBridge: () => undefined,
    replace: () => undefined,
    nodes: new Set(),
  };
  relay.currentBridge = createRendererEventBridge(relay, listener);
  relay.replace = (replacement: unknown) => {
    if (replacement === relay.currentBridge) return;
    relay.currentBridge = createRendererEventBridge(relay, replacement);
  };
  return relay;
}

function rendererEventDescriptor(relay: RendererEventRelay): PropertyDescriptor {
  return {
    configurable: true,
    enumerable: true,
    get: () => relay.currentBridge,
    set: (listener: unknown) => relay.replace(listener),
  };
}

function rendererEventDescriptorsEqual(
  observed: PropertyDescriptor | undefined,
  expected: PropertyDescriptor | undefined,
): boolean {
  if (observed === undefined || expected === undefined) return observed === expected;
  if (
    observed.configurable !== expected.configurable
    || observed.enumerable !== expected.enumerable
  ) return false;
  const observedIsData = "value" in observed || "writable" in observed;
  const expectedIsData = "value" in expected || "writable" in expected;
  if (observedIsData !== expectedIsData) return false;
  if (expectedIsData) {
    return Object.is(observed.value, expected.value)
      && observed.writable === expected.writable;
  }
  return observed.get === expected.get && observed.set === expected.set;
}

function revokeRendererEventRelay(relay: RendererEventRelay | null): void {
  if (!relay) return;
  relay.emit = null;
  relay.renderer = null;
  relay.dispatching = false;
  relay.replace = () => undefined;
  for (const node of relay.nodes) node.listener = null;
  relay.nodes.clear();
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
  #rendererErrorChannel: RendererEventChannel | null = null;
  #rendererDeviceLostChannel: RendererEventChannel | null = null;
  #state: ThreeBackendLifecycleSnapshot["state"] = "new";
  #eventBridgeActive = false;
  #initializePromise: Promise<void> | null = null;
  #initializeSettled = false;
  #disposePromise: Promise<void> | null = null;
  #viewport: RenderViewport | null = null;
  #passes: readonly RenderPass[] = [];
  #initializeCalls = 0;
  #precompileCalls = 0;
  #renderCalls = 0;
  #resizeCalls = 0;
  #disposeCalls = 0;
  #actual: ThreeActualBackend | null = null;
  #compatibilityMode: boolean | null = null;
  #terminalResources: Readonly<RenderResourceSnapshot> | null = null;
  #terminalRendererMemory: Readonly<ThreeRendererMemorySnapshot> | null = null;
  #lastLiveResources: Readonly<RenderResourceSnapshot> | null = null;
  #resourcesBeforeRendererDispose: Readonly<RenderResourceSnapshot> | null = null;
  #rendererDisposeInvoked = false;
  #rendererDisposeCompleted = false;
  #backendDisposeProbeAttempted = false;
  #backendDisposeInstrumented = false;
  #backendDisposeInvoked = false;
  #backendDisposeCompleted = false;
  #activeCleanupErrors: CleanupFailureCollector | null = null;
  #pendingBackendDisposeEvidence: unknown = undefined;
  #pendingBackendDisposeEvidencePresent = false;
  readonly #pendingBackendDisposeOccurrences = createFailureOccurrenceTokens();
  #failureSnapshotCaptureActive = false;
  #instrumentedBackend: RendererBackendProbe | null = null;
  #instrumentedBackendWrapper: (() => void) | null = null;
  #instrumentedBackendRelay: { invoke: () => void } | null = null;
  #resourceCountersReadable = true;
  readonly #resourceReadErrors = new Set<unknown>();
  #resourceCounterProvenance: ThreeBackendLifecycleSnapshot["resourceCounterProvenance"] =
    "live-renderer-info";
  #threeInfoResetObserved = false;
  #cleanupFailed = false;
  #runtimeFailureClaimed = false;
  #eventEmissionActive = false;
  #runtimeFailure: Readonly<BackendRuntimeEvent> | null = null;
  #runtimeFailureError: Error | null = null;
  readonly #cameraAspects = new WeakMap<object, number>();
  #activeRendererOperations = 0;
  #activeRendererOperationsDrain: ReturnType<typeof deferredVoid> | null = null;
  #telemetrySamplingActive = false;

  constructor(options: ThreeBackendAdapterOptions) {
    this.#options = Object.freeze({
      request: options.request,
      lab: options.lab,
      diagnosticsEnabled: options.diagnosticsEnabled,
      threeRevision: options.threeRevision,
      webgpuApiExposed: options.webgpuApiExposed,
      webgl2ApiAvailable: options.webgl2ApiAvailable,
      navigatorProbe: Object.freeze({ ...options.navigatorProbe }),
      createRenderer: options.createRenderer,
      now: options.now,
    });
    this.#now = this.#options.now ?? (() => performance.now());
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
      compatibilityMode: this.#compatibilityMode,
      lab: Object.freeze({
        enabled: this.#options.lab,
        diagnosticsEnabled: this.#options.diagnosticsEnabled,
        threeRevision: this.#options.threeRevision,
        performanceAccepted: false,
      }),
    });
  }

  initialize(context: BackendInitializationContext): Promise<void> {
    if (
      this.#disposePromise !== null
      && (
        this.#state === "new"
        || this.#state === "initializing"
        || this.#state === "ready"
      )
    ) {
      return Promise.reject(new Error(
        "Cannot initialize Three backend after disposal was requested.",
      ));
    }
    if (this.#telemetrySamplingActive) {
      // A live renderer necessarily has an initialization promise. Returning
      // it keeps idempotent identity without mutating counters mid-observation.
      return this.#initializePromise
        ?? Promise.reject(telemetryMutationError("initialize Three backend"));
    }
    this.#initializeCalls += 1;
    if (this.#initializePromise && !this.#initializeSettled) {
      return this.#initializePromise;
    }
    if (
      (this.#state === "new" || this.#state === "initializing" || this.#state === "ready")
      && this.#initializePromise
    ) {
      return this.#initializePromise;
    }
    if (this.#state === "ready") return Promise.resolve();
    if (this.#state !== "new") {
      return Promise.reject(new Error(`Cannot initialize Three backend while ${this.#state}.`));
    }
    const deferred = deferredVoid();
    this.#initializePromise = deferred.promise;
    void this.#performInitialize(context).then(
      () => {
        this.#initializeSettled = true;
        deferred.resolve();
      },
      (error: unknown) => {
        this.#initializeSettled = true;
        // Active callers keep their own rejected promise; the adapter must not
        // retain an arbitrary renderer/error graph after failed initialization.
        this.#initializePromise = null;
        deferred.reject(error);
      },
    );
    return this.#initializePromise;
  }

  async #performInitialize(context: BackendInitializationContext): Promise<void> {
    this.#state = "initializing";
    let renderer: ThreeRendererPort | null = null;
    try {
      renderer = this.#options.createRenderer();
      this.#renderer = renderer;
      this.#attachRendererEvents(renderer);
      this.#assertNoRuntimeFailure("begin renderer initialization");
      await renderer.init();
      this.#assertNoRuntimeFailure("complete renderer initialization");
      // Three may replace these callbacks during init. Reconcile the bridge
      // without nesting a second wrapper or losing the constructor callbacks.
      this.#attachRendererEvents(renderer);
      this.#assertNoRuntimeFailure("reconcile renderer event callbacks");
      const observedBackend = actualBackend(renderer);
      this.#assertNoRuntimeFailure("observe renderer backend");
      this.#actual = observedBackend;
      const compatibilityMode = renderer.backend?.compatibilityMode ?? null;
      this.#assertNoRuntimeFailure("observe compatibility mode");
      this.#compatibilityMode = compatibilityMode;
      this.#ensureBackendDisposeInstrumentation(renderer);
      this.#assertNoRuntimeFailure("instrument backend disposal");
      const initialTelemetry = this.#captureTelemetry(renderer, [], this.#listeners.size);
      this.#assertNoRuntimeFailure("observe renderer memory");
      if (
        !initialTelemetry.available
        || !isCompleteRendererMemory(initialTelemetry.rendererMemory)
      ) {
        throw new Error("Renderer memory telemetry is incomplete.");
      }
      this.#viewport = context.viewport;
      this.#applyViewport(context.viewport);
      this.#state = "ready";
    } catch (error: unknown) {
      const cleanupErrors = createCleanupFailureCollector();
      const priorCleanupErrors = this.#activeCleanupErrors;
      this.#activeCleanupErrors = cleanupErrors;
      try {
        if (!this.#consumePendingBackendDisposePrimary(error)) {
          this.#transferPendingBackendDisposeEvidence(cleanupErrors);
        }
        if (renderer) {
          this.#captureResourcesBeforeRendererDispose(renderer, cleanupErrors);
          this.#deactivateRendererEvents();
          await this.#disposeRenderer(renderer, cleanupErrors);
          try {
            this.#restoreRendererEvents(renderer);
          } catch (cleanupError: unknown) {
            if (!cleanupErrors.consumeNativeBackend(cleanupError)) {
              cleanupErrors.add(cleanupError);
            }
          }
        }
        this.#passes = [];
        this.#listeners.clear();
        this.#terminalResources = renderer
          ? this.#captureTerminalResources(renderer, cleanupErrors)
          : Object.freeze(emptyResources());
        if (!renderer) {
          this.#terminalRendererMemory = Object.freeze(unavailableRendererMemory());
          this.#resourceCounterProvenance = "unavailable";
        }
        this.#listeners.clear();
        this.#renderer = null;
        this.#actual = null;
        this.#compatibilityMode = null;
        this.#eventBridgeActive = false;
        this.#cleanupFailed = cleanupErrors.length > 0;
        this.#state = "failed";
        const cleanupSnapshots = cleanupErrors.snapshots();
        const terminalFailure = cleanupErrors.length > 0
          ? immutableAggregateError(
            [error, ...cleanupSnapshots],
            "Three backend initialization failed and renderer cleanup also failed.",
          )
          : error;
        cleanupErrors.releaseRawReferences();
        this.#releaseFailureReferences();
        throw terminalFailure;
      } finally {
        if (this.#activeCleanupErrors === cleanupErrors) {
          this.#activeCleanupErrors = priorCleanupErrors;
        }
      }
    }
  }

  resize(viewport: RenderViewport): void {
    if (this.#telemetrySamplingActive) {
      throw telemetryMutationError("resize Three backend");
    }
    this.#assertNoPendingDisposal("resize");
    this.#assertReady("resize");
    this.#assertNoRuntimeFailure("resize");
    const operation = this.#beginRendererOperation();
    try {
      this.#resizeCalls += 1;
      this.#viewport = viewport;
      this.#applyViewport(viewport);
      this.#assertNoRuntimeFailure("complete resize");
    } finally {
      operation.release();
    }
  }

  async precompile(passes: readonly RenderPass[]): Promise<void> {
    if (this.#telemetrySamplingActive) {
      throw telemetryMutationError("precompile Three backend");
    }
    this.#assertNoPendingDisposal("precompile");
    this.#assertReady("precompile");
    this.#assertNoRuntimeFailure("precompile");
    const operation = this.#beginRendererOperation();
    try {
      const capturedPasses = this.#capturePasses(passes, "capture precompile passes");
      this.#assertNoRuntimeFailure("capture precompile passes");
      this.#precompileCalls += 1;
      this.#passes = capturedPasses;
      if (this.#viewport) this.#applyViewport(this.#viewport);
      for (const pass of capturedPasses) {
        this.#assertNoRuntimeFailure("continue precompile");
        if (pass.scene != null && pass.camera != null) {
          await operation.renderer.compileAsync(pass.scene, pass.camera);
        }
        this.#assertNoRuntimeFailure("continue precompile");
      }
      const telemetry = this.#captureTelemetry(
        operation.renderer,
        capturedPasses,
        this.#listeners.size,
      );
      if (!telemetry.available) throw telemetryReentrancyError();
      this.#assertNoRuntimeFailure("record precompile resources");
      this.#lastLiveResources = telemetry.resources;
    } finally {
      operation.release();
    }
  }

  async render(passes: readonly RenderPass[]): Promise<void> {
    if (this.#telemetrySamplingActive) {
      throw telemetryMutationError("render Three backend");
    }
    this.#assertNoPendingDisposal("render");
    this.#assertReady("render");
    this.#assertNoRuntimeFailure("render");
    const operation = this.#beginRendererOperation();
    try {
      const capturedPasses = this.#capturePasses(passes, "capture render passes");
      this.#assertNoRuntimeFailure("capture render passes");
      this.#renderCalls += 1;
      this.#passes = capturedPasses;
      if (this.#viewport) this.#applyPassCameras(this.#viewport);
      for (const pass of capturedPasses) {
        this.#assertNoRuntimeFailure("continue render");
        if (pass.scene != null && pass.camera != null) {
          await operation.renderer.render(pass.scene, pass.camera);
        }
        this.#assertNoRuntimeFailure("continue render");
      }
      const telemetry = this.#captureTelemetry(
        operation.renderer,
        capturedPasses,
        this.#listeners.size,
      );
      if (!telemetry.available) throw telemetryReentrancyError();
      this.#assertNoRuntimeFailure("record render resources");
      this.#lastLiveResources = telemetry.resources;
    } finally {
      operation.release();
    }
  }

  subscribeEvents(listener: (event: BackendRuntimeEvent) => void): Unsubscribe {
    if (
      this.#telemetrySamplingActive
      ||
      this.#disposePromise !== null
      ||
      (this.#state === "initializing" && !this.#eventBridgeActive)
      || this.#state === "disposing"
      || this.#state === "disposed"
      || this.#state === "failed"
      || this.#runtimeFailureClaimed
    ) {
      return () => undefined;
    }
    this.#listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      // Lifecycle snapshots capture their subscriber count before entering
      // renderer getters, so immediate revocation cannot make that observation
      // incoherent and guarantees same-stack events never reach this listener.
      this.#listeners.delete(listener);
    };
  }

  snapshotResources(): Readonly<RenderResourceSnapshot> {
    const renderer = this.#renderer;
    if (renderer && this.#state !== "disposed" && this.#state !== "failed") {
      const telemetry = this.#captureTelemetry(renderer, this.#passes, this.#listeners.size);
      if (telemetry.available) this.#lastLiveResources = telemetry.resources;
      return telemetry.resources;
    }
    return this.#terminalResources ?? Object.freeze(emptyResources(this.#listeners.size));
  }

  snapshotLifecycle(): Readonly<ThreeBackendLifecycleSnapshot> {
    // Capture adapter-owned dimensions before consulting renderer/scene
    // getters. Reentrant getters may call public adapter methods, but every
    // field in this lifecycle view must still describe the same observation.
    const observation = Object.freeze({
      state: this.#state,
      eventBridgeActive: this.#eventBridgeActive,
      initializeCalls: this.#initializeCalls,
      precompileCalls: this.#precompileCalls,
      renderCalls: this.#renderCalls,
      resizeCalls: this.#resizeCalls,
      disposeCalls: this.#disposeCalls,
      rendererDisposeInvoked: this.#rendererDisposeInvoked,
      rendererDisposeCompleted: this.#rendererDisposeCompleted,
      backendDisposeInstrumented: this.#backendDisposeInstrumented,
      backendDisposeInvoked: this.#backendDisposeInvoked,
      backendDisposeCompleted: this.#backendDisposeCompleted,
      retainedFailureReferences: this.#retainedFailureReferenceCount(),
      resourceCounterProvenance: this.#resourceCounterProvenance,
      threeInfoResetObserved: this.#threeInfoResetObserved,
      lastLiveResources: this.#lastLiveResources,
      resourcesBeforeRendererDispose: this.#resourcesBeforeRendererDispose,
      passes: this.#passes,
      subscribers: this.#listeners.size,
      renderer: this.#renderer,
      terminalRendererMemory: this.#terminalRendererMemory,
      terminalResources: this.#terminalResources,
    });
    const { state, passes, subscribers, renderer } = observation;
    const hasLiveRenderer = renderer !== null
      && state !== "disposed"
      && state !== "failed";
    const telemetry = hasLiveRenderer
      ? this.#captureTelemetry(renderer, passes, subscribers)
      : Object.freeze({
          available: observation.resourceCounterProvenance !== "unavailable",
          rendererMemory: observation.terminalRendererMemory
            ?? Object.freeze(unavailableRendererMemory()),
          resources: observation.terminalResources
            ?? Object.freeze(emptyResources(subscribers)),
        });
    if (hasLiveRenderer && telemetry.available) {
      this.#lastLiveResources = telemetry.resources;
    }
    const memory = telemetry.rendererMemory;
    return Object.freeze({
      state,
      eventBridgeActive: observation.eventBridgeActive,
      initializeCalls: observation.initializeCalls,
      precompileCalls: observation.precompileCalls,
      renderCalls: observation.renderCalls,
      resizeCalls: observation.resizeCalls,
      disposeCalls: observation.disposeCalls,
      rendererDisposeInvoked: observation.rendererDisposeInvoked,
      rendererDisposeCompleted: observation.rendererDisposeCompleted,
      backendDisposeInstrumented: observation.backendDisposeInstrumented,
      backendDisposeInvoked: observation.backendDisposeInvoked,
      backendDisposeCompleted: observation.backendDisposeCompleted,
      retainedFailureReferences: observation.retainedFailureReferences,
      resourceCounterProvenance: telemetry.available
        ? observation.resourceCounterProvenance
        : "unavailable",
      threeInfoResetObserved: observation.threeInfoResetObserved,
      lastLiveResources: hasLiveRenderer && telemetry.available
        ? telemetry.resources
        : observation.lastLiveResources,
      resourcesBeforeRendererDispose: observation.resourcesBeforeRendererDispose,
      rendererMemory: memory,
      rendererMemoryComplete: isCompleteRendererMemory(memory),
      appOwnership: Object.freeze({
        renderPasses: passes.length,
        sceneObjects: telemetry.resources.objects,
        eventSubscribers: subscribers,
      }),
      aggregateCounterAvailability: Object.freeze({
        nodes: false,
        pendingUploads: false,
      }),
      resources: telemetry.resources,
    });
  }

  dispose(): Promise<void> {
    this.#disposeCalls += 1;
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    if (this.#state === "failed" && this.#renderer === null) {
      // Initialization already reported any cleanup failure together with its
      // primary error. Disposal acknowledges that completed cleanup attempt so
      // a composing owner does not count the same failure a second time.
      this.#disposePromise = Promise.resolve();
      return this.#disposePromise;
    }
    const deferred = deferredVoid();
    this.#disposePromise = deferred.promise;
    const beginDisposal = () => {
      void this.#performDispose().then(deferred.resolve, deferred.reject);
    };
    if (this.#telemetrySamplingActive || this.#failureSnapshotCaptureActive) {
      // Disposal is the one mutating API whose stable promise must be handed
      // back immediately. Defer its state transition until the synchronous
      // observation/evidence transaction has returned to its caller.
      queueMicrotask(beginDisposal);
    } else {
      beginDisposal();
    }
    return this.#disposePromise;
  }

  async #performDispose(): Promise<void> {
    if (this.#state === "initializing") {
      await this.#initializePromise?.catch(() => undefined);
      if (this.#isFailedWithoutRenderer()) {
        return;
      }
    }
    if (this.#state === "disposed") return;
    this.#state = "disposing";
    if (this.#activeRendererOperations > 0) await this.#drainRendererOperations();
    const renderer = this.#renderer;
    const cleanupErrors = createCleanupFailureCollector();
    const priorCleanupErrors = this.#activeCleanupErrors;
    this.#activeCleanupErrors = cleanupErrors;
    try {
      this.#transferPendingBackendDisposeEvidence(cleanupErrors);
      if (renderer) {
        this.#captureResourcesBeforeRendererDispose(renderer, cleanupErrors);
        this.#deactivateRendererEvents();
        await this.#disposeRenderer(renderer, cleanupErrors);
        try {
          this.#restoreRendererEvents(renderer);
        } catch (error: unknown) {
          if (!cleanupErrors.consumeNativeBackend(error)) cleanupErrors.add(error);
        }
      }
      this.#passes = [];
      this.#listeners.clear();
      this.#terminalResources = renderer
        ? this.#captureTerminalResources(renderer, cleanupErrors)
        : this.#terminalResources ?? Object.freeze(emptyResources());
      if (!renderer && this.#terminalRendererMemory === null) {
        this.#terminalRendererMemory = Object.freeze(unavailableRendererMemory());
        this.#resourceCounterProvenance = "unavailable";
      }
      this.#renderer = null;
      this.#eventBridgeActive = false;
      const cleanupError = this.#collapseCleanupErrors(cleanupErrors);
      this.#cleanupFailed = cleanupErrors.length > 0;
      this.#state = this.#cleanupFailed ? "failed" : "disposed";
      cleanupErrors.releaseRawReferences();
      this.#releaseFailureReferences();
      if (this.#cleanupFailed) throw cleanupError;
    } finally {
      if (this.#activeCleanupErrors === cleanupErrors) {
        this.#activeCleanupErrors = priorCleanupErrors;
      }
    }
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
    if (this.#eventEmissionActive) return;
    const isPrimaryFailure = !this.#runtimeFailureClaimed;
    if (isPrimaryFailure) this.#runtimeFailureClaimed = true;
    this.#eventEmissionActive = true;
    try {
    let occurredAtMs = 0;
    let clockFailure: unknown = null;
    let clockFailed = false;
    try {
      const observed = this.#now();
      if (Number.isFinite(observed)) occurredAtMs = observed;
      else {
        clockFailed = true;
        clockFailure = new Error("Graphics backend event clock returned a non-finite value.");
      }
    } catch (error: unknown) {
      clockFailed = true;
      clockFailure = error;
    }
    let publishedError = error;
    let clockWrappedError: Error | null = null;
    if (clockFailed) {
      const clockEvidence = immutableAggregateError(
        [error, clockFailure],
        "Graphics backend event and clock failures.",
      );
      clockWrappedError = new Error(
        `Graphics backend reported ${kind}; its event clock also failed.`,
        { cause: clockEvidence },
      );
      Object.freeze(clockWrappedError);
      publishedError = clockWrappedError;
    }
    const event = Object.freeze({ kind, error: publishedError, occurredAtMs });
    if (isPrimaryFailure) {
      this.#runtimeFailure = event;
      if (clockFailed) {
        this.#runtimeFailureError = clockWrappedError;
      } else {
        try {
          this.#runtimeFailureError = error instanceof Error
            ? error
            : new Error(
                `Graphics backend reported ${kind}.`,
                { cause: error },
              );
        } catch {
          this.#runtimeFailureError = new Error(
            `Graphics backend reported ${kind}.`,
            { cause: error },
          );
        }
      }
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // One diagnostic subscriber must not hide a terminal backend event from others.
      }
    }
    } finally {
      this.#eventEmissionActive = false;
    }
  }

  #assertNoRuntimeFailure(operation: string): void {
    const failure = this.#runtimeFailure;
    if (!failure) {
      if (!this.#runtimeFailureClaimed) return;
      const pending = new Error(
        `Cannot ${operation} while the first graphics backend failure is being captured.`,
      );
      Object.freeze(pending);
      throw pending;
    }
    if (!this.#runtimeFailureError) {
      this.#runtimeFailureError = new Error(
        `Cannot ${operation} after graphics backend reported ${failure.kind}.`,
        { cause: failure.error },
      );
    }
    throw this.#runtimeFailureError;
  }

  #retainedFailureReferenceCount(): number {
    return (this.#runtimeFailure === null ? 0 : 1)
      + (this.#runtimeFailureError === null ? 0 : 1)
      + (this.#pendingBackendDisposeEvidencePresent ? 1 : 0)
      + this.#resourceReadErrors.size;
  }

  #releaseFailureReferences(): void {
    this.#runtimeFailureClaimed = false;
    this.#eventEmissionActive = false;
    this.#runtimeFailure = null;
    this.#runtimeFailureError = null;
    this.#pendingBackendDisposeEvidence = undefined;
    this.#pendingBackendDisposeEvidencePresent = false;
    clearFailureOccurrences(this.#pendingBackendDisposeOccurrences);
    this.#failureSnapshotCaptureActive = false;
    this.#resourceReadErrors.clear();
    this.#viewport = null;
  }

  #deactivateRendererEvents(): void {
    this.#eventBridgeActive = false;
  }

  #restoreRendererEvents(renderer: ThreeRendererPort): void {
    const failures: unknown[] = [];
    // Restore the pre-adapter callbacks, not replacements that may close over
    // the bridge. During renderer.dispose the inactive bridge remains installed
    // so a replacement wrapper can still reach the original exactly once.
    try {
      this.#restoreRendererEventChannel(renderer, this.#rendererErrorChannel);
    } catch (error: unknown) {
      failures.push(error);
    } finally {
      this.#rendererErrorChannel = null;
    }
    try {
      this.#restoreRendererEventChannel(renderer, this.#rendererDeviceLostChannel);
    } catch (error: unknown) {
      failures.push(error);
    } finally {
      this.#rendererDeviceLostChannel = null;
      this.#eventBridgeActive = false;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw immutableAggregateError(
        failures,
        "Renderer event callbacks could not be restored.",
      );
    }
  }

  #attachRendererEvents(renderer: ThreeRendererPort): void {
    const failures: unknown[] = [];
    try {
      this.#attachRendererEventChannel(
        renderer,
        "onError",
        "renderer-error",
      );
    } catch (error: unknown) {
      failures.push(error);
    }
    try {
      this.#attachRendererEventChannel(
        renderer,
        "onDeviceLost",
        "device-lost",
      );
    } catch (error: unknown) {
      failures.push(error);
    }
    if (failures.length > 0) this.#eventBridgeActive = false;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw immutableAggregateError(
        failures,
        "Renderer event callbacks could not be installed.",
      );
    }
    this.#eventBridgeActive = true;
  }

  #attachRendererEventChannel(
    renderer: ThreeRendererPort,
    property: RendererEventProperty,
    kind: BackendRuntimeEvent["kind"],
  ): void {
    let channel = property === "onError"
      ? this.#rendererErrorChannel
      : this.#rendererDeviceLostChannel;
    if (!channel) {
      channel = {
        property,
        kind,
        originalDescriptor: undefined,
        originalDescriptorCaptured: false,
        restoreRequired: false,
        relay: null,
      };
      if (property === "onError") this.#rendererErrorChannel = channel;
      else this.#rendererDeviceLostChannel = channel;
    }
    if (!channel.originalDescriptorCaptured) {
      channel.originalDescriptor = Object.getOwnPropertyDescriptor(renderer, property);
      channel.originalDescriptorCaptured = true;
    }
    const currentListener = renderer[property];
    if (!channel.relay) {
      channel.relay = createRendererEventRelay(
        renderer,
        currentListener,
        (error) => this.#emit(kind, error),
      );
    } else if (currentListener !== channel.relay.currentBridge) {
      channel.relay.replace(currentListener);
    }
    // Publish the event gate before installation: a Proxy defineProperty trap
    // may invoke the descriptor before returning or throwing. The restore
    // obligation is published only after acquisition succeeds, or after a
    // throwing trap can be observed to have changed the original descriptor;
    // otherwise cleanup must leave the untouched property alone.
    this.#eventBridgeActive = true;
    const installedDescriptor = rendererEventDescriptor(channel.relay);
    try {
      Object.defineProperty(renderer, property, installedDescriptor);
    } catch (error: unknown) {
      if (!channel.restoreRequired) {
        let observedDescriptor: PropertyDescriptor | undefined;
        try {
          observedDescriptor = Object.getOwnPropertyDescriptor(renderer, property);
        } catch (inspectionError: unknown) {
          throw immutableAggregateError(
            [error, inspectionError],
            `Renderer event callback ${property} installation failed and acquisition could not be inspected.`,
          );
        }
        channel.restoreRequired = !rendererEventDescriptorsEqual(
          observedDescriptor,
          channel.originalDescriptor,
        );
      }
      throw error;
    }
    let observedDescriptor: PropertyDescriptor | undefined;
    try {
      observedDescriptor = Object.getOwnPropertyDescriptor(renderer, property);
    } catch (error: unknown) {
      // Object.defineProperty returned successfully, so cleanup must assume it
      // acquired the channel even though the postcondition cannot be inspected.
      channel.restoreRequired = true;
      throw error;
    }
    if (!rendererEventDescriptorsEqual(observedDescriptor, installedDescriptor)) {
      // A successful trap may acquire a transformed descriptor instead of the
      // requested accessor. Restore it unless readback proves that the
      // pre-adapter descriptor was left untouched.
      channel.restoreRequired = !rendererEventDescriptorsEqual(
        observedDescriptor,
        channel.originalDescriptor,
      );
      throw new Error(
        `Renderer event callback ${property} installation postcondition was not satisfied.`,
      );
    }
    channel.restoreRequired = true;
  }

  #restoreRendererEventChannel(
    renderer: ThreeRendererPort,
    channel: RendererEventChannel | null,
  ): void {
    if (!channel) return;
    const relay = channel.relay;
    // Revoke first so a descriptor left behind by a failed restoration has no
    // path back to this adapter, the renderer, or a replacement callback.
    revokeRendererEventRelay(relay);
    channel.relay = null;
    if (!channel.restoreRequired || !channel.originalDescriptorCaptured) return;
    channel.restoreRequired = false;
    if (channel.originalDescriptor) {
      Object.defineProperty(renderer, channel.property, channel.originalDescriptor);
      const restoredDescriptor = Object.getOwnPropertyDescriptor(renderer, channel.property);
      if (!rendererEventDescriptorsEqual(restoredDescriptor, channel.originalDescriptor)) {
        throw new Error(
          `Renderer event callback ${channel.property} restoration postcondition was not satisfied.`,
        );
      }
      return;
    }
    if (!Reflect.deleteProperty(renderer, channel.property)) {
      throw new TypeError(`Renderer event callback ${channel.property} could not be removed.`);
    }
    if (Object.getOwnPropertyDescriptor(renderer, channel.property) !== undefined) {
      throw new Error(
        `Renderer event callback ${channel.property} removal postcondition was not satisfied.`,
      );
    }
  }

  #captureTerminalResources(
    renderer: ThreeRendererPort,
    cleanupErrors: CleanupFailureCollector,
  ): Readonly<RenderResourceSnapshot> {
    try {
      const telemetry = this.#captureTelemetry(renderer, [], 0);
      if (!telemetry.available) throw telemetryReentrancyError();
      const resources = telemetry.resources;
      this.#terminalRendererMemory = telemetry.rendererMemory;
      if (this.#resourceCountersReadable) {
        this.#resourceCounterProvenance = "post-renderer-dispose-observation";
        this.#threeInfoResetObserved = Object.values(this.#terminalRendererMemory)
          .every((value) => value === 0);
      }
      return resources;
    } catch (error: unknown) {
      this.#recordResourceReadFailure(error, cleanupErrors);
      this.#terminalRendererMemory = Object.freeze(unavailableRendererMemory());
      return Object.freeze(emptyResources());
    }
  }

  #captureResourcesBeforeRendererDispose(
    renderer: ThreeRendererPort,
    cleanupErrors: CleanupFailureCollector,
  ): void {
    if (this.#resourcesBeforeRendererDispose !== null) return;
    try {
      const telemetry = this.#captureTelemetry(
        renderer,
        this.#passes,
        this.#listeners.size,
      );
      if (!telemetry.available) throw telemetryReentrancyError();
      this.#resourcesBeforeRendererDispose = telemetry.resources;
    } catch (error: unknown) {
      this.#recordResourceReadFailure(error, cleanupErrors);
      this.#resourcesBeforeRendererDispose = Object.freeze(emptyResources(this.#listeners.size));
    }
  }

  #recordResourceReadFailure(
    error: unknown,
    cleanupErrors: CleanupFailureCollector,
  ): void {
    const hasIdentity = (typeof error === "object" && error !== null)
      || typeof error === "function";
    if (hasIdentity) this.#resourceReadErrors.add(error);
    // Each failed observation is independent evidence even when a hostile
    // getter rethrows the same object in pre- and post-disposal phases. The one
    // immediate propagation of a native backend throw was already captured by
    // its wrapper and consumes its occurrence token instead of duplicating it.
    if (!cleanupErrors.consumeNativeBackend(error)) cleanupErrors.add(error);
    this.#resourceCountersReadable = false;
    this.#resourceCounterProvenance = "unavailable";
  }

  #captureTelemetry(
    renderer: ThreeRendererPort,
    passes: readonly RenderPass[],
    subscribers: number,
  ): RendererTelemetrySample {
    if (this.#telemetrySamplingActive) {
      // Never touch renderer or scene getters recursively. The nested observer
      // receives explicit unavailable evidence while the owning sample remains
      // free to complete or report its own source failure.
      return unavailableRendererTelemetry(subscribers);
    }
    this.#telemetrySamplingActive = true;
    try {
      return captureRendererTelemetry(renderer, passes, subscribers);
    } finally {
      this.#telemetrySamplingActive = false;
    }
  }

  #ensureBackendDisposeInstrumentation(renderer: ThreeRendererPort): void {
    if (this.#backendDisposeProbeAttempted) return;
    this.#backendDisposeProbeAttempted = true;
    const backend = renderer.backend;
    if (!backend || typeof backend.dispose !== "function") {
      throw new Error("Renderer backend disposal is not observable.");
    }
    const originalDispose = backend.dispose;
    const relay = { invoke: () => undefined };
    relay.invoke = () => {
      if (this.#backendDisposeInvoked) return;
      this.#backendDisposeInvoked = true;
      try {
        originalDispose.call(backend);
        this.#backendDisposeCompleted = true;
      } catch (error: unknown) {
        // Capture native failure evidence before renderer cleanup can swallow
        // it or a queued microtask can mutate its caller-owned graph.
        const cleanupErrors = this.#activeCleanupErrors;
        if (cleanupErrors) {
          cleanupErrors.addNativeBackend(error);
        } else {
          // Publish a provisional, reference-free obligation before inspecting
          // hostile Error/AggregateError properties. A message getter may call
          // dispose reentrantly, but that disposal must wait for the completed
          // immutable snapshot instead of observing "no failure".
          rememberFailureOccurrence(this.#pendingBackendDisposeOccurrences, error);
          this.#pendingBackendDisposeEvidence = immutableFailureMarker(
            "Native backend failure evidence capture is in progress.",
          );
          this.#pendingBackendDisposeEvidencePresent = true;
          this.#failureSnapshotCaptureActive = true;
          try {
            this.#pendingBackendDisposeEvidence = immutableFailureSnapshot(error);
          } finally {
            this.#failureSnapshotCaptureActive = false;
          }
        }
        throw error;
      }
    };
    // The published wrapper closes only over a revocable relay. Terminal
    // cleanup replaces relay.invoke, severing both behavior and adapter reachability.
    const wrapper = () => relay.invoke();
    this.#instrumentedBackend = backend;
    this.#instrumentedBackendWrapper = wrapper;
    this.#instrumentedBackendRelay = relay;
    try {
      backend.dispose = wrapper;
      if (backend.dispose !== wrapper) {
        throw new Error("Renderer backend disposal instrumentation was not installed.");
      }
      this.#backendDisposeInstrumented = true;
    } catch (error: unknown) {
      let readbackFailure: unknown = null;
      let readbackFailed = false;
      try {
        this.#backendDisposeInstrumented = backend.dispose === wrapper;
      } catch (readError: unknown) {
        readbackFailed = true;
        readbackFailure = readError;
      }
      // Retain the backend and wrapper handles through unwind even when the
      // assignment threw: a setter may install the wrapper before throwing.
      if (readbackFailed) {
        throw immutableAggregateError(
          [error, readbackFailure],
          "Renderer backend disposal instrumentation failed and could not be read back.",
        );
      }
      throw error;
    }
  }

  async #disposeRenderer(
    renderer: ThreeRendererPort,
    cleanupErrors: CleanupFailureCollector,
  ): Promise<void> {
    const priorCleanupErrors = this.#activeCleanupErrors;
    this.#activeCleanupErrors = cleanupErrors;
    try {
      // Initialization-unwind telemetry can invoke the instrumented backend
      // after its collector was first created but before renderer disposal.
      this.#transferPendingBackendDisposeEvidence(cleanupErrors);
      if (!this.#backendDisposeProbeAttempted) {
        try {
          this.#ensureBackendDisposeInstrumentation(renderer);
        } catch (error: unknown) {
          if (!cleanupErrors.consumeNativeBackend(error)) cleanupErrors.add(error);
        }
      }

      this.#rendererDisposeInvoked = true;
      let rendererDisposeFailed = false;
      try {
        renderer.dispose();
        this.#rendererDisposeCompleted = true;
      } catch (error: unknown) {
        rendererDisposeFailed = true;
        if (!cleanupErrors.consumeNativeBackend(error)) cleanupErrors.add(error);
      }

      // Some renderers defer their backend disposal to the next microtask. Wait
      // once for the instrumented call, but never invoke the opaque backend a
      // second time: a renderer may have captured its native dispose function.
      await Promise.resolve();
      if (
        this.#backendDisposeInstrumented
        && !this.#backendDisposeInvoked
        && !rendererDisposeFailed
      ) {
        cleanupErrors.add(new Error(
          "Renderer disposal completed without an observable backend disposal call.",
        ));
      }
      // A renderer that swallowed the native throw leaves no propagation to
      // consume. Expire the token before later telemetry so an independent
      // reuse of the same value remains a distinct occurrence.
      cleanupErrors.clearNativeBackendOccurrences();
      this.#detachBackendDisposeInstrumentation(cleanupErrors);
    } finally {
      if (this.#activeCleanupErrors === cleanupErrors) {
        this.#activeCleanupErrors = priorCleanupErrors;
      }
    }
  }

  #detachBackendDisposeInstrumentation(cleanupErrors: CleanupFailureCollector): void {
    const backend = this.#instrumentedBackend;
    const wrapper = this.#instrumentedBackendWrapper;
    const relay = this.#instrumentedBackendRelay;
    if (relay) relay.invoke = () => undefined;
    this.#instrumentedBackend = null;
    this.#instrumentedBackendWrapper = null;
    this.#instrumentedBackendRelay = null;
    if (!backend || !wrapper) return;
    try {
      // The native backend has already had its single disposal opportunity.
      // Always sever the backend's current chain: a replacement may close over
      // the instrumented wrapper even when it is not reference-equal to it.
      backend.dispose = () => undefined;
    } catch (error: unknown) {
      cleanupErrors.add(error);
    }
  }

  #transferPendingBackendDisposeEvidence(
    cleanupErrors: CleanupFailureCollector,
  ): void {
    if (!this.#pendingBackendDisposeEvidencePresent) return;
    const evidence = this.#pendingBackendDisposeEvidence;
    this.#pendingBackendDisposeEvidence = undefined;
    this.#pendingBackendDisposeEvidencePresent = false;
    clearFailureOccurrences(this.#pendingBackendDisposeOccurrences);
    cleanupErrors.add(evidence);
  }

  #consumePendingBackendDisposePrimary(error: unknown): boolean {
    if (
      !this.#pendingBackendDisposeEvidencePresent
      || !consumeFailureOccurrence(this.#pendingBackendDisposeOccurrences, error)
    ) {
      return false;
    }
    this.#pendingBackendDisposeEvidence = undefined;
    this.#pendingBackendDisposeEvidencePresent = false;
    clearFailureOccurrences(this.#pendingBackendDisposeOccurrences);
    return true;
  }

  #collapseCleanupErrors(errors: CleanupFailureCollector): unknown {
    if (errors.length === 0) return null;
    const snapshots = errors.snapshots();
    if (snapshots.length === 1) return snapshots[0];
    return immutableAggregateError(
      snapshots,
      "Three backend cleanup failed in multiple operations.",
    );
  }

  #isFailedWithoutRenderer(): boolean {
    return this.#state === "failed" && this.#renderer === null;
  }

  #applyViewport(viewport: RenderViewport): void {
    const renderer = this.#renderer;
    if (!renderer) return;
    this.#assertNoRuntimeFailure("apply viewport");
    renderer.setPixelRatio(viewport.pixelRatio);
    this.#assertNoRuntimeFailure("apply viewport");
    renderer.setSize(viewport.width, viewport.height, false);
    this.#assertNoRuntimeFailure("apply viewport");
    this.#applyPassCameras(viewport);
  }

  #applyPassCameras(viewport: RenderViewport): void {
    const aspect = viewport.width / viewport.height;
    for (const pass of this.#passes) {
      const camera = pass.camera as {
        isPerspectiveCamera?: boolean;
        aspect?: number;
        updateProjectionMatrix?: () => void;
      } | undefined;
      this.#assertNoRuntimeFailure("inspect viewport camera");
      if (!camera) continue;
      if ((typeof camera !== "object" && typeof camera !== "function") || camera === null) continue;
      const isPerspectiveCamera = camera.isPerspectiveCamera;
      this.#assertNoRuntimeFailure("inspect viewport camera");
      if (isPerspectiveCamera === true) {
        const currentAspect = camera.aspect;
        this.#assertNoRuntimeFailure("inspect viewport camera aspect");
        if (this.#cameraAspects.get(camera) === aspect && currentAspect === aspect) continue;
        camera.aspect = aspect;
        this.#assertNoRuntimeFailure("update viewport camera aspect");
        const updateProjectionMatrix = camera.updateProjectionMatrix;
        this.#assertNoRuntimeFailure("inspect viewport projection update");
        updateProjectionMatrix?.call(camera);
        this.#assertNoRuntimeFailure("update viewport projection");
        this.#cameraAspects.set(camera, aspect);
      }
    }
  }

  #capturePasses(passes: readonly RenderPass[], operation: string): readonly RenderPass[] {
    this.#assertNoRuntimeFailure(operation);
    const length = passes.length;
    this.#assertNoRuntimeFailure(operation);
    if (!Number.isSafeInteger(length) || length < 0 || length > 256) {
      throw new RangeError("A renderer operation accepts at most 256 render passes.");
    }
    const captured: RenderPass[] = [];
    for (let index = 0; index < length; index += 1) {
      const present = Object.prototype.hasOwnProperty.call(passes, index);
      this.#assertNoRuntimeFailure(operation);
      if (!present) continue;
      const pass = passes[index];
      this.#assertNoRuntimeFailure(operation);
      const name = pass.name;
      this.#assertNoRuntimeFailure(operation);
      if (typeof name !== "string" || !name.trim()) {
        throw new TypeError("A render pass requires non-empty name and kind fields.");
      }
      const kind = pass.kind;
      this.#assertNoRuntimeFailure(operation);
      if (typeof kind !== "string" || !kind.trim()) {
        throw new TypeError("A render pass requires non-empty name and kind fields.");
      }
      const scene = pass.scene;
      this.#assertNoRuntimeFailure(operation);
      const camera = pass.camera;
      this.#assertNoRuntimeFailure(operation);
      const payload = pass.payload;
      this.#assertNoRuntimeFailure(operation);
      captured.push(Object.freeze(payload === undefined
        ? { name, kind, scene, camera }
        : { name, kind, scene, camera, payload }));
    }
    return Object.freeze(captured);
  }

  #beginRendererOperation(): Readonly<{
    renderer: ThreeRendererPort;
    release(): void;
  }> {
    const renderer = this.#renderer;
    if (!renderer) throw new Error("Cannot begin a renderer operation without a renderer.");
    if (this.#activeRendererOperations === 0) {
      this.#activeRendererOperationsDrain = deferredVoid();
    }
    this.#activeRendererOperations += 1;
    let released = false;
    return Object.freeze({
      renderer,
      release: () => {
        if (released) return;
        released = true;
        this.#activeRendererOperations -= 1;
        if (this.#activeRendererOperations !== 0) return;
        const drain = this.#activeRendererOperationsDrain;
        this.#activeRendererOperationsDrain = null;
        drain?.resolve();
      },
    });
  }

  async #drainRendererOperations(): Promise<void> {
    while (this.#activeRendererOperations > 0) {
      const drain = this.#activeRendererOperationsDrain;
      if (!drain) {
        await Promise.resolve();
        continue;
      }
      await drain.promise;
    }
  }

  #assertReady(operation: string): void {
    if (this.#state !== "ready" || !this.#renderer) {
      throw new Error(`Cannot ${operation} Three backend while ${this.#state}.`);
    }
  }

  #assertNoPendingDisposal(operation: string): void {
    if (this.#disposePromise !== null && this.#state === "ready") {
      throw new Error(
        `Cannot ${operation} Three backend after disposal was requested.`,
      );
    }
  }
}
