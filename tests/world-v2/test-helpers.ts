import { expect } from "vitest";

export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown, label = "value"): UnknownRecord {
  expect(value, label).not.toBeNull();
  expect(typeof value, label).toBe("object");
  expect(Array.isArray(value), label).toBe(false);
  return value as UnknownRecord;
}

export function asArray(value: unknown, label = "value"): unknown[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as unknown[];
}

export function assertDeepFrozen(value: unknown, path = "$", seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value), path).toBe(true);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertDeepFrozen(entry, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${path}.${key}`, seen);
  }
}

export function numericLeaves(value: unknown, path = "$", output: Array<readonly [string, number]> = []): Array<readonly [string, number]> {
  if (typeof value === "number") {
    output.push([path, value]);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => numericLeaves(entry, `${path}[${index}]`, output));
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    numericLeaves(child, `${path}.${key}`, output);
  }
  return output;
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deterministicShuffle<T>(values: readonly T[]): T[] {
  const shuffled = [...values];
  let state = 0x243f_6a88;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state ^ (state >>> 16), 0x45d9_f3b) + index) >>> 0;
    const target = state % (index + 1);
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

export function collectIssueCodes(report: unknown): string[] {
  const record = asRecord(report, "validation report");
  const issues = asArray(record.issues, "validation issues");
  return issues.map((issue, index) => String(asRecord(issue, `issue ${index}`).code));
}
