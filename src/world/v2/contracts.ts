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
  "hydrology",
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
  readonly authoredBranches: readonly WorldFlowBranchPlan[];
  readonly hydrology: WorldHydrologyPlan;
  readonly twinklePolicy: WorldTwinklePolicy;
}

export type WorldPlanIssueCode =
  | "INVALID_STRUCTURE"
  | "NON_FINITE_NUMBER"
  | "NEGATIVE_ZERO"
  | "STORY_CHUNK_COUNT"
  | "MISSING_STORY_CHUNK"
  | "STORY_ORDER"
  | "TIMELINE_GAP"
  | "TIMELINE_DURATION"
  | "PHASE_MISMATCH"
  | "STORY_NODE_MISMATCH"
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
