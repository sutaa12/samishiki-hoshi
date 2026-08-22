/**
 * Shared, renderer-free vocabulary for the journey.  Keeping this module free
 * of browser and Three.js types makes recorded runs portable and testable.
 */

export const JOURNEY_SECONDS = 180;

export type JourneyPhase =
  | "LIFE"
  | "EARTH"
  | "ASCENT"
  | "SOLITUDE"
  | "ANSWER"
  | "TWINKLE";

export type QualityLevel = "low" | "balanced" | "high";

export interface TimelineShot {
  id: string;
  start: number;
  end: number;
  phase: JourneyPhase;
  biome: string;
  cue: string;
}

/** The authored 24-shot score. Ranges are half-open except for the final shot. */
export const SHOT_TABLE: readonly TimelineShot[] = [
  { id: "S01", start: 0, end: 3, phase: "LIFE", biome: "ocean-floor", cue: "豊かな海底。まだ人の痕跡はない。" },
  { id: "S02", start: 3, end: 8, phase: "LIFE", biome: "coral-cradle", cue: "魚群が分かれ、生命のしずくが形になる。" },
  { id: "S03", start: 8, end: 18, phase: "LIFE", biome: "first-bloom", cue: "最初の波紋が豊かな珊瑚へ新しい生命を加える。" },
  { id: "S04", start: 18, end: 24, phase: "LIFE", biome: "reef-arch", cue: "自然の岩礁に見える大きなArchへ入る。" },
  { id: "S05", start: 24, end: 31, phase: "LIFE", biome: "sunken-vehicle", cue: "Archが矩形の水没車両だと分かる。" },
  { id: "S06", start: 31, end: 36, phase: "LIFE", biome: "empty-seat", cue: "空の箱形座席を中景に残し魚群と抜ける。" },

  { id: "S07", start: 36, end: 44, phase: "EARTH", biome: "surface-rain", cue: "泡柱、飛沫、雨へ連続変化する。" },
  { id: "S08", start: 44, end: 54, phase: "EARTH", biome: "river", cue: "豊かな川と岸辺へ生命を増幅する。" },
  { id: "S09", start: 54, end: 62, phase: "EARTH", biome: "forest", cue: "根、幹、葉、花、鳥が連鎖成長する。" },
  { id: "S10", start: 62, end: 70, phase: "EARTH", biome: "city-edge", cue: "夕日の高層建築が森の向こうへ現れる。" },
  { id: "S11", start: 70, end: 80, phase: "EARTH", biome: "reclaimed-city", cue: "空のBenchと正方形観測Frameを通る。" },
  { id: "S12", start: 80, end: 88, phase: "EARTH", biome: "mountain-frame", cue: "巨大な正方形Frameの向こうに山と空を見る。" },

  { id: "S13", start: 88, end: 98, phase: "ASCENT", biome: "observatory", cue: "箱形天文台、直線Rail、琥珀色線状灯。" },
  { id: "S14", start: 98, end: 112, phase: "ASCENT", biome: "cloud-flight", cue: "渡り鳥と雲の中で翼が大きく開く。" },
  { id: "S15", start: 112, end: 121, phase: "ASCENT", biome: "aurora", cue: "雲粒が氷晶、Aurora、Stardustへ変わる。" },
  { id: "S16", start: 121, end: 130, phase: "ASCENT", biome: "living-earth", cue: "青と緑の豊かな地球を全景で見る。" },

  { id: "S17", start: 130, end: 140, phase: "SOLITUDE", biome: "orbital-debris", cue: "矩形の人類宇宙船片が小惑星に混ざる。" },
  { id: "S18", start: 140, end: 148, phase: "SOLITUDE", biome: "human-cockpit", cue: "空の箱形操縦席と消えるAmber beacon。" },
  { id: "S19", start: 148, end: 155, phase: "SOLITUDE", biome: "negative-space", cue: "色彩豊かな星雲の中、主人公の周囲だけが静か。" },
  { id: "S20", start: 155, end: 161, phase: "SOLITUDE", biome: "unknown-silhouette", cue: "三本の弧が未知船の輪郭だと分かる。" },

  { id: "S21", start: 161, end: 166, phase: "ANSWER", biome: "unknown-approach", cue: "三枚のRibbon shellと中央空洞が展開する。" },
  { id: "S22", start: 166, end: 171, phase: "ANSWER", biome: "answering-light", cue: "同じPulse間隔で穏やかな応答が返る。" },

  { id: "S23", start: 171, end: 178, phase: "TWINKLE", biome: "earth-return", cue: "地球一灯から無数の生命光へ増える。" },
  { id: "S24", start: 178, end: 180, phase: "TWINKLE", biome: "title", cue: "さみしき星のまたたきよ。" },
] as const;

export interface NormalizedInput {
  moveX: number;
  moveY: number;
  /** Rising edge. It makes a TwinkleSeed only while a Life Node is in range. */
  pulse?: boolean;
}

export interface TimedInput extends NormalizedInput {
  at: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface TwinkleSeed {
  readonly id: number;
  readonly journeyTime: number;
  readonly x: number;
  readonly y: number;
  readonly phase: JourneyPhase;
  readonly source: "player";
  readonly value: number;
}

export interface JourneyState {
  readonly seed: number;
  readonly time: number;
  readonly position: Vec2;
  readonly velocity: Vec2;
  readonly pulses: readonly TwinkleSeed[];
  readonly answerAt: number | null;
  readonly finished: boolean;
}

export const PHASE_WINDOWS: Readonly<Record<JourneyPhase, readonly [number, number]>> = {
  LIFE: [0, 36],
  EARTH: [36, 88],
  ASCENT: [88, 130],
  SOLITUDE: [130, 161],
  ANSWER: [161, 171],
  TWINKLE: [171, JOURNEY_SECONDS],
};

/** Keep authored boundaries identical to the v2 WorldPlan's integer-ms clock. */
function authoredStoryTime(time: number): number {
  const clamped = Math.max(0, Math.min(JOURNEY_SECONDS, time));
  return Math.round(clamped * 1_000) / 1_000;
}

export function phaseAt(time: number): JourneyPhase {
  const t = authoredStoryTime(time);
  if (t < 36) return "LIFE";
  if (t < 88) return "EARTH";
  if (t < 130) return "ASCENT";
  if (t < 161) return "SOLITUDE";
  if (t < 171) return "ANSWER";
  return "TWINKLE";
}

export function shotAt(time: number): TimelineShot {
  const t = authoredStoryTime(time);
  return SHOT_TABLE.find((shot) => t >= shot.start && (t < shot.end || shot.id === "S24")) ?? SHOT_TABLE[23];
}

export function normalizeInput(input: Partial<NormalizedInput> = {}): NormalizedInput {
  const x = Number.isFinite(input.moveX) ? input.moveX ?? 0 : 0;
  const y = Number.isFinite(input.moveY) ? input.moveY ?? 0 : 0;
  const length = Math.hypot(x, y);
  const multiplier = length > 1 ? 1 / length : 1;
  return { moveX: x * multiplier, moveY: y * multiplier, pulse: Boolean(input.pulse) };
}
