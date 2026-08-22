import { describe, expect, it } from "vitest";
import type { RailEncounter } from "../src/game/encounter-system";
import { distanceToEncounter3dMm } from "../src/game/encounter-system";
import {
  advanceJourneyTo,
  createJourneyState,
  hashJourney,
  simulateJourney,
  stepJourney,
} from "../src/game/simulation";
import { PULSE_COOLDOWN_MS, RAIL_FORWARD_SPEED_MM_PER_SECOND } from "../src/game/rail-flight-state";

const centeredGate = (id: string, distanceMm: number): Readonly<RailEncounter> => ({
  id,
  kind: "gate",
  distanceMm,
  center: { x: 0, y: -710 },
  radiusMm: 240,
});

describe("QX-R3-002 deterministic rail flight", () => {
  it("advances distance without input while score and Twinkle Seed stay at zero", () => {
    const state = simulateJourney([], { seed: 91 });

    expect(state.distanceMm).toBeGreaterThan(1_700_000);
    expect(state.score).toBe(0);
    expect(state.pulses).toEqual([]);
    expect(state.answerAt).toBeNull();
    expect(state.finished).toBe(true);
  });

  it("classifies the center replay as pass and the outside replay as miss exactly once", () => {
    const pass = advanceJourneyTo(createJourneyState({ seed: 4 }), 0.2, {}, [centeredGate("gate-pass", 1_000)]);
    const missGate: Readonly<RailEncounter> = {
      id: "gate-miss",
      kind: "gate",
      distanceMm: 1_000,
      center: { x: 900, y: 900 },
      radiusMm: 180,
    };
    const miss = advanceJourneyTo(createJourneyState({ seed: 4 }), 0.2, {}, [missGate]);

    expect(pass.passedEncounterIds).toEqual(["gate-pass"]);
    expect(pass.gameplayEvents.filter((event) => event.kind === "gate-pass")).toHaveLength(1);
    expect(pass.score).toBe(100);
    expect(miss.missedEncounterIds).toEqual(["gate-miss"]);
    expect(miss.gameplayEvents.filter((event) => event.kind === "gate-miss")).toHaveLength(1);
    expect(miss.score).toBe(0);
  });

  it("uses 3D proximity for obstacle hit and applies a short deterministic slowdown", () => {
    const obstacle: Readonly<RailEncounter> = {
      id: "rock-hit",
      kind: "obstacle",
      distanceMm: 1_000,
      center: { x: 0, y: -710 },
      hitRadiusMm: 180,
      nearMissRadiusMm: 420,
    };
    const hit = advanceJourneyTo(createJourneyState({ seed: 8 }), 0.2, {}, [obstacle]);

    expect(hit.gameplayEvents.filter((event) => event.kind === "obstacle-hit")).toHaveLength(1);
    expect(hit.forwardSpeedMmPerSecond).toBeLessThan(RAIL_FORWARD_SPEED_MM_PER_SECOND);
    expect(hit.slowdownRemainingMs).toBeGreaterThan(0);
    const recovered = advanceJourneyTo(hit, 1.2, {}, [obstacle]);
    expect(recovered.forwardSpeedMmPerSecond).toBe(RAIL_FORWARD_SPEED_MM_PER_SECOND);
    expect(recovered.slowdownRemainingMs).toBe(0);
  });

  it("creates a Seed only for a nearby Life Node and enforces the 0.7-second cooldown", () => {
    const node: Readonly<RailEncounter> = {
      id: "life-node",
      kind: "life-node",
      distanceMm: 0,
      center: { x: 0, y: -720 },
      perfectRadiusMm: 120,
      goodRadiusMm: 300,
    };
    const initial = createJourneyState({ seed: 12 });
    const activated = stepJourney(initial, { pulse: true }, 0.000_001, [node]);
    const cooldownRejected = stepJourney(activated, { pulse: true }, 0.1, [node]);
    const empty = stepJourney(createJourneyState({ seed: 12 }), { pulse: true }, 0.000_001, []);

    expect(activated.pulses).toHaveLength(1);
    expect(activated.activatedEncounterIds).toEqual(["life-node"]);
    expect(activated.pulseCooldownRemainingMs).toBe(PULSE_COOLDOWN_MS);
    expect(cooldownRejected.pulses).toHaveLength(1);
    expect(cooldownRejected.gameplayEvents.at(-1)?.kind).toBe("pulse-cooldown");
    expect(empty.pulses).toHaveLength(0);
    expect(empty.gameplayEvents.at(-1)?.kind).toBe("pulse-empty");
  });

  it("widens only the next gate after three consecutive misses and never game-overs", () => {
    const encounters: readonly Readonly<RailEncounter>[] = [
      ...[1_000, 2_000, 3_000].map((distanceMm, index) => ({
        id: `miss-${index + 1}`,
        kind: "gate" as const,
        distanceMm,
        center: { x: 900, y: 900 },
        radiusMm: 100,
      })),
      {
        id: "assisted-gate",
        kind: "gate",
        distanceMm: 4_000,
        center: { x: 390, y: -690 },
        radiusMm: 280,
      },
    ];
    const afterMisses = advanceJourneyTo(createJourneyState({ seed: 21 }), 0.31, {}, encounters);

    expect(afterMisses.assistLevel).toBe(1);
    expect(afterMisses.assistNextGate).toBe(true);
    expect(afterMisses.mistakes).toBe(3);
    expect(afterMisses.gameplayEvents.some((event) => event.kind === "assist-next-gate")).toBe(true);

    const recovered = advanceJourneyTo(afterMisses, 0.5, {}, encounters);
    expect(recovered.passedEncounterIds).toContain("assisted-gate");
    expect(recovered.assistNextGate).toBe(false);
    expect(recovered.finished).toBe(false);
  });

  it("produces the same complete rail ledger and hash for the same seed and timed inputs", () => {
    const node: Readonly<RailEncounter> = {
      id: "node-50m",
      kind: "life-node",
      distanceMm: 50_000,
      center: { x: 0, y: -350 },
      perfectRadiusMm: 400,
      goodRadiusMm: 900,
    };
    const inputs = [{ at: 5, moveX: 0.25, moveY: 0.1, pulse: true }] as const;
    const first = simulateJourney(inputs, { seed: 88, encounters: [node] });
    const second = simulateJourney(inputs, { seed: 88, encounters: [node] });

    expect(second).toEqual(first);
    expect(hashJourney(second)).toBe(hashJourney(first));
  });

  it("computes encounter distance from longitudinal and corridor axes", () => {
    const node: Readonly<RailEncounter> = {
      id: "geometry",
      kind: "life-node",
      distanceMm: 1_000,
      center: { x: 300, y: 400 },
      perfectRadiusMm: 100,
      goodRadiusMm: 600,
    };
    expect(distanceToEncounter3dMm(0, { x: 0, y: 0 }, node)).toBeCloseTo(Math.sqrt(1_250_000), 8);
  });
});
