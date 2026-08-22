import { describe, expect, it } from "vitest";
import {
  canonicalJson,
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

  it("rejects symbols, hidden state, array extras, and invalid prototypes", () => {
    expect(() => canonicalJson(Symbol("hidden"))).toThrow(/unsupported canonical value: symbol/i);

    const symbolKey = { visible: true } as Record<PropertyKey, unknown>;
    symbolKey[Symbol("hidden")] = 1;
    expect(() => canonicalJson(symbolKey)).toThrow(/symbol propert/i);

    const hidden = { visible: true } as Record<string, unknown>;
    Object.defineProperty(hidden, "hidden", { enumerable: false, value: 1 });
    expect(() => canonicalJson(hidden)).toThrow(/enumerable/i);

    const extraArray = [1] as unknown[] & { extra?: number };
    extraArray.extra = 2;
    expect(() => canonicalJson(extraArray)).toThrow(/extra propert/i);

    const hiddenIndex = [1];
    Object.defineProperty(hiddenIndex, "0", { enumerable: false, value: 1 });
    expect(() => canonicalJson(hiddenIndex)).toThrow(/enumerable/i);

    class NonCanonical {
      readonly value = 1;
    }
    expect(() => canonicalJson(new NonCanonical())).toThrow(/plain or null prototype/i);

    const invalidArrayPrototype = [1];
    Object.setPrototypeOf(invalidArrayPrototype, null);
    expect(() => canonicalJson(invalidArrayPrototype)).toThrow(/Array\.prototype/i);
  });

  it("rejects non-finite numbers, signed zero, and invalid Unicode", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalJson(value)).toThrow(/non-finite/i);
    }
    expect(() => canonicalJson(-0)).toThrow(/negative zero/i);
    expect(() => canonicalJson("\ud800")).toThrow(/valid Unicode/i);
    expect(() => canonicalJson({ "\udfff": 1 })).toThrow(/valid Unicode/i);
  });

  it("uses one bounded proxy snapshot and never invokes value getters", () => {
    let ownKeyReads = 0;
    let descriptorReads = 0;
    let ordinaryReads = 0;
    const proxy = new Proxy({ b: 2, a: 1 }, {
      ownKeys(target) {
        ownKeyReads += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      get() {
        ordinaryReads += 1;
        throw new Error("canonical encoding must not read values through property access");
      },
    });

    expect(canonicalJson(proxy)).toBe('{"a":1,"b":2}');
    expect({ ownKeyReads, descriptorReads, ordinaryReads }).toEqual({
      ownKeyReads: 1,
      descriptorReads: 2,
      ordinaryReads: 0,
    });

    const throwingProxy = new Proxy({}, {
      ownKeys() {
        throw new Error("attacker-controlled trap failure");
      },
    });
    expect(() => canonicalJson(throwingProxy)).toThrow(/keys could not be inspected/i);
  });

  it("bounds nesting depth without overflowing the JavaScript stack", () => {
    let deep: unknown = null;
    for (let index = 0; index < 20_000; index += 1) deep = { next: deep };

    expect(() => canonicalJson(deep)).toThrow(/nesting depth exceeds/i);
    try {
      canonicalJson(deep);
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect(String(error)).not.toMatch(/maximum call stack/i);
    }
  });

  it("bounds container width, total nodes, and UTF-8 output bytes", () => {
    expect(() => canonicalJson(new Array(50_001).fill(0))).toThrow(/array width exceeds/i);

    const wideObject = Object.fromEntries(
      Array.from({ length: 50_001 }, (_, index) => [`k${index}`, 0]),
    );
    expect(() => canonicalJson(wideObject)).toThrow(/object width exceeds/i);

    const tooManyNodes = Array.from({ length: 50_000 }, () => [0]);
    expect(() => canonicalJson(tooManyNodes)).toThrow(/node count exceeds/i);

    expect(() => canonicalJson("x".repeat(8 * 1024 * 1024))).toThrow(/byte budget/i);
  });
});
