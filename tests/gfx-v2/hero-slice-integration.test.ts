import {
  Color,
  Fog,
  PerspectiveCamera,
  Scene,
} from "three/webgpu";
import { describe, expect, it } from "vitest";
import type {
  FeatureInitContext,
  JourneyRenderSnapshot,
  RenderQualityProfile,
  RenderTwinkleSeedSnapshot,
  VisualClock,
} from "../../src/gfx/v2/contracts";
import {
  ForestCityHeroFeature,
  OceanHeroFeature,
  SpaceTwinkleHeroFeature,
} from "../../src/gfx/v2/hero";
import {
  WORLD_GENERATOR_VERSION,
  createWorldGenerationContext,
  generateWorldPlan,
  type WorldPlan,
} from "../../src/world/v2";

const QUALITY = Object.freeze({
  high: Object.freeze({
    tier: "high",
    pixelRatio: 1.5,
    uploadBudgetMs: 4,
    features: Object.freeze({ temporal: true }),
  }),
  balanced: Object.freeze({
    tier: "balanced",
    pixelRatio: 1,
    uploadBudgetMs: 4,
    features: Object.freeze({ temporal: false }),
  }),
  low: Object.freeze({
    tier: "low",
    pixelRatio: 0.75,
    uploadBudgetMs: 4,
    features: Object.freeze({ temporal: false }),
  }),
}) satisfies Readonly<Record<"high" | "balanced" | "low", Readonly<RenderQualityProfile>>>;

const CLOCK = Object.freeze({
  frame: 1,
  nowMs: 1_000,
  deltaSeconds: 1 / 60,
  elapsedSeconds: 1,
}) satisfies Readonly<VisualClock>;

const PULSES: readonly Readonly<RenderTwinkleSeedSnapshot>[] = Object.freeze([
  Object.freeze({
    id: 1,
    journeyTime: 5,
    x: 0.091_909,
    y: -0.146_463,
    phase: "LIFE" as const,
    source: "player" as const,
    value: 953_532_373,
  }),
  Object.freeze({
    id: 2,
    journeyTime: 39,
    x: 0.94,
    y: 0.749_6,
    phase: "EARTH" as const,
    source: "player" as const,
    value: 1_435_770_856,
  }),
  Object.freeze({
    id: 3,
    journeyTime: 166.4,
    x: -0.94,
    y: 0.94,
    phase: "ANSWER" as const,
    source: "player" as const,
    value: 1_348_556_668,
  }),
]);

function plan(): Readonly<WorldPlan> {
  return generateWorldPlan(createWorldGenerationContext({
    worldSeed: 20_260_818,
    generatorVersion: WORLD_GENERATOR_VERSION,
  }));
}

function frame(world: Readonly<WorldPlan>, storyTime: number): Readonly<JourneyRenderSnapshot> {
  const storyTimeMs = Math.round(storyTime * 1_000);
  const chunk = world.chunks.find((candidate) => (
    storyTimeMs >= candidate.storyNode.startMs
    && (storyTimeMs < candidate.storyNode.endMs || candidate.id === "S24")
  ));
  if (!chunk) throw new Error(`Missing canonical chunk at ${storyTime}.`);
  return Object.freeze({
    seed: Number(world.worldSeed),
    storyTime,
    phase: chunk.storyNode.phase,
    shotId: chunk.id,
    position: Object.freeze({ x: 0, y: 0 }),
    velocity: Object.freeze({ x: 0, y: 0 }),
    pulses: Object.freeze(PULSES.filter((pulse) => pulse.journeyTime <= storyTime)),
    answerAt: storyTime >= 166.400_001 ? 166.400_001 : null,
    finished: storyTime >= 180,
  });
}

describe("R2-G6 three-Hero isolated integration", () => {
  it("runs A, B, and C through one scene without cross-slice resource retention", async () => {
    const world = plan();
    const scene = new Scene();
    const originalBackground = new Color(0x010203);
    const originalFog = new Fog(0x040506, 2, 30);
    scene.background = originalBackground;
    scene.fog = originalFog;
    const baselineChildren = scene.children.length;

    const oceanFrame = frame(world, 12);
    const oceanFrameBefore = JSON.stringify(oceanFrame);
    const ocean = new OceanHeroFeature(scene, new PerspectiveCamera(48, 1, 0.1, 80), world);
    await ocean.initialize({} as FeatureInitContext);
    ocean.update(oceanFrame, CLOCK);
    for (const profile of [QUALITY.high, QUALITY.balanced, QUALITY.low, QUALITY.high]) {
      ocean.quality(profile);
      expect(ocean.snapshot()).toMatchObject({
        storyTime: 12,
        shotId: "S03",
        humanArtifactsVisible: false,
        allocationsAfterInitialize: 0,
      });
    }
    expect(JSON.stringify(oceanFrame)).toBe(oceanFrameBefore);
    const oceanDispose = ocean.dispose();
    expect(ocean.dispose()).toBe(oceanDispose);
    await oceanDispose;
    expect(ocean.snapshot()).toMatchObject({
      state: "disposed",
      ownedGeometries: 0,
      ownedMaterials: 0,
      ownedTextures: 0,
    });
    expect(scene.children).toHaveLength(baselineChildren);
    expect(scene.background).toBe(originalBackground);
    expect(scene.fog).toBe(originalFog);

    const forestFrame = frame(world, 75);
    const forestFrameBefore = JSON.stringify(forestFrame);
    const forest = new ForestCityHeroFeature(
      scene,
      new PerspectiveCamera(48, 1, 0.1, 80),
      world,
    );
    await forest.initialize({} as FeatureInitContext);
    forest.update(forestFrame, CLOCK);
    for (const profile of [QUALITY.high, QUALITY.balanced, QUALITY.low, QUALITY.high]) {
      forest.quality(profile);
      expect(forest.snapshot()).toMatchObject({
        storyTime: 75,
        shotId: "S11",
        cityRuinsVisible: true,
        hydrologyConnected: true,
        safeCorridorClear: true,
        allocationsAfterInitialize: 0,
      });
    }
    expect(JSON.stringify(forestFrame)).toBe(forestFrameBefore);
    const forestDispose = forest.dispose();
    expect(forest.dispose()).toBe(forestDispose);
    await forestDispose;
    expect(forest.snapshot()).toMatchObject({
      state: "disposed",
      ownedGeometries: 0,
      ownedMaterials: 0,
      ownedTextures: 0,
    });
    expect(scene.children).toHaveLength(baselineChildren);
    expect(scene.background).toBe(originalBackground);
    expect(scene.fog).toBe(originalFog);

    const twinkleFrame = frame(world, 176);
    const twinkleFrameBefore = JSON.stringify(twinkleFrame);
    const twinkle = new SpaceTwinkleHeroFeature(
      scene,
      new PerspectiveCamera(48, 1, 0.1, 80),
      world,
    );
    await twinkle.initialize({} as FeatureInitContext);
    twinkle.update(twinkleFrame, CLOCK);
    for (const profile of [QUALITY.high, QUALITY.balanced, QUALITY.low, QUALITY.high]) {
      twinkle.quality(profile);
      expect(twinkle.snapshot()).toMatchObject({
        storyTime: 176,
        shotId: "S23",
        alienRibbonShellCount: 3,
        centralVoidOpen: true,
        twinkleSourceCount: 3,
        ledgerOrderPreserved: true,
        allocationsAfterInitialize: 0,
      });
    }
    expect(JSON.stringify(twinkleFrame)).toBe(twinkleFrameBefore);
    expect(Object.isFrozen(twinkleFrame.pulses)).toBe(true);
    expect(twinkleFrame.pulses.every(Object.isFrozen)).toBe(true);
    const twinkleDispose = twinkle.dispose();
    expect(twinkle.dispose()).toBe(twinkleDispose);
    await twinkleDispose;
    expect(twinkle.snapshot()).toMatchObject({
      state: "disposed",
      ownedGeometries: 0,
      ownedMaterials: 0,
      ownedTextures: 0,
    });
    expect(JSON.stringify(twinkleFrame)).toBe(twinkleFrameBefore);
    expect(scene.children).toHaveLength(baselineChildren);
    expect(scene.background).toBe(originalBackground);
    expect(scene.fog).toBe(originalFog);
  });
});
