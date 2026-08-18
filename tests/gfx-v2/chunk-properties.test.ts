import { describe, expect, it } from "vitest";
import { digestWorldPlan } from "../../src/world/v2/canonical";
import { STORY_CHUNK_IDS } from "../../src/world/v2/contracts";
import { createWorldGenerationContext } from "../../src/world/v2/seed-streams";
import { generateWorldPlan } from "../../src/world/v2/world-plan";
import {
  CHUNK_PAYLOAD_STREAMS,
  CHUNK_PAYLOAD_VALUES_PER_STREAM,
  MAX_CHUNK_PAYLOAD_BYTES,
} from "../../src/gfx/v2/chunks/contracts";
import { generateChunkPayload } from "../../src/gfx/v2/chunks/worker-kernel";
import { validateGeneratedChunkPayload } from "../../src/gfx/v2/chunks/worker-protocol";
import { makeChunkGenerationToken } from "../../src/gfx/v2/chunks/worker-client";

describe("GFX-004 generated chunk property oracle", () => {
  it("keeps one thousand seeds deterministic, bounded, and quality/backend neutral", { timeout: 30_000 }, () => {
    const failures: string[] = [];
    const expectedByteLength = CHUNK_PAYLOAD_STREAMS.length
      * CHUNK_PAYLOAD_VALUES_PER_STREAM
      * Uint32Array.BYTES_PER_ELEMENT;

    for (let seed = 0; seed < 1000; seed += 1) {
      const plan = generateWorldPlan(createWorldGenerationContext({ worldSeed: seed }));
      const planDigest = digestWorldPlan(plan);
      const chunkId = STORY_CHUNK_IDS[seed % STORY_CHUNK_IDS.length]!;
      const firstToken = makeChunkGenerationToken({
        planDigest,
        chunkId,
        epoch: 1,
        requestId: 1,
      });
      const secondToken = makeChunkGenerationToken({
        planDigest,
        chunkId,
        epoch: 999,
        requestId: 999,
      });
      const first = generateChunkPayload(plan, firstToken);
      const second = generateChunkPayload(plan, secondToken);
      const expectedFamilies = plan.chunks.find((chunk) => chunk.id === chunkId)!
        .environment.materialFamilies;
      const report = validateGeneratedChunkPayload(first, {
        planDigest,
        token: firstToken,
        materialFamilies: expectedFamilies,
        sourceGeneratorVersion: plan.generatorVersion,
      });

      const sameBytes = first.buffers.every((buffer, index) => {
        const counterpart = second.buffers[index];
        if (!counterpart || counterpart.name !== buffer.name) return false;
        return new Uint32Array(buffer.buffer).every(
          (value, valueIndex) => value === new Uint32Array(counterpart.buffer)[valueIndex],
        );
      });
      const serializedContract = JSON.stringify({
        schemaVersion: first.schemaVersion,
        generatorVersion: first.generatorVersion,
        planDigest: first.planDigest,
        chunkId: first.chunkId,
        manifest: first.manifest,
        buffers: first.buffers.map(({ name, elementType, elementCount, byteLength }) => ({
          name,
          elementType,
          elementCount,
          byteLength,
        })),
      });
      const validBounds = first.manifest.byteLength === expectedByteLength
        && first.manifest.byteLength <= MAX_CHUNK_PAYLOAD_BYTES
        && first.manifest.bufferCount === CHUNK_PAYLOAD_STREAMS.length
        && first.manifest.sampleCount
          === CHUNK_PAYLOAD_STREAMS.length * CHUNK_PAYLOAD_VALUES_PER_STREAM
        && first.buffers.every((buffer) =>
          buffer.elementCount === CHUNK_PAYLOAD_VALUES_PER_STREAM
          && buffer.byteLength === CHUNK_PAYLOAD_VALUES_PER_STREAM * Uint32Array.BYTES_PER_ELEMENT
          && buffer.buffer.byteLength === buffer.byteLength
          && new Uint32Array(buffer.buffer).every((value) => Number.isSafeInteger(value)),
        );

      if (
        !report.valid
        || first.contentDigest !== second.contentDigest
        || !sameBytes
        || !validBounds
        || /quality|backend|webgpu|webgl|three/i.test(serializedContract)
      ) {
        failures.push(`${seed}:${chunkId}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
