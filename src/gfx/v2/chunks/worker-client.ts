import { canonicalWorldPlanBytes } from "../../../world/v2/canonical";
import type { WorldPlan } from "../../../world/v2/contracts";
import {
  CHUNK_PAYLOAD_GENERATOR_VERSION,
  CHUNK_WORKER_PROTOCOL_VERSION,
  MAX_CHUNK_WORKER_INBOX,
  type ChunkGenerationToken,
  type ChunkWorkerClientLike,
  type ChunkWorkerFailedReply,
  type ChunkWorkerGeneratedReply,
  type ChunkWorkerMessageEvent,
  type ChunkWorkerPort,
  type GeneratedChunkPayload,
  type OwnedWorldPlanSnapshot,
} from "./contracts";
import {
  captureOwnedWorldPlan,
  makeWorkerFailure,
  validateChunkGenerationToken,
  validateGeneratedChunkPayload,
  validateChunkWorkerReply,
  workerFailureIssue,
} from "./worker-protocol";

function sameToken(
  left: Readonly<ChunkGenerationToken>,
  right: Readonly<ChunkGenerationToken>,
): boolean {
  return left.protocolVersion === right.protocolVersion
    && left.payloadVersion === right.payloadVersion
    && left.planDigest === right.planDigest
    && left.chunkId === right.chunkId
    && left.epoch === right.epoch
    && left.requestId === right.requestId;
}

interface MessageRelay {
  receive: ((data: unknown) => void) | null;
}

interface TerminalRelay {
  receive: (() => void) | null;
}

function copyPayloadBuffer(source: ArrayBuffer, expectedBytes: number): ArrayBuffer {
  try {
    const view = new Uint8Array(source);
    if (view.byteLength !== expectedBytes) throw new TypeError("Payload buffer changed during ownership capture.");
    const owned = new Uint8Array(expectedBytes);
    owned.set(view);
    return owned.buffer;
  } catch {
    throw new TypeError("Payload buffer could not be captured into client ownership.");
  }
}

function ownGeneratedReply(
  reply: Readonly<ChunkWorkerGeneratedReply>,
  snapshot: Readonly<OwnedWorldPlanSnapshot>,
): Readonly<ChunkWorkerGeneratedReply> {
  const source = reply.payload;
  const buffers = Object.freeze(source.buffers.map((entry) => Object.freeze({
    name: entry.name,
    elementType: entry.elementType,
    elementCount: entry.elementCount,
    byteLength: entry.byteLength,
    buffer: copyPayloadBuffer(entry.buffer, entry.byteLength),
  })));
  const candidate: Readonly<GeneratedChunkPayload> = Object.freeze({
    schemaVersion: source.schemaVersion,
    generatorVersion: source.generatorVersion,
    planDigest: source.planDigest,
    chunkId: source.chunkId,
    contentDigest: source.contentDigest,
    manifest: Object.freeze({
      sourcePlanSchema: source.manifest.sourcePlanSchema,
      sourceGeneratorVersion: source.manifest.sourceGeneratorVersion,
      materialFamilies: Object.freeze([...source.manifest.materialFamilies]),
      bufferCount: source.manifest.bufferCount,
      sampleCount: source.manifest.sampleCount,
      byteLength: source.manifest.byteLength,
    }),
    buffers,
  });
  const chunk = snapshot.plan.chunks.find((entry) => entry.id === reply.token.chunkId);
  if (!chunk) throw new TypeError("Generated chunk is absent from the installed plan.");
  const report = validateGeneratedChunkPayload(candidate, {
    planDigest: snapshot.digest,
    token: reply.token,
    materialFamilies: chunk.environment.materialFamilies,
    sourceGeneratorVersion: snapshot.plan.generatorVersion,
  });
  if (!report.valid || !report.value) {
    throw new TypeError("Owned generated payload failed canonical revalidation.");
  }
  return Object.freeze({
    kind: "generated",
    protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
    token: Object.freeze({ ...reply.token }),
    payload: report.value,
  });
}

function deferredVoid(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class ChunkWorkerClient implements ChunkWorkerClientLike {
  readonly #port: ChunkWorkerPort;
  readonly #listener: (event: ChunkWorkerMessageEvent) => void;
  readonly #errorListener: (event: ChunkWorkerMessageEvent) => void;
  readonly #messageErrorListener: (event: ChunkWorkerMessageEvent) => void;
  readonly #messageRelay: MessageRelay;
  readonly #terminalRelay: TerminalRelay;
  readonly #inbox: Array<Readonly<ChunkWorkerGeneratedReply | ChunkWorkerFailedReply>> = [];
  #snapshot: Readonly<OwnedWorldPlanSnapshot> | null = null;
  #initializePromise: Promise<Readonly<OwnedWorldPlanSnapshot>> | null = null;
  #resolveInitialize: ((snapshot: Readonly<OwnedWorldPlanSnapshot>) => void) | null = null;
  #rejectInitialize: ((error: unknown) => void) | null = null;
  #disposed = false;
  #overflowed = false;
  #terminal = false;
  #disposePromise: Promise<void> | null = null;
  #unavailableInitializePromise: Promise<Readonly<OwnedWorldPlanSnapshot>> | null = null;

  constructor(port: ChunkWorkerPort) {
    this.#port = port;
    const messageRelay: MessageRelay = { receive: (data) => this.#receive(data) };
    const terminalRelay: TerminalRelay = { receive: () => this.#receiveTerminal() };
    this.#messageRelay = messageRelay;
    this.#terminalRelay = terminalRelay;
    this.#listener = (event) => messageRelay.receive?.(event.data);
    this.#errorListener = () => terminalRelay.receive?.();
    this.#messageErrorListener = () => terminalRelay.receive?.();
    const added: Array<"message" | "error" | "messageerror"> = [];
    try {
      this.#port.addEventListener("message", this.#listener);
      added.push("message");
      this.#port.addEventListener("error", this.#errorListener);
      added.push("error");
      this.#port.addEventListener("messageerror", this.#messageErrorListener);
      added.push("messageerror");
    } catch {
      messageRelay.receive = null;
      terminalRelay.receive = null;
      for (const type of added.reverse()) {
        const listener = type === "message"
          ? this.#listener
          : type === "error"
            ? this.#errorListener
            : this.#messageErrorListener;
        try {
          this.#port.removeEventListener(type, listener);
        } catch {
          // Revocation above makes a retained callback inert.
        }
      }
      throw new Error("Chunk worker listener initialization failed.");
    }
  }

  initialize(plan: Readonly<WorldPlan>): Promise<Readonly<OwnedWorldPlanSnapshot>> {
    if (this.#disposed || this.#terminal) {
      this.#unavailableInitializePromise ??= Promise.reject(new Error("Chunk worker client is unavailable."));
      return this.#unavailableInitializePromise;
    }
    if (this.#initializePromise) return this.#initializePromise;
    this.#initializePromise = new Promise<Readonly<OwnedWorldPlanSnapshot>>((resolve, reject) => {
      this.#resolveInitialize = resolve;
      this.#rejectInitialize = reject;
    });
    let snapshot: Readonly<OwnedWorldPlanSnapshot>;
    let bytes: Uint8Array;
    try {
      snapshot = captureOwnedWorldPlan(plan);
      bytes = canonicalWorldPlanBytes(snapshot.plan);
    } catch {
      this.#rejectInitialization(new TypeError("World plan capture for the chunk worker failed."));
      return this.#initializePromise;
    }
    this.#snapshot = snapshot;
    try {
      this.#port.postMessage(Object.freeze({
        kind: "install",
        protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
        planDigest: snapshot.digest,
        byteLength: bytes.byteLength,
        planBytes: bytes.buffer,
      }), [bytes.buffer]);
    } catch {
      this.#rejectInitialization(new Error("World-plan transfer to the chunk worker failed."));
    }
    return this.#initializePromise;
  }

  generate(token: Readonly<ChunkGenerationToken>): void {
    this.#assertReadyToken(token);
    this.#port.postMessage(Object.freeze({
      kind: "generate",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      token: Object.freeze({ ...token }),
    }));
  }

  cancel(token: Readonly<ChunkGenerationToken>): void {
    if (this.#disposed || this.#terminal || !this.#snapshot) return;
    const report = validateChunkGenerationToken(token);
    if (!report.valid || !report.value || report.value.planDigest !== this.#snapshot.digest) return;
    this.#port.postMessage(Object.freeze({
      kind: "cancel",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      token: report.value,
    }));
  }

  drainReplies(): readonly Readonly<ChunkWorkerGeneratedReply | ChunkWorkerFailedReply>[] {
    const drained = this.#inbox.splice(0, this.#inbox.length);
    if (this.#overflowed) {
      this.#overflowed = false;
      drained.push(makeWorkerFailure(null, workerFailureIssue(
        "WORKER_INBOX_FULL",
        `Worker reply inbox exceeded ${MAX_CHUNK_WORKER_INBOX} entries.`,
      )));
    }
    return Object.freeze(drained);
  }

  pendingReplyCount(): number {
    return this.#inbox.length + (this.#overflowed ? 1 : 0);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    const deferred = deferredVoid();
    this.#disposePromise = deferred.promise;
    void this.#runDispose().then(deferred.resolve, deferred.reject);
    return this.#disposePromise;
  }

  async #runDispose(): Promise<void> {
    this.#disposed = true;
    this.#messageRelay.receive = null;
    this.#terminalRelay.receive = null;
    const failures: unknown[] = [];
    try {
      this.#port.removeEventListener("message", this.#listener);
    } catch {
      failures.push(new Error("Chunk worker listener removal failed."));
    }
    try {
      this.#port.removeEventListener("error", this.#errorListener);
    } catch {
      failures.push(new Error("Chunk worker error listener removal failed."));
    }
    try {
      this.#port.removeEventListener("messageerror", this.#messageErrorListener);
    } catch {
      failures.push(new Error("Chunk worker messageerror listener removal failed."));
    }
    try {
      this.#port.terminate?.();
    } catch {
      failures.push(new Error("Chunk worker termination failed."));
    }
    this.#rejectInitialization(new Error("Chunk worker client was disposed during initialization."));
    this.#inbox.length = 0;
    this.#snapshot = null;
    this.#initializePromise = null;
    if (failures.length > 0) throw new Error(`Chunk worker client disposal failed in ${failures.length} bounded channel(s).`);
  }

  #assertReadyToken(token: Readonly<ChunkGenerationToken>): void {
    if (this.#disposed || this.#terminal) throw new Error("Chunk worker client is unavailable.");
    if (!this.#snapshot || this.#resolveInitialize !== null) {
      throw new Error("Chunk worker client is not ready.");
    }
    const report = validateChunkGenerationToken(token);
    if (!report.valid || !report.value) {
      throw new TypeError(`Invalid generation token: ${report.issues[0]?.code ?? "TOKEN_INVALID"}.`);
    }
    if (report.value.planDigest !== this.#snapshot.digest) {
      throw new TypeError("Generation token belongs to a different world plan.");
    }
  }

  #receive(data: unknown): void {
    if (this.#disposed || this.#terminal || !this.#snapshot) return;
    const report = validateChunkWorkerReply(data, {
      plan: this.#snapshot.plan,
      planDigest: this.#snapshot.digest,
    });
    if (!report.valid || !report.value) {
      const first = report.issues[0] ?? workerFailureIssue("INVALID_STRUCTURE", "Worker reply validation failed.");
      if (this.#resolveInitialize !== null) {
        this.#rejectInitialization(new TypeError(`${first.code}: ${first.detail}`));
      } else {
        this.#push(makeWorkerFailure(null, first));
      }
      return;
    }
    if (report.value.kind === "ready") {
      if (this.#resolveInitialize === null) return;
      const resolve = this.#resolveInitialize;
      this.#resolveInitialize = null;
      this.#rejectInitialize = null;
      resolve(this.#snapshot);
      return;
    }
    if (this.#resolveInitialize !== null) {
      this.#rejectInitialization(new Error("Chunk worker replied before acknowledging the installed plan."));
      return;
    }
    if (report.value.kind === "generated") {
      try {
        this.#push(ownGeneratedReply(report.value, this.#snapshot));
      } catch {
        this.#push(makeWorkerFailure(null, workerFailureIssue(
          "PAYLOAD_DIGEST_MISMATCH",
          "Generated payload ownership capture failed.",
        )));
      }
      return;
    }
    this.#push(report.value);
  }

  #receiveTerminal(): void {
    if (this.#disposed || this.#terminal) return;
    this.#terminal = true;
    if (this.#resolveInitialize !== null) {
      this.#rejectInitialization(new Error("Chunk worker transport failed during initialization."));
      return;
    }
    this.#push(makeWorkerFailure(null, workerFailureIssue(
      "GENERATION_FAILED",
      "Chunk worker transport terminated.",
    )));
    this.#snapshot = null;
  }

  #push(reply: Readonly<ChunkWorkerGeneratedReply | ChunkWorkerFailedReply>): void {
    if (this.#inbox.length >= MAX_CHUNK_WORKER_INBOX) {
      this.#overflowed = true;
      return;
    }
    this.#inbox.push(reply);
  }

  #rejectInitialization(error: unknown): void {
    const reject = this.#rejectInitialize;
    this.#resolveInitialize = null;
    this.#rejectInitialize = null;
    this.#snapshot = null;
    reject?.(error);
  }
}

export function makeChunkGenerationToken(options: {
  readonly planDigest: string;
  readonly chunkId: ChunkGenerationToken["chunkId"];
  readonly epoch: number;
  readonly requestId: number;
}): Readonly<ChunkGenerationToken> {
  const candidate = {
    protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
    payloadVersion: CHUNK_PAYLOAD_GENERATOR_VERSION,
    planDigest: options.planDigest,
    chunkId: options.chunkId,
    epoch: options.epoch,
    requestId: options.requestId,
  };
  const report = validateChunkGenerationToken(candidate);
  if (!report.valid || !report.value) {
    throw new TypeError(`Cannot create generation token: ${report.issues[0]?.detail ?? "invalid token"}`);
  }
  return report.value;
}

export function tokensEqual(
  left: Readonly<ChunkGenerationToken> | null,
  right: Readonly<ChunkGenerationToken> | null,
): boolean {
  return left !== null && right !== null && sameToken(left, right);
}
