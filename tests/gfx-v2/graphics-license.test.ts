import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

type LockPackage = Readonly<{
  version?: string;
  license?: string;
  dev?: boolean;
}>;

function productionSourceFiles(directory: string): readonly string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else if (/\.(?:css|ts|tsx)$/.test(name)) {
        files.push(path);
      }
    }
  };
  visit(directory);
  return Object.freeze(files.sort());
}

describe("R2-G6 runtime license and provenance boundary", () => {
  it("pins the complete non-dev browser package closure to four MIT packages", () => {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
      readonly packages: Readonly<Record<string, LockPackage>>;
    };
    const runtime = Object.entries(lock.packages)
      .filter(([path, entry]) => path.startsWith("node_modules/") && entry.dev !== true)
      .map(([path, entry]) => Object.freeze({
        name: path.slice("node_modules/".length),
        version: entry.version,
        license: entry.license,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    expect(runtime).toEqual([
      { name: "react", version: "19.2.6", license: "MIT" },
      { name: "react-dom", version: "19.2.6", license: "MIT" },
      { name: "scheduler", version: "0.27.0", license: "MIT" },
      { name: "three", version: "0.185.1", license: "MIT" },
    ]);
  });

  it("ships the exact runtime notices and records every Hero source pin", () => {
    const notice = readFileSync(join(root, "public/THIRD_PARTY_NOTICES.txt"), "utf8");
    for (const identity of [
      "react 19.2.6",
      "react-dom 19.2.6",
      "scheduler 0.27.0",
      "three 0.185.1",
      "Copyright (c) Meta Platforms, Inc. and affiliates.",
      "Copyright © 2010-2026 three.js authors",
      "Permission is hereby granted",
    ]) {
      expect(notice).toContain(identity);
    }

    const provenance = readFileSync(join(root, "DEMO_SOURCE_PROVENANCE.csv"), "utf8");
    expect(provenance).toContain("HERO-A-20260820");
    expect(provenance).toContain("8ca6e9a23930184454c1653131c637c5e1795f1c");
    expect(provenance).toContain("HERO-B-20260820");
    expect(provenance).toContain("de559f8a60a9d838bd428ca8e604a6ee94efd4f7");
    expect(provenance).toContain("HERO-C-20260820");
    expect(provenance).toContain("1d097899f08a74cfd649b91f48dc7ea1b20a43ef");
  });

  it("keeps the Notion reference boards outside every production module", () => {
    const sources = [
      ...productionSourceFiles(join(root, "app")),
      ...productionSourceFiles(join(root, "src")),
    ];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      expect(source, relative(root, file)).not.toContain("source-notion-20260818");
      expect(source, relative(root, file)).not.toContain("cinematic-gallery-");
    }
  });
});
