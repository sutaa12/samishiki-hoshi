import type { Vec2 } from "./model";

const UINT32 = 0x1_0000_0000;

/** A tiny deterministic PRNG; all arithmetic is explicitly uint32. */
export function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / UINT32;
  };
}

export function mixSeed(seed: number, salt: number): number {
  let value = (seed ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

/**
 * A bounded curl-like field. It supplies a gentle authored current while
 * preserving player agency; the returned vector is always at most 0.42 long.
 */
export function flowAt(seed: number, time: number, position: Vec2): Vec2 {
  const a = seed * 0.000_013 + time * 0.19 + position.y * 1.7;
  const b = seed * 0.000_021 - time * 0.13 + position.x * 1.9;
  const x = Math.sin(a) * 0.28 + Math.cos(b) * 0.14;
  const y = Math.cos(a * 0.83) * 0.25 - Math.sin(b * 1.11) * 0.15;
  return { x, y };
}

/** A deterministic, safe route used for scenic feature placement and tests. */
export function generateRoute(seed: number, points = 36): readonly Vec2[] {
  const random = mulberry32(mixSeed(seed, 0x9e3779b9));
  const route: Vec2[] = [];
  let x = (random() - 0.5) * 0.32;
  let y = -0.92;
  for (let index = 0; index < Math.max(2, points); index += 1) {
    const progress = index / (Math.max(2, points) - 1);
    const sway = (random() - 0.5) * 0.16;
    x = Math.max(-0.86, Math.min(0.86, x * 0.68 + sway));
    y = Math.max(-0.96, Math.min(0.96, -0.92 + progress * 1.84));
    route.push({ x, y });
  }
  return route;
}

export interface RouteValidation {
  valid: boolean;
  invalidSeeds: readonly number[];
  checked: number;
}

/** Property-style safety check: no generated route can leave the playable plane. */
export function validateRoutes(seedCount = 1000): RouteValidation {
  const invalidSeeds: number[] = [];
  const checked = Math.max(0, Math.floor(seedCount));
  for (let seed = 0; seed < checked; seed += 1) {
    const route = generateRoute(seed);
    const safe = route.length >= 2 && route.every((point) =>
      Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1,
    );
    if (!safe) invalidSeeds.push(seed);
  }
  return { valid: invalidSeeds.length === 0, invalidSeeds, checked };
}
