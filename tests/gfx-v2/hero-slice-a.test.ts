import { Color, Mesh, MeshPhysicalNodeMaterial, PerspectiveCamera, Scene } from "three/webgpu";
import { describe, expect, it } from "vitest";
import type {
  FeatureInitContext,
  JourneyRenderSnapshot,
  RenderQualityProfile,
  VisualClock,
} from "../../src/gfx/v2/contracts";
import { OceanHeroFeature } from "../../src/gfx/v2/hero";
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
  const feature = new OceanHeroFeature(scene, camera, world);
  return { world, scene, camera, feature, originalBackground };
}

describe("R2-G3 Hero Slice A ocean realization", () => {
  it("preallocates every material and geometry, then shows abundant nature with no human artifact at 12 seconds", async () => {
    const { world, scene, feature } = harness();
    expect(scene.getObjectByName("hero-a:submerged-vehicle")?.visible).toBe(true);
    await feature.initialize({} as FeatureInitContext);
    feature.quality(HIGH);
    feature.update(frame(world, 12), CLOCK);

    const snapshot = feature.snapshot();
    expect(snapshot).toMatchObject({
      state: "ready",
      storyTime: 12,
      shotId: "S03",
      qualityTier: "high",
      humanArtifactsVisible: false,
      protagonistVisible: true,
      pulseTargetVisible: true,
      flowGuideVisible: true,
      visibleFish: 28,
      visibleCoralClusters: 20,
      visibleKelp: 18,
      visibleBubbles: 36,
      allocationsAfterInitialize: 0,
    });
    expect(snapshot.ownedGeometries).toBeGreaterThan(30);
    expect(snapshot.ownedMaterials).toBeGreaterThan(15);
    expect(snapshot.ownedTextures).toBe(2);
    expect(scene.getObjectByName("hero-a:submerged-vehicle")?.visible).toBe(false);
    expect(scene.getObjectByName("hero-a:life-droplet")?.visible).toBe(true);
    expect(scene.getObjectByName("hero-a:pulse-living-target")?.visible).toBe(true);
    const physicalMaterials = new Set<MeshPhysicalNodeMaterial>();
    scene.traverse((object) => {
      if (!(object instanceof Mesh) || Array.isArray(object.material)) return;
      if (object.material instanceof MeshPhysicalNodeMaterial) physicalMaterials.add(object.material);
    });
    expect(physicalMaterials.size).toBeGreaterThanOrEqual(4);
    expect([...physicalMaterials].every((material) => material.transmission === 0)).toBe(true);
  });

  it("uses the exact 18-second boundary and keeps a readable rectilinear empty-seat inventory at 27 seconds", async () => {
    const { world, feature } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.quality(HIGH);

    feature.update(frame(world, 17.999), CLOCK);
    expect(feature.snapshot().humanArtifactsVisible).toBe(false);
    feature.update(frame(world, 18), CLOCK);
    expect(feature.snapshot().humanArtifactsVisible).toBe(true);
    feature.update(frame(world, 27), CLOCK);

    expect(feature.snapshot()).toMatchObject({
      storyTime: 27,
      shotId: "S05",
      humanArtifactsVisible: true,
      pulseTargetVisible: false,
      vehicleModules: 55,
      emptySeats: 5,
      rectangularWindowCells: 7,
      railSegments: 7,
      allocationsAfterInitialize: 0,
    });
    expect(feature.snapshot().visibleCoralClusters).toBeGreaterThanOrEqual(5);
  });

  it("crosses the waterline without changing story ownership or allocating runtime resources", async () => {
    const { world, feature, camera } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.quality(HIGH);
    const initial = feature.snapshot();

    for (let index = 0; index < 120; index += 1) {
      feature.update(frame(world, 37), Object.freeze({
        ...CLOCK,
        frame: index,
        elapsedSeconds: index / 60,
      }));
    }
    const waterline = feature.snapshot();
    expect(waterline).toMatchObject({
      storyTime: 37,
      shotId: "S07",
      humanArtifactsVisible: false,
      waterlineTransition: true,
      protagonistVisible: true,
      allocationsAfterInitialize: 0,
    });
    expect(waterline.ownedGeometries).toBe(initial.ownedGeometries);
    expect(waterline.ownedMaterials).toBe(initial.ownedMaterials);
    expect(waterline.ownedTextures).toBe(initial.ownedTextures);
    expect(camera.position.y).toBeGreaterThan(4.6);
  });

  it("reduces only visual density for fallback and restores the exact High inventory", async () => {
    const { world, feature } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.update(frame(world, 12), CLOCK);
    feature.quality(LOW);
    feature.update(frame(world, 12), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      qualityTier: "low",
      storyTime: 12,
      shotId: "S03",
      humanArtifactsVisible: false,
      visibleFish: 16,
      visibleCoralClusters: 13,
      visibleKelp: 11,
      visibleBubbles: 20,
      allocationsAfterInitialize: 0,
    });

    feature.quality(HIGH);
    feature.update(frame(world, 12), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      qualityTier: "high",
      visibleFish: 28,
      visibleCoralClusters: 20,
      visibleKelp: 18,
      visibleBubbles: 36,
      allocationsAfterInitialize: 0,
    });
  });

  it("removes the shared Hero graph and releases every owned geometry and material exactly once", async () => {
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
    expect(scene.getObjectByName("hero-a:ocean-root")).toBeUndefined();
    expect(scene.background).toBe(originalBackground);
  });
});
