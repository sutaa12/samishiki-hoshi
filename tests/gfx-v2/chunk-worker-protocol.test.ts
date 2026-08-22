import { describe, expect, it } from "vitest";
import {
  canonicalWorldPlanBytes,
  digestWorldPlan,
} from "../../src/world/v2/canonical";
import {
  WORLD_GENERATOR_VERSION,
  createWorldGenerationContext,
} from "../../src/world/v2/seed-streams";
import { generateWorldPlan } from "../../src/world/v2/world-plan";
import {
  CHUNK_PAYLOAD_STREAMS,
  CHUNK_WORKER_PROTOCOL_VERSION,
  MAX_CHUNK_WORKER_INBOX,
} from "../../src/gfx/v2/chunks/contracts";
import { createChunkWorkerEndpoint } from "../../src/gfx/v2/chunks/worker-endpoint";
import { generateChunkPayload } from "../../src/gfx/v2/chunks/worker-kernel";
import {
  captureOwnedWorldPlan,
  validateChunkWorkerReply,
  validateChunkWorkerRequest,
  validateGeneratedChunkPayload,
} from "../../src/gfx/v2/chunks/worker-protocol";
import { makeChunkGenerationToken } from "../../src/gfx/v2/chunks/worker-client";

function plan(seed = 20_260_818) {
  return generateWorldPlan(createWorldGenerationContext({
    worldSeed: seed,
    generatorVersion: WORLD_GENERATOR_VERSION,
  }));
}

function tokenFor(chunkId: "S01" | "S08" | "S24", requestId = 1) {
  const world = plan();
  return makeChunkGenerationToken({
    planDigest: digestWorldPlan(world),
    chunkId,
    epoch: 1,
    requestId,
  });
}

async function flushScheduled(tasks: Array<() => void>, limit = 256): Promise<void> {
  for (let turn = 0; turn < limit; turn += 1) {
    const task = tasks.shift();
    if (task) task();
    await Promise.resolve();
    if (tasks.length === 0) {
      await Promise.resolve();
      if (tasks.length === 0) return;
    }
  }
  throw new Error("Chunk worker scheduler did not drain within its bounded test budget.");
}

describe("GFX-004 worker protocol and pure kernel", () => {
  it("captures and validates a single canonical owned plan snapshot", () => {
    const world = plan();
    const snapshot = captureOwnedWorldPlan(world);
    expect(snapshot.digest).toBe("world-plan-v1:c7ed4025456222e2");
    expect(snapshot.plan).not.toBe(world);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.plan.chunks)).toBe(true);

    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "schemaVersion", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "lonely-star-world-plan/v1";
      },
    });
    expect(() => captureOwnedWorldPlan(accessor as never)).toThrow(/captured canonically/);
    expect(getterCalls).toBe(0);
  });

  it("generates quality/backend-free byte-stable named-stream payloads", () => {
    const world = plan();
    const first = generateChunkPayload(world, tokenFor("S08", 1));
    const second = generateChunkPayload(world, tokenFor("S08", 99));

    expect(first.contentDigest).toBe(second.contentDigest);
    expect(first.buffers.map((entry) => entry.name)).toEqual(CHUNK_PAYLOAD_STREAMS);
    expect(first.manifest.byteLength).toBe(896);
    expect(JSON.stringify(first)).not.toMatch(/quality|backend|webgpu|webgl|three/i);
    expect(validateGeneratedChunkPayload(first, {
      planDigest: digestWorldPlan(world),
      token: tokenFor("S08", 1),
      sourceGeneratorVersion: world.generatorVersion,
      materialFamilies: world.chunks[7]!.environment.materialFamilies,
    }).valid).toBe(true);
  });

  it("binds install, token, plan digest, schema, payload and transfer ownership", async () => {
    const world = plan();
    const bytes = canonicalWorldPlanBytes(world);
    const replies: unknown[] = [];
    const transfers: readonly Transferable[][] = [];
    const scheduled: Array<() => void> = [];
    const endpoint = createChunkWorkerEndpoint((reply, transfer = []) => {
      replies.push(reply);
      (transfers as Transferable[][]).push([...transfer]);
    }, (continuation) => scheduled.push(continuation));
    endpoint.receive({
      kind: "install",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      planDigest: digestWorldPlan(world),
      byteLength: bytes.byteLength,
      planBytes: bytes.buffer,
    });
    endpoint.receive({
      kind: "generate",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      token: tokenFor("S08"),
    });
    await flushScheduled(scheduled);

    expect(validateChunkWorkerReply(replies[0], {
      plan: world,
      planDigest: digestWorldPlan(world),
    }).valid).toBe(true);
    const generated = validateChunkWorkerReply(replies[1], {
      plan: world,
      planDigest: digestWorldPlan(world),
      token: tokenFor("S08"),
    });
    expect(generated.valid).toBe(true);
    expect(transfers[1]).toHaveLength(CHUNK_PAYLOAD_STREAMS.length);

    const reply = replies[1] as { payload: { buffers: Array<{ buffer: ArrayBuffer }> } };
    const owned = reply.payload.buffers.map((entry) => entry.buffer);
    const received = structuredClone(reply, { transfer: owned });
    expect(owned.every((buffer) => buffer.byteLength === 0)).toBe(true);
    expect(validateChunkWorkerReply(received, {
      plan: world,
      planDigest: digestWorldPlan(world),
      token: tokenFor("S08"),
    }).valid).toBe(true);
  });

  it("rejects accessors, extra fields, duplicate buffers, detached buffers and digest mutation", () => {
    expect(validateChunkWorkerRequest(1).valid).toBe(false);
    expect(validateChunkWorkerRequest({
      kind: "generate",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      token: tokenFor("S01"),
      quality: "high",
    }).issues.map((entry) => entry.code)).toContain("UNEXPECTED_PROPERTY");

    let getterCalls = 0;
    const request = {
      kind: "generate",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
    } as Record<string, unknown>;
    Object.defineProperty(request, "token", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return tokenFor("S01");
      },
    });
    expect(validateChunkWorkerRequest(request).valid).toBe(false);
    expect(getterCalls).toBe(0);

    const payload = generateChunkPayload(plan(), tokenFor("S01"));
    const duplicate = structuredClone(payload) as typeof payload;
    (duplicate.buffers as unknown as Array<{ buffer: ArrayBuffer }>)[1]!.buffer = duplicate.buffers[0]!.buffer;
    expect(validateGeneratedChunkPayload(duplicate).issues.map((entry) => entry.code)).toContain("PAYLOAD_BUFFER_INVALID");

    const mutated = structuredClone(payload) as typeof payload;
    new Uint32Array(mutated.buffers[0]!.buffer)[0] ^= 1;
    expect(validateGeneratedChunkPayload(mutated).issues.map((entry) => entry.code)).toContain("PAYLOAD_DIGEST_MISMATCH");

    const detached = structuredClone(payload) as typeof payload;
    const buffer = detached.buffers[0]!.buffer;
    structuredClone(buffer, { transfer: [buffer] });
    expect(validateGeneratedChunkPayload(detached).issues.map((entry) => entry.code)).toContain("PAYLOAD_BUFFER_INVALID");
  });

  it("bounds generation ownership, cancels FIFO work, and never retains late cancellation", async () => {
    const world = plan();
    const replies: Array<{ kind: string; issue?: { code: string } }> = [];
    const scheduled: Array<() => void> = [];
    const endpoint = createChunkWorkerEndpoint(
      (reply) => replies.push(reply),
      (continuation) => scheduled.push(continuation),
    );
    endpoint.receive({ kind: "cancel", protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION, token: tokenFor("S01", 1) });
    expect(replies.at(-1)?.issue?.code).toBe("WORKER_NOT_READY");

    const bytes = canonicalWorldPlanBytes(world);
    endpoint.receive({
      kind: "install",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      planDigest: digestWorldPlan(world),
      byteLength: bytes.byteLength,
      planBytes: bytes.buffer,
    });
    for (let index = 0; index <= MAX_CHUNK_WORKER_INBOX; index += 1) {
      endpoint.receive({
        kind: "generate",
        protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
        token: tokenFor("S01", index + 10),
      });
    }
    expect(replies.at(-1)?.issue?.code).toBe("WORKER_INBOX_FULL");

    for (let index = 0; index < MAX_CHUNK_WORKER_INBOX * 2; index += 1) {
      endpoint.receive({
        kind: "cancel",
        protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
        token: tokenFor("S24", index + 1_000),
      });
    }
    expect(replies.at(-1)?.issue?.code).toBe("WORKER_INBOX_FULL");

    const queued = tokenFor("S01", 10);
    endpoint.receive({ kind: "cancel", protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION, token: queued });
    await flushScheduled(scheduled, 2_048);
    expect(replies.some((reply) => reply.issue?.code === "GENERATION_CANCELLED")).toBe(true);
    expect(replies.filter((reply) => reply.issue?.code === "WORKER_INBOX_FULL")).toHaveLength(1);
  });

  it("routes an unwritable reply transport to one terminal callback", async () => {
    const world = plan();
    const bytes = canonicalWorldPlanBytes(world);
    const scheduled: Array<() => void> = [];
    const fatal: string[] = [];
    let ready = true;
    const endpoint = createChunkWorkerEndpoint(
      () => {
        if (!ready) throw Object.freeze({ opaque: true });
      },
      (continuation) => scheduled.push(continuation),
      (detail) => fatal.push(detail),
    );
    endpoint.receive({
      kind: "install",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      planDigest: digestWorldPlan(world),
      byteLength: bytes.byteLength,
      planBytes: bytes.buffer,
    });
    ready = false;
    endpoint.receive({ kind: "generate", protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION, token: tokenFor("S08") });
    await flushScheduled(scheduled);
    expect(fatal).toEqual(["Chunk worker reply transport failed."]);
  });

  it("rejects unregistered or unbounded worker issues and token/chunk mismatch", () => {
    const token = tokenFor("S08");
    const base = {
      kind: "failed",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      token,
    };
    expect(validateChunkWorkerReply({
      ...base,
      issue: { code: "ARBITRARY", path: "$", detail: "bad", chunkId: "S08" },
    }).valid).toBe(false);
    expect(validateChunkWorkerReply({
      ...base,
      issue: { code: "GENERATION_FAILED", path: `$${".x".repeat(300)}`, detail: "bad", chunkId: "S08" },
    }).valid).toBe(false);
    expect(validateChunkWorkerReply({
      ...base,
      issue: { code: "GENERATION_FAILED", path: "$", detail: "bad", chunkId: "S24" },
    }).issues.map((issue) => issue.code)).toContain("TOKEN_MISMATCH");
  });

  it("keeps every chunk digest independent of generation order", () => {
    const world = plan(778);
    const digest = digestWorldPlan(world);
    const ids = ["S01", "S08", "S24"] as const;
    const forward = ids.map((chunkId, index) => generateChunkPayload(world, makeChunkGenerationToken({
      planDigest: digest,
      chunkId,
      epoch: 1,
      requestId: index + 1,
    })).contentDigest);
    const reverse = [...ids].reverse().map((chunkId, index) => generateChunkPayload(world, makeChunkGenerationToken({
      planDigest: digest,
      chunkId,
      epoch: 9,
      requestId: index + 50,
    }))).reverse().map((entry) => entry.contentDigest);
    expect(reverse).toEqual(forward);
  });
});
