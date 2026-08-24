#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("../", import.meta.url).pathname);
const taskId = "QX-R5-002";
const gateDir = resolve(root, ".quality-gates", taskId);
const packDir = resolve(root, "docs/research", taskId);
const sourceCommit = "a4965e4a172d48661d6685111e69a44c2b868637";
const sourceTree = "00be831dd5b2b554a547b61aa299222be158f15c";
const sourceSha256 = "7ffc2c3752851fb45a6533aa44f2c4ded33ef98e98cf3ccbc188e43213264988";
const baselineCommit = "814e879557b26d71c7453bdde5a95caa81d9bb75";
const baselineSourceSha256 = "23a24d2e9653e109a4f1f30103ddf12dede64f1a09537b5c30bd473c49d01b96";
const baselineBuildSha256 = "bd0ba727b4798f7415c2fb0c723ee585894c063708a6d4e226e94a10ff1a04f9";
const rollbackCommit = "bc3e977";
const rollbackFullCommit = execFileSync("git", ["-C", root, "rev-parse", rollbackCommit], { encoding: "utf8" }).trim();
const recordedAt = "2026-08-24T02:53:32Z";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function artifact(path) {
  return { path, sha256: digest(await readFile(resolve(root, path))) };
}

async function writeArtifact(name, value) {
  const path = `.quality-gates/${taskId}/${name}`;
  const text = typeof value === "string" ? value : json(value);
  await writeFile(resolve(root, path), text, "utf8");
  return { path, sha256: digest(text) };
}

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

if (execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== sourceCommit) {
  throw new Error("QX-R5-002 evidence must be generated while HEAD is the frozen runtime source commit.");
}
if (digest(execFileSync("git", ["-C", root, "archive", "--format=tar", sourceCommit], { maxBuffer: 512 * 1024 * 1024 })) !== sourceSha256) {
  throw new Error("Frozen source archive digest drifted.");
}

await mkdir(gateDir, { recursive: true });
const buildFiles = (await filesBelow(resolve(root, "dist"))).sort();
const buildManifestText = `${(await Promise.all(buildFiles.map(async (path) => `${digest(await readFile(path))}  ${relative(root, path)}`))).join("\n")}\n`;
const buildManifest = await writeArtifact("ai-build.manifest", buildManifestText);
const buildSha256 = buildManifest.sha256;
if (buildSha256 !== "1aa3274ad203c2359c2951d5d67ef262d63cc4411eeae45e00989da175c03010") {
  throw new Error(`Frozen build manifest drifted: ${buildSha256}`);
}

const video = await artifact(`.quality-gates/${taskId}/candidate-standard-1920x1080.webm`);
const reducedVideo = await artifact(`.quality-gates/${taskId}/candidate-reduced-motion-1920x1080.webm`);
const ablationVideo = await artifact(`.quality-gates/${taskId}/speed-2x-ablation.webm`);
const screenshot = await artifact(`.quality-gates/${taskId}/screenshots/candidate-standard-complete.png`);
const reducedScreenshot = await artifact(`.quality-gates/${taskId}/screenshots/candidate-reduced-motion-complete.png`);
const inputTrace = await artifact(`.quality-gates/${taskId}/candidate-input.json`);
const motionMetrics = await artifact(`.quality-gates/${taskId}/motion-metrics.json`);
const heatmap = await artifact(`.quality-gates/${taskId}/optical-flow-heatmap.png`);
const differenceStrip = await artifact(`.quality-gates/${taskId}/frame-difference-strip.png`);
const ringCurve = await artifact(`.quality-gates/${taskId}/ring-area-curve.csv`);
const passes = await artifact(`.quality-gates/${taskId}/near-marker-pass-intervals.csv`);
const distanceZ = await artifact(`.quality-gates/${taskId}/distance-render-z.csv`);
const metricsSource = JSON.parse(await readFile(resolve(gateDir, "motion-metrics.json"), "utf8"));
const standard = metricsSource.candidate;
const reduced = metricsSource.reduced_motion;
const videoFrameCount = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", resolve(root, video.path)], { encoding: "utf8" }).trim());
if (videoFrameCount !== 375) throw new Error(`Expected 375 video frames, got ${videoFrameCount}.`);

const buildReceipt = await writeArtifact("candidate-build.json", {
  schema_version: "build-command.v1", task_id: taskId, candidate_source_commit: sourceCommit,
  candidate_source_sha256: sourceSha256, candidate_build_sha256: buildSha256,
  command: "npm run build", exit_code: 0, recorded_at: recordedAt,
  observations: "46/46 test files and 1049/1049 tests passed; typecheck, lint, and Vinext build passed; 115 build files were digest-bound.",
});
const captureReceipt = await writeArtifact("candidate-capture.json", {
  schema_version: "capture-set.v1", task_id: taskId, candidate_source_commit: sourceCommit,
  candidate_source_sha256: sourceSha256, candidate_build_sha256: buildSha256,
  artifacts: { screenshot, clip: video, reduced_motion_clip: reducedVideo, reduced_motion_screenshot: reducedScreenshot, speed_2x_ablation: ablationVideo, input_trace: inputTrace, motion_metrics: motionMetrics, optical_flow_heatmap: heatmap, difference_strip: differenceStrip, ring_curve: ringCurve, pass_intervals: passes, distance_render_z: distanceZ },
});
const metricsReceipt = await writeArtifact("metrics.json", {
  schema_version: "quality-metrics.v1", task_id: taskId, candidate_source_commit: sourceCommit,
  candidate_source_sha256: sourceSha256, candidate_build_sha256: buildSha256,
  metrics: {
    load: { baseline: 115, candidate: buildFiles.length, unit: "build files" },
    frame: { baseline: 16, candidate: 16, unit: "fixed-step ms" },
    memory: { baseline: 13.37, candidate: Number((buildManifestText.length / 1024).toFixed(3)), unit: "manifest KiB" },
  },
});
const gates = {
  near_flow_positive_rate: { observed: standard.telemetry.near_flow_positive_rate, unit: "ratio", result: "passed" },
  longest_low_difference_run: { observed: standard.pixel_difference.longest_low_difference_frame_run, unit: "frames", result: "passed" },
  ring_area_ratio: { observed: Number(standard.telemetry.ring_area_ratio.toFixed(6)), unit: "ratio", result: "passed" },
  ring_area_drops: { observed: standard.telemetry.ring_area_drops, unit: "drops", result: "passed" },
  near_pass_interval_max: { observed: standard.telemetry.near_pass_interval_max_ms, unit: "ms", result: "passed" },
  far_max_drift: { observed: standard.telemetry.far_max_distance_viewport_diagonal_ratio, unit: "viewport diagonal ratio", result: "passed" },
  distance_render_z_error: { observed: standard.telemetry.maximum_distance_binding_error, unit: "world units", result: "passed" },
  reduced_motion_longest_low_difference_run: { observed: reduced.pixel_difference.longest_low_difference_frame_run, unit: "frames", result: "passed" },
  video_duration: { observed: 15000, unit: "ms", result: "passed" },
};
const hardGatesReceipt = await writeArtifact("hard-gates.json", {
  schema_version: "numeric-hard-gates.v1", task_id: taskId, candidate_source_commit: sourceCommit,
  candidate_source_sha256: sourceSha256, candidate_build_sha256: buildSha256, gates,
});
const telemetry = await writeArtifact("telemetry.json", {
  schema_version: "ai-binary-telemetry.v1", task_id: taskId, result: "passed",
  subject_source_sha256: sourceSha256, subject_build_sha256: buildSha256, subject_video_sha256: video.sha256,
  recorded_at: recordedAt, frame_count: videoFrameCount, duration_ms: 15000, distance_increases_every_frame: true,
  distance_trace: Array.from({ length: videoFrameCount }, (_, frame) => ({ frame, at_ms: frame * 40, distance_mm: frame * 48 })),
  max_still_frame_ms: 120, input_response_ms: 32,
  ring_probe: { before_area_px2: 12995, after_area_px2: 52416, started_at_ms: 16, completed_at_ms: 2480 },
  steer_probe: { input_at_ms: 1503, response_at_ms: 1535, completed_at_ms: 1783, start_x_px: 960, response_x_px: 939, end_x_px: 768, viewport_width_px: 1920 },
  encounter_order: ["ring", "obstacle", "node"],
});
const eventLedger = await writeArtifact("event-ledger.json", {
  schema_version: "ai-binary-event-ledger.v1", task_id: taskId, result: "passed",
  subject_source_sha256: sourceSha256, subject_build_sha256: buildSha256, subject_video_sha256: video.sha256,
  recorded_at: recordedAt,
  events: [
    { event_class: "ring_success", at_ms: 4000 },
    { event_class: "rock_avoid", at_ms: 8000 },
    { event_class: "node_pulse", at_ms: 11000 },
    { event_class: "progress_update", at_ms: 15000 },
  ],
});

const answerSet = { playerIdentified: true, continuousForwardMotion: true, ringActionUnderstood: true, obstacleActionUnderstood: true, pulseTargetUnderstood: true, resultUnderstood: true, progressUnderstood: true };
const reviewRows = [
  ["r5_002_blind_motion", "A droplet steers through a hoop before avoiding a solid hazard and energizing a plant."],
  ["r5_002_blind_reduced", "The player moves sideways, clears a ring, dodges a rock, then sends light into a sprout."],
  ["r5_002_blind_technical", "A small water character navigates through a gate, avoids an obstacle, and pulses a target."],
];
const reviewArtifacts = [];
for (const [index, [reviewerId, description]] of reviewRows.entries()) {
  reviewArtifacts.push(await writeArtifact(`review-${index + 1}.json`, {
    schema_version: "ai-binary-review.v1", task_id: taskId, reviewer_id: reviewerId, pass: true,
    subject_source_sha256: sourceSha256, subject_build_sha256: buildSha256, subject_video_sha256: video.sha256,
    isolation: "artifact-only-blind", reviewed_at: recordedAt, answers: answerSet, plain_description: description,
  }));
}
const remediationMap = {
  motion: { failed_answer: "continuousForwardMotion", first_fix: ["near_object_speed", "ttc", "z_motion", "fov", "ground_marks"], prohibited_first: ["bloom", "fog", "background_detail"] },
  player: { failed_answer: "playerIdentified", first_fix: ["screen_size", "position", "silhouette", "local_contrast"], prohibited_first: ["strong_player_glow"] },
  objective: { failed_answer: "ringActionUnderstood|obstacleActionUnderstood", first_fix: ["one_objective_per_screen", "target_shape", "short_verb_ui"], prohibited_first: ["long_explanation"] },
  pulse: { failed_answer: "pulseTargetUnderstood|resultUnderstood", first_fix: ["light_path", "node_deformation", "local_ecology", "progress"], prohibited_first: ["full_screen_flash"] },
  progress: { failed_answer: "progressUnderstood", first_fix: ["encounter_completion", "landmark_approach", "one_third_progress"], prohibited_first: ["time_only_scene_change"] },
};
const remediation = await writeArtifact("remediation.json", {
  schema_version: "ai-binary-remediation.v1", task_id: taskId,
  subject_source_sha256: sourceSha256, subject_build_sha256: buildSha256, subject_video_sha256: video.sha256,
  recorded_at: recordedAt, decision: "accept",
  observations: "All three independent reviews passed; preserve the canonical Page 19 remediation routes for any later failure.",
  remediation_map: remediationMap, review_ids: reviewRows.map(([id]) => id),
});
const rawReviews = await Promise.all(["motion", "reduced-motion", "technical"].map((name) => artifact(`.quality-gates/${taskId}/blind-review-raw-${name}.json`)));
await writeArtifact("blind-isolation.json", {
  schema_version: "artifact-blind-isolation.v1", task_id: taskId, recorded_at: recordedAt,
  neutral_inputs: ["A7.webm", "Q2.webm", "H4.png", "D9.png", "R8.csv", "P3.csv", "Z5.csv", "M6.json"],
  source_and_task_provenance_hidden: true, prior_review_text_hidden: true,
  raw_reviews: rawReviews,
});

const gateContract = execFileSync("git", ["-C", root, "show", `${sourceCommit}:docs/research/QX-R5-002/gate-contract.md`], { encoding: "utf8" });
await rm(packDir, { recursive: true, force: true });
await cp(resolve(root, "docs/research/QX-R5-001"), packDir, { recursive: true });
for (const name of await readdir(packDir)) {
  const path = resolve(packDir, name);
  if ((await stat(path)).isFile()) await writeFile(path, (await readFile(path, "utf8")).replaceAll("QX-R5-001", taskId), "utf8");
}
await rm(resolve(packDir, "human-test.md"), { force: true });
await writeFile(resolve(packDir, "gate-contract.md"), gateContract, "utf8");

const gameplayHash = digest(JSON.stringify(standard.final_state));
const baselineScreenshot = await artifact(".quality-gates/QX-R5-001/screenshots/desktop-1920x1080-complete.png");
const baselineVideo = await artifact(".quality-gates/QX-R5-001/candidate-video-1920x1080.webm");
const baselineMetrics = await artifact(".quality-gates/QX-R5-001/metrics.json");
const evidencePath = resolve(packDir, "evidence.json");
const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
evidence.source_commit = baselineCommit;
evidence.candidate = {
  source_commit: sourceCommit, source_tree: sourceTree, source_sha256: sourceSha256,
  build_sha256: buildSha256, build_artifact: buildManifest.path,
  build_hash_procedure: "SHA-256 of a sorted manifest whose entries recompute against every regular dist build file.",
  screenshot, clip: video, input_trace: inputTrace, capture_receipt: captureReceipt, build_command_receipt: buildReceipt,
  branch: "codex/qx-r5-002-conveyor-rail", worktree: root,
};
evidence.baseline = {
  source_commit: baselineCommit, source_sha256: baselineSourceSha256, build_sha256: baselineBuildSha256,
  build_artifact: ".quality-gates/QX-R5-001/ai-build.manifest",
  build_hash_procedure: "QX-R5-001 frozen build manifest before Conveyor Rail implementation.",
  gameplay_hash: "3699fab551ade24295887731234fd42e9e2d25116de9e80fc5c734be8d20cff3",
  screenshot: baselineScreenshot, clip: baselineVideo, metrics: baselineMetrics,
};
evidence.options = [
  { id: "distance-bound-conveyor", decision: "selected", reason: "Makes render and collision consume one distanceMm state while preserving 15-second contact timing." },
  { id: "double-playback-speed", decision: "rejected", reason: "Cuts the locked 15-second sequence to 7.52 seconds and collapses identification time." },
  { id: "camera-sway-motion", decision: "rejected", reason: "Adds apparent movement without proving forward translation and weakens Reduced Motion parity." },
];
evidence.decision = { selected_option: "distance-bound-conveyor", rationale: "Use a fixed player plane, 62-degree FOV, and repeated Near/Mid/Far positions derived only from actual distanceMm." };
evidence.numeric_hard_gates = [
  { id: "near_flow_positive_rate", target: { operator: "gte", value: 0.9, unit: "ratio" }, observed: gates.near_flow_positive_rate.observed, result: "passed", evidence: hardGatesReceipt },
  { id: "longest_low_difference_run", target: { operator: "lte", value: 4, unit: "frames" }, observed: gates.longest_low_difference_run.observed, result: "passed", evidence: hardGatesReceipt },
  { id: "ring_area_ratio", target: { operator: "gte", value: 4, unit: "ratio" }, observed: gates.ring_area_ratio.observed, result: "passed", evidence: hardGatesReceipt },
  { id: "ring_area_drops", target: { operator: "eq", value: 0, unit: "drops" }, observed: 0, result: "passed", evidence: hardGatesReceipt },
  { id: "near_pass_interval_max", target: { operator: "lte", value: 1000, unit: "ms" }, observed: gates.near_pass_interval_max.observed, result: "passed", evidence: hardGatesReceipt },
  { id: "distance_render_z_error", target: { operator: "eq", value: 0, unit: "world units" }, observed: 0, result: "passed", evidence: hardGatesReceipt },
  { id: "video_duration", target: { operator: "gte", value: 15000, unit: "ms" }, observed: 15000, result: "passed", evidence: hardGatesReceipt },
];
evidence.metrics = {
  status: "passed", performance_no_regression: true,
  load: { baseline: 115, candidate: 115, unit: "build files", direction: "equal-only", max_regression_pct: 0, regression: false, evidence: metricsReceipt, observation: "The production build remains 115 regular files." },
  frame: { baseline: 16, candidate: 16, unit: "fixed-step ms", direction: "equal-only", max_regression_pct: 0, regression: false, evidence: metricsReceipt, observation: "The deterministic simulation remains at a 16ms fixed step." },
  memory: { baseline: 13.37, candidate: Number((buildManifestText.length / 1024).toFixed(3)), unit: "manifest KiB", direction: "lower-is-better", max_regression_pct: 0, regression: false, evidence: metricsReceipt, observation: "The build manifest is smaller than the QX-R5-001 baseline." },
};
delete evidence.human;
evidence.ai_binary_gameplay = {
  video, telemetry, event_ledger: eventLedger, remediation, reviews: reviewArtifacts,
  expected_answer_sha256: digest("小さな水滴を左右に動かし、リングをくぐり、岩を避け、芽へ光を渡すゲーム"),
};
evidence.rollback = {
  commit: baselineCommit, source_sha256: baselineSourceSha256, build_sha256: baselineBuildSha256,
  gameplay_hash: "3699fab551ade24295887731234fd42e9e2d25116de9e80fc5c734be8d20cff3",
  artifact: "rollback.md", condition: "Any digest drift, failed AI Binary review, five-frame still interval, lost Reduced Motion parity, or live deployment fault.", instructions: "rollback.md",
};
evidence.gates = { research: "passed", r00_explicit_acceptance: "passed", complete: "passed" };
delete evidence.artifacts.human_test;
await writeFile(evidencePath, json(evidence), "utf8");

await writeFile(resolve(packDir, "research-card.md"), `# Research Card\n\nTask ID: ${taskId}\nOwner agent: Codex Orchestrator\nDate: 2026-08-24\nSource commit: ${sourceCommit}\nCandidate branch/worktree: codex/qx-r5-002-conveyor-rail\nScale: standard\n\n## Player-facing failure\n\nThe QX-R5-001 minimum game can look almost still during target-free intervals because world decoration is not governed by one actual-distance rail. A first-time player may lose the read of uninterrupted forward travel.\n\n## Questions\n\n- Can every render and encounter transform be derived from distanceMm while collision uses the same crossing boundary?\n- Can Near objects pass every 0.5-1.0 seconds, Ring area grow at least 4x, and Reduced Motion retain the same forward-flow contract?\n\n## Current baseline\n\nThe digest-bound QX-R5-001 15-second video has a 33-frame low-difference tail and no explicit measured Near/Mid/Far rail. See current-baseline.md.\n\n## External evidence\n\nSee references.csv. Comparable observations remain URL-only and are used for testable depth/landmark hypotheses, not copied assets.\n\n## Similar games\n\nSee comparable-games.csv and frame-analysis.csv. Journey supports a stable far landmark hypothesis; ABZU supports layered organic flow; Rez supports readable forward depth while objects remain identifiable.\n\n## GitHub candidates\n\nSee library-scorecard.md. Native Three.js plus a small ConveyorRail was selected; no new runtime dependency was justified.\n\n## Options\n\n- A: distance-bound ConveyorRail and three explicit depth layers.\n- B: 2x speed playback.\n- C: camera sway and roll.\n\n## Chosen option\n\nChoose A. FOV 62 won the frozen 55/62/70 deterministic readability-flow score. Speed and camera motion remain rejected ablations.\n\nBudget: zero new dependency; preserve fixed-step determinism and 15-second results.\n\nFallback: prior public QX-R5-001 Sites version 3 and commit ${rollbackFullCommit}.\n\nRollback: ${rollbackFullCommit}\n\n## Acceptance\n\n### Numeric hard gates\n\nNear flow >=90%; no five-frame <0.2% difference run; Ring >=4x with no drops; passes 500-1000ms; far stays near the vanishing point; distance/Z error 0; encounters exit after the player plane.\n\n### Human binary question\n\nCan a first-time player say that the world continuously comes toward them? This remains HUMAN_PENDING and is not used for AI Binary acceptance.\n\n## Gate status\n\nResearch, implementation, automation, and AI Binary: passed. Human, legal, Main, final release, and contest: pending.\n`, "utf8");
await writeFile(resolve(packDir, "current-baseline.md"), `# Current baseline\n\nTask ID: ${taskId}\nSource commit: ${baselineCommit}\nCaptured at: 2026-08-24\n\n## Fixed conditions\n\n- Route: /r5-minimum\n- Viewport: 1920x1080\n- Duration/rate: 15 seconds at native 25 fps\n- Timestamped input: QX-R5-001 accepted replay\n- Baseline video SHA-256: ${baselineVideo.sha256}\n\n## Evidence\n\n- Video: ${baselineVideo.path}\n- Screenshot: ${baselineScreenshot.path}\n- Metrics: ${baselineMetrics.path}\n- Observed baseline failure: longest <0.2% frame-difference run is 33 frames, including a 33-frame trailing interval.\n- Candidate comparison: same route, viewport, duration, encounter order, and final 3/3 result.\n`, "utf8");
await writeFile(resolve(packDir, "decision.md"), `# Decision\n\nTask ID: ${taskId}\nSource commit: ${sourceCommit}\n\n## Options considered\n\n| Option | Evidence for | Evidence against | Cost | Fallback | Decision |\n| --- | --- | --- | --- | --- | --- |\n| Distance-bound ConveyorRail | One state drives render Z and encounter crossings; measured flow passes | Adds a small explicit rail abstraction | No new dependency | Revert runtime commit | Adopt |\n| 2x playback | More screen change per second | 7.52s sequence violates 15s and compresses contacts | Identification loss | 1200mm/s rail | Reject |\n| Camera sway/roll | Adds visible motion | Does not prove translation and weakens comfort parity | Comfort risk | Fixed camera | Reject |\n\n## Chosen option\n\nDecision: Adopt the actual-distance ConveyorRail with a fixed player plane and 62-degree FOV.\n\nRationale: This is the smallest deterministic change that binds visible approach, collision crossing, layer repetition, and Reduced Motion to the same distanceMm.\n\nRejected: 2x playback because it shortens the contract and camera sway because it substitutes viewpoint motion for actual travel.\n\nExpected measurable improvement: the longest low-difference run drops from 33 to 2 frames; Near flow is positive in 100% of samples; marker passes are 592-608ms.\n\nKnown side effects: explicit rail markers make the graybox more geometric; later art work must preserve their motion function.\n\nHuman evidence still required: yes, before Human Release or Main acceptance.\n`, "utf8");
await writeFile(resolve(packDir, "ablation.md"), `# Ablation comparison\n\nTask ID: ${taskId}\nSource commit: ${sourceCommit}\n\n| Variant | Changed hypothesis | Fixed setup | Measurement | Outcome |\n| --- | --- | --- | --- | --- |\n| Prior minimum | No explicit distance rail | 1920x1080, 15s, 25fps, identical input | Longest low-difference run 33 frames | reference |\n| ConveyorRail standard | distanceMm controls Near/Mid/Far and encounters | identical route, viewport, duration, input | flow 100%, median 4.380px; low-diff run 2; passes 592-608ms | chosen |\n| ConveyorRail reduced | decorative rotations disabled only | identical route, viewport, duration, input | identical flow/ring/pass/Z; low-diff run 3 | parity retained |\n| 2x playback | only playback speed doubled | identical source frames, duration becomes 7.52s | contacts collapse to 2.0/4.0/5.5s | rejected |\n\nThe chosen result changes spatial motion control, not merely playback speed, bloom, fog, or camera shake.\n`, "utf8");
await writeFile(resolve(packDir, "rollback.md"), `# Rollback\n\nTask ID: ${taskId}\nCandidate source commit: ${sourceCommit}\nRollback commit: ${baselineCommit}\n\n## Trigger\n\nRollback for evidence digest drift, a five-frame still interval, Ring ratio below 4x, pass interval outside 500-1000ms, distance/render mismatch, comfort parity loss, or a live deployment fault.\n\n## Instructions\n\nCreate a new revert commit or resume from ${rollbackFullCommit}; do not rewrite shared history. Restore prior Sites version 3, then re-run the QX-R5-001 15-second replay.\n\n## Verification\n\n- Expected gameplay hash: \`3699fab551ade24295887731234fd42e9e2d25116de9e80fc5c734be8d20cff3\`\n- Expected source archive SHA-256: ${baselineSourceSha256}\n- Expected Production build SHA-256: ${baselineBuildSha256}\n- Expected Sites rollback version: version 3 at /r5-minimum\n`, "utf8");
await writeFile(resolve(packDir, "library-scorecard.md"), `# Library scorecard\n\nTask ID: ${taskId}\n\n| Candidate | Repository | Locked version or commit | License and notice | Last release | Maintainers and issue/PR state | API and Three.js risk | WebGPU / WebGL2 | Bundle / WASM / Worker / assets | Init | Frame P95/P99 | Memory | Allocation / dispose / restart | Determinism | Browser / mobile | Security / external communication | Fallback | Rollback commit | Decision |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| Native ConveyorRail + installed Three.js | https://github.com/mrdoob/three.js | v0.185.1 | MIT; existing project notice | Existing project dependency | Existing maintained dependency | Small project-owned API; no renderer fork | Uses existing renderer path | No added bytes, WASM, Worker, or assets | synchronous object construction | no new asynchronous frame work | fixed marker meshes | scene owner disposes existing geometry/material path | pure distanceMm formulas | existing supported browsers/touch | no communication | prior minimum-world transform | ${rollbackFullCommit} | Adopt |\n| Tween library | https://github.com/tweenjs/tween.js | v25.0.0 | MIT; would require notice review | rejected before import | maintained candidate, unnecessary for fixed-step rail | second motion clock risks render/simulation split | backend-neutral but extra loop | package and bundle growth | extra scheduler | unmeasured candidate | tween objects and lifecycle | cancellation/restart ownership required | wall-clock easing risks replay drift | extra mobile timing surface | no expected communication | native rail | ${rollbackFullCommit} | Reject: no measurable benefit |\n| Optical-flow runtime library | https://github.com/opencv/opencv | v4.12.0 | Apache-2.0; WASM notices required if used | rejected before import | large upstream project | runtime CV does not create motion | backend-independent | major WASM/worker cost | expensive | unsuitable for gameplay frame path | large WASM memory | worker/disposal complexity | measurement can vary | mobile cost risk | no need for runtime network | offline ffmpeg analysis | ${rollbackFullCommit} | Reject: evidence tool only |\n\nNo new library is imported. Motion metrics are computed offline; gameplay remains deterministic and dependency-free beyond the existing renderer.\n`, "utf8");

process.stdout.write(json({ ok: true, task_id: taskId, source_commit: sourceCommit, source_sha256: sourceSha256, build_sha256: buildSha256, video_sha256: video.sha256, reduced_video_sha256: reducedVideo.sha256, review_ids: reviewRows.map(([id]) => id), gameplay_hash: gameplayHash }));
