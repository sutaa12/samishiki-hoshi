import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("release safety", () => {
  it("uses only allowlisted runtime dependency licenses", async () => {
    const project = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as {
      dependencies: Record<string, string>;
    };
    for (const dependency of Object.keys(project.dependencies)) {
      const manifest = JSON.parse(
        await readFile(new URL(`node_modules/${dependency}/package.json`, root), "utf8"),
      ) as { license?: string };
      expect(["MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"]).toContain(manifest.license);
    }
  });

  it("keeps gameplay free of runtime network clients", async () => {
    const files = [
      "app/game-client.tsx",
      "src/game/audio.ts",
      "src/game/model.ts",
      "src/game/procedural.ts",
      "src/game/simulation.ts",
      "src/game/world.ts",
    ];
    const source = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource/);
    expect(source).not.toMatch(/https?:\/\//);
  });

  it("ships the exact 1600 by 900 PNG thumbnail", async () => {
    const png = await readFile(new URL("public/og.png", root));
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1600);
    expect(png.readUInt32BE(20)).toBe(900);
    expect(png.byteLength).toBeLessThan(10 * 1024 * 1024);
  });
});

