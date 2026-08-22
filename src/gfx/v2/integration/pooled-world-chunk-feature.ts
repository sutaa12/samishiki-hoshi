import type {
  FeatureInitContext,
  JourneyRenderSnapshot,
  RenderFeature,
  RenderHistoryInvalidation,
  RenderPass,
  RenderPassRecorder,
  RenderOperationClock,
  RenderQualityProfile,
  RenderViewport,
} from "../contracts";
import { WorldChunkRenderFeature } from "../chunks";
import { ProductionThreeChunkUploader } from "./three-chunk-uploader";

function cleanupAggregate(failures: readonly unknown[]): AggregateError {
  const aggregate = new AggregateError([...failures], "Pooled world-chunk feature disposal failed.");
  Object.freeze(aggregate.errors);
  return Object.freeze(aggregate);
}

/**
 * Host-owned wrapper that builds the fixed GPU pool after materials are ready,
 * keeps it visible through precompile, and disposes chunk leases before the
 * shared geometry pool.
 */
export class PooledWorldChunkFeature implements RenderFeature {
  readonly id = "world-chunks-pooled";
  readonly #inner: WorldChunkRenderFeature;
  readonly #uploader: ProductionThreeChunkUploader;
  #disposed = false;
  #initializePromise: Promise<void> | null = null;
  #disposePromise: Promise<void> | null = null;

  constructor(
    inner: WorldChunkRenderFeature,
    uploader: ProductionThreeChunkUploader,
  ) {
    this.#inner = inner;
    this.#uploader = uploader;
  }

  initialize(context: FeatureInitContext): Promise<void> {
    if (this.#initializePromise) return this.#initializePromise;
    if (this.#disposed) {
      this.#initializePromise = Promise.reject(new Error("Cannot initialize a disposed pooled world feature."));
      return this.#initializePromise;
    }
    this.#initializePromise = Promise.resolve().then(async () => {
      this.#uploader.initializePool();
      await this.#inner.initialize(context);
    });
    return this.#initializePromise;
  }

  warmupPasses(profiles: readonly Readonly<RenderQualityProfile>[]): readonly RenderPass[] {
    return this.#inner.warmupPasses(profiles);
  }

  update(frame: Readonly<JourneyRenderSnapshot>, clock: RenderOperationClock): void {
    if (this.#disposed) return;
    this.#uploader.beginRuntime();
    this.#inner.update(frame, clock);
  }

  render(recorder: RenderPassRecorder): void {
    if (!this.#disposed) this.#inner.render(recorder);
  }

  quality(profile: Readonly<RenderQualityProfile>): void {
    if (this.#disposed) return;
    this.#uploader.quality(profile);
    this.#inner.quality(profile);
  }

  resize(viewport: Readonly<RenderViewport>): void {
    if (!this.#disposed) this.#inner.resize(viewport);
  }

  invalidateHistory(event: Readonly<RenderHistoryInvalidation>): void {
    if (!this.#disposed) this.#inner.invalidateHistory(event);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      try {
        await this.#inner.dispose();
      } catch (error: unknown) {
        failures.push(error);
      }
      try {
        await this.#uploader.dispose();
      } catch (error: unknown) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw cleanupAggregate(failures);
    });
    return this.#disposePromise;
  }
}
