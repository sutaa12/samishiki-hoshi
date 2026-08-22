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

type AddressState = readonly [number, number, number, number];

export const WORLD_GENERATOR_VERSION = "gfx003-world-plan-v1";

const OWNED_SUBSTREAMS: Readonly<Record<RegisteredSeedSystem, readonly string[]>> = deepFreeze({
  story: ["node"],
  flow: ["corridor", "branches"],
  encounters: ["placement"],
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

function assertAsciiToken(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new TypeError(`${label} must be a lower-case ASCII token of 1 to 64 characters.`);
  }
}

function assertWorldSeed(worldSeed: unknown): asserts worldSeed is number {
  if (
    typeof worldSeed !== "number"
    || !Number.isSafeInteger(worldSeed)
    || Object.is(worldSeed, -0)
    || worldSeed < 0
    || worldSeed > MAX_UINT32
  ) {
    throw new RangeError("worldSeed must be an integer from 0 through 4294967295.");
  }
}

function assertGeneratorVersion(generatorVersion: unknown): asserts generatorVersion is string {
  assertAsciiToken(generatorVersion, "generatorVersion");
}

function assertRegisteredSystem(systemName: unknown): asserts systemName is RegisteredSeedSystem {
  if (
    typeof systemName !== "string"
    || !(REGISTERED_SEED_SYSTEMS as readonly string[]).includes(systemName)
  ) {
    throw new RangeError(`Unregistered seed system: ${String(systemName)}`);
  }
}

function assertStoryChunk(chunkId: unknown): asserts chunkId is StoryChunkId {
  if (typeof chunkId !== "string" || !(STORY_CHUNK_IDS as readonly string[]).includes(chunkId)) {
    throw new RangeError(`Unknown story chunk: ${String(chunkId)}`);
  }
}

function assertOwnedSubstream(
  systemName: RegisteredSeedSystem,
  substream: unknown,
): asserts substream is string | undefined {
  if (substream === undefined) return;
  assertAsciiToken(substream, "substream");
  if (!OWNED_SUBSTREAMS[systemName].includes(substream)) {
    throw new RangeError(`Substream ${substream} is not registered to ${systemName}.`);
  }
}

function ownDataValue(
  source: unknown,
  key: string,
  label: string,
  required: boolean,
): unknown {
  if (typeof source !== "object" || source === null) {
    throw new TypeError(`${label} must be an object with own data properties.`);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  } catch {
    throw new TypeError(`${label}.${key} could not be captured as an own data property.`);
  }
  if (!descriptor) {
    if (required) throw new TypeError(`${label}.${key} must be an own data property.`);
    return undefined;
  }
  if (!("value" in descriptor)) {
    throw new TypeError(`${label}.${key} must not be an accessor.`);
  }
  return descriptor.value;
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

function rotateLeft(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
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

function domainHashAscii(
  value: string,
  initial: number,
  multiplier: number,
  rotation: number,
): number {
  let hash = (initial ^ Math.imul(value.length, 0x9e3779b1)) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7f) throw new TypeError("Seed addresses must contain ASCII only.");
    hash ^= (code + Math.imul(index + 1, 0x45d9f3b)) >>> 0;
    hash = Math.imul(hash, multiplier) >>> 0;
    hash = rotateLeft(hash, rotation);
  }
  return avalanche32(hash ^ Math.imul(value.length + 1, 0x27d4eb2f));
}

function seedAddressState(address: NamedSeedStreamAddress): AddressState {
  const key = seedAddressKey(address);
  return Object.freeze([
    avalanche32(fnv1aAscii(key) ^ 0x9e3779b9),
    domainHashAscii(key, 0x243f6a88, 0x85ebca6b, 5),
    domainHashAscii(key, 0xb7e15162, 0xc2b2ae35, 11),
    domainHashAscii(key, 0xdeadbeef, 0x27d4eb2f, 17),
  ]);
}

function counterValue(state: AddressState, index: number): number {
  const counter = index >>> 0;
  const first = avalanche32(state[0] ^ Math.imul((counter + 1) >>> 0, 0x9e3779b1));
  const second = avalanche32((state[1] + Math.imul(counter ^ 0xa5a5a5a5, 0x85ebca6b)) >>> 0);
  const third = avalanche32(state[2] ^ Math.imul(counter ^ 0x3c6ef372, 0xc2b2ae35));
  const fourth = avalanche32((state[3] + Math.imul(counter ^ 0xbb67ae85, 0x27d4eb2f)) >>> 0);
  return avalanche32(
    first
    ^ rotateLeft(second, 7)
    ^ rotateLeft(third, 13)
    ^ rotateLeft(fourth, 21)
    ^ counter,
  );
}

function addressFingerprint(state: AddressState): number {
  return avalanche32(
    state[0]
    ^ rotateLeft(state[1], 7)
    ^ rotateLeft(state[2], 13)
    ^ rotateLeft(state[3], 21),
  );
}

function assertCounterIndex(index: number): void {
  if (!Number.isInteger(index) || Object.is(index, -0) || index < 0 || index > MAX_UINT32) {
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
  const worldSeed = ownDataValue(options, "worldSeed", "options", true);
  const systemName = ownDataValue(options, "systemName", "options", true);
  const chunkId = ownDataValue(options, "chunkId", "options", true);
  const generatorVersion = ownDataValue(options, "generatorVersion", "options", true);
  const substream = ownDataValue(options, "substream", "options", false);
  assertWorldSeed(worldSeed);
  assertRegisteredSystem(systemName);
  assertStoryChunk(chunkId);
  assertGeneratorVersion(generatorVersion);
  assertOwnedSubstream(systemName, substream);

  const address: NamedSeedStreamAddress = deepFreeze({
    worldSeed: String(worldSeed >>> 0),
    systemName,
    chunkId,
    generatorVersion,
    substream: substream ?? null,
  });
  const addressState = seedAddressState(address);
  const baseSeed = addressFingerprint(addressState);

  const stream: NamedSeedStream = {
    address,
    baseSeed,
    uint32At(index: number): number {
      assertCounterIndex(index);
      return counterValue(addressState, index);
    },
    float01At(index: number): number {
      return stream.uint32At(index) / UINT32_RANGE;
    },
    integerAt(index: number, minimum: number, maximum: number): number {
      if (
        !Number.isSafeInteger(minimum)
        || !Number.isSafeInteger(maximum)
        || Object.is(minimum, -0)
        || Object.is(maximum, -0)
        || maximum < minimum
      ) {
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
  const worldSeed = ownDataValue(options, "worldSeed", "options", true);
  const requestedVersion = ownDataValue(options, "generatorVersion", "options", false);
  assertWorldSeed(worldSeed);
  const generatorVersion = requestedVersion === undefined
    ? WORLD_GENERATOR_VERSION
    : requestedVersion;
  assertGeneratorVersion(generatorVersion);
  return Object.freeze({ worldSeed, generatorVersion });
}

export function createSeedStreamRegistry(
  context: Readonly<CanonicalWorldGenerationContext>,
): Readonly<SeedStreamRegistry> {
  const capturedSeed = ownDataValue(context, "worldSeed", "context", true);
  const capturedVersion = ownDataValue(context, "generatorVersion", "context", true);
  assertWorldSeed(capturedSeed);
  assertGeneratorVersion(capturedVersion);
  const worldSeed = String(capturedSeed >>> 0);
  const generatorVersion = capturedVersion;
  const registry: SeedStreamRegistry = {
    worldSeed,
    generatorVersion,
    registeredSystems: REGISTERED_SEED_SYSTEMS,
    stream(systemName: RegisteredSeedSystem, chunkId: StoryChunkId, substream?: string) {
      return createSeedStream({
        worldSeed: capturedSeed,
        systemName,
        chunkId,
        generatorVersion,
        ...(substream === undefined ? {} : { substream }),
      });
    },
  };
  return Object.freeze(registry);
}
