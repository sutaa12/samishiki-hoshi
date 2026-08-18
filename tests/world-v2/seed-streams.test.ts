import { describe, expect, it } from "vitest";
import {
  STORY_CHUNK_IDS,
  WORLD_GENERATOR_VERSION,
  WORLD_PLAN_GENERATOR_SYSTEMS,
  createSeedStream,
  createSeedStreamRegistry,
  createWorldGenerationContext,
  type RegisteredSeedSystem,
  type StoryChunkId,
} from "../../src/world/v2";
import { assertDeepFrozen } from "./test-helpers";

const OWNED_SUBSTREAM = Object.freeze({
  story: "node",
  flow: "corridor",
  hydrology: "graph",
  civilization: "motif",
  "alien-ship": "reveal",
  twinkle: "ledger",
} satisfies Readonly<Record<(typeof WORLD_PLAN_GENERATOR_SYSTEMS)[number], string>>);

function values(stream: ReturnType<typeof createSeedStream>, count = 16): number[] {
  return Array.from({ length: count }, (_, index) => stream.uint32At(index));
}

function streamFor(overrides: Partial<Parameters<typeof createSeedStream>[0]> = {}) {
  return createSeedStream({
    worldSeed: 20_260_818,
    systemName: "flow",
    chunkId: "S08",
    generatorVersion: WORLD_GENERATOR_VERSION,
    substream: "corridor",
    ...overrides,
  });
}

describe("GFX-003 named counter seed streams", () => {
  it("exposes only lower-case ASCII registered generator systems and owned substreams", () => {
    expect(WORLD_PLAN_GENERATOR_SYSTEMS).toEqual([
      "story",
      "flow",
      "hydrology",
      "civilization",
      "alien-ship",
      "twinkle",
    ]);
    for (const systemName of WORLD_PLAN_GENERATOR_SYSTEMS) {
      expect(systemName).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
      expect(() => createSeedStream({
        worldSeed: 20_260_818,
        systemName,
        chunkId: "S01",
        generatorVersion: WORLD_GENERATOR_VERSION,
        substream: OWNED_SUBSTREAM[systemName],
      })).not.toThrow();
    }
  });

  it("rejects unregistered, non-ASCII, and foreign-owned addresses", () => {
    expect(() => streamFor({ systemName: "unknown" as RegisteredSeedSystem })).toThrow(/unregistered/i);
    expect(() => streamFor({ systemName: "地形" as RegisteredSeedSystem })).toThrow(/unregistered|ascii/i);
    expect(() => streamFor({ chunkId: "S25" as StoryChunkId })).toThrow(/chunk/i);
    expect(() => streamFor({ generatorVersion: "世界-v1" })).toThrow(/ascii/i);
    expect(() => streamFor({ substream: "graph" })).toThrow(/not registered to flow/i);
    expect(() => streamFor({ substream: "corridor/foreign" })).toThrow(/ascii|registered/i);
  });

  it("derives a different address when any allowed tuple field changes", () => {
    const baseline = streamFor();
    const variants = [
      streamFor({ worldSeed: 20_260_819 }),
      streamFor({ systemName: "hydrology", substream: "graph" }),
      streamFor({ chunkId: "S09" }),
      streamFor({ generatorVersion: "gfx003-world-plan-v2" }),
      streamFor({ substream: undefined }),
      createSeedStream({
        worldSeed: 20_260_818,
        systemName: "flow",
        chunkId: "S08",
        generatorVersion: WORLD_GENERATOR_VERSION,
        substream: "branches",
      }),
    ];

    expect(new Set([baseline.baseSeed, ...variants.map((variant) => variant.baseSeed)]).size).toBe(variants.length + 1);
    for (const variant of variants) expect(values(variant)).not.toEqual(values(baseline));
  });

  it("is counter-addressed rather than cursor-addressed", () => {
    const stream = streamFor();
    const expected = values(stream, 32);

    expect(stream.uint32At(31)).toBe(expected[31]);
    expect(stream.uint32At(0)).toBe(expected[0]);
    expect(stream.uint32At(17)).toBe(expected[17]);
    expect(values(stream, 32)).toEqual(expected);
    expect(values(streamFor(), 32)).toEqual(expected);
  });

  it("keeps unrelated systems unchanged regardless of stream creation and access order", () => {
    const context = createWorldGenerationContext({ worldSeed: 20_260_818 });
    const firstRegistry = createSeedStreamRegistry(context);
    const hydrologyBefore = values(firstRegistry.stream("hydrology", "S08", "graph"));

    const flow = firstRegistry.stream("flow", "S08", "corridor");
    for (let index = 4095; index >= 0; index -= 1) flow.uint32At(index);

    const story = firstRegistry.stream("story", "S08", "node");
    for (let index = 0; index < 4096; index += 1) story.uint32At(index);

    const secondRegistry = createSeedStreamRegistry(createWorldGenerationContext({ worldSeed: 20_260_818 }));
    const hydrologyAfter = values(secondRegistry.stream("hydrology", "S08", "graph"));
    expect(hydrologyAfter).toEqual(hydrologyBefore);
  });

  it("returns frozen addresses, streams, contexts, and registries", () => {
    const context = createWorldGenerationContext({ worldSeed: 20_260_818 });
    const registry = createSeedStreamRegistry(context);
    const stream = registry.stream("twinkle", "S23", "ledger");

    assertDeepFrozen(context);
    assertDeepFrozen(registry);
    assertDeepFrozen(stream);
  });

  it("keeps generated values within their documented ranges", () => {
    const stream = streamFor();
    for (let index = 0; index < 2048; index += 1) {
      expect(stream.uint32At(index)).toBeGreaterThanOrEqual(0);
      expect(stream.uint32At(index)).toBeLessThanOrEqual(0xffff_ffff);
      expect(stream.float01At(index)).toBeGreaterThanOrEqual(0);
      expect(stream.float01At(index)).toBeLessThan(1);
      expect(stream.integerAt(index, -7, 11)).toBeGreaterThanOrEqual(-7);
      expect(stream.integerAt(index, -7, 11)).toBeLessThanOrEqual(11);
    }
  });

  it("rejects invalid counters, integer bounds, seeds, and versions", () => {
    const stream = streamFor();
    for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000]) {
      expect(() => stream.uint32At(invalid)).toThrow(/uint32/i);
    }
    expect(() => stream.integerAt(0, 4, 3)).toThrow(/bounds/i);
    expect(() => createWorldGenerationContext({ worldSeed: -1 })).toThrow(/worldSeed/i);
    expect(() => createWorldGenerationContext({ worldSeed: 0.5 })).toThrow(/worldSeed/i);
    expect(() => createWorldGenerationContext({ worldSeed: Number.NaN })).toThrow(/worldSeed/i);
    expect(() => createWorldGenerationContext({ worldSeed: 0x1_0000_0000 })).toThrow(/worldSeed/i);
    expect(() => createWorldGenerationContext({ worldSeed: 1, generatorVersion: "" })).toThrow(/generatorVersion/i);
  });

  it("registers all 24 canonical shot chunks", () => {
    expect(STORY_CHUNK_IDS).toHaveLength(24);
    expect(STORY_CHUNK_IDS[0]).toBe("S01");
    expect(STORY_CHUNK_IDS[23]).toBe("S24");
    for (const chunkId of STORY_CHUNK_IDS) {
      expect(() => streamFor({ chunkId })).not.toThrow();
    }
  });
});
