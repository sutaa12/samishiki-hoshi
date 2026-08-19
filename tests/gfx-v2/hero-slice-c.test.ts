import {
  Color,
  InstancedMesh,
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
  RenderTwinkleSeedSnapshot,
  VisualClock,
} from "../../src/gfx/v2/contracts";
import { SpaceTwinkleHeroFeature } from "../../src/gfx/v2/hero";
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

function frame(
  world: Readonly<WorldPlan>,
  storyTime: number,
  pulses: readonly Readonly<RenderTwinkleSeedSnapshot>[] = PULSES.filter(
    (pulse) => pulse.journeyTime <= storyTime,
  ),
): Readonly<JourneyRenderSnapshot> {
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
    pulses: Object.freeze([...pulses]),
    answerAt: storyTime >= 166.400_001 ? 166.400_001 : null,
    finished: storyTime >= 180,
  });
}

function harness() {
  const world = plan();
  const scene = new Scene();
  const originalBackground = new Color(0x010203);
  scene.background = originalBackground;
  const camera = new PerspectiveCamera(48, 1, 0.1, 80);
  const feature = new SpaceTwinkleHeroFeature(scene, camera, world);
  return { world, scene, camera, feature, originalBackground };
}

describe("R2-G5 Hero Slice C space/alien/Twinkle realization", () => {
  it("shows seven readable rectilinear human forms and one dying beacon at 142 seconds", async () => {
    const { world, scene, feature } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.quality(HIGH);
    feature.update(frame(world, 142), CLOCK);

    expect(feature.snapshot()).toMatchObject({
      state: "ready",
      storyTime: 142,
      shotId: "S18",
      qualityTier: "high",
      humanDebrisVisible: true,
      humanDebrisForms: 7,
      humanGrammarRectilinear: true,
      solarPanels: 1,
      straightTrusses: 1,
      habitatModules: 1,
      slabRadiators: 1,
      rectangularAirlocks: 1,
      brokenObservationFrames: 1,
      emptyCockpits: 1,
      amberBeaconVisible: true,
      machineReactivated: false,
      nebulaVisible: false,
      peripheralArcsVisible: false,
      peripheralArcCount: 0,
      unknownShipVisible: false,
      alienRibbonShellCount: 0,
      earthVisible: false,
      twinkleStage: "none",
      visibleTwinkles: 0,
      visibleDistantStars: 180,
      allocationsAfterInitialize: 0,
    });
    expect(scene.getObjectByName("hero-c:debris-form-1-square-solar-panel")).toBeDefined();
    expect(scene.getObjectByName("hero-c:debris-form-5-rectangular-airlock")).toBeDefined();
    expect(scene.getObjectByName("hero-c:debris-form-6-broken-square-observation-frame")).toBeDefined();
    expect(scene.getObjectByName("hero-c:debris-form-7-box-empty-cockpit")).toBeDefined();

    feature.update(frame(world, 143), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      amberBeaconVisible: false,
      machineReactivated: false,
    });
  });

  it("keeps S20 to exactly three incomplete peripheral arcs with no full ship or center void", async () => {
    const { world, feature } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.update(frame(world, 158), CLOCK);

    expect(feature.snapshot()).toMatchObject({
      storyTime: 158,
      shotId: "S20",
      humanDebrisVisible: false,
      nebulaVisible: true,
      darkNegativeSpaceClear: true,
      peripheralArcsVisible: true,
      peripheralArcCount: 3,
      peripheralArcsIncomplete: true,
      unknownShipVisible: false,
      alienRibbonShellCount: 0,
      alienRibbonInventory: 3,
      centralVoidOpen: false,
      responseWindowOpen: false,
      earthVisible: false,
      twinkleStage: "none",
      visibleTwinkles: 0,
      allocationsAfterInitialize: 0,
    });

    feature.update(frame(world, 160.999), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      shotId: "S20",
      peripheralArcsVisible: true,
      peripheralArcCount: 3,
      unknownShipVisible: false,
      alienRibbonShellCount: 0,
      centralVoidOpen: false,
    });
    feature.update(frame(world, 161), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      shotId: "S21",
      peripheralArcsVisible: false,
      peripheralArcCount: 0,
      unknownShipVisible: true,
      alienRibbonShellCount: 3,
      centralVoidOpen: true,
    });
  });

  it("reveals exactly three thick closed B-spline ribbons around a real open center at S21", async () => {
    const { world, scene, feature } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.update(frame(world, 166), CLOCK);

    expect(feature.snapshot()).toMatchObject({
      storyTime: 166,
      shotId: "S22",
      peripheralArcsVisible: false,
      peripheralArcCount: 0,
      unknownShipVisible: true,
      alienRibbonShellCount: 3,
      alienRibbonInventory: 3,
      closedBsplineShells: true,
      parallelTransportFrames: true,
      constrainedSuperformulaSections: true,
      ribbonThickness: 0.1,
      centralVoidOpen: true,
      alienUsesHumanGrammar: false,
      alienHasCockpitWindowThrusterOrFront: false,
      responseWindowOpen: true,
      answerReceived: false,
      alienResponseVisible: false,
      allocationsAfterInitialize: 0,
    });
    expect(feature.snapshot().minimumShipVertexRadius).toBeGreaterThan(1.5);
    for (let index = 1; index <= 3; index += 1) {
      expect(scene.getObjectByName(`hero-c:alien-ribbon-shell-${index}`)).toBeDefined();
    }
    expect(scene.getObjectByName("hero-c:alien-ribbon-shell-4")).toBeUndefined();
  });

  it("preallocates layered nebulae, a sparse depth field, and pearl-shaded ribbon surfaces", async () => {
    const { scene, feature } = harness();
    await feature.initialize({} as FeatureInitContext);

    let nebulaLobes = 0;
    let nebulaHalos = 0;
    scene.traverse((object) => {
      if (/^hero-c:peripheral-nebula-\d-lobe-\d$/.test(object.name)) nebulaLobes += 1;
      if (/^hero-c:peripheral-nebula-\d-halo-\d$/.test(object.name)) nebulaHalos += 1;
    });
    expect({ nebulaLobes, nebulaHalos }).toEqual({ nebulaLobes: 16, nebulaHalos: 16 });

    const starfield = scene.getObjectByName("hero-c:distant-starfield");
    expect(starfield).toBeInstanceOf(InstancedMesh);
    if (starfield instanceof InstancedMesh) expect(starfield.count).toBe(180);
    for (let index = 1; index <= 3; index += 1) {
      const shell = scene.getObjectByName(`hero-c:alien-ribbon-shell-${index}`);
      expect(shell).toBeInstanceOf(Mesh);
      if (!(shell instanceof Mesh) || Array.isArray(shell.material)) continue;
      expect(shell.geometry.getAttribute("color")?.count).toBeGreaterThan(0);
      expect(shell.material).toBeInstanceOf(MeshPhysicalNodeMaterial);
      if (shell.material instanceof MeshPhysicalNodeMaterial) {
        expect(shell.material.iridescence).toBeGreaterThan(0.5);
        expect(shell.material.clearcoat).toBe(1);
      }
    }
    const earth = scene.getObjectByName("hero-c:living-earth-sphere");
    expect(earth).toBeInstanceOf(Mesh);
    if (earth instanceof Mesh) {
      expect(earth.geometry.getAttribute("color")?.count).toBeGreaterThan(0);
    }
    expect(feature.snapshot()).toMatchObject({
      state: "ready",
      visibleDistantStars: 180,
      allocationsAfterInitialize: 0,
    });
  });

  it("consumes the immutable ledger in order and stages one, few, tens, then many stable life lights", async () => {
    const { world, feature } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.quality(HIGH);
    const source = PULSES;
    const before = JSON.stringify(source);

    feature.update(frame(world, 171.4, source), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      twinkleStage: "one",
      visibleTwinkles: 1,
      twinkleSourceCount: 3,
      ledgerOrderPreserved: true,
    });
    feature.update(frame(world, 173, source), CLOCK);
    expect(feature.snapshot()).toMatchObject({ twinkleStage: "few", visibleTwinkles: 8 });
    feature.update(frame(world, 175, source), CLOCK);
    expect(feature.snapshot()).toMatchObject({ twinkleStage: "tens", visibleTwinkles: 40 });
    feature.update(frame(world, 176, source), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      storyTime: 176,
      shotId: "S23",
      qualityTier: "high",
      unknownShipVisible: true,
      alienRibbonShellCount: 3,
      centralVoidOpen: true,
      answerReceived: true,
      protagonistVisible: true,
      protagonistWingsOpen: true,
      earthVisible: true,
      twinkleStage: "many",
      visibleTwinkles: 160,
      visibleDistantStars: 180,
      twinkleSourceCount: 3,
      ledgerOrderPreserved: true,
      finalLifeLightsTemporalStable: true,
      allocationsAfterInitialize: 0,
    });
    expect(PULSES).toBe(source);
    expect(JSON.stringify(source)).toBe(before);
    expect(Object.isFrozen(source)).toBe(true);
    expect(source.every(Object.isFrozen)).toBe(true);

    feature.quality(LOW);
    expect(feature.snapshot()).toMatchObject({
      qualityTier: "low",
      alienRibbonShellCount: 3,
      centralVoidOpen: true,
      visibleTwinkles: 64,
      visibleDistantStars: 72,
      allocationsAfterInitialize: 0,
    });
    feature.quality(HIGH);
    expect(feature.snapshot()).toMatchObject({
      visibleTwinkles: 160,
      visibleDistantStars: 180,
    });
  });

  it("keeps the final formal-title state and releases all owned resources once", async () => {
    const { world, scene, feature, originalBackground } = harness();
    await feature.initialize({} as FeatureInitContext);
    feature.update(frame(world, 179), CLOCK);
    expect(feature.snapshot()).toMatchObject({
      storyTime: 179,
      shotId: "S24",
      formalTitleVisible: true,
      unknownShipVisible: true,
      earthVisible: true,
      twinkleStage: "many",
      finalLifeLightsTemporalStable: true,
    });

    const first = feature.dispose();
    const concurrent = feature.dispose();
    expect(concurrent).toBe(first);
    await first;
    expect(scene.background).toBe(originalBackground);
    expect(feature.snapshot()).toMatchObject({
      state: "disposed",
      ownedGeometries: 0,
      ownedMaterials: 0,
      ownedTextures: 0,
    });
    await expect(feature.dispose()).resolves.toBeUndefined();
  });
});
