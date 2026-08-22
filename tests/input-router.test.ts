import { describe, expect, it } from "vitest";
import { InputRouter } from "../src/game/input/input-router";
import type { PointerGestureSample } from "../src/game/input/pointer-gesture";

function pointer(overrides: Partial<PointerGestureSample> = {}): PointerGestureSample {
  return {
    pointerId: 1,
    pointerType: "touch",
    clientX: 100,
    clientY: 400,
    buttons: 1,
    timeStamp: 1_000,
    viewportWidth: 1_000,
    viewportHeight: 800,
    ...overrides,
  };
}

describe("QX-R3-003 InputRouter", () => {
  it("maps WASD and arrows to held steer input and clears them on keyup", () => {
    const router = new InputRouter();
    expect(router.keyDown("KeyD", false)).toMatchObject({ handled: true, steerIntent: true });
    expect(router.keyDown("ArrowUp", false)).toMatchObject({ handled: true, steerIntent: true });
    expect(router.consumeFrame()).toMatchObject({ moveX: 1, moveY: 1, pulse: false });
    expect(router.status().heldKeyCount).toBe(2);
    router.keyUp("KeyD");
    router.keyUp("ArrowUp");
    expect(router.consumeFrame()).toMatchObject({ moveX: 0, moveY: 0 });
  });

  it("creates one Space pulse edge and ignores repeat", () => {
    const router = new InputRouter();
    expect(router.keyDown("Space", false).pulseEdge).toBe(true);
    expect(router.keyDown("Space", true).pulseEdge).toBe(false);
    expect(router.consumeFrame().pulse).toBe(true);
    expect(router.consumeFrame().pulse).toBe(false);
  });

  it("queues distinct Pulse edges instead of coalescing them before a frame", () => {
    const router = new InputRouter();
    router.keyDown("Space", false);
    router.keyUp("Space");
    router.keyDown("Space", false);
    router.keyUp("Space");

    expect(router.consumeFrame().pulse).toBe(true);
    expect(router.status().pendingPulse).toBe(true);
    expect(router.consumeFrame().pulse).toBe(true);
    expect(router.status().pendingPulse).toBe(false);
    expect(router.consumeFrame().pulse).toBe(false);
  });

  it("routes a left-zone touch drag only to steer and never to pulse", () => {
    const router = new InputRouter();
    expect(router.pointerDown(pointer()).steerIntent).toBe(true);
    expect(router.pointerMove(pointer({ clientX: 220, timeStamp: 1_080 })).steerIntent).toBe(true);
    expect(router.consumeFrame().pointer.active).toBe(true);
    expect(router.pointerUp(pointer({ clientX: 230, buttons: 0, timeStamp: 1_120 })).pulseEdge).toBe(false);
    expect(router.consumeFrame()).toMatchObject({ pulse: false, pointer: { active: false } });
  });

  it("routes a right-zone touch tap to exactly one pulse and never to steer", () => {
    const router = new InputRouter();
    expect(router.pointerDown(pointer({ clientX: 850 })).steerIntent).toBe(false);
    expect(router.pointerUp(pointer({ clientX: 854, buttons: 0, timeStamp: 1_120 })).pulseEdge).toBe(true);
    expect(router.consumeFrame().pulse).toBe(true);
    expect(router.consumeFrame().pulse).toBe(false);
  });

  it("cancels a right-zone drag instead of rerouting its pointer ID to steer", () => {
    const router = new InputRouter();
    router.pointerDown(pointer({ clientX: 850, pointerId: 7 }));
    expect(router.pointerMove(pointer({ clientX: 700, pointerId: 7, timeStamp: 1_080 })).steerIntent).toBe(false);
    expect(router.pointerUp(pointer({ clientX: 700, pointerId: 7, buttons: 0, timeStamp: 1_100 })).pulseEdge).toBe(false);
    expect(router.consumeFrame()).toMatchObject({ pulse: false, pointer: { active: false } });
  });

  it("separates a mouse click from a mouse drag", () => {
    const clickRouter = new InputRouter();
    clickRouter.pointerDown(pointer({ pointerType: "mouse", clientX: 500 }));
    expect(clickRouter.pointerUp(pointer({ pointerType: "mouse", clientX: 505, buttons: 0, timeStamp: 1_100 })).pulseEdge).toBe(true);
    expect(clickRouter.consumeFrame()).toMatchObject({ pulse: true, pointer: { active: true } });

    const dragRouter = new InputRouter();
    expect(dragRouter.pointerDown(pointer({ pointerType: "mouse", clientX: 500 })).steerIntent).toBe(false);
    expect(dragRouter.pointerMove(pointer({ pointerType: "mouse", clientX: 560, timeStamp: 1_050 })).steerIntent).toBe(true);
    expect(dragRouter.pointerUp(pointer({ pointerType: "mouse", clientX: 600, buttons: 0, timeStamp: 1_100 })).pulseEdge).toBe(false);
    expect(dragRouter.consumeFrame().pulse).toBe(false);
  });

  it("ignores secondary pointers and clears every held route on cancel or reset", () => {
    const router = new InputRouter();
    router.keyDown("KeyA", false);
    router.pointerDown(pointer({ pointerId: 10 }));
    expect(router.pointerDown(pointer({ pointerId: 11, clientX: 850 })).handled).toBe(false);
    expect(router.pointerUp(pointer({ pointerId: 11, clientX: 850, buttons: 0 })).handled).toBe(false);
    expect(router.pointerCancel(10)).toBe(true);
    expect(router.status()).toMatchObject({ pointerActive: false, activePointerId: null, heldKeyCount: 1 });
    router.keyDown("Space", false);
    router.reset();
    expect(router.status()).toEqual({
      heldKeyCount: 0,
      pointerActive: false,
      activePointerId: null,
      pendingPulse: false,
    });
    expect(router.consumeFrame()).toMatchObject({ moveX: 0, moveY: 0, pulse: false });
  });
});
