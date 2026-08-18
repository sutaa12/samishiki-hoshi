import type { OwnedWorldPlanSnapshot } from "./contracts";
import {
  CHUNK_WORKER_PROTOCOL_VERSION,
  MAX_CHUNK_WORKER_INBOX,
  type ChunkGenerationToken,
  type ChunkWorkerReply,
} from "./contracts";
import { generateChunkPayloadCooperatively, transferListForChunkPayload } from "./worker-kernel";
import {
  decodeInstalledWorldPlan,
  makeWorkerFailure,
  validateChunkWorkerRequest,
  workerFailureIssue,
} from "./worker-protocol";

export type ChunkWorkerPost = (
  reply: Readonly<ChunkWorkerReply>,
  transfer?: readonly Transferable[],
) => void;

function tokenKey(token: Readonly<ChunkGenerationToken>): string {
  return `${token.planDigest}\u0000${token.chunkId}\u0000${token.epoch}\u0000${token.requestId}`;
}

export type ChunkWorkerSchedule = (continuation: () => void) => void;
export type ChunkWorkerFatal = (detail: string) => void;

interface PendingGeneration {
  readonly key: string;
  readonly token: Readonly<ChunkGenerationToken>;
  readonly installed: Readonly<OwnedWorldPlanSnapshot>;
  cancelled: boolean;
}

export interface ChunkWorkerEndpoint {
  receive(input: unknown): void;
  installedPlanDigest(): string | null;
}

export function createChunkWorkerEndpoint(
  post: ChunkWorkerPost,
  schedule: ChunkWorkerSchedule = (continuation) => { setTimeout(continuation, 0); },
  fatal: ChunkWorkerFatal = (detail) => {
    setTimeout(() => { throw new Error(detail); }, 0);
  },
): ChunkWorkerEndpoint {
  let installed: Readonly<OwnedWorldPlanSnapshot> | null = null;
  const pending: PendingGeneration[] = [];
  const pendingByKey = new Map<string, PendingGeneration>();
  let active: PendingGeneration | null = null;
  let pumpScheduled = false;
  let pumping = false;
  let terminal = false;

  const enterFatal = (): void => {
    if (terminal) return;
    terminal = true;
    if (active) active.cancelled = true;
    pending.length = 0;
    pendingByKey.clear();
    try {
      fatal("Chunk worker reply transport failed.");
    } catch {
      schedule(() => { throw new Error("Chunk worker reply transport failed."); });
    }
  };

  const safePost = (
    reply: Readonly<ChunkWorkerReply>,
    transfer?: readonly Transferable[],
  ): boolean => {
    if (terminal) return false;
    try {
      post(reply, transfer);
      return true;
    } catch {
      enterFatal();
      return false;
    }
  };

  const fail = (
    token: Readonly<ChunkGenerationToken> | null,
    code: Parameters<typeof workerFailureIssue>[0],
    detail: string,
  ): boolean => safePost(makeWorkerFailure(token, workerFailureIssue(code, detail, token?.chunkId)));

  const yieldControl = (): Promise<void> => new Promise<void>((resolve, reject) => {
    try {
      schedule(resolve);
    } catch {
      reject(new Error("Chunk worker scheduler failed."));
    }
  });

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (pending.length > 0) {
        const generation = pending.shift();
        if (!generation) continue;
        active = generation;
        try {
          const payload = generation.cancelled
            ? null
            : await generateChunkPayloadCooperatively(
              generation.installed.plan,
              generation.token,
              () => generation.cancelled,
              yieldControl,
            );
          if (generation.cancelled || payload === null) {
            fail(generation.token, "GENERATION_CANCELLED", "Generation request was cancelled before completion.");
          } else {
            safePost(Object.freeze({
              kind: "generated" as const,
              protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
              token: generation.token,
              payload,
            }), transferListForChunkPayload(payload));
          }
        } catch {
          fail(generation.token, "GENERATION_FAILED", "Chunk generation failed.");
        } finally {
          pendingByKey.delete(generation.key);
          active = null;
        }
      }
    } finally {
      pumping = false;
      if (pending.length > 0) schedulePump();
    }
  };

  const schedulePump = (): void => {
    if (pumpScheduled || pumping || pending.length === 0) return;
    pumpScheduled = true;
    try {
      schedule(() => {
        pumpScheduled = false;
        void pump();
      });
    } catch {
      pumpScheduled = false;
      for (const generation of pending.splice(0)) {
        pendingByKey.delete(generation.key);
        try {
          fail(generation.token, "GENERATION_FAILED", "Chunk worker scheduler failed.");
        } catch {
          // The worker transport itself is no longer writable.
        }
      }
    }
  };

  return Object.freeze({
    receive(input: unknown): void {
      if (terminal) return;
      const report = validateChunkWorkerRequest(input);
      if (!report.valid || !report.value) {
        const first = report.issues[0] ?? workerFailureIssue("INVALID_STRUCTURE", "Worker request is invalid.");
        safePost(makeWorkerFailure(null, first));
        return;
      }
      const request = report.value;
      if (request.kind === "install") {
        if (active) active.cancelled = true;
        for (const generation of pending.splice(0)) {
          pendingByKey.delete(generation.key);
          fail(generation.token, "GENERATION_CANCELLED", "World-plan replacement cancelled queued generation.");
        }
        try {
          installed = decodeInstalledWorldPlan(request);
          safePost(Object.freeze({
            kind: "ready",
            protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
            planDigest: installed.digest,
          }));
        } catch {
          installed = null;
          fail(null, "PLAN_INVALID", "World-plan installation failed.");
        }
        return;
      }
      if (request.kind === "cancel") {
        if (!installed) {
          fail(request.token, "WORKER_NOT_READY", "Worker has no installed world plan.");
          return;
        }
        if (request.token.planDigest !== installed.digest) {
          fail(request.token, "PLAN_DIGEST_MISMATCH", "Cancellation token belongs to a different world plan.");
          return;
        }
        const key = tokenKey(request.token);
        const generation = pendingByKey.get(key);
        if (generation) generation.cancelled = true;
        return;
      }
      const token = request.token;
      if (!installed) {
        fail(token, "WORKER_NOT_READY", "Worker has no installed world plan.");
        return;
      }
      if (token.planDigest !== installed.digest) {
        fail(token, "PLAN_DIGEST_MISMATCH", "Generation token belongs to a different world plan.");
        return;
      }
      const key = tokenKey(token);
      if (pendingByKey.has(key)) {
        fail(token, "TOKEN_MISMATCH", "Generation token is already queued or active.");
        return;
      }
      if (pendingByKey.size >= MAX_CHUNK_WORKER_INBOX) {
        fail(token, "WORKER_INBOX_FULL", "Worker generation queue is full.");
        return;
      }
      const generation: PendingGeneration = { key, token, installed, cancelled: false };
      pending.push(generation);
      pendingByKey.set(key, generation);
      schedulePump();
    },
    installedPlanDigest(): string | null {
      return installed?.digest ?? null;
    },
  });
}
