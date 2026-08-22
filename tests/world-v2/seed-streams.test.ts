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
  encounters: "placement",
  terrain: "heightfield",
  hydrology: "graph",
  water: "surface",
  flora: "placement",
  ecology: "spawns",
  atmosphere: "field",
  space: "field",
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
      "encounters",
      "terrain",
      "hydrology",
      "water",
      "flora",
      "ecology",
      "atmosphere",
      "space",
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

  it("snapshots caller-owned context primitives and rejects accessor-backed inputs", () => {
    const mutableContext = {
      worldSeed: 41,
      generatorVersion: WORLD_GENERATOR_VERSION,
    };
    const contextDescriptorReads = new Map<PropertyKey, number>();
    const contextProxy = new Proxy(mutableContext, {
      get() {
        throw new Error("registry context must not use ordinary property reads");
      },
      getOwnPropertyDescriptor(target, property) {
        contextDescriptorReads.set(property, (contextDescriptorReads.get(property) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const registry = createSeedStreamRegistry(contextProxy);
    mutableContext.worldSeed = 42;
    mutableContext.generatorVersion = "gfx003-world-plan-v2";

    const captured = registry.stream("flow", "S08", "corridor");
    expect(registry.worldSeed).toBe("41");
    expect(registry.generatorVersion).toBe(WORLD_GENERATOR_VERSION);
    expect(captured.address.worldSeed).toBe("41");
    expect(captured.address.generatorVersion).toBe(WORLD_GENERATOR_VERSION);
    expect([...contextDescriptorReads.entries()]).toEqual([
      ["worldSeed", 1],
      ["generatorVersion", 1],
    ]);

    let getterCalls = 0;
    const accessorContext = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessorContext, {
      worldSeed: {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 41;
        },
      },
      generatorVersion: {
        enumerable: true,
        value: WORLD_GENERATOR_VERSION,
      },
    });
    expect(() => createSeedStreamRegistry(
      accessorContext as unknown as Parameters<typeof createSeedStreamRegistry>[0],
    )).toThrow(/accessor/i);
    expect(getterCalls).toBe(0);

    expect(() => createWorldGenerationContext(
      accessorContext as unknown as Parameters<typeof createWorldGenerationContext>[0],
    )).toThrow(/accessor/i);
    expect(getterCalls).toBe(0);

    const accessorOptions = {
      worldSeed: 41,
      systemName: "flow",
      chunkId: "S08",
      get generatorVersion() {
        getterCalls += 1;
        return WORLD_GENERATOR_VERSION;
      },
      substream: "corridor",
    };
    expect(() => createSeedStream(
      accessorOptions as unknown as Parameters<typeof createSeedStream>[0],
    )).toThrow(/accessor/i);
    expect(getterCalls).toBe(0);
  });

  it("captures every options data property once without invoking ordinary property reads", () => {
    const descriptorReads = new Map<PropertyKey, number>();
    const options = new Proxy({
      worldSeed: 20_260_818,
      systemName: "flow" as const,
      chunkId: "S08" as const,
      generatorVersion: WORLD_GENERATOR_VERSION,
      substream: "corridor",
    }, {
      get() {
        throw new Error("ordinary property reads are forbidden");
      },
      getOwnPropertyDescriptor(target, property) {
        descriptorReads.set(property, (descriptorReads.get(property) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    const stream = createSeedStream(options);
    expect(stream.address.worldSeed).toBe("20260818");
    expect([...descriptorReads.entries()]).toEqual([
      ["worldSeed", 1],
      ["systemName", 1],
      ["chunkId", 1],
      ["generatorVersion", 1],
      ["substream", 1],
    ]);
  });

  it("separates the known 32-bit address collision with the full multiword state", () => {
    const hydrology = createSeedStream({
      worldSeed: 50_716,
      systemName: "hydrology",
      chunkId: "S20",
      generatorVersion: WORLD_GENERATOR_VERSION,
      substream: "graph",
    });
    const flora = createSeedStream({
      worldSeed: 50_716,
      systemName: "flora",
      chunkId: "S04",
      generatorVersion: WORLD_GENERATOR_VERSION,
    });

    expect(hydrology.address).not.toEqual(flora.address);
    expect(hydrology.baseSeed).not.toBe(flora.baseSeed);
    expect(values(hydrology, 64)).not.toEqual(values(flora, 64));
    expect({
      hydrology: { baseSeed: hydrology.baseSeed, values: values(hydrology, 4) },
      flora: { baseSeed: flora.baseSeed, values: values(flora, 4) },
    }).toEqual({
      hydrology: {
        baseSeed: 3_700_146_828,
        values: [3_328_895_747, 517_454_942, 4_060_427_720, 2_144_698_279],
      },
      flora: {
        baseSeed: 2_053_096_429,
        values: [3_306_658_742, 4_092_893_620, 2_372_072_687, 1_389_801_164],
      },
    });
  });

  it("pins address and counter vectors for cross-runtime determinism", () => {
    const stream = streamFor();
    expect({ baseSeed: stream.baseSeed, values: values(stream, 8) }).toEqual({
      baseSeed: 488_800_234,
      values: [
        549_068_816,
        2_054_472_098,
        1_363_191_026,
        599_199_395,
        1_947_957_952,
        3_098_263_545,
        2_785_762_456,
        2_440_697_353,
      ],
    });
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
    for (const invalid of [-0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000]) {
      expect(() => stream.uint32At(invalid)).toThrow(/uint32/i);
    }
    expect(() => stream.integerAt(0, 4, 3)).toThrow(/bounds/i);
    expect(() => stream.integerAt(0, -0, 1)).toThrow(/bounds/i);
    expect(() => stream.integerAt(0, 0, -0)).toThrow(/bounds/i);
    expect(() => streamFor({ worldSeed: -0 })).toThrow(/worldSeed/i);
    expect(() => createWorldGenerationContext({ worldSeed: -0 })).toThrow(/worldSeed/i);
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
