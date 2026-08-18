import type { RenderHostLifecycle } from "./contracts";

export type RenderHostErrorCode =
  | "INVALID_LIFECYCLE"
  | "INITIALIZATION_FAILED"
  | "FRAME_FAILED"
  | "BACKEND_RUNTIME_FAILED"
  | "DISPOSAL_FAILED";

export class RenderHostError extends Error {
  readonly code: RenderHostErrorCode;
  readonly lifecycle: RenderHostLifecycle;
  override readonly cause: unknown;

  constructor(
    code: RenderHostErrorCode,
    message: string,
    lifecycle: RenderHostLifecycle,
    cause?: unknown,
  ) {
    super(message);
    this.name = "RenderHostError";
    this.code = code;
    this.lifecycle = lifecycle;
    this.cause = cause;
  }
}

export function lifecycleError(
  operation: string,
  lifecycle: RenderHostLifecycle,
): RenderHostError {
  return new RenderHostError(
    "INVALID_LIFECYCLE",
    `Cannot ${operation} while RenderHost is ${lifecycle}.`,
    lifecycle,
  );
}

export function hostError(
  code: Exclude<RenderHostErrorCode, "INVALID_LIFECYCLE">,
  message: string,
  lifecycle: RenderHostLifecycle,
  cause: unknown,
): RenderHostError {
  return cause instanceof RenderHostError
    ? cause
    : new RenderHostError(code, message, lifecycle, cause);
}
