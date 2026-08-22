import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

const frozenSha256: Readonly<Record<string, string>> = {
  "src/game/model.ts": "9aa6b27123431ccde694f0ecd31e03c66093c4aa04575e05399f82fcb75001b2",
  "src/game/simulation.ts": "5aafeb15658888315532fb22176e4da1aec14487dd690866f5456c51ba841fd7",
  "src/game/procedural.ts": "a47ac1b6e2191aadf4d3ef391d5409791d87431f886588e9ecdcbc314843fbb5",
  "src/game/audio.ts": "c86f1881832ea45a025f9c580afdc5396a53f9e199afab061dfaf3c0f6a7f57f",
  "src/gfx/gfx-spike.ts": "0c1469ee755bbeb9ae4ce28938247a432e8792c7ed18f38b6ad5441df515c022",
  "src/gfx/telemetry.ts": "96d418aaa4e1021d6d15fef46492a34dd0f9289cd14145a877d185703269fb3d",
  "src/gfx/event-store.ts": "fa2c12edb4bcd9193230ad1d5dd8f00af87560fcb227a53d00cb69eda82e12c9",
  "app/gfx-spike/gfx-spike-client.tsx": "6cb13ed064b3267b026d412362a3de7f9fbbc26e7623da2999a9e556f907299b",
  "app/gfx-spike/gfx-spike.module.css": "2fccd30c68636c9f14beaa37f2ba14f448ce2adcbd96b13dbcf4519bb9dba780",
  "app/gfx-spike/page.tsx": "5e260ba07af84a362775ee7fb2c90e61f93d5a28119bd5537355b7fb55b371df",
  "tests/e2e/gfx-spike.spec.ts": "8e0725305b6996844f0913151fda9d10642e7bc3002b7b5caf7653b72b215e76",
  "playwright.config.ts": "c018882efead7eb221aca0242578068130979ae0f05961f64f2f9748c316d7fb",
};

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(join(root, file))).digest("hex");
}

function sourceFiles(directory: string): string[] {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((entry) => {
    const file = join(absolute, entry);
    if (statSync(file).isDirectory()) return sourceFiles(relative(root, file));
    return /\.(?:ts|tsx)$/.test(entry) ? [relative(root, file)] : [];
  });
}

function importsIn(source: string): string[] {
  const imports: string[] = [];
  const expression = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(expression)) imports.push(match[1]);
  return imports;
}

function resolveSourceImport(from: string, imported: string): string | null {
  const base = imported.startsWith("@/")
    ? resolve(root, imported.slice(2))
    : imported.startsWith(".")
      ? resolve(root, dirname(from), imported)
      : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return normalize(relative(root, candidate));
    }
  }
  return null;
}

function productionImportGraph(entry: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    for (const imported of importsIn(readFileSync(join(root, file), "utf8"))) {
      const resolved = resolveSourceImport(file, imported);
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    }
  }
  return visited;
}

describe("R2 production architecture boundary", () => {
  it("keeps the accepted game core and GFX-001 laboratory byte-frozen", () => {
    for (const [file, expected] of Object.entries(frozenSha256)) {
      expect(sha256(file), file).toBe(expected);
    }
  });

  it("keeps production graphics independent from simulation, input, audio, React, and legacy world", () => {
    const forbidden = [
      /(?:^|\/)game\/simulation(?:\.|$)/,
      /(?:^|\/)game\/audio(?:\.|$)/,
      /(?:^|\/)game\/world(?:\.|$)/,
      /(?:^|\/)game\/visual-assets(?:\.|$)/,
      /(?:^|\/)input(?:\.|\/|$)/,
      /(?:^|\/)replay(?:\.|\/|$)/,
      /^react(?:\/|$)/,
    ];
    for (const file of sourceFiles("src/gfx/v2")) {
      const imports = importsIn(readFileSync(join(root, file), "utf8"));
      for (const imported of imports) {
        expect(forbidden.some((rule) => rule.test(imported)), `${file} -> ${imported}`).toBe(false);
      }
    }
  });

  it("keeps canonical world generation free of renderer, browser, simulation, backend, and quality inputs", () => {
    const forbiddenImports = [
      /^three(?:\/|$)/,
      /(?:^|\/)game\/simulation(?:\.|$)/,
      /(?:^|\/)gfx(?:\/|$)/,
      /(?:^|\/)backend(?:\.|\/|$)/,
      /(?:^|\/)quality(?:\.|\/|$)/,
    ];
    const forbiddenRuntime = /\b(?:Math\.random|window|document|navigator|HTMLCanvasElement|WebGLRenderer|WebGPURenderer|GPUDevice)\b/;
    for (const file of sourceFiles("src/world/v2")) {
      const source = readFileSync(join(root, file), "utf8");
      for (const imported of importsIn(source)) {
        expect(forbiddenImports.some((rule) => rule.test(imported)), `${file} -> ${imported}`).toBe(false);
      }
      expect(source, `${file} contains a browser, renderer, or nondeterministic runtime token`).not.toMatch(forbiddenRuntime);
    }
  });

  it("prevents the frozen game core from depending on either v2 namespace", () => {
    for (const file of ["src/game/model.ts", "src/game/simulation.ts", "src/game/procedural.ts"]) {
      const imports = importsIn(readFileSync(join(root, file), "utf8"));
      expect(imports.some((entry) => entry.includes("gfx/v2") || entry.includes("world/v2")), file).toBe(false);
    }
  });

  it("routes the public production entry through v2 without reaching the legacy world", () => {
    const graph = productionImportGraph("app/page.tsx");
    expect(graph.has("app/game-client.tsx")).toBe(true);
    expect(graph.has("src/gfx/v2/integration/production-journey-runtime.ts")).toBe(true);
    expect(graph.has("src/gfx/v2/integration/foundation-runtime.ts")).toBe(true);
    expect(graph.has("src/game/world.ts")).toBe(false);
    expect(graph.has("src/game/visual-assets.ts")).toBe(false);
  });
});
