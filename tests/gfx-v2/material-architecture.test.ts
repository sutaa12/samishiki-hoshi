import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("GFX-005 material and pipeline source boundary", () => {
  it("contains no raw shader, WGSL, GLSL, or copied-demo material path", () => {
    const roots = [
      join(process.cwd(), "src/gfx/v2/materials"),
      join(process.cwd(), "src/gfx/v2/pipeline"),
    ];
    for (const file of roots.flatMap(sourceFiles)) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/ShaderMaterial|\bWGSL\b|\bGLSL\b|wgslFn|glslFn/);
      expect(source, file).not.toMatch(/three\/examples|webgpu_(?:materials|postprocessing)|demo[-_/ ]shader/i);
    }
  });

  it("owns one explicit ACES plus sRGB output transform and disables the automatic transform", () => {
    const source = readFileSync(
      join(process.cwd(), "src/gfx/v2/pipeline/linear-hdr-pipeline.ts"),
      "utf8",
    );
    expect(source.match(/renderOutput\s*\(/g)).toHaveLength(1);
    expect(source).toContain("ACESFilmicToneMapping");
    expect(source).toContain("SRGBColorSpace");
    expect(source).toContain("HalfFloatType");
    expect(source).toMatch(/outputColorTransform\s*=\s*false/);
  });
});
