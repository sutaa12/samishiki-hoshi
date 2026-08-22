import type { RegisteredSeedSystem, WorldPlan } from "../../../world/v2/contracts";
import { createSeedStreamRegistry } from "../../../world/v2/seed-streams";
import {
  CHUNK_PAYLOAD_GENERATOR_VERSION,
  CHUNK_PAYLOAD_SCHEMA_VERSION,
  CHUNK_PAYLOAD_STREAMS,
  CHUNK_PAYLOAD_VALUES_PER_STREAM,
  type ChunkGenerationToken,
  type ChunkPayloadBuffer,
  type ChunkPayloadStream,
  type GeneratedChunkPayload,
} from "./contracts";
import { digestGeneratedChunkPayload, validateGeneratedChunkPayload } from "./worker-protocol";

const OWNED_SUBSTREAM: Readonly<Record<ChunkPayloadStream, string>> = Object.freeze({
  flow: "corridor",
  terrain: "heightfield",
  water: "surface",
  flora: "placement",
  ecology: "spawns",
  atmosphere: "field",
  space: "field",
});

interface ChunkGenerationSetup {
  readonly chunk: Readonly<WorldPlan["chunks"][number]>;
  readonly registry: ReturnType<typeof createSeedStreamRegistry>;
}

function prepareGeneration(
  plan: Readonly<WorldPlan>,
  token: Readonly<ChunkGenerationToken>,
): ChunkGenerationSetup {
  if (token.planDigest.length === 0) throw new TypeError("Chunk token requires a plan digest.");
  const chunk = plan.chunks.find((candidate) => candidate.id === token.chunkId);
  if (!chunk) throw new RangeError(`Installed world plan does not contain ${token.chunkId}.`);
  const worldSeed = Number(plan.worldSeed);
  if (!Number.isSafeInteger(worldSeed) || worldSeed < 0 || worldSeed > 0xffff_ffff) {
    throw new TypeError("Installed world plan has an invalid seed.");
  }
  return {
    chunk,
    registry: createSeedStreamRegistry({
      worldSeed,
      generatorVersion: plan.generatorVersion,
    }),
  };
}

function generateStreamBuffer(
  setup: ChunkGenerationSetup,
  token: Readonly<ChunkGenerationToken>,
  name: ChunkPayloadStream,
): Readonly<ChunkPayloadBuffer> {
  const stream = setup.registry.stream(
    name as RegisteredSeedSystem,
    token.chunkId,
    OWNED_SUBSTREAM[name],
  );
  const values = new Uint32Array(CHUNK_PAYLOAD_VALUES_PER_STREAM);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = stream.uint32At(4096 + index);
  }
  return Object.freeze({
    name,
    elementType: "uint32" as const,
    elementCount: values.length,
    byteLength: values.byteLength,
    buffer: values.buffer,
  });
}

function finishPayload(
  plan: Readonly<WorldPlan>,
  token: Readonly<ChunkGenerationToken>,
  setup: ChunkGenerationSetup,
  buffers: readonly Readonly<ChunkPayloadBuffer>[],
): Readonly<GeneratedChunkPayload> {
  const frozenBuffers = Object.freeze([...buffers]);
  const byteLength = frozenBuffers.reduce((total, entry) => total + entry.byteLength, 0);
  const base = {
    schemaVersion: CHUNK_PAYLOAD_SCHEMA_VERSION,
    generatorVersion: CHUNK_PAYLOAD_GENERATOR_VERSION,
    planDigest: token.planDigest,
    chunkId: token.chunkId,
    manifest: Object.freeze({
      sourcePlanSchema: "lonely-star-world-plan/v1" as const,
      sourceGeneratorVersion: plan.generatorVersion,
      materialFamilies: Object.freeze([...setup.chunk.environment.materialFamilies]),
      bufferCount: frozenBuffers.length,
      sampleCount: frozenBuffers.length * CHUNK_PAYLOAD_VALUES_PER_STREAM,
      byteLength,
    }),
    buffers: frozenBuffers,
  };
  const payload: Readonly<GeneratedChunkPayload> = Object.freeze({
    ...base,
    contentDigest: digestGeneratedChunkPayload(base),
  });
  const report = validateGeneratedChunkPayload(payload, {
    planDigest: token.planDigest,
    token,
    materialFamilies: setup.chunk.environment.materialFamilies,
    sourceGeneratorVersion: plan.generatorVersion,
  });
  if (!report.valid || !report.value) {
    throw new Error(`Generated payload failed self-validation: ${report.issues[0]?.code ?? "unknown"}.`);
  }
  return report.value;
}

export function generateChunkPayload(
  plan: Readonly<WorldPlan>,
  token: Readonly<ChunkGenerationToken>,
): Readonly<GeneratedChunkPayload> {
  const setup = prepareGeneration(plan, token);
  const buffers = CHUNK_PAYLOAD_STREAMS.map((name) => generateStreamBuffer(setup, token, name));
  return finishPayload(plan, token, setup, buffers);
}

export async function generateChunkPayloadCooperatively(
  plan: Readonly<WorldPlan>,
  token: Readonly<ChunkGenerationToken>,
  cancelled: () => boolean,
  yieldControl: () => Promise<void>,
): Promise<Readonly<GeneratedChunkPayload> | null> {
  const setup = prepareGeneration(plan, token);
  const buffers: Readonly<ChunkPayloadBuffer>[] = [];
  for (const name of CHUNK_PAYLOAD_STREAMS) {
    await yieldControl();
    if (cancelled()) return null;
    buffers.push(generateStreamBuffer(setup, token, name));
  }
  if (cancelled()) return null;
  return finishPayload(plan, token, setup, buffers);
}

export function transferListForChunkPayload(
  payload: Readonly<GeneratedChunkPayload>,
): readonly ArrayBuffer[] {
  return Object.freeze(payload.buffers.map((entry) => entry.buffer));
}
