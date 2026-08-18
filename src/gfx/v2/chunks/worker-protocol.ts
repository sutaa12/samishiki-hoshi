import {
  canonicalWorldPlanBytes,
  digestCanonicalValue,
  digestWorldPlan,
} from "../../../world/v2/canonical";
import {
  STORY_CHUNK_IDS,
  WORLD_MATERIAL_FAMILIES,
  type StoryChunkId,
  type WorldMaterialFamily,
  type WorldPlan,
} from "../../../world/v2/contracts";
import { validateWorldPlan } from "../../../world/v2/validation";
import {
  CHUNK_PAYLOAD_GENERATOR_VERSION,
  CHUNK_PAYLOAD_SCHEMA_VERSION,
  CHUNK_PAYLOAD_STREAMS,
  CHUNK_PAYLOAD_VALUES_PER_STREAM,
  CHUNK_WORKER_PROTOCOL_VERSION,
  CHUNK_ISSUE_CODES,
  MAX_CHUNK_PAYLOAD_BUFFERS,
  MAX_CHUNK_PAYLOAD_BYTES,
  MAX_CHUNK_PLAN_BYTES,
  type ChunkGenerationToken,
  type ChunkIssue,
  type ChunkPayloadBuffer,
  type ChunkValidationReport,
  type ChunkWorkerFailedReply,
  type ChunkWorkerGeneratedReply,
  type ChunkWorkerInstallRequest,
  type ChunkWorkerReadyReply,
  type ChunkWorkerReply,
  type ChunkWorkerRequest,
  type GeneratedChunkPayload,
  type OwnedWorldPlanSnapshot,
} from "./contracts";

const TOKEN_KEYS = Object.freeze([
  "protocolVersion",
  "payloadVersion",
  "planDigest",
  "chunkId",
  "epoch",
  "requestId",
]);
const PAYLOAD_KEYS = Object.freeze([
  "schemaVersion",
  "generatorVersion",
  "planDigest",
  "chunkId",
  "contentDigest",
  "manifest",
  "buffers",
]);
const MANIFEST_KEYS = Object.freeze([
  "sourcePlanSchema",
  "sourceGeneratorVersion",
  "materialFamilies",
  "bufferCount",
  "sampleCount",
  "byteLength",
]);
const BUFFER_KEYS = Object.freeze([
  "name",
  "elementType",
  "elementCount",
  "byteLength",
  "buffer",
]);
const MAX_ISSUES = 32;

function issue(
  code: ChunkIssue["code"],
  path: string,
  detail: string,
  chunkId?: StoryChunkId,
): Readonly<ChunkIssue> {
  return Object.freeze({ code, path, detail, ...(chunkId === undefined ? {} : { chunkId }) });
}

function finish<T>(issues: readonly Readonly<ChunkIssue>[], value?: T): Readonly<ChunkValidationReport<T>> {
  const frozenIssues = Object.freeze(issues.slice(0, MAX_ISSUES));
  return Object.freeze(value === undefined || frozenIssues.length > 0
    ? { valid: false, issues: frozenIssues }
    : { valid: true, issues: frozenIssues, value });
}

function ownDataRecord(
  input: unknown,
  expectedKeys: readonly string[],
  path: string,
  issues: Readonly<ChunkIssue>[],
): Readonly<Record<string, unknown>> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.push(issue("INVALID_STRUCTURE", path, "Expected a plain object."));
    return null;
  }
  let prototype: object | null;
  let keys: readonly (string | symbol)[];
  try {
    prototype = Reflect.getPrototypeOf(input);
    keys = Reflect.ownKeys(input);
  } catch {
    issues.push(issue("INVALID_STRUCTURE", path, "Object shape could not be inspected."));
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    issues.push(issue("INVALID_STRUCTURE", path, "Object must use a plain or null prototype."));
    return null;
  }
  const expected = new Set(expectedKeys);
  if (keys.length !== expectedKeys.length) {
    issues.push(issue("UNEXPECTED_PROPERTY", path, "Object keys do not match the protocol schema."));
  }
  const captured: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !expected.has(key)) {
      issues.push(issue("UNEXPECTED_PROPERTY", path, "Object contains an unexpected property."));
      continue;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    } catch {
      issues.push(issue("INVALID_STRUCTURE", `${path}.${key}`, "Property descriptor could not be inspected."));
      continue;
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      issues.push(issue("INVALID_STRUCTURE", `${path}.${key}`, "Protocol properties must be enumerable data properties."));
      continue;
    }
    captured[key] = descriptor.value;
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(captured, key)) {
      issues.push(issue("INVALID_STRUCTURE", `${path}.${key}`, "Required protocol property is missing."));
    }
  }
  return Object.freeze(captured);
}

function ownDenseArray(
  input: unknown,
  maximum: number,
  path: string,
  issues: Readonly<ChunkIssue>[],
): readonly unknown[] | null {
  if (!Array.isArray(input)) {
    issues.push(issue("INVALID_STRUCTURE", path, "Expected an array."));
    return null;
  }
  let keys: readonly (string | symbol)[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    if (Reflect.getPrototypeOf(input) !== Array.prototype) {
      issues.push(issue("INVALID_STRUCTURE", path, "Array must use Array.prototype."));
      return null;
    }
    keys = Reflect.ownKeys(input);
    lengthDescriptor = Reflect.getOwnPropertyDescriptor(input, "length");
  } catch {
    issues.push(issue("INVALID_STRUCTURE", path, "Array shape could not be inspected."));
    return null;
  }
  if (!lengthDescriptor || !("value" in lengthDescriptor)) {
    issues.push(issue("INVALID_STRUCTURE", path, "Array length must be a data property."));
    return null;
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    issues.push(issue("PAYLOAD_BOUNDS", path, `Array length exceeds the ${maximum}-entry budget.`));
    return null;
  }
  if (keys.length !== length + 1) {
    issues.push(issue("INVALID_STRUCTURE", path, "Array must be dense and contain no extra properties."));
    return null;
  }
  const captured: unknown[] = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    } catch {
      issues.push(issue("INVALID_STRUCTURE", `${path}[${index}]`, "Array descriptor could not be inspected."));
      continue;
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      issues.push(issue("INVALID_STRUCTURE", `${path}[${index}]`, "Array entries must be enumerable data properties."));
      continue;
    }
    captured[index] = descriptor.value;
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      issues.push(issue("UNEXPECTED_PROPERTY", path, "Array contains an unexpected property."));
    }
  }
  return Object.freeze(captured);
}

function safeCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function validDigest(value: unknown, prefix: string): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}:[0-9a-f]{16}$`).test(value);
}

function captureToken(
  input: unknown,
  path: string,
  issues: Readonly<ChunkIssue>[],
): Readonly<ChunkGenerationToken> | null {
  const record = ownDataRecord(input, TOKEN_KEYS, path, issues);
  if (!record) return null;
  const chunkId = record.chunkId;
  if (record.protocolVersion !== CHUNK_WORKER_PROTOCOL_VERSION) {
    issues.push(issue("PROTOCOL_MISMATCH", `${path}.protocolVersion`, "Worker protocol version does not match."));
  }
  if (record.payloadVersion !== CHUNK_PAYLOAD_GENERATOR_VERSION) {
    issues.push(issue("TOKEN_INVALID", `${path}.payloadVersion`, "Payload generator version does not match."));
  }
  if (!validDigest(record.planDigest, "world-plan-v1")) {
    issues.push(issue("TOKEN_INVALID", `${path}.planDigest`, "Token requires a canonical world-plan digest."));
  }
  if (typeof chunkId !== "string" || !(STORY_CHUNK_IDS as readonly string[]).includes(chunkId)) {
    issues.push(issue("TOKEN_INVALID", `${path}.chunkId`, "Token requires a canonical story chunk id."));
  }
  if (!safeCounter(record.epoch)) {
    issues.push(issue("TOKEN_INVALID", `${path}.epoch`, "Token epoch must be a non-negative safe integer."));
  }
  if (!safeCounter(record.requestId)) {
    issues.push(issue("TOKEN_INVALID", `${path}.requestId`, "Token requestId must be a non-negative safe integer."));
  }
  if (issues.length > 0) return null;
  return Object.freeze({
    protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
    payloadVersion: CHUNK_PAYLOAD_GENERATOR_VERSION,
    planDigest: record.planDigest as string,
    chunkId: chunkId as StoryChunkId,
    epoch: record.epoch as number,
    requestId: record.requestId as number,
  });
}

export function validateChunkGenerationToken(
  input: unknown,
): Readonly<ChunkValidationReport<Readonly<ChunkGenerationToken>>> {
  const issues: Readonly<ChunkIssue>[] = [];
  const token = captureToken(input, "$.token", issues);
  return finish(issues, token ?? undefined);
}

function arrayBufferByteLength(value: unknown): number | null {
  try {
    const getter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
    if (!getter) return null;
    return getter.call(value) as number;
  } catch {
    return null;
  }
}

function materialFamilies(
  input: unknown,
  path: string,
  issues: Readonly<ChunkIssue>[],
): readonly WorldMaterialFamily[] | null {
  const values = ownDenseArray(input, WORLD_MATERIAL_FAMILIES.length, path, issues);
  if (!values) return null;
  const result: WorldMaterialFamily[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string" || !(WORLD_MATERIAL_FAMILIES as readonly string[]).includes(value) || seen.has(value)) {
      issues.push(issue("INVALID_STRUCTURE", `${path}[${index}]`, "Material families must be unique canonical family ids."));
      continue;
    }
    seen.add(value);
    result.push(value as WorldMaterialFamily);
  }
  return Object.freeze(result);
}

function valuesForDigest(buffers: readonly Readonly<ChunkPayloadBuffer>[]): readonly unknown[] {
  return Object.freeze(buffers.map((entry) => Object.freeze({
    name: entry.name,
    elementType: entry.elementType,
    values: Object.freeze(Array.from(new Uint32Array(entry.buffer))),
  })));
}

export function digestGeneratedChunkPayload(
  payload: Pick<GeneratedChunkPayload, "schemaVersion" | "generatorVersion" | "planDigest" | "chunkId" | "manifest" | "buffers">,
): string {
  return digestCanonicalValue({
    schemaVersion: payload.schemaVersion,
    generatorVersion: payload.generatorVersion,
    planDigest: payload.planDigest,
    chunkId: payload.chunkId,
    manifest: payload.manifest,
    buffers: valuesForDigest(payload.buffers),
  }, "chunk-payload-v1");
}

export interface ExpectedChunkPayload {
  readonly planDigest?: string;
  readonly token?: Readonly<ChunkGenerationToken>;
  readonly materialFamilies?: readonly WorldMaterialFamily[];
  readonly sourceGeneratorVersion?: string;
}

export function validateGeneratedChunkPayload(
  input: unknown,
  expected: Readonly<ExpectedChunkPayload> = {},
): Readonly<ChunkValidationReport<Readonly<GeneratedChunkPayload>>> {
  const issues: Readonly<ChunkIssue>[] = [];
  const root = ownDataRecord(input, PAYLOAD_KEYS, "$.payload", issues);
  if (!root) return finish(issues);
  if (root.schemaVersion !== CHUNK_PAYLOAD_SCHEMA_VERSION) {
    issues.push(issue("PAYLOAD_SCHEMA_MISMATCH", "$.payload.schemaVersion", "Generated chunk schema does not match."));
  }
  if (root.generatorVersion !== CHUNK_PAYLOAD_GENERATOR_VERSION) {
    issues.push(issue("PAYLOAD_SCHEMA_MISMATCH", "$.payload.generatorVersion", "Generated chunk version does not match."));
  }
  if (!validDigest(root.planDigest, "world-plan-v1")) {
    issues.push(issue("PLAN_DIGEST_MISMATCH", "$.payload.planDigest", "Payload plan digest is invalid."));
  }
  if (expected.planDigest !== undefined && root.planDigest !== expected.planDigest) {
    issues.push(issue("PLAN_DIGEST_MISMATCH", "$.payload.planDigest", "Payload belongs to a different world plan."));
  }
  const chunkId = root.chunkId;
  if (typeof chunkId !== "string" || !(STORY_CHUNK_IDS as readonly string[]).includes(chunkId)) {
    issues.push(issue("INVALID_STRUCTURE", "$.payload.chunkId", "Payload chunk id is invalid."));
  }
  if (expected.token !== undefined && chunkId !== expected.token.chunkId) {
    issues.push(issue("TOKEN_MISMATCH", "$.payload.chunkId", "Payload chunk id differs from its token."));
  }
  const manifest = ownDataRecord(root.manifest, MANIFEST_KEYS, "$.payload.manifest", issues);
  const families = manifest
    ? materialFamilies(manifest.materialFamilies, "$.payload.manifest.materialFamilies", issues)
    : null;
  if (manifest) {
    if (manifest.sourcePlanSchema !== "lonely-star-world-plan/v1") {
      issues.push(issue("PAYLOAD_SCHEMA_MISMATCH", "$.payload.manifest.sourcePlanSchema", "Source plan schema does not match."));
    }
    if (typeof manifest.sourceGeneratorVersion !== "string" || manifest.sourceGeneratorVersion.length < 1 || manifest.sourceGeneratorVersion.length > 64) {
      issues.push(issue("INVALID_STRUCTURE", "$.payload.manifest.sourceGeneratorVersion", "Source generator version is invalid."));
    }
    if (expected.sourceGeneratorVersion !== undefined && manifest.sourceGeneratorVersion !== expected.sourceGeneratorVersion) {
      issues.push(issue("PLAN_DIGEST_MISMATCH", "$.payload.manifest.sourceGeneratorVersion", "Source generator version differs from the installed plan."));
    }
  }
  if (families && expected.materialFamilies) {
    if (families.join("\u0000") !== expected.materialFamilies.join("\u0000")) {
      issues.push(issue("PAYLOAD_SCHEMA_MISMATCH", "$.payload.manifest.materialFamilies", "Payload material families differ from the canonical chunk."));
    }
  }

  const rawBuffers = ownDenseArray(root.buffers, MAX_CHUNK_PAYLOAD_BUFFERS, "$.payload.buffers", issues);
  const capturedBuffers: Readonly<ChunkPayloadBuffer>[] = [];
  const seenBuffers = new Set<ArrayBuffer>();
  let totalBytes = 0;
  if (rawBuffers) {
    if (rawBuffers.length !== CHUNK_PAYLOAD_STREAMS.length) {
      issues.push(issue("PAYLOAD_SCHEMA_MISMATCH", "$.payload.buffers", `Expected ${CHUNK_PAYLOAD_STREAMS.length} canonical stream buffers.`));
    }
    for (let index = 0; index < rawBuffers.length; index += 1) {
      const path = `$.payload.buffers[${index}]`;
      const record = ownDataRecord(rawBuffers[index], BUFFER_KEYS, path, issues);
      if (!record) continue;
      const expectedName = CHUNK_PAYLOAD_STREAMS[index];
      if (record.name !== expectedName) {
        issues.push(issue("PAYLOAD_SCHEMA_MISMATCH", `${path}.name`, `Expected canonical stream ${String(expectedName)}.`));
      }
      if (record.elementType !== "uint32") {
        issues.push(issue("PAYLOAD_SCHEMA_MISMATCH", `${path}.elementType`, "Only uint32 payload buffers are accepted."));
      }
      if (record.elementCount !== CHUNK_PAYLOAD_VALUES_PER_STREAM) {
        issues.push(issue("PAYLOAD_BOUNDS", `${path}.elementCount`, `Expected ${CHUNK_PAYLOAD_VALUES_PER_STREAM} values.`));
      }
      const actualBytes = arrayBufferByteLength(record.buffer);
      const expectedBytes = CHUNK_PAYLOAD_VALUES_PER_STREAM * Uint32Array.BYTES_PER_ELEMENT;
      if (actualBytes === null || actualBytes === 0) {
        issues.push(issue("PAYLOAD_BUFFER_INVALID", `${path}.buffer`, "Payload buffer is not an owned, attached ArrayBuffer."));
        continue;
      }
      if (record.byteLength !== expectedBytes || actualBytes !== expectedBytes) {
        issues.push(issue("PAYLOAD_BUFFER_INVALID", `${path}.byteLength`, "Payload buffer byte length does not match its schema."));
      }
      if (seenBuffers.has(record.buffer as ArrayBuffer)) {
        issues.push(issue("PAYLOAD_BUFFER_INVALID", `${path}.buffer`, "Payload buffers must have unique ownership."));
      }
      seenBuffers.add(record.buffer as ArrayBuffer);
      totalBytes += actualBytes;
      if (totalBytes > MAX_CHUNK_PAYLOAD_BYTES) {
        issues.push(issue("PAYLOAD_BOUNDS", "$.payload.buffers", `Payload exceeds ${MAX_CHUNK_PAYLOAD_BYTES} bytes.`));
        break;
      }
      capturedBuffers.push(Object.freeze({
        name: record.name as ChunkPayloadBuffer["name"],
        elementType: "uint32",
        elementCount: record.elementCount as number,
        byteLength: record.byteLength as number,
        buffer: record.buffer as ArrayBuffer,
      }));
    }
  }
  if (manifest) {
    if (manifest.bufferCount !== capturedBuffers.length) {
      issues.push(issue("PAYLOAD_BOUNDS", "$.payload.manifest.bufferCount", "Manifest buffer count does not match payload buffers."));
    }
    if (manifest.sampleCount !== capturedBuffers.length * CHUNK_PAYLOAD_VALUES_PER_STREAM) {
      issues.push(issue("PAYLOAD_BOUNDS", "$.payload.manifest.sampleCount", "Manifest sample count does not match payload buffers."));
    }
    if (manifest.byteLength !== totalBytes) {
      issues.push(issue("PAYLOAD_BOUNDS", "$.payload.manifest.byteLength", "Manifest byte length does not match payload buffers."));
    }
  }
  if (typeof root.contentDigest !== "string" || !/^chunk-payload-v1:[0-9a-f]{16}$/.test(root.contentDigest)) {
    issues.push(issue("PAYLOAD_DIGEST_MISMATCH", "$.payload.contentDigest", "Payload content digest is invalid."));
  }
  if (issues.length > 0 || !manifest || !families || capturedBuffers.length !== CHUNK_PAYLOAD_STREAMS.length) {
    return finish(issues);
  }
  const payload: Readonly<GeneratedChunkPayload> = Object.freeze({
    schemaVersion: CHUNK_PAYLOAD_SCHEMA_VERSION,
    generatorVersion: CHUNK_PAYLOAD_GENERATOR_VERSION,
    planDigest: root.planDigest as string,
    chunkId: chunkId as StoryChunkId,
    contentDigest: root.contentDigest as string,
    manifest: Object.freeze({
      sourcePlanSchema: "lonely-star-world-plan/v1",
      sourceGeneratorVersion: manifest.sourceGeneratorVersion as string,
      materialFamilies: families,
      bufferCount: manifest.bufferCount as number,
      sampleCount: manifest.sampleCount as number,
      byteLength: manifest.byteLength as number,
    }),
    buffers: Object.freeze(capturedBuffers),
  });
  let actualDigest: string;
  try {
    actualDigest = digestGeneratedChunkPayload(payload);
  } catch {
    return finish([issue("PAYLOAD_BUFFER_INVALID", "$.payload.buffers", "Payload buffers could not be read for digest validation.")]);
  }
  if (actualDigest !== payload.contentDigest) {
    return finish([issue("PAYLOAD_DIGEST_MISMATCH", "$.payload.contentDigest", "Payload content digest does not match its buffers.", payload.chunkId)]);
  }
  return finish([], payload);
}

function exactTokenEqual(left: Readonly<ChunkGenerationToken>, right: Readonly<ChunkGenerationToken>): boolean {
  return left.protocolVersion === right.protocolVersion
    && left.payloadVersion === right.payloadVersion
    && left.planDigest === right.planDigest
    && left.chunkId === right.chunkId
    && left.epoch === right.epoch
    && left.requestId === right.requestId;
}

export function validateChunkWorkerRequest(
  input: unknown,
): Readonly<ChunkValidationReport<Readonly<ChunkWorkerRequest>>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return finish([issue("INVALID_STRUCTURE", "$", "Worker request must be an object.")]);
  }
  let kindDescriptor: PropertyDescriptor | undefined;
  try {
    kindDescriptor = Reflect.getOwnPropertyDescriptor(input, "kind");
  } catch {
    return finish([issue("INVALID_STRUCTURE", "$.kind", "Request kind could not be inspected.")]);
  }
  if (!kindDescriptor || !("value" in kindDescriptor) || typeof kindDescriptor.value !== "string") {
    return finish([issue("INVALID_STRUCTURE", "$.kind", "Worker request kind is missing.")]);
  }
  const kind = kindDescriptor.value;
  const keys = kind === "install"
    ? ["kind", "protocolVersion", "planDigest", "byteLength", "planBytes"]
    : kind === "generate" || kind === "cancel"
      ? ["kind", "protocolVersion", "token"]
      : [];
  if (keys.length === 0) return finish([issue("PROTOCOL_MISMATCH", "$.kind", "Unknown worker request kind.")]);
  const issues: Readonly<ChunkIssue>[] = [];
  const record = ownDataRecord(input, keys, "$", issues);
  if (!record) return finish(issues);
  if (record.protocolVersion !== CHUNK_WORKER_PROTOCOL_VERSION) {
    issues.push(issue("PROTOCOL_MISMATCH", "$.protocolVersion", "Worker protocol version does not match."));
  }
  if (kind === "install") {
    if (!validDigest(record.planDigest, "world-plan-v1")) {
      issues.push(issue("PLAN_DIGEST_MISMATCH", "$.planDigest", "Install request plan digest is invalid."));
    }
    const actualBytes = arrayBufferByteLength(record.planBytes);
    if (!safeCounter(record.byteLength) || record.byteLength < 1 || record.byteLength > MAX_CHUNK_PLAN_BYTES || actualBytes !== record.byteLength) {
      issues.push(issue("PLAN_INVALID", "$.planBytes", `Install plan must be an attached ArrayBuffer up to ${MAX_CHUNK_PLAN_BYTES} bytes.`));
    }
    if (issues.length > 0) return finish(issues);
    return finish([], Object.freeze({
      kind: "install",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      planDigest: record.planDigest as string,
      byteLength: record.byteLength as number,
      planBytes: record.planBytes as ArrayBuffer,
    }));
  }
  const token = captureToken(record.token, "$.token", issues);
  if (issues.length > 0 || !token) return finish(issues);
  return finish([], Object.freeze({ kind, protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION, token }) as Readonly<ChunkWorkerRequest>);
}

export interface ExpectedChunkWorkerReply {
  readonly plan?: Readonly<WorldPlan>;
  readonly planDigest?: string;
  readonly token?: Readonly<ChunkGenerationToken>;
}

export function validateChunkWorkerReply(
  input: unknown,
  expected: Readonly<ExpectedChunkWorkerReply> = {},
): Readonly<ChunkValidationReport<Readonly<ChunkWorkerReply>>> {
  const initialIssues: Readonly<ChunkIssue>[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return finish([issue("INVALID_STRUCTURE", "$", "Worker reply must be an object.")]);
  }
  let kindDescriptor: PropertyDescriptor | undefined;
  try {
    kindDescriptor = Reflect.getOwnPropertyDescriptor(input, "kind");
  } catch {
    return finish([issue("INVALID_STRUCTURE", "$.kind", "Reply kind could not be inspected.")]);
  }
  if (!kindDescriptor || !("value" in kindDescriptor) || typeof kindDescriptor.value !== "string") {
    return finish([issue("INVALID_STRUCTURE", "$.kind", "Worker reply kind is missing.")]);
  }
  const kind = kindDescriptor.value;
  const keys = kind === "ready"
    ? ["kind", "protocolVersion", "planDigest"]
    : kind === "generated"
      ? ["kind", "protocolVersion", "token", "payload"]
      : kind === "failed"
        ? ["kind", "protocolVersion", "token", "issue"]
        : [];
  if (keys.length === 0) return finish([issue("PROTOCOL_MISMATCH", "$.kind", "Unknown worker reply kind.")]);
  const record = ownDataRecord(input, keys, "$", initialIssues);
  if (!record) return finish(initialIssues);
  if (record.protocolVersion !== CHUNK_WORKER_PROTOCOL_VERSION) {
    initialIssues.push(issue("PROTOCOL_MISMATCH", "$.protocolVersion", "Worker protocol version does not match."));
  }
  if (kind === "ready") {
    if (!validDigest(record.planDigest, "world-plan-v1") || (expected.planDigest !== undefined && record.planDigest !== expected.planDigest)) {
      initialIssues.push(issue("PLAN_DIGEST_MISMATCH", "$.planDigest", "Ready reply plan digest does not match."));
    }
    if (initialIssues.length > 0) return finish(initialIssues);
    const reply: Readonly<ChunkWorkerReadyReply> = Object.freeze({
      kind: "ready",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      planDigest: record.planDigest as string,
    });
    return finish([], reply);
  }
  const token = record.token === null && kind === "failed"
    ? null
    : captureToken(record.token, "$.token", initialIssues);
  if (expected.token && (!token || !exactTokenEqual(token, expected.token))) {
    initialIssues.push(issue("TOKEN_MISMATCH", "$.token", "Worker reply token does not match the active request."));
  }
  if (kind === "failed") {
    let hasChunkId = false;
    try {
      hasChunkId = typeof record.issue === "object"
        && record.issue !== null
        && Reflect.getOwnPropertyDescriptor(record.issue, "chunkId") !== undefined;
    } catch {
      initialIssues.push(issue("INVALID_STRUCTURE", "$.issue", "Worker issue shape could not be inspected."));
    }
    const failure = ownDataRecord(
      record.issue,
      hasChunkId ? ["code", "path", "detail", "chunkId"] : ["code", "path", "detail"],
      "$.issue",
      initialIssues,
    );
    if (!failure) return finish(initialIssues);
    const chunkId = failure.chunkId;
    if (
      typeof failure.code !== "string"
      || !(CHUNK_ISSUE_CODES as readonly string[]).includes(failure.code)
      || typeof failure.path !== "string"
      || failure.path.length < 1
      || failure.path.length > 512
      || failure.path[0] !== "$"
      || (failure.path.length > 1 && failure.path[1] !== "." && failure.path[1] !== "[")
      || typeof failure.detail !== "string"
      || failure.detail.length < 1
      || failure.detail.length > 512
    ) {
      initialIssues.push(issue("INVALID_STRUCTURE", "$.issue", "Worker failure issue is malformed."));
    }
    if (chunkId !== null && chunkId !== undefined && (typeof chunkId !== "string" || !(STORY_CHUNK_IDS as readonly string[]).includes(chunkId))) {
      initialIssues.push(issue("INVALID_STRUCTURE", "$.issue.chunkId", "Worker failure chunk id is invalid."));
    }
    if (token && chunkId !== undefined && chunkId !== null && chunkId !== token.chunkId) {
      initialIssues.push(issue("TOKEN_MISMATCH", "$.issue.chunkId", "Worker failure chunk id differs from its token."));
    }
    if (!token && chunkId !== undefined && chunkId !== null) {
      initialIssues.push(issue("TOKEN_MISMATCH", "$.issue.chunkId", "Global worker failure cannot claim a chunk id."));
    }
    if (initialIssues.length > 0) return finish(initialIssues);
    const reply: Readonly<ChunkWorkerFailedReply> = Object.freeze({
      kind: "failed",
      protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
      token,
      issue: Object.freeze({
        code: failure.code as ChunkIssue["code"],
        path: failure.path as string,
        detail: failure.detail as string,
        ...(chunkId === undefined || chunkId === null ? {} : { chunkId: chunkId as StoryChunkId }),
      }),
    });
    return finish([], reply);
  }
  if (!token) return finish(initialIssues);
  const chunk = expected.plan?.chunks.find((entry) => entry.id === token.chunkId);
  const payloadReport = validateGeneratedChunkPayload(record.payload, {
    planDigest: expected.planDigest,
    token,
    sourceGeneratorVersion: expected.plan?.generatorVersion,
    materialFamilies: chunk?.environment.materialFamilies,
  });
  initialIssues.push(...payloadReport.issues);
  if (initialIssues.length > 0 || !payloadReport.value) return finish(initialIssues);
  const reply: Readonly<ChunkWorkerGeneratedReply> = Object.freeze({
    kind: "generated",
    protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
    token,
    payload: payloadReport.value,
  });
  return finish([], reply);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function captureOwnedWorldPlan(input: Readonly<WorldPlan>): Readonly<OwnedWorldPlanSnapshot> {
  let json: string;
  try {
    const bytes = canonicalWorldPlanBytes(input);
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("World plan could not be captured canonically.");
  }
  const parsed = JSON.parse(json) as unknown;
  const report = validateWorldPlan(parsed);
  if (!report.valid) {
    const first = report.issues[0];
    throw new TypeError(`World plan failed preflight: ${first?.code ?? "PLAN_INVALID"} at ${first?.path ?? "$"}.`);
  }
  const plan = deepFreeze(parsed as WorldPlan);
  return Object.freeze({ plan, digest: digestWorldPlan(plan) });
}

export function decodeInstalledWorldPlan(
  request: Readonly<ChunkWorkerInstallRequest>,
): Readonly<OwnedWorldPlanSnapshot> {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(request.planBytes));
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("Installed world-plan bytes are not valid canonical UTF-8 JSON.");
  }
  const report = validateWorldPlan(parsed);
  if (!report.valid) {
    const first = report.issues[0];
    throw new TypeError(`Installed world plan is invalid: ${first?.code ?? "PLAN_INVALID"}.`);
  }
  const plan = deepFreeze(parsed as WorldPlan);
  const canonicalBytes = canonicalWorldPlanBytes(plan);
  if (canonicalBytes.byteLength !== request.byteLength) {
    throw new TypeError("Installed world-plan bytes are not in canonical form.");
  }
  const digest = digestWorldPlan(plan);
  if (digest !== request.planDigest) throw new TypeError("Installed world-plan digest does not match its bytes.");
  return Object.freeze({ plan, digest });
}

export function makeWorkerFailure(
  token: Readonly<ChunkGenerationToken> | null,
  failure: Readonly<ChunkIssue>,
): Readonly<ChunkWorkerFailedReply> {
  return Object.freeze({
    kind: "failed",
    protocolVersion: CHUNK_WORKER_PROTOCOL_VERSION,
    token,
    issue: Object.freeze({ ...failure }),
  });
}

export function workerFailureIssue(
  code: ChunkIssue["code"],
  detail: string,
  chunkId?: StoryChunkId,
): Readonly<ChunkIssue> {
  return issue(code, "$", detail.slice(0, 512), chunkId);
}
