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
      ["fractional id", { id: 1.5 }],
      ["oversized id", { id: 0x1_0000_0000 }],
      ["negative time", { journeyTime: -1 }],
      ["late time", { journeyTime: 180.001 }],
      ["negative-zero time", { journeyTime: -0 }],
      ["non-finite x", { x: Number.NaN }],
      ["x outside playable bound", { x: 0.940_001 }],
      ["y outside playable bound", { y: -0.940_001 }],
      ["negative value", { value: -1 }],
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
