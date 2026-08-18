import type { WorldPlan } from "./contracts";

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("Canonical data cannot contain a non-finite number.");
  if (Object.is(value, -0)) throw new TypeError("Canonical data cannot contain negative zero.");
  return JSON.stringify(value);
}

function canonicalize(value: unknown, active: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value !== "object") throw new TypeError(`Unsupported canonical value: ${typeof value}`);

  if (active.has(value)) throw new TypeError("Canonical data cannot contain a cycle.");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError("Canonical arrays cannot be sparse.");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("Canonical arrays cannot contain accessors.");
        }
        entries.push(canonicalize(descriptor.value, active));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical objects must use a plain or null prototype.");
    }
    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("Canonical objects cannot contain accessors.");
      }
      entries.push(`${JSON.stringify(key)}:${canonicalize(descriptor.value, active)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

function utf8Encode(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) throw new TypeError("Canonical strings must contain valid Unicode.");
      codePoint = 0x1_0000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
      index += 1;
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      throw new TypeError("Canonical strings must contain valid Unicode.");
    }

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function avalanche32(value: number): number {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d) >>> 0;
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b) >>> 0;
  result ^= result >>> 16;
  return result >>> 0;
}

export function digestCanonicalValue(value: unknown, prefix = "canonical-v1"): string {
  const bytes = utf8Encode(canonicalJson(value));
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const byte of bytes) {
    first ^= byte;
    first = Math.imul(first, 0x01000193) >>> 0;
    second = (second + byte + 0x6d2b79f5) >>> 0;
    second = Math.imul(second ^ (second >>> 13), 0x85ebca6b) >>> 0;
  }
  const left = avalanche32(first).toString(16).padStart(8, "0");
  const right = avalanche32(second ^ bytes.length).toString(16).padStart(8, "0");
  return `${prefix}:${left}${right}`;
}

export function canonicalWorldPlanJson(plan: Readonly<WorldPlan>): string {
  return canonicalJson(plan);
}

export function canonicalWorldPlanBytes(plan: Readonly<WorldPlan>): Uint8Array {
  return utf8Encode(canonicalWorldPlanJson(plan));
}

export function digestWorldPlan(plan: Readonly<WorldPlan>): string {
  return digestCanonicalValue(plan, "world-plan-v1");
}
