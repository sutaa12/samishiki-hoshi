#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function parseArguments(argv) {
  let sourceCommit = "";
  let output = "";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--source-commit") sourceCommit = argv[++index] ?? "";
    else if (argv[index] === "--output") output = argv[++index] ?? "";
    else throw new Error(`Unexpected argument: ${argv[index]}`);
  }
  if (!COMMIT_PATTERN.test(sourceCommit)) throw new Error("--source-commit must be a full Git commit.");
  if (!output) throw new Error("--output is required.");
  const outputPath = resolve(PROJECT_ROOT, output);
  if (!relative(PROJECT_ROOT, outputPath) || relative(PROJECT_ROOT, outputPath).startsWith("..")) {
    throw new Error("--output must be a repository-contained file outside the repository root.");
  }
  return { sourceCommit, outputPath };
}

function git(...args) {
  const result = spawnSync("git", ["-C", PROJECT_ROOT, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function walk(directory) {
  const files = [];
  for (const name of await readdir(directory)) {
    const path = resolve(directory, name);
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`Build contains a symlink: ${relative(PROJECT_ROOT, path)}`);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function main() {
  const { sourceCommit, outputPath } = parseArguments(process.argv.slice(2));
  if (git("rev-parse", "HEAD") !== sourceCommit) throw new Error("HEAD does not match --source-commit.");
  const dist = resolve(PROJECT_ROOT, "dist");
  const files = (await walk(dist)).sort((a, b) => relative(dist, a).localeCompare(relative(dist, b)));
  if (files.length === 0) throw new Error("dist has no files; run npm run build first.");
  const lines = [];
  for (const path of files) {
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    lines.push(`${digest}  ./${relative(dist, path).replaceAll("\\", "/")}`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  const manifestSha256 = createHash("sha256").update(await readFile(outputPath)).digest("hex");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    source_commit: sourceCommit,
    output: relative(PROJECT_ROOT, outputPath).replaceAll("\\", "/"),
    files: files.length,
    manifest_sha256: manifestSha256,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
