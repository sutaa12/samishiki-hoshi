import type { StoryChunkId } from "../../../world/v2/contracts";
import type {
  ChunkIssue,
  ChunkLifecycleSnapshot,
  ChunkLifecycleState,
  ChunkLifecycleSubphase,
  ChunkWindowRole,
} from "./contracts";

function states(...values: ChunkLifecycleState[]): readonly ChunkLifecycleState[] {
  return Object.freeze(values);
}

const TRANSITIONS: Readonly<Record<ChunkLifecycleState, readonly ChunkLifecycleState[]>> = Object.freeze({
  absent: states("queued"),
  queued: states("generating", "retiring", "failed"),
  generating: states("generated", "retiring", "failed"),
  generated: states("uploading", "retiring", "failed"),
  uploading: states("active", "retiring", "failed"),
  active: states("retiring", "failed"),
  retiring: states("disposed", "failed"),
  disposed: states(),
  failed: states(),
});

export function isChunkTransitionAllowed(
  from: ChunkLifecycleState,
  to: ChunkLifecycleState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

function frozenIssue(
  code: ChunkIssue["code"],
  detail: string,
  chunkId: StoryChunkId,
): Readonly<ChunkIssue> {
  return Object.freeze({ code, path: `$.chunks.${chunkId}.state`, detail, chunkId });
}

export function createAbsentChunkSnapshot(chunkId: StoryChunkId): Readonly<ChunkLifecycleSnapshot> {
  return Object.freeze({
    chunkId,
    state: "absent",
    role: null,
    updateMode: "live",
    subphase: "none",
    epoch: 0,
    requestId: null,
    gpuSlotOwned: false,
    placeholder: false,
    issue: null,
  });
}

export interface ChunkTransitionPatch {
  readonly role?: ChunkWindowRole | null;
  readonly subphase?: ChunkLifecycleSubphase;
  readonly epoch?: number;
  readonly requestId?: number | null;
  readonly gpuSlotOwned?: boolean;
  readonly placeholder?: boolean;
  readonly issue?: Readonly<ChunkIssue> | null;
}

function assertCounter(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
}

export function transitionChunkSnapshot(
  current: Readonly<ChunkLifecycleSnapshot>,
  nextState: ChunkLifecycleState,
  patch: Readonly<ChunkTransitionPatch> = {},
): Readonly<ChunkLifecycleSnapshot> {
  if (!isChunkTransitionAllowed(current.state, nextState)) {
    throw Object.assign(
      new Error(`Invalid chunk transition ${current.state} -> ${nextState} for ${current.chunkId}.`),
      { issue: frozenIssue(
        "INVALID_TRANSITION",
        `Transition ${current.state} -> ${nextState} is not allowed.`,
        current.chunkId,
      ) },
    );
  }

  const epoch = patch.epoch ?? current.epoch;
  const requestId = patch.requestId === undefined ? current.requestId : patch.requestId;
  assertCounter(epoch, "Chunk epoch");
  if (requestId !== null) assertCounter(requestId, "Chunk requestId");
  const role = patch.role === undefined ? current.role : patch.role;
  const subphase = patch.subphase ?? current.subphase;
  const gpuSlotOwned = patch.gpuSlotOwned ?? current.gpuSlotOwned;
  const placeholder = patch.placeholder ?? current.placeholder;
  const issue = patch.issue === undefined ? current.issue : patch.issue;

  if (nextState === "active" && !gpuSlotOwned) {
    throw new Error(`Active chunk ${current.chunkId} must own a GPU slot.`);
  }
  if ((nextState === "disposed" || nextState === "failed") && gpuSlotOwned) {
    throw new Error(`Terminal chunk ${current.chunkId} cannot retain a GPU slot.`);
  }

  return Object.freeze({
    chunkId: current.chunkId,
    state: nextState,
    role,
    updateMode: role === "behind" ? "frozen" : "live",
    subphase,
    epoch,
    requestId,
    gpuSlotOwned,
    placeholder,
    issue: issue ? Object.freeze({ ...issue }) : null,
  });
}

export function updateChunkWindowRole(
  current: Readonly<ChunkLifecycleSnapshot>,
  role: ChunkWindowRole | null,
): Readonly<ChunkLifecycleSnapshot> {
  return Object.freeze({
    ...current,
    role,
    updateMode: role === "behind" ? "frozen" : "live",
  });
}

export function failChunkSnapshot(
  current: Readonly<ChunkLifecycleSnapshot>,
  issue: Readonly<ChunkIssue>,
  placeholder: boolean,
): Readonly<ChunkLifecycleSnapshot> {
  return transitionChunkSnapshot(current, "failed", {
    subphase: placeholder ? "placeholder" : current.subphase,
    gpuSlotOwned: false,
    placeholder,
    issue,
  });
}
