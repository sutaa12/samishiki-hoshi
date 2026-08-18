import {
  REGISTERED_SEED_SYSTEMS,
  STORY_CHUNK_IDS,
  type CanonicalWorldGenerationContext,
  type NamedSeedStream,
  type NamedSeedStreamAddress,
  type RegisteredSeedSystem,
  type SeedStreamRegistry,
  type StoryChunkId,
} from "./contracts";
import { deepFreeze } from "./immutable";

const UINT32_RANGE = 0x1_0000_0000;
const MAX_UINT32 = 0xffff_ffff;

export const WORLD_GENERATOR_VERSION = "gfx003-world-plan-v1";

const OWNED_SUBSTREAMS: Readonly<Record<RegisteredSeedSystem, readonly string[]>> = deepFreeze({
  story: ["node"],
  flow: ["corridor", "branches"],
  terrain: ["heightfield"],
  hydrology: ["graph"],
  water: ["surface"],
  flora: ["placement"],
  ecology: ["spawns"],
  atmosphere: ["field"],
  space: ["field"],
  twinkle: ["ledger"],
  civilization: ["motif"],
  "alien-ship": ["reveal"],
});

function assertAsciiToken(value: string, label: string): void {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new TypeError(`${label} must be a lower-case ASCII token of 1 to 64 characters.`);
  }
}

function assertWorldSeed(worldSeed: number): void {
  if (!Number.isSafeInteger(worldSeed) || worldSeed < 0 || worldSeed > MAX_UINT32) {
    throw new RangeError("worldSeed must be an integer from 0 through 4294967295.");
  }
}

function assertGeneratorVersion(generatorVersion: string): void {
  assertAsciiToken(generatorVersion, "generatorVersion");
}

function assertRegisteredSystem(systemName: string): asserts systemName is RegisteredSeedSystem {
  if (!(REGISTERED_SEED_SYSTEMS as readonly string[]).includes(systemName)) {
    throw new RangeError(`Unregistered seed system: ${systemName}`);
  }
}

function assertStoryChunk(chunkId: string): asserts chunkId is StoryChunkId {
  if (!(STORY_CHUNK_IDS as readonly string[]).includes(chunkId)) {
    throw new RangeError(`Unknown story chunk: ${chunkId}`);
  }
}

function assertOwnedSubstream(systemName: RegisteredSeedSystem, substream: string | undefined): void {
  if (substream === undefined) return;
  assertAsciiToken(substream, "substream");
  if (!OWNED_SUBSTREAMS[systemName].includes(substream)) {
    throw new RangeError(`Substream ${substream} is not registered to ${systemName}.`);
  }
}

function lengthPrefix(value: string): string {
  return `${value.length}:${value}`;
}

function seedAddressKey(address: NamedSeedStreamAddress): string {
  return [
    address.worldSeed,
    address.systemName,
    address.chunkId,
    address.generatorVersion,
    address.substream ?? "-",
  ].map(lengthPrefix).join("|");
}

function fnv1aAscii(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) throw new TypeError("Seed addresses must contain ASCII only.");
    hash ^= code;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function avalanche32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d) >>> 0;
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b) >>> 0;
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function assertCounterIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > MAX_UINT32) {
    throw new RangeError("Seed-stream index must be a uint32 integer.");
  }
}

export interface CreateSeedStreamOptions {
  readonly worldSeed: number;
  readonly systemName: RegisteredSeedSystem;
  readonly chunkId: StoryChunkId;
  readonly generatorVersion: string;
  readonly substream?: string;
}

export function createSeedStream(options: CreateSeedStreamOptions): Readonly<NamedSeedStream> {
  assertWorldSeed(options.worldSeed);
  assertRegisteredSystem(options.systemName);
  assertStoryChunk(options.chunkId);
  assertGeneratorVersion(options.generatorVersion);
  assertOwnedSubstream(options.systemName, options.substream);

  const address: NamedSeedStreamAddress = deepFreeze({
    worldSeed: String(options.worldSeed >>> 0),
    systemName: options.systemName,
    chunkId: options.chunkId,
    generatorVersion: options.generatorVersion,
    substream: options.substream ?? null,
  });
  const baseSeed = avalanche32(fnv1aAscii(seedAddressKey(address)) ^ 0x9e3779b9);

  const stream: NamedSeedStream = {
    address,
    baseSeed,
    uint32At(index: number): number {
      assertCounterIndex(index);
      const counter = Math.imul(index >>> 0, 0x9e3779b1) >>> 0;
      return avalanche32((baseSeed + counter + 0x6d2b79f5) >>> 0);
    },
    float01At(index: number): number {
      return stream.uint32At(index) / UINT32_RANGE;
    },
    integerAt(index: number, minimum: number, maximum: number): number {
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
        throw new RangeError("integerAt bounds must be ordered safe integers.");
      }
      const span = maximum - minimum + 1;
      if (span < 1 || span > UINT32_RANGE) {
        throw new RangeError("integerAt span must fit one uint32 range.");
      }
      return minimum + (stream.uint32At(index) % span);
    },
  };
  return Object.freeze(stream);
}

export interface CreateWorldGenerationContextOptions {
  readonly worldSeed: number;
  readonly generatorVersion?: string;
}

export function createWorldGenerationContext(
  options: CreateWorldGenerationContextOptions,
): Readonly<CanonicalWorldGenerationContext> {
  assertWorldSeed(options.worldSeed);
  const generatorVersion = options.generatorVersion ?? WORLD_GENERATOR_VERSION;
  assertGeneratorVersion(generatorVersion);
  return Object.freeze({ worldSeed: options.worldSeed, generatorVersion });
}

export function createSeedStreamRegistry(
  context: Readonly<CanonicalWorldGenerationContext>,
): Readonly<SeedStreamRegistry> {
  assertWorldSeed(context.worldSeed);
  assertGeneratorVersion(context.generatorVersion);
  const worldSeed = String(context.worldSeed >>> 0);
  const registry: SeedStreamRegistry = {
    worldSeed,
    generatorVersion: context.generatorVersion,
    registeredSystems: REGISTERED_SEED_SYSTEMS,
    stream(systemName: RegisteredSeedSystem, chunkId: StoryChunkId, substream?: string) {
      return createSeedStream({
        worldSeed: context.worldSeed,
        systemName,
        chunkId,
        generatorVersion: context.generatorVersion,
        ...(substream === undefined ? {} : { substream }),
      });
    },
  };
  return Object.freeze(registry);
}
