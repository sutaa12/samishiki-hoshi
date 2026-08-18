import type { JourneyPhase, TwinkleSeed } from "../../game/model";
import { digestCanonicalValue } from "./canonical";
import type {
  StoryChunkId,
  TwinkleSpeciesFamily,
  WorldChunkPlan,
  WorldPlan,
  WorldTwinkleSemantic,
} from "./contracts";
import { deepFreeze } from "./immutable";
import { createSeedStreamRegistry, createWorldGenerationContext } from "./seed-streams";

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new RangeError(`${label} must be a finite canonical number.`);
  }
}

function chunkForTime(plan: Readonly<WorldPlan>, journeyTime: number): Readonly<WorldChunkPlan> {
  const timeMs = journeyTime * 1000;
  const chunk = plan.chunks.find((candidate, index) =>
    timeMs >= candidate.storyNode.startMs
    && (timeMs < candidate.storyNode.endMs || index === plan.chunks.length - 1),
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

function assertLedgerEntry(entry: Readonly<TwinkleSeed>, index: number): void {
  if (!Number.isInteger(entry.id) || entry.id < 0 || entry.id > 0xffff_ffff) {
    throw new RangeError(`Twinkle ledger entry ${index} has an invalid id.`);
  }
  assertFinite(entry.journeyTime, `ledger[${index}].journeyTime`);
  assertFinite(entry.x, `ledger[${index}].x`);
  assertFinite(entry.y, `ledger[${index}].y`);
  assertFinite(entry.value, `ledger[${index}].value`);
  if (entry.journeyTime < 0 || entry.journeyTime > 180) {
    throw new RangeError(`Twinkle ledger entry ${index} lies outside the journey.`);
  }
  if (entry.source !== "player") throw new TypeError(`Twinkle ledger entry ${index} has an unknown source.`);
}

function signatureFor(
  plan: Readonly<WorldPlan>,
  chunkId: StoryChunkId,
  ledgerIndex: number,
  entry: Readonly<TwinkleSeed>,
): string {
  const worldSeed = Number(plan.worldSeed);
  const registry = createSeedStreamRegistry(createWorldGenerationContext({
    worldSeed,
    generatorVersion: plan.generatorVersion,
  }));
  const entropy = registry.stream("twinkle", chunkId, "ledger").uint32At(entry.id);
  return digestCanonicalValue({
    worldSeed: plan.worldSeed,
    generatorVersion: plan.generatorVersion,
    ledgerIndex,
    id: entry.id,
    journeyTime: entry.journeyTime,
    x: entry.x,
    y: entry.y,
    phase: entry.phase,
    source: entry.source,
    value: entry.value,
    chunkId,
    entropy,
  }, "twinkle-semantic-v1");
}

export function projectTwinkleSemantics(
  plan: Readonly<WorldPlan>,
  ledger: readonly Readonly<TwinkleSeed>[],
): readonly Readonly<WorldTwinkleSemantic>[] {
  if (!Array.isArray(ledger)) throw new TypeError("Twinkle ledger must be an array.");
  const result = ledger.map((source, ledgerIndex): WorldTwinkleSemantic => {
    const entry: TwinkleSeed = {
      id: source.id,
      journeyTime: source.journeyTime,
      x: source.x,
      y: source.y,
      phase: source.phase,
      source: source.source,
      value: source.value,
    };
    assertLedgerEntry(entry, ledgerIndex);
    const chunk = chunkForTime(plan, entry.journeyTime);
    if (chunk.storyNode.phase !== entry.phase) {
      throw new RangeError(`Twinkle ledger entry ${ledgerIndex} phase does not match its story chunk.`);
    }
    return {
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
      signature: signatureFor(plan, chunk.id, ledgerIndex, entry),
    };
  });
  return deepFreeze(result);
}
