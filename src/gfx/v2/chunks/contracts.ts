import type {
  MaybePromise,
  RenderLogicalResourceOwnership,
  RenderOperationClock,
  RenderQualityProfile,
  VisualClock,
} from "../contracts";
import type {
  StoryChunkId,
  WorldMaterialFamily,
  WorldPlan,
} from "../../../world/v2/contracts";

export const CHUNK_WORKER_PROTOCOL_VERSION = "lonely-star-chunk-worker/v1" as const;
export const CHUNK_PAYLOAD_SCHEMA_VERSION = "lonely-star-generated-chunk/v1" as const;
export const CHUNK_PAYLOAD_GENERATOR_VERSION = "gfx004-chunk-payload-v1" as const;

export const CHUNK_UPLOAD_TARGET_MS = 1;
export const CHUNK_UPLOAD_WARNING_MS = 2;
export const CHUNK_UPLOAD_HARD_CAP_MS = 4;
export const DEFAULT_CHUNK_UPLOAD_BUDGET_MS = 4;

export const MAX_CHUNK_PLAN_BYTES = 8 * 1024 * 1024;
export const MAX_CHUNK_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_CHUNK_PAYLOAD_BUFFERS = 32;
export const MAX_CHUNK_PENDING_UPLOADS = 64;
export const MAX_CHUNK_WORKER_INBOX = 64;
export const MAX_CHUNK_TELEMETRY_EVENTS = 256;
export const MAX_CHUNK_GENERATION_CONCURRENCY = 2;

export const CHUNK_PAYLOAD_STREAMS = Object.freeze([
  "flow",
  "terrain",
  "water",
  "flora",
  "ecology",
  "atmosphere",
  "space",
] as const);

export type ChunkPayloadStream = (typeof CHUNK_PAYLOAD_STREAMS)[number];
export const CHUNK_PAYLOAD_VALUES_PER_STREAM = 32;

export type ChunkLifecycleState =
  | "absent"
  | "queued"
  | "generating"
  | "generated"
  | "uploading"
  | "active"
  | "retiring"
  | "disposed"
  | "failed";

export type ChunkWindowRole = "behind" | "current" | "ahead-1" | "ahead-2";
export type ChunkUpdateMode = "live" | "frozen";

/** Page-11 phases represented without widening the accepted public lifecycle. */
export type ChunkLifecycleSubphase =
  | "none"
  | "planned"
  | "worker"
  | "validating"
  | "gpu-upload-pending"
  | "placeholder";

export interface ChunkGenerationToken {
  readonly protocolVersion: typeof CHUNK_WORKER_PROTOCOL_VERSION;
  readonly payloadVersion: typeof CHUNK_PAYLOAD_GENERATOR_VERSION;
  readonly planDigest: string;
  readonly chunkId: StoryChunkId;
  readonly epoch: number;
  readonly requestId: number;
}

export interface ChunkPayloadBuffer {
  readonly name: ChunkPayloadStream;
  readonly elementType: "uint32";
  readonly elementCount: number;
  readonly byteLength: number;
  readonly buffer: ArrayBuffer;
}

export interface GeneratedChunkManifest {
  readonly sourcePlanSchema: "lonely-star-world-plan/v1";
  readonly sourceGeneratorVersion: string;
  readonly materialFamilies: readonly WorldMaterialFamily[];
  readonly bufferCount: number;
  readonly sampleCount: number;
  readonly byteLength: number;
}

/**
 * Renderer-neutral worker output. Buffers are canonical procedural samples,
 * not Three.js geometry and not a quality/backend realization.
 */
export interface GeneratedChunkPayload {
  readonly schemaVersion: typeof CHUNK_PAYLOAD_SCHEMA_VERSION;
  readonly generatorVersion: typeof CHUNK_PAYLOAD_GENERATOR_VERSION;
  readonly planDigest: string;
  readonly chunkId: StoryChunkId;
  readonly contentDigest: string;
  readonly manifest: Readonly<GeneratedChunkManifest>;
  readonly buffers: readonly Readonly<ChunkPayloadBuffer>[];
}

export const CHUNK_ISSUE_CODES = Object.freeze([
  "INVALID_STRUCTURE",
  "UNEXPECTED_PROPERTY",
  "PROTOCOL_MISMATCH",
  "PLAN_INVALID",
  "PLAN_DIGEST_MISMATCH",
  "TOKEN_INVALID",
  "TOKEN_MISMATCH",
  "PAYLOAD_SCHEMA_MISMATCH",
  "PAYLOAD_BOUNDS",
  "PAYLOAD_BUFFER_INVALID",
  "PAYLOAD_DIGEST_MISMATCH",
  "WORKER_NOT_READY",
  "WORKER_INBOX_FULL",
  "GENERATION_CANCELLED",
  "GENERATION_FAILED",
  "STALE_REPLY",
  "INVALID_TRANSITION",
  "UPLOAD_QUEUE_FULL",
  "UPLOAD_JOB_INVALID",
  "UPLOAD_FAILED",
  "UPLOAD_SLICE_WARNING",
  "UPLOAD_HARD_CAP_EXCEEDED",
  "RESOURCE_RELEASE_FAILED",
  "DISPOSED",
] as const);

export type ChunkIssueCode = (typeof CHUNK_ISSUE_CODES)[number];

export interface ChunkIssue {
  readonly code: ChunkIssueCode;
  readonly path: string;
  readonly detail: string;
  readonly chunkId?: StoryChunkId;
}

export interface ChunkValidationReport<T = never> {
  readonly valid: boolean;
  readonly issues: readonly Readonly<ChunkIssue>[];
  readonly value?: T;
}

export type ChunkWorkerInstallRequest = Readonly<{
  kind: "install";
  protocolVersion: typeof CHUNK_WORKER_PROTOCOL_VERSION;
  planDigest: string;
  byteLength: number;
  planBytes: ArrayBuffer;
}>;

export type ChunkWorkerGenerateRequest = Readonly<{
  kind: "generate";
  protocolVersion: typeof CHUNK_WORKER_PROTOCOL_VERSION;
  token: Readonly<ChunkGenerationToken>;
}>;

export type ChunkWorkerCancelRequest = Readonly<{
  kind: "cancel";
  protocolVersion: typeof CHUNK_WORKER_PROTOCOL_VERSION;
  token: Readonly<ChunkGenerationToken>;
}>;

export type ChunkWorkerRequest =
  | ChunkWorkerInstallRequest
  | ChunkWorkerGenerateRequest
  | ChunkWorkerCancelRequest;

export type ChunkWorkerReadyReply = Readonly<{
  kind: "ready";
  protocolVersion: typeof CHUNK_WORKER_PROTOCOL_VERSION;
  planDigest: string;
}>;

export type ChunkWorkerGeneratedReply = Readonly<{
  kind: "generated";
  protocolVersion: typeof CHUNK_WORKER_PROTOCOL_VERSION;
  token: Readonly<ChunkGenerationToken>;
  payload: Readonly<GeneratedChunkPayload>;
}>;

export type ChunkWorkerFailedReply = Readonly<{
  kind: "failed";
  protocolVersion: typeof CHUNK_WORKER_PROTOCOL_VERSION;
  token: Readonly<ChunkGenerationToken> | null;
  issue: Readonly<ChunkIssue>;
}>;

export type ChunkWorkerReply =
  | ChunkWorkerReadyReply
  | ChunkWorkerGeneratedReply
  | ChunkWorkerFailedReply;

export interface ChunkWorkerMessageEvent {
  readonly data: unknown;
}

export interface ChunkWorkerPort {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: ChunkWorkerMessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: ChunkWorkerMessageEvent) => void,
  ): void;
  terminate?(): void;
}

export interface OwnedWorldPlanSnapshot {
  readonly plan: Readonly<WorldPlan>;
  readonly digest: string;
}

export interface ChunkWorkerClientLike {
  initialize(plan: Readonly<WorldPlan>): Promise<Readonly<OwnedWorldPlanSnapshot>>;
  generate(token: Readonly<ChunkGenerationToken>): void;
  cancel(token: Readonly<ChunkGenerationToken>): void;
  drainReplies(): readonly Readonly<ChunkWorkerGeneratedReply | ChunkWorkerFailedReply>[];
  pendingReplyCount(): number;
  dispose(): Promise<void>;
}

export type ChunkUploadStepResult =
  | Readonly<{ kind: "pending"; uploadedBytes: number }>
  | Readonly<{ kind: "complete"; uploadedBytes: number; lease: ChunkGpuLease }>;

export interface ChunkGpuLease {
  readonly ownerId: string;
  readonly ownership: Readonly<RenderLogicalResourceOwnership>;
  /** Switches prebuilt renderer variants without regenerating canonical data. */
  quality?(profile: Readonly<RenderQualityProfile>): void;
  /** Controls membership in the persistent world scene; new leases begin inactive. */
  setActive?(active: boolean): void;
  dispose(): MaybePromise<void>;
}

export interface ChunkUploadJob {
  readonly id: string;
  readonly ownerId: string;
  readonly token: Readonly<ChunkGenerationToken>;
  readonly byteLength: number;
  /** A declared upper bound; jobs over one millisecond are not admitted. */
  readonly maximumSliceMs: number;
  runSlice(clock: VisualClock): Readonly<ChunkUploadStepResult>;
  cancel(): MaybePromise<void>;
}

export type ChunkUploadResult =
  | Readonly<{ kind: "complete"; jobId: string; ownerId: string; lease: ChunkGpuLease }>
  | Readonly<{ kind: "cancelled"; jobId: string; ownerId: string }>
  | Readonly<{ kind: "failed"; jobId: string; ownerId: string; issue: Readonly<ChunkIssue> }>;

export interface ChunkUploadTicket {
  readonly id: string;
  readonly ownerId: string;
  readonly result: Promise<Readonly<ChunkUploadResult>>;
}

export interface ChunkUploadQueueSnapshot {
  readonly initialized: boolean;
  readonly disposed: boolean;
  readonly pending: number;
  readonly activeJobId: string | null;
  readonly completed: number;
  readonly cancelled: number;
  readonly failed: number;
  readonly totalUploadedBytes: number;
  readonly orphanLeaseCount: number;
  readonly orphanJobCount: number;
  readonly orphanOwnerIds: readonly string[];
  readonly cleanupFailureCount: number;
  readonly events: readonly Readonly<ChunkRuntimeEvent>[];
}

export interface ChunkUploadQueueLike {
  enqueue(job: Readonly<ChunkUploadJob>): Readonly<ChunkUploadTicket>;
  cancelOwner(ownerId: string): Promise<void>;
  snapshot(): Readonly<ChunkUploadQueueSnapshot>;
  pendingCount(): number;
}

export interface ChunkUploader {
  createUploadJob(
    payload: Readonly<GeneratedChunkPayload>,
    token: Readonly<ChunkGenerationToken>,
  ): Readonly<ChunkUploadJob>;
}

export interface ChunkRuntimeEvent {
  readonly sequence: number;
  readonly kind:
    | "state"
    | "worker"
    | "upload"
    | "resource"
    | "placeholder"
    | "issue";
  readonly name: string;
  readonly chunkId: StoryChunkId | null;
  readonly requestId: number | null;
  readonly frame: number | null;
  readonly value: number | string | boolean | null;
}

export interface ChunkLifecycleSnapshot {
  readonly chunkId: StoryChunkId;
  readonly state: ChunkLifecycleState;
  readonly role: ChunkWindowRole | null;
  readonly updateMode: ChunkUpdateMode;
  readonly subphase: ChunkLifecycleSubphase;
  readonly epoch: number;
  readonly requestId: number | null;
  readonly gpuSlotOwned: boolean;
  readonly placeholder: boolean;
  readonly issue: Readonly<ChunkIssue> | null;
}

export interface ChunkRuntimeSnapshot {
  readonly initialized: boolean;
  readonly disposed: boolean;
  readonly planDigest: string | null;
  readonly focusChunkId: StoryChunkId | null;
  readonly desiredChunkIds: readonly StoryChunkId[];
  readonly activeChunkIds: readonly StoryChunkId[];
  readonly placeholderChunkIds: readonly StoryChunkId[];
  readonly gpuOwnedCount: number;
  readonly generatingCount: number;
  readonly workerInboxCount: number;
  readonly uploadQueue: Readonly<ChunkUploadQueueSnapshot>;
  readonly chunks: readonly Readonly<ChunkLifecycleSnapshot>[];
  readonly events: readonly Readonly<ChunkRuntimeEvent>[];
}

export interface ChunkManagerLike {
  initialize(): Promise<void>;
  setFocus(chunkId: StoryChunkId): void;
  update(clock: RenderOperationClock): void;
  quality(profile: Readonly<RenderQualityProfile>): void;
  snapshot(): Readonly<ChunkRuntimeSnapshot>;
  dispose(): Promise<void>;
}
