import { describe, expect, it } from "vitest";
import { JOURNEY_SECONDS, PHASE_WINDOWS, SHOT_TABLE, phaseAt, shotAt } from "../src/game/model";
import { generateRoute } from "../src/game/procedural";
import { createJourneyState, hashJourney, simulateJourney, stepJourney, validateSeedProperties } from "../src/game/simulation";

describe("authored journey score", () => {
  it("contains a contiguous 24-shot, 180-second score", () => {
    expect(SHOT_TABLE).toHaveLength(24);
    expect(SHOT_TABLE[0].start).toBe(0);
    expect(SHOT_TABLE[SHOT_TABLE.length - 1]?.end).toBe(JOURNEY_SECONDS);
    SHOT_TABLE.forEach((shot, index) => {
      expect(shot.end).toBeGreaterThan(shot.start);
      if (index > 0) expect(shot.start).toBe(SHOT_TABLE[index - 1].end);
    });
  });

  it("uses the exact phase boundaries", () => {
    expect(PHASE_WINDOWS).toEqual({ LIFE: [0, 36], EARTH: [36, 88], ASCENT: [88, 130], SOLITUDE: [130, 161], ANSWER: [161, 171], TWINKLE: [171, 180] });
    expect([phaseAt(0), phaseAt(36), phaseAt(88), phaseAt(130), phaseAt(161), phaseAt(171)]).toEqual(["LIFE", "EARTH", "ASCENT", "SOLITUDE", "ANSWER", "TWINKLE"]);
    expect(shotAt(180).id).toBe("S24");
  });
});

describe("deterministic simulation", () => {
  const inputs = [
    { at: 5, moveX: 0.7, moveY: 0.1, pulse: true },
    { at: 39, moveX: -0.4, moveY: 0.8, pulse: true },
    { at: 166.4, moveX: 0, moveY: 0, pulse: true },
  ] as const;

  it("makes one immutable ledger entry per player pulse", () => {
    const state = simulateJourney(inputs, { seed: 42 });
    expect(state.pulses).toHaveLength(3);
    expect(Object.isFrozen(state.pulses)).toBe(true);
    expect(Object.isFrozen(state.pulses[0])).toBe(true);
    expect(state.pulses.map((pulse) => pulse.phase)).toEqual(["LIFE", "EARTH", "ANSWER"]);
    expect(state.answerAt).toBeCloseTo(166.4, 3);
  });

  it("has a quality-independent state hash for the same run", () => {
    const low = simulateJourney(inputs, { seed: 778, quality: "low" });
    const high = simulateJourney(inputs, { seed: 778, quality: "high" });
    expect(hashJourney(low)).toBe(hashJourney(high));
  });

  it("automatically answers 2.5 seconds after the response window opens", () => {
    const state = simulateJourney([], { seed: 3 });
    expect(state.answerAt).toBe(168.5);
  });

  it("does not reveal the formal title shot before 178 seconds", () => {
    expect(shotAt(177.999).id).toBe("S23");
    expect(shotAt(178).id).toBe("S24");
  });

  it("clamps the droplet to the playable route plane", () => {
    let state = createJourneyState({ seed: 1 });
    for (let index = 0; index < 600; index += 1) state = stepJourney(state, { moveX: 1, moveY: 1 }, 1 / 60);
    expect(Math.abs(state.position.x)).toBeLessThanOrEqual(0.94);
    expect(Math.abs(state.position.y)).toBeLessThanOrEqual(0.94);
  });
});

describe("procedural safety properties", () => {
  it("validates 1,000 numeric seeds with no out-of-bounds routes", () => {
    expect(validateSeedProperties(1000)).toEqual({ valid: true, checked: 1000, invalidSeeds: [] });
  });

  it("generates stable paths", () => {
    expect(generateRoute(99)).toEqual(generateRoute(99));
  });
});
