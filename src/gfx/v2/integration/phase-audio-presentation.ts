export interface PhaseAudioPresentationSnapshot {
  readonly state: "new" | "started" | "disposed";
  readonly muted: boolean;
  readonly audioLayer: number;
  readonly bedGainTarget: number;
  readonly shimmerGainTarget: number;
  readonly filterFrequencyTarget: number;
}

export interface PhaseAudioPresentationOptions {
  readonly muted?: boolean;
  readonly audioLayer?: number;
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

  constructor(options: Readonly<PhaseAudioPresentationOptions> = {}) {
    this.#muted = Boolean(options.muted);
    this.#audioLayer = captureAudioLayer(options.audioLayer ?? 0.1);
  }

  get started(): boolean {
    return this.#context !== null;
  }

  async start(): Promise<void> {
    if (this.#disposed) return;
    if (!this.#context) this.#createGraph();
    if (this.#context?.state === "suspended") await this.#context.resume();
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

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#bed?.stop();
    this.#shimmer?.stop();
    this.#context?.close().catch(() => undefined);
    this.#context = null;
    this.#master = null;
    this.#bed = null;
    this.#shimmer = null;
    this.#bedGain = null;
    this.#shimmerGain = null;
    this.#filter = null;
  }

  #createGraph(): void {
    const AudioContextConstructor = window.AudioContext
      ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    const master = context.createGain();
    const filter = context.createBiquadFilter();
    const targets = targetsAt(this.#audioLayer);
    master.gain.value = this.#muted ? 0 : 0.035;
    filter.type = "lowpass";
    filter.frequency.value = targets.filterFrequency;
    master.connect(filter).connect(context.destination);

    const bed = context.createOscillator();
    const bedGain = context.createGain();
    bed.type = "sine";
    bed.frequency.value = 87;
    bedGain.gain.value = targets.bedGain;
    bed.connect(bedGain).connect(master);

    const shimmer = context.createOscillator();
    const shimmerGain = context.createGain();
    shimmer.type = "triangle";
    shimmer.frequency.value = 522;
    shimmerGain.gain.value = targets.shimmerGain;
    shimmer.connect(shimmerGain).connect(master);

    bed.start();
    shimmer.start();
    this.#context = context;
    this.#master = master;
    this.#bed = bed;
    this.#shimmer = shimmer;
    this.#bedGain = bedGain;
    this.#shimmerGain = shimmerGain;
    this.#filter = filter;
  }
}

export function createProductionPhaseAudioPresentation(
  options: Readonly<PhaseAudioPresentationOptions> = {},
): ProductionPhaseAudioPresentation {
  return new ProductionPhaseAudioPresentation(options);
}
