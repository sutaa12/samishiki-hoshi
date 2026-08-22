import type { WorldPlan } from "./contracts";

const MAX_CANONICAL_DEPTH = 256;
const MAX_CANONICAL_NODES = 100_000;
const MAX_CANONICAL_CONTAINER_WIDTH = 50_000;
const MAX_CANONICAL_BYTES = 8 * 1024 * 1024;

interface CanonicalBudget {
  bytes: number;
  nodes: number;
  readonly parts: string[];
}

interface CapturedProperty {
  readonly key: string;
  readonly keyBytes: number;
  readonly value: unknown;
}

export type CanonicalNumericFailureCode = "NON_FINITE_NUMBER" | "NEGATIVE_ZERO";

const canonicalNumericFailureCodes = new WeakMap<object, CanonicalNumericFailureCode>();

function canonicalNumericFailure(code: CanonicalNumericFailureCode, message: string): TypeError {
  const failure = new TypeError(message);
  canonicalNumericFailureCodes.set(failure, code);
  return failure;
}

export function canonicalNumericFailureCode(error: unknown): CanonicalNumericFailureCode | undefined {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return undefined;
  return canonicalNumericFailureCodes.get(error);
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw canonicalNumericFailure("NON_FINITE_NUMBER", "Canonical data cannot contain a non-finite number.");
  }
  if (Object.is(value, -0)) {
    throw canonicalNumericFailure("NEGATIVE_ZERO", "Canonical data cannot contain negative zero.");
  }
  return String(value);
}

function byteBudgetError(): RangeError {
  return new RangeError(`Canonical UTF-8 output exceeds the ${MAX_CANONICAL_BYTES}-byte budget.`);
}

function addMeasuredByte(byteCount: number, total: number, limit: number): number {
  if (byteCount > limit - total) throw byteBudgetError();
  return total + byteCount;
}

/** Measures exact UTF-8 size after JSON escaping without first allocating the escaped string. */
function canonicalStringByteLength(value: string, limit = MAX_CANONICAL_BYTES): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes = addMeasuredByte(2, bytes, limit);
    } else if (codeUnit <= 0x1f) {
      const shortEscape = codeUnit === 0x08
        || codeUnit === 0x09
        || codeUnit === 0x0a
        || codeUnit === 0x0c
        || codeUnit === 0x0d;
      bytes = addMeasuredByte(shortEscape ? 2 : 6, bytes, limit);
    } else if (codeUnit <= 0x7f) {
      bytes = addMeasuredByte(1, bytes, limit);
    } else if (codeUnit <= 0x7ff) {
      bytes = addMeasuredByte(2, bytes, limit);
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new TypeError("Canonical strings must contain valid Unicode.");
      }
      bytes = addMeasuredByte(4, bytes, limit);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Canonical strings must contain valid Unicode.");
    } else {
      bytes = addMeasuredByte(3, bytes, limit);
    }
  }
  return bytes;
}

function appendAscii(value: string, budget: CanonicalBudget): void {
  budget.bytes = addMeasuredByte(value.length, budget.bytes, MAX_CANONICAL_BYTES);
  budget.parts.push(value);
}

function appendCanonicalString(
  value: string,
  budget: CanonicalBudget,
  knownByteLength?: number,
): void {
  const byteLength = knownByteLength ?? canonicalStringByteLength(
    value,
    MAX_CANONICAL_BYTES - budget.bytes,
  );
  budget.bytes = addMeasuredByte(byteLength, budget.bytes, MAX_CANONICAL_BYTES);
  budget.parts.push(JSON.stringify(value));
}

function inspectOwnKeys(value: object): readonly (string | symbol)[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw new TypeError("Canonical property keys could not be inspected.");
  }
}

function inspectDescriptor(value: object, key: PropertyKey): PropertyDescriptor {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new TypeError("Canonical property descriptors could not be inspected.");
  }
  if (!descriptor) throw new TypeError("Canonical properties must remain stable while captured.");
  return descriptor;
}

function inspectPrototype(value: object): object | null {
  try {
    return Reflect.getPrototypeOf(value);
  } catch {
    throw new TypeError("Canonical object prototype could not be inspected.");
  }
}

function assertDataDescriptor(descriptor: PropertyDescriptor, container: "arrays" | "objects"): void {
  if (!("value" in descriptor)) throw new TypeError(`Canonical ${container} cannot contain accessors.`);
}

function captureArray(value: readonly unknown[], budget: CanonicalBudget): readonly unknown[] {
  if (inspectPrototype(value) !== Array.prototype) {
    throw new TypeError("Canonical arrays must use Array.prototype.");
  }
  const keys = inspectOwnKeys(value);
  if (keys.length > MAX_CANONICAL_CONTAINER_WIDTH + 1) {
    throw new RangeError(`Canonical array width exceeds ${MAX_CANONICAL_CONTAINER_WIDTH} entries.`);
  }
  if (!keys.includes("length")) throw new TypeError("Canonical arrays must have an own length property.");

  const lengthDescriptor = inspectDescriptor(value, "length");
  assertDataDescriptor(lengthDescriptor, "arrays");
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError("Canonical arrays must have a valid integer length.");
  }
  if (length > MAX_CANONICAL_CONTAINER_WIDTH) {
    throw new RangeError(`Canonical array width exceeds ${MAX_CANONICAL_CONTAINER_WIDTH} entries.`);
  }

  const captured = new Array<unknown>(length);
  let capturedIndexes = 0;
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key === "symbol") throw new TypeError("Canonical arrays cannot contain symbol properties.");
    if (key.length > 5 || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
      throw new TypeError("Canonical arrays cannot contain extra properties.");
    }
    const index = Number(key);
    if (index >= length) throw new TypeError("Canonical arrays cannot contain extra properties.");
    const descriptor = inspectDescriptor(value, key);
    assertDataDescriptor(descriptor, "arrays");
    if (!descriptor.enumerable) throw new TypeError("Canonical array entries must be enumerable.");
    captured[index] = descriptor.value;
    capturedIndexes += 1;
  }
  if (capturedIndexes !== length) throw new TypeError("Canonical arrays cannot be sparse.");

  const punctuationBytes = length === 0 ? 2 : length + 1;
  if (punctuationBytes > MAX_CANONICAL_BYTES - budget.bytes) throw byteBudgetError();
  return captured;
}

function captureObject(value: object, budget: CanonicalBudget): readonly CapturedProperty[] {
  const prototype = inspectPrototype(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical objects must use a plain or null prototype.");
  }

  const keys = inspectOwnKeys(value);
  if (keys.length > MAX_CANONICAL_CONTAINER_WIDTH) {
    throw new RangeError(`Canonical object width exceeds ${MAX_CANONICAL_CONTAINER_WIDTH} properties.`);
  }

  const captured: CapturedProperty[] = [];
  let minimumBytes = keys.length === 0 ? 2 : keys.length + 1;
  for (const key of keys) {
    if (typeof key === "symbol") throw new TypeError("Canonical objects cannot contain symbol properties.");
    const keyBytes = canonicalStringByteLength(key, MAX_CANONICAL_BYTES - budget.bytes);
    minimumBytes = addMeasuredByte(keyBytes + 1, minimumBytes, MAX_CANONICAL_BYTES - budget.bytes);
    const descriptor = inspectDescriptor(value, key);
    assertDataDescriptor(descriptor, "objects");
    if (!descriptor.enumerable) throw new TypeError("Canonical object properties must be enumerable.");
    captured.push({ key, keyBytes, value: descriptor.value });
  }
  if (minimumBytes > MAX_CANONICAL_BYTES - budget.bytes) throw byteBudgetError();
  captured.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  return captured;
}

function writeCanonical(
  value: unknown,
  active: Set<object>,
  depth: number,
  budget: CanonicalBudget,
): void {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new RangeError(`Canonical nesting depth exceeds ${MAX_CANONICAL_DEPTH}.`);
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_NODES) {
    throw new RangeError(`Canonical node count exceeds ${MAX_CANONICAL_NODES}.`);
  }

  if (value === null) {
    appendAscii("null", budget);
    return;
  }
  if (typeof value === "string") {
    appendCanonicalString(value, budget);
    return;
  }
  if (typeof value === "boolean") {
    appendAscii(value ? "true" : "false", budget);
    return;
  }
  if (typeof value === "number") {
    appendAscii(canonicalNumber(value), budget);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`Unsupported canonical value: ${typeof value}`);

  if (active.has(value)) throw new TypeError("Canonical data cannot contain a cycle.");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const captured = captureArray(value, budget);
      appendAscii("[", budget);
      for (let index = 0; index < captured.length; index += 1) {
        if (index > 0) appendAscii(",", budget);
        writeCanonical(captured[index], active, depth + 1, budget);
      }
      appendAscii("]", budget);
      return;
    }

    const captured = captureObject(value, budget);
    appendAscii("{", budget);
    for (let index = 0; index < captured.length; index += 1) {
      if (index > 0) appendAscii(",", budget);
      const property = captured[index];
      appendCanonicalString(property.key, budget, property.keyBytes);
      appendAscii(":", budget);
      writeCanonical(property.value, active, depth + 1, budget);
    }
    appendAscii("}", budget);
  } finally {
    active.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  const budget: CanonicalBudget = { bytes: 0, nodes: 0, parts: [] };
  writeCanonical(value, new Set<object>(), 0, budget);
  return budget.parts.join("");
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new TypeError("Canonical strings must contain valid Unicode.");
      }
      bytes += 4;
      index += 1;
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      throw new TypeError("Canonical strings must contain valid Unicode.");
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function utf8Encode(value: string): Uint8Array {
  const bytes = new Uint8Array(utf8ByteLength(value));
  let offset = 0;
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      codePoint = 0x1_0000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
      index += 1;
    }

    if (codePoint <= 0x7f) {
      bytes[offset] = codePoint;
      offset += 1;
    } else if (codePoint <= 0x7ff) {
      bytes[offset] = 0xc0 | (codePoint >>> 6);
      bytes[offset + 1] = 0x80 | (codePoint & 0x3f);
      offset += 2;
    } else if (codePoint <= 0xffff) {
      bytes[offset] = 0xe0 | (codePoint >>> 12);
      bytes[offset + 1] = 0x80 | ((codePoint >>> 6) & 0x3f);
      bytes[offset + 2] = 0x80 | (codePoint & 0x3f);
      offset += 3;
    } else {
      bytes[offset] = 0xf0 | (codePoint >>> 18);
      bytes[offset + 1] = 0x80 | ((codePoint >>> 12) & 0x3f);
      bytes[offset + 2] = 0x80 | ((codePoint >>> 6) & 0x3f);
      bytes[offset + 3] = 0x80 | (codePoint & 0x3f);
      offset += 4;
    }
  }
  return bytes;
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
