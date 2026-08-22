import type { JourneyPhase } from "../../game/model";

export const STORY_CHUNK_IDS = Object.freeze([
  "S01",
  "S02",
  "S03",
  "S04",
  "S05",
  "S06",
  "S07",
  "S08",
  "S09",
  "S10",
  "S11",
  "S12",
  "S13",
  "S14",
  "S15",
  "S16",
  "S17",
  "S18",
  "S19",
  "S20",
  "S21",
  "S22",
  "S23",
  "S24",
] as const);

export type StoryChunkId = (typeof STORY_CHUNK_IDS)[number];

export const REGISTERED_SEED_SYSTEMS = Object.freeze([
  "story",
  "flow",
  "encounters",
  "terrain",
  "hydrology",
  "water",
  "flora",
  "ecology",
  "atmosphere",
  "space",
  "twinkle",
  "civilization",
  "alien-ship",
] as const);

export type RegisteredSeedSystem = (typeof REGISTERED_SEED_SYSTEMS)[number];

export const WORLD_PLAN_GENERATOR_SYSTEMS = Object.freeze([
  "story",
  "flow",
  "encounters",
  "terrain",
  "hydrology",
  "water",
  "flora",
  "ecology",
  "atmosphere",
  "space",
  "civilization",
  "alien-ship",
  "twinkle",
] as const);

export type WorldPlanGeneratorSystem = (typeof WORLD_PLAN_GENERATOR_SYSTEMS)[number];

export interface CanonicalWorldGenerationContext {
  readonly worldSeed: number;
  readonly generatorVersion: string;
}

export interface NamedSeedStreamAddress {
  readonly worldSeed: string;
  readonly systemName: RegisteredSeedSystem;
  readonly chunkId: StoryChunkId;
  readonly generatorVersion: string;
  readonly substream: string | null;
}

export interface NamedSeedStream {
  readonly address: Readonly<NamedSeedStreamAddress>;
  readonly baseSeed: number;
  uint32At(index: number): number;
  float01At(index: number): number;
  integerAt(index: number, minimum: number, maximum: number): number;
}

export interface SeedStreamRegistry {
  readonly worldSeed: string;
  readonly generatorVersion: string;
  readonly registeredSystems: readonly RegisteredSeedSystem[];
  stream(systemName: RegisteredSeedSystem, chunkId: StoryChunkId, substream?: string): Readonly<NamedSeedStream>;
}

export interface WorldPointMm {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type StoryMotifKind =
  | "life-source"
  | "fish-school"
  | "first-twinkle"
  | "reef-arch"
  | "submerged-rectilinear-vehicle"
  | "empty-rectangular-seat"
  | "square-observation-frame"
  | "amber-line-light"
  | "surface-rain"
  | "river"
  | "waterfall-forest"
  | "rectilinear-city"
  | "bird-flight"
  | "aurora"
  | "living-earth"
  | "rectilinear-human-debris"
  | "negative-space"
  | "alien-incomplete-peripheral-arcs"
  | "alien-complete-three-shell-ship"
  | "answering-light"
  | "life-light-wave"
  | "formal-title";

export interface WorldStoryNodePlan {
  readonly id: string;
  readonly shotId: StoryChunkId;
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly phase: JourneyPhase;
  readonly biome: string;
  readonly cue: string;
  readonly motifs: readonly StoryMotifKind[];
}

export interface WorldFlowSegmentPlan {
  readonly id: string;
  readonly chunkId: StoryChunkId;
  readonly points: readonly WorldPointMm[];
}

export interface WorldSphereBlockerPlan {
  readonly id: string;
  readonly motif: StoryMotifKind;
  readonly kind: "sphere";
  readonly center: WorldPointMm;
  readonly radiusMm: number;
}

export interface WorldSafeCorridorPlan {
  readonly flowSegmentId: string;
  readonly radiusMm: number;
  readonly blockers: readonly WorldSphereBlockerPlan[];
}

export interface WorldFlowBranchPlan {
  readonly id: string;
  readonly chunkId: StoryChunkId;
  readonly entryPoint: WorldPointMm;
  readonly branchPoint: WorldPointMm;
  readonly mergePoint: WorldPointMm;
}

export type WorldEncounterKind = "gate" | "obstacle" | "life-node";

export interface WorldEncounterRadiiPlan {
  /** Gameplay collision/perfect radius. */
  readonly collisionMm: number;
  /** Renderer-visible ring and gameplay near/good radius from the same descriptor. */
  readonly visibleRingMm: number;
}

export interface WorldEncounterBasePlan {
  readonly id: string;
  readonly kind: WorldEncounterKind;
  readonly chunkId: StoryChunkId;
  readonly distanceMm: number;
  readonly flowPositionPermille: number;
  readonly centerOffsetMm: Readonly<{ readonly x: number; readonly y: number }>;
  readonly worldPoint: WorldPointMm;
  readonly previewDistanceMm: number;
  readonly radii: WorldEncounterRadiiPlan;
  readonly authoredRole: "tutorial" | "story";
}

export interface WorldGateEncounterPlan extends WorldEncounterBasePlan {
  readonly kind: "gate";
}

export interface WorldObstacleEncounterPlan extends WorldEncounterBasePlan {
  readonly kind: "obstacle";
  readonly safeRouteOffsetMm: Readonly<{ readonly x: number; readonly y: number }>;
}

export interface WorldLifeNodeEncounterPlan extends WorldEncounterBasePlan {
  readonly kind: "life-node";
}

export type WorldEncounterPlan =
  | WorldGateEncounterPlan
  | WorldObstacleEncounterPlan
  | WorldLifeNodeEncounterPlan;

export interface WorldHydrologyNodePlan {
  readonly id: string;
  readonly chunkId: StoryChunkId;
  readonly elevationMm: number;
  readonly required: boolean;
}

export interface WorldHydrologyEdgePlan {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "rainfall" | "river" | "waterfall" | "outlet";
  readonly dropMm: number;
}

export interface WorldHydrologyPlan {
  readonly sourceNodeId: string;
  readonly outletNodeId: string;
  readonly nodes: readonly WorldHydrologyNodePlan[];
  readonly edges: readonly WorldHydrologyEdgePlan[];
}

export const WORLD_MATERIAL_FAMILIES = Object.freeze([
  "water",
  "terrain",
  "foliage",
  "concrete",
  "metal",
  "glass-foil",
  "alien",
] as const);

export type WorldMaterialFamily = (typeof WORLD_MATERIAL_FAMILIES)[number];

export type WorldMaterialShadingModel =
  | "dielectric"
  | "conductor"
  | "transmissive-dielectric"
  | "emissive-dielectric";

/** Renderer-neutral semantic ranges. GFX-005 realizes them with TSL materials. */
export interface WorldMaterialDescriptor {
  readonly id: string;
  readonly family: WorldMaterialFamily;
  readonly shadingModel: WorldMaterialShadingModel;
  readonly baseColorLinearPermille: readonly [number, number, number];
  readonly roughnessPermille: readonly [number, number];
  readonly metalnessPermille: readonly [number, number];
  readonly transmissionPermille: readonly [number, number];
  readonly emissionLinearPermille: readonly [number, number];
}

export interface WorldTerrainDescriptor {
  readonly ownerSystem: "terrain";
  readonly ownedSubstream: "heightfield";
  readonly seedFingerprint: number;
  readonly baseElevationMm: number;
  readonly reliefMm: number;
  readonly erosionPermille: number;
  readonly materialFamily: "terrain";
}

export type WorldWaterRegime = "none" | "ocean" | "rain" | "river" | "waterfall" | "cloud";

export interface WorldWaterDescriptor {
  readonly ownerSystem: "water";
  readonly ownedSubstream: "surface";
  readonly seedFingerprint: number;
  readonly regime: WorldWaterRegime;
  readonly surfaceElevationMm: number;
  readonly flowMmPerSecond: number;
  readonly absorptionDepthMm: number;
  readonly foamPermille: number;
  readonly materialFamily: "water";
}

export interface WorldFloraDescriptor {
  readonly ownerSystem: "flora";
  readonly ownedSubstream: "placement";
  readonly seedFingerprint: number;
  readonly active: boolean;
  readonly densityPermille: number;
  readonly minimumHeightMm: number;
  readonly maximumHeightMm: number;
  readonly materialFamily: "foliage";
}

export interface WorldEcologyDescriptor {
  readonly ownerSystem: "ecology";
  readonly ownedSubstream: "spawns";
  readonly seedFingerprint: number;
  readonly active: boolean;
  readonly speciesSlots: number;
  readonly schoolCount: number;
  readonly flockCount: number;
  readonly carryingCapacity: number;
}

export type WorldAtmosphereRegime = "underwater" | "surface" | "upper-atmosphere" | "vacuum";

export interface WorldAtmosphereDescriptor {
  readonly ownerSystem: "atmosphere";
  readonly ownedSubstream: "field";
  readonly seedFingerprint: number;
  readonly regime: WorldAtmosphereRegime;
  readonly densityPpm: number;
  readonly humidityPermille: number;
  readonly aerosolPermille: number;
  readonly cloudCoveragePermille: number;
}

export type WorldSpaceRegime = "none" | "planetary" | "orbital" | "deep-space" | "alien-encounter";

export interface WorldSpaceDescriptor {
  readonly ownerSystem: "space";
  readonly ownedSubstream: "field";
  readonly seedFingerprint: number;
  readonly regime: WorldSpaceRegime;
  readonly starClusterCount: number;
  readonly nebulaDensityPermille: number;
  readonly humanDebrisCount: number;
}

export interface WorldEnvironmentDescriptor {
  readonly terrain: WorldTerrainDescriptor;
  readonly water: WorldWaterDescriptor;
  readonly flora: WorldFloraDescriptor;
  readonly ecology: WorldEcologyDescriptor;
  readonly atmosphere: WorldAtmosphereDescriptor;
  readonly space: WorldSpaceDescriptor;
  readonly materialFamilies: readonly WorldMaterialFamily[];
}

export type WorldAlienPresence =
  | {
      readonly kind: "absent";
    }
  | {
      readonly kind: "incomplete-peripheral-arcs";
      readonly arcCount: 3;
      readonly complete: false;
      readonly centralVoidVisible: false;
    }
  | {
      readonly kind: "complete-three-shell-ship";
      readonly shellCount: 3;
      readonly complete: true;
      readonly centralVoid: "open";
      readonly revealAtMs: 161_000;
    };

export interface WorldChunkPlan {
  readonly id: StoryChunkId;
  readonly storyNode: WorldStoryNodePlan;
  readonly flowSegment: WorldFlowSegmentPlan;
  readonly safeCorridor: WorldSafeCorridorPlan;
  readonly hydrologyNodeIds: readonly string[];
  readonly alienPresence: WorldAlienPresence;
  readonly environment: WorldEnvironmentDescriptor;
}

export interface WorldTwinkleRevealStage {
  readonly id: "one" | "few" | "tens" | "many";
  readonly startsAtMs: number;
}

export interface WorldTwinklePolicy {
  readonly preservesLedgerOrder: true;
  readonly semanticSystem: "twinkle";
  readonly revealStages: readonly WorldTwinkleRevealStage[];
}

export interface WorldSeedContract {
  readonly derivation: "counter-based-named-ascii-v1";
  readonly worldSeed: string;
  readonly generatorVersion: string;
  readonly registeredSystems: readonly RegisteredSeedSystem[];
  readonly tupleFields: readonly [
    "worldSeed",
    "systemName",
    "shotChunk",
    "generatorVersion",
    "ownedSubstream",
  ];
}

export interface WorldPlan {
  readonly schemaVersion: "lonely-star-world-plan/v1";
  readonly worldSeed: string;
  readonly generatorVersion: string;
  readonly seedContract: WorldSeedContract;
  readonly chunks: readonly WorldChunkPlan[];
  readonly encounters: readonly WorldEncounterPlan[];
  readonly authoredBranches: readonly WorldFlowBranchPlan[];
  readonly hydrology: WorldHydrologyPlan;
  readonly twinklePolicy: WorldTwinklePolicy;
  readonly materials: readonly WorldMaterialDescriptor[];
}

export type WorldPlanIssueCode =
  | "INVALID_STRUCTURE"
  | "NON_FINITE_NUMBER"
  | "NEGATIVE_ZERO"
  | "UNSAFE_INTEGER"
  | "NON_CANONICAL"
  | "UNEXPECTED_PROPERTY"
  | "FORBIDDEN_RENDER_INPUT"
  | "SCHEMA_MISMATCH"
  | "SEED_CONTRACT_MISMATCH"
  | "TWINKLE_POLICY_MISMATCH"
  | "MATERIAL_CONTRACT_MISMATCH"
  | "ENVIRONMENT_DESCRIPTOR_MISMATCH"
  | "PLAN_MISMATCH"
  | "STORY_CHUNK_COUNT"
  | "MISSING_STORY_CHUNK"
  | "STORY_ORDER"
  | "TIMELINE_GAP"
  | "TIMELINE_DURATION"
  | "PHASE_MISMATCH"
  | "STORY_NODE_MISMATCH"
  | "ENCOUNTER_CONTRACT_MISMATCH"
  | "ENCOUNTER_COUNT_MISMATCH"
  | "ENCOUNTER_OVERLAP"
  | "ENCOUNTER_UNREACHABLE"
  | "ENCOUNTER_PREVIEW_INVALID"
  | "SAFE_CORRIDOR_DISCONNECTED"
  | "SAFE_CORRIDOR_BLOCKED"
  | "FLOW_BRANCH_LIMIT"
  | "FLOW_BRANCH_INVALID"
  | "HYDROLOGY_DISCONNECTED"
  | "HYDROLOGY_INVALID_EDGE"
  | "HYDROLOGY_INVALID_DROP"
  | "ALIEN_S20_INVALID"
  | "ALIEN_REVEAL_EARLY"
  | "ALIEN_S21_MISSING";

export interface WorldPlanIssue {
  readonly code: WorldPlanIssueCode;
  readonly path: string;
  readonly chunkId?: StoryChunkId;
  readonly detail: string;
}

export interface WorldPlanValidationReport {
  readonly valid: boolean;
  readonly issues: readonly WorldPlanIssue[];
}

export interface WorldSeedRangeValidationReport {
  readonly valid: boolean;
  readonly checked: number;
  readonly invalidSeeds: readonly number[];
  readonly issuesBySeed: Readonly<Record<string, readonly WorldPlanIssue[]>>;
}

export type TwinkleSpeciesFamily = "marine" | "terrestrial" | "aerial" | "cosmic";

export interface WorldTwinkleSemantic {
  readonly ledgerIndex: number;
  readonly id: number;
  readonly journeyTime: number;
  readonly x: number;
  readonly y: number;
  readonly phase: JourneyPhase;
  readonly source: "player";
  readonly value: number;
  readonly chunkId: StoryChunkId;
  readonly biome: string;
  readonly speciesFamily: TwinkleSpeciesFamily;
  readonly signature: string;
}
