import { JOURNEY_SECONDS, SHOT_TABLE } from "../../game/model";
import {
  REGISTERED_SEED_SYSTEMS,
  STORY_CHUNK_IDS,
  WORLD_PLAN_GENERATOR_SYSTEMS,
  type CanonicalWorldGenerationContext,
  type SeedStreamRegistry,
  type StoryChunkId,
  type StoryMotifKind,
  type WorldAlienPresence,
  type WorldChunkPlan,
  type WorldFlowBranchPlan,
  type WorldFlowSegmentPlan,
  type WorldHydrologyPlan,
  type WorldPlan,
  type WorldPlanGeneratorSystem,
  type WorldPointMm,
  type WorldSphereBlockerPlan,
  type WorldStoryNodePlan,
  type WorldTwinklePolicy,
} from "./contracts";
import { deepFreeze } from "./immutable";
import { createSeedStreamRegistry } from "./seed-streams";

const STORY_MOTIFS: Readonly<Record<StoryChunkId, readonly StoryMotifKind[]>> = deepFreeze({
  S01: ["life-source"],
  S02: ["fish-school"],
  S03: ["first-twinkle"],
  S04: ["reef-arch"],
  S05: ["submerged-rectilinear-vehicle", "empty-rectangular-seat", "square-observation-frame"],
  S06: ["empty-rectangular-seat"],
  S07: ["surface-rain"],
  S08: ["river"],
  S09: ["waterfall-forest"],
  S10: ["rectilinear-city"],
  S11: ["empty-rectangular-seat", "square-observation-frame", "amber-line-light"],
  S12: ["square-observation-frame"],
  S13: ["square-observation-frame", "amber-line-light"],
  S14: ["bird-flight"],
  S15: ["aurora"],
  S16: ["living-earth"],
  S17: ["rectilinear-human-debris"],
  S18: ["empty-rectangular-seat", "amber-line-light"],
  S19: ["negative-space"],
  S20: ["alien-incomplete-peripheral-arcs"],
  S21: ["alien-complete-three-shell-ship"],
  S22: ["alien-complete-three-shell-ship", "answering-light"],
  S23: ["alien-complete-three-shell-ship", "life-light-wave"],
  S24: ["alien-complete-three-shell-ship", "formal-title"],
});

const HUMAN_BLOCKING_MOTIFS = new Set<StoryMotifKind>([
  "submerged-rectilinear-vehicle",
  "empty-rectangular-seat",
  "square-observation-frame",
  "rectilinear-city",
  "rectilinear-human-debris",
]);

interface StoryContribution {
  readonly nodes: readonly WorldStoryNodePlan[];
}

interface FlowContribution {
  readonly segments: readonly WorldFlowSegmentPlan[];
  readonly branches: readonly WorldFlowBranchPlan[];
  readonly corridorRadiiMm: readonly number[];
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

interface PlanContributions {
  readonly story: StoryContribution;
  readonly flow: FlowContribution;
  readonly hydrology: HydrologyContribution;
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

function buildStoryContribution(): StoryContribution {
  if (SHOT_TABLE.length !== STORY_CHUNK_IDS.length) {
    throw new Error("The frozen shot score no longer contains exactly 24 entries.");
  }
  const nodes = SHOT_TABLE.map((shot, index): WorldStoryNodePlan => {
    const chunkId = storyChunkIdAt(index);
    if (shot.id !== chunkId) throw new Error(`Frozen shot ${index} is ${shot.id}, expected ${chunkId}.`);
    return {
      id: `story:${chunkId}`,
      shotId: chunkId,
      index,
      startMs: shot.start * 1000,
      endMs: shot.end * 1000,
      phase: shot.phase,
      biome: shot.biome,
      cue: shot.cue,
      motifs: [...STORY_MOTIFS[chunkId]],
    };
  });
  return { nodes };
}

function buildFlowContribution(registry: Readonly<SeedStreamRegistry>): FlowContribution {
  const boundaryPoints: WorldPointMm[] = [];
  for (let index = 0; index <= STORY_CHUNK_IDS.length; index += 1) {
    const chunkId = storyChunkIdAt(Math.min(index, STORY_CHUNK_IDS.length - 1));
    const stream = registry.stream("flow", chunkId, "corridor");
    boundaryPoints.push({
      x: stream.integerAt(index * 3, -2400, 2400),
      y: -12_000 + index * 1000 + stream.integerAt(index * 3 + 1, -180, 180),
      z: index * 20_000,
    });
  }

  const segments = STORY_CHUNK_IDS.map((chunkId, index): WorldFlowSegmentPlan => {
    const start = boundaryPoints[index];
    const end = boundaryPoints[index + 1];
    if (!start || !end) throw new Error(`Flow boundary missing for ${chunkId}.`);
    const stream = registry.stream("flow", chunkId, "corridor");
    const middle: WorldPointMm = {
      x: Math.trunc((start.x + end.x) / 2) + stream.integerAt(100, -240, 240),
      y: Math.trunc((start.y + end.y) / 2) + stream.integerAt(101, -120, 120),
      z: Math.trunc((start.z + end.z) / 2),
    };
    return {
      id: `flow:${chunkId}`,
      chunkId,
      points: [copyPoint(start), middle, copyPoint(end)],
    };
  });

  const corridorRadiiMm = STORY_CHUNK_IDS.map((chunkId) =>
    registry.stream("flow", chunkId, "corridor").integerAt(102, 3200, 4000),
  );
  const branchChunks = ["S08", "S14"] as const;
  const branches = branchChunks.map((chunkId, index): WorldFlowBranchPlan => {
    const chunkIndex = STORY_CHUNK_IDS.indexOf(chunkId);
    const segment = segments[chunkIndex];
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
  return { segments, branches, corridorRadiiMm };
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

function buildCivilizationContribution(registry: Readonly<SeedStreamRegistry>): CivilizationContribution {
  const blockersByChunk = emptyBlockerRecord();
  for (const chunkId of STORY_CHUNK_IDS) {
    const stream = registry.stream("civilization", chunkId, "motif");
    STORY_MOTIFS[chunkId].filter((motif) => HUMAN_BLOCKING_MOTIFS.has(motif)).forEach((motif, index) => {
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

function buildAlienContribution(registry: Readonly<SeedStreamRegistry>): AlienContribution {
  const presenceByChunk = {} as Record<StoryChunkId, WorldAlienPresence>;
  const blockersByChunk = emptyBlockerRecord();
  for (const [index, chunkId] of STORY_CHUNK_IDS.entries()) {
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

function assertGenerationOrder(order: readonly WorldPlanGeneratorSystem[]): void {
  if (order.length !== WORLD_PLAN_GENERATOR_SYSTEMS.length) {
    throw new RangeError("generationOrder must contain every world-plan generator exactly once.");
  }
  const actual = new Set(order);
  if (actual.size !== order.length || WORLD_PLAN_GENERATOR_SYSTEMS.some((system) => !actual.has(system))) {
    throw new RangeError("generationOrder must be a permutation of the registered world-plan generators.");
  }
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
}

export function generateWorldPlan(
  context: Readonly<CanonicalWorldGenerationContext>,
  options: GenerateWorldPlanOptions = {},
): Readonly<WorldPlan> {
  const registry = createSeedStreamRegistry(context);
  const generationOrder = options.generationOrder ?? WORLD_PLAN_GENERATOR_SYSTEMS;
  assertGenerationOrder(generationOrder);

  const contributions = new Map<WorldPlanGeneratorSystem, unknown>();
  const generators: Readonly<Record<WorldPlanGeneratorSystem, () => unknown>> = {
    story: buildStoryContribution,
    flow: () => buildFlowContribution(registry),
    hydrology: () => buildHydrologyContribution(registry),
    civilization: () => buildCivilizationContribution(registry),
    "alien-ship": () => buildAlienContribution(registry),
    twinkle: buildTwinkleContribution,
  };
  for (const system of generationOrder) contributions.set(system, generators[system]());

  const story = contributions.get("story") as PlanContributions["story"] | undefined;
  const flow = contributions.get("flow") as PlanContributions["flow"] | undefined;
  const hydrology = contributions.get("hydrology") as PlanContributions["hydrology"] | undefined;
  const civilization = contributions.get("civilization") as PlanContributions["civilization"] | undefined;
  const alien = contributions.get("alien-ship") as PlanContributions["alien-ship"] | undefined;
  const twinkle = contributions.get("twinkle") as PlanContributions["twinkle"] | undefined;
  if (!story || !flow || !hydrology || !civilization || !alien || !twinkle) {
    throw new Error("World-plan generation did not produce every required contribution.");
  }

  const hydrologyByChunk = hydrologyNodesByChunk(hydrology.hydrology);
  const chunks = STORY_CHUNK_IDS.map((chunkId, index): WorldChunkPlan => {
    const storyNode = story.nodes[index];
    const flowSegment = flow.segments[index];
    const radiusMm = flow.corridorRadiiMm[index];
    if (!storyNode || !flowSegment || radiusMm === undefined) {
      throw new Error(`Incomplete canonical contribution for ${chunkId}.`);
    }
    const seeds = [
      ...civilization.blockersByChunk[chunkId],
      ...alien.blockersByChunk[chunkId],
    ];
    return {
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
    };
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
  };

  const finalNode = plan.chunks[plan.chunks.length - 1]?.storyNode;
  if (!finalNode || finalNode.endMs !== JOURNEY_SECONDS * 1000) {
    throw new Error("World plan does not end at the frozen 180-second boundary.");
  }
  return deepFreeze(plan);
}
