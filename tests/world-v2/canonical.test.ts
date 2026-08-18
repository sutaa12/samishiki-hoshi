import { describe, expect, it } from "vitest";
import {
  canonicalWorldPlanBytes,
  canonicalWorldPlanJson,
  createWorldGenerationContext,
  generateWorldPlan,
  type WorldPlan,
} from "../../src/world/v2";
import { jsonClone } from "./test-helpers";

function plan(): Readonly<WorldPlan> {
  return generateWorldPlan(createWorldGenerationContext({ worldSeed: 20_260_818 }));
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
}

describe("GFX-003 canonical plan encoding", () => {
  it("sorts object keys while preserving semantic array order", () => {
    const baseline = plan();
    const reversedKeys = reverseObjectKeys(jsonClone(baseline)) as WorldPlan;
    expect(canonicalWorldPlanJson(reversedKeys)).toBe(canonicalWorldPlanJson(baseline));

    const reorderedChunks = jsonClone(baseline) as { chunks: unknown[] } & WorldPlan;
    [reorderedChunks.chunks[0], reorderedChunks.chunks[1]] = [reorderedChunks.chunks[1], reorderedChunks.chunks[0]];
    expect(canonicalWorldPlanJson(reorderedChunks)).not.toBe(canonicalWorldPlanJson(baseline));
  });

  it("encodes canonical JSON as exact UTF-8 bytes", () => {
    const baseline = plan();
    const json = canonicalWorldPlanJson(baseline);
    const bytes = canonicalWorldPlanBytes(baseline);
    expect(bytes).toEqual(new TextEncoder().encode(json));
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(json);
  });

  it("rejects undefined values, accessors, sparse arrays, and cycles", () => {
    const undefinedValue = jsonClone(plan()) as WorldPlan & { injected?: unknown };
    undefinedValue.injected = undefined;
    expect(() => canonicalWorldPlanJson(undefinedValue)).toThrow(/unsupported canonical value/i);

    const accessor = jsonClone(plan()) as WorldPlan & { injected?: unknown };
    Object.defineProperty(accessor, "injected", { enumerable: true, get: () => 1 });
    expect(() => canonicalWorldPlanJson(accessor)).toThrow(/accessor/i);

    const sparse = jsonClone(plan()) as WorldPlan & { injected?: unknown[] };
    sparse.injected = new Array(2);
    sparse.injected[1] = "present";
    expect(() => canonicalWorldPlanJson(sparse)).toThrow(/sparse/i);

    const cyclic = jsonClone(plan()) as WorldPlan & { injected?: unknown };
    cyclic.injected = cyclic;
    expect(() => canonicalWorldPlanJson(cyclic)).toThrow(/cycle/i);
  });
});
