import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionPhaseAudioPresentation } from "../../src/gfx/v2/integration/phase-audio-presentation";

class FakeAudioParam {
  value = 0;
  readonly ramps: number[] = [];
  cancelScheduledValues(): void {}
  linearRampToValueAtTime(value: number): void {
    this.value = value;
    this.ramps.push(value);
  }
}

class FakeGainNode {
  readonly gain = new FakeAudioParam();
  connect<T>(target: T): T { return target; }
}

class FakeFilterNode {
  type = "lowpass";
  readonly frequency = new FakeAudioParam();
  connect<T>(target: T): T { return target; }
}

class FakeOscillatorNode {
  type = "sine";
  readonly frequency = new FakeAudioParam();
  started = false;
  stopped = false;
  connect<T>(target: T): T { return target; }
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
}

class FakeAudioContext {
  static latest: FakeAudioContext | null = null;
  readonly currentTime = 2;
  readonly state = "running";
  readonly destination = Object.freeze({ kind: "destination" });
  readonly gains: FakeGainNode[] = [];
  readonly filters: FakeFilterNode[] = [];
  readonly oscillators: FakeOscillatorNode[] = [];
  closed = false;

  constructor() { FakeAudioContext.latest = this; }
  createGain(): FakeGainNode {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }
  createBiquadFilter(): FakeFilterNode {
    const node = new FakeFilterNode();
    this.filters.push(node);
    return node;
  }
  createOscillator(): FakeOscillatorNode {
    const node = new FakeOscillatorNode();
    this.oscillators.push(node);
    return node;
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> { this.closed = true; }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeAudioContext.latest = null;
});

describe("QX-R3-005 phase audio presentation", () => {
  it("continuously maps the phase audio layer to persistent graph targets", () => {
    const audio = new ProductionPhaseAudioPresentation({ muted: false, audioLayer: 0.1 });
    const life = audio.snapshot();

    audio.update(0.32);
    const earth = audio.snapshot();

    expect(life).toMatchObject({
      state: "new",
      audioLayer: 0.1,
    });
    expect(earth).toMatchObject({
      state: "new",
      audioLayer: 0.32,
    });
    expect(earth.bedGainTarget).toBeGreaterThan(life.bedGainTarget);
    expect(earth.shimmerGainTarget).toBeGreaterThan(life.shimmerGainTarget);
    expect(earth.filterFrequencyTarget).toBeGreaterThan(life.filterFrequencyTarget);
    expect(Object.isFrozen(earth)).toBe(true);
  });

  it("rejects non-finite or out-of-range presentation input before mutation", () => {
    const audio = new ProductionPhaseAudioPresentation({ audioLayer: 0.5 });
    expect(() => audio.update(Number.NaN)).toThrow(/finite/);
    expect(() => audio.update(1.01)).toThrow(/between 0 and 1/);
    expect(audio.snapshot()).toMatchObject({ state: "new", audioLayer: 0.5 });
  });

  it("ramps persistent Web Audio gains and filter without replacing the graph", async () => {
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    const audio = new ProductionPhaseAudioPresentation({ audioLayer: 0.2 });
    await audio.start();
    const context = FakeAudioContext.latest!;
    const nodes = {
      gains: context.gains.slice(),
      filters: context.filters.slice(),
      oscillators: context.oscillators.slice(),
    };

    audio.update(0.8);

    expect(audio.snapshot()).toMatchObject({ state: "started", audioLayer: 0.8 });
    expect(context.gains).toEqual(nodes.gains);
    expect(context.filters).toEqual(nodes.filters);
    expect(context.oscillators).toEqual(nodes.oscillators);
    expect(context.gains[1]?.gain.ramps.at(-1)).toBeCloseTo(0.079, 8);
    expect(context.gains[2]?.gain.ramps.at(-1)).toBeCloseTo(0.0336, 8);
    expect(context.filters[0]?.frequency.ramps.at(-1)).toBeCloseTo(3_120, 8);
    expect(context.oscillators.every((oscillator) => oscillator.started)).toBe(true);
    audio.dispose();
    expect(context.oscillators.every((oscillator) => oscillator.stopped)).toBe(true);
    expect(audio.snapshot().state).toBe("disposed");
  });
});
