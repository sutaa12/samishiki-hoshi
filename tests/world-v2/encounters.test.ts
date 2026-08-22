import { describe, expect, it } from "vitest";
import {
  railEncountersFromWorldPlan,
} from "../../src/game/encounter-system";
import { hashJourney, simulateJourney } from "../../src/game/simulation";
import { projectEncounterDebugMarkers } from "../../src/gfx/v2/chunks";
import {
  createWorldGenerationContext,
  generateWorldPlan,
  validateWorldPlan,
  validateWorldSeedRange,
  type WorldEncounterPlan,
  type WorldPlan,
} from "../../src/world/v2";

function plan(seed: number): Readonly<WorldPlan> {
  return generateWorldPlan(createWorldGenerationContext({ worldSeed: seed }));
}

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

function mutablePlan(seed: number): Mutable<WorldPlan> {
  return structuredClone(plan(seed)) as Mutable<WorldPlan>;
}

function early(encounters: readonly Readonly<WorldEncounterPlan>[]) {
  return encounters.filter((encounter) => encounter.distanceMm < 360_000);
}

describe("QX-R3-004 WorldPlan encounters", () => {
  it("generates the exact first-36-second contract and keeps only tutorial anchors seed-invariant", () => {
    const zero = plan(0);
    const other = plan(0xffff_ffff);
    const first = early(zero.encounters);

    expect(first.filter((entry) => entry.kind === "gate")).toHaveLength(5);
    expect(first.filter((entry) => entry.kind === "obstacle")).toHaveLength(3);
    expect(first.filter((entry) => entry.kind === "life-node")).toHaveLength(3);
    expect(first.map((entry) => entry.distanceMm)).toEqual([...first.map((entry) => entry.distanceMm)].sort((a, b) => a - b));

    const tutorialGate = zero.encounters.find((entry) => entry.kind === "gate" && entry.authoredRole === "tutorial");
    const tutorialNode = zero.encounters.find((entry) => entry.kind === "life-node" && entry.authoredRole === "tutorial");
    expect(tutorialGate).toEqual(other.encounters.find((entry) => entry.id === tutorialGate?.id));
    expect(tutorialNode).toEqual(other.encounters.find((entry) => entry.id === tutorialNode?.id));

    const seededZero = zero.encounters.filter((entry) => entry.authoredRole === "story").map((entry) => entry.centerOffsetMm);
    const seededOther = other.encounters.filter((entry) => entry.authoredRole === "story").map((entry) => entry.centerOffsetMm);
    expect(seededZero).not.toEqual(seededOther);
  });

  it("passes canonical validation for 1,000 seeds with an independently passable obstacle route", () => {
    expect(validateWorldSeedRange(1_000)).toEqual({
      valid: true,
      checked: 1_000,
      invalidSeeds: [],
      issuesBySeed: {},
    });
    for (let seed = 0; seed < 1_000; seed += 1) {
      const generated = plan(seed);
      for (const encounter of generated.encounters) {
        expect(encounter.distanceMm, `${seed}:${encounter.id}:near-plane`).toBeGreaterThanOrEqual(30_000);
        expect(encounter.previewDistanceMm, `${seed}:${encounter.id}:preview`).toBe(18_000);
        if (encounter.kind !== "obstacle") continue;
        expect(Math.abs(encounter.safeRouteOffsetMm.x), `${seed}:${encounter.id}:safe-x`).toBeLessThanOrEqual(940);
        expect(Math.abs(encounter.safeRouteOffsetMm.y), `${seed}:${encounter.id}:safe-y`).toBeLessThanOrEqual(940);
        expect(Math.hypot(
          encounter.safeRouteOffsetMm.x - encounter.centerOffsetMm.x,
          encounter.safeRouteOffsetMm.y - encounter.centerOffsetMm.y,
        ), `${seed}:${encounter.id}:clearance`).toBeGreaterThan(encounter.radii.visibleRingMm + 200);
      }
    }
  }, 30_000);

  it("uses one immutable descriptor for gameplay radii and High/Fallback debug realization", () => {
    const generated = plan(20_260_822);
    const gameplay = railEncountersFromWorldPlan(generated);
    const high = projectEncounterDebugMarkers(generated, "high");
    const fallback = projectEncounterDebugMarkers(generated, "fallback");

    expect(fallback).toEqual(high);
    expect(Object.isFrozen(high)).toBe(true);
    expect(gameplay).toHaveLength(generated.encounters.length);
    for (const [index, descriptor] of generated.encounters.entries()) {
      const rail = gameplay[index];
      const marker = high[index];
      expect(rail?.id).toBe(descriptor.id);
      expect(marker).toMatchObject({
        id: descriptor.id,
        collisionRadiusMm: descriptor.radii.collisionMm,
        visibleRingRadiusMm: descriptor.radii.visibleRingMm,
      });
      if (rail?.kind === "gate") expect(rail.radiusMm).toBe(descriptor.radii.collisionMm);
      if (rail?.kind === "obstacle") {
        expect(rail.hitRadiusMm).toBe(descriptor.radii.collisionMm);
        expect(rail.nearMissRadiusMm).toBe(descriptor.radii.visibleRingMm);
      }
      if (rail?.kind === "life-node") {
        expect(rail.perfectRadiusMm).toBe(descriptor.radii.collisionMm);
        expect(rail.goodRadiusMm).toBe(descriptor.radii.visibleRingMm);
      }
    }

    const replay = [
      { at: 5, moveX: 0.7, moveY: 0.1, pulse: true },
      { at: 39, moveX: -0.4, moveY: 0.8, pulse: true },
      { at: 166.4, moveX: 0, moveY: 0, pulse: true },
    ] as const;
    expect(hashJourney(simulateJourney(replay, { seed: 20_260_822, quality: "high" }))).toBe(
      hashJourney(simulateJourney(replay, { seed: 20_260_822, quality: "low" })),
    );
  });

  it("rejects overlap, unreachable safe routes, and near-plane descriptor mutations", () => {
    const overlap = mutablePlan(4);
    overlap.encounters[1]!.distanceMm = overlap.encounters[0]!.distanceMm;
    expect(validateWorldPlan(overlap).issues.some((issue) => issue.code === "ENCOUNTER_OVERLAP")).toBe(true);

    const unreachable = mutablePlan(5);
    const obstacle = unreachable.encounters.find((entry) => entry.kind === "obstacle");
    if (!obstacle || obstacle.kind !== "obstacle") throw new Error("Expected obstacle descriptor.");
    obstacle.safeRouteOffsetMm.x = 941;
    expect(validateWorldPlan(unreachable).issues.some((issue) => issue.code === "ENCOUNTER_UNREACHABLE")).toBe(true);

    const nearPlane = mutablePlan(6);
    nearPlane.encounters[0]!.distanceMm = 29_999;
    expect(validateWorldPlan(nearPlane).issues.some((issue) => issue.code === "ENCOUNTER_PREVIEW_INVALID")).toBe(true);
  });
});
