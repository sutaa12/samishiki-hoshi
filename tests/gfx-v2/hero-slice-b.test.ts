import {
  Color,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  NoColorSpace,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
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
      visibleGrassClusters: 144,
      visibleFlowers: 72,
      visibleFireflies: 84,
      visibleSunbeams: 4,
      visibleBirds: 22,
      visibleMistClusters: 20,
      visibleFoamClusters: 32,
      visibleClouds: 12,
      allocationsAfterInitialize: 0,
    });
    expect(feature.snapshot().ownedGeometries).toBeGreaterThan(20);
    expect(feature.snapshot().ownedMaterials).toBeGreaterThan(15);
    expect(feature.snapshot().ownedTextures).toBe(18);
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
    const mappedSurfaces = new Set<MeshStandardNodeMaterial>();
    scene.traverse((object) => {
      if (!(object instanceof Mesh) || Array.isArray(object.material)) return;
      if (object.material instanceof MeshStandardNodeMaterial
        && object.material.map
        && object.material.bumpMap) mappedSurfaces.add(object.material);
    });
    expect(mappedSurfaces.size).toBeGreaterThanOrEqual(5);
    for (const material of mappedSurfaces) {
      expect(material.bumpMap).not.toBe(material.map);
      expect(material.map?.colorSpace).toBe(SRGBColorSpace);
      expect(material.bumpMap?.colorSpace).toBe(NoColorSpace);
    }
    const wetCliff = scene.getObjectByName("hero-b:wet-waterfall-cliff-face");
    expect(wetCliff).toBeInstanceOf(Mesh);
    const wetCliffMaterial = (wetCliff as Mesh).material;
    expect(wetCliffMaterial).toBeInstanceOf(MeshPhysicalNodeMaterial);
    if (wetCliffMaterial instanceof MeshPhysicalNodeMaterial) {
      expect(wetCliffMaterial.bumpMap).not.toBeNull();
      expect(wetCliffMaterial.bumpMap).not.toBe(wetCliffMaterial.map);
      expect(wetCliffMaterial.roughnessMap).toBeNull();
      expect(wetCliffMaterial.roughness).toBeGreaterThan(0);
    }
  });

  it("preallocates layered forest and cloud silhouettes instead of repeating primitive stand-ins", async () => {
    const { scene, feature } = harness();
    await feature.initialize({} as FeatureInitContext);

    const expectedInstances = new Map<string, number>([
      ["hero-b:stable-tree-crowns", 48],
      ["hero-b:tree-crown-lobes-a", 48],
      ["hero-b:tree-crown-lobes-b", 48],
      ["hero-b:tree-crown-lobes-c", 48],
      ["hero-b:tree-crown-lobes-d", 48],
      ["hero-b:tree-leaf-card-layers", 240],
      ["hero-b:tree-branches", 192],
      ["hero-b:tree-contact-shadows", 48],
      ["hero-b:asymmetric-foreground-canopy", 8],
      ["hero-b:overlapping-mid-understory", 20],
      ["hero-b:continuous-distant-canopy-belt", 16],
      ["hero-b:preallocated-life-fireflies", 84],
      ["hero-b:stable-cloud-clusters", 12],
      ["hero-b:cloud-lobes-a", 12],
      ["hero-b:cloud-lobes-b", 12],
    ]);
    for (const [name, count] of expectedInstances) {
      const object = scene.getObjectByName(name);
      expect(object, name).toBeInstanceOf(InstancedMesh);
      if (object instanceof InstancedMesh) expect(object.count, name).toBe(count);
    }
    for (const name of [
      "hero-b:asymmetric-foreground-canopy",
      "hero-b:overlapping-mid-understory",
      "hero-b:continuous-distant-canopy-belt",
    ]) {
      const layer = scene.getObjectByName(name);
      if (layer instanceof InstancedMesh) {
        expect(layer.geometry.name).toBe("hero-b:layered-canopy-mass-geometry");
        expect(layer.geometry.getAttribute("position").count).toBeLessThan(300);
      }
    }

    const sky = scene.getObjectByName("hero-b:sunset-sky-dome");
    expect(sky).toBeInstanceOf(Mesh);
    if (sky instanceof Mesh) {
      expect(sky.geometry.getAttribute("color")?.count).toBeGreaterThan(0);
    }
    const grass = scene.getObjectByName("hero-b:stable-grass-clusters");
    const birds = scene.getObjectByName("hero-b:bird-flow");
    expect(grass).toBeInstanceOf(InstancedMesh);
    expect(birds).toBeInstanceOf(InstancedMesh);
    if (grass instanceof InstancedMesh && birds instanceof InstancedMesh) {
      expect(grass.geometry.getAttribute("position")?.count).toBe(15);
      expect(birds.geometry.getAttribute("position")?.count).toBe(9);
    }
    const cloud = scene.getObjectByName("hero-b:stable-cloud-clusters");
    expect(cloud).toBeInstanceOf(InstancedMesh);
    if (cloud instanceof InstancedMesh && !Array.isArray(cloud.material)) {
      expect(cloud.geometry.type).toBe("BufferGeometry");
      expect(cloud.geometry.name).toBe("hero-b:depth-layered-cloud-billboard-geometry");
      expect(cloud.geometry.getAttribute("position").count).toBe(13);
      expect(cloud.geometry.index?.count).toBe(36);
      expect(cloud.material).toBeInstanceOf(MeshBasicNodeMaterial);
      if (cloud.material instanceof MeshBasicNodeMaterial) {
        expect(cloud.material.alphaMap?.name).toBe("hero-b:waterfall-mist-linear-alpha-mask");
      }
    }
    for (let index = 0; index < 4; index += 1) {
      const beam = scene.getObjectByName(`hero-b:forest-sunbeam:${index}`);
      expect(beam).toBeInstanceOf(Mesh);
      if (beam instanceof Mesh && !Array.isArray(beam.material)) {
        expect(beam.geometry.type).toBe("BufferGeometry");
        expect(beam.geometry.name).toBe(`hero-b:sun-aligned-irregular-beam-geometry:${index}`);
        expect(beam.geometry.getAttribute("position").count).toBe(18);
        expect(beam.geometry.index?.count).toBe(48);
        expect(beam.material).toBeInstanceOf(MeshBasicNodeMaterial);
        if (beam.material instanceof MeshBasicNodeMaterial) {
          expect(beam.material.alphaMap?.name).toBe("hero-b:waterfall-mist-linear-alpha-mask");
        }
      }
    }
    const branches = scene.getObjectByName("hero-b:tree-branches");
    expect(branches).toBeInstanceOf(InstancedMesh);
    if (branches instanceof InstancedMesh) {
      expect(branches.geometry.name).toBe("hero-b:organic-curved-branch-geometry");
      expect(branches.geometry.getAttribute("position").count).toBeGreaterThan(130);
    }
    expect(feature.snapshot()).toMatchObject({
      state: "ready",
      ownedTextures: 18,
      visibleFireflies: 84,
      visibleSunbeams: 4,
      allocationsAfterInitialize: 0,
    });
    expect(scene.getObjectByName("hero-b:connected-waterfall")).toBeDefined();
    expect(scene.getObjectByName("hero-b:upper-feeder-river")).toBeInstanceOf(Mesh);
    const plungePool = scene.getObjectByName("hero-b:waterfall-plunge-pool");
    expect(plungePool).toBeInstanceOf(Mesh);
    if (plungePool instanceof Mesh) {
      expect(plungePool.geometry.type).toBe("BufferGeometry");
      expect(plungePool.geometry.getAttribute("position").count).toBe(66);
      plungePool.geometry.computeBoundingBox();
      const poolBounds = plungePool.geometry.boundingBox;
      expect(poolBounds).not.toBeNull();
      if (poolBounds) {
        expect(poolBounds.max.x - poolBounds.min.x).toBeGreaterThan(7.5);
        expect(poolBounds.max.z - poolBounds.min.z).toBeGreaterThan(4.7);
      }
    }
    expect(scene.getObjectByName("hero-b:waterfall-river-lip-foam")).toBeInstanceOf(Mesh);
    expect(scene.getObjectByName("hero-b:wet-waterfall-cliff-face")).toBeInstanceOf(Mesh);
    expect(scene.getObjectByName("hero-b:waterfall-lip-whitewater")).toBeInstanceOf(Group);
    expect(scene.getObjectByName("hero-b:waterfall-wetness-gradients")).toBeInstanceOf(Group);
    expect(scene.getObjectByName("hero-b:waterfall-impact-plumes")).toBeInstanceOf(Group);
    expect(scene.getObjectByName("hero-b:waterfall-directional-outflow")).toBeInstanceOf(Group);
    const waterfallBreakSteps: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const volume = scene.getObjectByName(`hero-b:waterfall-volume:${index}`);
      expect(volume).toBeInstanceOf(Mesh);
      if (volume instanceof Mesh) {
        expect(volume.geometry.type).toBe("BufferGeometry");
        expect(volume.geometry.getAttribute("position").count).toBe(350);
        expect(volume.geometry.index?.count).toBe(2_088);
        const positions = volume.geometry.getAttribute("position");
        const rowCenterZ = (row: number): number => {
          let center = 0;
          for (let column = 0; column < 7; column += 1) {
            center += positions.getZ(row * 7 + column) / 7;
          }
          return center;
        };
        let maximumStep = 0;
        for (let row = 0; row < 24; row += 1) {
          maximumStep = Math.max(maximumStep, Math.abs(rowCenterZ(row + 1) - rowCenterZ(row)));
        }
        waterfallBreakSteps.push(maximumStep);
        expect(volume.material).toBeInstanceOf(MeshPhysicalNodeMaterial);
        if (volume.material instanceof MeshPhysicalNodeMaterial) {
          expect(volume.material.alphaMap?.name).toBe("hero-b:waterfall-linear-alpha-mask");
          expect(volume.material.alphaMap?.colorSpace).toBe(NoColorSpace);
          expect(volume.material.bumpMap?.name).toBe(
            "hero-b:photoreal-waterfall-flow-texture:bump",
          );
          expect(volume.material.opacity).toBeLessThan(0.9);
        }
      }
      const wetness = scene.getObjectByName(`hero-b:waterfall-wetness-trail:${index}`);
      expect(wetness).toBeInstanceOf(Mesh);
      if (wetness instanceof Mesh) {
        expect(wetness.geometry.getAttribute("color")).toBeDefined();
      }
      expect(scene.getObjectByName(`hero-b:waterfall-lip-whitewater:${index}`)).toBeInstanceOf(Mesh);
      const plume = scene.getObjectByName(`hero-b:waterfall-impact-plume:${index}`);
      expect(plume).toBeInstanceOf(Mesh);
      if (plume instanceof Mesh) {
        expect(plume.geometry.getAttribute("position").count).toBe(20);
        expect(plume.geometry.index?.count).toBe(30);
      }
      const outflow = scene.getObjectByName(`hero-b:waterfall-outflow-foam:${index}`);
      expect(outflow).toBeInstanceOf(Mesh);
      if (outflow instanceof Mesh && !Array.isArray(outflow.material)) {
        expect(outflow.material.alphaMap?.name).toBe("hero-b:waterfall-mist-linear-alpha-mask");
      }
    }
    for (let index = 0; index < 12; index += 1) {
      expect(scene.getObjectByName(`hero-b:waterfall-cliff-rock:${index}`)).toBeInstanceOf(Mesh);
    }
    expect(waterfallBreakSteps.filter((step) => step > 0.09).length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...waterfallBreakSteps) - Math.min(...waterfallBreakSteps)).toBeGreaterThan(0.025);
    for (let index = 0; index < 6; index += 1) {
      const gapRock = scene.getObjectByName(`hero-b:waterfall-gap-rock:${index}`);
      expect(gapRock).toBeInstanceOf(Mesh);
      if (gapRock instanceof Mesh) {
        expect(gapRock.material).toBeInstanceOf(MeshPhysicalNodeMaterial);
        expect(gapRock.geometry.getAttribute("position").count).toBeGreaterThan(1_400);
      }
    }
    const impactFoam = scene.getObjectByName("hero-b:waterfall-impact-foam");
    expect(impactFoam).toBeInstanceOf(InstancedMesh);
    if (impactFoam instanceof InstancedMesh) {
      expect(impactFoam.count).toBe(32);
      expect(impactFoam.geometry.type).toBe("BufferGeometry");
      expect(impactFoam.geometry.getAttribute("position").count).toBe(42);
    }

    const streamCenters: Array<Readonly<{ x: number; z: number }>> = [];
    for (let index = 0; index < 4; index += 1) {
      const stream = scene.getObjectByName(`hero-b:waterfall-stream:${index}`);
      expect(stream).toBeInstanceOf(Mesh);
      if (!(stream instanceof Mesh)) continue;
      stream.geometry.computeBoundingBox();
      const bounds = stream.geometry.boundingBox;
      expect(bounds).not.toBeNull();
      if (!bounds) continue;
      streamCenters.push(Object.freeze({
        x: (bounds.min.x + bounds.max.x) * 0.5,
        z: (bounds.min.z + bounds.max.z) * 0.5,
      }));
      expect(stream.geometry.type).toBe("TubeGeometry");
      expect(stream.geometry.getAttribute("position").count).toBe(539);
    }
    expect(streamCenters).toHaveLength(4);
    const depthValues = streamCenters.map(({ z }) => z);
    expect(Math.max(...depthValues) - Math.min(...depthValues)).toBeGreaterThan(0.45);
    const xValues = streamCenters.map(({ x }) => x).sort((left, right) => left - right);
    const gaps = xValues.slice(1).map((value, index) => (
      Math.round((value - xValues[index]!) * 100)
    ));
    expect(new Set(gaps).size).toBeGreaterThan(1);

    const firstStream = scene.getObjectByName("hero-b:waterfall-stream:0");
    expect(firstStream).toBeInstanceOf(Mesh);
    if (firstStream instanceof Mesh) {
      const positions = firstStream.geometry.getAttribute("position");
      const ringRadius = (ring: number): number => {
        let centerX = 0;
        let centerY = 0;
        let centerZ = 0;
        for (let radial = 0; radial < 10; radial += 1) {
          const vertex = ring * 11 + radial;
          centerX += positions.getX(vertex) / 10;
          centerY += positions.getY(vertex) / 10;
          centerZ += positions.getZ(vertex) / 10;
        }
        let radius = 0;
        for (let radial = 0; radial < 10; radial += 1) {
          const vertex = ring * 11 + radial;
          radius += Math.hypot(
            positions.getX(vertex) - centerX,
            positions.getY(vertex) - centerY,
            positions.getZ(vertex) - centerZ,
          ) / 10;
        }
        return radius;
      };
      const topRadius = ringRadius(0);
      const middleRadius = ringRadius(24);
      const impactRadius = ringRadius(48);
      expect(middleRadius).toBeLessThan(topRadius * 0.9);
      expect(middleRadius).toBeLessThan(impactRadius * 0.8);
    }
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
    expect(camera.position.y).toBeCloseTo(3.93, 5);
    expect(camera.position.z).toBeCloseTo(13.55, 5);
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
      visibleGrassClusters: 44,
      visibleFlowers: 22,
      visibleFireflies: 24,
      visibleSunbeams: 2,
      visibleBirds: 10,
      visibleMistClusters: 8,
      visibleFoamClusters: 12,
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
      visibleGrassClusters: 144,
      visibleFlowers: 72,
      visibleFireflies: 84,
      visibleSunbeams: 4,
      visibleBirds: 22,
      visibleMistClusters: 20,
      visibleFoamClusters: 32,
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
