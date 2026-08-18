import { describe, expect, it } from "vitest";
import { projectJourneyState } from "../../src/gfx/v2/project-journey";
import { hashJourney, simulateJourney } from "../../src/game/simulation";

const REPLAY = [
  { at: 5, moveX: 0.7, moveY: 0.1, pulse: true },
  { at: 39, moveX: -0.4, moveY: 0.8, pulse: true },
  { at: 166.4, moveX: 0, moveY: 0, pulse: true },
] as const;

describe("GFX-002 frozen replay fixture", () => {
  it("pins the gameplay hash independently from requested render quality", () => {
    const low = simulateJourney(REPLAY, { seed: 778, quality: "low" });
    const high = simulateJourney(REPLAY, { seed: 778, quality: "high" });

    expect(hashJourney(low)).toBe("09780631");
    expect(hashJourney(high)).toBe("09780631");
    expect(projectJourneyState(low)).toEqual(projectJourneyState(high));
  });

  it("projects copied renderer containers without mutating or exposing the ledger", () => {
    const state = simulateJourney(REPLAY, { seed: 778 });
    const before = hashJourney(state);
    const projected = projectJourneyState(state);

    expect(projected.pulses).not.toBe(state.pulses);
    expect(projected.position).not.toBe(state.position);
    expect(projected.velocity).not.toBe(state.velocity);
    expect(projected).toMatchObject({
      seed: 778,
      storyTime: 180,
      phase: "TWINKLE",
      shotId: "S24",
      finished: true,
    });
    expect(hashJourney(state)).toBe(before);
    expect(before).toBe("09780631");
  });
});
