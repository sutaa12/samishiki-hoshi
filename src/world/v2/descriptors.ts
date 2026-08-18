import {
  STORY_CHUNK_IDS,
  WORLD_MATERIAL_FAMILIES,
  type SeedStreamRegistry,
  type StoryChunkId,
  type StoryMotifKind,
  type WorldAtmosphereDescriptor,
  type WorldEcologyDescriptor,
  type WorldFloraDescriptor,
  type WorldMaterialDescriptor,
  type WorldMaterialFamily,
  type WorldSpaceDescriptor,
  type WorldTerrainDescriptor,
  type WorldWaterDescriptor,
  type WorldWaterRegime,
} from "./contracts";
import { deepFreeze } from "./immutable";
import { CANONICAL_STORY_MOTIFS, storyScoreEntry } from "./story-score";

type DescriptorRecord<T> = Readonly<Record<StoryChunkId, Readonly<T>>>;

export const WORLD_MATERIAL_LIBRARY: readonly Readonly<WorldMaterialDescriptor>[] = deepFreeze([
  {
    id: "material:water",
    family: "water",
    shadingModel: "transmissive-dielectric",
    baseColorLinearPermille: [28, 170, 230],
    roughnessPermille: [20, 180],
    metalnessPermille: [0, 0],
    transmissionPermille: [700, 1000],
    emissionLinearPermille: [0, 80],
  },
  {
    id: "material:terrain",
    family: "terrain",
    shadingModel: "dielectric",
    baseColorLinearPermille: [190, 230, 170],
    roughnessPermille: [520, 940],
    metalnessPermille: [0, 20],
    transmissionPermille: [0, 0],
    emissionLinearPermille: [0, 20],
  },
  {
    id: "material:foliage",
    family: "foliage",
    shadingModel: "dielectric",
    baseColorLinearPermille: [90, 320, 115],
    roughnessPermille: [420, 820],
    metalnessPermille: [0, 0],
    transmissionPermille: [80, 420],
    emissionLinearPermille: [0, 45],
  },
  {
    id: "material:concrete",
    family: "concrete",
    shadingModel: "dielectric",
    baseColorLinearPermille: [360, 350, 330],
    roughnessPermille: [620, 980],
    metalnessPermille: [0, 30],
    transmissionPermille: [0, 0],
    emissionLinearPermille: [0, 15],
  },
  {
    id: "material:metal",
    family: "metal",
    shadingModel: "conductor",
    baseColorLinearPermille: [420, 450, 490],
    roughnessPermille: [160, 760],
    metalnessPermille: [780, 1000],
    transmissionPermille: [0, 0],
    emissionLinearPermille: [0, 120],
  },
  {
    id: "material:glass-foil",
    family: "glass-foil",
    shadingModel: "transmissive-dielectric",
    baseColorLinearPermille: [520, 610, 680],
    roughnessPermille: [30, 360],
    metalnessPermille: [0, 240],
    transmissionPermille: [420, 980],
    emissionLinearPermille: [0, 180],
  },
  {
    id: "material:alien",
    family: "alien",
    shadingModel: "emissive-dielectric",
    baseColorLinearPermille: [260, 620, 570],
    roughnessPermille: [90, 460],
    metalnessPermille: [80, 380],
    transmissionPermille: [120, 620],
    emissionLinearPermille: [120, 720],
  },
]);

function recordFromOrder<T>(
  chunkOrder: readonly StoryChunkId[],
  create: (chunkId: StoryChunkId) => T,
): DescriptorRecord<T> {
  const result = {} as Record<StoryChunkId, T>;
  for (const chunkId of chunkOrder) result[chunkId] = create(chunkId);
  return result;
}

function waterRegime(chunkId: StoryChunkId): WorldWaterRegime {
  if (chunkId <= "S06") return "ocean";
  if (chunkId === "S07") return "rain";
  if (chunkId === "S08") return "river";
  if (chunkId === "S09") return "waterfall";
  if (chunkId === "S14") return "cloud";
  return "none";
}

export function buildTerrainDescriptors(
  registry: Readonly<SeedStreamRegistry>,
  chunkOrder: readonly StoryChunkId[],
): DescriptorRecord<WorldTerrainDescriptor> {
  return recordFromOrder(chunkOrder, (chunkId) => {
    const stream = registry.stream("terrain", chunkId, "heightfield");
    return {
      ownerSystem: "terrain",
      ownedSubstream: "heightfield",
      seedFingerprint: stream.baseSeed,
      baseElevationMm: stream.integerAt(0, -8_000, 12_000),
      reliefMm: stream.integerAt(1, 1_500, 12_000),
      erosionPermille: stream.integerAt(2, 100, 900),
      materialFamily: "terrain",
    };
  });
}

export function buildWaterDescriptors(
  registry: Readonly<SeedStreamRegistry>,
  chunkOrder: readonly StoryChunkId[],
): DescriptorRecord<WorldWaterDescriptor> {
  return recordFromOrder(chunkOrder, (chunkId) => {
    const stream = registry.stream("water", chunkId, "surface");
    const regime = waterRegime(chunkId);
    const active = regime !== "none";
    return {
      ownerSystem: "water",
      ownedSubstream: "surface",
      seedFingerprint: stream.baseSeed,
      regime,
      surfaceElevationMm: active ? stream.integerAt(0, -2_000, 4_000) : 0,
      flowMmPerSecond: active ? stream.integerAt(1, 180, 3_600) : 0,
      absorptionDepthMm: active ? stream.integerAt(2, 1_200, 24_000) : 0,
      foamPermille: active ? stream.integerAt(3, 20, 760) : 0,
      materialFamily: "water",
    };
  });
}

export function buildFloraDescriptors(
  registry: Readonly<SeedStreamRegistry>,
  chunkOrder: readonly StoryChunkId[],
): DescriptorRecord<WorldFloraDescriptor> {
  return recordFromOrder(chunkOrder, (chunkId) => {
    const stream = registry.stream("flora", chunkId, "placement");
    const phase = storyScoreEntry(chunkId).phase;
    const active = phase === "LIFE" || phase === "EARTH";
    const minimumHeightMm = active ? stream.integerAt(1, 80, 1_200) : 0;
    return {
      ownerSystem: "flora",
      ownedSubstream: "placement",
      seedFingerprint: stream.baseSeed,
      active,
      densityPermille: active ? stream.integerAt(0, 280, 920) : 0,
      minimumHeightMm,
      maximumHeightMm: active ? minimumHeightMm + stream.integerAt(2, 800, 18_000) : 0,
      materialFamily: "foliage",
    };
  });
}

export function buildEcologyDescriptors(
  registry: Readonly<SeedStreamRegistry>,
  chunkOrder: readonly StoryChunkId[],
): DescriptorRecord<WorldEcologyDescriptor> {
  return recordFromOrder(chunkOrder, (chunkId) => {
    const stream = registry.stream("ecology", chunkId, "spawns");
    const phase = storyScoreEntry(chunkId).phase;
    const active = phase === "LIFE" || phase === "EARTH" || chunkId === "S14";
    return {
      ownerSystem: "ecology",
      ownedSubstream: "spawns",
      seedFingerprint: stream.baseSeed,
      active,
      speciesSlots: active ? stream.integerAt(0, 3, 12) : 0,
      schoolCount: phase === "LIFE" ? stream.integerAt(1, 2, 9) : 0,
      flockCount: phase === "EARTH" || chunkId === "S14" ? stream.integerAt(2, 1, 7) : 0,
      carryingCapacity: active ? stream.integerAt(3, 100, 1_000) : 0,
    };
  });
}

export function buildAtmosphereDescriptors(
  registry: Readonly<SeedStreamRegistry>,
  chunkOrder: readonly StoryChunkId[],
): DescriptorRecord<WorldAtmosphereDescriptor> {
  return recordFromOrder(chunkOrder, (chunkId) => {
    const stream = registry.stream("atmosphere", chunkId, "field");
    const phase = storyScoreEntry(chunkId).phase;
    const regime = phase === "LIFE"
      ? "underwater"
      : phase === "EARTH"
        ? "surface"
        : phase === "ASCENT"
          ? "upper-atmosphere"
          : "vacuum";
    const vacuum = regime === "vacuum";
    return {
      ownerSystem: "atmosphere",
      ownedSubstream: "field",
      seedFingerprint: stream.baseSeed,
      regime,
      densityPpm: vacuum ? 0 : stream.integerAt(0, 420_000, 1_000_000),
      humidityPermille: vacuum ? 0 : stream.integerAt(1, 180, 980),
      aerosolPermille: vacuum ? 0 : stream.integerAt(2, 10, 420),
      cloudCoveragePermille: regime === "surface" || regime === "upper-atmosphere"
        ? stream.integerAt(3, 80, 860)
        : 0,
    };
  });
}

export function buildSpaceDescriptors(
  registry: Readonly<SeedStreamRegistry>,
  chunkOrder: readonly StoryChunkId[],
): DescriptorRecord<WorldSpaceDescriptor> {
  return recordFromOrder(chunkOrder, (chunkId) => {
    const stream = registry.stream("space", chunkId, "field");
    const index = STORY_CHUNK_IDS.indexOf(chunkId);
    const regime = index < 15
      ? "none"
      : chunkId === "S16"
        ? "planetary"
        : chunkId === "S17"
          ? "orbital"
          : index < 20
            ? "deep-space"
            : "alien-encounter";
    const active = regime !== "none";
    const humanDebrisCount = chunkId === "S17"
      ? stream.integerAt(2, 5, 9)
      : chunkId === "S18"
        ? 1
        : 0;
    return {
      ownerSystem: "space",
      ownedSubstream: "field",
      seedFingerprint: stream.baseSeed,
      regime,
      starClusterCount: active ? stream.integerAt(0, 3, 18) : 0,
      nebulaDensityPermille: active ? stream.integerAt(1, 40, 720) : 0,
      humanDebrisCount,
    };
  });
}

const CONCRETE_MOTIFS = new Set<StoryMotifKind>([
  "submerged-rectilinear-vehicle",
  "empty-rectangular-seat",
  "square-observation-frame",
  "rectilinear-city",
]);

const METAL_MOTIFS = new Set<StoryMotifKind>([
  "amber-line-light",
  "rectilinear-human-debris",
]);

export function materialFamiliesForChunk(
  chunkId: StoryChunkId,
  water: Readonly<WorldWaterDescriptor>,
  flora: Readonly<WorldFloraDescriptor>,
): readonly WorldMaterialFamily[] {
  const motifs = CANONICAL_STORY_MOTIFS[chunkId];
  const selected = new Set<WorldMaterialFamily>();
  if (water.regime !== "none") selected.add("water");
  if (storyScoreEntry(chunkId).phase !== "SOLITUDE"
    && storyScoreEntry(chunkId).phase !== "ANSWER"
    && storyScoreEntry(chunkId).phase !== "TWINKLE") selected.add("terrain");
  if (flora.active) selected.add("foliage");
  if (motifs.some((motif) => CONCRETE_MOTIFS.has(motif))) selected.add("concrete");
  if (motifs.some((motif) => METAL_MOTIFS.has(motif))) selected.add("metal");
  if (chunkId === "S13" || chunkId === "S17" || chunkId === "S18") selected.add("glass-foil");
  if (STORY_CHUNK_IDS.indexOf(chunkId) >= STORY_CHUNK_IDS.indexOf("S20")) selected.add("alien");
  return WORLD_MATERIAL_FAMILIES.filter((family) => selected.has(family));
}
