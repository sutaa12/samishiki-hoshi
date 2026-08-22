export const TOUCH_STEER_ZONE_RATIO = 0.7;
export const TAP_MAX_DISTANCE_PX = 14;
export const TAP_MAX_DURATION_MS = 350;

export type SupportedPointerType = "mouse" | "touch" | "pen";
export type PointerGestureRole = "pending-click" | "steer" | "pulse-candidate";

export type PointerGestureSample = Readonly<{
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  buttons: number;
  timeStamp: number;
  viewportWidth: number;
  viewportHeight: number;
}>;

export type PointerGesture = Readonly<{
  pointerId: number;
  pointerType: SupportedPointerType;
  role: PointerGestureRole;
  startX: number;
  startY: number;
  startTime: number;
  currentX: number;
  currentY: number;
  maximumDistancePx: number;
  cancelled: boolean;
}>;

export type PointerGestureResult = Readonly<{
  gesture: PointerGesture;
  steer: boolean;
  pulse: boolean;
}>;

function supportedPointerType(value: string): SupportedPointerType {
  if (value === "touch" || value === "pen") return value;
  return "mouse";
}

function distanceFromStart(gesture: PointerGesture, sample: PointerGestureSample): number {
  return Math.hypot(sample.clientX - gesture.startX, sample.clientY - gesture.startY);
}

export function beginPointerGesture(sample: PointerGestureSample): PointerGestureResult {
  const pointerType = supportedPointerType(sample.pointerType);
  const touchStartsInSteerZone = pointerType === "touch"
    && sample.clientX < sample.viewportWidth * TOUCH_STEER_ZONE_RATIO;
  const role: PointerGestureRole = pointerType === "touch"
    ? touchStartsInSteerZone ? "steer" : "pulse-candidate"
    : "pending-click";
  const gesture: PointerGesture = Object.freeze({
    pointerId: sample.pointerId,
    pointerType,
    role,
    startX: sample.clientX,
    startY: sample.clientY,
    startTime: sample.timeStamp,
    currentX: sample.clientX,
    currentY: sample.clientY,
    maximumDistancePx: 0,
    cancelled: false,
  });
  return Object.freeze({ gesture, steer: role === "steer", pulse: false });
}

export function updatePointerGesture(
  gesture: PointerGesture,
  sample: PointerGestureSample,
): PointerGestureResult {
  if (gesture.pointerId !== sample.pointerId || gesture.cancelled) {
    return Object.freeze({ gesture, steer: false, pulse: false });
  }

  const maximumDistancePx = Math.max(
    gesture.maximumDistancePx,
    distanceFromStart(gesture, sample),
  );
  let role = gesture.role;
  let cancelled: boolean = gesture.cancelled;
  if (role === "pending-click" && maximumDistancePx > TAP_MAX_DISTANCE_PX) {
    role = "steer";
  } else if (role === "pulse-candidate" && maximumDistancePx > TAP_MAX_DISTANCE_PX) {
    cancelled = true;
  }
  const next = Object.freeze({
    ...gesture,
    role,
    currentX: sample.clientX,
    currentY: sample.clientY,
    maximumDistancePx,
    cancelled,
  });
  return Object.freeze({ gesture: next, steer: role === "steer" && !cancelled, pulse: false });
}

export function endPointerGesture(
  gesture: PointerGesture,
  sample: PointerGestureSample,
): PointerGestureResult {
  const updated = updatePointerGesture(gesture, sample);
  const elapsedMs = Math.max(0, sample.timeStamp - gesture.startTime);
  const isTap = !updated.gesture.cancelled
    && updated.gesture.maximumDistancePx <= TAP_MAX_DISTANCE_PX
    && elapsedMs <= TAP_MAX_DURATION_MS;
  const pulse = isTap
    && (updated.gesture.role === "pending-click" || updated.gesture.role === "pulse-candidate");
  return Object.freeze({ gesture: updated.gesture, steer: false, pulse });
}

export function normalizePointerTarget(sample: PointerGestureSample): Readonly<{ x: number; y: number }> {
  const width = Math.max(1, sample.viewportWidth);
  const height = Math.max(1, sample.viewportHeight);
  return Object.freeze({
    x: Math.max(-0.94, Math.min(0.94, (sample.clientX / width) * 1.88 - 0.94)),
    y: Math.max(-0.94, Math.min(0.94, 0.94 - (sample.clientY / height) * 1.88)),
  });
}
