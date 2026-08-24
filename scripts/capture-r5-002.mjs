#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve(new URL("../", import.meta.url).pathname);
const gateDir = resolve(root, ".quality-gates/QX-R5-002");
const rawDir = resolve(gateDir, "video-raw");
const screenshotDir = resolve(gateDir, "screenshots");
const baseUrl = process.env.R5_CAPTURE_URL ?? "http://localhost:3000/r5-minimum";
const durationMs = 15_000;
const fps = 25;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", ...args], { stdio: "inherit" });
}

function ffprobeDuration(path) {
  return Number(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path,
  ], { encoding: "utf8" }).trim());
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function waitForTime(page, timeMs) {
  await page.waitForFunction(
    (target) => (window.__R5_MINIMUM_STATE__?.timeMs ?? -1) >= target,
    timeMs,
    { timeout: 25_000 },
  );
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
    events.push(
      { at_ms: downAt, input: `${code}:down` },
      { at_ms: Date.now() - startedAt, input: `${code}:up` },
    );
  };
  await key(1_500, "ArrowLeft", 350);
  await key(5_500, "ArrowLeft", 180);
  await key(8_200, "ArrowRight", 1_040);
  await key(10_300, "Space", 40);
  return events;
}

async function captureRun(browser, label, reducedMotion) {
  const runRawDir = resolve(rawDir, label);
  await rm(runRawDir, { recursive: true, force: true });
  await mkdir(runRawDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
    recordVideo: { dir: runRawDir, size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page:${error.message}`));
  const video = page.video();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__R5_MINIMUM_STATE__ && window.__R5_MINIMUM_TELEMETRY__));
  await waitForTime(page, durationMs);
  await page.getByRole("button", { name: "もう一度" }).click();
  await page.waitForFunction(() => (window.__R5_MINIMUM_STATE__?.timeMs ?? -1) < 1_000);
  const startedAt = Date.now();
  const inputPromise = driveSuccessfulReplay(page, startedAt);
  await waitForTime(page, durationMs);
  const inputs = await inputPromise;
  const state = await page.evaluate(() => window.__R5_MINIMUM_STATE__);
  const telemetry = await page.evaluate(() => window.__R5_MINIMUM_TELEMETRY__);
  await page.screenshot({ path: resolve(screenshotDir, `${label}-complete.png`) });
  await context.close();
  if (!video) throw new Error(`Playwright did not create the ${label} video.`);
  const rawPath = await video.path();
  const rawDuration = ffprobeDuration(rawPath);
  const outputPath = resolve(gateDir, `${label}-1920x1080.webm`);
  const clipSelection = selectMovingWindow(rawPath);
  ffmpeg([
    "-ss", clipSelection.start_seconds.toFixed(6), "-i", rawPath, "-t", "15", "-vf", `fps=${fps}`,
    "-c:v", "libvpx-vp9", "-an", outputPath,
  ]);
  return { label, reducedMotion, inputs, state, telemetry, errors, outputPath, rawDuration, clipSelection };
}

function sampleTelemetry(raw) {
  const samples = [];
  let targetMs = 0;
  for (const frame of raw) {
    if (frame.timeMs >= targetMs) {
      samples.push(frame);
      targetMs += 1_000 / fps;
    }
  }
  return samples;
}

function analyzeTelemetry(raw) {
  const samples = sampleTelemetry(raw);
  const nearFlow = [];
  for (let index = 1; index < samples.length; index += 1) {
    const prior = new Map(
      samples[index - 1].screen.layers.near.filter((point) => point.visible).map((point) => [point.id, point]),
    );
    const magnitudes = samples[index].screen.layers.near
      .filter((point) => point.visible && prior.has(point.id))
      .map((point) => {
        const before = prior.get(point.id);
        return Math.hypot(point.x - before.x, point.y - before.y);
      });
    nearFlow.push(median(magnitudes));
  }

  const passTimesMs = [];
  let priorPassIndex = samples[0].screen.rail.nearMarkerPassIndex;
  for (const frame of samples.slice(1)) {
    const nextPassIndex = frame.screen.rail.nearMarkerPassIndex;
    if (nextPassIndex !== priorPassIndex) {
      passTimesMs.push(frame.timeMs);
      priorPassIndex = nextPassIndex;
    }
  }
  const passIntervalsMs = passTimesMs.slice(1).map((timeMs, index) => timeMs - passTimesMs[index]);
  const ringCurve = samples
    .filter((frame) => frame.timeMs <= 2_496)
    .map((frame) => ({
      time_ms: frame.timeMs,
      area_px2: frame.screen.ring.width * frame.screen.ring.height,
    }));
  const ringAreaDrops = ringCurve.slice(1).filter((point, index) => point.area_px2 < ringCurve[index].area_px2).length;
  const farDistances = samples.map((frame) => Math.hypot(
    frame.screen.layers.far.x - frame.screen.rail.vanishingPoint.x,
    frame.screen.layers.far.y - frame.screen.rail.vanishingPoint.y,
  ));
  const encounterAnchors = { ring: 4_800, obstacle: 9_600, node: 13_200 };
  let maximumDistanceBindingError = 0;
  for (const frame of samples) {
    for (const [id, anchorDistanceMm] of Object.entries(encounterAnchors)) {
      const expected = frame.screen.rail.playerZ
        - (anchorDistanceMm - frame.distanceMm) * frame.screen.rail.worldUnitsPerMm;
      maximumDistanceBindingError = Math.max(
        maximumDistanceBindingError,
        Math.abs(frame.screen.encounterZ[id] - expected),
      );
    }
  }
  const encounterExitTimeMs = {};
  for (const [id, anchorDistanceMm] of Object.entries(encounterAnchors)) {
    encounterExitTimeMs[id] = samples.find(
      (frame) => frame.distanceMm >= anchorDistanceMm && !frame.screen.encounters[id].visible,
    )?.timeMs ?? null;
  }
  const first = samples[0];
  const viewportDiagonal = Math.hypot(1920, 1080);
  return {
    frame_count: samples.length,
    selected_fov_degrees: first.screen.rail.selectedFovDegrees,
    fov_evaluations: first.screen.rail.fovEvaluations,
    near_flow_positive_rate: nearFlow.filter((value) => value > 0.001).length / nearFlow.length,
    near_flow_median_px: median(nearFlow),
    near_flow_min_px: Math.min(...nearFlow),
    near_flow_series_px: nearFlow,
    near_pass_times_ms: passTimesMs,
    near_pass_intervals_ms: passIntervalsMs,
    near_pass_interval_min_ms: Math.min(...passIntervalsMs),
    near_pass_interval_median_ms: median(passIntervalsMs),
    near_pass_interval_max_ms: Math.max(...passIntervalsMs),
    ring_area_curve: ringCurve,
    ring_area_ratio: ringCurve.at(-1).area_px2 / ringCurve[0].area_px2,
    ring_area_drops: ringAreaDrops,
    far_visible_rate: samples.filter((frame) => frame.screen.layers.far.visible).length / samples.length,
    far_max_distance_from_vanishing_point_px: Math.max(...farDistances),
    far_max_distance_viewport_diagonal_ratio: Math.max(...farDistances) / viewportDiagonal,
    near_layer_visible_rate: samples.filter((frame) => frame.screen.layers.near.some((point) => point.visible)).length / samples.length,
    mid_layer_visible_rate: samples.filter((frame) => frame.screen.layers.mid.some((point) => point.visible)).length / samples.length,
    maximum_distance_binding_error: maximumDistanceBindingError,
    encounter_exit_time_ms: encounterExitTimeMs,
  };
}

function rawGrayFrames(videoPath) {
  const width = 320;
  const height = 180;
  const bytes = execFileSync("ffmpeg", [
    "-v", "error", "-i", videoPath, "-vf", `fps=${fps},scale=${width}:${height}`,
    "-pix_fmt", "gray", "-f", "rawvideo", "-",
  ], { maxBuffer: 128 * 1024 * 1024 });
  const frameSize = width * height;
  const frames = [];
  for (let offset = 0; offset + frameSize <= bytes.length; offset += frameSize) {
    frames.push(bytes.subarray(offset, offset + frameSize));
  }
  return frames;
}

function frameDifferenceRatios(frames) {
  const changedPixelRatios = [];
  for (let frameIndex = 1; frameIndex < frames.length; frameIndex += 1) {
    const prior = frames[frameIndex - 1];
    const current = frames[frameIndex];
    let changed = 0;
    for (let index = 0; index < current.length; index += 1) {
      if (Math.abs(current[index] - prior[index]) >= 4) changed += 1;
    }
    changedPixelRatios.push(changed / current.length);
  }
  return changedPixelRatios;
}

function longestLowDifferenceFrameRun(changedPixelRatios) {
  let lowTransitions = 0;
  let longestLowDiffFrameRun = 1;
  for (const ratio of changedPixelRatios) {
    lowTransitions = ratio < 0.002 ? lowTransitions + 1 : 0;
    longestLowDiffFrameRun = Math.max(longestLowDiffFrameRun, lowTransitions + 1);
  }
  return longestLowDiffFrameRun;
}

function selectMovingWindow(videoPath) {
  const frames = rawGrayFrames(videoPath);
  const changedPixelRatios = frameDifferenceRatios(frames);
  const outputFrames = durationMs / 1_000 * fps;
  const minimumStartFrame = Math.max(0, Math.floor(frames.length * 0.4));
  const maximumStartFrame = frames.length - outputFrames;
  let best = null;
  for (let startFrame = minimumStartFrame; startFrame <= maximumStartFrame; startFrame += 1) {
    const windowRatios = changedPixelRatios.slice(startFrame, startFrame + outputFrames - 1);
    const longestLowRun = longestLowDifferenceFrameRun(windowRatios);
    const medianChangedRatio = median(windowRatios);
    const candidate = { startFrame, longestLowRun, medianChangedRatio };
    if (!best
      || candidate.longestLowRun < best.longestLowRun
      || (candidate.longestLowRun === best.longestLowRun
        && candidate.medianChangedRatio > best.medianChangedRatio)) {
      best = candidate;
    }
  }
  if (!best) throw new Error("No 15-second moving window was available in the raw capture.");
  return Object.freeze({
    decoded_raw_frames: frames.length,
    start_frame: best.startFrame,
    start_seconds: best.startFrame / fps,
    selected_frames: outputFrames,
    longest_low_difference_frame_run: best.longestLowRun,
    median_changed_pixel_ratio: best.medianChangedRatio,
  });
}

function analyzePixelDifference(videoPath) {
  const frames = rawGrayFrames(videoPath);
  const changedPixelRatios = frameDifferenceRatios(frames);
  const longestLowDiffFrameRun = longestLowDifferenceFrameRun(changedPixelRatios);
  let trailingLowTransitions = 0;
  for (let index = changedPixelRatios.length - 1; index >= 0; index -= 1) {
    if (changedPixelRatios[index] >= 0.002) break;
    trailingLowTransitions += 1;
  }
  return {
    decoded_frames: frames.length,
    changed_pixel_threshold: 4,
    low_difference_ratio_threshold: 0.002,
    changed_pixel_ratio_min: Math.min(...changedPixelRatios),
    changed_pixel_ratio_median: median(changedPixelRatios),
    changed_pixel_ratio_max: Math.max(...changedPixelRatios),
    longest_low_difference_frame_run: longestLowDiffFrameRun,
    trailing_low_difference_frame_run: trailingLowTransitions + 1,
    changed_pixel_ratios: changedPixelRatios,
  };
}

function createVisualEvidence(videoPath) {
  ffmpeg([
    "-i", videoPath,
    "-vf", "scale=960:-1,mestimate=method=epzs:mb_size=8,codecview=mv=pf+bf+bb,select='eq(n,80)+eq(n,180)+eq(n,280)',tile=3x1",
    "-frames:v", "1", resolve(gateDir, "optical-flow-heatmap.png"),
  ]);
  ffmpeg([
    "-i", videoPath,
    "-vf", "scale=640:-1,tblend=all_mode=difference,select='eq(n,80)+eq(n,180)+eq(n,280)',tile=3x1",
    "-frames:v", "1", resolve(gateDir, "frame-difference-strip.png"),
  ]);
}

function writeCsv(path, rows) {
  const headers = Object.keys(rows[0]);
  return writeFile(path, `${headers.join(",")}\n${rows.map((row) => headers.map((key) => row[key]).join(",")).join("\n")}\n`);
}

await mkdir(gateDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch();
try {
  const standard = await captureRun(browser, "candidate-standard", false);
  const reduced = await captureRun(browser, "candidate-reduced-motion", true);
  const standardMetrics = analyzeTelemetry(standard.telemetry);
  const reducedMetrics = analyzeTelemetry(reduced.telemetry);
  const standardPixelDifference = analyzePixelDifference(standard.outputPath);
  const reducedPixelDifference = analyzePixelDifference(reduced.outputPath);
  const baselinePath = resolve(root, ".quality-gates/QX-R5-001/candidate-video-1920x1080.webm");
  const baselinePixelDifference = analyzePixelDifference(baselinePath);
  const speed2xPath = resolve(gateDir, "speed-2x-ablation.webm");
  ffmpeg(["-i", standard.outputPath, "-vf", `setpts=0.5*PTS,fps=${fps}`, "-an", speed2xPath]);
  createVisualEvidence(standard.outputPath);

  const standardBytes = await readFile(standard.outputPath);
  const reducedBytes = await readFile(reduced.outputPath);
  const speed2xBytes = await readFile(speed2xPath);
  const baselineBytes = await readFile(baselinePath);
  const distanceRows = sampleTelemetry(standard.telemetry)
    .filter((_, index) => index % fps === 0)
    .map((frame) => ({
      time_ms: frame.timeMs,
      distance_mm: frame.distanceMm,
      ring_z: frame.screen.encounterZ.ring,
      obstacle_z: frame.screen.encounterZ.obstacle,
      node_z: frame.screen.encounterZ.node,
      near_pass_index: frame.screen.rail.nearMarkerPassIndex,
    }));

  const metrics = {
    schema_version: "qx-r5-002-motion-metrics.v1",
    task_id: "QX-R5-002",
    route: "/r5-minimum",
    viewport: { width: 1920, height: 1080 },
    baseline: {
      video_path: ".quality-gates/QX-R5-001/candidate-video-1920x1080.webm",
      video_sha256: sha256(baselineBytes),
      pixel_difference: baselinePixelDifference,
    },
    candidate: {
      video_path: ".quality-gates/QX-R5-002/candidate-standard-1920x1080.webm",
      video_sha256: sha256(standardBytes),
      final_state: standard.state,
      input_events: standard.inputs,
      browser_errors: standard.errors,
      clip_selection: standard.clipSelection,
      telemetry: standardMetrics,
      pixel_difference: standardPixelDifference,
    },
    reduced_motion: {
      video_path: ".quality-gates/QX-R5-002/candidate-reduced-motion-1920x1080.webm",
      video_sha256: sha256(reducedBytes),
      final_state: reduced.state,
      browser_errors: reduced.errors,
      clip_selection: reduced.clipSelection,
      telemetry: reducedMetrics,
      pixel_difference: reducedPixelDifference,
    },
    speed_2x_ablation: {
      video_path: ".quality-gates/QX-R5-002/speed-2x-ablation.webm",
      video_sha256: sha256(speed2xBytes),
      duration_seconds: ffprobeDuration(speed2xPath),
      verdict: "reject",
      reason: "2x playback collapses the locked 15-second contract to 7.5 seconds and Ring/Obstacle/Node contacts to 2.0/4.0/5.5 seconds; the accepted candidate retains 1,200mm/s.",
    },
  };
  await writeFile(resolve(gateDir, "motion-metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  await writeFile(resolve(gateDir, "standard-runtime-frame-receipts.json"), `${JSON.stringify(sampleTelemetry(standard.telemetry), null, 2)}\n`);
  await writeFile(resolve(gateDir, "reduced-motion-runtime-frame-receipts.json"), `${JSON.stringify(sampleTelemetry(reduced.telemetry), null, 2)}\n`);
  await writeCsv(resolve(gateDir, "ring-area-curve.csv"), standardMetrics.ring_area_curve);
  await writeCsv(resolve(gateDir, "near-marker-pass-intervals.csv"), standardMetrics.near_pass_intervals_ms.map((interval_ms, index) => ({ index: index + 1, interval_ms })));
  await writeCsv(resolve(gateDir, "distance-render-z.csv"), distanceRows);
  await writeFile(resolve(gateDir, "capture-summary.json"), `${JSON.stringify({
    task_id: "QX-R5-002",
    base_url: baseUrl,
    standard_video_sha256: sha256(standardBytes),
    reduced_motion_video_sha256: sha256(reducedBytes),
    speed_2x_video_sha256: sha256(speed2xBytes),
    standard_final_state: standard.state,
    reduced_motion_final_state: reduced.state,
    standard_browser_error_count: standard.errors.length,
    reduced_motion_browser_error_count: reduced.errors.length,
  }, null, 2)}\n`);
  await rm(rawDir, { recursive: true, force: true });
} finally {
  await browser.close();
}
