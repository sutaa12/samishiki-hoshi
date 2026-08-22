import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PHASE_AUDIO_CONSTRUCTION_STAGES,
  ProductionPhaseAudioPresentation,
} from "../../src/gfx/v2/integration/phase-audio-presentation";

type AudioFailurePlan = {
  readonly bedStart?: unknown;
  readonly bedStop?: unknown;
  readonly shimmerStart?: unknown;
  readonly shimmerStop?: unknown;
  readonly masterDisconnect?: unknown;
  readonly filterDisconnect?: unknown;
  readonly bedDisconnect?: unknown;
  readonly bedGainDisconnect?: unknown;
  readonly shimmerDisconnect?: unknown;
  readonly shimmerGainDisconnect?: unknown;
  readonly close?: unknown;
};

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
  disconnectCalls = 0;
  constructor(
    readonly label: string,
    readonly cleanupLog: string[],
    readonly disconnectFailure?: unknown,
  ) {}
  connect<T>(target: T): T { return target; }
  disconnect(): void {
    this.disconnectCalls += 1;
    this.cleanupLog.push(`disconnect:${this.label}`);
    if (this.disconnectFailure !== undefined) throw this.disconnectFailure;
  }
}

class FakeFilterNode {
  type = "lowpass";
  readonly frequency = new FakeAudioParam();
  disconnectCalls = 0;
  constructor(
    readonly cleanupLog: string[],
    readonly disconnectFailure?: unknown,
  ) {}
  connect<T>(target: T): T { return target; }
  disconnect(): void {
    this.disconnectCalls += 1;
    this.cleanupLog.push("disconnect:filter");
    if (this.disconnectFailure !== undefined) throw this.disconnectFailure;
  }
}

class FakeOscillatorNode {
  type = "sine";
  readonly frequency = new FakeAudioParam();
  started = false;
  stopped = false;
  startCalls = 0;
  stopCalls = 0;
  disconnectCalls = 0;
  constructor(
    readonly label: "bed" | "shimmer",
    readonly cleanupLog: string[],
    readonly startFailure?: unknown,
    public stopFailure?: unknown,
    readonly disconnectFailure?: unknown,
  ) {}
  connect<T>(target: T): T { return target; }
  start(): void {
    this.startCalls += 1;
    this.started = true;
    if (this.startFailure !== undefined) throw this.startFailure;
  }
  stop(): void {
    this.stopCalls += 1;
    this.stopped = true;
    this.cleanupLog.push(`stop:${this.label}`);
    if (this.stopFailure !== undefined) throw this.stopFailure;
  }
  disconnect(): void {
    this.disconnectCalls += 1;
    this.cleanupLog.push(`disconnect:${this.label}`);
    if (this.disconnectFailure !== undefined) throw this.disconnectFailure;
  }
}

class FakeAudioContext {
  static latest: FakeAudioContext | null = null;
  static nextFailurePlan: AudioFailurePlan = {};
  readonly currentTime = 2;
  readonly state = "running";
  readonly destination = Object.freeze({ kind: "destination" });
  readonly gains: FakeGainNode[] = [];
  readonly filters: FakeFilterNode[] = [];
  readonly oscillators: FakeOscillatorNode[] = [];
  readonly cleanupLog: string[] = [];
  closed = false;
  closeCalls = 0;
  readonly failurePlan: AudioFailurePlan;

  constructor() {
    this.failurePlan = FakeAudioContext.nextFailurePlan;
    FakeAudioContext.latest = this;
  }
  createGain(): FakeGainNode {
    const disconnectFailure = this.gains.length === 0
      ? this.failurePlan.masterDisconnect
      : this.gains.length === 1
        ? this.failurePlan.bedGainDisconnect
        : this.failurePlan.shimmerGainDisconnect;
    const label = this.gains.length === 0
      ? "master"
      : this.gains.length === 1 ? "bed-gain" : "shimmer-gain";
    const node = new FakeGainNode(label, this.cleanupLog, disconnectFailure);
    this.gains.push(node);
    return node;
  }
  createBiquadFilter(): FakeFilterNode {
    const node = new FakeFilterNode(this.cleanupLog, this.failurePlan.filterDisconnect);
    this.filters.push(node);
    return node;
  }
  createOscillator(): FakeOscillatorNode {
    const shimmer = this.oscillators.length === 1;
    const node = new FakeOscillatorNode(
      shimmer ? "shimmer" : "bed",
      this.cleanupLog,
      shimmer ? this.failurePlan.shimmerStart : this.failurePlan.bedStart,
      shimmer ? this.failurePlan.shimmerStop : this.failurePlan.bedStop,
      shimmer ? this.failurePlan.shimmerDisconnect : this.failurePlan.bedDisconnect,
    );
    this.oscillators.push(node);
    return node;
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.cleanupLog.push("close");
    if (this.failurePlan.close !== undefined) throw this.failurePlan.close;
    this.closed = true;
  }
}

function graphNodes(context: FakeAudioContext): Array<
  FakeGainNode | FakeFilterNode | FakeOscillatorNode
> {
  return [...context.gains, ...context.filters, ...context.oscillators];
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeAudioContext.latest = null;
  FakeAudioContext.nextFailurePlan = {};
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
    await audio.dispose();
    expect(context.oscillators.every((oscillator) => oscillator.stopped)).toBe(true);
    expect(graphNodes(context).every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(context.cleanupLog).toEqual([
      "stop:shimmer",
      "stop:bed",
      "disconnect:shimmer-gain",
      "disconnect:shimmer",
      "disconnect:bed-gain",
      "disconnect:bed",
      "disconnect:filter",
      "disconnect:master",
      "close",
    ]);
    expect(audio.snapshot().state).toBe("disposed");
  });

  it.each(PHASE_AUDIO_CONSTRUCTION_STAGES)(
    "rolls back local ownership when construction fails at %s",
    async (failedStage) => {
      vi.stubGlobal("window", { AudioContext: FakeAudioContext });
      const failure = new Error(`failure at ${failedStage}`);
      const audio = new ProductionPhaseAudioPresentation({
        constructionCheckpoint(stage) {
          if (stage === failedStage) throw failure;
        },
      });

      const rejection = await audio.start().then(
        () => null,
        (error: unknown) => error,
      );

      expect(rejection).toBe(failure);
      expect(audio.snapshot().state).toBe("new");
      const context = FakeAudioContext.latest;
      expect(context).not.toBeNull();
      expect(context!.closed).toBe(true);
      expect(context!.closeCalls).toBe(1);
      for (const oscillator of context!.oscillators) {
        expect(oscillator.stopCalls).toBe(oscillator.startCalls > 0 ? 1 : 0);
      }
      expect(graphNodes(context!).every((node) => node.disconnectCalls === 1)).toBe(true);
      if (failedStage === "publish") {
        expect(context!.cleanupLog).toEqual([
          "stop:shimmer",
          "stop:bed",
          "disconnect:shimmer-gain",
          "disconnect:shimmer",
          "disconnect:bed-gain",
          "disconnect:bed",
          "disconnect:filter",
          "disconnect:master",
          "close",
        ]);
      }
      const stopCalls = context?.oscillators.map((oscillator) => oscillator.stopCalls) ?? [];
      const disconnectCalls = context ? graphNodes(context).map((node) => node.disconnectCalls) : [];
      const closeCalls = context?.closeCalls ?? 0;
      const firstDispose = audio.dispose();
      const concurrentDispose = audio.dispose();
      expect(concurrentDispose).toBe(firstDispose);
      await firstDispose;
      expect(context?.oscillators.map((oscillator) => oscillator.stopCalls) ?? []).toEqual(stopCalls);
      expect(context ? graphNodes(context).map((node) => node.disconnectCalls) : [])
        .toEqual(disconnectCalls);
      expect(context?.closeCalls ?? 0).toBe(closeCalls);
      expect(audio.snapshot().state).toBe("disposed");
    },
  );

  it("stops both attempted oscillators when the second start mutates then throws", async () => {
    const startFailure = new Error("second oscillator start failed after mutation");
    FakeAudioContext.nextFailurePlan = { shimmerStart: startFailure };
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    const audio = new ProductionPhaseAudioPresentation();

    const rejection = await audio.start().then(
      () => null,
      (error: unknown) => error,
    );

    const context = FakeAudioContext.latest!;
    expect(rejection).toBe(startFailure);
    expect(context.oscillators).toHaveLength(2);
    expect(context.oscillators.map((oscillator) => oscillator.startCalls)).toEqual([1, 1]);
    expect(context.oscillators.map((oscillator) => oscillator.stopCalls)).toEqual([1, 1]);
    expect(graphNodes(context).every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(context.closed).toBe(true);
    expect(context.closeCalls).toBe(1);
    expect(audio.snapshot().state).toBe("new");
    const disposal = audio.dispose();
    expect(audio.dispose()).toBe(disposal);
    await disposal;
    expect(context.oscillators.map((oscillator) => oscillator.stopCalls)).toEqual([1, 1]);
    expect(context.closeCalls).toBe(1);
  });

  it("preserves original, stop, and close errors when rollback cleanup also fails", async () => {
    const original = new Error("second oscillator start failed");
    const shimmerStop = new Error("shimmer stop failed");
    const bedStop = new Error("bed stop failed");
    const shimmerGainDisconnect = new Error("shimmer gain disconnect failed");
    const bedDisconnect = new Error("bed disconnect failed");
    const close = new Error("context close failed");
    FakeAudioContext.nextFailurePlan = {
      shimmerStart: original,
      shimmerStop,
      bedStop,
      shimmerGainDisconnect,
      bedDisconnect,
      close,
    };
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    const audio = new ProductionPhaseAudioPresentation();

    const rejection = await audio.start().then(
      () => null,
      (error: unknown) => error,
    );

    const context = FakeAudioContext.latest!;
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([
      original,
      shimmerStop,
      bedStop,
      shimmerGainDisconnect,
      bedDisconnect,
      close,
    ]);
    expect(context.oscillators.map((oscillator) => oscillator.stopCalls)).toEqual([1, 1]);
    expect(graphNodes(context).every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(context.closeCalls).toBe(1);
    expect(audio.snapshot().state).toBe("new");
  });

  it("attempts every terminal cleanup once and memoizes a failed dispose", async () => {
    const shimmerStop = new Error("shimmer stop failed");
    const bedStop = new Error("bed stop failed");
    const shimmerGainDisconnect = new Error("shimmer gain disconnect failed");
    const masterDisconnect = new Error("master disconnect failed");
    const close = new Error("context close failed");
    FakeAudioContext.nextFailurePlan = {
      shimmerStop,
      bedStop,
      shimmerGainDisconnect,
      masterDisconnect,
      close,
    };
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    const audio = new ProductionPhaseAudioPresentation();
    await audio.start();
    const context = FakeAudioContext.latest!;

    const firstDispose = audio.dispose();
    const concurrentDispose = audio.dispose();
    const rejection = await firstDispose.then(
      () => null,
      (error: unknown) => error,
    );

    expect(concurrentDispose).toBe(firstDispose);
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([
      shimmerStop,
      bedStop,
      shimmerGainDisconnect,
      masterDisconnect,
      close,
    ]);
    expect(context.oscillators.map((oscillator) => oscillator.stopCalls)).toEqual([1, 1]);
    expect(graphNodes(context).every((node) => node.disconnectCalls === 1)).toBe(true);
    expect(context.closeCalls).toBe(1);
    expect(audio.dispose()).toBe(firstDispose);
    expect(audio.snapshot().state).toBe("disposed");
  });
});
