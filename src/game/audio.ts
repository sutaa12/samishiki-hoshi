import type { JourneyPhase } from "./model";

export interface AudioOptions {
  muted?: boolean;
  reducedMotion?: boolean;
}

const PHASE_FREQUENCY: Record<JourneyPhase, number> = {
  LIFE: 174,
  EARTH: 220,
  ASCENT: 294,
  SOLITUDE: 116,
  ANSWER: 246,
  TWINKLE: 330,
};

/** A no-asset Web Audio score. Calling start is intentionally user-gesture gated. */
export class JourneyAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private bed: OscillatorNode | null = null;
  private shimmer: OscillatorNode | null = null;
  private muted: boolean;
  private disposed = false;
  private phase: JourneyPhase = "LIFE";

  public constructor(options: AudioOptions = {}) {
    this.muted = Boolean(options.muted);
  }

  public get started(): boolean {
    return this.context !== null;
  }

  public async start(): Promise<void> {
    if (this.disposed) return;
    if (!this.context) this.createGraph();
    if (this.context?.state === "suspended") await this.context.resume();
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.context || !this.master) return;
    this.master.gain.cancelScheduledValues(this.context.currentTime);
    this.master.gain.linearRampToValueAtTime(muted ? 0 : 0.14, this.context.currentTime + 0.08);
  }

  public update(phase: JourneyPhase, storyTime?: number): void {
    void storyTime;
    this.phase = phase;
    if (!this.context || !this.bed || !this.shimmer) return;
    const now = this.context.currentTime;
    const frequency = PHASE_FREQUENCY[phase];
    this.bed.frequency.exponentialRampToValueAtTime(frequency, now + 0.8);
    this.shimmer.frequency.exponentialRampToValueAtTime(frequency * (phase === "SOLITUDE" ? 1.498 : 2.01), now + 0.9);
  }

  public emitPulse(phase: JourneyPhase = this.phase): void {
    if (!this.context || this.muted || this.disposed) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = phase === "SOLITUDE" ? "sine" : "triangle";
    oscillator.frequency.setValueAtTime(PHASE_FREQUENCY[phase] * 2, now);
    oscillator.frequency.exponentialRampToValueAtTime(PHASE_FREQUENCY[phase] * 3.2, now + 0.32);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    oscillator.connect(gain).connect(this.master!);
    oscillator.start(now);
    oscillator.stop(now + 0.62);
  }

  public answer(): void {
    if (!this.context || this.muted || this.disposed) return;
    const now = this.context.currentTime;
    [1, 1.25, 1.5].forEach((ratio, index) => {
      const oscillator = this.context!.createOscillator();
      const gain = this.context!.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(246 * ratio, now + index * 0.06);
      gain.gain.setValueAtTime(0.0001, now + index * 0.06);
      gain.gain.exponentialRampToValueAtTime(0.095, now + 0.16 + index * 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.65 + index * 0.06);
      oscillator.connect(gain).connect(this.master!);
      oscillator.start(now + index * 0.06);
      oscillator.stop(now + 1.75 + index * 0.06);
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bed?.stop();
    this.shimmer?.stop();
    this.context?.close().catch(() => undefined);
    this.context = null;
    this.master = null;
    this.bed = null;
    this.shimmer = null;
  }

  private createGraph(): void {
    const AudioContextConstructor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    const master = context.createGain();
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1800;
    master.gain.value = this.muted ? 0 : 0.14;
    master.connect(filter).connect(context.destination);
    const bed = context.createOscillator();
    bed.type = "sine";
    bed.frequency.value = PHASE_FREQUENCY.LIFE;
    const bedGain = context.createGain();
    bedGain.gain.value = 0.26;
    bed.connect(bedGain).connect(master);
    const shimmer = context.createOscillator();
    shimmer.type = "triangle";
    shimmer.frequency.value = PHASE_FREQUENCY.LIFE * 2.01;
    const shimmerGain = context.createGain();
    shimmerGain.gain.value = 0.045;
    shimmer.connect(shimmerGain).connect(master);
    bed.start();
    shimmer.start();
    this.context = context;
    this.master = master;
    this.bed = bed;
    this.shimmer = shimmer;
  }
}

export function createJourneyAudio(options: AudioOptions = {}): JourneyAudio {
  return new JourneyAudio(options);
}
