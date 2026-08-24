import { describe, expect, it } from "vitest";
import { MINIMUM_ENCOUNTERS, MINIMUM_SPEED_MM_PER_SECOND } from "../../src/game/r5/minimum-encounters";
import {
  ConveyorRail,
  MINIMUM_FOV_EVALUATIONS,
  MINIMUM_NEAR_MARKER_CYCLE_MM,
  MINIMUM_NEAR_MARKER_SPACING_MM,
  MINIMUM_NEAR_RECYCLE_BEHIND_MM,
  MINIMUM_PLAYER_Z,
  MINIMUM_SELECTED_FOV,
  MINIMUM_WORLD_UNITS_PER_MM,
} from "../../src/gfx/r5/conveyor-rail";

describe("QX-R5-002 ConveyorRail", () => {
  it("derives encounter render Z only from anchor distance and travelled distance", () => {
    const rail = new ConveyorRail();
    expect(rail.zAt(MINIMUM_ENCOUNTERS.ring.distanceMm, 0)).toBe(
      MINIMUM_PLAYER_Z - MINIMUM_ENCOUNTERS.ring.distanceMm * MINIMUM_WORLD_UNITS_PER_MM,
    );
    expect(rail.zAt(MINIMUM_ENCOUNTERS.ring.distanceMm, MINIMUM_ENCOUNTERS.ring.distanceMm)).toBe(MINIMUM_PLAYER_Z);
    expect(rail.zAt(MINIMUM_ENCOUNTERS.ring.distanceMm, MINIMUM_ENCOUNTERS.ring.distanceMm + 450)).toBe(MINIMUM_PLAYER_Z + 1);
  });

  it("keeps repeated Near markers continuous through a camera-side recycle window", () => {
    const rail = new ConveyorRail();
    const before = rail.repeatedZAt(360, 359, MINIMUM_NEAR_MARKER_CYCLE_MM, MINIMUM_NEAR_RECYCLE_BEHIND_MM);
    const at = rail.repeatedZAt(360, 360, MINIMUM_NEAR_MARKER_CYCLE_MM, MINIMUM_NEAR_RECYCLE_BEHIND_MM);
    const after = rail.repeatedZAt(360, 361, MINIMUM_NEAR_MARKER_CYCLE_MM, MINIMUM_NEAR_RECYCLE_BEHIND_MM);
    expect(before).toBeLessThan(at);
    expect(at).toBe(MINIMUM_PLAYER_Z);
    expect(after).toBeGreaterThan(at);
  });

  it("sets the Near-marker pass cadence to 600ms without changing game speed", () => {
    const rail = new ConveyorRail();
    expect(rail.passIntervalMs(MINIMUM_NEAR_MARKER_SPACING_MM, MINIMUM_SPEED_MM_PER_SECOND)).toBe(600);
    expect(MINIMUM_SPEED_MM_PER_SECOND).toBe(1_200);
  });

  it("selects a deterministic FOV inside the specified 55–70 degree range", () => {
    expect(MINIMUM_FOV_EVALUATIONS.map((entry) => entry.fovDegrees)).toEqual([55, 62, 70]);
    expect(MINIMUM_SELECTED_FOV).toBe(62);
    expect(MINIMUM_SELECTED_FOV).toBeGreaterThanOrEqual(55);
    expect(MINIMUM_SELECTED_FOV).toBeLessThanOrEqual(70);
  });

  it("rejects invalid repeated-rail cycles", () => {
    const rail = new ConveyorRail();
    expect(() => rail.repeatedZAt(0, 0, 0, 0)).toThrow(RangeError);
    expect(() => rail.repeatedZAt(0, 0, 100, 100)).toThrow(RangeError);
  });
});
