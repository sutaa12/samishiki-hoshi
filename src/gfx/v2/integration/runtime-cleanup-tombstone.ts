export interface StableDisposableRuntime {
  dispose(): Promise<unknown>;
}

/**
 * Retains the exact runtime being cleaned until its stable disposal promise
 * resolves. A failed cleanup therefore blocks replacement construction rather
 * than becoming an unreachable worker/renderer owner.
 */
export class RuntimeCleanupTombstone<Runtime extends StableDisposableRuntime> {
  #retained: Runtime | null = null;

  retained(): Runtime | null {
    return this.#retained;
  }

  async drain(): Promise<void> {
    const retained = this.#retained;
    if (!retained) return;
    await retained.dispose();
    if (this.#retained === retained) this.#retained = null;
  }

  async dispose(runtime: Runtime): Promise<void> {
    if (this.#retained && this.#retained !== runtime) await this.drain();
    this.#retained = runtime;
    await runtime.dispose();
    if (this.#retained === runtime) this.#retained = null;
  }
}
