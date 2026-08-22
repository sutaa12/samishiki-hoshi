import type { RenderHostLifecycle } from "./contracts";

const renderHostCauses = new WeakMap<RenderHostError, unknown>();
const renderHostErrorOwners = new WeakMap<RenderHostError, object>();

export type RenderHostErrorCode =
  | "INVALID_LIFECYCLE"
  | "INITIALIZATION_FAILED"
  | "FRAME_FAILED"
  | "BACKEND_RUNTIME_FAILED"
  | "DISPOSAL_FAILED";

export class RenderHostError extends Error {
  readonly code: RenderHostErrorCode;
  readonly lifecycle: RenderHostLifecycle;
  override get cause(): unknown {
    return renderHostCauses.get(this);
  }

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
    renderHostCauses.set(this, cause);
    Object.freeze(this);
  }
}

export function lifecycleError(
  operation: string,
  lifecycle: RenderHostLifecycle,
  owner?: object,
): RenderHostError {
  const error = new RenderHostError(
    "INVALID_LIFECYCLE",
    `Cannot ${operation} while RenderHost is ${lifecycle}.`,
    lifecycle,
  );
  if (owner) renderHostErrorOwners.set(error, owner);
  return error;
}

export function hostError(
  code: Exclude<RenderHostErrorCode, "INVALID_LIFECYCLE">,
  message: string,
  lifecycle: RenderHostLifecycle,
  cause: unknown,
  owner?: object,
): RenderHostError {
  try {
    if (
      owner
      && cause instanceof RenderHostError
      && renderHostErrorOwners.get(cause) === owner
    ) {
      return cause;
    }
  } catch {
    // Unknown rejection values may be Proxies with hostile prototype traps.
  }
  const error = new RenderHostError(code, message, lifecycle, cause);
  if (owner) renderHostErrorOwners.set(error, owner);
  return error;
}

/** @internal Reads the module-owned cause without invoking caller-overridable accessors. */
export function renderHostErrorCause(error: RenderHostError): unknown {
  return renderHostCauses.get(error);
}

/** @internal Replaces finalized evidence without changing public error identity. */
export function replaceRenderHostErrorCause(
  error: RenderHostError,
  cause: unknown,
  owner: object,
): RenderHostError {
  if (renderHostErrorOwners.get(error) !== owner) return error;
  renderHostCauses.set(error, cause);
  return error;
}

/** @internal Creates immutable Host-owned aggregate evidence. */
export function immutableRenderHostAggregate(
  errors: readonly unknown[],
  message?: string,
): AggregateError {
  const aggregate = new AggregateError([...errors], message);
  Object.freeze(aggregate.errors);
  Object.freeze(aggregate);
  return aggregate;
}

/** @internal Preserves a Host-owned terminal error identity while cleanup finishes. */
export function attachRenderHostCleanupFailures(
  error: RenderHostError,
  failures: readonly unknown[],
  owner: object,
): RenderHostError {
  if (
    failures.length === 0
    || renderHostErrorOwners.get(error) !== owner
  ) return error;
  const aggregate = immutableRenderHostAggregate(
    [renderHostCauses.get(error), ...failures],
    "RenderHost failure cleanup also failed.",
  );
  renderHostCauses.set(error, aggregate);
  return error;
}
