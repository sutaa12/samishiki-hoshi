import { SHOT_TABLE, type JourneyPhase } from "../../game/model";
import { digestCanonicalValue } from "./canonical";
import {
  STORY_CHUNK_IDS,
  type StoryChunkId,
  type StoryMotifKind,
} from "./contracts";
import { deepFreeze } from "./immutable";

export interface CanonicalStoryScoreEntry {
  readonly id: StoryChunkId;
  readonly start: number;
  readonly end: number;
  readonly phase: JourneyPhase;
  readonly biome: string;
  readonly cue: string;
}

export const PINNED_STORY_SCORE_DIGEST = "story-score-v1:28a70afd6684e90a";

/*
 * SHOT_TABLE is source-frozen by Git but its exported array is mutable at
 * runtime. Capture it exactly once, verify its pinned authored value, and never
 * retain a reference to the caller-visible array or its entries.
 */
const capturedStoryScore = SHOT_TABLE.map((shot, index): CanonicalStoryScoreEntry => {
  const expectedId = STORY_CHUNK_IDS[index];
  if (!expectedId || shot.id !== expectedId) {
    throw new Error(`Frozen story score entry ${index} is ${shot.id}, expected ${String(expectedId)}.`);
  }
  return {
    id: expectedId,
    start: shot.start,
    end: shot.end,
    phase: shot.phase,
    biome: shot.biome,
    cue: shot.cue,
  };
});

if (capturedStoryScore.length !== STORY_CHUNK_IDS.length) {
  throw new Error(`Frozen story score contains ${capturedStoryScore.length} entries, expected 24.`);
}

const capturedDigest = digestCanonicalValue(capturedStoryScore, "story-score-v1");
if (capturedDigest !== PINNED_STORY_SCORE_DIGEST) {
  throw new Error(
    `Frozen story score integrity mismatch: ${capturedDigest}; expected ${PINNED_STORY_SCORE_DIGEST}.`,
  );
}

export const CANONICAL_STORY_SCORE: readonly Readonly<CanonicalStoryScoreEntry>[] = deepFreeze(capturedStoryScore);

export const CANONICAL_STORY_MOTIFS: Readonly<Record<StoryChunkId, readonly StoryMotifKind[]>> = deepFreeze({
  S01: ["life-source"],
  S02: ["fish-school"],
  S03: ["first-twinkle"],
  S04: ["reef-arch"],
  S05: ["submerged-rectilinear-vehicle", "empty-rectangular-seat", "square-observation-frame"],
  S06: ["empty-rectangular-seat"],
  S07: ["surface-rain"],
  S08: ["river"],
  S09: ["waterfall-forest"],
  S10: ["rectilinear-city"],
  S11: ["empty-rectangular-seat", "square-observation-frame", "amber-line-light"],
  S12: ["square-observation-frame"],
  S13: ["square-observation-frame", "amber-line-light"],
  S14: ["bird-flight"],
  S15: ["aurora"],
  S16: ["living-earth"],
  S17: ["rectilinear-human-debris"],
  S18: ["empty-rectangular-seat", "amber-line-light"],
  S19: ["negative-space"],
  S20: ["alien-incomplete-peripheral-arcs"],
  S21: ["alien-complete-three-shell-ship"],
  S22: ["alien-complete-three-shell-ship", "answering-light"],
  S23: ["alien-complete-three-shell-ship", "life-light-wave"],
  S24: ["alien-complete-three-shell-ship", "formal-title"],
});

export function storyScoreEntry(chunkId: StoryChunkId): Readonly<CanonicalStoryScoreEntry> {
  const index = STORY_CHUNK_IDS.indexOf(chunkId);
  const entry = CANONICAL_STORY_SCORE[index];
  if (!entry) throw new RangeError(`Missing canonical story entry for ${chunkId}.`);
  return entry;
}
