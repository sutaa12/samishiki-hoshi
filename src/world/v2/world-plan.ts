import { JOURNEY_SECONDS } from "../../game/model";
import {
  REGISTERED_SEED_SYSTEMS,
  STORY_CHUNK_IDS,
  WORLD_PLAN_GENERATOR_SYSTEMS,
  type CanonicalWorldGenerationContext,
  type SeedStreamRegistry,
  type StoryChunkId,
  type StoryMotifKind,
  type WorldAtmosphereDescriptor,
  type WorldAlienPresence,
  type WorldChunkPlan,
  type WorldEcologyDescriptor,
  type WorldEncounterPlan,
  type WorldFloraDescriptor,
  type WorldFlowBranchPlan,
  type WorldFlowSegmentPlan,
  type WorldHydrologyPlan,
  type WorldPlan,
  type WorldPlanGeneratorSystem,
  type WorldPointMm,
  type WorldSphereBlockerPlan,
  type WorldSpaceDescriptor,
  type WorldStoryNodePlan,
  type WorldTerrainDescriptor,
  type WorldTwinklePolicy,
  type WorldWaterDescriptor,
} from "./contracts";
import {
  WORLD_MATERIAL_LIBRARY,
  buildAtmosphereDescriptors,
  buildEcologyDescriptors,
  buildFloraDescriptors,
  buildSpaceDescriptors,
  buildTerrainDescriptors,
  buildWaterDescriptors,
  materialFamiliesForChunk,
} from "./descriptors";
import { deepFreeze } from "./immutable";
import { createSeedStreamRegistry } from "./seed-streams";
import { CANONICAL_STORY_MOTIFS, storyScoreEntry } from "./story-score";

const HUMAN_BLOCKING_MOTIFS = new Set<StoryMotifKind>([
  "submerged-rectilinear-vehicle",
  "empty-rectangular-seat",
  "square-observation-frame",
  "rectilinear-city",
  "rectilinear-human-debris",
]);

interface StoryContribution {
  readonly nodesByChunk: Readonly<Record<StoryChunkId, WorldStoryNodePlan>>;
}

interface FlowContribution {
  readonly segmentsByChunk: Readonly<Record<StoryChunkId, WorldFlowSegmentPlan>>;
  readonly branches: readonly WorldFlowBranchPlan[];
  readonly corridorRadiiByChunk: Readonly<Record<StoryChunkId, number>>;
}

interface EncounterSeed {
  readonly id: string;
  readonly kind: WorldEncounterPlan["kind"];
  readonly distanceMm: number;
  readonly authoredRole: "tutorial" | "story";
  readonly centerX: number;
  readonly centerY: number;
  readonly collisionMm: number;
  readonly visibleRingMm: number;
  readonly safeRouteX?: number;
  readonly safeRouteY?: number;
}

interface EncounterContribution {
  readonly seeds: readonly EncounterSeed[];
}

interface HydrologyContribution {
  readonly hydrology: WorldHydrologyPlan;
}

interface BlockerSeed {
  readonly motif: StoryMotifKind;
  readonly radiusMm: number;
  readonly side: -1 | 1;
  readonly extraOffsetMm: number;
}

interface CivilizationContribution {
  readonly blockersByChunk: Readonly<Record<StoryChunkId, readonly BlockerSeed[]>>;
}

interface AlienContribution {
  readonly presenceByChunk: Readonly<Record<StoryChunkId, WorldAlienPresence>>;
  readonly blockersByChunk: Readonly<Record<StoryChunkId, readonly BlockerSeed[]>>;
}

interface TwinkleContribution {
  readonly policy: WorldTwinklePolicy;
}

type ChunkDescriptorRecord<T> = Readonly<Record<StoryChunkId, Readonly<T>>>;

interface PlanContributions {
  readonly story: StoryContribution;
  readonly flow: FlowContribution;
  readonly encounters: EncounterContribution;
  readonly terrain: ChunkDescriptorRecord<WorldTerrainDescriptor>;
  readonly hydrology: HydrologyContribution;
  readonly water: ChunkDescriptorRecord<WorldWaterDescriptor>;
  readonly flora: ChunkDescriptorRecord<WorldFloraDescriptor>;
  readonly ecology: ChunkDescriptorRecord<WorldEcologyDescriptor>;
  readonly atmosphere: ChunkDescriptorRecord<WorldAtmosphereDescriptor>;
  readonly space: ChunkDescriptorRecord<WorldSpaceDescriptor>;
  readonly civilization: CivilizationContribution;
  readonly "alien-ship": AlienContribution;
  readonly twinkle: TwinkleContribution;
}

const ENCOUNTER_DISTANCE_SCHEDULE = Object.freeze([
  { id: "life-node-tutorial", kind: "life-node", distanceMm: 55_000, authoredRole: "tutorial" },
  { id: "gate-tutorial", kind: "gate", distanceMm: 80_000, authoredRole: "tutorial" },
  { id: "gate-life-02", kind: "gate", distanceMm: 120_000, authoredRole: "story" },
  { id: "obstacle-life-01", kind: "obstacle", distanceMm: 140_000, authoredRole: "story" },
  { id: "gate-life-03", kind: "gate", distanceMm: 180_000, authoredRole: "story" },
  { id: "obstacle-life-02", kind: "obstacle", distanceMm: 220_000, authoredRole: "story" },
  { id: "life-node-life-02", kind: "life-node", distanceMm: 240_000, authoredRole: "story" },
  { id: "gate-life-04", kind: "gate", distanceMm: 260_000, authoredRole: "story" },
  { id: "obstacle-life-03", kind: "obstacle", distanceMm: 300_000, authoredRole: "story" },
  { id: "gate-life-05", kind: "gate", distanceMm: 320_000, authoredRole: "story" },
  { id: "life-node-life-03", kind: "life-node", distanceMm: 345_000, authoredRole: "story" },
  { id: "life-node-earth-01", kind: "life-node", distanceMm: 390_000, authoredRole: "story" },
  { id: "life-node-earth-02", kind: "life-node", distanceMm: 484_000, authoredRole: "story" },
  { id: "life-node-ascent-01", kind: "life-node", distanceMm: 880_000, authoredRole: "story" },
  { id: "life-node-solitude-01", kind: "life-node", distanceMm: 1_300_000, authoredRole: "story" },
  { id: "life-node-answer-01", kind: "life-node", distanceMm: 1_610_000, authoredRole: "story" },
  { id: "life-node-answer-02", kind: "life-node", distanceMm: 1_664_000, authoredRole: "story" },
  { id: "life-node-twinkle-01", kind: "life-node", distanceMm: 1_710_000, authoredRole: "story" },
] as const);

function copyPoint(point: WorldPointMm): WorldPointMm {
  return { x: point.x, y: point.y, z: point.z };
}

function storyChunkIdAt(index: number): StoryChunkId {
  const chunkId = STORY_CHUNK_IDS[index];
  if (!chunkId) throw new RangeError(`Missing story chunk at index ${index}.`);
  return chunkId;
}

function buildStoryContribution(chunkOrder: readonly StoryChunkId[]): StoryContribution {
  const nodesByChunk = {} as Record<StoryChunkId, WorldStoryNodePlan>;
  for (const chunkId of chunkOrder) {
    const index = STORY_CHUNK_IDS.indexOf(chunkId);
    const shot = storyScoreEntry(chunkId);
    nodesByChunk[chunkId] = {
      id: `story:${chunkId}`,
      shotId: chunkId,
      index,
      startMs: shot.start * 1000,
      endMs: shot.end * 1000,
      phase: shot.phase,
      biome: shot.biome,
      cue: shot.cue,
      motifs: [...CANONICAL_STORY_MOTIFS[chunkId]],
    };
  }
  return { nodesByChunk };
}

function flowBoundaryPoint(registry: Readonly<SeedStreamRegistry>, index: number): WorldPointMm {
  if (index === 2) return { x: 0, y: -10_000, z: 40_000 };
  const chunkId = storyChunkIdAt(Math.min(index, STORY_CHUNK_IDS.length - 1));
  const stream = registry.stream("flow", chunkId, "corridor");
  return {
    x: stream.integerAt(index * 3, -2400, 2400),
    y: -12_000 + index * 1000 + stream.integerAt(index * 3 + 1, -180, 180),
    z: index * 20_000,
  };
}

function buildFlowContribution(
  registry: Readonly<SeedStreamRegistry>,
  chunkOrder: readonly StoryChunkId[],
): FlowContribution {
  const segmentsByChunk = {} as Record<StoryChunkId, WorldFlowSegmentPlan>;
  const corridorRadiiByChunk = {} as Record<StoryChunkId, number>;
  for (const chunkId of chunkOrder) {
    const index = STORY_CHUNK_IDS.indexOf(chunkId);
    const start = flowBoundaryPoint(registry, index);
    const end = flowBoundaryPoint(registry, index + 1);
    const stream = registry.stream("flow", chunkId, "corridor");
    const tutorialAnchorChunk = chunkId === "S02";
    const middle: WorldPointMm = tutorialAnchorChunk
      ? { x: 0, y: -11_500 + index * 1_000, z: index * 20_000 + 10_000 }
      : {
          x: Math.trunc((start.x + end.x) / 2) + stream.integerAt(100, -240, 240),
          y: Math.trunc((start.y + end.y) / 2) + stream.integerAt(101, -120, 120),
          z: Math.trunc((start.z + end.z) / 2),
        };
    segmentsByChunk[chunkId] = {
      id: `flow:${chunkId}`,
      chunkId,
      points: [copyPoint(start), middle, copyPoint(end)],
    };
    corridorRadiiByChunk[chunkId] = stream.integerAt(102, 3200, 4000);
  }
  const branchChunks = ["S08", "S14"] as const;
  const branches = branchChunks.map((chunkId, index): WorldFlowBranchPlan => {
    const segment = segmentsByChunk[chunkId];
    if (!segment) throw new Error(`Branch segment missing for ${chunkId}.`);
    const [entry, middle, merge] = segment.points;
    if (!entry || !middle || !merge) throw new Error(`Branch points missing for ${chunkId}.`);
    const stream = registry.stream("flow", chunkId, "branches");
    const side = stream.uint32At(0) % 2 === 0 ? -1 : 1;
    return {
      id: `branch:${String(index + 1).padStart(2, "0")}:${chunkId}`,
      chunkId,
      entryPoint: copyPoint(entry),
      branchPoint: {
        x: middle.x + side * stream.integerAt(1, 1200, 2200),
        y: middle.y + stream.integerAt(2, -240, 240),
        z: middle.z,
      },
      mergePoint: copyPoint(merge),
    };
  });
  return { segmentsByChunk, branches, corridorRadiiByChunk };
}

function storyChunkForDistance(distanceMm: number): StoryChunkId {
  const timeMs = Math.trunc(distanceMm / 10);
  for (const chunkId of STORY_CHUNK_IDS) {
    const shot = storyScoreEntry(chunkId);
    if (timeMs >= shot.start * 1000 && timeMs < shot.end * 1000) return chunkId;
  }
  return "S24";
}

function buildEncounterContribution(registry: Readonly<SeedStreamRegistry>): EncounterContribution {
  const seeds = ENCOUNTER_DISTANCE_SCHEDULE.map((entry, index): EncounterSeed => {
    if (entry.authoredRole === "tutorial") {
      return entry.kind === "gate"
        ? { ...entry, centerX: 0, centerY: -700, collisionMm: 450, visibleRingMm: 900 }
        : { ...entry, centerX: 0, centerY: -700, collisionMm: 2_500, visibleRingMm: 10_000 };
    }
    const chunkId = storyChunkForDistance(entry.distanceMm);
    const stream = registry.stream("encounters", chunkId, "placement");
    const cursor = index * 8;
    if (entry.kind === "gate") {
      return {
        ...entry,
        centerX: stream.integerAt(cursor, -600, 600),
        centerY: stream.integerAt(cursor + 1, -800, 200),
        collisionMm: stream.integerAt(cursor + 2, 320, 420),
        visibleRingMm: stream.integerAt(cursor + 3, 850, 1_100),
      };
    }
    if (entry.kind === "obstacle") {
      const side = stream.uint32At(cursor) % 2 === 0 ? -1 : 1;
      const centerX = side * stream.integerAt(cursor + 1, 500, 700);
      const centerY = stream.integerAt(cursor + 2, -600, 200);
      return {
        ...entry,
        centerX,
        centerY,
        collisionMm: stream.integerAt(cursor + 3, 240, 320),
        visibleRingMm: stream.integerAt(cursor + 4, 500, 650),
        safeRouteX: -side * 900,
        safeRouteY: centerY,
      };
    }
    return {
      ...entry,
      centerX: stream.integerAt(cursor, -300, 300),
      centerY: stream.integerAt(cursor + 1, -900, 100),
      collisionMm: stream.integerAt(cursor + 2, 2_200, 2_800),
      visibleRingMm: stream.integerAt(cursor + 3, 9_500, 10_500),
    };
  });
  return { seeds };
}

function interpolatePoint(start: WorldPointMm, end: WorldPointMm, permille: number): WorldPointMm {
  const scale = 1_000;
  return {
    x: Math.round((start.x * (scale - permille) + end.x * permille) / scale),
    y: Math.round((start.y * (scale - permille) + end.y * permille) / scale),
    z: Math.round((start.z * (scale - permille) + end.z * permille) / scale),
  };
}

function encounterWorldPoint(
  segment: Readonly<WorldFlowSegmentPlan>,
  flowPositionPermille: number,
  centerX: number,
  centerY: number,
): WorldPointMm {
  const [start, middle, end] = segment.points;
  if (!start || !middle || !end) throw new Error(`Flow segment ${segment.id} requires three points.`);
  const centerline = flowPositionPermille <= 500
    ? interpolatePoint(start, middle, flowPositionPermille * 2)
    : interpolatePoint(middle, end, (flowPositionPermille - 500) * 2);
  return { x: centerline.x + centerX, y: centerline.y + centerY, z: centerline.z };
}

function realizeEncounters(
  contribution: Readonly<EncounterContribution>,
  story: Readonly<StoryContribution>,
  flow: Readonly<FlowContribution>,
): readonly WorldEncounterPlan[] {
  return contribution.seeds.map((seed): WorldEncounterPlan => {
    const chunkId = storyChunkForDistance(seed.distanceMm);
    const node = story.nodesByChunk[chunkId];
    const segment = flow.segmentsByChunk[chunkId];
    if (!node || !segment) throw new Error(`Encounter ${seed.id} cannot resolve ${chunkId}.`);
    const timeMs = Math.trunc(seed.distanceMm / 10);
    const durationMs = node.endMs - node.startMs;
    const flowPositionPermille = Math.max(0, Math.min(1_000,
      Math.round(((timeMs - node.startMs) * 1_000) / durationMs),
    ));
    const base = {
      id: seed.id,
      kind: seed.kind,
      chunkId,
      distanceMm: seed.distanceMm,
      flowPositionPermille,
      centerOffsetMm: { x: seed.centerX, y: seed.centerY },
      worldPoint: encounterWorldPoint(segment, flowPositionPermille, seed.centerX, seed.centerY),
      previewDistanceMm: 18_000,
      radii: { collisionMm: seed.collisionMm, visibleRingMm: seed.visibleRingMm },
      authoredRole: seed.authoredRole,
    } as const;
    if (seed.kind === "gate") return { ...base, kind: "gate" };
    if (seed.kind === "life-node") return { ...base, kind: "life-node" };
    if (seed.safeRouteX === undefined || seed.safeRouteY === undefined) {
      throw new Error(`Obstacle ${seed.id} is missing its safe route.`);
    }
    return { ...base, kind: "obstacle", safeRouteOffsetMm: { x: seed.safeRouteX, y: seed.safeRouteY } };
  });
}

function buildHydrologyContribution(registry: Readonly<SeedStreamRegistry>): HydrologyContribution {
  const stream = registry.stream("hydrology", "S07", "graph");
  const nodeDefinitions = [
    ["rain-catchment", "S07", 17_000 + stream.integerAt(0, 0, 400)],
    ["river-source", "S08", 14_000 + stream.integerAt(1, 0, 300)],
    ["river-reach", "S08", 11_000 + stream.integerAt(2, 0, 250)],
    ["waterfall-lip", "S09", 8_000 + stream.integerAt(3, 0, 200)],
    ["waterfall-pool", "S09", 3_000 + stream.integerAt(4, 0, 150)],
    ["ocean-outlet", "S10", 0],
  ] as const;
  const nodes = nodeDefinitions.map(([id, chunkId, elevationMm]) => ({
    id,
    chunkId,
    elevationMm,
    required: true,
  }));
  const edgeKinds = ["rainfall", "river", "river", "waterfall", "outlet"] as const;
  const edges = edgeKinds.map((kind, index) => {
    const from = nodes[index];
    const to = nodes[index + 1];
    if (!from || !to) throw new Error("Hydrology edge endpoints are incomplete.");
    return {
      id: `hydrology:${String(index + 1).padStart(2, "0")}`,
      from: from.id,
      to: to.id,
      kind,
      dropMm: from.elevationMm - to.elevationMm,
    };
  });
  return {
    hydrology: {
      sourceNodeId: "rain-catchment",
      outletNodeId: "ocean-outlet",
      nodes,
      edges,
    },
  };
}

function emptyBlockerRecord(): Record<StoryChunkId, BlockerSeed[]> {
  const result = {} as Record<StoryChunkId, BlockerSeed[]>;
  for (const chunkId of STORY_CHUNK_IDS) result[chunkId] = [];
  return result;
}

function buildCivilizationContribution(
  registry: Readonly<SeedStreamRegistry>,
  chunkOrder: readonly StoryChunkId[],
): CivilizationContribution {
  const blockersByChunk = emptyBlockerRecord();
  for (const chunkId of chunkOrder) {
    const stream = registry.stream("civilization", chunkId, "motif");
    CANONICAL_STORY_MOTIFS[chunkId].filter((motif) => HUMAN_BLOCKING_MOTIFS.has(motif)).forEach((motif, index) => {
      blockersByChunk[chunkId].push({
        motif,
        radiusMm: stream.integerAt(index * 3, 700, 1500),
        side: stream.uint32At(index * 3 + 1) % 2 === 0 ? -1 : 1,
        extraOffsetMm: stream.integerAt(index * 3 + 2, 0, 2400),
      });
    });
  }
  return { blockersByChunk };
}

function buildAlienContribution(
  registry: Readonly<SeedStreamRegistry>,
  chunkOrder: readonly StoryChunkId[],
): AlienContribution {
  const presenceByChunk = {} as Record<StoryChunkId, WorldAlienPresence>;
  const blockersByChunk = emptyBlockerRecord();
  for (const chunkId of chunkOrder) {
    const index = STORY_CHUNK_IDS.indexOf(chunkId);
    if (chunkId === "S20") {
      presenceByChunk[chunkId] = {
        kind: "incomplete-peripheral-arcs",
        arcCount: 3,
        complete: false,
        centralVoidVisible: false,
      };
    } else if (index >= STORY_CHUNK_IDS.indexOf("S21")) {
      presenceByChunk[chunkId] = {
        kind: "complete-three-shell-ship",
        shellCount: 3,
        complete: true,
        centralVoid: "open",
        revealAtMs: 161_000,
      };
      const stream = registry.stream("alien-ship", chunkId, "reveal");
      blockersByChunk[chunkId].push({
        motif: "alien-complete-three-shell-ship",
        radiusMm: stream.integerAt(0, 1200, 1800),
        side: stream.uint32At(1) % 2 === 0 ? -1 : 1,
        extraOffsetMm: stream.integerAt(2, 800, 2800),
      });
    } else {
      presenceByChunk[chunkId] = { kind: "absent" };
    }
  }
  return { presenceByChunk, blockersByChunk };
}

function buildTwinkleContribution(): TwinkleContribution {
  return {
    policy: {
      preservesLedgerOrder: true,
      semanticSystem: "twinkle",
      revealStages: [
        { id: "one", startsAtMs: 171_000 },
        { id: "few", startsAtMs: 173_000 },
        { id: "tens", startsAtMs: 175_000 },
        { id: "many", startsAtMs: 177_000 },
      ],
    },
  };
}

function snapshotPermutation<T extends string>(
  supplied: readonly T[] | undefined,
  canonical: readonly T[],
  label: string,
): readonly T[] {
  const snapshot: T[] = [];
  if (supplied === undefined) {
    snapshot.push(...canonical);
  } else {
    for (const entry of supplied) {
      snapshot.push(entry);
      if (snapshot.length > canonical.length) break;
    }
  }
  if (snapshot.length !== canonical.length) {
    throw new RangeError(`${label} must contain every canonical entry exactly once.`);
  }
  const actual = new Set(snapshot);
  if (actual.size !== snapshot.length || canonical.some((entry) => !actual.has(entry))) {
    throw new RangeError(`${label} must be a permutation of its canonical entries.`);
  }
  return Object.freeze(snapshot);
}

function hydrologyNodesByChunk(hydrology: WorldHydrologyPlan): Readonly<Record<StoryChunkId, readonly string[]>> {
  const result = {} as Record<StoryChunkId, string[]>;
  for (const chunkId of STORY_CHUNK_IDS) result[chunkId] = [];
  for (const node of hydrology.nodes) result[node.chunkId].push(node.id);
  return result;
}

function createBlocker(
  chunkId: StoryChunkId,
  index: number,
  seed: BlockerSeed,
  segment: WorldFlowSegmentPlan,
  corridorRadiusMm: number,
): WorldSphereBlockerPlan {
  const middle = segment.points[Math.trunc(segment.points.length / 2)];
  if (!middle) throw new Error(`Flow segment ${segment.id} has no middle point.`);
  const offset = corridorRadiusMm + seed.radiusMm + 16_000 + seed.extraOffsetMm;
  return {
    id: `blocker:${chunkId}:${String(index + 1).padStart(2, "0")}:${seed.motif}`,
    motif: seed.motif,
    kind: "sphere",
    center: {
      x: middle.x + seed.side * offset,
      y: middle.y,
      z: middle.z,
    },
    radiusMm: seed.radiusMm,
  };
}

export interface GenerateWorldPlanOptions {
  readonly generationOrder?: readonly WorldPlanGeneratorSystem[];
  readonly chunkOrder?: readonly StoryChunkId[];
}

export function generateWorldPlan(
  context: Readonly<CanonicalWorldGenerationContext>,
  options: GenerateWorldPlanOptions = {},
): Readonly<WorldPlan> {
  const registry = createSeedStreamRegistry(context);
  const generationOrder = snapshotPermutation(
    options.generationOrder,
    WORLD_PLAN_GENERATOR_SYSTEMS,
    "generationOrder",
  );
  const chunkOrder = snapshotPermutation(options.chunkOrder, STORY_CHUNK_IDS, "chunkOrder");

  const contributions = new Map<WorldPlanGeneratorSystem, unknown>();
  const generators: Readonly<Record<WorldPlanGeneratorSystem, () => unknown>> = {
    story: () => buildStoryContribution(chunkOrder),
    flow: () => buildFlowContribution(registry, chunkOrder),
    encounters: () => buildEncounterContribution(registry),
    terrain: () => buildTerrainDescriptors(registry, chunkOrder),
    hydrology: () => buildHydrologyContribution(registry),
    water: () => buildWaterDescriptors(registry, chunkOrder),
    flora: () => buildFloraDescriptors(registry, chunkOrder),
    ecology: () => buildEcologyDescriptors(registry, chunkOrder),
    atmosphere: () => buildAtmosphereDescriptors(registry, chunkOrder),
    space: () => buildSpaceDescriptors(registry, chunkOrder),
    civilization: () => buildCivilizationContribution(registry, chunkOrder),
    "alien-ship": () => buildAlienContribution(registry, chunkOrder),
    twinkle: buildTwinkleContribution,
  };
  for (const system of generationOrder) contributions.set(system, generators[system]());

  const story = contributions.get("story") as PlanContributions["story"] | undefined;
  const flow = contributions.get("flow") as PlanContributions["flow"] | undefined;
  const encounters = contributions.get("encounters") as PlanContributions["encounters"] | undefined;
  const terrain = contributions.get("terrain") as PlanContributions["terrain"] | undefined;
  const hydrology = contributions.get("hydrology") as PlanContributions["hydrology"] | undefined;
  const water = contributions.get("water") as PlanContributions["water"] | undefined;
  const flora = contributions.get("flora") as PlanContributions["flora"] | undefined;
  const ecology = contributions.get("ecology") as PlanContributions["ecology"] | undefined;
  const atmosphere = contributions.get("atmosphere") as PlanContributions["atmosphere"] | undefined;
  const space = contributions.get("space") as PlanContributions["space"] | undefined;
  const civilization = contributions.get("civilization") as PlanContributions["civilization"] | undefined;
  const alien = contributions.get("alien-ship") as PlanContributions["alien-ship"] | undefined;
  const twinkle = contributions.get("twinkle") as PlanContributions["twinkle"] | undefined;
  if (!story || !flow || !encounters || !terrain || !hydrology || !water || !flora || !ecology
    || !atmosphere || !space || !civilization || !alien || !twinkle) {
    throw new Error("World-plan generation did not produce every required contribution.");
  }

  const hydrologyByChunk = hydrologyNodesByChunk(hydrology.hydrology);
  const generatedChunks = new Map<StoryChunkId, WorldChunkPlan>();
  for (const chunkId of chunkOrder) {
    const storyNode = story.nodesByChunk[chunkId];
    const flowSegment = flow.segmentsByChunk[chunkId];
    const radiusMm = flow.corridorRadiiByChunk[chunkId];
    const terrainDescriptor = terrain[chunkId];
    const waterDescriptor = water[chunkId];
    const floraDescriptor = flora[chunkId];
    const ecologyDescriptor = ecology[chunkId];
    const atmosphereDescriptor = atmosphere[chunkId];
    const spaceDescriptor = space[chunkId];
    if (!storyNode || !flowSegment || radiusMm === undefined || !terrainDescriptor
      || !waterDescriptor || !floraDescriptor || !ecologyDescriptor
      || !atmosphereDescriptor || !spaceDescriptor) {
      throw new Error(`Incomplete canonical contribution for ${chunkId}.`);
    }
    const seeds = [
      ...civilization.blockersByChunk[chunkId],
      ...alien.blockersByChunk[chunkId],
    ];
    generatedChunks.set(chunkId, {
      id: chunkId,
      storyNode,
      flowSegment,
      safeCorridor: {
        flowSegmentId: flowSegment.id,
        radiusMm,
        blockers: seeds.map((seed, blockerIndex) =>
          createBlocker(chunkId, blockerIndex, seed, flowSegment, radiusMm),
        ),
      },
      hydrologyNodeIds: [...hydrologyByChunk[chunkId]],
      alienPresence: alien.presenceByChunk[chunkId],
      environment: {
        terrain: terrainDescriptor,
        water: waterDescriptor,
        flora: floraDescriptor,
        ecology: ecologyDescriptor,
        atmosphere: atmosphereDescriptor,
        space: spaceDescriptor,
        materialFamilies: materialFamiliesForChunk(chunkId, waterDescriptor, floraDescriptor),
      },
    });
  }
  const chunks = STORY_CHUNK_IDS.map((chunkId) => {
    const chunk = generatedChunks.get(chunkId);
    if (!chunk) throw new Error(`Scheduled generation omitted ${chunkId}.`);
    return chunk;
  });

  const plan: WorldPlan = {
    schemaVersion: "lonely-star-world-plan/v1",
    worldSeed: registry.worldSeed,
    generatorVersion: registry.generatorVersion,
    seedContract: {
      derivation: "counter-based-named-ascii-v1",
      worldSeed: registry.worldSeed,
      generatorVersion: registry.generatorVersion,
      registeredSystems: [...REGISTERED_SEED_SYSTEMS],
      tupleFields: ["worldSeed", "systemName", "shotChunk", "generatorVersion", "ownedSubstream"],
    },
    chunks,
    encounters: [...realizeEncounters(encounters, story, flow)],
    authoredBranches: [...flow.branches],
    hydrology: hydrology.hydrology,
    twinklePolicy: twinkle.policy,
    materials: [...WORLD_MATERIAL_LIBRARY],
  };

  const finalNode = plan.chunks[plan.chunks.length - 1]?.storyNode;
  if (!finalNode || finalNode.endMs !== JOURNEY_SECONDS * 1000) {
    throw new Error("World plan does not end at the frozen 180-second boundary.");
  }
  return deepFreeze(plan);
}
