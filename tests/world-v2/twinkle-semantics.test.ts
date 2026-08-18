import { describe, expect, it } from "vitest";
import { phaseAt, type TwinkleSeed } from "../../src/game/model";
import { hashJourney, simulateJourney } from "../../src/game/simulation";
import {
  createWorldGenerationContext,
  generateWorldPlan,
  projectTwinkleSemantics,
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
});
