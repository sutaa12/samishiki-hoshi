import { describe, expect, it } from "vitest";
import { SHOT_TABLE } from "../../src/game/model";
import {
  STORY_CHUNK_IDS,
  canonicalWorldPlanJson,
  createWorldGenerationContext,
  generateWorldPlan,
  validateWorldPlan,
  validateWorldSeedRange,
  type WorldPlan,
  type WorldPointMm,
} from "../../src/world/v2";
import { collectIssueCodes, jsonClone, numericLeaves } from "./test-helpers";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

function mutablePlan(seed = 20_260_818): Mutable<WorldPlan> {
  return jsonClone(generateWorldPlan(createWorldGenerationContext({ worldSeed: seed }))) as Mutable<WorldPlan>;
}

function squaredDistance(left: WorldPointMm, right: WorldPointMm): number {
  const x = left.x - right.x;
  const y = left.y - right.y;
  const z = left.z - right.z;
  return x * x + y * y + z * z;
}

function squaredDistanceToSegment(point: WorldPointMm, start: WorldPointMm, end: WorldPointMm): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const denominator = dx * dx + dy * dy + dz * dz;
  if (denominator === 0) return squaredDistance(point, start);
  const projection = (
    (point.x - start.x) * dx
    + (point.y - start.y) * dy
    + (point.z - start.z) * dz
  ) / denominator;
  const t = Math.max(0, Math.min(1, projection));
  return squaredDistance(point, {
    x: start.x + dx * t,
    y: start.y + dy * t,
    z: start.z + dz * t,
  });
}

function pathExists(plan: Readonly<WorldPlan>, from: string, to: string): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of plan.hydrology.edges) {
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }
  const queue = [from];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined || visited.has(node)) continue;
    if (node === to) return true;
    visited.add(node);
    queue.push(...(outgoing.get(node) ?? []));
  }
  return false;
}

function independentPlanIssues(plan: Readonly<WorldPlan>): string[] {
  const issues: string[] = [];
  if (plan.chunks.length !== 24) issues.push("chunk-count");
  if (plan.chunks.map((chunk) => chunk.id).join(",") !== STORY_CHUNK_IDS.join(",")) issues.push("chunk-order");
  for (let index = 0; index < plan.chunks.length; index += 1) {
    const chunk = plan.chunks[index];
    const shot = SHOT_TABLE[index];
    if (!chunk || !shot) {
      issues.push(`missing-shot:${index}`);
      continue;
    }
    if (
      chunk.storyNode.startMs !== shot.start * 1000
      || chunk.storyNode.endMs !== shot.end * 1000
      || chunk.storyNode.phase !== shot.phase
    ) issues.push(`story:${chunk.id}`);

    const points = chunk.flowSegment.points;
    if (points.length < 2) issues.push(`corridor-empty:${chunk.id}`);
    if (index > 0) {
      const previous = plan.chunks[index - 1];
      const previousEnd = previous?.flowSegment.points[previous.flowSegment.points.length - 1];
      if (!previousEnd || !points[0] || squaredDistance(previousEnd, points[0]) !== 0) {
        issues.push(`corridor-disconnected:${chunk.id}`);
      }
    }
    for (const blocker of chunk.safeCorridor.blockers) {
      const requiredClearance = chunk.safeCorridor.radiusMm + blocker.radiusMm;
      for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
        const start = points[pointIndex - 1];
        const end = points[pointIndex];
        if (!start || !end) continue;
        if (squaredDistanceToSegment(blocker.center, start, end) <= requiredClearance * requiredClearance) {
          issues.push(`corridor-blocked:${chunk.id}:${blocker.id}`);
        }
      }
    }
  }

  if (plan.authoredBranches.length > 2) issues.push("branch-limit");
  if (!pathExists(plan, plan.hydrology.sourceNodeId, plan.hydrology.outletNodeId)) {
    issues.push("hydrology-source-outlet");
  }
  for (const node of plan.hydrology.nodes.filter((candidate) => candidate.required)) {
    if (!pathExists(plan, plan.hydrology.sourceNodeId, node.id)) issues.push(`hydrology-unreachable:${node.id}`);
    if (!pathExists(plan, node.id, plan.hydrology.outletNodeId)) issues.push(`hydrology-no-outlet:${node.id}`);
  }
  for (const edge of plan.hydrology.edges.filter((candidate) => candidate.kind === "waterfall")) {
    if (edge.dropMm <= 0) issues.push(`waterfall-drop:${edge.id}`);
  }
  for (const [path, value] of numericLeaves(plan)) {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) issues.push(`number:${path}`);
  }
  return issues;
}

function expectRejected(plan: Readonly<WorldPlan>, code: string): void {
  const report = validateWorldPlan(plan);
  expect(report.valid).toBe(false);
  expect(collectIssueCodes(report)).toContain(code);
}

describe("GFX-003 world-plan property oracle", () => {
  it("independently validates one thousand world seeds", { timeout: 30_000 }, () => {
    const failures: Array<{ seed: number; validator: string[]; oracle: string[] }> = [];
    for (let seed = 0; seed < 1000; seed += 1) {
      const plan = generateWorldPlan(createWorldGenerationContext({ worldSeed: seed }));
      const report = validateWorldPlan(plan);
      const oracle = independentPlanIssues(plan);
      if (!report.valid || report.issues.length > 0 || oracle.length > 0) {
        failures.push({ seed, validator: collectIssueCodes(report), oracle });
      }
      expect(() => canonicalWorldPlanJson(plan), `canonical seed ${seed}`).not.toThrow();
    }
    expect(failures).toEqual([]);
    expect(validateWorldSeedRange(1000)).toEqual({
      valid: true,
      checked: 1000,
      invalidSeeds: [],
      issuesBySeed: {},
    });
  });

  it("rejects non-finite numbers instead of silently canonicalizing them to null", () => {
    const plan = mutablePlan();
    plan.chunks[0]!.flowSegment.points[0]!.x = Number.NaN;
    expectRejected(plan, "NON_FINITE_NUMBER");
    expect(() => canonicalWorldPlanJson(plan)).toThrow(/non-finite/i);
  });

  it("rejects negative zero", () => {
    const plan = mutablePlan();
    plan.chunks[0]!.flowSegment.points[0]!.x = -0;
    expectRejected(plan, "NEGATIVE_ZERO");
    expect(() => canonicalWorldPlanJson(plan)).toThrow(/negative zero/i);
  });

  it("rejects missing and reordered story chunks", () => {
    const missing = mutablePlan();
    missing.chunks.splice(11, 1);
    expectRejected(missing, "STORY_CHUNK_COUNT");
    expect(collectIssueCodes(validateWorldPlan(missing))).toContain("MISSING_STORY_CHUNK");

    const reordered = mutablePlan();
    [reordered.chunks[9], reordered.chunks[10]] = [reordered.chunks[10]!, reordered.chunks[9]!];
    expectRejected(reordered, "STORY_ORDER");
  });

  it("rejects timeline gaps and phase mismatches", () => {
    const gap = mutablePlan();
    gap.chunks[6]!.storyNode.startMs += 1;
    expectRejected(gap, "TIMELINE_GAP");

    const phase = mutablePlan();
    phase.chunks[20]!.storyNode.phase = "LIFE";
    expectRejected(phase, "PHASE_MISMATCH");
  });

  it("rejects a blocker inserted into the safe corridor", () => {
    const plan = mutablePlan();
    const chunk = plan.chunks[8]!;
    chunk.safeCorridor.blockers.push({
      id: "test-blocker",
      motif: "rectilinear-city",
      kind: "sphere",
      center: { ...chunk.flowSegment.points[0]! },
      radiusMm: 1,
    });
    expectRejected(plan, "SAFE_CORRIDOR_BLOCKED");
  });

  it("rejects cross-chunk corridor discontinuity", () => {
    const plan = mutablePlan();
    plan.chunks[1]!.flowSegment.points[0]!.x += 1;
    expectRejected(plan, "SAFE_CORRIDOR_DISCONNECTED");
  });

  it("rejects disconnected required hydrology and invalid waterfall drop", () => {
    const disconnected = mutablePlan();
    disconnected.hydrology.edges.splice(0, disconnected.hydrology.edges.length);
    expectRejected(disconnected, "HYDROLOGY_DISCONNECTED");

    const invalidDrop = mutablePlan();
    const waterfall = invalidDrop.hydrology.edges.find((edge) => edge.kind === "waterfall");
    expect(waterfall, "generated plan should include a required waterfall edge").toBeDefined();
    if (waterfall) waterfall.dropMm = 0;
    expectRejected(invalidDrop, "HYDROLOGY_INVALID_DROP");
  });

  it("rejects a third authored flow branch", () => {
    const plan = mutablePlan();
    const template = plan.authoredBranches[0] ?? {
      id: "branch-template",
      chunkId: "S08" as const,
      entryPoint: { x: 0, y: 0, z: 0 },
      branchPoint: { x: 1, y: 0, z: 0 },
      mergePoint: { x: 2, y: 0, z: 0 },
    };
    plan.authoredBranches.splice(0, plan.authoredBranches.length,
      { ...jsonClone(template), id: "test-branch-1" },
      { ...jsonClone(template), id: "test-branch-2" },
      { ...jsonClone(template), id: "test-branch-3" },
    );
    expectRejected(plan, "FLOW_BRANCH_LIMIT");
  });

  it("rejects an early complete ship and missing S20/S21 reveal states", () => {
    const early = mutablePlan();
    early.chunks[0]!.alienPresence = {
      kind: "complete-three-shell-ship",
      shellCount: 3,
      complete: true,
      centralVoid: "open",
      revealAtMs: 161_000,
    };
    expectRejected(early, "ALIEN_REVEAL_EARLY");

    const s20 = mutablePlan();
    s20.chunks[19]!.alienPresence = { kind: "absent" };
    expectRejected(s20, "ALIEN_S20_INVALID");

    const s21 = mutablePlan();
    s21.chunks[20]!.alienPresence = { kind: "absent" };
    expectRejected(s21, "ALIEN_S21_MISSING");
  });
});
