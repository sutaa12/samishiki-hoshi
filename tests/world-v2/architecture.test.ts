import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WORLD_GENERATOR_VERSION,
  createWorldGenerationContext,
  generateWorldPlan,
} from "../../src/world/v2";

const root = process.cwd();

function sourceFiles(directory: string): string[] {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((entry) => {
    const file = join(absolute, entry);
    if (statSync(file).isDirectory()) return sourceFiles(relative(root, file));
    return /\.ts$/.test(entry) ? [relative(root, file)] : [];
  });
}

function importsIn(source: string): string[] {
  const imports: string[] = [];
  const expression = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(expression)) imports.push(match[1]);
  return imports;
}

function objectKeysDeep(value: unknown, keys: string[] = []): string[] {
  if (value === null || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const child of value) objectKeysDeep(child, keys);
    return keys;
  }
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    objectKeysDeep(child, keys);
  }
  return keys;
}

describe("GFX-003 canonical-world architecture", () => {
  it("has a real world-v2 implementation so the boundary suite cannot pass vacuously", () => {
    const files = sourceFiles("src/world/v2");
    expect(files).toContain("src/world/v2/index.ts");
    expect(files.length).toBeGreaterThan(1);
  });

  it("does not import renderer, browser, simulation, quality, or backend implementations", () => {
    const forbiddenImports = [
      /^three(?:\/|$)/,
      /^react(?:\/|$)/,
      /^node:/,
      /(?:^|\/)game\/simulation(?:\.|$)/,
      /(?:^|\/)game\/world(?:\.|$)/,
      /(?:^|\/)game\/visual-assets(?:\.|$)/,
      /(?:^|\/)gfx(?:\/|$)/,
      /(?:^|\/)backend(?:\.|\/|$)/,
      /(?:^|\/)quality(?:\.|\/|$)/,
    ];
    const forbiddenRuntime = /\b(?:Math\.random|Date\.now|performance\.now|randomUUID|getRandomValues|window|document|navigator|HTMLCanvasElement|WebGLRenderer|WebGPURenderer|GPUDevice)\b/;
    const files = sourceFiles("src/world/v2");
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const source = readFileSync(join(root, file), "utf8");
      for (const imported of importsIn(source)) {
        expect(forbiddenImports.some((rule) => rule.test(imported)), `${file} -> ${imported}`).toBe(false);
        if (imported.startsWith(".")) {
          const target = relative(root, resolve(dirname(join(root, file)), imported));
          expect(
            target === "src/game/model" || target.startsWith("src/world/v2/"),
            `${file} imports a non-world dependency: ${imported}`,
          ).toBe(true);
        } else {
          expect(imported, `${file} imports an external dependency`).toBe("../../game/model");
        }
      }
      expect(source, `${file} contains a browser, renderer, clock, or nondeterministic random token`).not.toMatch(forbiddenRuntime);
    }
  });

  it("keeps backend and quality facts out of the canonical context and plan", () => {
    const context = createWorldGenerationContext({
      worldSeed: 20_260_818,
      generatorVersion: WORLD_GENERATOR_VERSION,
    });
    const plan = generateWorldPlan(context);
    const keys = objectKeysDeep({ context, plan });

    expect(keys.filter((key) => /quality|backend|webgpu|webgl/i.test(key))).toEqual([]);
  });

  it("isolates the only mutable SHOT_TABLE import behind the verified story-score snapshot", () => {
    const worldPlan = readFileSync(join(root, "src/world/v2/world-plan.ts"), "utf8");
    const validation = readFileSync(join(root, "src/world/v2/validation.ts"), "utf8");
    const storyScore = readFileSync(join(root, "src/world/v2/story-score.ts"), "utf8");

    expect(worldPlan).not.toMatch(/\bSHOT_TABLE\b/);
    expect(validation).not.toMatch(/\bSHOT_TABLE\b/);
    expect(storyScore).toMatch(/import \{ SHOT_TABLE/);
    expect(storyScore).toMatch(/PINNED_STORY_SCORE_DIGEST/);
    expect(storyScore).toMatch(/deepFreeze\(capturedStoryScore\)/);
  });

  it("fails module initialization when SHOT_TABLE was mutated before snapshot capture", async () => {
    vi.resetModules();
    const model = await import("../../src/game/model");
    const shots = model.SHOT_TABLE as unknown as Array<{ cue: string }>;
    const first = shots[0];
    if (!first) throw new Error("Expected S01 in mutable source score.");
    const originalCue = first.cue;
    try {
      first.cue = "pre-import-mutation";
      await expect(import("../../src/world/v2/story-score")).rejects.toThrow(/integrity mismatch/i);
    } finally {
      first.cue = originalCue;
      vi.resetModules();
    }
  });
});
