import type {
  FeatureInitContext,
  JourneyRenderSnapshot,
  RenderFeature,
  RenderHistoryInvalidation,
  RenderPass,
  RenderPassRecorder,
  RenderQualityProfile,
  RenderViewport,
  VisualClock,
} from "../contracts";
import { STORY_CHUNK_IDS, type StoryChunkId } from "../../../world/v2/contracts";
import type { ChunkManagerLike } from "./contracts";

function capturePersistentPass(input: Readonly<RenderPass>): Readonly<RenderPass> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("World-chunk persistent pass must be an object.");
  }
  let keys: readonly (string | symbol)[];
  let prototype: object | null;
  try {
    keys = Reflect.ownKeys(input);
    prototype = Reflect.getPrototypeOf(input);
  } catch {
    throw new TypeError("World-chunk persistent pass shape could not be inspected.");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("World-chunk persistent pass must use a plain or null prototype.");
  }
  const allowed = new Set(["name", "kind", "variant", "scene", "camera", "payload"]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError("World-chunk persistent pass has an unexpected property.");
  }
  const values = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") continue;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    } catch {
      throw new TypeError(`World-chunk persistent pass ${key} could not be inspected.`);
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`World-chunk persistent pass ${key} must be an enumerable data property.`);
    }
    values.set(key, descriptor.value);
  }
  const name = values.get("name");
  const kind = values.get("kind");
  const variant = values.get("variant");
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("World-chunk persistent pass requires a name.");
  }
  if (typeof kind !== "string" || !kind.trim()) {
    throw new TypeError("World-chunk persistent pass requires a kind.");
  }
  if (values.has("variant") && variant !== undefined && (typeof variant !== "string" || !variant.trim())) {
    throw new TypeError("World-chunk persistent pass variant is invalid.");
  }
  if (values.has("payload") && values.get("payload") !== undefined) {
    throw new TypeError("World-chunk persistent pass cannot carry mutable per-frame payload.");
  }
  return Object.freeze({
    name,
    kind,
    ...(variant === undefined ? {} : { variant: variant as string }),
    ...(values.get("scene") === undefined ? {} : { scene: values.get("scene") }),
    ...(values.get("camera") === undefined ? {} : { camera: values.get("camera") }),
  });
}

function deferredVoid(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class WorldChunkRenderFeature implements RenderFeature {
  readonly id = "world-chunks";
  readonly #manager: ChunkManagerLike;
  readonly #persistentPass: Readonly<RenderPass>;
  #initialized = false;
  #disposed = false;
  #initializePromise: Promise<void> | null = null;
  #disposePromise: Promise<void> | null = null;

  constructor(manager: ChunkManagerLike, persistentPass: Readonly<RenderPass>) {
    this.#manager = manager;
    this.#persistentPass = capturePersistentPass(persistentPass);
  }

  initialize(context: FeatureInitContext): Promise<void> {
    void context;
    if (this.#initializePromise) return this.#initializePromise;
    if (this.#disposed) {
      this.#initializePromise = Promise.reject(new Error("Cannot initialize a disposed world-chunk feature."));
      return this.#initializePromise;
    }
    const deferred = deferredVoid();
    this.#initializePromise = deferred.promise;
    void this.#runInitialize().then(deferred.resolve, deferred.reject);
    return this.#initializePromise;
  }

  warmupPasses(profiles: readonly Readonly<RenderQualityProfile>[]): readonly RenderPass[] {
    void profiles;
    return Object.freeze([this.#persistentPass]);
  }

  update(frame: Readonly<JourneyRenderSnapshot>, clock: VisualClock): void {
    if (!this.#initialized || this.#disposed) return;
    if (!(STORY_CHUNK_IDS as readonly string[]).includes(frame.shotId)) {
      throw new RangeError(`Journey snapshot has an unknown chunk id: ${frame.shotId}.`);
    }
    this.#manager.setFocus(frame.shotId as StoryChunkId);
    this.#manager.update(clock);
  }

  render(recorder: RenderPassRecorder): void {
    if (!this.#initialized || this.#disposed) return;
    recorder.record(this.#persistentPass);
  }

  quality(profile: Readonly<RenderQualityProfile>): void {
    if (this.#disposed) return;
    this.#manager.quality(profile);
  }

  resize(viewport: Readonly<RenderViewport>): void {
    void viewport;
    // Chunk generation is world-space and viewport independent.
  }

  invalidateHistory(event: Readonly<RenderHistoryInvalidation>): void {
    void event;
    // Temporal ownership belongs to GFX-005. Chunk state is intentionally unchanged.
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    const deferred = deferredVoid();
    this.#disposePromise = deferred.promise;
    void this.#runDispose().then(deferred.resolve, deferred.reject);
    return this.#disposePromise;
  }

  async #runInitialize(): Promise<void> {
    await this.#manager.initialize();
    if (this.#disposed) {
      throw new Error("World-chunk feature was disposed during initialization.");
    }
    this.#initialized = true;
  }

  async #runDispose(): Promise<void> {
    await this.#manager.dispose();
    if (this.#initializePromise) await Promise.allSettled([this.#initializePromise]);
    this.#initialized = false;
  }
}
