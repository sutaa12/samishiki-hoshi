import {
  Color,
  FogExp2,
  InstancedMesh,
  Mesh,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  NoColorSpace,
  type Object3D,
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

function productionHarness() {
  const world = plan();
  const scene = new Scene();
  const originalBackground = new Color(0x102030);
  const originalFog = new FogExp2(0x304050, 0.021);
  scene.background = originalBackground;
  scene.fog = originalFog;
  const camera = new PerspectiveCamera(60, 1, 0.1, 80);
  camera.position.set(0.25, -0.72, 0.4);
  camera.lookAt(0.1, -0.78, 2.4);
  const feature = new OceanHeroFeature(scene, camera, world, { mode: "production" });
  return { world, scene, camera, feature, originalBackground, originalFog };
}

function humanArtifactObjects(scene: Scene): readonly Object3D[] {
  const root = scene.getObjectByName("hero-a:submerged-vehicle");
  if (!root) throw new Error("Missing Hero A human-artifact root.");
  const objects: Object3D[] = [];
  root.traverse((object) => objects.push(object));
  return objects;
}

function expectHumanArtifactsVisible(scene: Scene, visible: boolean): void {
  const objects = humanArtifactObjects(scene);
  expect(objects).toHaveLength(92);
  for (const object of objects) {
    expect(object.visible, object.name || object.type).toBe(visible);
  }
}

describe("R2-G3 Hero Slice A ocean realization", () => {
  it("preallocates every material and geometry, then shows abundant nature with no human artifact at 12 seconds", async () => {
    const { world, scene, feature } = harness();
    expectHumanArtifactsVisible(scene, false);
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
    expect(snapshot.ownedTextures).toBe(12);
    expectHumanArtifactsVisible(scene, false);
    expect(scene.getObjectByName("hero-a:life-droplet")?.visible).toBe(true);
    expect(scene.getObjectByName("hero-a:pulse-living-target")?.visible).toBe(true);
    const physicalMaterials = new Set<MeshPhysicalNodeMaterial>();
    scene.traverse((object) => {
      if (!(object instanceof Mesh) || Array.isArray(object.material)) return;
      if (object.material instanceof MeshPhysicalNodeMaterial) physicalMaterials.add(object.material);
    });
    expect(physicalMaterials.size).toBeGreaterThanOrEqual(4);
    expect([...physicalMaterials].every((material) => material.transmission === 0)).toBe(true);
    const mappedSurfaces = new Set<MeshStandardNodeMaterial>();
    scene.traverse((object) => {
      if (!(object instanceof Mesh) || Array.isArray(object.material)) return;
      if (object.material instanceof MeshStandardNodeMaterial
        && object.material.map
        && object.material.bumpMap) mappedSurfaces.add(object.material);
    });
    expect(mappedSurfaces.size).toBeGreaterThanOrEqual(8);
    for (const material of mappedSurfaces) {
      expect(material.bumpMap).not.toBe(material.map);
      expect(material.map?.colorSpace).toBe(SRGBColorSpace);
      expect(material.bumpMap?.colorSpace).toBe(NoColorSpace);
      expect(material.roughnessMap).toBeNull();
    }
  });

  it("synchronizes every human-artifact descendant at 18 seconds across quality changes and seek-back", async () => {
    const { world, scene, feature } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.quality(HIGH);

    feature.update(frame(world, 17.999), CLOCK);
    expect(feature.snapshot().humanArtifactsVisible).toBe(false);
    expectHumanArtifactsVisible(scene, false);
    feature.quality(LOW);
    expectHumanArtifactsVisible(scene, false);

    feature.update(frame(world, 18), CLOCK);
    expect(feature.snapshot().humanArtifactsVisible).toBe(true);
    expectHumanArtifactsVisible(scene, true);
    feature.quality(HIGH);
    expectHumanArtifactsVisible(scene, true);

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
    expectHumanArtifactsVisible(scene, true);

    feature.quality(LOW);
    expectHumanArtifactsVisible(scene, true);
    feature.update(frame(world, 12), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      storyTime: 12,
      shotId: "S03",
      qualityTier: "low",
      humanArtifactsVisible: false,
      allocationsAfterInitialize: 0,
    });
    expectHumanArtifactsVisible(scene, false);

    feature.quality(HIGH);
    expectHumanArtifactsVisible(scene, false);
    feature.update(frame(world, 27), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      storyTime: 27,
      shotId: "S05",
      qualityTier: "high",
      humanArtifactsVisible: true,
      allocationsAfterInitialize: 0,
    });
    expectHumanArtifactsVisible(scene, true);
  });

  it("preallocates organic reef silhouettes instead of repeating primitive placeholders", async () => {
    const { scene, feature } = harness();
    await feature.initialize({} as FeatureInitContext);
    const inventory = {
      continuousBranchCorals: 0,
      denseBushCorals: 0,
      volumetricPolypColonies: 0,
      coralPolypInstances: 0,
      coralMounds: 0,
      seaFans: 0,
      seaFanTissues: 0,
      seaFanPolypColonies: 0,
      seaFanPolypInstances: 0,
      tableCorals: 0,
      foregroundReefWalls: 0,
      kelpBlades: 0,
      dorsalFins: 0,
      analFins: 0,
      pectoralFins: 0,
      forkedTails: 0,
      fishEyes: 0,
      causticPatches: 0,
      photorealCoralCards: 0,
      volumetricHazeLayers: 0,
    };
    const fishSpecies = new Set<string>();
    scene.traverse((object) => {
      if (object.name.startsWith("hero-a:continuous-branch-coral:")) {
        inventory.continuousBranchCorals += 1;
      }
      if (object.name.startsWith("hero-a:dense-bush-coral:")) inventory.denseBushCorals += 1;
      if (object.name.startsWith("hero-a:volumetric-coral-polyps:")) {
        inventory.volumetricPolypColonies += 1;
        if (object instanceof InstancedMesh) inventory.coralPolypInstances += object.count;
      }
      if (object.name.startsWith("hero-a:coral-organic-mound:")) inventory.coralMounds += 1;
      if (object.name.startsWith("hero-a:coral-sea-fan:")) inventory.seaFans += 1;
      if (object.name.startsWith("hero-a:coral-sea-fan-tissue:")) inventory.seaFanTissues += 1;
      if (object.name.startsWith("hero-a:sea-fan-edge-polyps:")) {
        inventory.seaFanPolypColonies += 1;
        if (object instanceof InstancedMesh) inventory.seaFanPolypInstances += object.count;
      }
      if (object.name.startsWith("hero-a:coral-table-plate:")) inventory.tableCorals += 1;
      if (object.name.startsWith("hero-a:foreground-reef-wall:")) inventory.foregroundReefWalls += 1;
      if (object.name.startsWith("hero-a:kelp-blade:")) inventory.kelpBlades += 1;
      if (object.name.startsWith("hero-a:fish-dorsal-fin:")) inventory.dorsalFins += 1;
      if (object.name.startsWith("hero-a:fish-anal-fin:")) inventory.analFins += 1;
      if (object.name.startsWith("hero-a:fish-pectoral-fin:")) inventory.pectoralFins += 1;
      if (object.name.startsWith("hero-a:fish-forked-tail:")) inventory.forkedTails += 1;
      if (object.name.startsWith("hero-a:fish-eye:")) inventory.fishEyes += 1;
      if (object.name.startsWith("hero-a:caustic-patch:")) inventory.causticPatches += 1;
      if (object.name.startsWith("hero-a:photoreal-coral-card:")) inventory.photorealCoralCards += 1;
      if (object.name.startsWith("hero-a:volumetric-haze-layer:")) inventory.volumetricHazeLayers += 1;
      if (object.name.startsWith("hero-a:fish-body:")) {
        const species = object.name.split(":").at(-1);
        if (species) fishSpecies.add(species);
      }
    });

    expect(inventory).toEqual({
      continuousBranchCorals: 20,
      denseBushCorals: 20,
      volumetricPolypColonies: 20,
      coralPolypInstances: 536,
      coralMounds: 21,
      seaFans: 7,
      seaFanTissues: 7,
      seaFanPolypColonies: 7,
      seaFanPolypInstances: 84,
      tableCorals: 18,
      foregroundReefWalls: 8,
      kelpBlades: 36,
      dorsalFins: 28,
      analFins: 28,
      pectoralFins: 56,
      forkedTails: 28,
      fishEyes: 0,
      causticPatches: 18,
      photorealCoralCards: 0,
      volumetricHazeLayers: 4,
    });
    expect([...fishSpecies].sort()).toEqual(["species-0", "species-1", "species-2"]);
    expect(scene.getObjectByName("hero-a:water-column-gradient-dome")).toBeInstanceOf(Mesh);
    for (const side of ["left", "right"] as const) {
      const shelf = scene.getObjectByName(`hero-a:organic-reef-shelf:${side}`);
      expect(shelf).toBeInstanceOf(Mesh);
      if (shelf instanceof Mesh) {
        expect(shelf.geometry.getAttribute("position").count).toBe(403);
        expect(shelf.geometry.getAttribute("color")).toBeDefined();
        expect(shelf.geometry.index?.count).toBe(2_160);
      }
    }
    const seaFan = scene.getObjectByName("hero-a:coral-sea-fan:1");
    expect(seaFan).toBeInstanceOf(Mesh);
    const seaFanMaterial = (seaFan as Mesh).material;
    expect(seaFanMaterial).toBeInstanceOf(MeshStandardNodeMaterial);
    expect((seaFanMaterial as MeshStandardNodeMaterial).map?.name).toBe(
      "hero-a:organic-surface-detail-texture",
    );
    if (seaFan instanceof Mesh) {
      const fanPositions = seaFan.geometry.getAttribute("position");
      expect(fanPositions.count).toBeGreaterThan(600);
      let minimumZ = Number.POSITIVE_INFINITY;
      let maximumZ = Number.NEGATIVE_INFINITY;
      let maximumY = Number.NEGATIVE_INFINITY;
      for (let index = 0; index < fanPositions.count; index += 1) {
        minimumZ = Math.min(minimumZ, fanPositions.getZ(index));
        maximumZ = Math.max(maximumZ, fanPositions.getZ(index));
        maximumY = Math.max(maximumY, fanPositions.getY(index));
      }
      expect(maximumZ - minimumZ).toBeGreaterThan(0.15);
      expect(maximumY).toBeLessThan(1.3);
    }
    const seaFanTissue = scene.getObjectByName("hero-a:coral-sea-fan-tissue:1:front");
    expect(seaFanTissue).toBeInstanceOf(Mesh);
    if (seaFanTissue instanceof Mesh) {
      const tissueMaterial = seaFanTissue.material;
      expect(tissueMaterial).toBeInstanceOf(MeshStandardNodeMaterial);
      if (tissueMaterial instanceof MeshStandardNodeMaterial) {
        expect(tissueMaterial.map).toBeNull();
        expect(tissueMaterial.bumpMap?.name).toBe("hero-a:photoreal-coral-cluster-texture:bump");
        expect(tissueMaterial.vertexColors).toBe(true);
        expect(tissueMaterial.alphaTest).toBe(0);
      }
      expect(seaFanTissue.geometry.getAttribute("color")).toBeDefined();
      expect(seaFanTissue.geometry.index?.count).toBeGreaterThan(500);
      const tissuePositions = seaFanTissue.geometry.getAttribute("position");
      expect(tissuePositions.count).toBe(400);
      let minimumZ = Number.POSITIVE_INFINITY;
      let maximumZ = Number.NEGATIVE_INFINITY;
      let maximumY = Number.NEGATIVE_INFINITY;
      let maximumOuterEdgeStep = 0;
      const outerFrontStart = tissuePositions.count - 50;
      for (let index = 0; index < tissuePositions.count; index += 1) {
        minimumZ = Math.min(minimumZ, tissuePositions.getZ(index));
        maximumZ = Math.max(maximumZ, tissuePositions.getZ(index));
        maximumY = Math.max(maximumY, tissuePositions.getY(index));
      }
      for (let spoke = 1; spoke < 25; spoke += 1) {
        const previous = outerFrontStart + (spoke - 1) * 2;
        const current = outerFrontStart + spoke * 2;
        maximumOuterEdgeStep = Math.max(
          maximumOuterEdgeStep,
          Math.abs(tissuePositions.getY(current) - tissuePositions.getY(previous)),
        );
      }
      expect(maximumZ - minimumZ).toBeGreaterThan(0.16);
      expect(maximumY).toBeGreaterThan(1.3);
      expect(maximumOuterEdgeStep).toBeLessThan(0.11);
    }
    const seaFanTissueGeometryIds = new Set<string>();
    scene.traverse((object) => {
      if (object.name.startsWith("hero-a:coral-sea-fan-tissue:") && object instanceof Mesh) {
        seaFanTissueGeometryIds.add(object.geometry.uuid);
      }
    });
    expect(seaFanTissueGeometryIds.size).toBe(7);
    const fanPolyps = scene.getObjectByName("hero-a:sea-fan-edge-polyps:1");
    expect(fanPolyps).toBeInstanceOf(InstancedMesh);
    if (fanPolyps instanceof InstancedMesh) expect(fanPolyps.count).toBe(12);
    const branchCoral = scene.getObjectByName("hero-a:continuous-branch-coral:0");
    expect(branchCoral).toBeInstanceOf(Mesh);
    if (branchCoral instanceof Mesh) {
      expect(branchCoral.geometry.getAttribute("position").count).toBeGreaterThan(250);
      expect(branchCoral.geometry.index?.count).toBeGreaterThan(800);
    }
    const bushCoral = scene.getObjectByName("hero-a:dense-bush-coral:0");
    expect(bushCoral).toBeInstanceOf(Mesh);
    if (bushCoral instanceof Mesh) {
      expect(bushCoral.geometry.getAttribute("position").count).toBeGreaterThan(700);
      expect(bushCoral.geometry.index?.count).toBeGreaterThan(1_500);
    }
    const coralPolyps = scene.getObjectByName("hero-a:volumetric-coral-polyps:0");
    expect(coralPolyps).toBeInstanceOf(InstancedMesh);
    if (coralPolyps instanceof InstancedMesh) {
      expect(coralPolyps.count).toBe(28);
      expect(coralPolyps.geometry.name).toBe("hero-a:branch-attached-coral-polyp-geometry");
      expect(coralPolyps.instanceColor).not.toBeNull();
      const polypPositions = coralPolyps.geometry.getAttribute("position");
      let minimumY = Number.POSITIVE_INFINITY;
      let maximumY = Number.NEGATIVE_INFINITY;
      let maximumRadius = 0;
      for (let index = 0; index < polypPositions.count; index += 1) {
        minimumY = Math.min(minimumY, polypPositions.getY(index));
        maximumY = Math.max(maximumY, polypPositions.getY(index));
        maximumRadius = Math.max(
          maximumRadius,
          Math.hypot(polypPositions.getX(index), polypPositions.getZ(index)),
        );
      }
      expect(maximumY - minimumY).toBeGreaterThan(maximumRadius * 1.8);
    }
    expect(scene.getObjectByName("hero-a:photoreal-coral-card:0:0")).toBeUndefined();
    const fishBody = scene.getObjectByName("hero-a:fish-body:0:species-0");
    expect(fishBody).toBeInstanceOf(Mesh);
    expect(((fishBody as Mesh).material as MeshStandardNodeMaterial).map?.name).toBe(
      "hero-a:photoreal-fish-scale-texture:albedo",
    );
    expect((fishBody as Mesh).geometry.getAttribute("position").count).toBeGreaterThan(500);
    const fishTail = scene.getObjectByName("hero-a:fish-forked-tail:0");
    expect(fishTail).toBeInstanceOf(Mesh);
    if (fishTail instanceof Mesh) {
      expect(fishTail.geometry.index?.count).toBeGreaterThan(30);
    }
    const reefWall = scene.getObjectByName("hero-a:foreground-reef-wall:0");
    expect(reefWall).toBeInstanceOf(Mesh);
    expect(((reefWall as Mesh).geometry.attributes.position?.count ?? 0)).toBeGreaterThan(1_400);
    expect(feature.snapshot()).toMatchObject({
      state: "ready",
      ownedTextures: 12,
      allocationsAfterInitialize: 0,
    });
  });

  it("crosses the waterline without changing story ownership or allocating runtime resources", async () => {
    const { world, scene, feature, camera } = harness();
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
    expect(camera.position.y).toBeGreaterThan(5.2);
    const surface = scene.getObjectByName("hero-a:ocean-surface");
    const sheen = scene.getObjectByName("hero-a:ocean-surface-caustic-sheen");
    expect(surface).toBeInstanceOf(Mesh);
    expect(sheen).toBeInstanceOf(Mesh);
    if (surface instanceof Mesh && sheen instanceof Mesh) {
      expect(sheen.geometry).toBe(surface.geometry);
      surface.geometry.computeBoundingBox();
      const bounds = surface.geometry.boundingBox;
      expect(bounds).not.toBeNull();
      if (bounds) {
        expect(bounds.max.z - bounds.min.z).toBeGreaterThan(0.14);
        expect(bounds.max.z - bounds.min.z).toBeLessThan(0.38);
      }
      const normals = surface.geometry.getAttribute("normal");
      let maximumLateralNormal = 0;
      for (let index = 0; index < normals.count; index += 1) {
        maximumLateralNormal = Math.max(
          maximumLateralNormal,
          Math.abs(normals.getX(index)),
          Math.abs(normals.getY(index)),
        );
      }
      expect(maximumLateralNormal).toBeGreaterThan(0.015);
    }
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

  it("keeps production camera and environment ownership with the journey while exposing canonical LIFE encounters", async () => {
    const { world, scene, camera, feature, originalBackground, originalFog } = productionHarness();
    const before = camera.position.clone();
    await feature.initialize({} as FeatureInitContext);
    feature.update(frame(world, 12), CLOCK);
    const snapshot = feature.snapshot();

    expect(scene.background).toBe(originalBackground);
    expect(scene.fog).toBe(originalFog);
    expect(camera.position).toEqual(before);
    expect(snapshot).toMatchObject({
      mode: "production",
      cameraOwned: false,
      environmentOwned: false,
      whitePointKelvin: 6500,
      encounterCounts: { gate: 5, obstacle: 3, lifeNode: 3 },
      materialFamilyAudit: { natural: 8, concrete: 1, paintedMetal: 2, glass: 1, emissiveAdditive: 6 },
      nonEmissiveBasicMaterialCount: 0,
      pulseTargetVisible: false,
      allocationsAfterInitialize: 0,
    });
    expect(snapshot.encounterInventory).toHaveLength(11);
    for (const encounter of world.encounters.filter((candidate) => candidate.distanceMm < 360_000)) {
      const item = snapshot.encounterInventory.find((candidate) => candidate.id === encounter.id);
      expect(item?.kind).toBe(encounter.kind);
      expect(item?.position.x).toBeCloseTo(encounter.worldPoint.x / 10_000, 8);
      expect(item?.position.y).toBeCloseTo(encounter.worldPoint.y / 10_000, 8);
      expect(item?.position.z).toBeCloseTo(encounter.worldPoint.z / 10_000, 8);
    }
    expect(scene.getObjectByName("hero-a:production:encounter:gate:gate-tutorial")).toBeDefined();
    expect(scene.getObjectByName("hero-a:production:obstacle-solid-spire:obstacle-life-01")).toBeDefined();
    expect(scene.getObjectByName("hero-a:production:life-node-organic-bud:life-node-tutorial")).toBeDefined();

    await feature.dispose();
    expect(scene.background).toBe(originalBackground);
    expect(scene.fog).toBe(originalFog);
  });

  it("keeps every production vehicle descendant absent before 18 seconds and restores the exact reveal on seek", async () => {
    const { world, scene, feature } = productionHarness();
    await feature.initialize({} as FeatureInitContext);
    feature.update(frame(world, 17.999), CLOCK);
    expect(feature.snapshot().humanArtifactsVisible).toBe(false);
    expectHumanArtifactsVisible(scene, false);
    feature.update(frame(world, 18), CLOCK);
    expect(feature.snapshot().humanArtifactsVisible).toBe(true);
    expectHumanArtifactsVisible(scene, true);
    feature.update(frame(world, 12), CLOCK);
    expectHumanArtifactsVisible(scene, false);
  });
});
