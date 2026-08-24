#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(new URL("../", import.meta.url).pathname);
const gateDir = resolve(root, ".quality-gates/QX-R5-001");
const screenshotDir = resolve(gateDir, "screenshots");
const rawVideoDir = resolve(gateDir, "video-raw");
const baseUrl = process.env.R5_CAPTURE_URL ?? "http://127.0.0.1:3000/r5-minimum";
const durationMs = 15_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForTime(page, timeMs) {
  await page.waitForFunction((target) => (window.__R5_MINIMUM_STATE__?.timeMs ?? -1) >= target, timeMs, { timeout: 25_000 });
}

async function driveSuccessfulReplay(page, startedAt) {
  const sleepUntil = async (offsetMs) => {
    const remaining = startedAt + offsetMs - Date.now();
    if (remaining > 0) await page.waitForTimeout(remaining);
  };
  const events = [];
  const key = async (offsetMs, code, holdMs) => {
    await sleepUntil(offsetMs);
    const downAt = Date.now() - startedAt;
    await page.keyboard.down(code);
    await page.waitForTimeout(holdMs);
    await page.keyboard.up(code);
    events.push({ at_ms: downAt, input: `${code}:down` }, { at_ms: Date.now() - startedAt, input: `${code}:up` });
  };
  await key(1_500, "ArrowLeft", 350);
  await key(5_500, "ArrowLeft", 180);
  await key(8_200, "ArrowRight", 1_040);
  await key(10_300, "Space", 40);
  return events;
}

async function captureVideo(browser) {
  await rm(rawVideoDir, { recursive: true, force: true });
  await mkdir(rawVideoDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: rawVideoDir, size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();
  const video = page.video();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__R5_MINIMUM_STATE__ && window.__R5_MINIMUM_TELEMETRY__));
  await waitForTime(page, durationMs);
  await page.getByRole("button", { name: "もう一度" }).click();
  await page.waitForFunction(() => (window.__R5_MINIMUM_STATE__?.timeMs ?? -1) < 1_000);
  const startedAt = Date.now();
  const inputPromise = driveSuccessfulReplay(page, startedAt);
  await waitForTime(page, durationMs);
  const inputs = await inputPromise;
  const state = await page.evaluate(() => window.__R5_MINIMUM_STATE__);
  const runtimeTelemetry = await page.evaluate(() => window.__R5_MINIMUM_TELEMETRY__);
  await page.screenshot({ path: resolve(screenshotDir, "desktop-1920x1080-complete.png") });
  await context.close();
  if (!video) throw new Error("Playwright did not create a video.");
  const rawPath = await video.path();
  const rawDuration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", rawPath], { encoding: "utf8" }).trim());
  const finalPath = resolve(gateDir, "candidate-video-1920x1080.webm");
  const startSeconds = Math.max(0, rawDuration - durationMs / 1_000);
  execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", "-ss", startSeconds.toFixed(6), "-i", rawPath, "-t", "15", "-vf", "fps=25", "-c:v", "libvpx-vp9", "-an", finalPath]);
  return { finalPath, inputs, state, runtimeTelemetry };
}

async function captureStill(browser, viewport, targetMs, name) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: "html { filter: grayscale(1) !important; }" });
  if (targetMs > 0) await waitForTime(page, targetMs);
  await page.screenshot({ path: resolve(screenshotDir, name) });
  await context.close();
}

await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch();
try {
  const video = await captureVideo(browser);
  for (const targetMs of [0, 4_000, 8_000, 12_000]) {
    await captureStill(browser, { width: 1920, height: 1080 }, targetMs, `grayscale-${String(targetMs / 1_000).padStart(2, "0")}s-1920x1080.png`);
  }
  await captureStill(browser, { width: 390, height: 844 }, 7_500, "portrait-390x844.png");
  const videoBytes = await readFile(video.finalPath);
  const inputTrace = {
    schema_version: "r5-minimum-input-trace.v1",
    task_id: "QX-R5-001",
    route: "/r5-minimum",
    viewport: { width: 1920, height: 1080 },
    events: video.inputs,
    final_state: video.state,
  };
  await writeFile(resolve(gateDir, "candidate-input.json"), `${JSON.stringify(inputTrace, null, 2)}\n`);
  await writeFile(resolve(gateDir, "runtime-frame-receipts.json"), `${JSON.stringify(video.runtimeTelemetry, null, 2)}\n`);
  await writeFile(resolve(gateDir, "capture-summary.json"), `${JSON.stringify({
    task_id: "QX-R5-001",
    url: baseUrl,
    video: { path: ".quality-gates/QX-R5-001/candidate-video-1920x1080.webm", sha256: sha256(videoBytes) },
    final_state: video.state,
    runtime_frame_receipts: video.runtimeTelemetry?.length ?? 0,
  }, null, 2)}\n`);
} finally {
  await browser.close();
}
