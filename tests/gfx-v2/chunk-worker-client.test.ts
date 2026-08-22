import { afterEach, describe, expect, it, vi } from "vitest";
import { digestWorldPlan } from "../../src/world/v2/canonical";
import { createWorldGenerationContext } from "../../src/world/v2/seed-streams";
import { generateWorldPlan } from "../../src/world/v2/world-plan";
import {
  CHUNK_WORKER_PROTOCOL_VERSION,
  type ChunkWorkerMessageEvent,
  type ChunkWorkerPort,
} from "../../src/gfx/v2/chunks/contracts";
import { createBrowserWorldChunkWorker } from "../../src/gfx/v2/chunks/browser-worker";
import { ChunkWorkerClient, makeChunkGenerationToken } from "../../src/gfx/v2/chunks/worker-client";
import { createChunkWorkerEndpoint } from "../../src/gfx/v2/chunks/worker-endpoint";
import { generateChunkPayload } from "../../src/gfx/v2/chunks/worker-kernel";

type WorkerEventType = "message" | "error" | "messageerror";

class FakeWorkerPort implements ChunkWorkerPort {
  readonly posts: Array<{ readonly message: unknown; readonly transfer: readonly Transferable[] }> = [];
  readonly listeners = new Map<WorkerEventType, Set<(event: ChunkWorkerMessageEvent) => void>>();
  throwRemove = false;
  terminated = 0;

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    this.posts.push({ message, transfer });
  }

  addEventListener(type: WorkerEventType, listener: (event: ChunkWorkerMessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WorkerEventType, listener: (event: ChunkWorkerMessageEvent) => void): void {
    if (this.throwRemove) throw new Error("retained by hostile port");
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated += 1;
  }

  emit(type: WorkerEventType, data: unknown = null): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ data });
  }
}

const WORLD = generateWorldPlan(createWorldGenerationContext({ worldSeed: 20_260_818 }));
const DIGEST = digestWorldPlan(WORLD);

function readyClient(): { readonly client: ChunkWorkerClient; readonly port: FakeWorkerPort; readonly ready: Promise<unknown> } {
  const port = new FakeWorkerPort();
  const client = new ChunkWorkerClient(port);
  const ready = client.initialize(WORLD);
  port.emit("message", Object.freeze({
    kind: "ready",
    protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
    planDigest: DIGEST,
  }));
  return { client, port, ready };
}

describe("GFX-004 worker client ownership and transport", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("copies transferred payload bytes before another listener can mutate event data", async () => {
    const { client, port, ready } = readyClient();
    await ready;
    const token = makeChunkGenerationToken({ planDigest: DIGEST, chunkId: "S08", epoch: 1, requestId: 1 });
    client.generate(token);
    const payload = generateChunkPayload(WORLD, token);
    const expected = Array.from(new Uint32Array(payload.buffers[0]!.buffer));
    const reply = Object.freeze({
      kind: "generated" as const,
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      token,
      payload,
    });
    port.emit("message", reply);
    new Uint32Array(payload.buffers[0]!.buffer)[0] ^= 0xffff_ffff;

    const [owned] = client.drainReplies();
    expect(owned?.kind).toBe("generated");
    if (owned?.kind !== "generated") throw new Error("Expected an owned generated reply.");
    expect(Array.from(new Uint32Array(owned.payload.buffers[0]!.buffer))).toEqual(expected);
    expect(owned.payload.buffers[0]!.buffer).not.toBe(payload.buffers[0]!.buffer);
    await client.dispose();
  });

  it("rejects install transport failure and emits one terminal failure for active work", async () => {
    const installPort = new FakeWorkerPort();
    const installing = new ChunkWorkerClient(installPort);
    const initialize = installing.initialize(WORLD);
    installPort.emit("error");
    await expect(initialize).rejects.toThrow(/transport failed during initialization/);
    await installing.dispose();

    const { client, port, ready } = readyClient();
    await ready;
    client.generate(makeChunkGenerationToken({ planDigest: DIGEST, chunkId: "S08", epoch: 1, requestId: 2 }));
    client.generate(makeChunkGenerationToken({ planDigest: DIGEST, chunkId: "S09", epoch: 1, requestId: 3 }));
    port.emit("messageerror");
    port.emit("error");
    const replies = client.drainReplies();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ kind: "failed", token: null, issue: { code: "GENERATION_FAILED" } });
    expect(() => client.generate(makeChunkGenerationToken({ planDigest: DIGEST, chunkId: "S10", epoch: 1, requestId: 4 }))).toThrow(/unavailable/);
    await client.dispose();
  });

  it("revokes retained callbacks before removal and returns stable disposal identity", async () => {
    const { client, port, ready } = readyClient();
    await ready;
    port.throwRemove = true;
    const first = client.dispose();
    const second = client.dispose();
    expect(first).toBe(second);
    await expect(first).rejects.toThrow(/bounded channel/);
    expect(port.terminated).toBe(1);
    port.emit("message", Object.freeze({ hostile: true }));
    port.emit("error");
    expect(client.pendingReplyCount()).toBe(0);
  });

  it("runs factory init, FIFO cancel, transfer, and termination through a browser-equivalent Worker", async () => {
    const constructed: Array<{ readonly url: string | URL; readonly options: WorkerOptions }> = [];
    const workerInstances: FakeWorkerPort[] = [];
    class LoopbackWorker extends FakeWorkerPort {
      readonly #endpoint = createChunkWorkerEndpoint(
        (reply, transfer = []) => {
          const cloned = structuredClone(reply, { transfer: [...transfer] });
          queueMicrotask(() => this.emit("message", cloned));
        },
        (continuation) => queueMicrotask(continuation),
        () => this.emit("error"),
      );

      constructor(url: string | URL, options: WorkerOptions) {
        super();
        workerInstances.push(this);
        constructed.push({ url, options });
      }

      override postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
        const cloned = structuredClone(message, { transfer: [...transfer] });
        queueMicrotask(() => this.#endpoint.receive(cloned));
      }
    }
    vi.stubGlobal("Worker", LoopbackWorker);
    const client = createBrowserWorldChunkWorker();
    await client.initialize(WORLD);
    const token = makeChunkGenerationToken({ planDigest: DIGEST, chunkId: "S08", epoch: 1, requestId: 88 });
    client.generate(token);
    client.cancel(token);
    for (let turn = 0; turn < 32 && client.pendingReplyCount() === 0; turn += 1) await Promise.resolve();
    expect(client.drainReplies()).toEqual([
      expect.objectContaining({ kind: "failed", token: expect.objectContaining({ requestId: 88 }), issue: expect.objectContaining({ code: "GENERATION_CANCELLED" }) }),
    ]);
    await client.dispose();
    expect(constructed).toHaveLength(1);
    expect(String(constructed[0]?.url)).toContain("world-chunk-worker");
    expect(constructed[0]?.options).toMatchObject({ type: "module", name: "lonely-star-world-chunks" });
    expect(workerInstances[0]?.terminated).toBe(1);
    expect((client as unknown as { pendingReplyCount(): number }).pendingReplyCount()).toBe(0);
  });
});
