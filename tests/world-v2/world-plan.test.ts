import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JOURNEY_SECONDS, PHASE_WINDOWS, SHOT_TABLE } from "../../src/game/model";
import {
  CANONICAL_STORY_SCORE,
  STORY_CHUNK_IDS,
  WORLD_MATERIAL_FAMILIES,
  WORLD_GENERATOR_VERSION,
  WORLD_PLAN_GENERATOR_SYSTEMS,
  canonicalWorldPlanBytes,
  canonicalWorldPlanJson,
  createWorldGenerationContext,
  createSeedStreamRegistry,
  digestWorldPlan,
  generateWorldPlan,
  validateWorldPlan,
  type StoryChunkId,
  type WorldPlanGeneratorSystem,
} from "../../src/world/v2";
import { assertDeepFrozen, deterministicShuffle, numericLeaves } from "./test-helpers";

function createPlan(
  generationOrder: readonly WorldPlanGeneratorSystem[] = WORLD_PLAN_GENERATOR_SYSTEMS,
  chunkOrder: readonly StoryChunkId[] = STORY_CHUNK_IDS,
) {
  return generateWorldPlan(
    createWorldGenerationContext({ worldSeed: 20_260_818, generatorVersion: WORLD_GENERATOR_VERSION }),
    { generationOrder, chunkOrder },
  );
}

function last<T>(values: readonly T[]): T {
  const value = values[values.length - 1];
  if (value === undefined) throw new Error("Expected a non-empty array.");
  return value;
}

describe("GFX-003 canonical world plan", () => {
  it("uses exactly one canonical story chunk and node for each S01 through S24", () => {
    const plan = createPlan();

    expect(plan.chunks).toHaveLength(24);
    expect(plan.chunks.map((chunk) => chunk.id)).toEqual(STORY_CHUNK_IDS);
    expect(new Set(plan.chunks.map((chunk) => chunk.id)).size).toBe(24);
    expect(plan.chunks.map((chunk) => chunk.storyNode.shotId)).toEqual(STORY_CHUNK_IDS);
    expect(new Set(plan.chunks.map((chunk) => chunk.storyNode.id)).size).toBe(24);

    for (const chunk of plan.chunks) {
      expect(Object.keys(chunk).filter((key) => /hero|shared.*light|lighting/i.test(key))).toEqual([]);
    }
  });

  it("records the complete quality-free named-seed tuple contract", () => {
    const plan = createPlan();
    expect(plan.seedContract).toMatchObject({
      derivation: "counter-based-named-ascii-v1",
      worldSeed: "20260818",
      generatorVersion: WORLD_GENERATOR_VERSION,
      tupleFields: ["worldSeed", "systemName", "shotChunk", "generatorVersion", "ownedSubstream"],
    });
    expect(Object.keys(plan.seedContract).filter((key) => /quality|backend/i.test(key))).toEqual([]);
  });

  it("copies the frozen 24-shot score exactly and covers six phases over 180 seconds", () => {
    const plan = createPlan();
    expect(plan.chunks.map((chunk) => ({
      id: chunk.storyNode.shotId,
      index: chunk.storyNode.index,
      start: chunk.storyNode.startMs / 1000,
      end: chunk.storyNode.endMs / 1000,
      phase: chunk.storyNode.phase,
      biome: chunk.storyNode.biome,
      cue: chunk.storyNode.cue,
    }))).toEqual(CANONICAL_STORY_SCORE.map((shot, index) => ({
      id: shot.id,
      index,
      start: shot.start,
      end: shot.end,
      phase: shot.phase,
      biome: shot.biome,
      cue: shot.cue,
    })));

    expect(plan.chunks[0]?.storyNode.startMs).toBe(0);
    expect(last(plan.chunks).storyNode.endMs).toBe(JOURNEY_SECONDS * 1000);
    for (let index = 1; index < plan.chunks.length; index += 1) {
      expect(plan.chunks[index]?.storyNode.startMs).toBe(plan.chunks[index - 1]?.storyNode.endMs);
    }

    const phaseCounts = Object.fromEntries(Object.keys(PHASE_WINDOWS).map((phase) => [
      phase,
      plan.chunks.filter((chunk) => chunk.storyNode.phase === phase).length,
    ]));
    expect(phaseCounts).toEqual({ LIFE: 6, EARTH: 6, ASCENT: 4, SOLITUDE: 4, ANSWER: 2, TWINKLE: 2 });
  });

  it("keeps S20 to incomplete peripheral arcs and begins the complete ship at S21 / 161 seconds", () => {
    const plan = createPlan();
    const s20 = plan.chunks[19];
    const s21 = plan.chunks[20];

    expect(s20?.id).toBe("S20");
    expect(s20?.alienPresence).toEqual({
      kind: "incomplete-peripheral-arcs",
      arcCount: 3,
      complete: false,
      centralVoidVisible: false,
    });
    expect(s21?.id).toBe("S21");
    expect(s21?.storyNode.startMs).toBe(161_000);
    expect(s21?.alienPresence).toEqual({
      kind: "complete-three-shell-ship",
      shellCount: 3,
      complete: true,
      centralVoid: "open",
      revealAtMs: 161_000,
    });

    expect(plan.chunks.slice(0, 20).some((chunk) => chunk.alienPresence.kind === "complete-three-shell-ship")).toBe(false);
    expect(plan.chunks.find((chunk) => chunk.alienPresence.kind === "complete-three-shell-ship")?.id).toBe("S21");
  });

  it("has contiguous cross-chunk flow segments and matching corridor ownership", () => {
    const plan = createPlan();
    for (let index = 0; index < plan.chunks.length; index += 1) {
      const chunk = plan.chunks[index];
      if (!chunk) throw new Error(`Missing chunk ${index}.`);
      expect(chunk.flowSegment.chunkId).toBe(chunk.id);
      expect(chunk.safeCorridor.flowSegmentId).toBe(chunk.flowSegment.id);
      expect(chunk.flowSegment.points.length).toBeGreaterThanOrEqual(2);
      expect(chunk.safeCorridor.radiusMm).toBeGreaterThan(0);
      if (index > 0) {
        const previous = plan.chunks[index - 1];
        if (!previous) throw new Error(`Missing previous chunk ${index - 1}.`);
        expect(chunk.flowSegment.points[0]).toEqual(last(previous.flowSegment.points));
      }
    }
  });

  it("keeps all canonical numeric leaves finite, non-negative-zero safe integers", () => {
    const plan = createPlan();
    const leaves = numericLeaves(plan);
    expect(leaves.length).toBeGreaterThan(100);
    for (const [path, value] of leaves) {
      expect(Number.isFinite(value), path).toBe(true);
      expect(Number.isSafeInteger(value), path).toBe(true);
      expect(Object.is(value, -0), path).toBe(false);
    }
  });

  it("is deeply immutable", () => {
    assertDeepFrozen(createPlan());
  });

  it("owns deterministic renderer-independent environment and seven-family material descriptors", () => {
    const context = createWorldGenerationContext({
      worldSeed: 20_260_818,
      generatorVersion: WORLD_GENERATOR_VERSION,
    });
    const registry = createSeedStreamRegistry(context);
    const plan = createPlan();

    expect(plan.materials.map((material) => material.family)).toEqual(WORLD_MATERIAL_FAMILIES);
    expect(plan.materials.map((material) => material.id)).toEqual(
      WORLD_MATERIAL_FAMILIES.map((family) => `material:${family}`),
    );
    for (const chunk of plan.chunks) {
      const environment = chunk.environment;
      expect(environment.terrain).toMatchObject({ ownerSystem: "terrain", ownedSubstream: "heightfield" });
      expect(environment.water).toMatchObject({ ownerSystem: "water", ownedSubstream: "surface" });
      expect(environment.flora).toMatchObject({ ownerSystem: "flora", ownedSubstream: "placement" });
      expect(environment.ecology).toMatchObject({ ownerSystem: "ecology", ownedSubstream: "spawns" });
      expect(environment.atmosphere).toMatchObject({ ownerSystem: "atmosphere", ownedSubstream: "field" });
      expect(environment.space).toMatchObject({ ownerSystem: "space", ownedSubstream: "field" });
      expect(environment.terrain.seedFingerprint).toBe(
        registry.stream("terrain", chunk.id, "heightfield").baseSeed,
      );
      expect(environment.water.seedFingerprint).toBe(
        registry.stream("water", chunk.id, "surface").baseSeed,
      );
      expect(environment.flora.seedFingerprint).toBe(
        registry.stream("flora", chunk.id, "placement").baseSeed,
      );
      expect(environment.ecology.seedFingerprint).toBe(
        registry.stream("ecology", chunk.id, "spawns").baseSeed,
      );
      expect(environment.atmosphere.seedFingerprint).toBe(
        registry.stream("atmosphere", chunk.id, "field").baseSeed,
      );
      expect(environment.space.seedFingerprint).toBe(
        registry.stream("space", chunk.id, "field").baseSeed,
      );
      expect(environment.materialFamilies.every((family) => WORLD_MATERIAL_FAMILIES.includes(family))).toBe(true);
    }
  });

  it("produces identical canonical bytes for forward, reverse, and shuffled system and 24-chunk schedules", () => {
    const forward = createPlan(WORLD_PLAN_GENERATOR_SYSTEMS, STORY_CHUNK_IDS);
    const reverse = createPlan(
      [...WORLD_PLAN_GENERATOR_SYSTEMS].reverse(),
      [...STORY_CHUNK_IDS].reverse(),
    );
    const shuffled = createPlan(
      deterministicShuffle(WORLD_PLAN_GENERATOR_SYSTEMS),
      deterministicShuffle(STORY_CHUNK_IDS),
    );

    const forwardBytes = canonicalWorldPlanBytes(forward);
    expect(canonicalWorldPlanBytes(reverse)).toEqual(forwardBytes);
    expect(canonicalWorldPlanBytes(shuffled)).toEqual(forwardBytes);
    expect(canonicalWorldPlanJson(reverse)).toBe(canonicalWorldPlanJson(forward));
    expect(canonicalWorldPlanJson(shuffled)).toBe(canonicalWorldPlanJson(forward));
    expect(digestWorldPlan(reverse)).toBe(digestWorldPlan(forward));
    expect(digestWorldPlan(shuffled)).toBe(digestWorldPlan(forward));
    expect(new TextDecoder().decode(forwardBytes)).toBe(canonicalWorldPlanJson(forward));
  });

  it("captures caller-owned generation and chunk schedules exactly once before execution", () => {
    let generationIterations = 0;
    let chunkIterations = 0;
    const generationOrder = new Proxy([...WORLD_PLAN_GENERATOR_SYSTEMS], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) generationIterations += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const chunkOrder = new Proxy([...STORY_CHUNK_IDS], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) chunkIterations += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const plan = createPlan(generationOrder, chunkOrder);
    generationOrder.reverse();
    chunkOrder.reverse();

    expect(generationIterations).toBe(1);
    expect(chunkIterations).toBe(1);
    expect(canonicalWorldPlanBytes(plan)).toEqual(canonicalWorldPlanBytes(createPlan()));
  });

  it("uses its verified story snapshot after another consumer mutates SHOT_TABLE", () => {
    const baseline = canonicalWorldPlanJson(createPlan());
    const mutableShots = SHOT_TABLE as unknown as Array<{ start: number; end: number; cue: string }>;
    const s06 = mutableShots[5];
    const s07 = mutableShots[6];
    if (!s06 || !s07) throw new Error("Expected mutable source shots S06 and S07.");
    const original = { s06End: s06.end, s07Start: s07.start, cue: s06.cue };
    try {
      s06.end = 37;
      s07.start = 37;
      s06.cue = "mutated-by-another-consumer";
      const regenerated = createPlan();
      expect(canonicalWorldPlanJson(regenerated)).toBe(baseline);
      expect(regenerated.chunks[5]?.storyNode.endMs).toBe(36_000);
      expect(validateWorldPlan(regenerated).valid).toBe(true);
    } finally {
      s06.end = original.s06End;
      s07.start = original.s07Start;
      s06.cue = original.cue;
    }
  });

  it("rejects system or chunk schedules that omit or duplicate canonical entries", () => {
    expect(() => createPlan(WORLD_PLAN_GENERATOR_SYSTEMS.slice(1))).toThrow(/canonical entry|permutation/i);
    expect(() => createPlan([
      ...WORLD_PLAN_GENERATOR_SYSTEMS.slice(0, -1),
      WORLD_PLAN_GENERATOR_SYSTEMS[0],
    ])).toThrow(/canonical entry|permutation/i);
    expect(() => createPlan(WORLD_PLAN_GENERATOR_SYSTEMS, STORY_CHUNK_IDS.slice(1))).toThrow(
      /canonical entry|permutation/i,
    );
    expect(() => createPlan(WORLD_PLAN_GENERATOR_SYSTEMS, [
      ...STORY_CHUNK_IDS.slice(0, -1),
      STORY_CHUNK_IDS[0],
    ])).toThrow(/canonical entry|permutation/i);
  });

  it("pins seed 20260818 to reviewed custom and SHA-256 digests plus byte length", () => {
    const pinnedPlan = createPlan();
    const bytes = canonicalWorldPlanBytes(pinnedPlan);
    expect({
      customDigest: digestWorldPlan(pinnedPlan),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    }).toEqual({
      customDigest: "world-plan-v1:75d93cbb8e0580cd",
      sha256: "4f91cb8393ed54478aa8388600f0329155e0d114fc93b5835305ee9ed7d1642c",
      byteLength: 48_271,
    });
  });
});
