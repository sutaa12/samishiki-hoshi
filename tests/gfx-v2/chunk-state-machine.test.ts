import { describe, expect, it } from "vitest";
import {
  createAbsentChunkSnapshot,
  failChunkSnapshot,
  isChunkTransitionAllowed,
  transitionChunkSnapshot,
  updateChunkWindowRole,
} from "../../src/gfx/v2/chunks/state-machine";

describe("GFX-004 chunk lifecycle", () => {
  it("follows the accepted eight-state path and represents Page-11 phases as subphases", () => {
    let state = createAbsentChunkSnapshot("S08");
    state = transitionChunkSnapshot(state, "queued", {
      role: "current",
      subphase: "planned",
      epoch: 1,
      requestId: 7,
    });
    state = transitionChunkSnapshot(state, "generating", { subphase: "worker" });
    state = transitionChunkSnapshot(state, "generated", { subphase: "validating" });
    state = transitionChunkSnapshot(state, "uploading", {
      subphase: "gpu-upload-pending",
      gpuSlotOwned: true,
    });
    state = transitionChunkSnapshot(state, "active", { subphase: "none" });
    state = updateChunkWindowRole(state, "behind");
    expect(state).toMatchObject({ state: "active", role: "behind", updateMode: "frozen" });
    state = transitionChunkSnapshot(state, "retiring", { role: null });
    state = transitionChunkSnapshot(state, "disposed", { gpuSlotOwned: false });

    expect(state).toMatchObject({
      chunkId: "S08",
      state: "disposed",
      epoch: 1,
      requestId: 7,
      gpuSlotOwned: false,
    });
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("fails closed on every skipped, reversed, or post-terminal transition", () => {
    const absent = createAbsentChunkSnapshot("S01");
    expect(() => transitionChunkSnapshot(absent, "active", { gpuSlotOwned: true })).toThrow(/Invalid chunk transition/);
    const queued = transitionChunkSnapshot(absent, "queued");
    expect(() => transitionChunkSnapshot(queued, "generated")).toThrow(/Invalid chunk transition/);
    const retiring = transitionChunkSnapshot(queued, "retiring");
    const disposed = transitionChunkSnapshot(retiring, "disposed", { gpuSlotOwned: false });
    expect(() => transitionChunkSnapshot(disposed, "queued")).toThrow(/Invalid chunk transition/);
    expect(isChunkTransitionAllowed("failed", "queued")).toBe(false);
  });

  it("requires an owned GPU slot for active and releases it before terminal state", () => {
    let state = transitionChunkSnapshot(createAbsentChunkSnapshot("S02"), "queued");
    state = transitionChunkSnapshot(state, "generating");
    state = transitionChunkSnapshot(state, "generated");
    state = transitionChunkSnapshot(state, "uploading", { gpuSlotOwned: true });
    expect(() => transitionChunkSnapshot(state, "active", { gpuSlotOwned: false })).toThrow(/GPU slot/);
    expect(() => transitionChunkSnapshot(state, "failed", { gpuSlotOwned: true })).toThrow(/cannot retain/);

    const failed = failChunkSnapshot(state, Object.freeze({
      code: "UPLOAD_FAILED",
      path: "$.upload",
      detail: "bounded failure",
      chunkId: "S02",
    }), true);
    expect(failed).toMatchObject({
      state: "failed",
      gpuSlotOwned: false,
      placeholder: true,
      subphase: "placeholder",
    });
  });
});
