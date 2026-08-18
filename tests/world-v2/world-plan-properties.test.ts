import { describe, expect, it } from "vitest";
import { SHOT_TABLE } from "../../src/game/model";
import {
  STORY_CHUNK_IDS,
  WORLD_MATERIAL_FAMILIES,
  canonicalWorldPlanJson,
  createWorldGenerationContext,
  generateWorldPlan,
  validateWorldPlan,
  validateWorldSeedRange,
  type WorldPlan,
  type WorldPointMm,
} from "../../src/world/v2";
import { assertDeepFrozen, collectIssueCodes, jsonClone, numericLeaves } from "./test-helpers";

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
  const inRange = (value: number, minimum: number, maximum: number): boolean =>
    Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  if (plan.chunks.length !== 24) issues.push("chunk-count");
  if (plan.chunks.map((chunk) => chunk.id).join(",") !== STORY_CHUNK_IDS.join(",")) issues.push("chunk-order");
  if (plan.materials.map((material) => material.family).join(",") !== WORLD_MATERIAL_FAMILIES.join(",")) {
    issues.push("material-families");
  }
  for (const material of plan.materials) {
    const ranges = [
      material.roughnessPermille,
      material.metalnessPermille,
      material.transmissionPermille,
      material.emissionLinearPermille,
    ];
    if (ranges.some(([minimum, maximum]) => !inRange(minimum, 0, 1000)
      || !inRange(maximum, 0, 1000) || minimum > maximum)) {
      issues.push(`material-range:${material.family}`);
    }
    if (material.baseColorLinearPermille.some((channel) => !inRange(channel, 0, 1000))) {
      issues.push(`material-color:${material.family}`);
    }
  }
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

    const environment = chunk.environment;
    if (environment.terrain.ownerSystem !== "terrain" || environment.terrain.ownedSubstream !== "heightfield"
      || environment.water.ownerSystem !== "water" || environment.water.ownedSubstream !== "surface"
      || environment.flora.ownerSystem !== "flora" || environment.flora.ownedSubstream !== "placement"
      || environment.ecology.ownerSystem !== "ecology" || environment.ecology.ownedSubstream !== "spawns"
      || environment.atmosphere.ownerSystem !== "atmosphere" || environment.atmosphere.ownedSubstream !== "field"
      || environment.space.ownerSystem !== "space" || environment.space.ownedSubstream !== "field") {
      issues.push(`environment-owner:${chunk.id}`);
    }
    if (!inRange(environment.terrain.baseElevationMm, -8000, 12_000)
      || !inRange(environment.terrain.reliefMm, 1500, 12_000)
      || !inRange(environment.terrain.erosionPermille, 100, 900)) {
      issues.push(`terrain-range:${chunk.id}`);
    }
    if (environment.water.regime === "none") {
      if (environment.water.surfaceElevationMm !== 0 || environment.water.flowMmPerSecond !== 0
        || environment.water.absorptionDepthMm !== 0 || environment.water.foamPermille !== 0) {
        issues.push(`inactive-water:${chunk.id}`);
      }
    } else if (!inRange(environment.water.surfaceElevationMm, -2000, 4000)
      || !inRange(environment.water.flowMmPerSecond, 180, 3600)
      || !inRange(environment.water.absorptionDepthMm, 1200, 24_000)
      || !inRange(environment.water.foamPermille, 20, 760)) {
      issues.push(`water-range:${chunk.id}`);
    }
    if (environment.flora.active) {
      if (!inRange(environment.flora.densityPermille, 280, 920)
        || !inRange(environment.flora.minimumHeightMm, 80, 1200)
        || !inRange(environment.flora.maximumHeightMm - environment.flora.minimumHeightMm, 800, 18_000)) {
        issues.push(`flora-range:${chunk.id}`);
      }
    } else if (environment.flora.densityPermille !== 0 || environment.flora.minimumHeightMm !== 0
      || environment.flora.maximumHeightMm !== 0) {
      issues.push(`inactive-flora:${chunk.id}`);
    }
    if (environment.ecology.active && (!inRange(environment.ecology.speciesSlots, 3, 12)
      || !inRange(environment.ecology.carryingCapacity, 100, 1000))) {
      issues.push(`ecology-range:${chunk.id}`);
    }
    if (environment.atmosphere.regime === "vacuum") {
      if (environment.atmosphere.densityPpm !== 0 || environment.atmosphere.humidityPermille !== 0
        || environment.atmosphere.aerosolPermille !== 0 || environment.atmosphere.cloudCoveragePermille !== 0) {
        issues.push(`vacuum-range:${chunk.id}`);
      }
    } else if (!inRange(environment.atmosphere.densityPpm, 420_000, 1_000_000)
      || !inRange(environment.atmosphere.humidityPermille, 180, 980)
      || !inRange(environment.atmosphere.aerosolPermille, 10, 420)) {
      issues.push(`atmosphere-range:${chunk.id}`);
    }
    if (environment.space.regime === "none") {
      if (environment.space.starClusterCount !== 0 || environment.space.nebulaDensityPermille !== 0
        || environment.space.humanDebrisCount !== 0) issues.push(`inactive-space:${chunk.id}`);
    } else if (!inRange(environment.space.starClusterCount, 3, 18)
      || !inRange(environment.space.nebulaDensityPermille, 40, 720)) {
      issues.push(`space-range:${chunk.id}`);
    }

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

  it("rejects unsafe and fractional canonical numbers", () => {
    const unsafe = mutablePlan();
    unsafe.chunks[0]!.flowSegment.points[0]!.x = Number.MAX_SAFE_INTEGER + 1;
    expectRejected(unsafe, "UNSAFE_INTEGER");

    const fractional = mutablePlan();
    fractional.chunks[0]!.safeCorridor.radiusMm += 0.5;
    expectRejected(fractional, "UNSAFE_INTEGER");
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

  it("rejects altered exact motifs, including an early human-work motif", () => {
    const plan = mutablePlan();
    plan.chunks[0]!.storyNode.motifs.push("rectilinear-city");
    expectRejected(plan, "STORY_NODE_MISMATCH");
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

  it("rejects degenerate or backward flow and altered S08/S14 branch anchors", () => {
    const degenerate = mutablePlan();
    degenerate.chunks[0]!.flowSegment.points[1] = {
      ...degenerate.chunks[0]!.flowSegment.points[0]!,
    };
    expectRejected(degenerate, "SAFE_CORRIDOR_DISCONNECTED");

    const backward = mutablePlan();
    backward.chunks[0]!.flowSegment.points[1]!.z = -1;
    expectRejected(backward, "SAFE_CORRIDOR_DISCONNECTED");

    const branch = mutablePlan();
    branch.authoredBranches[0]!.entryPoint.x += 1;
    expectRejected(branch, "FLOW_BRANCH_INVALID");
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

  it("requires directed hydrology, valid edge kinds, a waterfall, and exact chunk links", () => {
    const flagsCannotHideDisconnection = mutablePlan();
    for (const node of flagsCannotHideDisconnection.hydrology.nodes) node.required = false;
    flagsCannotHideDisconnection.hydrology.edges.splice(0);
    expectRejected(flagsCannotHideDisconnection, "HYDROLOGY_DISCONNECTED");

    const invalidKind = mutablePlan();
    (invalidKind.hydrology.edges[0] as unknown as { kind: string }).kind = "teleport";
    expectRejected(invalidKind, "HYDROLOGY_INVALID_EDGE");

    const noWaterfall = mutablePlan();
    const waterfall = noWaterfall.hydrology.edges.find((edge) => edge.kind === "waterfall");
    if (!waterfall) throw new Error("Expected canonical waterfall.");
    (waterfall as unknown as { kind: string }).kind = "river";
    expectRejected(noWaterfall, "HYDROLOGY_INVALID_EDGE");

    const chunkLinks = mutablePlan();
    chunkLinks.chunks[7]!.hydrologyNodeIds.splice(0);
    expectRejected(chunkLinks, "HYDROLOGY_DISCONNECTED");
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

  it("rejects schema, seed-contract, Twinkle-policy, environment, and material drift", () => {
    const schema = mutablePlan();
    (schema as unknown as { schemaVersion: string }).schemaVersion = "lonely-star-world-plan/v2";
    expectRejected(schema, "SCHEMA_MISMATCH");

    const seedContract = mutablePlan();
    (seedContract.seedContract as unknown as { derivation: string }).derivation = "shared-cursor";
    expectRejected(seedContract, "SEED_CONTRACT_MISMATCH");

    const twinkle = mutablePlan();
    twinkle.twinklePolicy.revealStages[0]!.startsAtMs += 1;
    expectRejected(twinkle, "TWINKLE_POLICY_MISMATCH");

    const environment = mutablePlan();
    environment.chunks[0]!.environment.terrain.reliefMm += 1;
    expectRejected(environment, "ENVIRONMENT_DESCRIPTOR_MISMATCH");

    const material = mutablePlan();
    material.materials[0]!.roughnessPermille[0] += 1;
    expectRejected(material, "MATERIAL_CONTRACT_MISMATCH");
  });

  it("fails closed on forbidden, undefined, hidden, accessor, symbol, and extra data", () => {
    const forbidden = mutablePlan();
    (forbidden as unknown as Record<string, unknown>).qualityTier = "ultra";
    expectRejected(forbidden, "FORBIDDEN_RENDER_INPUT");

    const undefinedValue = mutablePlan();
    (undefinedValue.chunks[0] as unknown as Record<string, unknown>).extra = undefined;
    expectRejected(undefinedValue, "INVALID_STRUCTURE");

    const hidden = mutablePlan();
    Object.defineProperty(hidden.chunks[0], "hidden", { value: true, enumerable: false });
    expectRejected(hidden, "INVALID_STRUCTURE");

    const accessor = mutablePlan();
    Object.defineProperty(accessor.chunks[0], "computed", { get: () => 1, enumerable: true });
    expectRejected(accessor, "INVALID_STRUCTURE");

    const symbol = mutablePlan();
    Object.defineProperty(symbol.chunks[0], Symbol("hidden"), { value: true, enumerable: true });
    expectRejected(symbol, "INVALID_STRUCTURE");

    const extra = mutablePlan();
    (extra.chunks[0] as unknown as Record<string, unknown>).extra = true;
    expectRejected(extra, "UNEXPECTED_PROPERTY");
  });

  it("reports one structural budget issue and aborts semantic validation", () => {
    const plan = mutablePlan();
    (plan as unknown as Record<string, unknown>).oversized = new Array(50_001);
    const report = validateWorldPlan(plan);
    expect(report).toMatchObject({
      valid: false,
      issues: [{ code: "INVALID_STRUCTURE" }],
    });
    expect(report.issues).toHaveLength(1);
  });

  it("bounds hostile array key lists before inspecting every extra key", () => {
    const extraKeys = Array.from({ length: 50_001 }, (_, index) => `x${index}`);
    let descriptorReads = 0;
    const hostile = new Proxy([], {
      ownKeys: () => ["length", ...extraKeys],
      getOwnPropertyDescriptor(target, property) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    const report = validateWorldPlan(hostile);

    expect(report).toEqual({
      valid: false,
      issues: [{
        code: "INVALID_STRUCTURE",
        path: "$",
        detail: "Array key count exceeds 50000 entries plus length.",
      }],
    });
    expect(descriptorReads).toBe(1);
    assertDeepFrozen(report);
  });

  it("returns a frozen fail-closed report without inspecting a hostile thrown value", () => {
    const hostileFailure = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("secondary hostile trap");
      },
    });
    const source = mutablePlan();
    const hostilePlan = new Proxy(source, {
      get(target, property, receiver) {
        if (property === "schemaVersion") throw hostileFailure;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    let report: ReturnType<typeof validateWorldPlan> | undefined;
    expect(() => {
      report = validateWorldPlan(hostilePlan);
    }).not.toThrow();
    expect(report).toEqual({
      valid: false,
      issues: [{
        code: "INVALID_STRUCTURE",
        path: "$",
        detail: "World-plan validation failed closed on an opaque input error.",
      }],
    });
    assertDeepFrozen(report);
  });
});
