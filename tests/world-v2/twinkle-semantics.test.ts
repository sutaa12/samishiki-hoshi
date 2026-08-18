import { describe, expect, it } from "vitest";
import { phaseAt, type TwinkleSeed } from "../../src/game/model";
import { hashJourney, simulateJourney } from "../../src/game/simulation";
import {
  createSeedStreamRegistry,
  createWorldGenerationContext,
  digestCanonicalValue,
  generateWorldPlan,
  projectTwinkleSemantics,
  type WorldPlan,
} from "../../src/world/v2";
import { assertDeepFrozen } from "./test-helpers";

const REPLAY = [
  { at: 5, moveX: 0.7, moveY: 0.1, pulse: true },
  { at: 39, moveX: -0.4, moveY: 0.8, pulse: true },
  { at: 166.4, moveX: 0, moveY: 0, pulse: true },
] as const;

function createPlan(seed: number) {
  return generateWorldPlan(createWorldGenerationContext({ worldSeed: seed }));
}

function pulse(id: number, journeyTime: number): TwinkleSeed {
  return Object.freeze({
    id,
    journeyTime,
    x: id / 10,
    y: -id / 20,
    phase: phaseAt(journeyTime),
    source: "player" as const,
    value: id * 101,
  });
}

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

function mutablePlan(seed = 20_260_818): Mutable<WorldPlan> {
  return structuredClone(createPlan(seed)) as Mutable<WorldPlan>;
}

describe("GFX-003 Twinkle semantic projection", () => {
  it("does not mutate the simulation or its immutable ledger", () => {
    const state = simulateJourney(REPLAY, { seed: 778 });
    const beforeHash = hashJourney(state);
    const beforeLedger = JSON.stringify(state.pulses);
    const semantics = projectTwinkleSemantics(createPlan(state.seed), state.pulses);

    expect(hashJourney(state)).toBe(beforeHash);
    expect(JSON.stringify(state.pulses)).toBe(beforeLedger);
    expect(Object.isFrozen(state.pulses)).toBe(true);
    expect(state.pulses.every(Object.isFrozen)).toBe(true);
    expect(semantics).not.toBe(state.pulses);
  });

  it("normalizes a real simulation signed-zero position only in the owned semantic copy", () => {
    const state = simulateJourney([
      { at: 0, moveX: 0, moveY: 0, pulse: true },
    ], { seed: 0 });
    const source = state.pulses[0];
    if (!source) throw new Error("Expected the seed-zero pulse at story time zero.");
    const beforeHash = hashJourney(state);

    expect(Object.is(source.x, -0)).toBe(true);
    expect(Object.isFrozen(state.pulses)).toBe(true);
    expect(Object.isFrozen(source)).toBe(true);

    const semantics = projectTwinkleSemantics(createPlan(state.seed), state.pulses);
    const semantic = semantics[0];
    if (!semantic) throw new Error("Expected one projected seed-zero semantic.");

    expect(hashJourney(state)).toBe(beforeHash);
    expect(state.pulses[0]).toBe(source);
    expect(Object.is(source.x, -0)).toBe(true);
    expect(semantic).not.toBe(source);
    expect(Object.is(semantic.x, 0)).toBe(true);
    expect(Object.is(semantic.x, -0)).toBe(false);
    expect(semantic.signature).toMatch(/^twinkle-semantic-v1:[0-9a-f]{16}$/);
    expect(projectTwinkleSemantics(createPlan(state.seed), state.pulses)[0]?.signature).toBe(
      semantic.signature,
    );
    assertDeepFrozen(semantics);

    const yState = simulateJourney([
      { at: 0, moveX: 0, moveY: 1 },
      { at: 1.128_397_376_332_195_7, moveX: 0, moveY: 1, pulse: true },
    ], { seed: 0 });
    const ySource = yState.pulses[0];
    if (!ySource) throw new Error("Expected a legal simulation pulse with signed-zero y.");
    const yHash = hashJourney(yState);
    expect(Object.is(ySource.y, -0)).toBe(true);

    const ySemantic = projectTwinkleSemantics(createPlan(yState.seed), yState.pulses)[0];
    if (!ySemantic) throw new Error("Expected a projected signed-zero y semantic.");
    expect(Object.is(ySemantic.y, 0)).toBe(true);
    expect(Object.is(ySemantic.y, -0)).toBe(false);
    expect(Object.is(ySource.y, -0)).toBe(true);
    expect(hashJourney(yState)).toBe(yHash);
  });

  it("gives positional signed zero canonical signatures without collapsing nonzero epsilon", () => {
    const plan = createPlan(778);
    const negativeZero = Object.freeze({ ...pulse(1, 5), x: -0, y: -0 });
    const positiveZero = Object.freeze({ ...pulse(1, 5), x: 0, y: 0 });
    const negativeEpsilon = Object.freeze({ ...pulse(1, 5), x: -Number.MIN_VALUE, y: 0 });

    const negativeSemantic = projectTwinkleSemantics(plan, [negativeZero])[0];
    const positiveSemantic = projectTwinkleSemantics(plan, [positiveZero])[0];
    const epsilonSemantic = projectTwinkleSemantics(plan, [negativeEpsilon])[0];
    if (!negativeSemantic || !positiveSemantic || !epsilonSemantic) {
      throw new Error("Expected signed-zero comparison semantics.");
    }

    expect(Object.is(negativeZero.x, -0)).toBe(true);
    expect(Object.is(negativeZero.y, -0)).toBe(true);
    expect(Object.is(negativeSemantic.x, 0)).toBe(true);
    expect(Object.is(negativeSemantic.y, 0)).toBe(true);
    expect(negativeSemantic.signature).toBe(positiveSemantic.signature);
    expect(epsilonSemantic.x).toBe(-Number.MIN_VALUE);
    expect(epsilonSemantic.signature).not.toBe(positiveSemantic.signature);
  });

  it("preserves input identity order without sorting or deduplicating", () => {
    const state = simulateJourney(REPLAY, { seed: 778 });
    const reordered = Object.freeze([
      state.pulses[2]!,
      state.pulses[0]!,
      state.pulses[1]!,
      state.pulses[0]!,
    ]);
    const semantics = projectTwinkleSemantics(createPlan(state.seed), reordered);

    expect(semantics.map((entry) => entry.id)).toEqual(reordered.map((entry) => entry.id));
    expect(semantics.map((entry) => entry.ledgerIndex)).toEqual([0, 1, 2, 3]);
    expect(semantics).toHaveLength(reordered.length);
  });

  it("never writes through a readonly ledger proxy", () => {
    const state = simulateJourney(REPLAY, { seed: 778 });
    let writes = 0;
    const protectedLedger = new Proxy(state.pulses, {
      set() {
        writes += 1;
        throw new Error("ledger mutation");
      },
      defineProperty() {
        writes += 1;
        throw new Error("ledger mutation");
      },
      deleteProperty() {
        writes += 1;
        throw new Error("ledger mutation");
      },
    });

    expect(() => projectTwinkleSemantics(createPlan(state.seed), protectedLedger)).not.toThrow();
    expect(writes).toBe(0);
  });

  it("maps exact timeline boundaries to canonical chunks without changing order", () => {
    const boundaryTimes = [0, 3, 36, 88, 130, 161, 171, 178, 180] as const;
    const ledger = Object.freeze(boundaryTimes.map((time, index) => pulse(index + 1, time)));
    const semantics = projectTwinkleSemantics(createPlan(20_260_818), ledger);

    expect(semantics.map((entry) => entry.chunkId)).toEqual([
      "S01",
      "S02",
      "S07",
      "S13",
      "S17",
      "S21",
      "S23",
      "S24",
      "S24",
    ]);
    expect(semantics.map((entry) => entry.id)).toEqual(ledger.map((entry) => entry.id));
  });

  it("resolves real rounded phase-boundary pulses to the immediately previous chunk only", () => {
    const cases = [
      { at: 35.999_5, journeyTime: 36, phase: "LIFE", chunkId: "S06" },
      { at: 87.999_5, journeyTime: 88, phase: "EARTH", chunkId: "S12" },
      { at: 129.999_5, journeyTime: 130, phase: "ASCENT", chunkId: "S16" },
      { at: 160.999_5, journeyTime: 161, phase: "SOLITUDE", chunkId: "S20" },
      { at: 170.999_5, journeyTime: 171, phase: "ANSWER", chunkId: "S22" },
    ] as const;

    for (const boundary of cases) {
      const state = simulateJourney([
        { at: boundary.at, moveX: 0, moveY: 0, pulse: true },
      ], { seed: 0 });
      const source = state.pulses[0];
      if (!source) throw new Error(`Expected a pulse near ${boundary.journeyTime}s.`);
      const beforeHash = hashJourney(state);

      expect(source.journeyTime).toBe(boundary.journeyTime);
      expect(source.phase).toBe(boundary.phase);
      expect(Object.isFrozen(state.pulses)).toBe(true);
      expect(Object.isFrozen(source)).toBe(true);

      const semantics = projectTwinkleSemantics(createPlan(state.seed), state.pulses);
      expect(semantics[0]?.chunkId).toBe(boundary.chunkId);
      expect(semantics[0]?.phase).toBe(boundary.phase);
      expect(state.pulses[0]).toBe(source);
      expect(hashJourney(state)).toBe(beforeHash);
      assertDeepFrozen(semantics);
    }

    const plan = createPlan(0);
    expect(() => projectTwinkleSemantics(plan, [
      Object.freeze({ ...pulse(1, 36), phase: "ASCENT" as const }),
    ])).toThrow(/phase does not match/i);
    expect(() => projectTwinkleSemantics(plan, [
      Object.freeze({ ...pulse(1, 36.001), phase: "LIFE" as const }),
    ])).toThrow(/phase does not match/i);
  });

  it("copies every gameplay ledger field and adds quality-independent world semantics", () => {
    const state = simulateJourney(REPLAY, { seed: 778 });
    const semantics = projectTwinkleSemantics(createPlan(state.seed), state.pulses);

    expect(semantics.map((entry) => ({
      id: entry.id,
      journeyTime: entry.journeyTime,
      x: entry.x,
      y: entry.y,
      phase: entry.phase,
      source: entry.source,
      value: entry.value,
    }))).toEqual(state.pulses.map((entry) => ({
      id: entry.id,
      journeyTime: entry.journeyTime,
      x: entry.x,
      y: entry.y,
      phase: entry.phase,
      source: entry.source,
      value: entry.value,
    })));
    for (const entry of semantics) {
      expect(entry.biome.length).toBeGreaterThan(0);
      expect(entry.speciesFamily).toMatch(/^(marine|terrestrial|aerial|cosmic)$/);
      expect(entry.signature).toMatch(/^twinkle-semantic-v1:[0-9a-f]{16}$/);
      expect(Object.keys(entry).filter((key) => /quality|backend|webgpu|webgl/i.test(key))).toEqual([]);
    }
  });

  it("returns deterministic, deeply frozen copies", () => {
    const state = simulateJourney(REPLAY, { seed: 778 });
    const first = projectTwinkleSemantics(createPlan(state.seed), state.pulses);
    const second = projectTwinkleSemantics(createPlan(state.seed), state.pulses);

    expect(first).toEqual(second);
    assertDeepFrozen(first);
    first.forEach((entry, index) => expect(entry).not.toBe(state.pulses[index]));
  });

  it("snapshots each ledger entry data property exactly once without invoking ordinary gets", () => {
    const target = { ...pulse(1, 5) };
    let propertyGets = 0;
    const descriptorReads = new Map<PropertyKey, number>();
    const guarded = new Proxy(target, {
      get() {
        propertyGets += 1;
        throw new Error("ordinary property read");
      },
      getOwnPropertyDescriptor(object, key) {
        descriptorReads.set(key, (descriptorReads.get(key) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    }) as TwinkleSeed;

    const semantics = projectTwinkleSemantics(createPlan(778), Object.freeze([guarded]));

    expect(semantics[0]?.id).toBe(1);
    expect(propertyGets).toBe(0);
    expect(Object.fromEntries(descriptorReads)).toEqual({
      id: 1,
      journeyTime: 1,
      x: 1,
      y: 1,
      phase: 1,
      source: 1,
      value: 1,
    });
  });

  it("rejects sparse, accessor-backed, and extra-property ledger arrays without invoking accessors", () => {
    const plan = createPlan(778);
    const sparse = new Array<TwinkleSeed>(2);
    sparse[1] = pulse(1, 5);
    expect(() => projectTwinkleSemantics(plan, sparse)).toThrow(/dense|indexed data properties/i);

    let accessorReads = 0;
    const accessorLedger: TwinkleSeed[] = [];
    Object.defineProperty(accessorLedger, "0", {
      configurable: true,
      enumerable: true,
      get() {
        accessorReads += 1;
        return pulse(1, 5);
      },
    });
    expect(() => projectTwinkleSemantics(plan, accessorLedger)).toThrow(/own data property/i);
    expect(accessorReads).toBe(0);

    const extra = [pulse(1, 5)];
    Object.defineProperty(extra, "qualityTier", { value: "high", enumerable: false });
    expect(() => projectTwinkleSemantics(plan, extra)).toThrow(/only indexed data properties|extra property/i);
  });

  it("rejects accessor-backed, inherited, missing, and extra ledger-entry fields", () => {
    const plan = createPlan(778);
    let accessorReads = 0;
    const accessorEntry = { ...pulse(1, 5) };
    Object.defineProperty(accessorEntry, "x", {
      configurable: true,
      enumerable: true,
      get() {
        accessorReads += 1;
        return 0;
      },
    });
    expect(() => projectTwinkleSemantics(plan, [accessorEntry as TwinkleSeed])).toThrow(/own data property/i);
    expect(accessorReads).toBe(0);

    const extraEntry = { ...pulse(1, 5), backend: "webgpu" } as unknown as TwinkleSeed;
    expect(() => projectTwinkleSemantics(plan, [extraEntry])).toThrow(/exactly the canonical/i);

    const missingEntry = { ...pulse(1, 5) } as Partial<TwinkleSeed>;
    Reflect.deleteProperty(missingEntry, "value");
    expect(() => projectTwinkleSemantics(plan, [missingEntry as TwinkleSeed])).toThrow(/exactly the canonical/i);

    class DerivedEntry {
      id = 1;
      journeyTime = 5;
      x = 0;
      y = 0;
      phase = "LIFE" as const;
      source = "player" as const;
      value = 1;
    }
    expect(() => projectTwinkleSemantics(plan, [new DerivedEntry()])).toThrow(/plain or null prototype/i);
  });

  it("enforces the frozen simulation ranges while accepting their exact inclusive edges", () => {
    const plan = createPlan(778);
    const edgeEntries = Object.freeze([
      Object.freeze({ ...pulse(1, 0), x: -0.94, y: 0.94, value: 0 }),
      Object.freeze({ ...pulse(2, 180), x: 0.94, y: -0.94, value: 0xffff_ffff }),
    ]);
    expect(() => projectTwinkleSemantics(plan, edgeEntries)).not.toThrow();

    const invalidEntries: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["zero id", { id: 0 }],
      ["negative-zero id", { id: -0 }],
      ["fractional id", { id: 1.5 }],
      ["oversized id", { id: 0x1_0000_0000 }],
      ["negative time", { journeyTime: -1 }],
      ["late time", { journeyTime: 180.001 }],
      ["negative-zero time", { journeyTime: -0 }],
      ["non-finite x", { x: Number.NaN }],
      ["non-finite y", { y: Number.POSITIVE_INFINITY }],
      ["x outside playable bound", { x: 0.940_001 }],
      ["y outside playable bound", { y: -0.940_001 }],
      ["negative value", { value: -1 }],
      ["negative-zero value", { value: -0 }],
      ["fractional value", { value: 0.5 }],
      ["oversized value", { value: 0x1_0000_0000 }],
      ["invalid phase", { phase: "BROKEN" }],
      ["invalid source", { source: "auto" }],
    ];
    for (const [label, override] of invalidEntries) {
      const candidate = { ...pulse(1, 5), ...override } as unknown as TwinkleSeed;
      expect(() => projectTwinkleSemantics(plan, [candidate]), label).toThrow();
    }
  });

  it("validates seed, generator, and chunk lookup before projection without mutating the plan", () => {
    const invalidSeed = mutablePlan();
    invalidSeed.worldSeed = "-1";
    const invalidSeedBefore = JSON.stringify(invalidSeed);
    expect(() => projectTwinkleSemantics(invalidSeed, [pulse(1, 5)])).toThrow(/world plan|seed/i);
    expect(JSON.stringify(invalidSeed)).toBe(invalidSeedBefore);

    const invalidVersion = mutablePlan();
    invalidVersion.generatorVersion = "世界";
    const invalidVersionBefore = JSON.stringify(invalidVersion);
    expect(() => projectTwinkleSemantics(invalidVersion, [pulse(1, 5)])).toThrow(/world plan|generator|ascii/i);
    expect(JSON.stringify(invalidVersion)).toBe(invalidVersionBefore);

    const missingChunk = mutablePlan();
    missingChunk.chunks.splice(0, 1);
    const missingChunkBefore = JSON.stringify(missingChunk);
    expect(() => projectTwinkleSemantics(missingChunk, [pulse(1, 5)])).toThrow(/world plan|chunk/i);
    expect(JSON.stringify(missingChunk)).toBe(missingChunkBefore);
  });

  it("validates and consumes one descriptor-owned plan snapshot without later caller reads", () => {
    const target = mutablePlan(778);
    const baseline = projectTwinkleSemantics(target, [pulse(1, 5)]);
    const injectedChunks = structuredClone(target.chunks);
    const injectedChunk = injectedChunks[1];
    if (!injectedChunk) throw new Error("Expected S02 for the stateful plan regression.");
    injectedChunk.storyNode.biome = "injected-after-validation";

    let ordinaryReads = 0;
    const readsByProperty = new Map<PropertyKey, number>();
    const statefulPlan = new Proxy(target, {
      get(object, property, receiver) {
        ordinaryReads += 1;
        const reads = (readsByProperty.get(property) ?? 0) + 1;
        readsByProperty.set(property, reads);
        if (property === "worldSeed" && reads > 2) return "779";
        if (property === "generatorVersion" && reads > 2) return "gfx003-world-plan-v2";
        if (property === "chunks" && reads > 3) return injectedChunks;
        return Reflect.get(object, property, receiver) as unknown;
      },
    });

    const projected = projectTwinkleSemantics(statefulPlan, [pulse(1, 5)]);

    expect(projected).toEqual(baseline);
    expect(projected[0]?.biome).not.toBe("injected-after-validation");
    expect(projected[0]?.signature).toBe(baseline[0]?.signature);
    expect(ordinaryReads).toBe(0);
    expect(readsByProperty.size).toBe(0);
  });

  it("binds signatures to every projected semantic including biome and species family", () => {
    const plan = createPlan(778);
    const semantic = projectTwinkleSemantics(plan, [pulse(1, 5)])[0];
    if (!semantic) throw new Error("Expected one Twinkle semantic.");
    const { signature, ...unsigned } = semantic;
    const registry = createSeedStreamRegistry(createWorldGenerationContext({
      worldSeed: Number(plan.worldSeed),
      generatorVersion: plan.generatorVersion,
    }));
    const entropy = registry.stream("twinkle", semantic.chunkId, "ledger").uint32At(semantic.id);
    const signatureFor = (candidate: typeof unsigned) => digestCanonicalValue({
      worldSeed: plan.worldSeed,
      generatorVersion: plan.generatorVersion,
      entropy,
      semantic: candidate,
    }, "twinkle-semantic-v1");

    expect(signature).toBe(signatureFor(unsigned));
    expect(signature).not.toBe(signatureFor({ ...unsigned, biome: `${unsigned.biome}-changed` }));
    expect(signature).not.toBe(signatureFor({ ...unsigned, speciesFamily: "cosmic" }));
  });
});
