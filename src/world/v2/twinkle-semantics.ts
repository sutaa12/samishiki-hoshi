import type { JourneyPhase, TwinkleSeed } from "../../game/model";
import { canonicalJson, digestCanonicalValue } from "./canonical";
import type {
  SeedStreamRegistry,
  TwinkleSpeciesFamily,
  WorldChunkPlan,
  WorldPlan,
  WorldTwinkleSemantic,
} from "./contracts";
import { deepFreeze } from "./immutable";
import { createSeedStreamRegistry, createWorldGenerationContext } from "./seed-streams";
import { validateWorldPlan } from "./validation";

const MAX_UINT32 = 0xffff_ffff;
const PLAYABLE_BOUND = 0.94;
const WORLD_SEED_PATTERN = /^(?:0|[1-9][0-9]{0,9})$/;
const JOURNEY_PHASES = Object.freeze([
  "LIFE",
  "EARTH",
  "ASCENT",
  "SOLITUDE",
  "ANSWER",
  "TWINKLE",
] as const satisfies readonly JourneyPhase[]);
const LEDGER_ENTRY_FIELDS = Object.freeze([
  "id",
  "journeyTime",
  "x",
  "y",
  "phase",
  "source",
  "value",
] as const satisfies readonly (keyof TwinkleSeed)[]);

type UnsignedTwinkleSemantic = Omit<WorldTwinkleSemantic, "signature">;

interface ValidatedPlanContext {
  readonly worldSeed: string;
  readonly generatorVersion: string;
  readonly registry: Readonly<SeedStreamRegistry>;
  readonly chunks: readonly Readonly<WorldChunkPlan>[];
}

function assertCanonicalNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new RangeError(`${label} must be a finite canonical number.`);
  }
}

function assertUint32(value: unknown, label: string, positive = false): asserts value is number {
  assertCanonicalNumber(value, label);
  const minimum = positive ? 1 : 0;
  if (!Number.isInteger(value) || value < minimum || value > MAX_UINT32) {
    throw new RangeError(`${label} must be ${positive ? "a positive " : "a "}uint32 integer.`);
  }
}

function isJourneyPhase(value: unknown): value is JourneyPhase {
  return typeof value === "string" && (JOURNEY_PHASES as readonly string[]).includes(value);
}

function snapshotLedgerEntry(source: unknown, index: number): Readonly<TwinkleSeed> {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new TypeError(`ledger[${index}] must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`ledger[${index}] must use a plain or null prototype.`);
  }

  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.length !== LEDGER_ENTRY_FIELDS.length
    || ownKeys.some((key) => typeof key !== "string"
      || !(LEDGER_ENTRY_FIELDS as readonly string[]).includes(key))) {
    throw new TypeError(`ledger[${index}] must contain exactly the canonical TwinkleSeed fields.`);
  }

  const captured: Record<string, unknown> = {};
  for (const field of LEDGER_ENTRY_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`ledger[${index}].${field} must be an own data property.`);
    }
    captured[field] = descriptor.value;
  }

  assertUint32(captured.id, `ledger[${index}].id`, true);
  assertCanonicalNumber(captured.journeyTime, `ledger[${index}].journeyTime`);
  assertCanonicalNumber(captured.x, `ledger[${index}].x`);
  assertCanonicalNumber(captured.y, `ledger[${index}].y`);
  assertUint32(captured.value, `ledger[${index}].value`);
  if (captured.journeyTime < 0 || captured.journeyTime > 180) {
    throw new RangeError(`ledger[${index}].journeyTime must be between 0 and 180 seconds.`);
  }
  if (Math.abs(captured.x) > PLAYABLE_BOUND || Math.abs(captured.y) > PLAYABLE_BOUND) {
    throw new RangeError(`ledger[${index}] position must stay within the frozen playable bound.`);
  }
  if (!isJourneyPhase(captured.phase)) {
    throw new TypeError(`ledger[${index}].phase is not a JourneyPhase.`);
  }
  if (captured.source !== "player") {
    throw new TypeError(`ledger[${index}].source must be player.`);
  }

  return Object.freeze({
    id: captured.id,
    journeyTime: captured.journeyTime,
    x: captured.x,
    y: captured.y,
    phase: captured.phase,
    source: captured.source,
    value: captured.value,
  });
}

function snapshotLedger(ledger: unknown): readonly Readonly<TwinkleSeed>[] {
  if (!Array.isArray(ledger)) throw new TypeError("Twinkle ledger must be an array.");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(ledger, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)
    || !Number.isInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw new TypeError("Twinkle ledger length must be an own integer data property.");
  }
  const length = lengthDescriptor.value as number;
  const ownKeys = Reflect.ownKeys(ledger);
  if (ownKeys.length !== length + 1) {
    throw new TypeError("Twinkle ledger must be dense and contain only indexed data properties and length.");
  }
  for (const key of ownKeys) {
    if (key === "length") continue;
    if (typeof key !== "string") {
      throw new TypeError("Twinkle ledger cannot contain symbol or extra properties.");
    }
    const candidateIndex = Number(key);
    if (!Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= length
      || String(candidateIndex) !== key) {
      throw new TypeError(`Twinkle ledger contains an extra property: ${key}.`);
    }
  }

  const snapshot: Readonly<TwinkleSeed>[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(ledger, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`ledger[${index}] must be a present own data property.`);
    }
    snapshot.push(snapshotLedgerEntry(descriptor.value, index));
  }
  return Object.freeze(snapshot);
}

function validatePlanContext(plan: Readonly<WorldPlan>): Readonly<ValidatedPlanContext> {
  const planSnapshot = deepFreeze(
    JSON.parse(canonicalJson(plan)) as unknown,
  ) as Readonly<WorldPlan>;
  const report = validateWorldPlan(planSnapshot);
  if (!report.valid) {
    const firstIssue = report.issues[0];
    throw new TypeError(`Twinkle world plan is invalid${firstIssue ? `: ${firstIssue.code} at ${firstIssue.path}` : "."}`);
  }
  if (typeof planSnapshot.worldSeed !== "string" || !WORLD_SEED_PATTERN.test(planSnapshot.worldSeed)) {
    throw new TypeError("Twinkle world plan seed must be a canonical uint32 decimal string.");
  }
  const worldSeed = Number(planSnapshot.worldSeed);
  if (!Number.isInteger(worldSeed) || worldSeed < 0 || worldSeed > MAX_UINT32
    || String(worldSeed) !== planSnapshot.worldSeed) {
    throw new RangeError("Twinkle world plan seed is outside the uint32 domain.");
  }
  const generationContext = createWorldGenerationContext({
    worldSeed,
    generatorVersion: planSnapshot.generatorVersion,
  });
  const registry = createSeedStreamRegistry(generationContext);
  return Object.freeze({
    worldSeed: planSnapshot.worldSeed,
    generatorVersion: generationContext.generatorVersion,
    registry,
    chunks: Object.freeze([...planSnapshot.chunks]),
  });
}

function chunkForTime(
  chunks: readonly Readonly<WorldChunkPlan>[],
  journeyTime: number,
): Readonly<WorldChunkPlan> {
  const timeMs = journeyTime * 1000;
  const chunk = chunks.find((candidate, index) =>
    timeMs >= candidate.storyNode.startMs
    && (timeMs < candidate.storyNode.endMs || index === chunks.length - 1),
  );
  if (!chunk) throw new RangeError(`Twinkle time ${journeyTime} is outside the world plan.`);
  return chunk;
}

function speciesFamilyForPhase(phase: JourneyPhase): TwinkleSpeciesFamily {
  switch (phase) {
    case "LIFE":
      return "marine";
    case "EARTH":
      return "terrestrial";
    case "ASCENT":
      return "aerial";
    case "SOLITUDE":
    case "ANSWER":
    case "TWINKLE":
      return "cosmic";
  }
}

function signatureFor(
  context: Readonly<ValidatedPlanContext>,
  semantic: Readonly<UnsignedTwinkleSemantic>,
): string {
  const entropy = context.registry.stream("twinkle", semantic.chunkId, "ledger").uint32At(semantic.id);
  return digestCanonicalValue({
    worldSeed: context.worldSeed,
    generatorVersion: context.generatorVersion,
    entropy,
    semantic,
  }, "twinkle-semantic-v1");
}

export function projectTwinkleSemantics(
  plan: Readonly<WorldPlan>,
  ledger: readonly Readonly<TwinkleSeed>[],
): readonly Readonly<WorldTwinkleSemantic>[] {
  const context = validatePlanContext(plan);
  const ledgerSnapshot = snapshotLedger(ledger);
  const result = ledgerSnapshot.map((entry, ledgerIndex): WorldTwinkleSemantic => {
    const chunk = chunkForTime(context.chunks, entry.journeyTime);
    if (chunk.storyNode.phase !== entry.phase) {
      throw new RangeError(`Twinkle ledger entry ${ledgerIndex} phase does not match its story chunk.`);
    }
    const semantic: UnsignedTwinkleSemantic = {
      ledgerIndex,
      id: entry.id,
      journeyTime: entry.journeyTime,
      x: entry.x,
      y: entry.y,
      phase: entry.phase,
      source: entry.source,
      value: entry.value,
      chunkId: chunk.id,
      biome: chunk.storyNode.biome,
      speciesFamily: speciesFamilyForPhase(entry.phase),
    };
    return {
      ...semantic,
      signature: signatureFor(context, semantic),
    };
  });
  return deepFreeze(result);
}
