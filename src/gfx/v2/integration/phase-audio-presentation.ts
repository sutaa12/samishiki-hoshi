export interface PhaseAudioPresentationSnapshot {
  readonly state: "new" | "started" | "disposed";
  readonly muted: boolean;
  readonly audioLayer: number;
  readonly bedGainTarget: number;
  readonly shimmerGainTarget: number;
  readonly filterFrequencyTarget: number;
}

export const PHASE_AUDIO_CONSTRUCTION_STAGES = Object.freeze([
  "context",
  "master-gain",
  "filter",
  "master-connect-filter",
  "filter-connect-destination",
  "bed-oscillator",
  "bed-gain",
  "bed-connect-gain",
  "bed-gain-connect-master",
  "shimmer-oscillator",
  "shimmer-gain",
  "shimmer-connect-gain",
  "shimmer-gain-connect-master",
  "bed-start",
  "shimmer-start",
  "publish",
] as const);

export type PhaseAudioConstructionStage = (typeof PHASE_AUDIO_CONSTRUCTION_STAGES)[number];

export interface PhaseAudioPresentationOptions {
  readonly muted?: boolean;
  readonly audioLayer?: number;
  /** @internal Deterministic construction fault seam used by lifecycle tests. */
  readonly constructionCheckpoint?: (stage: PhaseAudioConstructionStage) => void;
}

function captureAudioLayer(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("The phase audio layer must be finite and between 0 and 1.");
  }
  return value;
}

function targetsAt(audioLayer: number) {
  return Object.freeze({
    bedGain: 0.035 + audioLayer * 0.055,
    shimmerGain: 0.008 + audioLayer * 0.032,
    filterFrequency: 1_200 + audioLayer * 2_400,
  });
}

type LocalGraphOwnership = {
  context: AudioContext | null;
  master: GainNode | null;
  filter: BiquadFilterNode | null;
  bed: OscillatorNode | null;
  bedGain: GainNode | null;
  shimmer: OscillatorNode | null;
  shimmerGain: GainNode | null;
  bedStartAttempted: boolean;
  shimmerStartAttempted: boolean;
};

async function cleanupOwnedGraph(ownership: Readonly<LocalGraphOwnership>): Promise<unknown[]> {
  const failures: unknown[] = [];
  if (ownership.shimmer && ownership.shimmerStartAttempted) {
    try {
      ownership.shimmer.stop();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (ownership.bed && ownership.bedStartAttempted) {
    try {
      ownership.bed.stop();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  const nodes: Array<AudioNode | null> = [
    ownership.shimmerGain,
    ownership.shimmer,
    ownership.bedGain,
    ownership.bed,
    ownership.filter,
    ownership.master,
  ];
  for (const node of nodes) {
    if (!node) continue;
    try {
      node.disconnect();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (ownership.context) {
    try {
      await ownership.context.close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  return failures;
}

function constructionFailure(original: unknown, cleanupFailures: readonly unknown[]): unknown {
  if (cleanupFailures.length === 0) return original;
  return new AggregateError(
    [original, ...cleanupFailures],
    "Phase audio graph construction failed and cleanup was incomplete.",
  );
}

/**
 * Supplemental production-only Web Audio layer for PhaseDirector presentation.
 * It is deliberately isolated from simulation state and the byte-frozen core score.
 */
export class ProductionPhaseAudioPresentation {
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #bed: OscillatorNode | null = null;
  #shimmer: OscillatorNode | null = null;
  #bedGain: GainNode | null = null;
  #shimmerGain: GainNode | null = null;
  #filter: BiquadFilterNode | null = null;
  #muted: boolean;
  #audioLayer: number;
  #disposed = false;
  readonly #constructionCheckpoint: ((stage: PhaseAudioConstructionStage) => void) | null;
  #startOperation: Promise<void> | null = null;
  #disposeOperation: Promise<void> | null = null;

  constructor(options: Readonly<PhaseAudioPresentationOptions> = {}) {
    this.#muted = Boolean(options.muted);
    this.#audioLayer = captureAudioLayer(options.audioLayer ?? 0.1);
    this.#constructionCheckpoint = options.constructionCheckpoint ?? null;
  }

  get started(): boolean {
    return this.#context !== null;
  }

  start(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#startOperation) return this.#startOperation;
    const operation = this.#performStart();
    this.#startOperation = operation;
    operation.then(
      () => { if (this.#startOperation === operation) this.#startOperation = null; },
      () => { if (this.#startOperation === operation) this.#startOperation = null; },
    );
    return operation;
  }

  setMuted(muted: boolean): void {
    this.#muted = Boolean(muted);
    if (!this.#context || !this.#master) return;
    const now = this.#context.currentTime;
    this.#master.gain.cancelScheduledValues(now);
    this.#master.gain.linearRampToValueAtTime(this.#muted ? 0 : 0.035, now + 0.08);
  }

  update(audioLayer: number): number {
    const next = captureAudioLayer(audioLayer);
    if (next === this.#audioLayer) return next;
    this.#audioLayer = next;
    if (!this.#context || !this.#bedGain || !this.#shimmerGain || !this.#filter) return next;
    const now = this.#context.currentTime;
    const targets = targetsAt(next);
    this.#bedGain.gain.cancelScheduledValues(now);
    this.#bedGain.gain.linearRampToValueAtTime(targets.bedGain, now + 0.12);
    this.#shimmerGain.gain.cancelScheduledValues(now);
    this.#shimmerGain.gain.linearRampToValueAtTime(targets.shimmerGain, now + 0.12);
    this.#filter.frequency.cancelScheduledValues(now);
    this.#filter.frequency.linearRampToValueAtTime(targets.filterFrequency, now + 0.12);
    return next;
  }

  snapshot(): Readonly<PhaseAudioPresentationSnapshot> {
    const targets = targetsAt(this.#audioLayer);
    return Object.freeze({
      state: this.#disposed ? "disposed" : this.started ? "started" : "new",
      muted: this.#muted,
      audioLayer: this.#audioLayer,
      bedGainTarget: targets.bedGain,
      shimmerGainTarget: targets.shimmerGain,
      filterFrequencyTarget: targets.filterFrequency,
    });
  }

  dispose(): Promise<void> {
    if (this.#disposeOperation) return this.#disposeOperation;
    this.#disposed = true;
    const ownership: LocalGraphOwnership = {
      context: this.#context,
      master: this.#master,
      filter: this.#filter,
      bed: this.#bed,
      bedGain: this.#bedGain,
      shimmer: this.#shimmer,
      shimmerGain: this.#shimmerGain,
      bedStartAttempted: this.#bed !== null,
      shimmerStartAttempted: this.#shimmer !== null,
    };
    this.#context = null;
    this.#master = null;
    this.#bed = null;
    this.#shimmer = null;
    this.#bedGain = null;
    this.#shimmerGain = null;
    this.#filter = null;
    const operation = cleanupOwnedGraph(ownership).then((failures) => {
      if (failures.length > 0) {
        throw new AggregateError(failures, "Phase audio presentation disposal failed.");
      }
    });
    this.#disposeOperation = operation;
    return operation;
  }

  async #performStart(): Promise<void> {
    if (!this.#context) await this.#createGraph();
    if (!this.#disposed && this.#context?.state === "suspended") await this.#context.resume();
  }

  #checkpoint(stage: PhaseAudioConstructionStage): void {
    this.#constructionCheckpoint?.(stage);
    if (this.#disposed) {
      throw new Error("Phase audio graph construction was interrupted by disposal.");
    }
  }

  async #createGraph(): Promise<void> {
    const AudioContextConstructor = window.AudioContext
      ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;
    const ownership: LocalGraphOwnership = {
      context: null,
      master: null,
      filter: null,
      bed: null,
      bedGain: null,
      shimmer: null,
      shimmerGain: null,
      bedStartAttempted: false,
      shimmerStartAttempted: false,
    };
    try {
      const context = new AudioContextConstructor();
      ownership.context = context;
      this.#checkpoint("context");
      const master = context.createGain();
      ownership.master = master;
      this.#checkpoint("master-gain");
      const filter = context.createBiquadFilter();
      ownership.filter = filter;
      this.#checkpoint("filter");
      const targets = targetsAt(this.#audioLayer);
      master.gain.value = this.#muted ? 0 : 0.035;
      filter.type = "lowpass";
      filter.frequency.value = targets.filterFrequency;
      master.connect(filter);
      this.#checkpoint("master-connect-filter");
      filter.connect(context.destination);
      this.#checkpoint("filter-connect-destination");

      const bed = context.createOscillator();
      ownership.bed = bed;
      this.#checkpoint("bed-oscillator");
      const bedGain = context.createGain();
      ownership.bedGain = bedGain;
      this.#checkpoint("bed-gain");
      bed.type = "sine";
      bed.frequency.value = 87;
      bedGain.gain.value = targets.bedGain;
      bed.connect(bedGain);
      this.#checkpoint("bed-connect-gain");
      bedGain.connect(master);
      this.#checkpoint("bed-gain-connect-master");

      const shimmer = context.createOscillator();
      ownership.shimmer = shimmer;
      this.#checkpoint("shimmer-oscillator");
      const shimmerGain = context.createGain();
      ownership.shimmerGain = shimmerGain;
      this.#checkpoint("shimmer-gain");
      shimmer.type = "triangle";
      shimmer.frequency.value = 522;
      shimmerGain.gain.value = targets.shimmerGain;
      shimmer.connect(shimmerGain);
      this.#checkpoint("shimmer-connect-gain");
      shimmerGain.connect(master);
      this.#checkpoint("shimmer-gain-connect-master");

      ownership.bedStartAttempted = true;
      bed.start();
      this.#checkpoint("bed-start");
      ownership.shimmerStartAttempted = true;
      shimmer.start();
      this.#checkpoint("shimmer-start");
      this.#checkpoint("publish");
      this.#context = context;
      this.#master = master;
      this.#bed = bed;
      this.#shimmer = shimmer;
      this.#bedGain = bedGain;
      this.#shimmerGain = shimmerGain;
      this.#filter = filter;
    } catch (error: unknown) {
      const cleanupFailures = await cleanupOwnedGraph(ownership);
      throw constructionFailure(error, cleanupFailures);
    }
  }
}

export function createProductionPhaseAudioPresentation(
  options: Readonly<PhaseAudioPresentationOptions> = {},
): ProductionPhaseAudioPresentation {
  return new ProductionPhaseAudioPresentation(options);
}
