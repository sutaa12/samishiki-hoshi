#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = require("@playwright/test/package.json").version;

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const TASK_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CHECKPOINTS = Object.freeze([
  { id: "current-life-10s", at: 10, phase: "LIFE", shot: "S03" },
  { id: "current-earth-48s", at: 48, phase: "EARTH", shot: "S08" },
  { id: "current-solitude-142s", at: 142, phase: "SOLITUDE", shot: "S18" },
]);

function parseArguments(argv) {
  const options = {
    baseUrl: "http://localhost:4174/",
    sourceCommit: "",
    taskId: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base-url") options.baseUrl = argv[++index] ?? "";
    else if (argument === "--source-commit") options.sourceCommit = argv[++index] ?? "";
    else if (argument === "--task") options.taskId = argv[++index] ?? "";
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!TASK_ID_PATTERN.test(options.taskId)) throw new Error("--task must be a Task ID such as QX-R4-R01.");
  if (!COMMIT_PATTERN.test(options.sourceCommit)) throw new Error("--source-commit must be a full 40-character Git commit.");
  const url = new URL(options.baseUrl);
  if (!new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname)) {
    throw new Error("Reference baseline capture only accepts a local base URL.");
  }
  return { ...options, baseUrl: url.toString() };
}

function git(...args) {
  const result = spawnSync("git", ["-C", PROJECT_ROOT, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function localhostResponds(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    await fetch(baseUrl, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function startSourceBoundServer(baseUrl) {
  if (await localhostResponds(baseUrl)) {
    throw new Error(`Refusing to capture an existing server at ${baseUrl}; the harness must own the source-bound server.`);
  }
  const url = new URL(baseUrl);
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--host", url.hostname, "--port", url.port],
    {
      cwd: PROJECT_ROOT,
      detached: true,
      env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Source-bound dev server exited ${child.exitCode}: ${output.slice(-4_000)}`);
    if (await localhostResponds(baseUrl)) {
      return {
        command: `npm run dev -- --host ${url.hostname} --port ${url.port}`,
        stop() {
          if (child.pid) {
            try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
          }
        },
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
  throw new Error(`Source-bound dev server did not become ready: ${output.slice(-4_000)}`);
}

function relativeArtifact(path) {
  return relative(PROJECT_ROOT, path).replaceAll("\\", "/");
}

async function openCheckpoint(browser, baseUrl, checkpoint) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const url = new URL(baseUrl);
  url.search = new URLSearchParams({
    qa: "1",
    backend: "webgl2",
    quality: "high",
    speed: "1",
    at: String(checkpoint.at),
    seed: "20260818",
  }).toString();
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  const shell = page.getByTestId("game-shell");
  await shell.waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "旅をはじめる" }).click();
  await page.waitForFunction(
    ({ phase, shot }) => {
      const element = document.querySelector("[data-testid='game-shell']");
      return element?.getAttribute("data-renderer-status") === "ready"
        && element.getAttribute("data-actual-backend") === "webgl2"
        && element.getAttribute("data-phase") === phase
        && element.getAttribute("data-shot") === shot;
    },
    { phase: checkpoint.phase, shot: checkpoint.shot },
    { timeout: 120_000 },
  );
  await page.waitForTimeout(1_000);
  return page;
}

async function captureStill(browser, baseUrl, checkpoint, outputDirectory) {
  const page = await openCheckpoint(browser, baseUrl, checkpoint);
  try {
    const metrics = page.getByTestId("qa-metrics");
    const metricAttributes = await metrics.evaluate((element) => Object.fromEntries(
      Array.from(element.attributes, (attribute) => [attribute.name, attribute.value]),
    ));
    await metrics.evaluate((element) => {
      element.style.display = "none";
    });
    const path = join(outputDirectory, `${checkpoint.id}.png`);
    await page.screenshot({ path });
    const shellAttributes = await page.getByTestId("game-shell").evaluate((element) => Object.fromEntries(
      Array.from(element.attributes, (attribute) => [attribute.name, attribute.value]),
    ));
    const canvasBox = await page.locator("canvas.world-canvas").boundingBox();
    return {
      ...checkpoint,
      path: relativeArtifact(path),
      sha256: await sha256(path),
      viewport: { width: 1920, height: 1080 },
      canvas_box: canvasBox,
      shell: shellAttributes,
      metrics: metricAttributes,
    };
  } finally {
    await page.close();
  }
}

async function captureMovingClip(browser, baseUrl, outputDirectory) {
  const temporaryFrames = await mkdtemp(join(tmpdir(), "lonely-star-r01-frames-"));
  const checkpoint = { id: "current-earth-moving-48s", at: 48, phase: "EARTH", shot: "S08" };
  const page = await openCheckpoint(browser, baseUrl, checkpoint);
  try {
    await page.getByTestId("qa-metrics").evaluate((element) => {
      element.style.display = "none";
    });
    const canvas = page.locator("canvas.world-canvas");
    const sampleCount = 72;
    const framesPerSecond = 6;
    const wallStart = Date.now();
    const storyStart = Number(await page.getByTestId("game-shell").getAttribute("data-story-time"));
    for (let index = 0; index < sampleCount; index += 1) {
      const targetElapsed = index * (1_000 / framesPerSecond);
      const delay = Math.max(0, targetElapsed - (Date.now() - wallStart));
      if (delay > 0) await page.waitForTimeout(delay);
      await canvas.screenshot({ path: join(temporaryFrames, `frame-${String(index).padStart(3, "0")}.png`) });
    }
    const storyEnd = Number(await page.getByTestId("game-shell").getAttribute("data-story-time"));
    const path = join(outputDirectory, "current-earth-moving-12s.webm");
    const result = spawnSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", String(framesPerSecond),
        "-i", join(temporaryFrames, "frame-%03d.png"),
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuv420p",
        "-r", String(framesPerSecond),
        path,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.status !== 0) throw new Error(result.stderr || "ffmpeg failed to encode the moving clip.");
    return {
      id: checkpoint.id,
      path: relativeArtifact(path),
      sha256: await sha256(path),
      frame_count: sampleCount,
      fps: framesPerSecond,
      encoded_duration_seconds: sampleCount / framesPerSecond,
      story_time_start: storyStart,
      story_time_end: storyEnd,
    };
  } finally {
    await page.close();
    await rm(temporaryFrames, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const head = git("rev-parse", "HEAD");
  if (head !== options.sourceCommit) {
    throw new Error(`HEAD ${head} does not match --source-commit ${options.sourceCommit}.`);
  }
  if (git("status", "--short")) {
    throw new Error("The complete worktree must be clean before capture.");
  }
  const server = await startSourceBoundServer(options.baseUrl);
  const outputDirectory = resolve(PROJECT_ROOT, ".quality-gates", options.taskId);
  await mkdir(outputDirectory, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ["--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=metal"],
  });
  try {
    const browserVersion = await browser.version();
    const ffmpegVersion = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout.split("\n")[0]?.trim();
    const checkpoints = [];
    for (const checkpoint of CHECKPOINTS) {
      checkpoints.push(await captureStill(browser, options.baseUrl, checkpoint, outputDirectory));
    }
    const clip = await captureMovingClip(browser, options.baseUrl, outputDirectory);
    const receipt = {
      schema_version: "current-reference-capture.v1",
      task_id: options.taskId,
      source_commit: options.sourceCommit,
      source_tree: git("rev-parse", `${options.sourceCommit}^{tree}`),
      base_url: options.baseUrl,
      server_command: server.command,
      captured_at: new Date().toISOString(),
      rights: "Project-owned runtime capture; third-party media is not embedded.",
      conditions: {
        viewport: { width: 1920, height: 1080 },
        backend: "webgl2",
        quality: "high",
        seed: "20260818",
      },
      toolchain: {
        playwright: PLAYWRIGHT_VERSION,
        chromium: browserVersion,
        ffmpeg: ffmpegVersion,
      },
      checkpoints,
      clip,
    };
    const metricsPath = join(outputDirectory, "current-capture-metrics.json");
    await writeFile(metricsPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      task_id: options.taskId,
      source_commit: options.sourceCommit,
      metrics: relativeArtifact(metricsPath),
      screenshot: checkpoints.find((entry) => entry.at === 48)?.path,
      clip: clip.path,
      files: [...checkpoints.map((entry) => basename(entry.path)), basename(clip.path), basename(metricsPath)],
    }, null, 2)}\n`);
  } finally {
    await browser.close();
    server.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
