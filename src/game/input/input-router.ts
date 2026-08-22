import {
  beginPointerGesture,
  endPointerGesture,
  normalizePointerTarget,
  updatePointerGesture,
  type PointerGesture,
  type PointerGestureSample,
} from "./pointer-gesture";

const STEER_KEYS = Object.freeze([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
]);

export type InputRouterStatus = Readonly<{
  heldKeyCount: number;
  pointerActive: boolean;
  activePointerId: number | null;
  pendingPulse: boolean;
}>;

export type InputRouteResult = Readonly<{
  handled: boolean;
  steerIntent: boolean;
  pulseEdge: boolean;
  capturePointer: boolean;
}>;

export type InputFrame = Readonly<{
  moveX: number;
  moveY: number;
  pointer: Readonly<{ x: number; y: number; active: boolean }>;
  pulse: boolean;
}>;

const IGNORED_RESULT: InputRouteResult = Object.freeze({
  handled: false,
  steerIntent: false,
  pulseEdge: false,
  capturePointer: false,
});

export class InputRouter {
  readonly #keys = new Set<string>();
  #gesture: PointerGesture | null = null;
  #pointer = { x: 0, y: -0.72, active: false };
  #pendingPulseEdges = 0;

  keyDown(code: string, repeat: boolean): InputRouteResult {
    if (code === "Space") {
      const pulseEdge = !repeat;
      if (pulseEdge) this.#pendingPulseEdges += 1;
      return Object.freeze({
        handled: true,
        steerIntent: false,
        pulseEdge,
        capturePointer: false,
      });
    }
    if (!STEER_KEYS.includes(code)) return IGNORED_RESULT;
    this.#keys.add(code);
    return Object.freeze({
      handled: true,
      steerIntent: true,
      pulseEdge: false,
      capturePointer: false,
    });
  }

  keyUp(code: string): boolean {
    return this.#keys.delete(code);
  }

  pointerDown(sample: PointerGestureSample): InputRouteResult {
    if (this.#gesture !== null) return IGNORED_RESULT;
    const result = beginPointerGesture(sample);
    this.#gesture = result.gesture;
    const target = normalizePointerTarget(sample);
    this.#pointer = { ...target, active: result.steer };
    return Object.freeze({
      handled: true,
      steerIntent: result.steer,
      pulseEdge: false,
      capturePointer: true,
    });
  }

  pointerMove(sample: PointerGestureSample): InputRouteResult {
    if (this.#gesture === null) {
      if (sample.pointerType !== "mouse" || sample.buttons !== 0) return IGNORED_RESULT;
      const target = normalizePointerTarget(sample);
      this.#pointer = { ...target, active: true };
      return Object.freeze({
        handled: true,
        steerIntent: true,
        pulseEdge: false,
        capturePointer: false,
      });
    }
    if (this.#gesture.pointerId !== sample.pointerId) return IGNORED_RESULT;
    const result = updatePointerGesture(this.#gesture, sample);
    this.#gesture = result.gesture;
    const target = normalizePointerTarget(sample);
    this.#pointer = { ...target, active: result.steer };
    return Object.freeze({
      handled: true,
      steerIntent: result.steer,
      pulseEdge: false,
      capturePointer: false,
    });
  }

  pointerUp(sample: PointerGestureSample): InputRouteResult {
    if (this.#gesture === null || this.#gesture.pointerId !== sample.pointerId) {
      return IGNORED_RESULT;
    }
    const result = endPointerGesture(this.#gesture, sample);
    this.#gesture = null;
    if (result.pulse) this.#pendingPulseEdges += 1;
    const target = normalizePointerTarget(sample);
    this.#pointer = {
      ...target,
      active: sample.pointerType === "mouse",
    };
    return Object.freeze({
      handled: true,
      steerIntent: false,
      pulseEdge: result.pulse,
      capturePointer: false,
    });
  }

  pointerCancel(pointerId?: number): boolean {
    if (this.#gesture === null) return false;
    if (pointerId !== undefined && this.#gesture.pointerId !== pointerId) return false;
    this.#gesture = null;
    this.#pointer.active = false;
    return true;
  }

  reset(): void {
    this.#keys.clear();
    this.#gesture = null;
    this.#pointer = { x: 0, y: -0.72, active: false };
    this.#pendingPulseEdges = 0;
  }

  consumeFrame(): InputFrame {
    const moveX = Number(this.#keys.has("ArrowRight") || this.#keys.has("KeyD"))
      - Number(this.#keys.has("ArrowLeft") || this.#keys.has("KeyA"));
    const moveY = Number(this.#keys.has("ArrowUp") || this.#keys.has("KeyW"))
      - Number(this.#keys.has("ArrowDown") || this.#keys.has("KeyS"));
    const pulse = this.#pendingPulseEdges > 0;
    if (pulse) this.#pendingPulseEdges -= 1;
    return Object.freeze({ moveX, moveY, pointer: Object.freeze({ ...this.#pointer }), pulse });
  }

  status(): InputRouterStatus {
    return Object.freeze({
      heldKeyCount: this.#keys.size,
      pointerActive: this.#pointer.active,
      activePointerId: this.#gesture?.pointerId ?? null,
      pendingPulse: this.#pendingPulseEdges > 0,
    });
  }
}
