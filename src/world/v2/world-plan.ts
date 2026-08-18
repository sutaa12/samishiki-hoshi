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
    const middle: WorldPointMm = {
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
  const snapshot = supplied === undefined ? [...canonical] : Array.from(supplied);
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
  const contextSnapshot: CanonicalWorldGenerationContext = Object.freeze({
    worldSeed: context.worldSeed,
    generatorVersion: context.generatorVersion,
  });
  const registry = createSeedStreamRegistry(contextSnapshot);
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
  if (!story || !flow || !terrain || !hydrology || !water || !flora || !ecology
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
