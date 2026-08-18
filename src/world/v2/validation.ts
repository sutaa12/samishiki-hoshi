import { JOURNEY_SECONDS } from "../../game/model";
import { canonicalJson } from "./canonical";
import {
  STORY_CHUNK_IDS,
  WORLD_MATERIAL_FAMILIES,
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
import { CANONICAL_STORY_MOTIFS, CANONICAL_STORY_SCORE } from "./story-score";
import { generateWorldPlan } from "./world-plan";

const MAX_VALIDATION_NODES = 100_000;
const MAX_VALIDATION_DEPTH = 256;
const MAX_CONTAINER_WIDTH = 50_000;
const MAX_REPORTED_ISSUES = 512;
const MAX_UINT32 = 0xffff_ffff;
const ROOT_KEYS = Object.freeze([
  "schemaVersion",
  "worldSeed",
  "generatorVersion",
  "seedContract",
  "chunks",
  "authoredBranches",
  "hydrology",
  "twinklePolicy",
  "materials",
] as const);
const HYDROLOGY_EDGE_KINDS = new Set(["rainfall", "river", "waterfall", "outlet"]);
const FORBIDDEN_RENDER_KEY = /(?:quality|backend|renderer|webgpu|webgl|gpu-device)/i;

interface StructureInspection {
  readonly fatal: boolean;
  readonly budgetPath?: string;
  readonly budgetDetail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0);
}

function isPoint(value: unknown): value is WorldPointMm {
  return isRecord(value) && isSafeInteger(value.x) && isSafeInteger(value.y) && isSafeInteger(value.z);
}

function samePoint(left: WorldPointMm, right: WorldPointMm): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
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
  const px = point.x - (start.x + dx * t);
  const py = point.y - (start.y + dy * t);
  const pz = point.z - (start.z + dz * t);
  return px * px + py * py + pz * pz;
}

function inspectStructure(
  value: unknown,
  add: (code: WorldPlanIssueCode, path: string, detail: string) => void,
): StructureInspection {
  let visited = 0;
  let fatal = false;
  let budgetPath: string | undefined;
  let budgetDetail: string | undefined;
  const active = new Set<object>();

  const exhaust = (path: string, detail: string): void => {
    if (budgetPath === undefined) {
      budgetPath = path;
      budgetDetail = detail;
    }
  };

  const invalid = (path: string, detail: string): void => {
    fatal = true;
    add("INVALID_STRUCTURE", path, detail);
  };

  const visit = (candidate: unknown, path: string, depth: number): void => {
    if (budgetPath !== undefined) return;
    visited += 1;
    if (visited > MAX_VALIDATION_NODES) {
      exhaust(path, `Validation node count exceeds ${MAX_VALIDATION_NODES}.`);
      return;
    }
    if (depth > MAX_VALIDATION_DEPTH) {
      exhaust(path, `Validation nesting depth exceeds ${MAX_VALIDATION_DEPTH}.`);
      return;
    }
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        add("NON_FINITE_NUMBER", path, "Number must be finite.");
      } else if (!Number.isSafeInteger(candidate)) {
        add("UNSAFE_INTEGER", path, "Canonical world-plan numbers must be safe integers.");
      }
      if (Object.is(candidate, -0)) add("NEGATIVE_ZERO", path, "Negative zero is not canonical.");
      return;
    }
    if (typeof candidate !== "object") {
      invalid(path, `Unsupported canonical value: ${typeof candidate}.`);
      return;
    }

    const object = candidate as object;
    if (active.has(object)) {
      invalid(path, "World plan contains a cycle.");
      return;
    }
    active.add(object);
    try {
      let prototype: object | null;
      try {
        prototype = Reflect.getPrototypeOf(object);
      } catch {
        invalid(path, "Object prototype could not be inspected.");
        return;
      }
      if (Array.isArray(candidate)) {
        if (prototype !== Array.prototype) {
          invalid(path, "Canonical arrays must use Array.prototype.");
          return;
        }
        let lengthDescriptor: PropertyDescriptor | undefined;
        try {
          lengthDescriptor = Reflect.getOwnPropertyDescriptor(candidate, "length");
        } catch {
          invalid(path, "Array length could not be inspected.");
          return;
        }
        if (!lengthDescriptor || !("value" in lengthDescriptor)
          || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
          invalid(path, "Array length must be an own integer data property.");
          return;
        }
        const length = lengthDescriptor.value as number;
        if (length > MAX_CONTAINER_WIDTH) {
          exhaust(path, `Array width exceeds ${MAX_CONTAINER_WIDTH}.`);
          return;
        }
        let keys: readonly (string | symbol)[];
        try {
          keys = Reflect.ownKeys(candidate);
        } catch {
          invalid(path, "Array keys could not be inspected.");
          return;
        }
        if (keys.length !== length + 1) {
          invalid(path, "Canonical arrays must be dense and contain no extra properties.");
        }
        const present = new Set<number>();
        for (const key of keys) {
          if (key === "length") continue;
          if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
            invalid(path, "Canonical arrays cannot contain symbol or named properties.");
            continue;
          }
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
            invalid(`${path}.${key}`, "Array index is outside its canonical length.");
            continue;
          }
          let descriptor: PropertyDescriptor | undefined;
          try {
            descriptor = Reflect.getOwnPropertyDescriptor(candidate, key);
          } catch {
            invalid(`${path}[${index}]`, "Array entry could not be inspected.");
            continue;
          }
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            invalid(`${path}[${index}]`, "Array entries must be enumerable data properties.");
            continue;
          }
          present.add(index);
          visit(descriptor.value, `${path}[${index}]`, depth + 1);
        }
        if (present.size !== length) invalid(path, "Canonical arrays cannot be sparse.");
        return;
      }

      if (prototype !== Object.prototype && prototype !== null) {
        invalid(path, "Canonical objects must use a plain or null prototype.");
        return;
      }
      let keys: readonly (string | symbol)[];
      try {
        keys = Reflect.ownKeys(candidate);
      } catch {
        invalid(path, "Object keys could not be inspected.");
        return;
      }
      if (keys.length > MAX_CONTAINER_WIDTH) {
        exhaust(path, `Object width exceeds ${MAX_CONTAINER_WIDTH}.`);
        return;
      }
      for (const key of keys) {
        if (typeof key !== "string") {
          invalid(path, "Canonical objects cannot contain symbol properties.");
          continue;
        }
        if (FORBIDDEN_RENDER_KEY.test(key)) {
          add("FORBIDDEN_RENDER_INPUT", `${path}.${key}`, "Renderer, quality, and backend facts are non-canonical.");
        }
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Reflect.getOwnPropertyDescriptor(candidate, key);
        } catch {
          invalid(`${path}.${key}`, "Property could not be inspected.");
          continue;
        }
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          invalid(`${path}.${key}`, "Object properties must be enumerable data properties.");
          continue;
        }
        visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
    } finally {
      active.delete(object);
    }
  };

  visit(value, "$", 0);
  return { fatal, ...(budgetPath === undefined ? {} : { budgetPath, budgetDetail }) };
}

function compareShape(
  actual: unknown,
  expected: unknown,
  path: string,
  add: (code: WorldPlanIssueCode, path: string, detail: string) => void,
): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return;
    if (actual.length !== expected.length) {
      add("NON_CANONICAL", path, `Expected ${expected.length} entries, received ${actual.length}.`);
    }
    const length = Math.min(actual.length, expected.length);
    for (let index = 0; index < length; index += 1) {
      compareShape(actual[index], expected[index], `${path}[${index}]`, add);
    }
    return;
  }
  if (!isRecord(expected) || !isRecord(actual)) return;
  const expectedKeys = new Set(Object.keys(expected));
  for (const key of Object.keys(actual)) {
    if (!expectedKeys.has(key)) add("UNEXPECTED_PROPERTY", `${path}.${key}`, "Property is not in the canonical contract.");
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      add("NON_CANONICAL", `${path}.${key}`, "Required canonical property is missing.");
      continue;
    }
    compareShape(actual[key], expected[key], `${path}.${key}`, add);
  }
}

function canReach(start: string, target: string, adjacency: ReadonlyMap<string, readonly string[]>): boolean {
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

function finish(issues: readonly WorldPlanIssue[]): Readonly<WorldPlanValidationReport> {
  return deepFreeze({ valid: issues.length === 0, issues: [...issues] });
}

export function validateWorldPlan(value: unknown): Readonly<WorldPlanValidationReport> {
  const issues: WorldPlanIssue[] = [];
  const add = (
    code: WorldPlanIssueCode,
    path: string,
    detail: string,
    chunkId?: StoryChunkId,
  ): void => {
    if (issues.length >= MAX_REPORTED_ISSUES) return;
    issues.push({ code, path, detail, ...(chunkId === undefined ? {} : { chunkId }) });
  };

  try {
    const structure = inspectStructure(value, (code, path, detail) => add(code, path, detail));
    if (structure.budgetPath !== undefined) {
      return finish([{
        code: "INVALID_STRUCTURE",
        path: structure.budgetPath,
        detail: structure.budgetDetail ?? "Validation budget exceeded.",
      }]);
    }
    if (structure.fatal) return finish(issues);
    if (!isRecord(value)) {
      add("INVALID_STRUCTURE", "$", "World plan must be a plain object.");
      return finish(issues);
    }

    const actualRootKeys = Object.keys(value);
    const expectedRootKeySet = new Set<string>(ROOT_KEYS);
    for (const key of actualRootKeys) {
      if (!expectedRootKeySet.has(key)) add("UNEXPECTED_PROPERTY", `$.${key}`, "Unexpected world-plan root property.");
    }
    for (const key of ROOT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        add("NON_CANONICAL", `$.${key}`, "Required world-plan root property is missing.");
      }
    }

    if (value.schemaVersion !== "lonely-star-world-plan/v1") {
      add("SCHEMA_MISMATCH", "$.schemaVersion", "Expected lonely-star-world-plan/v1.");
    }
    const worldSeedText = value.worldSeed;
    const parsedSeed = typeof worldSeedText === "string" && /^(?:0|[1-9][0-9]{0,9})$/.test(worldSeedText)
      ? Number(worldSeedText)
      : Number.NaN;
    const validSeed = Number.isSafeInteger(parsedSeed)
      && parsedSeed >= 0
      && parsedSeed <= MAX_UINT32
      && String(parsedSeed) === worldSeedText;
    if (!validSeed) add("SEED_CONTRACT_MISMATCH", "$.worldSeed", "worldSeed must be a canonical uint32 decimal string.");
    const generatorVersion = value.generatorVersion;
    const validVersion = typeof generatorVersion === "string"
      && /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(generatorVersion);
    if (!validVersion) {
      add("SEED_CONTRACT_MISMATCH", "$.generatorVersion", "generatorVersion must be a lower-case ASCII token.");
    }

    let expectedPlan: Readonly<WorldPlan> | undefined;
    if (validSeed && validVersion) {
      expectedPlan = generateWorldPlan(createWorldGenerationContext({
        worldSeed: parsedSeed,
        generatorVersion,
      }));
      compareShape(value, expectedPlan, "$", (code, path, detail) => add(code, path, detail));
      if (!canonicalEqual(value.seedContract, expectedPlan.seedContract)) {
        add("SEED_CONTRACT_MISMATCH", "$.seedContract", "Seed tuple contract differs from the canonical generator contract.");
      }
      if (!canonicalEqual(value.twinklePolicy, expectedPlan.twinklePolicy)) {
        add("TWINKLE_POLICY_MISMATCH", "$.twinklePolicy", "Twinkle policy differs from the frozen semantic policy.");
      }
      if (!canonicalEqual(value.materials, expectedPlan.materials)) {
        add("MATERIAL_CONTRACT_MISMATCH", "$.materials", "Semantic material library differs from the canonical seven-family contract.");
      }
    }

    const rawChunks = Array.isArray(value.chunks) ? value.chunks : [];
    if (!Array.isArray(value.chunks)) {
      add("INVALID_STRUCTURE", "$.chunks", "chunks must be an array.");
    }
    if (rawChunks.length !== STORY_CHUNK_IDS.length) {
      add("STORY_CHUNK_COUNT", "$.chunks", `Expected 24 story chunks, received ${rawChunks.length}.`);
    }
    const actualIds = new Set(rawChunks.map((chunk) => isRecord(chunk) ? chunk.id : undefined));
    for (const chunkId of STORY_CHUNK_IDS) {
      if (!actualIds.has(chunkId)) add("MISSING_STORY_CHUNK", "$.chunks", `Missing ${chunkId}.`, chunkId);
    }

    for (let index = 0; index < Math.min(rawChunks.length, STORY_CHUNK_IDS.length); index += 1) {
      const chunkId = STORY_CHUNK_IDS[index];
      const shot = CANONICAL_STORY_SCORE[index];
      const chunk = rawChunks[index];
      const path = `$.chunks[${index}]`;
      if (!chunkId || !shot || !isRecord(chunk)) {
        add("INVALID_STRUCTURE", path, "Chunk must be an object.", chunkId);
        continue;
      }
      if (chunk.id !== chunkId) {
        add("STORY_ORDER", `${path}.id`, `Expected ${chunkId}, received ${String(chunk.id)}.`, chunkId);
      }
      const storyNode = chunk.storyNode;
      if (!isRecord(storyNode)) {
        add("INVALID_STRUCTURE", `${path}.storyNode`, "storyNode must be an object.", chunkId);
      } else {
        if (storyNode.id !== `story:${chunkId}` || storyNode.shotId !== chunkId || storyNode.index !== index) {
          add("STORY_NODE_MISMATCH", `${path}.storyNode`, "Story-node identity differs from the frozen score.", chunkId);
        }
        if (storyNode.startMs !== shot.start * 1000 || storyNode.endMs !== shot.end * 1000) {
          add("TIMELINE_GAP", `${path}.storyNode`, "Story-node timing differs from the frozen score.", chunkId);
        }
        if (storyNode.phase !== shot.phase) {
          add("PHASE_MISMATCH", `${path}.storyNode.phase`, `Expected ${shot.phase}.`, chunkId);
        }
        if (storyNode.biome !== shot.biome || storyNode.cue !== shot.cue
          || !canonicalEqual(storyNode.motifs, CANONICAL_STORY_MOTIFS[chunkId])) {
          add("STORY_NODE_MISMATCH", `${path}.storyNode`, "Biome, cue, or motifs differ from the frozen score.", chunkId);
        }
        if (index < STORY_CHUNK_IDS.indexOf("S21") && Array.isArray(storyNode.motifs)
          && storyNode.motifs.includes("alien-complete-three-shell-ship")) {
          add("ALIEN_REVEAL_EARLY", `${path}.storyNode.motifs`, "Complete-ship motif begins before S21.", chunkId);
        }
      }

      const flowSegment = chunk.flowSegment;
      let points: WorldPointMm[] = [];
      if (!isRecord(flowSegment) || !Array.isArray(flowSegment.points)) {
        add("INVALID_STRUCTURE", `${path}.flowSegment`, "Flow segment must contain points.", chunkId);
      } else {
        const rawPoints = flowSegment.points;
        points = rawPoints.filter(isPoint);
        if (flowSegment.id !== `flow:${chunkId}` || flowSegment.chunkId !== chunkId
          || rawPoints.length < 2 || points.length !== rawPoints.length) {
          add("SAFE_CORRIDOR_DISCONNECTED", `${path}.flowSegment`, "Flow identity or point structure is invalid.", chunkId);
        }
        for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
          const previous = points[pointIndex - 1];
          const point = points[pointIndex];
          if (!previous || !point || samePoint(previous, point) || point.z <= previous.z) {
            add("SAFE_CORRIDOR_DISCONNECTED", `${path}.flowSegment.points[${pointIndex}]`, "Flow must advance through nondegenerate segments in positive z.", chunkId);
          }
        }
      }

      const corridor = chunk.safeCorridor;
      if (!isRecord(corridor) || !Array.isArray(corridor.blockers)) {
        add("INVALID_STRUCTURE", `${path}.safeCorridor`, "Safe corridor must contain blockers.", chunkId);
      } else {
        if (!isRecord(flowSegment) || corridor.flowSegmentId !== flowSegment.id
          || !isSafeInteger(corridor.radiusMm) || corridor.radiusMm <= 0) {
          add("SAFE_CORRIDOR_DISCONNECTED", `${path}.safeCorridor`, "Corridor reference or radius is invalid.", chunkId);
        }
        if (isSafeInteger(corridor.radiusMm) && corridor.radiusMm > 0 && points.length >= 2) {
          for (const [blockerIndex, blocker] of corridor.blockers.entries()) {
            const blockerPath = `${path}.safeCorridor.blockers[${blockerIndex}]`;
            if (!isRecord(blocker) || blocker.kind !== "sphere" || !isPoint(blocker.center)
              || !isSafeInteger(blocker.radiusMm) || blocker.radiusMm <= 0) {
              add("INVALID_STRUCTURE", blockerPath, "Blocker must be a positive-radius sphere.", chunkId);
              continue;
            }
            const clearance = corridor.radiusMm + blocker.radiusMm;
            for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
              const start = points[pointIndex - 1];
              const end = points[pointIndex];
              if (start && end && pointSegmentDistanceSquared(blocker.center, start, end) <= clearance * clearance) {
                add("SAFE_CORRIDOR_BLOCKED", blockerPath, "Blocker intersects the safe corridor capsule.", chunkId);
                break;
              }
            }
          }
        }
      }

      const next = rawChunks[index + 1];
      if (points.length > 0 && isRecord(next) && isRecord(next.flowSegment)
        && Array.isArray(next.flowSegment.points)) {
        const currentEnd = points[points.length - 1];
        const nextStart = next.flowSegment.points[0];
        if (!currentEnd || !isPoint(nextStart) || !samePoint(currentEnd, nextStart)) {
          add("SAFE_CORRIDOR_DISCONNECTED", `${path}.flowSegment.points`, "Adjacent chunk endpoints do not match.", chunkId);
        }
      }

      if (expectedPlan) {
        const expectedChunk = expectedPlan.chunks[index];
        if (!expectedChunk || !canonicalEqual(chunk.environment, expectedChunk.environment)) {
          add("ENVIRONMENT_DESCRIPTOR_MISMATCH", `${path}.environment`, "Environment descriptor differs from its named-stream-owned canonical value.", chunkId);
        }
        if (!expectedChunk || !canonicalEqual(chunk.hydrologyNodeIds, expectedChunk.hydrologyNodeIds)) {
          add("HYDROLOGY_DISCONNECTED", `${path}.hydrologyNodeIds`, "Chunk hydrology links differ from the directed graph.", chunkId);
        }
      }

      const alien = chunk.alienPresence;
      if (!isRecord(alien)) {
        add("INVALID_STRUCTURE", `${path}.alienPresence`, "Alien presence must be discriminated data.", chunkId);
      } else {
        if (index < STORY_CHUNK_IDS.indexOf("S20") && alien.kind !== "absent") {
          add("ALIEN_REVEAL_EARLY", `${path}.alienPresence`, "Alien geometry appears before S20.", chunkId);
        }
        if (chunkId === "S20" && (alien.kind !== "incomplete-peripheral-arcs" || alien.arcCount !== 3
          || alien.complete !== false || alien.centralVoidVisible !== false)) {
          add("ALIEN_S20_INVALID", `${path}.alienPresence`, "S20 must contain three incomplete peripheral arcs only.", chunkId);
        }
        if (index < STORY_CHUNK_IDS.indexOf("S21") && alien.kind === "complete-three-shell-ship") {
          add("ALIEN_REVEAL_EARLY", `${path}.alienPresence`, "Complete ship begins before S21 / 161 seconds.", chunkId);
        }
        if (index >= STORY_CHUNK_IDS.indexOf("S21") && (alien.kind !== "complete-three-shell-ship"
          || alien.shellCount !== 3 || alien.complete !== true || alien.centralVoid !== "open"
          || alien.revealAtMs !== 161_000)) {
          add("ALIEN_S21_MISSING", `${path}.alienPresence`, "S21 through S24 require the complete three-shell ship.", chunkId);
        }
      }
    }

    const firstStory = isRecord(rawChunks[0]) && isRecord(rawChunks[0].storyNode)
      ? rawChunks[0].storyNode
      : undefined;
    const lastChunk = rawChunks[rawChunks.length - 1];
    const lastStory = isRecord(lastChunk) && isRecord(lastChunk.storyNode) ? lastChunk.storyNode : undefined;
    if (firstStory?.startMs !== 0 || lastStory?.endMs !== JOURNEY_SECONDS * 1000) {
      add("TIMELINE_DURATION", "$.chunks", "Timeline must cover exactly 0 through 180000 milliseconds.");
    }

    const rawBranches = Array.isArray(value.authoredBranches) ? value.authoredBranches : [];
    if (!Array.isArray(value.authoredBranches)) {
      add("INVALID_STRUCTURE", "$.authoredBranches", "authoredBranches must be an array.");
    }
    if (rawBranches.length > 2) add("FLOW_BRANCH_LIMIT", "$.authoredBranches", "At most two branches are allowed.");
    if (rawBranches.length !== 2) add("FLOW_BRANCH_INVALID", "$.authoredBranches", "Exactly S08 and S14 branches are required.");
    const branchChunkIds = ["S08", "S14"] as const;
    for (let index = 0; index < Math.min(rawBranches.length, branchChunkIds.length); index += 1) {
      const branch = rawBranches[index];
      const expectedBranch = expectedPlan?.authoredBranches[index];
      const expectedChunkId = branchChunkIds[index];
      if (!isRecord(branch) || branch.chunkId !== expectedChunkId || typeof branch.id !== "string"
        || !isPoint(branch.entryPoint) || !isPoint(branch.branchPoint) || !isPoint(branch.mergePoint)
        || branch.branchPoint.z <= branch.entryPoint.z || branch.branchPoint.z >= branch.mergePoint.z
        || (expectedBranch !== undefined && !canonicalEqual(branch, expectedBranch))) {
        add("FLOW_BRANCH_INVALID", `$.authoredBranches[${index}]`, `Branch ${index} must use the exact ${expectedChunkId} flow anchors.`);
      }
    }

    const hydrology = value.hydrology;
    if (!isRecord(hydrology) || !Array.isArray(hydrology.nodes) || !Array.isArray(hydrology.edges)) {
      add("INVALID_STRUCTURE", "$.hydrology", "Hydrology must contain directed node and edge arrays.");
    } else {
      const nodes = hydrology.nodes as unknown[];
      const edges = hydrology.edges as unknown[];
      const nodeMap = new Map<string, WorldHydrologyNodePlan>();
      for (const [index, rawNode] of nodes.entries()) {
        if (!isRecord(rawNode) || typeof rawNode.id !== "string"
          || !(STORY_CHUNK_IDS as readonly string[]).includes(String(rawNode.chunkId))
          || !isSafeInteger(rawNode.elevationMm) || typeof rawNode.required !== "boolean") {
          add("HYDROLOGY_INVALID_EDGE", `$.hydrology.nodes[${index}]`, "Hydrology node is invalid.");
          continue;
        }
        const node = rawNode as unknown as WorldHydrologyNodePlan;
        if (nodeMap.has(node.id)) add("HYDROLOGY_INVALID_EDGE", `$.hydrology.nodes[${index}].id`, "Hydrology node ids must be unique.");
        nodeMap.set(node.id, node);
      }
      const edgeIds = new Set<string>();
      const adjacency = new Map<string, string[]>();
      for (const nodeId of nodeMap.keys()) adjacency.set(nodeId, []);
      let waterfallCount = 0;
      for (const [index, rawEdge] of edges.entries()) {
        const edgePath = `$.hydrology.edges[${index}]`;
        if (!isRecord(rawEdge) || typeof rawEdge.id !== "string" || typeof rawEdge.from !== "string"
          || typeof rawEdge.to !== "string" || typeof rawEdge.kind !== "string"
          || !isSafeInteger(rawEdge.dropMm)) {
          add("HYDROLOGY_INVALID_EDGE", edgePath, "Hydrology edge is invalid.");
          continue;
        }
        const edge = rawEdge as unknown as WorldHydrologyEdgePlan;
        if (edgeIds.has(edge.id) || !HYDROLOGY_EDGE_KINDS.has(edge.kind)) {
          add("HYDROLOGY_INVALID_EDGE", edgePath, "Hydrology edge id or kind is invalid.");
        }
        edgeIds.add(edge.id);
        const from = nodeMap.get(edge.from);
        const to = nodeMap.get(edge.to);
        if (!from || !to) {
          add("HYDROLOGY_INVALID_EDGE", edgePath, "Hydrology edge references a missing node.");
          continue;
        }
        adjacency.get(from.id)?.push(to.id);
        const actualDrop = from.elevationMm - to.elevationMm;
        if (edge.dropMm !== actualDrop || actualDrop <= 0) {
          add("HYDROLOGY_INVALID_DROP", edgePath, "Hydrology edge must descend by its exact recorded drop.");
        }
        if (edge.kind === "waterfall") {
          waterfallCount += 1;
          if (actualDrop < 1000) add("HYDROLOGY_INVALID_DROP", edgePath, "Waterfall requires at least a one-metre drop.");
        }
      }
      if (waterfallCount !== 1) {
        add("HYDROLOGY_INVALID_EDGE", "$.hydrology.edges", "Exactly one required waterfall edge must exist.");
      }
      const source = hydrology.sourceNodeId;
      const outlet = hydrology.outletNodeId;
      if (typeof source !== "string" || typeof outlet !== "string" || !nodeMap.has(source) || !nodeMap.has(outlet)
        || !canReach(source, outlet, adjacency)) {
        add("HYDROLOGY_DISCONNECTED", "$.hydrology", "A directed source-to-outlet path is required.");
      } else {
        for (const node of nodeMap.values()) {
          if (!canReach(source, node.id, adjacency) || !canReach(node.id, outlet, adjacency)) {
            add("HYDROLOGY_DISCONNECTED", "$.hydrology", `Node ${node.id} is not on the source-to-outlet path.`);
          }
        }
      }
    }

    const rawMaterials = Array.isArray(value.materials) ? value.materials : [];
    if (!Array.isArray(value.materials)) {
      add("MATERIAL_CONTRACT_MISMATCH", "$.materials", "materials must be an array.");
    }
    if (rawMaterials.length !== WORLD_MATERIAL_FAMILIES.length) {
      add("MATERIAL_CONTRACT_MISMATCH", "$.materials", "Exactly seven semantic material families are required.");
    }
    for (let index = 0; index < Math.min(rawMaterials.length, WORLD_MATERIAL_FAMILIES.length); index += 1) {
      const material = rawMaterials[index];
      const family = WORLD_MATERIAL_FAMILIES[index];
      if (!isRecord(material) || material.family !== family || material.id !== `material:${family}`) {
        add("MATERIAL_CONTRACT_MISMATCH", `$.materials[${index}]`, `Expected material family ${family}.`);
        continue;
      }
      for (const rangeKey of ["roughnessPermille", "metalnessPermille", "transmissionPermille", "emissionLinearPermille"] as const) {
        const range = material[rangeKey];
        if (!Array.isArray(range) || range.length !== 2 || !isSafeInteger(range[0]) || !isSafeInteger(range[1])
          || range[0] < 0 || range[1] > 1000 || range[0] > range[1]) {
          add("MATERIAL_CONTRACT_MISMATCH", `$.materials[${index}].${rangeKey}`, "Material range must be ordered within 0..1000 permille.");
        }
      }
      const color = material.baseColorLinearPermille;
      if (!Array.isArray(color) || color.length !== 3
        || color.some((channel) => !isSafeInteger(channel) || channel < 0 || channel > 1000)) {
        add("MATERIAL_CONTRACT_MISMATCH", `$.materials[${index}].baseColorLinearPermille`, "Material color must contain three 0..1000 linear channels.");
      }
    }

    if (expectedPlan && !canonicalEqual(value, expectedPlan)) {
      add("PLAN_MISMATCH", "$", "World plan differs from canonical generation for its seed and generator version.");
    }
  } catch (error) {
    add(
      "INVALID_STRUCTURE",
      "$",
      `World-plan validation failed closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return finish(issues);
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
