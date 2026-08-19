import type {
  BackendInitializationContext,
  BackendRuntimeEvent,
  RenderBackendAdapter,
  RenderBackendFrameTelemetry,
  RenderBackendFacts,
  RenderPass,
  RenderResourceSnapshot,
  RenderViewport,
  Unsubscribe,
} from "../contracts";
import type { ThreeRenderPipelinePort } from "../pipeline/contracts";

const intrinsicHasOwnProperty = Object.prototype.hasOwnProperty;
const intrinsicReflectApply = Reflect.apply;

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
  readonly render?: {
    readonly calls?: number;
    readonly triangles?: number;
    readonly lines?: number;
    readonly points?: number;
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
  /** Optional GFX-005 whole-frame submission seam. The direct GFX-002 path remains the default. */
  readonly pipeline?: ThreeRenderPipelinePort;
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
      if (!intrinsicReflectApply(intrinsicHasOwnProperty, children, [index])) continue;
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

const unavailableFrameTelemetry = Object.freeze({
  available: false,
  drawCalls: null,
  triangles: null,
  lines: null,
  points: null,
  pixelRatio: null,
  drawingBufferWidth: null,
  drawingBufferHeight: null,
  gpuTimeMs: null,
}) satisfies Readonly<RenderBackendFrameTelemetry>;

function frameCounter(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || Object.is(value, -0)
  ) {
    throw new TypeError(`Renderer ${label} telemetry is invalid.`);
  }
  return value;
}

function captureRendererFrameTelemetry(
  renderer: ThreeRendererPort,
  viewport: Readonly<RenderViewport>,
): Readonly<RenderBackendFrameTelemetry> {
  const info = renderer.info;
  const render = info?.render;
  if (!render) return unavailableFrameTelemetry;
  const drawCalls = frameCounter(render.calls, "draw-call");
  const triangles = frameCounter(render.triangles, "triangle");
  const lines = frameCounter(render.lines, "line");
  const points = frameCounter(render.points, "point");
  const pixelRatio = viewport.pixelRatio;
  const drawingBufferWidth = Math.round(viewport.width * pixelRatio);
  const drawingBufferHeight = Math.round(viewport.height * pixelRatio);
  if (
    !Number.isFinite(pixelRatio)
    || pixelRatio < 0
    || Object.is(pixelRatio, -0)
    || !Number.isSafeInteger(drawingBufferWidth)
    || drawingBufferWidth < 0
    || !Number.isSafeInteger(drawingBufferHeight)
    || drawingBufferHeight < 0
  ) {
    throw new TypeError("Renderer drawing-buffer telemetry is invalid.");
  }
  return Object.freeze({
    available: true,
    drawCalls,
    triangles,
    lines,
    points,
    pixelRatio,
    drawingBufferWidth,
    drawingBufferHeight,
    gpuTimeMs: null,
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
const ownedFailureSnapshots = new WeakSet<object>();

function defineImmutableFailureField(
  target: object,
  property: "cause" | "errors" | "message" | "stack" | "textTruncated",
  value: unknown,
): void {
  Object.defineProperty(target, property, {
    configurable: false,
    enumerable: false,
    value,
    writable: false,
  });
}

function immutableError(
  message?: string,
  cause: ImmutableCauseSnapshot = absentImmutableCause,
  textTruncated = false,
): Error {
  const error = Object.create(Error.prototype) as Error;
  if (message !== undefined) defineImmutableFailureField(error, "message", message);
  if (cause.present) defineImmutableFailureField(error, "cause", cause.value);
  if (textTruncated) defineImmutableFailureField(error, "textTruncated", true);
  defineImmutableFailureField(error, "stack", undefined);
  ownedFailureSnapshots.add(error);
  Object.freeze(error);
  return error;
}

function immutableAggregateError(
  errors: readonly unknown[],
  message?: string,
  cause: ImmutableCauseSnapshot = absentImmutableCause,
  context?: FailureSnapshotContext,
  messageAlreadyTruncated = false,
): AggregateError {
  const boundedMessage = message === undefined || context === undefined
    ? Object.freeze({ value: message, truncated: messageAlreadyTruncated })
    : boundedFailureText(message, context);
  const aggregate = Object.create(AggregateError.prototype) as AggregateError;
  const immutableErrors = Object.freeze([...errors]);
  defineImmutableFailureField(aggregate, "errors", immutableErrors);
  if (boundedMessage.value !== undefined) {
    defineImmutableFailureField(aggregate, "message", boundedMessage.value);
  }
  if (cause.present) defineImmutableFailureField(aggregate, "cause", cause.value);
  if (boundedMessage.truncated) {
    defineImmutableFailureField(aggregate, "textTruncated", true);
  }
  defineImmutableFailureField(aggregate, "stack", undefined);
  ownedFailureSnapshots.add(aggregate);
  Object.freeze(aggregate);
  return aggregate;
}

function immutableAggregateCauseSnapshot(
  value: unknown,
  context: FailureSnapshotContext,
  ownedSnapshot = false,
  depth = 0,
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
  if (ownedSnapshot) {
    return Object.freeze({
      present: true,
      // Untrusted Aggregate causes are captured as one special owned node
      // without advancing the errors-list depth. Rebudget that trusted node at
      // the same depth so retry cannot relabel an accepted depth-32 marker.
      value: immutableFailureSnapshot(cause, depth, context),
    });
  }
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
      ? immutableFailurePrimitiveSnapshot(cause, context)
      : immutableFailureLimitMarker(context),
  });
}

type FailureSnapshotContext = {
  readonly activePath: Set<unknown>;
  visitedNodes: number;
  readonly maximumNodes: number;
  remainingTextUnits: number;
  limitMarker: Error | null;
  textLimitMarker: Error | null;
};

type BoundedFailureText = Readonly<{
  value?: string;
  truncated: boolean;
}>;

const maximumFailureSnapshotNodes = 2_048;
const maximumFailureTextUnits = 4_096;
const maximumFailureTextFieldUnits = 256;
const maximumInlineFailureBigIntMagnitude = BigInt(`1${"0".repeat(128)}`);

function createFailureSnapshotContext(): FailureSnapshotContext {
  return {
    activePath: new Set(),
    visitedNodes: 0,
    maximumNodes: maximumFailureSnapshotNodes,
    remainingTextUnits: maximumFailureTextUnits,
    limitMarker: null,
    textLimitMarker: null,
  };
}

function boundedFailureText(
  value: string,
  context: FailureSnapshotContext,
  prefix = "",
  suffix = "",
): BoundedFailureText {
  const wrapperLength = prefix.length + suffix.length;
  const maximumOutputLength = Math.min(
    maximumFailureTextFieldUnits,
    context.remainingTextUnits,
  );
  if (wrapperLength > maximumOutputLength) return { truncated: true };
  const maximumValueOutputLength = maximumOutputLength - wrapperLength;
  if (value.length <= maximumValueOutputLength) {
    const output = `${prefix}${value}${suffix}`;
    context.remainingTextUnits -= output.length;
    return { value: output, truncated: false };
  }
  let retainedLength = maximumValueOutputLength;
  let truncationSuffix = "";
  for (;;) {
    truncationSuffix = `[truncated ${value.length - retainedLength} UTF-16 code units]`;
    const nextRetainedLength = Math.max(
      0,
      maximumValueOutputLength - truncationSuffix.length,
    );
    if (nextRetainedLength === retainedLength) break;
    retainedLength = nextRetainedLength;
  }
  if (truncationSuffix.length > maximumValueOutputLength) return { truncated: true };
  const output = `${prefix}${value.slice(0, retainedLength)}${truncationSuffix}${suffix}`;
  context.remainingTextUnits -= output.length;
  return { value: output, truncated: true };
}

function immutableFailurePrimitiveSnapshot(
  value: unknown,
  context: FailureSnapshotContext,
): unknown {
  if (typeof value === "string") {
    const bounded = boundedFailureText(value, context);
    return bounded.value ?? immutableFailureTextLimitMarker(context);
  }
  if (typeof value === "bigint") {
    const text = value > -maximumInlineFailureBigIntMagnitude
      && value < maximumInlineFailureBigIntMagnitude
      ? value.toString()
      : `${value < BigInt(0) ? "-" : ""}[bigint omitted beyond 128 decimal digits]`;
    const bounded = boundedFailureText(text, context);
    return bounded.value ?? immutableFailureTextLimitMarker(context);
  }
  if (typeof value === "symbol") {
    const description = value.description;
    const bounded = description === undefined
      ? boundedFailureText("Symbol()", context)
      : boundedFailureText(description, context, "Symbol(", ")");
    return bounded.value ?? immutableFailureTextLimitMarker(context);
  }
  return value;
}

function immutableFailureMarker(
  message: string,
  context: FailureSnapshotContext = createFailureSnapshotContext(),
  suffix = "",
): Error {
  const bounded = boundedFailureText(message, context, "", suffix);
  return immutableError(bounded.value, absentImmutableCause, bounded.truncated);
}

function immutableFailureTextLimitMarker(context: FailureSnapshotContext): Error {
  if (context.textLimitMarker !== null) return context.textLimitMarker;
  context.textLimitMarker = immutableError(undefined, absentImmutableCause, true);
  return context.textLimitMarker;
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
    context,
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
    ? immutableFailureMarker(message, context)
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
  context: FailureSnapshotContext = createFailureSnapshotContext(),
): unknown {
  if (!claimFailureSnapshotNode(context)) return immutableFailureLimitMarker(context);
  const hasIdentity = (typeof value === "object" && value !== null)
    || typeof value === "function";
  if (!hasIdentity) return immutableFailurePrimitiveSnapshot(value, context);
  if (depth > 32 || context.activePath.has(value)) {
    return immutableFailureMarker(
      depth > 32
        ? "Backend failure evidence exceeded the snapshot depth limit."
        : "Cyclic backend failure evidence was sanitized.",
      context,
    );
  }

  context.activePath.add(value);
  try {
    let isAggregate = false;
    let isError = false;
    try {
      isAggregate = value instanceof AggregateError;
      isError = value instanceof Error;
    } catch {
      return immutableFailureMarker("Opaque backend failure evidence was sanitized.", context);
    }

    const ownedSnapshot = ownedFailureSnapshots.has(value as object);
    let rawMessage: string | undefined = isAggregate
      ? "Backend operation failed with multiple errors."
      : "Backend operation failed.";
    let sourceMessageTruncated = false;
    if (ownedSnapshot) {
      const messageDescriptor = Object.getOwnPropertyDescriptor(value, "message");
      rawMessage = messageDescriptor && "value" in messageDescriptor
        && typeof messageDescriptor.value === "string"
        ? messageDescriptor.value
        : undefined;
      const truncatedDescriptor = Object.getOwnPropertyDescriptor(value, "textTruncated");
      sourceMessageTruncated = truncatedDescriptor !== undefined
        && "value" in truncatedDescriptor
        && truncatedDescriptor.value === true;
    } else {
      try {
        const observed = (value as { readonly message?: unknown }).message;
        if (typeof observed === "string" && observed.length > 0) rawMessage = observed;
      } catch {
        // The safe snapshot intentionally keeps no reference to the source value.
      }
    }

    if (isAggregate) {
      const message = rawMessage === undefined
        ? Object.freeze({ value: undefined, truncated: sourceMessageTruncated })
        : boundedFailureText(rawMessage, context);
      const messageTruncated = sourceMessageTruncated || message.truncated;
      const cause = immutableAggregateCauseSnapshot(value, context, ownedSnapshot, depth);
      let entries: unknown;
      try {
        entries = (value as AggregateError).errors;
      } catch {
        return immutableAggregateError(
          immutableInvalidAggregateDetails(context),
          message.value,
          cause,
          undefined,
          messageTruncated,
        );
      }
      try {
        if (!Array.isArray(entries)) {
          return immutableAggregateError(
            immutableInvalidAggregateDetails(context),
            message.value,
            cause,
            undefined,
            messageTruncated,
          );
        }
        const length = entries.length;
        if (!Number.isSafeInteger(length) || length < 0 || length > 256) {
          return immutableAggregateError(
            immutableInvalidAggregateDetails(context),
            message.value,
            cause,
            undefined,
            messageTruncated,
          );
        }
        const snapshots: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          if (!failureSnapshotNodeCapacity(context)) {
            snapshots.push(immutableFailureLimitMarker(context));
            break;
          }
          if (!intrinsicReflectApply(intrinsicHasOwnProperty, entries, [index])) continue;
          snapshots.push(immutableFailureSnapshot(entries[index], depth + 1, context));
        }
        return immutableAggregateError(
          snapshots,
          message.value,
          cause,
          undefined,
          messageTruncated,
        );
      } catch {
        return immutableAggregateError(
          immutableInvalidAggregateDetails(context),
          message.value,
          cause,
          undefined,
          messageTruncated,
        );
      }
    }

    if (isError) {
      let causePresent = false;
      let cause: unknown;
      try {
        causePresent = intrinsicReflectApply(intrinsicHasOwnProperty, value, ["cause"]);
        if (causePresent) cause = (value as Error).cause;
      } catch {
        return immutableFailureMarker(
          rawMessage ?? "Backend operation failed.",
          context,
          " (cause was sanitized)",
        );
      }
      const message = rawMessage === undefined
        ? Object.freeze({ value: undefined, truncated: sourceMessageTruncated })
        : boundedFailureText(rawMessage, context);
      const messageTruncated = sourceMessageTruncated || message.truncated;
      return causePresent
        ? immutableError(message.value, Object.freeze({
            present: true,
            value: immutableFailureSnapshot(cause, depth + 1, context),
          }), messageTruncated)
        : immutableError(message.value, absentImmutableCause, messageTruncated);
    }

    return immutableFailureMarker("Opaque backend failure evidence was sanitized.", context);
  } finally {
    context.activePath.delete(value);
  }
}

type FailureOccurrenceTokens = {
  identities: WeakSet<object>;
  propagations: WeakSet<object>;
  readonly primitives: Array<null | undefined | boolean | number>;
};

const maximumFailurePrimitiveTokens = 32;

function createNativeBackendFailurePropagation(tokens: FailureOccurrenceTokens): object {
  const propagation = Object.freeze(Object.create(null)) as object;
  tokens.identities.add(propagation);
  tokens.propagations.add(propagation);
  return propagation;
}

type FailureOccurrenceMatch = "propagation" | "source";

function createFailureOccurrenceTokens(): FailureOccurrenceTokens {
  return {
    identities: new WeakSet<object>(),
    propagations: new WeakSet<object>(),
    primitives: [],
  };
}

function rememberFailureOccurrence(tokens: FailureOccurrenceTokens, error: unknown): boolean {
  const hasIdentity = (typeof error === "object" && error !== null)
    || typeof error === "function";
  if (hasIdentity) {
    tokens.identities.add(error as object);
    return true;
  }
  // String, BigInt, and Symbol cannot be represented with exact SameValue
  // semantics in a bounded, non-owning token. Never retain them here. Internal
  // propagation uses an adapter-owned identity token instead, while a direct
  // ready-state caller still receives the original thrown primitive.
  if (
    typeof error === "string"
    || typeof error === "bigint"
    || typeof error === "symbol"
  ) return false;
  if (tokens.primitives.some((token) => Object.is(token, error))) return true;
  if (tokens.primitives.length >= maximumFailurePrimitiveTokens) return false;
  tokens.primitives.push(error as null | undefined | boolean | number);
  return true;
}

function consumeFailureOccurrence(
  tokens: FailureOccurrenceTokens,
  error: unknown,
): FailureOccurrenceMatch | null {
  const hasIdentity = (typeof error === "object" && error !== null)
    || typeof error === "function";
  if (hasIdentity) {
    if (!tokens.identities.has(error as object)) return null;
    const match = tokens.propagations.has(error as object) ? "propagation" : "source";
    tokens.identities.delete(error as object);
    tokens.propagations.delete(error as object);
    return match;
  }
  const index = tokens.primitives.findIndex((token) => Object.is(token, error));
  if (index < 0) return null;
  tokens.primitives.splice(index, 1);
  return "source";
}

function clearFailureOccurrences(tokens: FailureOccurrenceTokens): void {
  tokens.identities = new WeakSet<object>();
  tokens.propagations = new WeakSet<object>();
  tokens.primitives.length = 0;
}

type CleanupFailureCollector = Readonly<{
  readonly length: number;
  add(error: unknown): unknown;
  capture(error: unknown): unknown;
  aggregate(errors: readonly unknown[], message: string): AggregateError;
  appendSnapshots(snapshots: readonly unknown[]): void;
  addNativeBackend(error: unknown): unknown;
  consumeNativeBackend(error: unknown): boolean;
  clearNativeBackendOccurrences(): void;
  fork(): CleanupFailureCollector;
  snapshots(): readonly unknown[];
  releaseRawReferences(): void;
}>;

function createCleanupFailureCollector(
  sharedContext?: FailureSnapshotContext,
  sharedOccurrences?: FailureOccurrenceTokens,
): CleanupFailureCollector {
  const nativeOccurrences = sharedOccurrences ?? createFailureOccurrenceTokens();
  const immutableSnapshots: unknown[] = [];
  const ownsContext = sharedContext === undefined;
  const ownsOccurrences = sharedOccurrences === undefined;
  const context = sharedContext ?? createFailureSnapshotContext();
  const addSnapshot = (error: unknown) => {
    // Snapshot at the catch boundary, before any awaited cleanup stage can
    // give caller-owned errors an opportunity to mutate. One context bounds
    // the entire cleanup suffix rather than granting each error a new budget.
    const snapshot = immutableFailureSnapshot(error, 0, context);
    immutableSnapshots.push(snapshot);
    return snapshot;
  };
  return {
    get length() {
      return immutableSnapshots.length;
    },
    add(error: unknown) {
      return addSnapshot(error);
    },
    capture(error: unknown) {
      return immutableFailureSnapshot(error, 0, context);
    },
    aggregate(errors: readonly unknown[], message: string) {
      return immutableAggregateError(errors, message, absentImmutableCause, context);
    },
    appendSnapshots(snapshots: readonly unknown[]) {
      // Fork snapshots already consumed this collector's shared traversal
      // budget. Append them without re-reading the failure graph.
      immutableSnapshots.push(...snapshots);
    },
    addNativeBackend(error: unknown) {
      addSnapshot(error);
      const propagation = createNativeBackendFailurePropagation(nativeOccurrences);
      // The renderer-facing throw carries no caller primitive. The immutable
      // snapshot already records the native failure in this collector.
      return propagation;
    },
    consumeNativeBackend(error: unknown) {
      return consumeFailureOccurrence(nativeOccurrences, error) !== null;
    },
    clearNativeBackendOccurrences() {
      clearFailureOccurrences(nativeOccurrences);
    },
    fork() {
      return createCleanupFailureCollector(context, nativeOccurrences);
    },
    snapshots() {
      return Object.freeze([...immutableSnapshots]);
    },
    releaseRawReferences() {
      if (ownsOccurrences) clearFailureOccurrences(nativeOccurrences);
      if (ownsContext) {
        context.activePath.clear();
        context.limitMarker = null;
        context.textLimitMarker = null;
      }
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
      intrinsicReflectApply(currentListener, renderer, [error]);
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

function sameRenderViewport(
  left: Readonly<RenderViewport>,
  right: Readonly<RenderViewport>,
): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.pixelRatio === right.pixelRatio;
}

type PendingBackendResize = {
  readonly viewport: Readonly<RenderViewport>;
  pipelineComplete: boolean;
  rendererComplete: boolean;
  attempt: Promise<void> | null;
};

type RendererOperation = Readonly<{
  renderer: ThreeRendererPort;
  release(): void;
}>;

/**
 * Backend implementation with the raw Three renderer held in a private field.
 * RenderHost is the sole animation-loop owner; this adapter never starts one.
 */
export class ThreeRenderBackendAdapter implements ThreeBackendAdapter {
  readonly #options: ThreeBackendAdapterOptions;
  #pipeline: ThreeRenderPipelinePort | null;
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
  #nonRetryableCleanupFailure: unknown = null;
  #nonRetryableCleanupFailurePresent = false;
  #runtimeFailureClaimed = false;
  #eventEmissionActive = false;
  #runtimeFailure: Readonly<BackendRuntimeEvent> | null = null;
  #runtimeFailureError: Error | null = null;
  readonly #cameraAspects = new WeakMap<object, number>();
  #activeRendererOperations = 0;
  #activeRendererOperationsDrain: ReturnType<typeof deferredVoid> | null = null;
  #resizeOperationActive = false;
  #pendingResize: PendingBackendResize | null = null;
  #resizeCaptureActive = false;
  #externalPipelineCallbackDepth = 0;
  #telemetrySamplingActive = false;

  constructor(options: ThreeBackendAdapterOptions) {
    this.#pipeline = options.pipeline ?? null;
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
    if (this.#externalPipelineCallbackDepth !== 0) {
      return Promise.reject(new Error(
        "Cannot initialize Three backend reentrantly from a pipeline callback.",
      ));
    }
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
      await this.#invokePipelineCallback(
        () => this.#pipeline?.attachBackend(renderer, observedBackend, context.viewport),
      );
      this.#assertNoRuntimeFailure("attach Linear HDR pipeline");
      this.#state = "ready";
    } catch (error: unknown) {
      const cleanupErrors = createCleanupFailureCollector();
      const priorCleanupErrors = this.#activeCleanupErrors;
      this.#activeCleanupErrors = cleanupErrors;
      try {
        const pendingPrimary = this.#consumePendingBackendDisposePrimary(error);
        const primaryError = pendingPrimary === null
          ? error
          : pendingPrimary.requiresRebudget
            ? cleanupErrors.capture(pendingPrimary.value)
            : pendingPrimary.value;
        if (pendingPrimary === null) {
          this.#transferPendingBackendDisposeEvidence(cleanupErrors);
        }
        if (renderer) {
          this.#captureResourcesBeforeRendererDispose(renderer, cleanupErrors);
        }
        const pipelineCleanupErrors = cleanupErrors.fork();
        if (this.#pipeline) await this.#disposePipeline(pipelineCleanupErrors);
        const pipelineFailureStart = cleanupErrors.length;
        cleanupErrors.appendSnapshots(pipelineCleanupErrors.snapshots());
        const pipelineFailureEnd = cleanupErrors.length;
        pipelineCleanupErrors.releaseRawReferences();
        if (renderer) {
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
        this.#rememberNonRetryableCleanupFailure(
          cleanupErrors,
          pipelineFailureStart,
          pipelineFailureEnd,
        );
        const terminalFailure = cleanupErrors.length > 0
          ? cleanupErrors.aggregate(
            [primaryError, ...cleanupSnapshots],
            "Three backend initialization failed and renderer cleanup also failed.",
          )
          : primaryError;
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

  async resize(viewport: RenderViewport): Promise<void> {
    if (this.#externalPipelineCallbackDepth !== 0) {
      throw new Error("Cannot resize Three backend reentrantly from a pipeline callback.");
    }
    if (this.#telemetrySamplingActive) {
      throw telemetryMutationError("resize Three backend");
    }
    this.#assertNoPendingDisposal("resize");
    this.#assertReady("resize");
    this.#assertNoRuntimeFailure("resize");
    if (this.#resizeCaptureActive) {
      throw new Error("Cannot resize Three backend reentrantly during viewport capture.");
    }
    const pendingAtAdmission = this.#pendingResize;
    const existingAttempt = pendingAtAdmission?.attempt ?? null;
    const operation = existingAttempt === null
      ? this.#beginRendererOperation("resize")
      : null;
    try {
      this.#resizeCaptureActive = true;
      let next: Readonly<RenderViewport>;
      try {
        next = Object.freeze({
          width: viewport.width,
          height: viewport.height,
          pixelRatio: viewport.pixelRatio,
        });
      } finally {
        this.#resizeCaptureActive = false;
      }
      this.#assertNoPendingDisposal("resize");
      this.#assertReady("resize");
      this.#assertNoRuntimeFailure("resize");
      let transaction = this.#pendingResize;
      if (transaction) {
        if (!sameRenderViewport(transaction.viewport, next)) {
          throw new Error("Cannot change the Three backend resize target while a prior resize is pending.");
        }
        if (transaction.attempt) {
          await transaction.attempt;
          return;
        }
      } else {
        transaction = {
          viewport: next,
          pipelineComplete: false,
          rendererComplete: false,
          attempt: null,
        };
        this.#pendingResize = transaction;
      }
      if (!operation) {
        throw new Error("Cannot retry Three backend resize without an exclusive renderer reservation.");
      }
      const deferred = deferredVoid();
      const attempt = deferred.promise;
      transaction.attempt = attempt;
      this.#resizeCalls += 1;
      void this.#performResize(transaction, operation).then(deferred.resolve, deferred.reject);
      try {
        await attempt;
      } finally {
        if (transaction.attempt === attempt) transaction.attempt = null;
        if (
          transaction.pipelineComplete
          && transaction.rendererComplete
          && this.#pendingResize === transaction
        ) {
          this.#pendingResize = null;
        }
      }
    } finally {
      operation?.release();
    }
  }

  async #performResize(
    transaction: PendingBackendResize,
    operation: RendererOperation,
  ): Promise<void> {
    if (this.#renderer !== operation.renderer) {
      throw new Error("Three backend renderer changed during an admitted resize transaction.");
    }
    if (!transaction.pipelineComplete) {
      const pipeline = this.#pipeline;
      if (pipeline) {
        await this.#invokePipelineCallback(() => pipeline.resize(transaction.viewport));
      }
      transaction.pipelineComplete = true;
    }
    if (!transaction.rendererComplete) {
      this.#assertNoRuntimeFailure("complete resize");
      this.#applyViewport(transaction.viewport);
      this.#viewport = transaction.viewport;
      transaction.rendererComplete = true;
    }
  }

  async precompile(passes: readonly RenderPass[]): Promise<void> {
    if (this.#externalPipelineCallbackDepth !== 0) {
      throw new Error("Cannot precompile Three backend reentrantly from a pipeline callback.");
    }
    if (this.#telemetrySamplingActive) {
      throw telemetryMutationError("precompile Three backend");
    }
    this.#assertNoPendingDisposal("precompile");
    this.#assertReady("precompile");
    this.#assertNoRuntimeFailure("precompile");
    this.#assertNoPendingResize("precompile");
    const operation = this.#beginRendererOperation("precompile");
    try {
      const capturedPasses = this.#capturePasses(passes, "capture precompile passes");
      this.#assertNoRuntimeFailure("capture precompile passes");
      this.#precompileCalls += 1;
      this.#passes = capturedPasses;
      if (this.#viewport) this.#applyViewport(this.#viewport);
      if (this.#pipeline) {
        await this.#invokePipelineCallback(() => this.#pipeline!.precompile(capturedPasses));
        this.#assertNoRuntimeFailure("continue precompile");
      } else {
        for (const pass of capturedPasses) {
          this.#assertNoRuntimeFailure("continue precompile");
          if (pass.scene != null && pass.camera != null) {
            await operation.renderer.compileAsync(pass.scene, pass.camera);
          }
          this.#assertNoRuntimeFailure("continue precompile");
        }
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
    if (this.#externalPipelineCallbackDepth !== 0) {
      throw new Error("Cannot render Three backend reentrantly from a pipeline callback.");
    }
    if (this.#telemetrySamplingActive) {
      throw telemetryMutationError("render Three backend");
    }
    this.#assertNoPendingDisposal("render");
    this.#assertReady("render");
    this.#assertNoRuntimeFailure("render");
    this.#assertNoPendingResize("render");
    const operation = this.#beginRendererOperation("render");
    try {
      const capturedPasses = this.#capturePasses(passes, "capture render passes");
      this.#assertNoRuntimeFailure("capture render passes");
      this.#renderCalls += 1;
      this.#passes = capturedPasses;
      if (this.#viewport) this.#applyPassCameras(this.#viewport);
      if (this.#pipeline) {
        await this.#invokePipelineCallback(() => this.#pipeline!.submit(capturedPasses));
        this.#assertNoRuntimeFailure("continue render");
      } else {
        for (const pass of capturedPasses) {
          this.#assertNoRuntimeFailure("continue render");
          if (pass.scene != null && pass.camera != null) {
            await operation.renderer.render(pass.scene, pass.camera);
          }
          this.#assertNoRuntimeFailure("continue render");
        }
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

  snapshotFrameTelemetry(): Readonly<RenderBackendFrameTelemetry> {
    const renderer = this.#renderer;
    const viewport = this.#viewport;
    if (
      renderer === null
      || viewport === null
      || this.#state === "disposed"
      || this.#state === "failed"
      || this.#telemetrySamplingActive
    ) {
      return unavailableFrameTelemetry;
    }
    this.#telemetrySamplingActive = true;
    try {
      return captureRendererFrameTelemetry(renderer, viewport);
    } catch {
      return unavailableFrameTelemetry;
    } finally {
      this.#telemetrySamplingActive = false;
    }
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
    if (this.#externalPipelineCallbackDepth !== 0) {
      return Promise.reject(new Error(
        "Cannot dispose Three backend reentrantly from a pipeline callback.",
      ));
    }
    this.#disposeCalls += 1;
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    if (this.#state === "failed" && this.#renderer === null && this.#pipeline === null) {
      // Initialization already reported any cleanup failure together with its
      // primary error. Disposal acknowledges that completed cleanup attempt so
      // a composing owner does not count the same failure a second time.
      this.#disposePromise = Promise.resolve();
      return this.#disposePromise;
    }
    const deferred = deferredVoid();
    const attempt = deferred.promise;
    this.#disposePromise = attempt;
    const beginDisposal = () => {
      void this.#performDispose().then(
        deferred.resolve,
        (error: unknown) => {
          // Concurrent callers share one attempt. A pipeline retained after a
          // rejection remains a real cleanup obligation, so only that failed
          // attempt latch is cleared before its rejection reaches callers.
          if (this.#pipeline !== null && this.#disposePromise === attempt) {
            this.#disposePromise = null;
          }
          deferred.reject(error);
        },
      );
    };
    if (this.#telemetrySamplingActive || this.#failureSnapshotCaptureActive) {
      // Disposal is the one mutating API whose stable promise must be handed
      // back immediately. Defer its state transition until the synchronous
      // observation/evidence transaction has returned to its caller.
      queueMicrotask(beginDisposal);
    } else {
      beginDisposal();
    }
    return attempt;
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
    this.#pendingResize = null;
    const renderer = this.#renderer;
    const cleanupErrors = createCleanupFailureCollector();
    const priorCleanupErrors = this.#activeCleanupErrors;
    this.#activeCleanupErrors = cleanupErrors;
    try {
      if (this.#nonRetryableCleanupFailurePresent) {
        this.#nonRetryableCleanupFailure = cleanupErrors.add(
          this.#nonRetryableCleanupFailure,
        );
      }
      this.#transferPendingBackendDisposeEvidence(cleanupErrors);
      if (renderer) {
        this.#captureResourcesBeforeRendererDispose(renderer, cleanupErrors);
      }
      const pipelineCleanupErrors = cleanupErrors.fork();
      if (this.#pipeline) await this.#disposePipeline(pipelineCleanupErrors);
      const pipelineFailureStart = cleanupErrors.length;
      cleanupErrors.appendSnapshots(pipelineCleanupErrors.snapshots());
      const pipelineFailureEnd = cleanupErrors.length;
      pipelineCleanupErrors.releaseRawReferences();
      if (renderer) {
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
      this.#rememberNonRetryableCleanupFailure(
        cleanupErrors,
        pipelineFailureStart,
        pipelineFailureEnd,
      );
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

  async #disposePipeline(cleanupErrors: CleanupFailureCollector): Promise<void> {
    const pipeline = this.#pipeline;
    if (!pipeline) return;
    try {
      await this.#invokePipelineCallback(() => pipeline.dispose());
      if (this.#pipeline === pipeline) this.#pipeline = null;
    } catch (error: unknown) {
      const nativePropagation = this.#activeCleanupErrors?.consumeNativeBackend(error) ?? false;
      if (!nativePropagation && !cleanupErrors.consumeNativeBackend(error)) {
        cleanupErrors.add(error);
      }
    }
  }

  #rememberNonRetryableCleanupFailure(
    errors: CleanupFailureCollector,
    pipelineFailureStart: number,
    pipelineFailureEnd: number,
  ): void {
    if (this.#nonRetryableCleanupFailurePresent) return;
    const snapshots = errors.snapshots();
    const evidence = Object.freeze([
      ...snapshots.slice(0, pipelineFailureStart),
      ...snapshots.slice(pipelineFailureEnd),
    ]);
    if (evidence.length === 0) return;
    this.#nonRetryableCleanupFailure = evidence.length === 1
      ? evidence[0]
      : errors.aggregate(
        evidence,
        "Three backend retained non-retryable cleanup failure evidence.",
      );
    this.#nonRetryableCleanupFailurePresent = true;
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
        intrinsicReflectApply(originalDispose, backend, []);
        this.#backendDisposeCompleted = true;
      } catch (error: unknown) {
        // Capture native failure evidence before renderer cleanup can swallow
        // it or a queued microtask can mutate its caller-owned graph.
        const cleanupErrors = this.#activeCleanupErrors;
        if (cleanupErrors) {
          throw cleanupErrors.addNativeBackend(error);
        } else {
          // Publish a provisional, reference-free obligation before inspecting
          // hostile Error/AggregateError properties. A message getter may call
          // dispose reentrantly, but that disposal must wait for the completed
          // immutable snapshot instead of observing "no failure".
          const occurrenceRemembered = rememberFailureOccurrence(
            this.#pendingBackendDisposeOccurrences,
            error,
          );
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
          if (!occurrenceRemembered && this.#state === "initializing") {
            const propagation = createNativeBackendFailurePropagation(
              this.#pendingBackendDisposeOccurrences,
            );
            throw propagation;
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

  #consumePendingBackendDisposePrimary(error: unknown): Readonly<{
    value: unknown;
    requiresRebudget: boolean;
  }> | null {
    if (!this.#pendingBackendDisposeEvidencePresent) {
      return null;
    }
    const match = consumeFailureOccurrence(this.#pendingBackendDisposeOccurrences, error);
    if (match === null) return null;
    const evidence = this.#pendingBackendDisposeEvidence;
    this.#pendingBackendDisposeEvidence = undefined;
    this.#pendingBackendDisposeEvidencePresent = false;
    clearFailureOccurrences(this.#pendingBackendDisposeOccurrences);
    return Object.freeze({
      value: match === "propagation" ? evidence : error,
      requiresRebudget: match === "propagation",
    });
  }

  #collapseCleanupErrors(errors: CleanupFailureCollector): unknown {
    if (errors.length === 0) return null;
    const snapshots = errors.snapshots();
    if (snapshots.length === 1) return snapshots[0];
    return errors.aggregate(
      snapshots,
      "Three backend cleanup failed in multiple operations.",
    );
  }

  #isFailedWithoutRenderer(): boolean {
    return this.#state === "failed" && this.#renderer === null && this.#pipeline === null;
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
        if (updateProjectionMatrix) intrinsicReflectApply(updateProjectionMatrix, camera, []);
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
      const present = intrinsicReflectApply(intrinsicHasOwnProperty, passes, [index]);
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
      const variant = pass.variant;
      this.#assertNoRuntimeFailure(operation);
      if (variant !== undefined && (typeof variant !== "string" || !variant.trim())) {
        throw new TypeError("A render pass variant must be a non-empty string when present.");
      }
      const scene = pass.scene;
      this.#assertNoRuntimeFailure(operation);
      const camera = pass.camera;
      this.#assertNoRuntimeFailure(operation);
      const payload = pass.payload;
      this.#assertNoRuntimeFailure(operation);
      const capturedPass = variant === undefined
        ? { name, kind, scene, camera }
        : { name, kind, variant, scene, camera };
      captured.push(Object.freeze(payload === undefined
        ? capturedPass
        : { ...capturedPass, payload }));
    }
    return Object.freeze(captured);
  }

  #beginRendererOperation(kind: "precompile" | "render" | "resize"): RendererOperation {
    const renderer = this.#renderer;
    if (!renderer) throw new Error("Cannot begin a renderer operation without a renderer.");
    if (kind === "resize" && this.#activeRendererOperations !== 0) {
      throw new Error("Cannot resize Three backend while another renderer operation is active.");
    }
    if (kind !== "resize" && this.#resizeOperationActive) {
      throw new Error(`Cannot ${kind} Three backend while a resize is active.`);
    }
    if (this.#activeRendererOperations === 0) {
      this.#activeRendererOperationsDrain = deferredVoid();
    }
    this.#activeRendererOperations += 1;
    if (kind === "resize") this.#resizeOperationActive = true;
    let released = false;
    return Object.freeze({
      renderer,
      release: () => {
        if (released) return;
        released = true;
        if (kind === "resize") this.#resizeOperationActive = false;
        this.#activeRendererOperations -= 1;
        if (this.#activeRendererOperations !== 0) return;
        const drain = this.#activeRendererOperationsDrain;
        this.#activeRendererOperationsDrain = null;
        drain?.resolve();
      },
    });
  }

  #invokePipelineCallback<T>(callback: () => T): T {
    this.#externalPipelineCallbackDepth += 1;
    try {
      return callback();
    } finally {
      this.#externalPipelineCallbackDepth -= 1;
    }
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

  #assertNoPendingResize(operation: string): void {
    if (this.#pendingResize !== null) {
      throw new Error(`Cannot ${operation} Three backend while a resize is pending.`);
    }
    if (this.#resizeCaptureActive || this.#resizeOperationActive) {
      throw new Error(`Cannot ${operation} Three backend while resize admission is active.`);
    }
  }
}
