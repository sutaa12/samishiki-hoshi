import { describe, expect, it } from "vitest";
import { RENDER_HISTORY_INVALIDATION_REASONS } from "../../src/gfx/v2/contracts";
import { TemporalHistoryOwner } from "../../src/gfx/v2/pipeline/temporal-history";

describe("GFX-005 temporal-history owner", () => {
  it("keeps disposal terminal when an initialization viewport getter reenters", () => {
    const history = new TemporalHistoryOwner();
    let widthReads = 0;
    const hostileViewport = { height: 360, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(hostileViewport, "width", {
      enumerable: true,
      get() {
        widthReads += 1;
        history.dispose();
        return 640;
      },
    });

    expect(() => history.initialize(
      hostileViewport as unknown as { width: number; height: number; pixelRatio: number },
    )).toThrow(/became disposed/);
    expect(widthReads).toBe(1);
    expect(history.snapshot()).toMatchObject({
      state: "disposed",
      generation: 0,
      valid: false,
      viewport: null,
      pendingReasons: [],
      resetCounts: { initialization: 0 },
    });
  });

  it("rejects nested initialization before the nested viewport is inspected", () => {
    const history = new TemporalHistoryOwner();
    let nestedFailure: unknown;
    let nestedWidthReads = 0;
    const nestedViewport = { height: 180, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(nestedViewport, "width", {
      enumerable: true,
      get() {
        nestedWidthReads += 1;
        return 320;
      },
    });
    const outerViewport = { height: 360, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(outerViewport, "width", {
      enumerable: true,
      get() {
        try {
          history.initialize(
            nestedViewport as unknown as { width: number; height: number; pixelRatio: number },
          );
        } catch (error: unknown) {
          nestedFailure = error;
        }
        return 640;
      },
    });

    history.initialize(
      outerViewport as unknown as { width: number; height: number; pixelRatio: number },
    );
    expect(nestedFailure).toMatchObject({ message: expect.stringMatching(/initialize is active/) });
    expect(nestedWidthReads).toBe(0);
    expect(history.snapshot()).toMatchObject({
      state: "ready",
      generation: 1,
      viewport: { width: 640, height: 360, pixelRatio: 1 },
      pendingReasons: ["initialization"],
    });
    history.dispose();
  });

  it("reserves resize before viewport inspection and rejects nested mutations", () => {
    const history = new TemporalHistoryOwner();
    history.initialize({ width: 640, height: 360, pixelRatio: 1 });
    let nestedWidthReads = 0;
    const nestedViewport = { height: 180, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(nestedViewport, "width", {
      enumerable: true,
      get() {
        nestedWidthReads += 1;
        return 320;
      },
    });
    const nestedFailures: unknown[] = [];
    const outerViewport = { height: 450, pixelRatio: 1.25 } as Record<string, unknown>;
    Object.defineProperty(outerViewport, "width", {
      enumerable: true,
      get() {
        const attempts = [
          () => history.initialize(
            nestedViewport as unknown as { width: number; height: number; pixelRatio: number },
          ),
          () => history.resize(
            nestedViewport as unknown as { width: number; height: number; pixelRatio: number },
          ),
          () => history.invalidate("camera-discontinuity"),
          () => history.beginFrame(),
          () => history.completeFrame(true),
        ];
        for (let index = 0; index < attempts.length; index += 1) {
          try {
            attempts[index]!();
          } catch (error: unknown) {
            nestedFailures[index] = error;
          }
        }
        return 800;
      },
    });

    expect(history.resize(
      outerViewport as unknown as { width: number; height: number; pixelRatio: number },
    )).toBe(true);
    expect(nestedWidthReads).toBe(0);
    expect(nestedFailures).toHaveLength(5);
    for (let index = 0; index < nestedFailures.length; index += 1) {
      expect(nestedFailures[index]).toMatchObject({
        message: expect.stringMatching(/resize is active/),
      });
    }
    expect(history.snapshot()).toMatchObject({
      state: "ready",
      generation: 2,
      valid: false,
      frameActive: false,
      viewport: { width: 800, height: 450, pixelRatio: 1.25 },
      pendingReasons: ["initialization", "resize"],
      resetCounts: { resize: 1, "camera-discontinuity": 0 },
    });
    history.dispose();
  });

  it("keeps disposal terminal when a resize viewport getter reenters", () => {
    const history = new TemporalHistoryOwner();
    history.initialize({ width: 640, height: 360, pixelRatio: 1 });
    let widthReads = 0;
    const hostileViewport = { height: 450, pixelRatio: 1.25 } as Record<string, unknown>;
    Object.defineProperty(hostileViewport, "width", {
      enumerable: true,
      get() {
        widthReads += 1;
        history.dispose();
        return 800;
      },
    });

    expect(() => history.resize(
      hostileViewport as unknown as { width: number; height: number; pixelRatio: number },
    )).toThrow(/became disposed/);
    expect(widthReads).toBe(1);
    expect(history.snapshot()).toMatchObject({
      state: "disposed",
      generation: 1,
      valid: false,
      frameActive: false,
      viewport: null,
      pendingReasons: [],
      resetCounts: { initialization: 1, resize: 0 },
    });
  });

  it("releases viewport admission after capture throws", () => {
    const history = new TemporalHistoryOwner();
    const hostileViewport = { height: 360, pixelRatio: 1 } as Record<string, unknown>;
    Object.defineProperty(hostileViewport, "width", {
      enumerable: true,
      get() {
        throw new Error("viewport capture failed");
      },
    });

    expect(() => history.initialize(
      hostileViewport as unknown as { width: number; height: number; pixelRatio: number },
    )).toThrow("viewport capture failed");
    expect(history.snapshot()).toMatchObject({ state: "new", generation: 0, viewport: null });
    history.initialize({ width: 640, height: 360, pixelRatio: 1 });
    expect(history.snapshot()).toMatchObject({
      state: "ready",
      generation: 1,
      viewport: { width: 640, height: 360, pixelRatio: 1 },
    });
    history.dispose();
  });

  it("owns invalidation generations and never exposes stale history after reset", () => {
    const history = new TemporalHistoryOwner(0.2);
    history.initialize({ width: 640, height: 360, pixelRatio: 1 });
    expect(history.beginFrame()).toMatchObject({ blendWeight: 0, resetReasons: ["initialization"] });
    history.completeFrame(true);
    expect(history.beginFrame().blendWeight).toBe(0.2);
    history.completeFrame(true);

    history.invalidate("camera-discontinuity");
    expect(history.beginFrame()).toMatchObject({
      blendWeight: 0,
      resetReasons: ["camera-discontinuity"],
    });
    history.completeFrame(false);
    expect(history.beginFrame().blendWeight).toBe(0);
    history.completeFrame(true);
    history.dispose();
  });

  it("deduplicates same-frame reasons and treats a repeated viewport as a no-op", () => {
    const history = new TemporalHistoryOwner();
    const viewport = { width: 640, height: 360, pixelRatio: 1 } as const;
    history.initialize(viewport);
    expect(history.resize(viewport)).toBe(false);
    expect(history.resize({ ...viewport, pixelRatio: 1.25 })).toBe(true);
    history.invalidate("resize");
    expect(history.snapshot().resetCounts.resize).toBe(1);
    expect(history.snapshot().pendingReasons).toEqual(["initialization", "resize"]);
    history.dispose();
  });

  it("supports the exact nine shared reset reasons", () => {
    const history = new TemporalHistoryOwner();
    history.initialize({ width: 1, height: 1, pixelRatio: 1 });
    for (const reason of RENDER_HISTORY_INVALIDATION_REASONS) history.invalidate(reason);
    expect(Object.keys(history.snapshot().resetCounts)).toEqual(RENDER_HISTORY_INVALIDATION_REASONS);
    expect(RENDER_HISTORY_INVALIDATION_REASONS).toHaveLength(9);
    history.dispose();
  });

  it("does not consult mutable Array or Set prototype routing after invalidation input", () => {
    const history = new TemporalHistoryOwner();
    history.initialize({ width: 640, height: 360, pixelRatio: 1 });
    history.beginFrame();
    history.completeFrame(true);
    const includesDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "includes")!;
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(Set.prototype, Symbol.iterator)!;
    const sizeDescriptor = Object.getOwnPropertyDescriptor(Set.prototype, "size")!;
    let includesCalls = 0;
    let iteratorCalls = 0;
    let sizeCalls = 0;
    let invalidated = false;
    let frame: ReturnType<TemporalHistoryOwner["beginFrame"]> | null = null;
    let snapshot: ReturnType<TemporalHistoryOwner["snapshot"]> | null = null;
    Object.defineProperty(Array.prototype, "includes", {
      configurable: true,
      value: () => {
        includesCalls += 1;
        return false;
      },
      writable: true,
    });
    Object.defineProperty(Set.prototype, Symbol.iterator, {
      configurable: true,
      value: () => {
        iteratorCalls += 1;
        return { next: () => ({ done: true as const, value: undefined }) };
      },
      writable: true,
    });
    Object.defineProperty(Set.prototype, "size", {
      configurable: true,
      get: () => {
        sizeCalls += 1;
        return 0;
      },
    });
    try {
      invalidated = history.invalidate("camera-discontinuity");
      frame = history.beginFrame();
      history.completeFrame(true);
      snapshot = history.snapshot();
    } finally {
      Object.defineProperty(Array.prototype, "includes", includesDescriptor);
      Object.defineProperty(Set.prototype, Symbol.iterator, iteratorDescriptor);
      Object.defineProperty(Set.prototype, "size", sizeDescriptor);
    }
    expect(invalidated).toBe(true);
    expect(includesCalls).toBe(0);
    expect(iteratorCalls).toBe(0);
    expect(sizeCalls).toBe(0);
    expect(frame).toMatchObject({
      blendWeight: 0,
      resetReasons: ["camera-discontinuity"],
    });
    expect(snapshot).toMatchObject({
      valid: true,
      generation: 2,
      pendingReasons: [],
      resetCounts: { "camera-discontinuity": 1 },
    });
    history.dispose();
  });
});
