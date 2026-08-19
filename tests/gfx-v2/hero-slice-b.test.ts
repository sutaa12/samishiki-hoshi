import {
  Color,
  Mesh,
  MeshPhysicalNodeMaterial,
  PerspectiveCamera,
  Scene,
} from "three/webgpu";
import { describe, expect, it } from "vitest";
import type {
  FeatureInitContext,
  JourneyRenderSnapshot,
  RenderQualityProfile,
  VisualClock,
} from "../../src/gfx/v2/contracts";
import { ForestCityHeroFeature } from "../../src/gfx/v2/hero";
import {
  WORLD_GENERATOR_VERSION,
  createWorldGenerationContext,
  generateWorldPlan,
  type WorldPlan,
} from "../../src/world/v2";

const HIGH = Object.freeze({
  tier: "high",
  pixelRatio: 1.5,
  uploadBudgetMs: 4,
  features: Object.freeze({ temporal: true }),
}) satisfies Readonly<RenderQualityProfile>;

const LOW = Object.freeze({
  tier: "low",
  pixelRatio: 0.75,
  uploadBudgetMs: 4,
  features: Object.freeze({ temporal: false }),
}) satisfies Readonly<RenderQualityProfile>;

const CLOCK = Object.freeze({
  frame: 1,
  nowMs: 1_000,
  deltaSeconds: 1 / 60,
  elapsedSeconds: 1,
}) satisfies VisualClock;

function plan(): Readonly<WorldPlan> {
  return generateWorldPlan(createWorldGenerationContext({
    worldSeed: 20_260_818,
    generatorVersion: WORLD_GENERATOR_VERSION,
  }));
}

function frame(world: Readonly<WorldPlan>, storyTime: number): Readonly<JourneyRenderSnapshot> {
  const storyTimeMs = Math.round(storyTime * 1000);
  const chunk = world.chunks.find((candidate) => (
    storyTimeMs >= candidate.storyNode.startMs
    && (storyTimeMs < candidate.storyNode.endMs || candidate.id === "S24")
  ));
  if (!chunk) throw new Error(`Missing chunk at ${storyTime}.`);
  return Object.freeze({
    seed: Number(world.worldSeed),
    storyTime,
    phase: chunk.storyNode.phase,
    shotId: chunk.id,
    position: Object.freeze({ x: 0, y: 0 }),
    velocity: Object.freeze({ x: 0, y: 0 }),
    pulses: Object.freeze([]),
    answerAt: null,
    finished: false,
  });
}

function harness() {
  const world = plan();
  const scene = new Scene();
  const originalBackground = new Color(0x010203);
  scene.background = originalBackground;
  const camera = new PerspectiveCamera(48, 1, 0.1, 80);
  const feature = new ForestCityHeroFeature(scene, camera, world);
  return { world, scene, camera, feature, originalBackground };
}

describe("R2-G4 Hero Slice B forest/city realization", () => {
  it("shows the connected river, waterfall, dense forest, and living pulse before any city reveal", async () => {
    const { world, scene, feature } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.quality(HIGH);
    feature.update(frame(world, 58), CLOCK);

    expect(feature.snapshot()).toMatchObject({
      state: "ready",
      storyTime: 58,
      shotId: "S09",
      qualityTier: "high",
      forestPeakVisible: true,
      cityRuinsVisible: false,
      riverVisible: true,
      waterfallVisible: true,
      protagonistVisible: true,
      pulseTargetVisible: true,
      flowGuideVisible: true,
      natureReadsFirst: true,
      safeCorridorClear: true,
      safeCorridorHalfWidth: 2.8,
      storySightlineOpen: true,
      hydrologyConnected: true,
      foliageTemporalStable: true,
      visibleTrees: 48,
      visibleGrassClusters: 72,
      visibleFlowers: 36,
      visibleBirds: 22,
      visibleMistClusters: 20,
      visibleClouds: 12,
      allocationsAfterInitialize: 0,
    });
    expect(feature.snapshot().ownedGeometries).toBeGreaterThan(20);
    expect(feature.snapshot().ownedMaterials).toBeGreaterThan(15);
    expect(feature.snapshot().ownedTextures).toBe(3);
    expect(scene.getObjectByName("hero-b:rectilinear-city")?.visible).toBe(false);
    expect(scene.getObjectByName("hero-b:broken-amber-beacon-light")?.parent?.name).toBe(
      "hero-b:forest-city-root",
    );

    for (const name of [
      "hero-b:stable-tree-crowns",
      "hero-b:stable-grass-clusters",
      "hero-b:forest-flowers",
    ]) {
      const object = scene.getObjectByName(name);
      expect(object).toBeDefined();
      expect(object instanceof Mesh && !Array.isArray(object.material)).toBe(true);
      if (object instanceof Mesh && !Array.isArray(object.material)) {
        expect(object.material.transparent).toBe(false);
      }
    }
    const physicalMaterials = new Set<MeshPhysicalNodeMaterial>();
    scene.traverse((object) => {
      if (!(object instanceof Mesh) || Array.isArray(object.material)) return;
      if (object.material instanceof MeshPhysicalNodeMaterial) physicalMaterials.add(object.material);
    });
    expect(physicalMaterials.size).toBeGreaterThanOrEqual(5);
    expect([...physicalMaterials].every((material) => material.transmission === 0)).toBe(true);
  });

  it("uses the exact 62-second boundary and keeps nature dominant around the empty rectilinear city", async () => {
    const { world, scene, feature } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.quality(HIGH);

    feature.update(frame(world, 61.999), CLOCK);
    expect(feature.snapshot().cityRuinsVisible).toBe(false);
    feature.update(frame(world, 62), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      storyTime: 62,
      shotId: "S10",
      cityRuinsVisible: true,
      natureReadsFirst: true,
      pulseTargetVisible: false,
    });
    feature.update(frame(world, 75), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      storyTime: 75,
      shotId: "S11",
      forestPeakVisible: true,
      cityRuinsVisible: true,
      riverVisible: true,
      waterfallVisible: true,
      natureReadsFirst: true,
      safeCorridorClear: true,
      storySightlineOpen: true,
      hydrologyConnected: true,
      ruinTowers: 8,
      floorSlabs: 36,
      columnGridSegments: 32,
      facadeCells: 48,
      emptyBenchSeats: 3,
      playgroundFrames: 1,
      observationFrames: 1,
      amberBeacons: 1,
      rooftopTrees: 8,
      windowBirds: 8,
      allocationsAfterInitialize: 0,
    });
    expect(scene.getObjectByName("hero-b:empty-rectangular-bench")?.visible).toBe(true);
    expect(scene.getObjectByName("hero-b:square-observation-frame")?.visible).toBe(true);
  });

  it("updates the full 58-to-75-second camera path without allocating a runtime resource", async () => {
    const { world, feature, camera } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.quality(HIGH);
    const initial = feature.snapshot();

    for (let index = 0; index < 180; index += 1) {
      const storyTime = 58 + (17 * index) / 179;
      feature.update(frame(world, storyTime), Object.freeze({
        ...CLOCK,
        frame: index,
        elapsedSeconds: index / 60,
      }));
    }
    const city = feature.snapshot();
    expect(city.allocationsAfterInitialize).toBe(0);
    expect(city.ownedGeometries).toBe(initial.ownedGeometries);
    expect(city.ownedMaterials).toBe(initial.ownedMaterials);
    expect(city.ownedTextures).toBe(initial.ownedTextures);
    expect(city.ownedObjects).toBe(initial.ownedObjects);
    expect(camera.position.x).toBeCloseTo(1.6, 5);
    expect(camera.position.y).toBeCloseTo(5.4, 5);
    expect(camera.position.z).toBeCloseTo(15.75, 5);
  });

  it("reduces only visual density for fallback and restores the exact High inventory", async () => {
    const { world, feature } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.update(frame(world, 75), CLOCK);
    const ownership = feature.snapshot();

    feature.quality(LOW);
    feature.update(frame(world, 75), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      qualityTier: "low",
      storyTime: 75,
      shotId: "S11",
      cityRuinsVisible: true,
      safeCorridorClear: true,
      hydrologyConnected: true,
      visibleTrees: 24,
      visibleGrassClusters: 28,
      visibleFlowers: 14,
      visibleBirds: 10,
      visibleMistClusters: 8,
      visibleClouds: 6,
      allocationsAfterInitialize: 0,
    });
    expect(feature.snapshot()).toMatchObject({
      ownedGeometries: ownership.ownedGeometries,
      ownedMaterials: ownership.ownedMaterials,
      ownedTextures: ownership.ownedTextures,
      ownedObjects: ownership.ownedObjects,
    });

    feature.quality(HIGH);
    feature.update(frame(world, 75), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      qualityTier: "high",
      visibleTrees: 48,
      visibleGrassClusters: 72,
      visibleFlowers: 36,
      visibleBirds: 22,
      visibleMistClusters: 20,
      visibleClouds: 12,
      allocationsAfterInitialize: 0,
    });
  });

  it("removes the Hero graph and releases every owned resource exactly once", async () => {
    const { feature, scene, originalBackground } = harness();
    await feature.initialize({} as FeatureInitContext);
    const first = feature.dispose();
    const concurrent = feature.dispose();
    expect(concurrent).toBe(first);
    await first;
    const later = feature.dispose();
    expect(later).toBe(first);
    await later;

    expect(feature.snapshot()).toMatchObject({
      state: "disposed",
      ownedGeometries: 0,
      ownedMaterials: 0,
      ownedTextures: 0,
      ownedObjects: 0,
    });
    expect(scene.getObjectByName("hero-b:forest-city-root")).toBeUndefined();
    expect(scene.background).toBe(originalBackground);
  });
});
