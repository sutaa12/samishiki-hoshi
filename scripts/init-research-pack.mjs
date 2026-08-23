#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const TASK_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;

function parseArguments(argv) {
  let root = process.cwd();
  let taskId;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      root = resolve(argv[index + 1] ?? "");
      index += 1;
    } else if (!taskId) {
      taskId = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    throw new Error("Task ID is required and must look like QX-R4-001.");
  }
  return { root: resolve(root), taskId };
}

function gitValue(root, args, fallback) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function initializeResearchPack(root, taskId, now = new Date()) {
  const templates = resolve(root, "docs/research/_templates");
  const target = resolve(root, "docs/research", taskId);
  if (await exists(target)) {
    throw new Error(`Research Pack already exists: ${target}`);
  }

  const sourceCommit = gitValue(root, ["rev-parse", "HEAD"], "REPLACE_WITH_SOURCE_COMMIT");
  const branch = gitValue(root, ["branch", "--show-current"], "REPLACE_WITH_CANDIDATE_BRANCH");
  const replacements = new Map([
    ["{{TASK_ID}}", taskId],
    ["{{DATE}}", now.toISOString().slice(0, 10)],
    ["{{SOURCE_COMMIT}}", sourceCommit],
    ["{{CANDIDATE_BRANCH}}", branch],
    ["{{CANDIDATE_WORKTREE}}", root],
  ]);

  const files = (await readdir(templates, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) {
    throw new Error(`No Research Pack templates found in ${templates}`);
  }

  await mkdir(target, { recursive: false });
  for (const file of files) {
    let fileText = await readFile(resolve(templates, file), "utf8");
    for (const [needle, value] of replacements) {
      fileText = fileText.replaceAll(needle, value);
    }
    await writeFile(resolve(target, file), fileText, "utf8");
  }
  return { taskId, sourceCommit, branch, target, files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { root, taskId } = parseArguments(process.argv.slice(2));
    const result = await initializeResearchPack(root, taskId);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
