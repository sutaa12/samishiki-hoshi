import { JOURNEY_SECONDS, SHOT_TABLE } from "../../game/model";
import {
  STORY_CHUNK_IDS,
  type StoryChunkId,
  type WorldHydrologyEdgePlan,
  type WorldHydrologyNodePlan,
  type WorldPlan,
  type WorldPlanIssue,
  type WorldPlanIssueCode,
  type WorldPlanValidationReport,
  type WorldPointMm,
  type WorldSeedRangeValidationReport,
} from "./contracts";
import { deepFreeze } from "./immutable";
import { createWorldGenerationContext } from "./seed-streams";
import { generateWorldPlan } from "./world-plan";

const MAX_VALIDATION_NODES = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPoint(value: unknown): value is WorldPointMm {
  return isRecord(value)
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.z);
}

function samePoint(left: WorldPointMm, right: WorldPointMm): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function pointSegmentDistanceSquared(point: WorldPointMm, start: WorldPointMm, end: WorldPointMm): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  if (lengthSquared === 0) {
    const px = point.x - start.x;
    const py = point.y - start.y;
    const pz = point.z - start.z;
    return px * px + py * py + pz * pz;
  }
  const projection = (
    (point.x - start.x) * dx
    + (point.y - start.y) * dy
    + (point.z - start.z) * dz
  ) / lengthSquared;
  const t = Math.max(0, Math.min(1, projection));
  const nearestX = start.x + dx * t;
  const nearestY = start.y + dy * t;
  const nearestZ = start.z + dz * t;
  const px = point.x - nearestX;
  const py = point.y - nearestY;
  const pz = point.z - nearestZ;
  return px * px + py * py + pz * pz;
}

function inspectNumbers(
  value: unknown,
  path: string,
  add: (code: WorldPlanIssueCode, path: string, detail: string) => void,
): void {
  const active = new Set<object>();
  let visited = 0;

  const visit = (candidate: unknown, candidatePath: string): void => {
    visited += 1;
    if (visited > MAX_VALIDATION_NODES) {
      add("INVALID_STRUCTURE", candidatePath, "Validation node budget exceeded.");
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) add("NON_FINITE_NUMBER", candidatePath, "Number must be finite.");
      if (Object.is(candidate, -0)) add("NEGATIVE_ZERO", candidatePath, "Negative zero is not canonical.");
      return;
    }
    if ((typeof candidate !== "object" && typeof candidate !== "function") || candidate === null) return;
    const object = candidate as object;
    if (active.has(object)) {
      add("INVALID_STRUCTURE", candidatePath, "World plan contains a cycle.");
      return;
    }
    active.add(object);
    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > MAX_VALIDATION_NODES) {
          add("INVALID_STRUCTURE", candidatePath, "Array length exceeds the validation budget.");
          return;
        }
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(candidate, index)) {
            add("INVALID_STRUCTURE", `${candidatePath}[${index}]`, "Sparse array entry.");
            continue;
          }
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor || !("value" in descriptor)) {
            add("INVALID_STRUCTURE", `${candidatePath}[${index}]`, "Accessor entries are not canonical.");
            continue;
          }
          visit(descriptor.value, `${candidatePath}[${index}]`);
        }
      } else {
        for (const key of Object.keys(candidate)) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
          if (!descriptor || !("value" in descriptor)) {
            add("INVALID_STRUCTURE", `${candidatePath}.${key}`, "Accessor properties are not canonical.");
            continue;
          }
          visit(descriptor.value, `${candidatePath}.${key}`);
        }
      }
    } finally {
      active.delete(object);
    }
  };

  visit(value, path);
}

function canReach(
  start: string,
  target: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
): boolean {
  const queue = [start];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    if (current === target) return true;
    seen.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export function validateWorldPlan(value: unknown): Readonly<WorldPlanValidationReport> {
  const issues: WorldPlanIssue[] = [];
  const add = (
    code: WorldPlanIssueCode,
    path: string,
    detail: string,
    chunkId?: StoryChunkId,
  ): void => {
    issues.push({ code, path, detail, ...(chunkId === undefined ? {} : { chunkId }) });
  };

  try {
    inspectNumbers(value, "$", (code, path, detail) => add(code, path, detail));
    if (!isRecord(value)) {
      add("INVALID_STRUCTURE", "$", "World plan must be an object.");
      return deepFreeze({ valid: false, issues });
    }

    const plan = value as unknown as Partial<WorldPlan>;
    if (!Array.isArray(plan.chunks)) {
      add("INVALID_STRUCTURE", "$.chunks", "chunks must be an array.");
      return deepFreeze({ valid: false, issues });
    }
    const chunks = plan.chunks;
    if (chunks.length !== STORY_CHUNK_IDS.length) {
      add("STORY_CHUNK_COUNT", "$.chunks", `Expected 24 story chunks, received ${chunks.length}.`);
    }

    const actualIds = new Set(chunks.map((chunk) => isRecord(chunk) ? chunk.id : undefined));
    for (const chunkId of STORY_CHUNK_IDS) {
      if (!actualIds.has(chunkId)) add("MISSING_STORY_CHUNK", "$.chunks", `Missing ${chunkId}.`, chunkId);
    }

    for (let index = 0; index < Math.min(chunks.length, STORY_CHUNK_IDS.length); index += 1) {
      const expectedId = STORY_CHUNK_IDS[index];
      const expectedShot = SHOT_TABLE[index];
      const chunk = chunks[index];
      const path = `$.chunks[${index}]`;
      if (!expectedId || !expectedShot || !isRecord(chunk)) {
        add("INVALID_STRUCTURE", path, "Chunk must be an object.", expectedId);
        continue;
      }
      if (chunk.id !== expectedId) {
        add("STORY_ORDER", `${path}.id`, `Expected ${expectedId}, received ${String(chunk.id)}.`, expectedId);
      }
      if (!isRecord(chunk.storyNode)) {
        add("INVALID_STRUCTURE", `${path}.storyNode`, "storyNode must be an object.", expectedId);
        continue;
      }
      const storyNode = chunk.storyNode;
      const expectedStartMs = expectedShot.start * 1000;
      const expectedEndMs = expectedShot.end * 1000;
      if (storyNode.shotId !== expectedId || storyNode.id !== `story:${expectedId}` || storyNode.index !== index) {
        add("STORY_NODE_MISMATCH", `${path}.storyNode`, "Story-node identity differs from the frozen score.", expectedId);
      }
      if (storyNode.startMs !== expectedStartMs || storyNode.endMs !== expectedEndMs) {
        add("TIMELINE_GAP", `${path}.storyNode`, "Story-node timing differs from the frozen score.", expectedId);
      }
      if (storyNode.phase !== expectedShot.phase) {
        add("PHASE_MISMATCH", `${path}.storyNode.phase`, `Expected ${expectedShot.phase}.`, expectedId);
      }
      if (storyNode.biome !== expectedShot.biome || storyNode.cue !== expectedShot.cue) {
        add("STORY_NODE_MISMATCH", `${path}.storyNode`, "Biome or cue differs from the frozen score.", expectedId);
      }

      if (!isRecord(chunk.flowSegment) || !Array.isArray(chunk.flowSegment.points)) {
        add("INVALID_STRUCTURE", `${path}.flowSegment`, "Flow segment must contain points.", expectedId);
        continue;
      }
      const flowSegment = chunk.flowSegment;
      const rawPoints = flowSegment.points as unknown[];
      if (flowSegment.id !== `flow:${expectedId}` || flowSegment.chunkId !== expectedId || rawPoints.length < 2) {
        add("SAFE_CORRIDOR_DISCONNECTED", `${path}.flowSegment`, "Flow-segment identity or point count is invalid.", expectedId);
      }
      const points = rawPoints.filter(isPoint);
      if (points.length !== rawPoints.length) {
        add("INVALID_STRUCTURE", `${path}.flowSegment.points`, "Flow points must be finite coordinate objects.", expectedId);
      }
      if (!isRecord(chunk.safeCorridor) || !Array.isArray(chunk.safeCorridor.blockers)) {
        add("INVALID_STRUCTURE", `${path}.safeCorridor`, "Safe corridor must contain blockers.", expectedId);
        continue;
      }
      const corridor = chunk.safeCorridor;
      const blockers = corridor.blockers as unknown[];
      if (corridor.flowSegmentId !== flowSegment.id || !Number.isInteger(corridor.radiusMm) || Number(corridor.radiusMm) <= 0) {
        add("SAFE_CORRIDOR_DISCONNECTED", `${path}.safeCorridor`, "Corridor reference or radius is invalid.", expectedId);
      }
      if (points.length >= 2 && Number.isFinite(corridor.radiusMm)) {
        for (const [blockerIndex, blocker] of blockers.entries()) {
          if (!isRecord(blocker) || blocker.kind !== "sphere" || !isPoint(blocker.center)
            || !Number.isFinite(blocker.radiusMm) || Number(blocker.radiusMm) < 0) {
            add("INVALID_STRUCTURE", `${path}.safeCorridor.blockers[${blockerIndex}]`, "Invalid sphere blocker.", expectedId);
            continue;
          }
          const requiredClearance = Number(corridor.radiusMm) + Number(blocker.radiusMm);
          let minimumDistanceSquared = Number.POSITIVE_INFINITY;
          for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex += 1) {
            const start = points[pointIndex];
            const end = points[pointIndex + 1];
            if (!start || !end) continue;
            minimumDistanceSquared = Math.min(
              minimumDistanceSquared,
              pointSegmentDistanceSquared(blocker.center, start, end),
            );
          }
          if (minimumDistanceSquared <= requiredClearance * requiredClearance) {
            add("SAFE_CORRIDOR_BLOCKED", `${path}.safeCorridor.blockers[${blockerIndex}]`, "Blocker intersects the corridor capsule.", expectedId);
          }
        }
      }

      const nextChunk = chunks[index + 1];
      if (nextChunk && isRecord(nextChunk) && isRecord(nextChunk.flowSegment)
        && Array.isArray(nextChunk.flowSegment.points)) {
        const currentEnd = points[points.length - 1];
        const nextStart = nextChunk.flowSegment.points[0];
        if (!currentEnd || !isPoint(nextStart) || !samePoint(currentEnd, nextStart)) {
          add("SAFE_CORRIDOR_DISCONNECTED", `${path}.flowSegment.points`, "Adjacent chunk endpoints do not match.", expectedId);
        }
      }

      const alien = chunk.alienPresence;
      if (!isRecord(alien)) {
        add("INVALID_STRUCTURE", `${path}.alienPresence`, "Alien presence must be discriminated data.", expectedId);
      } else {
        if (index < STORY_CHUNK_IDS.indexOf("S20") && alien.kind !== "absent") {
          add("ALIEN_REVEAL_EARLY", `${path}.alienPresence`, "Alien geometry appears before S20.", expectedId);
        }
        if (expectedId === "S20") {
          const motifs = Array.isArray(storyNode.motifs) ? storyNode.motifs : [];
          if (alien.kind !== "incomplete-peripheral-arcs" || alien.arcCount !== 3
            || alien.complete !== false || alien.centralVoidVisible !== false
            || motifs.length !== 1 || motifs[0] !== "alien-incomplete-peripheral-arcs") {
            add("ALIEN_S20_INVALID", `${path}.alienPresence`, "S20 must contain only three incomplete peripheral arcs.", expectedId);
          }
        }
        const motifs = Array.isArray(storyNode.motifs) ? storyNode.motifs : [];
        if (index < STORY_CHUNK_IDS.indexOf("S21") && motifs.includes("alien-complete-three-shell-ship")) {
          add("ALIEN_REVEAL_EARLY", `${path}.storyNode.motifs`, "Complete-ship motif begins before S21.", expectedId);
        }
        if (index < STORY_CHUNK_IDS.indexOf("S21") && alien.kind === "complete-three-shell-ship") {
          add("ALIEN_REVEAL_EARLY", `${path}.alienPresence`, "Complete ship begins before S21 / 161 seconds.", expectedId);
        }
        if (index >= STORY_CHUNK_IDS.indexOf("S21")) {
          if (alien.kind !== "complete-three-shell-ship" || alien.shellCount !== 3
            || alien.complete !== true || alien.centralVoid !== "open" || alien.revealAtMs !== 161_000) {
            add("ALIEN_S21_MISSING", `${path}.alienPresence`, "S21 through S24 must retain the complete three-shell ship.", expectedId);
          }
        }
      }
    }

    const firstStart = chunks[0]?.storyNode?.startMs;
    const finalEnd = chunks[chunks.length - 1]?.storyNode?.endMs;
    if (firstStart !== 0 || finalEnd !== JOURNEY_SECONDS * 1000) {
      add("TIMELINE_DURATION", "$.chunks", "Timeline must cover exactly 0 through 180000 milliseconds.");
    }

    if (!Array.isArray(plan.authoredBranches)) {
      add("INVALID_STRUCTURE", "$.authoredBranches", "authoredBranches must be an array.");
    } else {
      if (plan.authoredBranches.length > 2) {
        add("FLOW_BRANCH_LIMIT", "$.authoredBranches", "At most two authored flow branches are allowed.");
      }
      const branchIds = new Set<string>();
      for (const [index, branch] of plan.authoredBranches.entries()) {
        if (!isRecord(branch) || typeof branch.id !== "string" || branchIds.has(branch.id)
          || !(STORY_CHUNK_IDS as readonly unknown[]).includes(branch.chunkId)
          || !isPoint(branch.entryPoint) || !isPoint(branch.branchPoint) || !isPoint(branch.mergePoint)) {
          add("FLOW_BRANCH_INVALID", `$.authoredBranches[${index}]`, "Branch identity, chunk, or points are invalid.");
          continue;
        }
        branchIds.add(branch.id);
      }
    }

    if (!isRecord(plan.hydrology) || !Array.isArray(plan.hydrology.nodes) || !Array.isArray(plan.hydrology.edges)) {
      add("INVALID_STRUCTURE", "$.hydrology", "Hydrology must contain directed nodes and edges.");
    } else {
      const nodes = plan.hydrology.nodes as readonly WorldHydrologyNodePlan[];
      const edges = plan.hydrology.edges as readonly WorldHydrologyEdgePlan[];
      const nodeMap = new Map(nodes.map((node) => [node.id, node]));
      if (nodeMap.size !== nodes.length) {
        add("HYDROLOGY_INVALID_EDGE", "$.hydrology.nodes", "Hydrology node ids must be unique.");
      }
      const adjacency = new Map<string, string[]>();
      for (const node of nodes) adjacency.set(node.id, []);
      for (const [index, edge] of edges.entries()) {
        const from = nodeMap.get(edge.from);
        const to = nodeMap.get(edge.to);
        if (!from || !to) {
          add("HYDROLOGY_INVALID_EDGE", `$.hydrology.edges[${index}]`, "Hydrology edge references a missing node.");
          continue;
        }
        adjacency.get(from.id)?.push(to.id);
        const actualDrop = from.elevationMm - to.elevationMm;
        if (edge.dropMm !== actualDrop || actualDrop <= 0) {
          add("HYDROLOGY_INVALID_DROP", `$.hydrology.edges[${index}]`, "Hydrology edge must descend by its recorded drop.");
        }
        if (edge.kind === "waterfall" && actualDrop < 1000) {
          add("HYDROLOGY_INVALID_DROP", `$.hydrology.edges[${index}]`, "Waterfall requires at least a one-metre drop.");
        }
      }
      const outlet = plan.hydrology.outletNodeId;
      if (!nodeMap.has(plan.hydrology.sourceNodeId) || !nodeMap.has(outlet)) {
        add("HYDROLOGY_DISCONNECTED", "$.hydrology", "Hydrology source or outlet is missing.");
      }
      for (const node of nodes.filter((candidate) => candidate.required)) {
        if (!canReach(plan.hydrology.sourceNodeId, node.id, adjacency)
          || !canReach(node.id, outlet, adjacency)) {
          add("HYDROLOGY_DISCONNECTED", "$.hydrology", `Required node ${node.id} is not on the source-to-outlet path.`);
        }
      }
    }
  } catch (error) {
    add(
      "INVALID_STRUCTURE",
      "$",
      `World-plan validation failed closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return deepFreeze({ valid: issues.length === 0, issues });
}

export function validateWorldSeedRange(seedCount = 1000): Readonly<WorldSeedRangeValidationReport> {
  if (!Number.isInteger(seedCount) || seedCount < 0 || seedCount > 10_000) {
    throw new RangeError("seedCount must be an integer from 0 through 10000.");
  }
  const invalidSeeds: number[] = [];
  const issuesBySeed: Record<string, readonly WorldPlanIssue[]> = {};
  for (let worldSeed = 0; worldSeed < seedCount; worldSeed += 1) {
    const plan = generateWorldPlan(createWorldGenerationContext({ worldSeed }));
    const report = validateWorldPlan(plan);
    if (!report.valid) {
      invalidSeeds.push(worldSeed);
      issuesBySeed[String(worldSeed)] = report.issues;
    }
  }
  return deepFreeze({
    valid: invalidSeeds.length === 0,
    checked: seedCount,
    invalidSeeds,
    issuesBySeed,
  });
}
