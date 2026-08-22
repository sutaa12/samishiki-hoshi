import { describe, expect, it } from "vitest";
import { productionQualityId } from "../../src/gfx/v2/integration/production-journey-runtime";
import { projectJourneyState, projectRailFlightState } from "../../src/gfx/v2/project-journey";
import { advanceJourneyTo, createJourneyState, hashJourney, stepJourney } from "../../src/game/simulation";

describe("QX-R3-001 production journey boundary", () => {
  it("maps public quality choices to the existing warmed v2 profiles", () => {
    expect(productionQualityId("low")).toBe("low-static");
    expect(productionQualityId("balanced")).toBe("balanced-temporal");
    expect(productionQualityId("high")).toBe("high-temporal");
    expect(productionQualityId("low", true)).toBe("low-static");
    expect(productionQualityId("balanced", true)).toBe("balanced-static");
    expect(productionQualityId("high", true)).toBe("high-static");
  });

  it("projects the live seed, time, movement, pulse ledger, and answer state without changing gameplay", () => {
    const checkpoint = advanceJourneyTo(createJourneyState({ seed: 20_260_818 }), 166);
    const moved = stepJourney(checkpoint, { moveX: 0.8, moveY: -0.25 }, 1 / 60);
    const pulsed = stepJourney(moved, { pulse: true }, 1 / 60);
    const before = hashJourney(pulsed);
    const projected = projectJourneyState(pulsed);
    const rail = projectRailFlightState(pulsed);

    expect(projected).toMatchObject({
      seed: 20_260_818,
      storyTime: pulsed.time,
      phase: "ANSWER",
      shotId: "S22",
      position: pulsed.position,
      velocity: pulsed.velocity,
      answerAt: pulsed.answerAt,
      finished: false,
    });
    expect(projected.pulses).toHaveLength(1);
    expect(projected.pulses[0]).toEqual(pulsed.pulses[0]);
    expect(projected.position).not.toBe(pulsed.position);
    expect(projected.velocity).not.toBe(pulsed.velocity);
    expect(projected.pulses).not.toBe(pulsed.pulses);
    expect(rail).toEqual({
      distanceMm: pulsed.distanceMm,
      forwardSpeedMmPerSecond: pulsed.forwardSpeedMmPerSecond,
      corridorOffset: pulsed.corridorOffset,
    });
    expect(rail.corridorOffset).not.toBe(pulsed.corridorOffset);
    expect(Object.isFrozen(rail)).toBe(true);
    expect(Object.isFrozen(rail.corridorOffset)).toBe(true);
    const normalizedZero = projectRailFlightState({
      ...pulsed,
      corridorOffset: { x: -0, y: -0 },
    });
    expect(Object.is(normalizedZero.corridorOffset.x, -0)).toBe(false);
    expect(Object.is(normalizedZero.corridorOffset.y, -0)).toBe(false);
    expect(hashJourney(pulsed)).toBe(before);
  });
});
