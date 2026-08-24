import { describe, expect, it } from "vitest";
import { createMinimumLoopState, stepMinimumLoop, type MinimumLoopInput, type MinimumLoopState } from "../../src/game/r5/minimum-loop";

function run(
  inputAt: (state: MinimumLoopState) => MinimumLoopInput,
): MinimumLoopState {
  let state = createMinimumLoopState();
  while (state.timeMs < 15_000) state = stepMinimumLoop(state, inputAt(state), 16);
  return state;
}

describe("QX-R5-001 deterministic 15-second loop", () => {
  it("emits Ring, Obstacle, and Node exactly once in order within 15 seconds", () => {
    const state = run(() => ({ moveX: 0, pointerXPermille: null, pulse: false }));
    expect(state.timeMs).toBe(15_000);
    expect(state.progress).toBe(3);
    expect(state.events.map((entry) => [entry.encounter, entry.atMs])).toEqual([
      ["ring", 4_000],
      ["obstacle", 8_000],
      ["node", 11_000],
    ]);
  });

  it("supports a successful steer-and-pulse replay without vertical input", () => {
    const state = run((current) => ({
      moveX: 0,
      pointerXPermille: current.timeMs < 4_000 ? -200 : current.timeMs < 8_000 ? -650 : 450,
      pulse: current.timeMs >= 10_480 && current.timeMs < 10_496,
    }));
    expect(state.ringResult).toBe("pass");
    expect(state.obstacleResult).toBe("dodge");
    expect(state.nodeResult).toBe("perfect");
    expect(state.events).toHaveLength(3);
  });

  it("is deterministic for the same fixed-step input stream", () => {
    const replay = (state: MinimumLoopState): MinimumLoopInput => ({
      moveX: state.timeMs < 2_000 ? -1 : state.timeMs < 7_000 ? 1 : 0,
      pointerXPermille: null,
      pulse: state.timeMs === 10_496,
    });
    expect(run(replay)).toEqual(run(replay));
  });

  it("clamps long frames and the horizontal playfield", () => {
    let state = createMinimumLoopState();
    state = stepMinimumLoop(state, { moveX: 1, pointerXPermille: 4_000, pulse: false }, 1_000);
    expect(state.timeMs).toBe(100);
    expect(state.playerXPermille).toBeLessThanOrEqual(850);
    for (let index = 0; index < 100; index += 1) {
      state = stepMinimumLoop(state, { moveX: 1, pointerXPermille: 4_000, pulse: false }, 100);
    }
    expect(state.playerXPermille).toBe(850);
  });

  it("resolves each encounter when shared distance crosses its rail anchor", () => {
    let state = createMinimumLoopState();
    while (state.timeMs < 3_984) {
      state = stepMinimumLoop(state, { moveX: 0, pointerXPermille: -200, pulse: false }, 16);
    }
    expect(state.distanceMm).toBeLessThan(4_800);
    expect(state.ringResult).toBe("pending");
    state = stepMinimumLoop(state, { moveX: 0, pointerXPermille: -200, pulse: false }, 16);
    expect(state.distanceMm).toBeGreaterThanOrEqual(4_800);
    expect(state.ringResult).toBe("pass");
    expect(state.events[0]?.distanceMm).toBe(4_800);
  });
});
