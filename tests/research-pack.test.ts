import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = new URL("../", import.meta.url);
const initializer = new URL("../scripts/init-research-pack.mjs", import.meta.url);
const validator = new URL("../scripts/validate-research-pack.mjs", import.meta.url);
const temporaryRoots: string[] = [];
const AI_TASK_ID = "QX-R5-001";

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "lonely-star-research-pack-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "docs/research"), { recursive: true });
  await cp(new URL("../docs/research/_templates", import.meta.url), join(root, "docs/research/_templates"), { recursive: true });
  return root;
}

async function copySample(root: string) {
  await cp(new URL("../docs/research/QX-R4-R00", import.meta.url), join(root, "docs/research/QX-R4-R00"), { recursive: true });
}

async function copyR01(root: string) {
  await cp(new URL("../docs/research/QX-R4-R01", import.meta.url), join(root, "docs/research/QX-R4-R01"), { recursive: true });
  await mkdir(join(root, ".quality-gates/QX-R4-R01"), { recursive: true });
  await cp(new URL("../.quality-gates/QX-R4-R01", import.meta.url), join(root, ".quality-gates/QX-R4-R01"), { recursive: true });
  await mkdir(join(root, ".quality-gates/QX-R4-R00"), { recursive: true });
  await cp(new URL("../.quality-gates/QX-R4-R00/production-stable-assets.sha256", import.meta.url), join(root, ".quality-gates/QX-R4-R00/production-stable-assets.sha256"));
}

async function bindR01Closure(root: string, closure: Record<string, unknown>) {
  const closurePath = join(root, ".quality-gates/QX-R4-R01/research-only-ai-closure.json");
  const closureText = `${JSON.stringify(closure, null, 2)}\n`;
  await writeFile(closurePath, closureText, "utf8");
  const evidencePath = join(root, "docs/research/QX-R4-R01/evidence.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.research_only_ai_closure.sha256 = sha256(closureText);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

async function bindR01Assessment(root: string, reviewText: string) {
  const reviewPath = join(root, ".quality-gates/QX-R4-R01/r5-migration-assessment.md");
  await writeFile(reviewPath, reviewText, "utf8");
  const closurePath = join(root, ".quality-gates/QX-R4-R01/research-only-ai-closure.json");
  const closure = JSON.parse(await readFile(closurePath, "utf8"));
  closure.independent_review.sha256 = sha256(reviewText);
  await bindR01Closure(root, closure);
}

function runValidator(root: string, taskId: string, stage = "research", acceptance = "human-release") {
  const effectiveTaskId = acceptance === "ai-binary" && taskId === "QX-R4-R00" ? AI_TASK_ID : taskId;
  const result = spawnSync(process.execPath, [validator.pathname, effectiveTaskId, "--root", root, "--stage", stage, "--acceptance", acceptance], { encoding: "utf8" });
  return { ...result, report: JSON.parse(result.stdout || "{}") as { ok?: boolean; issues?: Array<{ code: string }> } };
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function prepareValidAiBinaryPack(root: string) {
  await copySample(root);
  const originalPack = join(root, "docs/research/QX-R4-R00");
  const pack = join(root, `docs/research/${AI_TASK_ID}`);
  await rename(originalPack, pack);
  for (const name of await readdir(pack)) {
    const path = join(pack, name);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replaceAll("QX-R4-R00", AI_TASK_ID), "utf8");
  }
  await rm(join(pack, "human-test.md"));

  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Fixture"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture base"]);
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const sourceSha = sha256(execFileSync("git", ["-C", root, "archive", "--format=tar", commit]));

  const gateDir = join(root, ".quality-gates/QX-R4-R00");
  await mkdir(gateDir, { recursive: true });
  async function artifact(name: string, value: string | object) {
    const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    const path = `.quality-gates/QX-R4-R00/${name}`;
    await writeFile(join(root, path), text, "utf8");
    return { path, sha256: sha256(text) };
  }

  const runtimeFile = await artifact("runtime-app.js", "fixture-runtime\n");
  const build = await artifact("ai-build.manifest", `${runtimeFile.sha256}  ${runtimeFile.path}\n`);
  const baselineScreenshot = await artifact("baseline-shot.bin", "baseline screenshot");
  const baselineClip = await artifact("baseline-clip.bin", "baseline clip");
  const baselineMetrics = await artifact("baseline-metrics.json", { result: "baseline" });
  const screenshot = await artifact("candidate-shot.bin", "candidate screenshot");
  const videoPath = ".quality-gates/QX-R4-R00/candidate-video.webm";
  execFileSync("ffmpeg", [
    "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=30:duration=15",
    "-c:v", "libvpx-vp9", "-an", join(root, videoPath),
  ]);
  const videoBytes = await readFile(join(root, videoPath));
  const video = { path: videoPath, sha256: sha256(videoBytes) };
  const inputTrace = await artifact("candidate-input.json", { events: [{ at_ms: 100, input: "left" }] });
  const captureReceipt = await artifact("candidate-capture.json", {
    schema_version: "capture-set.v1",
    task_id: AI_TASK_ID,
    candidate_source_commit: commit,
    candidate_source_sha256: sourceSha,
    candidate_build_sha256: build.sha256,
    artifacts: { screenshot, clip: video, input_trace: inputTrace },
  });
  const buildReceipt = await artifact("candidate-build.json", {
    schema_version: "build-command.v1",
    task_id: AI_TASK_ID,
    candidate_source_commit: commit,
    candidate_source_sha256: sourceSha,
    candidate_build_sha256: build.sha256,
    command: "npm run build",
    exit_code: 0,
    recorded_at: "2026-08-23T07:30:00Z",
    observations: "Fixture build passed.",
  });
  const metricsReceipt = await artifact("metrics.json", {
    schema_version: "quality-metrics.v1",
    task_id: AI_TASK_ID,
    candidate_source_commit: commit,
    candidate_source_sha256: sourceSha,
    candidate_build_sha256: build.sha256,
    metrics: {
      load: { baseline: 1, candidate: 1, unit: "ms" },
      frame: { baseline: 1, candidate: 1, unit: "ms" },
      memory: { baseline: 1, candidate: 1, unit: "MiB" },
    },
  });
  const hardGateReceipt = await artifact("hard-gates.json", {
    schema_version: "numeric-hard-gates.v1",
    task_id: AI_TASK_ID,
    candidate_source_commit: commit,
    candidate_source_sha256: sourceSha,
    candidate_build_sha256: build.sha256,
    gates: { ai_binary_fixture: { observed: 1, unit: "pass", result: "passed" } },
  });
  const telemetry = await artifact("telemetry.json", {
    schema_version: "ai-binary-telemetry.v1",
    task_id: AI_TASK_ID,
    result: "passed",
    subject_source_sha256: sourceSha,
    subject_build_sha256: build.sha256,
    subject_video_sha256: video.sha256,
    recorded_at: "2026-08-23T07:30:00Z",
    frame_count: 450,
    duration_ms: 15000,
    distance_increases_every_frame: true,
    distance_trace: Array.from({ length: 450 }, (_, frame) => ({ frame, at_ms: frame * (1000 / 30), distance_mm: frame * 2 })),
    max_still_frame_ms: 400,
    input_response_ms: 80,
    ring_probe: { before_area_px2: 100, after_area_px2: 425, started_at_ms: 3500, completed_at_ms: 4300 },
    steer_probe: { input_at_ms: 5000, response_at_ms: 5080, completed_at_ms: 5280, start_x_px: 200, response_x_px: 216, end_x_px: 250, viewport_width_px: 400 },
    encounter_order: ["ring", "obstacle", "node"],
  });
  const eventLedger = await artifact("event-ledger.json", {
    schema_version: "ai-binary-event-ledger.v1",
    task_id: AI_TASK_ID,
    result: "passed",
    subject_source_sha256: sourceSha,
    subject_build_sha256: build.sha256,
    subject_video_sha256: video.sha256,
    recorded_at: "2026-08-23T07:30:00Z",
    events: [{ event_class: "ring_success", at_ms: 4000 }, { event_class: "rock_avoid", at_ms: 8000 }, { event_class: "node_pulse", at_ms: 11000 }, { event_class: "progress_update", at_ms: 14000 }],
  });
  const descriptions = [
    "A droplet steers through a hoop before avoiding a solid hazard and energizing a plant.",
    "The player moves sideways, clears a ring, dodges a rock, then sends light into a sprout.",
    "A small water character navigates through a gate, avoids an obstacle, and pulses a target.",
  ];
  const reviews = [];
  for (let index = 0; index < 3; index += 1) {
    reviews.push(await artifact(`review-${index + 1}.json`, {
      schema_version: "ai-binary-review.v1",
      task_id: AI_TASK_ID,
      reviewer_id: `blind-${index + 1}`,
      pass: true,
      subject_source_sha256: sourceSha,
      subject_build_sha256: build.sha256,
      subject_video_sha256: video.sha256,
      isolation: "artifact-only-blind",
      reviewed_at: `2026-08-23T07:3${index}:00Z`,
      answers: Object.fromEntries(["playerIdentified", "continuousForwardMotion", "ringActionUnderstood", "obstacleActionUnderstood", "pulseTargetUnderstood", "resultUnderstood", "progressUnderstood"].map((field) => [field, true])),
      plain_description: descriptions[index],
    }));
  }
  const remediation = await artifact("remediation.json", {
    schema_version: "ai-binary-remediation.v1",
    task_id: AI_TASK_ID,
    subject_source_sha256: sourceSha,
    subject_build_sha256: build.sha256,
    subject_video_sha256: video.sha256,
    recorded_at: "2026-08-23T07:35:00Z",
    decision: "accept",
    observations: "All three independent reviews passed; preserve the canonical Page 19 remediation routes for any later failure.",
    remediation_map: {
      motion: { failed_answer: "continuousForwardMotion", first_fix: ["near_object_speed", "ttc", "z_motion", "fov", "ground_marks"], prohibited_first: ["bloom", "fog", "background_detail"] },
      player: { failed_answer: "playerIdentified", first_fix: ["screen_size", "position", "silhouette", "local_contrast"], prohibited_first: ["strong_player_glow"] },
      objective: { failed_answer: "ringActionUnderstood|obstacleActionUnderstood", first_fix: ["one_objective_per_screen", "target_shape", "short_verb_ui"], prohibited_first: ["long_explanation"] },
      pulse: { failed_answer: "pulseTargetUnderstood|resultUnderstood", first_fix: ["light_path", "node_deformation", "local_ecology", "progress"], prohibited_first: ["full_screen_flash"] },
      progress: { failed_answer: "progressUnderstood", first_fix: ["encounter_completion", "landmark_approach", "one_third_progress"], prohibited_first: ["time_only_scene_change"] },
    },
    review_ids: ["blind-1", "blind-2", "blind-3"],
  });

  const evidencePath = join(pack, "evidence.json");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.source_commit = commit;
  evidence.candidate = {
    source_commit: commit,
    source_tree: tree,
    source_sha256: sourceSha,
    build_sha256: build.sha256,
    build_artifact: build.path,
    build_hash_procedure: "SHA-256 fixture manifest",
    screenshot,
    clip: video,
    input_trace: inputTrace,
    capture_receipt: captureReceipt,
    build_command_receipt: buildReceipt,
  };
  evidence.baseline = {
    source_commit: commit,
    source_sha256: sourceSha,
    build_sha256: build.sha256,
    build_artifact: build.path,
    build_hash_procedure: "SHA-256 fixture manifest",
    gameplay_hash: "fixture-gameplay-hash",
    screenshot: baselineScreenshot,
    clip: baselineClip,
    metrics: baselineMetrics,
  };
  evidence.numeric_hard_gates = [{ id: "ai_binary_fixture", target: { operator: "eq", value: 1, unit: "pass" }, observed: 1, result: "passed", evidence: hardGateReceipt }];
  evidence.metrics = {
    status: "passed",
    performance_no_regression: true,
    load: { baseline: 1, candidate: 1, unit: "ms", direction: "equal-only", max_regression_pct: 0, regression: false, evidence: metricsReceipt, observation: "Equal fixture load." },
    frame: { baseline: 1, candidate: 1, unit: "ms", direction: "equal-only", max_regression_pct: 0, regression: false, evidence: metricsReceipt, observation: "Equal fixture frame." },
    memory: { baseline: 1, candidate: 1, unit: "MiB", direction: "equal-only", max_regression_pct: 0, regression: false, evidence: metricsReceipt, observation: "Equal fixture memory." },
  };
  delete evidence.human;
  evidence.ai_binary_gameplay = {
    video,
    telemetry,
    event_ledger: eventLedger,
    remediation,
    reviews,
    expected_answer_sha256: sha256("小さな水滴を左右に動かし、リングをくぐり、岩を避け、芽へ光を渡すゲーム"),
  };
  evidence.rollback = { commit, source_sha256: sourceSha, build_sha256: build.sha256, gameplay_hash: "fixture-gameplay-hash", artifact: "rollback.md", condition: "Any fixture mismatch.", instructions: "rollback.md" };
  evidence.gates.complete = "passed";
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  const baselinePath = join(pack, "current-baseline.md");
  await writeFile(baselinePath, (await readFile(baselinePath, "utf8")).replace(/Source commit: [0-9a-f]{40}/, `Source commit: ${commit}`), "utf8");
  const rollbackPath = join(pack, "rollback.md");
  const rollback = (await readFile(rollbackPath, "utf8"))
    .replace(/Candidate source commit: [0-9a-f]{40}/, `Candidate source commit: ${commit}`)
    .replace(/Rollback commit: [0-9a-f]{40}/, `Rollback commit: ${commit}`)
    .replace(/- Expected gameplay hash:[^\n]*/, "- Expected gameplay hash: `fixture-gameplay-hash`")
    .replace(/- Expected source archive SHA-256:[^\n]*/, `- Expected source archive SHA-256: ${sourceSha}`)
    .replace(/- Expected Production build SHA-256:[^\n]*/, `- Expected Production build SHA-256: ${build.sha256}`);
  await writeFile(rollbackPath, rollback, "utf8");
  return { pack, evidencePath, reviews, telemetry, video, remediation };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evidence-driven Research Pack", () => {
  it("locks Page 19 precedence and both acceptance modes in the project contract", async () => {
    const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
    const skill = await readFile(new URL("../.openai/skills/evidence-driven-game-quality/SKILL.md", import.meta.url), "utf8");
    expect(agents.indexOf("Notion page 19")).toBeGreaterThan(-1);
    expect(agents.indexOf("Notion page 19")).toBeLessThan(agents.indexOf("Notion page 18"));
    expect(agents).toContain("QX-R5-001 through QX-R5-007 use the `ai_binary_gameplay` acceptance mode");
    expect(agents).toContain("--acceptance human-release");
    expect(skill).toContain("acceptance_modes:");
    expect(skill).toContain("human_release:");
    expect(skill).toContain("ai_binary_gameplay:");
    expect(skill).toContain("requires_three_blind_ai_reviews: true");
    expect(skill).toContain("validator must decode the video itself");
    expect(skill).toContain("one indexed, uniformly frame-timed `distance_mm` sample for every decoded video frame");
    expect(skill).toContain("Reject preserved in either optional Human Markdown or `evidence.json`");
  });

  it("fails an empty pack", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "docs/research/QX-EMPTY"));
    const result = runValidator(root, "QX-EMPTY");
    expect(result.status).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.issues?.some((entry) => entry.code === "MISSING_FILE")).toBe(true);
  });

  it("fails a community-only pack instead of treating Reddit as acceptance", async () => {
    const root = await makeRoot();
    execFileSync(process.execPath, [initializer.pathname, "QX-COMMUNITY", "--root", root]);
    await writeFile(
      join(root, "docs/research/QX-COMMUNITY/references.csv"),
      [
        "ID,SourceType,Title,URL,VersionOrCommit,License,ObservedFact,Inference,TestableHypothesis,AccessedAt",
        "C01,Community,Forum one,https://example.invalid/one,thread,Observation,Observed one,Inference one,Hypothesis one,2026-08-23",
        "C02,Community,Forum two,https://example.invalid/two,thread,Observation,Observed two,Inference two,Hypothesis two,2026-08-23",
      ].join("\n"),
      "utf8",
    );
    const result = runValidator(root, "QX-COMMUNITY");
    expect(result.status).toBe(1);
    expect(result.report.issues?.filter((entry) => entry.code === "SOURCE_COUNT")).toHaveLength(2);
  });

  it("passes the committed minimum Research Pack", () => {
    const result = spawnSync(process.execPath, [validator.pathname, "QX-R4-R00", "--root", projectRoot.pathname], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      task_id: "QX-R4-R00",
      counts: { primary: 6, github: 2, community: 2, comparable_games: 3, frames: 6 },
    });
  });

  it("passes the large QX-R4-R01 official reference corpus", () => {
    const result = spawnSync(process.execPath, [validator.pathname, "QX-R4-R01", "--root", projectRoot.pathname], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      task_id: "QX-R4-R01",
      scale: "large",
      counts: { primary: 6, github: 2, community: 2, comparable_games: 6, frames: 13 },
    });
  });

  it("rejects a large corpus with missing composition annotations", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const path = join(root, "docs/research/QX-R4-R01/frame-analysis.csv");
    const csv = (await readFile(path, "utf8")).replace("x58-64 y65-95; height 23%; area 2.1%", "");
    await writeFile(path, csv, "utf8");
    const result = runValidator(root, "QX-R4-R01");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("FRAME_FIELD");
  });

  it("rejects embedded media inside a URL-and-timecode Research Pack", async () => {
    const root = await makeRoot();
    await copyR01(root);
    await writeFile(join(root, "docs/research/QX-R4-R01/copied-frame.png"), "not-a-real-image", "utf8");
    const result = runValidator(root, "QX-R4-R01");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("EXTERNAL_MEDIA");
  });

  it("rejects a forged research-stage hard-gate digest", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const path = join(root, "docs/research/QX-R4-R01/evidence.json");
    const evidence = JSON.parse(await readFile(path, "utf8")) as { numeric_hard_gates: Array<{ evidence: { sha256: string } }> };
    evidence.numeric_hard_gates[0].evidence.sha256 = "0".repeat(64);
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R01");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_HARD_GATE_EVIDENCE");
  });

  it("rejects numeric TTC inferred from a single official still", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const path = join(root, "docs/research/QX-R4-R01/frame-analysis.csv");
    const csv = (await readFile(path, "utf8")).replace("large ships above and right; TTC not measurable from still", "large ships above and right; estimated TTC 0.7s");
    await writeFile(path, csv, "utf8");
    const result = runValidator(root, "QX-R4-R01");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("TIMING_PROVENANCE");
  });

  it("rejects a forged large-research validation receipt binding", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const path = join(root, "docs/research/QX-R4-R01/evidence.json");
    const evidence = JSON.parse(await readFile(path, "utf8")) as { research_validation: { sha256: string } };
    evidence.research_validation.sha256 = "0".repeat(64);
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R01");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_VALIDATION_BINDING");
  });

  it("passes AI Binary completion without a Human file when all machine and three-review evidence is bound", async () => {
    const root = await makeRoot();
    await prepareValidAiBinaryPack(root);
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status, result.stdout).toBe(0);
    expect(result.report).toMatchObject({ ok: true, acceptance: "ai-binary" });
  });

  it("accepts distinct natural Japanese gameplay descriptions", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "小さな水滴を動かしてリングをくぐり、岩を避け、芽へ光を渡す遊びです。",
      "プレイヤーを左右に移動し、輪を通り、障害を避け、植物へ光を届けます。",
      "雫を操作してゲートを抜け、壁をかわし、ノードに光を送り起動します。",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status, result.stdout).toBe(0);
  });

  it("rejects AI Binary acceptance outside QX-R5-001 through QX-R5-007 and the R01 migration", async () => {
    const root = await makeRoot();
    await copySample(root);
    const result = spawnSync(process.execPath, [validator.pathname, "QX-R4-R00", "--root", root, "--stage", "complete", "--acceptance", "ai-binary"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).issues.map((entry: { code: string }) => entry.code)).toContain("AI_ACCEPTANCE_SCOPE");
  });

  it("keeps Human release fail-closed when the Human file is absent", async () => {
    const root = await makeRoot();
    await prepareValidAiBinaryPack(root);
    const result = runValidator(root, AI_TASK_ID, "complete", "human-release");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("MISSING_FILE");
  });

  it("does not let AI Binary mode override a preserved Human Reject", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    await writeFile(join(fixture.pack, "human-test.md"), "# Human test\n\n- **Status：** RE​JECT!\n", "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
  });

  it("does not let AI Binary mode override a Human Reject preserved only in evidence.json", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.human = { status: "pending", outcome: "失敗", decision: "FAIL", raw_answer_count: 1, reject_count: "1" };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
  });

  it("rejects arbitrary bytes even when the AI video digest is updated", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const bytes = Buffer.from("not a decodable moving video");
    await writeFile(join(root, fixture.video.path), bytes);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.candidate.clip.sha256 = sha256(bytes);
    evidence.ai_binary_gameplay.video.sha256 = sha256(bytes);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_VIDEO");
  });

  it("rejects a decodable video shorter than 15 seconds", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    execFileSync("ffmpeg", [
      "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10:duration=14.9",
      "-c:v", "libvpx-vp9", "-an", join(root, fixture.video.path),
    ]);
    const bytes = await readFile(join(root, fixture.video.path));
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.candidate.clip.sha256 = sha256(bytes);
    evidence.ai_binary_gameplay.video.sha256 = sha256(bytes);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_VIDEO");
  });

  it("rejects a 15-second slideshow made from three static color plates", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    execFileSync("ffmpeg", [
      "-nostdin", "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=red:s=64x64:r=30:d=5",
      "-f", "lavfi", "-i", "color=c=green:s=64x64:r=30:d=5",
      "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=30:d=5",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
      "-map", "[v]", "-c:v", "libvpx-vp9", "-an", join(root, fixture.video.path),
    ]);
    const bytes = await readFile(join(root, fixture.video.path));
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.candidate.clip.sha256 = sha256(bytes);
    evidence.ai_binary_gameplay.video.sha256 = sha256(bytes);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_VIDEO");
  });

  it("rejects 150 hard-cut static plates even though every sampled hash changes", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    execFileSync("ffmpeg", [
      "-nostdin", "-y", "-v", "error", "-f", "lavfi",
      "-i", "nullsrc=s=64x64:r=10:d=15,geq=lum='mod(N*97,256)':cb=128:cr=128",
      "-c:v", "libvpx-vp9", "-an", join(root, fixture.video.path),
    ]);
    const bytes = await readFile(join(root, fixture.video.path));
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.candidate.clip.sha256 = sha256(bytes);
    evidence.ai_binary_gameplay.video.sha256 = sha256(bytes);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_VIDEO");
  });

  it("rejects a visually static clip with only one changing pixel", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    execFileSync("ffmpeg", [
      "-nostdin", "-y", "-v", "error", "-f", "lavfi",
      "-i", "nullsrc=s=64x64:r=10:d=15,geq=lum='if(eq(X,mod(N,64))*eq(Y,0),255,0)':cb=128:cr=128",
      "-c:v", "libvpx-vp9", "-an", join(root, fixture.video.path),
    ]);
    const bytes = await readFile(join(root, fixture.video.path));
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.candidate.clip.sha256 = sha256(bytes);
    evidence.ai_binary_gameplay.video.sha256 = sha256(bytes);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_VIDEO");
  });

  it("rejects AI Binary completion with only two reviewers", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.reviews.pop();
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_COUNT");
  });

  it("rejects three AI reviews that reuse one Reviewer ID", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const reviewPath = join(root, fixture.reviews[1].path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.reviewer_id = "blind-1";
    const reviewText = `${JSON.stringify(review, null, 2)}\n`;
    await writeFile(reviewPath, reviewText, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.reviews[1].sha256 = sha256(reviewText);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_ID");
  });

  it("rejects visibly identical Reviewer IDs separated only by zero-width characters", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const ids = ["blind-reviewer", "blind-​reviewer", "blind-‌reviewer"];
    for (let index = 0; index < fixture.reviews.length; index += 1) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.reviewer_id = ids[index];
      const text = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, text, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(text);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_ID");
  });

  it("rejects hard-linked AI review artifacts that share one inode", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const firstPath = join(root, fixture.reviews[0].path);
    const secondPath = join(root, fixture.reviews[1].path);
    await rm(secondPath);
    await link(firstPath, secondPath);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.reviews[1].sha256 = evidence.ai_binary_gameplay.reviews[0].sha256;
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_COUNT");
  });

  it("rejects lexical parent aliases and symlinked intermediate directories", async () => {
    for (const mode of ["parent", "intermediate"] as const) {
      const root = await makeRoot();
      const fixture = await prepareValidAiBinaryPack(root);
      const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
      if (mode === "parent") {
        evidence.ai_binary_gameplay.reviews[0].path = ".quality-gates/QX-R4-R00/../QX-R4-R00/review-1.json";
      } else {
        await symlink("QX-R4-R00", join(root, ".quality-gates/review-alias"));
        evidence.ai_binary_gameplay.reviews[0].path = ".quality-gates/review-alias/review-1.json";
      }
      await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
      expect(result.status, mode).toBe(1);
      expect(result.report.issues?.map((entry) => entry.code), mode).toContain("AI_REVIEW_COUNT");
    }
  });

  it("rejects an AI review bound to a different Video SHA", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const reviewPath = join(root, fixture.reviews[2].path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.subject_video_sha256 = "0".repeat(64);
    const reviewText = `${JSON.stringify(review, null, 2)}\n`;
    await writeFile(reviewPath, reviewText, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.reviews[2].sha256 = sha256(reviewText);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_BINDING");
  });

  it("rejects AI Binary completion when one reviewer fails", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const reviewPath = join(root, fixture.reviews[0].path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.pass = false;
    const reviewText = `${JSON.stringify(review, null, 2)}\n`;
    await writeFile(reviewPath, reviewText, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.reviews[0].sha256 = sha256(reviewText);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_FAIL");
  });

  it("rejects AI Binary completion without telemetry", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.telemetry = null;
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_TELEMETRY");
  });

  it("rejects contradictory or extra telemetry fields", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const telemetryPath = join(root, fixture.telemetry.path);
    const telemetry = JSON.parse(await readFile(telemetryPath, "utf8"));
    telemetry.verdict = "REJECT";
    telemetry.accepted = false;
    const telemetryText = `${JSON.stringify(telemetry, null, 2)}\n`;
    await writeFile(telemetryPath, telemetryText, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.telemetry.sha256 = sha256(telemetryText);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_TELEMETRY");
  });

  it.each([
    ["Unicode-confusable reject", { status: "r\u0435ject" }],
    ["positive rejected_count", { rejected_count: 1 }],
    ["positive rejected flag", { rejected: true }],
    ["positive failed flag", { failed: true }],
    ["negative passed flag", { passed: false }],
    ["positive failed_count", { failed_count: 1 }],
    ["Japanese reject count", { 拒否数: 1 }],
    ["NFKC positive rejected_count", { rejected_count: "１" }],
    ["negative Human decision text", { decision: "did not pass" }],
    ["contracted Human decision text", { decision: "didn’t pass" }],
    ["denied Human decision text", { decision: "denied" }],
    ["declined Human decision text", { decision: "declined" }],
    ["unsuccessful Human outcome", { outcome: "unsuccessful" }],
    ["blocked Human outcome", { outcome: "blocked" }],
    ["refusing Human approval", { decision: "refusing approval" }],
    ["positive denied flag", { denied: true }],
    ["positive refusal count", { refusal_count: 1 }],
    ["string true rejected flag", { rejected: "true" }],
    ["string yes rejected flag", { rejected: "yes" }],
    ["string on failed flag", { failed: "on" }],
    ["string off approved flag", { approved: "off" }],
    ["negative success flag", { success: false }],
    ["negative approval switch", { approval: "off" }],
    ["generic Human result false", { result: false }],
    ["nested generic Human outcome false", { outcome: { value: false } }],
    ["nested positive failed value", { failed: { value: true } }],
  ])("rejects preserved Human evidence hidden by %s", async (_label, human) => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.human = human;
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
  });

  it.each([
    ["Human label sibling", { audit_record: { label: "Human", payload: { rejected: true } } }],
    ["Human review_type sibling", { audit_record: { review_type: "Human", payload: { failed: true } } }],
    ["nested Human metadata sibling", { audit_record: { metadata: { label: "Human" }, payload: { passed: false } } }],
    ["non-historical baseline alias", { "base line": { reviewer_role: "Human", status: "declined" } }],
    ["nested Human reviewer role", { audit_record: { reviewer: { role: "Human" }, status: "denied" } }],
    ["plural Human reviewer roles", { audit_record: { reviewer_roles: ["Human"], status: "refused" } }],
    ["nested plural Human descriptors", { audit_record: { descriptors: [{ roles: ["Human"] }], structured_result: { passed: false } } }],
    ["nested Human audience context", { audit_record: { context: { audience: "Human" }, result: { passed: false } } }],
    ["Human reviewer ID and generic result", { audit_record: { reviewer_id: "Human-42", result: false } }],
    ["Human participant ID and generic result", { audit_record: { participant_id: "P-001", result: false } }],
    ["is_rejected", { preserved_human_evidence: { is_rejected: true } }],
    ["rejection_positive", { preserved_human_evidence: { rejection_positive: true } }],
  ])("rejects preserved Human evidence outside the canonical subtree: %s", async (_label, preserved) => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    Object.assign(evidence, preserved);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
  });

  it("rejects Human-labeled digest-bound Markdown containing a fragmented rejection", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const markdown = "# Preserved Human result\n\nDecision: R E J E C T\n";
    const markdownPath = ".quality-gates/QX-R4-R00/preserved-human-result.md";
    await writeFile(join(root, markdownPath), markdown, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.audit_record = { descriptors: [{ roles: ["Human"] }], evidence: { path: markdownPath, sha256: sha256(markdown) } };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
  });

  it.each([
    ["JSON false pass", "{\"passed\":false}\n"],
    ["JSON numeric pass failure", "{\"pass\":0}\n"],
    ["negative pass prose", "Decision: did not pass.\n"],
    ["contracted pass prose", "Decision: didn’t pass.\n"],
    ["negative acceptance prose", "Outcome: not accepted.\n"],
    ["refusing approval prose", "Reviewer is refusing approval.\n"],
    ["denies approval prose", "Human denies approval.\n"],
    ["contracted approving prose", "Reviewer isn’t approving.\n"],
    ["contracted passed prose", "Reviewer hasn’t passed it.\n"],
    ["disapproved prose", "Human was disapproved.\n"],
    ["contracted success prose", "Decision: wasn’t successful.\n"],
    ["not granted prose", "Approval was not granted.\n"],
    ["Japanese approval denial prose", "承認されませんでした。\n"],
    ["acceptance not met prose", "Decision: did not meet acceptance.\n"],
    ["passive acceptance criteria prose", "The acceptance criteria were not met.\n"],
    ["perfect passive requirements prose", "The requirements have not been met.\n"],
    ["remaining unmet prose", "The acceptance criteria remain unmet.\n"],
    ["generic false result prose", "result: false\n"],
    ["generic no status prose", "Status: no\n"],
    ["generic zero result prose", "Result: 0\n"],
    ["withheld approval prose", "Approval was withheld.\n"],
    ["Japanese criteria not met prose", "基準を満たさなかった。\n"],
  ])("rejects Human-labeled supplemental text with %s", async (_label, supplementalText) => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const supplementalPath = ".quality-gates/QX-R4-R00/preserved-human-result.txt";
    await writeFile(join(root, supplementalPath), supplementalText, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.audit_record = { metadata: { review_type: "Human" }, evidence: { path: supplementalPath, sha256: sha256(supplementalText) } };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
  });

  it("rejects passive Human failure prose in the optional canonical Human file", async () => {
    const root = await makeRoot();
    await prepareValidAiBinaryPack(root);
    await writeFile(join(root, `docs/research/${AI_TASK_ID}/human-test.md`), "The requirements have not been met.\n", "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
  });

  it("applies the general Human rejection detector in human-release mode", async () => {
    const root = await makeRoot();
    await copySample(root);
    const evidencePath = join(root, "docs/research/QX-R4-R00/evidence.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    evidence.human.passed = false;
    evidence.gates.complete = "passed";
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "human-release");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
  });

  it("rejects fragmented Human rejection text", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.human = { notes: ["re", "jected"] };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
  });

  it("rejects a preserved baseline Human rejection for R5 candidates", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.baseline.human = { status: "rejected" };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
  });

  it("rejects a malformed Human-labeled artifact reference", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.audit_record = {
      metadata: { review_type: "Human" },
      evidence: { path: ".quality-gates/QX-R4-R00/preserved-human-result.txt", sha256: "malformed" },
    };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_ARTIFACT_REFERENCE");
  });

  it("rejects a Human artifact reference whose digest does not match the file", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const supplementalText = "{\"result\":false}\n";
    const supplementalPath = ".quality-gates/QX-R4-R00/digest-mismatch-human.json";
    await writeFile(join(root, supplementalPath), supplementalText, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.audit_record = {
      metadata: { review_type: "Human" },
      evidence: { path: supplementalPath, sha256: "0".repeat(64) },
    };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_ARTIFACT_REFERENCE");
  });

  it.each(["false\n", "0\n", "null\n", "[]\n", "{\"result\":false\n"])("rejects a scalar, array, or malformed Human artifact: %s", async (supplementalText) => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const supplementalPath = ".quality-gates/QX-R4-R00/preserved-human-result.json";
    await writeFile(join(root, supplementalPath), supplementalText, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.audit_record = {
      metadata: { review_type: "Human" },
      evidence: { path: supplementalPath, sha256: sha256(supplementalText) },
    };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
  });

  it("uses a numeric participant ID to discover a digest-bound Human failure", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const supplementalText = "{\"result\":false}\n";
    const supplementalPath = ".quality-gates/QX-R4-R00/numeric-participant-result.json";
    await writeFile(join(root, supplementalPath), supplementalText, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.audit_record = {
      participant_id: 7,
      evidence: { path: supplementalPath, sha256: sha256(supplementalText) },
    };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
  });

  it.each([null, -1, 1.5, "", "\u200B"])("rejects a malformed Human provenance ID: %s", async (participantId) => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.audit_record = { participant_id: participantId };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_PROVENANCE_ID");
  });

  it("rejects a malformed Human reviewer ID", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.audit_record = { metadata: { review_type: "Human" }, reviewer_id: null };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_PROVENANCE_ID");
  });

  it("rejects a Human artifact hard-linked to candidate evidence", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const source = join(root, evidence.candidate.input_trace.path);
    const aliasPath = ".quality-gates/QX-R4-R00/human-input-alias.json";
    await link(source, join(root, aliasPath));
    evidence.audit_record = {
      metadata: { review_type: "Human" },
      evidence: { path: aliasPath, sha256: evidence.candidate.input_trace.sha256 },
    };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_ARTIFACT_REFERENCE");
  });

  it("rejects a Human artifact hard-linked to the candidate capture receipt", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const source = join(root, evidence.candidate.capture_receipt.path);
    const aliasPath = ".quality-gates/QX-R4-R00/human-capture-receipt-alias.json";
    await link(source, join(root, aliasPath));
    evidence.audit_record = {
      metadata: { review_type: "Human" },
      evidence: { path: aliasPath, sha256: evidence.candidate.capture_receipt.sha256 },
    };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("ARTIFACT_IDENTITY_REUSE");
  });

  it("rejects a candidate screenshot hard-linked to an AI review", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const screenshotPath = join(root, evidence.candidate.screenshot.path);
    await rm(screenshotPath);
    await link(join(root, fixture.reviews[0].path), screenshotPath);
    evidence.candidate.screenshot.sha256 = evidence.ai_binary_gameplay.reviews[0].sha256;
    const receiptPath = join(root, evidence.candidate.capture_receipt.path);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.artifacts.screenshot.sha256 = evidence.candidate.screenshot.sha256;
    const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
    await writeFile(receiptPath, receiptText, "utf8");
    evidence.candidate.capture_receipt.sha256 = sha256(receiptText);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("ARTIFACT_IDENTITY_REUSE");
  });

  it("rejects a required rollback file hard-linked to referenced evidence", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const rollbackPath = join(fixture.pack, "rollback.md");
    const rollbackText = await readFile(rollbackPath, "utf8");
    const screenshotPath = join(root, evidence.baseline.screenshot.path);
    await rm(screenshotPath);
    await link(rollbackPath, screenshotPath);
    evidence.baseline.screenshot.sha256 = sha256(rollbackText);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("ARTIFACT_IDENTITY_REUSE");
  });

  it("rejects distinct but meaningless AI descriptions", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    for (const [index, description] of ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"].entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects keyword-salad AI descriptions", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "player move ring rock pulse and foo bar baz qux",
      "droplet steer hoop obstacle light and foo bar baz qux",
      "water avatar navigate gate hazard plant and foo bar baz qux",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects contradictory or wrongly related gameplay descriptions", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "The player moves through a ring while a rock moves, then a pulse moves.",
      "A droplet moves through a hoop while an obstacle moves, then light moves.",
      "The player moves through a ring, never avoids the rock, and then sends no light into a plant.",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects gameplay descriptions that assign the actions to the wrong actor", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "A rock carries the droplet; the rock moves through a ring, avoids another rock, and energizes a plant.",
      "A ring guides the player; the ring moves through a hoop, avoids a rock, and sends light into a sprout.",
      "A plant follows the droplet; the plant moves through a gate, dodges a boulder, and pulses a target.",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects non-traversal and late wrong-subject gameplay descriptions", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "A droplet moves beside a ring, avoids a rock, and sends light into a plant.",
      "A player advances and a camera moves through a hoop, dodges a boulder, then energizes a sprout.",
      "A droplet moves through a gate and avoids a rock while the camera sends light into a plant.",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects canonical Japanese descriptions disguised by internal modifiers", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "小さな青い水滴を左右に動かし、光るリングをくぐり、大きな岩を避け、芽へ優しい光を渡すゲームです。",
      "小さな透明な水滴を左右に動かし、丸いリングをくぐり、硬い岩を避け、芽へ暖かな光を渡すゲームです。",
      "小さな輝く水滴を左右に動かし、大きいリングをくぐり、黒い岩を避け、芽へ明るい光を渡すゲームです。",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects Japanese descriptions with reversed order, wrong subject, or negated traversal", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "水滴を動かして芽へ光を渡し、岩を避け、リングをくぐる遊びです。",
      "水滴を動かしてカメラがリングをくぐり、岩を避け、芽へ光を渡す遊びです。",
      "水滴を動かしてリングをくぐらなかったが、岩を避け、芽へ光を渡す遊びです。",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects Japanese descriptions with inline camera subject swaps", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "水滴を動かしてリングをカメラがくぐり、岩を避け、芽へ光を渡す遊びです。",
      "プレイヤーを左右に移動し、輪を通り、障害をカメラが避け、植物へ光を届けます。",
      "雫を操作してゲートを抜け、壁をかわし、ノードへカメラが光を送ります。",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects subject insertion inside the initial player motion", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "A droplet moves a camera through a ring, avoids a rock, and sends light into a plant.",
      "A player advances a machine through a hoop, dodges a boulder, then energizes a sprout.",
      "水滴をカメラが動かしてリングをくぐり、岩を避け、芽へ光を渡す遊びです。",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects inverted target direction and late pulse subject swaps", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "A droplet moves through a ring, avoids a rock, and sends light away from a plant.",
      "A small water character advances through a gate, avoids an obstacle, and sends light while a camera activates a plant.",
      "小さな水滴を動かしてリングをくぐり、岩を避け、芽から光を送る遊びです。",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects Japanese actor insertion with de and mo particles", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "水滴を動かしてリングをカメラでくぐり、岩を避け、芽へ光を渡す遊びです。",
      "プレイヤーを左右に移動し、輪を通り、障害をカメラで避け、植物へ光を届けます。",
      "雫を操作してゲートを抜け、壁をかわし、ノードへカメラも光を送ります。",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects trailing camera or autopilot control after the pulse", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "A droplet moves through a ring, avoids a rock, and energizes a plant, while the camera controls the droplet.",
      "The player moves sideways, clears a ring, dodges a rock, then sends light into a sprout; afterward an autopilot controls everything.",
      "水滴を動かしてリングをくぐり、岩を避け、芽へ光を渡し、その後カメラが全部を操作します。",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects descriptions whose after connectors reverse event time", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "A droplet moves through a ring after avoiding a rock and energizing a plant.",
      "The player moves through a hoop before avoiding a boulder after sending light to a sprout.",
      "A small water character advances through a gate after dodging an obstacle before pulsing a target.",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it.each([
    ["automatic motion", "A droplet automatically moves through a ring, avoids a rock, and energizes a plant."],
    ["autopilot motion", "A droplet on autopilot steers through a ring, avoids a rock, and energizes a plant."],
    ["motion without player agency", "A small water character advances through a gate, avoids an obstacle, and pulses a target."],
    ["Japanese automatic motion", "水滴が自動で移動してリングをくぐり、岩を避け、芽へ光を渡す遊びです。"],
    ["Japanese auto motion", "雫がオートで移動してゲートを抜け、壁をかわし、ノードに光を送ります。"],
    ["Japanese motion without player agency", "水滴が進んでリングをくぐり、岩を避け、芽へ光を渡す遊びです。"],
    ["Japanese reflexive operation", "水滴が自ら操作してリングをくぐり、岩を避け、芽へ光を渡す遊びです。"],
    ["Japanese self operation", "水滴が自身で操作してリングをくぐり、岩を避け、芽へ光を渡す遊びです。"],
    ["independent motion", "A droplet independently steers through a ring, avoids a rock, and energizes a plant."],
    ["zero traversal", "A droplet steers through zero ring, avoids a rock, and energizes a plant."],
    ["Japanese AI operation", "水滴がAIで操作してリングをくぐり、岩を避け、芽へ光を渡すゲームです。"],
    ["Japanese AI agent operation", "水滴がAIにより操作してリングをくぐり、岩を避け、芽へ光を渡すゲームです。"],
    ["Japanese AI instrumental operation", "水滴がAIによって操作してリングをくぐり、岩を避け、芽へ光を渡すゲームです。"],
    ["Japanese bot operation", "水滴がボットで操作してリングをくぐり、岩を避け、芽へ光を渡すゲームです。"],
  ])("rejects %s in an AI gameplay description", async (_label, description) => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const reviewPath = join(root, fixture.reviews[0].path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.plain_description = description;
    const reviewText = `${JSON.stringify(review, null, 2)}\n`;
    await writeFile(reviewPath, reviewText, "utf8");
    evidence.ai_binary_gameplay.reviews[0].sha256 = sha256(reviewText);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects descriptions that negate required actions with neither", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "A droplet steers through neither ring, avoids a rock, and energizes a plant.",
      "The player moves sideways, clears a ring, dodges neither rock, then sends light into a sprout.",
      "A small water character navigates through a gate, avoids an obstacle, and pulses neither target.",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects AI descriptions that differ only by decorative adjectives", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "A droplet steers through a ring, avoids a rock, and energizes a plant.",
      "A tiny droplet steers through a ring, avoids a rock, and energizes a plant.",
      "A small droplet steers through a ring, avoids a rock, and energizes a plant.",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects copied description skeletons hidden by arbitrary modifiers", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "A droplet steers through a bright ring, avoids a jagged rock, and energizes a green plant.",
      "A droplet steers through a silver ring, avoids a massive rock, and energizes a young plant.",
      "A droplet steers through a quiet ring, avoids a rough rock, and energizes a vivid plant.",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects copied skeletons perturbed with reserved gameplay vocabulary", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const descriptions = [
      "A droplet steers through a water ring, avoids an energy rock, and energizes a target plant.",
      "A droplet steers through an energy ring, avoids a target rock, and energizes a water plant.",
      "A droplet steers through a target ring, avoids a water rock, and energizes an energy plant.",
    ];
    for (const [index, description] of descriptions.entries()) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = description;
      const reviewText = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewText, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(reviewText);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects Human and release pass claims in AI Binary evidence", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.human = { status: "passed", owner_decision: "pass" };
    evidence.release_ready = true;
    evidence.gates.human_release = "passed";
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_EXTERNAL_GATE_CLAIM");
  });

  it.each([
    ["descriptor-derived Human decision", { audit_record: { metadata: { review_type: "Human" }, decision: "passed" } }],
    ["numeric Human passed claim", { human: { passed: 1 } }],
    ["string Human passed claim", { human: { passed: "yes" } }],
    ["gate-derived Human release status", { audit_record: { gate: "Human Release", status: "passed" } }],
    ["neutral-key Human release prose", { audit_note: "Human release status: passed" }],
    ["granted Human decision", { human: { decision: "granted" } }],
    ["positive numeric Human claim", { human: { passed: 2 } }],
    ["external publication lifecycle claims", { legal: { status: "cleared" }, main: { status: "merged" }, sites: { status: "published" }, contest: { status: "submitted" }, release: { status: "shipped" } }],
    ["split Human key claim", { hu: { man: { status: "passed" } } }],
  ])("rejects %s in AI Binary evidence", async (_label, claim) => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    Object.assign(evidence, claim);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_EXTERNAL_GATE_CLAIM");
  });

  it("rejects malformed Human result metadata", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.human = { status: null };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("EXTERNAL_RESULT_METADATA");
  });

  it("rejects malformed non-Human external result metadata", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.owner = { decision: null };
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("EXTERNAL_RESULT_METADATA");
  });

  it.each([
    ["optional Human file", "human-test.md", "Decision: passed\n"],
    ["referenced Human artifact", ".quality-gates/QX-R4-R00/preserved-human-pass.txt", "Status: yes\n"],
  ])("rejects a pass claim in the %s", async (_label, artifactPath, artifactText) => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    if (artifactPath === "human-test.md") {
      await writeFile(join(root, `docs/research/${AI_TASK_ID}/human-test.md`), artifactText, "utf8");
    } else {
      await writeFile(join(root, artifactPath), artifactText, "utf8");
      const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
      evidence.audit_record = {
        metadata: { review_type: "Human" },
        evidence: { path: artifactPath, sha256: sha256(artifactText) },
      };
      await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_EXTERNAL_GATE_CLAIM");
  });

  it("rejects a format-only Reviewer ID", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const reviewPath = join(root, fixture.reviews[2].path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.reviewer_id = "\u200B";
    const reviewText = `${JSON.stringify(review, null, 2)}\n`;
    await writeFile(reviewPath, reviewText, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.reviews[2].sha256 = sha256(reviewText);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_ID");
  });

  it("rejects a build manifest whose physical file digest does not recompute", async () => {
    const root = await makeRoot();
    await prepareValidAiBinaryPack(root);
    await writeFile(join(root, ".quality-gates/QX-R4-R00/runtime-app.js"), "tampered runtime\n", "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_BUILD_MANIFEST");
  });

  it("rejects copied or duplicate AI free descriptions", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const reviewPath = join(root, fixture.reviews[0].path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.plain_description = "小さな水滴を左右に動かし、リングをくぐり、岩を避け、芽へ光を渡すゲーム";
    const reviewText = `${JSON.stringify(review, null, 2)}\n`;
    await writeFile(reviewPath, reviewText, "utf8");
    evidence.ai_binary_gameplay.reviews[0].sha256 = sha256(reviewText);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects canonical descriptions disguised with different punctuation", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const copies = [
      "。小さな水滴を左右に動かし、リングをくぐり、岩を避け、芽へ光を渡すゲーム。",
      "！小さな水滴を左右に動かし、リングをくぐり、岩を避け、芽へ光を渡すゲーム！",
      "「小さな水滴を左右に動かし、リングをくぐり、岩を避け、芽へ光を渡すゲーム」",
    ];
    for (let index = 0; index < fixture.reviews.length; index += 1) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = copies[index];
      const text = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, text, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(text);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects visible expected-answer copies separated only by zero-width characters", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const copies = [
      "小さな​水滴を左右に動かし、リングをくぐり、岩を避け、芽へ光を渡すゲーム",
      "小さな‌水滴を左右に動かし、リングをくぐり、岩を避け、芽へ光を渡すゲーム",
      "小さな‍水滴を左右に動かし、リングをくぐり、岩を避け、芽へ光を渡すゲーム",
    ];
    for (let index = 0; index < fixture.reviews.length; index += 1) {
      const reviewPath = join(root, fixture.reviews[index].path);
      const review = JSON.parse(await readFile(reviewPath, "utf8"));
      review.plain_description = copies[index];
      const text = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, text, "utf8");
      evidence.ai_binary_gameplay.reviews[index].sha256 = sha256(text);
    }
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects the canonical description even when a prefix is added", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const reviewPath = join(root, fixture.reviews[0].path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.plain_description = "動画では、小さな水滴を左右に動かし、リングをくぐり、岩を避け、芽へ光を渡すゲーム";
    const text = `${JSON.stringify(review, null, 2)}\n`;
    await writeFile(reviewPath, text, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.reviews[0].sha256 = sha256(text);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects negative timing and missing semantic telemetry bounds", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const telemetryPath = join(root, fixture.telemetry.path);
    const telemetry = JSON.parse(await readFile(telemetryPath, "utf8"));
    telemetry.max_still_frame_ms = -1;
    telemetry.input_response_ms = -1;
    telemetry.ring_probe.after_area_px2 = telemetry.ring_probe.before_area_px2 * 3;
    telemetry.ring_probe.completed_at_ms = telemetry.ring_probe.started_at_ms + 10000;
    telemetry.steer_probe.response_x_px = telemetry.steer_probe.start_x_px + 5;
    telemetry.steer_probe.end_x_px = telemetry.steer_probe.start_x_px + telemetry.steer_probe.viewport_width_px * 0.05;
    const text = `${JSON.stringify(telemetry, null, 2)}\n`;
    await writeFile(telemetryPath, text, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.telemetry.sha256 = sha256(text);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_TELEMETRY");
  });

  it("rejects compressed frame times and steering coordinates outside the viewport", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const telemetryPath = join(root, fixture.telemetry.path);
    const telemetry = JSON.parse(await readFile(telemetryPath, "utf8"));
    telemetry.distance_trace = telemetry.distance_trace.map((sample: { frame: number; distance_mm: number }, index: number) => ({ ...sample, at_ms: index === 449 ? 15000 : index }));
    telemetry.steer_probe.start_x_px = 401;
    telemetry.steer_probe.response_x_px = 420;
    telemetry.steer_probe.end_x_px = 460;
    const text = `${JSON.stringify(telemetry, null, 2)}\n`;
    await writeFile(telemetryPath, text, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.telemetry.sha256 = sha256(text);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_TELEMETRY");
  });

  it("rejects a one-sample distance trace for a multi-frame video", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const telemetryPath = join(root, fixture.telemetry.path);
    const telemetry = JSON.parse(await readFile(telemetryPath, "utf8"));
    telemetry.frame_count = 1;
    telemetry.distance_trace = [{ frame: 0, at_ms: 0, distance_mm: 0 }];
    const text = `${JSON.stringify(telemetry, null, 2)}\n`;
    await writeFile(telemetryPath, text, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.telemetry.sha256 = sha256(text);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_TELEMETRY");
  });

  it("rejects a reversed semantic Event ledger", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const ledgerPath = join(root, evidence.ai_binary_gameplay.event_ledger.path);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.events = [
      { event_class: "node_pulse", at_ms: 4000 },
      { event_class: "rock_avoid", at_ms: 8000 },
      { event_class: "ring_success", at_ms: 11000 },
      { event_class: "progress_update", at_ms: 14000 },
    ];
    const text = `${JSON.stringify(ledger, null, 2)}\n`;
    await writeFile(ledgerPath, text, "utf8");
    evidence.ai_binary_gameplay.event_ledger.sha256 = sha256(text);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_EVENT_LEDGER");
  });

  it("rejects semantic Event ledger entries sharing one timestamp", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const ledgerPath = join(root, evidence.ai_binary_gameplay.event_ledger.path);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.events = ledger.events.map((event: object) => ({ ...event, at_ms: 5000 }));
    const text = `${JSON.stringify(ledger, null, 2)}\n`;
    await writeFile(ledgerPath, text, "utf8");
    evidence.ai_binary_gameplay.event_ledger.sha256 = sha256(text);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_EVENT_LEDGER");
  });

  it("rejects a failed ledger or duplicate semantic event after completion", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const ledgerPath = join(root, evidence.ai_binary_gameplay.event_ledger.path);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.result = "failed";
    ledger.events.push({ event_class: "ring_success", at_ms: 14500 });
    const text = `${JSON.stringify(ledger, null, 2)}\n`;
    await writeFile(ledgerPath, text, "utf8");
    evidence.ai_binary_gameplay.event_ledger.sha256 = sha256(text);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_EVENT_LEDGER");
  });

  it("rejects a shape-only remediation map", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const remediationPath = join(root, fixture.remediation.path);
    const remediation = JSON.parse(await readFile(remediationPath, "utf8"));
    remediation.remediation_map = {
      motion: "x".repeat(24),
      player: "y".repeat(24),
      objective: "z".repeat(24),
      pulse: "q".repeat(24),
      progress: "r".repeat(24),
    };
    const text = `${JSON.stringify(remediation, null, 2)}\n`;
    await writeFile(remediationPath, text, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.remediation.sha256 = sha256(text);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REMEDIATION");
  });

  it("rejects contradictory review fields and filler remediation observations", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    const reviewPath = join(root, fixture.reviews[0].path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.verdict = "REJECT";
    review.outcome = "fail";
    const reviewText = `${JSON.stringify(review, null, 2)}\n`;
    await writeFile(reviewPath, reviewText, "utf8");
    evidence.ai_binary_gameplay.reviews[0].sha256 = sha256(reviewText);
    const remediationPath = join(root, fixture.remediation.path);
    const remediation = JSON.parse(await readFile(remediationPath, "utf8"));
    remediation.observations = "x".repeat(48);
    const remediationText = `${JSON.stringify(remediation, null, 2)}\n`;
    await writeFile(remediationPath, remediationText, "utf8");
    evidence.ai_binary_gameplay.remediation.sha256 = sha256(remediationText);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["AI_REVIEW_FAIL", "AI_REMEDIATION"]));
  });

  it("rejects duplicate AI free descriptions even when all binary answers pass", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const firstReview = JSON.parse(await readFile(join(root, fixture.reviews[0].path), "utf8"));
    const secondPath = join(root, fixture.reviews[1].path);
    const secondReview = JSON.parse(await readFile(secondPath, "utf8"));
    secondReview.plain_description = firstReview.plain_description;
    const secondText = `${JSON.stringify(secondReview, null, 2)}\n`;
    await writeFile(secondPath, secondText, "utf8");
    const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
    evidence.ai_binary_gameplay.reviews[1].sha256 = sha256(secondText);
    await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("AI_REVIEW_DESCRIPTION");
  });

  it("rejects AI Binary completion without an Event ledger or remediation decision", async () => {
    for (const [field, code] of [["event_ledger", "AI_EVENT_LEDGER"], ["remediation", "AI_REMEDIATION"]] as const) {
      const root = await makeRoot();
      const fixture = await prepareValidAiBinaryPack(root);
      const evidence = JSON.parse(await readFile(fixture.evidencePath, "utf8"));
      evidence.ai_binary_gameplay[field] = null;
      await writeFile(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
      expect(result.status, field).toBe(1);
      expect(result.report.issues?.map((entry) => entry.code), field).toContain(code);
    }
  });

  it("accepts the committed R01 only through the research-only AI migration receipt", () => {
    const ai = spawnSync(process.execPath, [validator.pathname, "QX-R4-R01", "--root", projectRoot.pathname, "--stage", "complete", "--acceptance", "ai-binary"], { encoding: "utf8" });
    expect(ai.status, ai.stdout).toBe(0);
    expect(JSON.parse(ai.stdout)).toMatchObject({ ok: true, acceptance: "ai-binary" });
    const human = spawnSync(process.execPath, [validator.pathname, "QX-R4-R01", "--root", projectRoot.pathname, "--stage", "complete", "--acceptance", "human-release"], { encoding: "utf8" });
    expect(human.status).toBe(1);
    expect(JSON.parse(human.stdout).issues.map((entry: { code: string }) => entry.code)).toEqual(expect.arrayContaining(["COMPLETE_GATE", "HUMAN_GATE"]));
  }, 15_000);

  it("exempts structured historical Human rejection inside the R01 baseline", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const evidencePath = join(root, "docs/research/QX-R4-R01/evidence.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    evidence.baseline.historical_human_input = { review_type: "Human", status: "REJECT", rejected_count: 1 };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.report.issues?.map((entry) => entry.code)).not.toContain("HUMAN_REJECT");
  });

  it("still verifies the digest of R01 historical Human baseline evidence", async () => {
    const root = await makeRoot();
    await copyR01(root);
    await writeFile(join(root, "docs/research/QX-R4-R01/baseline-human-findings.md"), "tampered historical finding\n", "utf8");
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("ARTIFACT_REFERENCE");
    expect(result.report.issues?.map((entry) => entry.code)).not.toContain("HUMAN_REJECT");
  });

  it("does not let R01 bypass its dedicated migration through ordinary AI completion", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    const r01Pack = join(root, "docs/research/QX-R4-R01");
    await rename(fixture.pack, r01Pack);
    const evidencePath = join(r01Pack, "evidence.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    evidence.task_id = "QX-R4-R01";
    evidence.gates.complete = "passed";
    delete evidence.research_only_ai_closure;
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_ONLY_AI_CLOSURE");
  });

  it("rejects R01 candidate identity drift or a Production-improvement claim", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const evidencePath = join(root, "docs/research/QX-R4-R01/evidence.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    evidence.candidate.source_commit = "bae8d1f0000000000000000000000000000000000";
    evidence.candidate.production_improvement_claimed = true;
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_ONLY_AI_CLOSURE");
  });

  it("rejects malformed or externally contradictory R01 closure metadata", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const closurePath = join(root, ".quality-gates/QX-R4-R01/research-only-ai-closure.json");
    const closure = JSON.parse(await readFile(closurePath, "utf8"));
    closure.withdrawn_gate = "Human acceptance complete; Legal cleared; Main merged; Sites published; Contest submitted; release shipped.";
    closure.issuer = "";
    closure.policy_source = "";
    closure.rollback_condition = "";
    await bindR01Closure(root, closure);
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_ONLY_AI_CLOSURE");
  });

  it("rejects an R01 build archive that does not reproduce its manifest", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const archivePath = join(root, ".quality-gates/QX-R4-R01/production-build-be0eb516.tar.gz");
    const archiveText = "not a build archive\n";
    await writeFile(archivePath, archiveText, "utf8");
    const closurePath = join(root, ".quality-gates/QX-R4-R01/research-only-ai-closure.json");
    const closure = JSON.parse(await readFile(closurePath, "utf8"));
    closure.build_archive.sha256 = sha256(archiveText);
    await bindR01Closure(root, closure);
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_ONLY_AI_CLOSURE");
  });

  it("rejects a rewritten R01 migration policy even when its local references are rebound", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const policyPath = join(root, ".quality-gates/QX-R4-R01/migration-policy.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.minimum_score = 0;
    const policyText = `${JSON.stringify(policy, null, 2)}\n`;
    await writeFile(policyPath, policyText, "utf8");
    const closurePath = join(root, ".quality-gates/QX-R4-R01/research-only-ai-closure.json");
    const closure = JSON.parse(await readFile(closurePath, "utf8"));
    closure.migration_policy.sha256 = sha256(policyText);
    await bindR01Closure(root, closure);
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_ONLY_AI_CLOSURE");
  });

  it("rejects any malformed line in the preserved R01 build manifest", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const manifestPath = join(root, ".quality-gates/QX-R4-R01/production-complete-files.sha256");
    await writeFile(manifestPath, `${await readFile(manifestPath, "utf8")}contradictory malformed line\n`, "utf8");
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_ONLY_AI_CLOSURE");
  });

  it("rejects an R01 archive that does not reproduce the pinned Production-stable subset", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const stablePath = join(root, ".quality-gates/QX-R4-R00/production-stable-assets.sha256");
    await writeFile(stablePath, (await readFile(stablePath, "utf8")).replace("c24f1032", "d24f1032"), "utf8");
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_ONLY_AI_CLOSURE");
  });

  it("rejects a research-only closure whose bound independent review is a rejection", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const reviewPath = join(root, ".quality-gates/QX-R4-R01/r5-migration-assessment.md");
    const reviewText = `${await readFile(reviewPath, "utf8")}\nVerdict: R E J E C T\nS 2 findings: 1\n`;
    await bindR01Assessment(root, reviewText);
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_ONLY_AI_CLOSURE");
  });

  it("rejects contradictory R01 gate rows and release claims", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const reviewPath = join(root, ".quality-gates/QX-R4-R01/r5-migration-assessment.md");
    const reviewText = `${await readFile(reviewPath, "utf8")}\nAdditional gate statement: Human gate is COMPLETE.\nProduction gameplay is materially improved.\n`;
    await bindR01Assessment(root, reviewText);
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_ONLY_AI_CLOSURE");
  });

  it("rejects replacing the preserved historical review with an unrelated artifact", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const unrelatedPath = join(root, ".quality-gates/QX-R4-R01/current-capture-metrics.json");
    const unrelatedText = await readFile(unrelatedPath, "utf8");
    const closurePath = join(root, ".quality-gates/QX-R4-R01/research-only-ai-closure.json");
    const closure = JSON.parse(await readFile(closurePath, "utf8"));
    closure.historical_research_review = {
      path: ".quality-gates/QX-R4-R01/current-capture-metrics.json",
      sha256: sha256(unrelatedText),
    };
    await bindR01Closure(root, closure);
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_ONLY_AI_CLOSURE");
  });

  it("rejects rewriting the historical review at the expected path", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const historicalPath = join(root, ".quality-gates/QX-R4-R01/independent-review-round4.md");
    const historicalText = "# Rewritten historical review\n\nVerdict: ACCEPT\n";
    await writeFile(historicalPath, historicalText, "utf8");
    const historicalSha = sha256(historicalText);
    const assessmentPath = join(root, ".quality-gates/QX-R4-R01/r5-migration-assessment.md");
    const assessmentText = (await readFile(assessmentPath, "utf8")).replace(/Historical round-4 review artifact \| `[^`]+`/, `Historical round-4 review artifact | \`${historicalSha}\``);
    await writeFile(assessmentPath, assessmentText, "utf8");
    const closurePath = join(root, ".quality-gates/QX-R4-R01/research-only-ai-closure.json");
    const closure = JSON.parse(await readFile(closurePath, "utf8"));
    closure.historical_research_review.sha256 = historicalSha;
    closure.independent_review.sha256 = sha256(assessmentText);
    await bindR01Closure(root, closure);
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_ONLY_AI_CLOSURE");
  });

  it("rejects an R01 migration score above 32", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const assessmentPath = join(root, ".quality-gates/QX-R4-R01/r5-migration-assessment.md");
    const assessmentText = (await readFile(assessmentPath, "utf8")).replace("Score: 32/32", "Score: 99/32");
    await writeFile(assessmentPath, assessmentText, "utf8");
    const closurePath = join(root, ".quality-gates/QX-R4-R01/research-only-ai-closure.json");
    const closure = JSON.parse(await readFile(closurePath, "utf8"));
    closure.automated_review_score = "99/32";
    closure.independent_review.sha256 = sha256(assessmentText);
    await bindR01Closure(root, closure);
    const result = runValidator(root, "QX-R4-R01", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_ONLY_AI_CLOSURE");
  });

  it("does not allow an R5 task to use the R01-only migration exception", async () => {
    const root = await makeRoot();
    await copyR01(root);
    await rename(join(root, "docs/research/QX-R4-R01"), join(root, "docs/research/QX-R5-003"));
    const closurePath = join(root, ".quality-gates/QX-R4-R01/research-only-ai-closure.json");
    const closure = JSON.parse(await readFile(closurePath, "utf8"));
    closure.task_id = "QX-R5-003";
    const closureText = `${JSON.stringify(closure, null, 2)}\n`;
    await writeFile(closurePath, closureText, "utf8");
    const evidencePath = join(root, "docs/research/QX-R5-003/evidence.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    evidence.task_id = "QX-R5-003";
    evidence.research_only_ai_closure.sha256 = sha256(closureText);
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R5-003", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("COMPLETE_GATE");
  });

  it("rejects a validation receipt recorded before its capture", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const validationPath = join(root, ".quality-gates/QX-R4-R01/research-validation.json");
    const validation = JSON.parse(await readFile(validationPath, "utf8")) as { recorded_at: string };
    validation.recorded_at = "2026-08-23T05:00:00Z";
    const validationText = `${JSON.stringify(validation, null, 2)}\n`;
    await writeFile(validationPath, validationText, "utf8");
    const evidencePath = join(root, "docs/research/QX-R4-R01/evidence.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as { research_validation: { sha256: string } };
    evidence.research_validation.sha256 = sha256(validationText);
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R01");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("RESEARCH_VALIDATION_BINDING");
  });

  it("rejects a missing ablation screenshot interval", async () => {
    const root = await makeRoot();
    await copyR01(root);
    const path = join(root, "docs/research/QX-R4-R01/ablation.md");
    const ablation = (await readFile(path, "utf8")).replace("- EARTH: 48.95-49.07s; 36cccfbf->a2b5274b", "- EARTH interval omitted");
    await writeFile(path, ablation, "utf8");
    const result = runValidator(root, "QX-R4-R01");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("CAPTURE_INTERVAL_SYNC");
  });

  it("keeps completion blocked without numeric and raw human evidence", async () => {
    const root = await makeRoot();
    await copySample(root);
    const path = join(root, "docs/research/QX-R4-R00/evidence.json");
    const evidence = JSON.parse(await readFile(path, "utf8")) as {
      numeric_hard_gates: Array<{ result: string }>;
      metrics: { status: string; performance_no_regression: boolean };
      human: { status: string; raw_answer_count: number; owner_decision: string };
      gates: { complete: string };
    };
    evidence.numeric_hard_gates.forEach((gate) => {
      gate.result = "pending";
    });
    evidence.metrics.status = "pending";
    evidence.metrics.performance_no_regression = false;
    evidence.human.status = "pending";
    evidence.human.raw_answer_count = 0;
    evidence.human.owner_decision = "pending";
    evidence.gates.complete = "pending";
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["COMPLETE_GATE", "METRICS_GATE", "HARD_GATE", "HUMAN_GATE", "CANDIDATE_CAPTURE"]),
    );
  });

  it("rejects missing, outside, directory, symlink, alias, and digest-mismatched candidate captures", async () => {
    for (const mode of ["missing", "outside", "directory", "symlink", "alias", "digest"] as const) {
      const root = await makeRoot();
      await copySample(root);
      const pack = join(root, "docs/research/QX-R4-R00");
      const payloads = { screenshot: "shot", clip: "clip", input_trace: "trace" };
      for (const [id, payload] of Object.entries(payloads)) await writeFile(join(pack, `${id}.bin`), payload, "utf8");
      if (mode === "symlink") await symlink("screenshot.bin", join(pack, "screenshot-link.bin"));
      const evidencePath = join(pack, "evidence.json");
      const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
        candidate: Record<string, unknown> & { source_commit: string; source_sha256: string; build_sha256: string };
        gates: { complete: string };
      };
      const refs: Record<string, { path: string; sha256: string } | null> = {
        screenshot: { path: "screenshot.bin", sha256: sha256(payloads.screenshot) },
        clip: { path: "clip.bin", sha256: sha256(payloads.clip) },
        input_trace: { path: "input_trace.bin", sha256: sha256(payloads.input_trace) },
      };
      if (mode === "missing") refs.screenshot = null;
      if (mode === "outside") refs.screenshot = { path: "../outside.bin", sha256: sha256("outside") };
      if (mode === "directory") refs.screenshot = { path: "docs/", sha256: sha256("directory") };
      if (mode === "symlink") refs.screenshot = { path: "screenshot-link.bin", sha256: sha256(payloads.screenshot) };
      if (mode === "alias") refs.clip = { path: "docs/research/QX-R4-R00/screenshot.bin", sha256: sha256(payloads.screenshot) };
      if (mode === "digest" && refs.screenshot) refs.screenshot.sha256 = "0".repeat(64);
      Object.assign(evidence.candidate, refs);
      const receipt = JSON.stringify({
        schema_version: "capture-set.v1",
        task_id: "QX-R4-R00",
        candidate_source_commit: evidence.candidate.source_commit,
        candidate_source_sha256: evidence.candidate.source_sha256,
        candidate_build_sha256: evidence.candidate.build_sha256,
        artifacts: refs,
      });
      await writeFile(join(pack, "capture-receipt.json"), receipt, "utf8");
      evidence.candidate.capture_receipt = { path: "capture-receipt.json", sha256: sha256(receipt) };
      evidence.gates.complete = "passed";
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      const result = runValidator(root, "QX-R4-R00", "complete");
      expect(result.status, mode).toBe(1);
      expect(result.report.issues?.map((entry) => entry.code), mode).toContain("CANDIDATE_CAPTURE");
    }
  });

  it("rejects a baseline capture digest mismatch", async () => {
    const root = await makeRoot();
    await copySample(root);
    const path = join(root, "docs/research/QX-R4-R00/evidence.json");
    const evidence = JSON.parse(await readFile(path, "utf8")) as { baseline: { screenshot: { sha256: string } } };
    evidence.baseline.screenshot.sha256 = "0".repeat(64);
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("BASELINE_EVIDENCE");
  });

  it("rejects forged completion flags without structured raw answers or owner evidence", async () => {
    const root = await makeRoot();
    await copySample(root);
    const path = join(root, "docs/research/QX-R4-R00/evidence.json");
    const evidence = JSON.parse(await readFile(path, "utf8")) as {
      candidate: { source_commit: string; source_sha256: string; build_sha256: string };
      human: { status: string; raw_answer_count: number; owner_decision: string; raw_answers: { path: string; sha256: string } | null; owner_evidence: { path: string; sha256: string } | null };
      gates: { complete: string };
    };
    const reusedReceipt = JSON.stringify({
      schema_version: "human-owner-decision.v1",
      task_id: "QX-R4-R00",
      decision: "pass",
      owner_role: "Human Acceptance Owner",
      signed_at: "2026-08-23T12:00:00+09:00",
      candidate_source_commit: evidence.candidate.source_commit,
      candidate_source_sha256: evidence.candidate.source_sha256,
      candidate_build_sha256: evidence.candidate.build_sha256,
      raw_answer_count: 1,
    });
    const reusedPath = join(root, "docs/research/QX-R4-R00/reused-evidence.json");
    await writeFile(reusedPath, reusedReceipt, "utf8");
    const reusedSha = sha256(reusedReceipt);
    evidence.human.status = "passed";
    evidence.human.raw_answer_count = 1;
    evidence.human.owner_decision = "pass";
    evidence.human.raw_answers = { path: "reused-evidence.json", sha256: reusedSha };
    evidence.human.owner_evidence = { path: "./reused-evidence.json", sha256: reusedSha };
    evidence.gates.complete = "passed";
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const humanPath = join(root, "docs/research/QX-R4-R00/human-test.md");
    const human = (await readFile(humanPath, "utf8"))
      .replace("Owner: not applicable to this process-only task", "Owner: Human Acceptance Owner")
      .replace("Decision: not applicable to QX-R4-R00. This file is a validated sample; it cannot be reused as a Human pass for another task.", "Decision: pass")
      .replace("| --- | --- | --- | --- | --- | --- | --- | --- |", `| --- | --- | --- | --- | --- | --- | --- | --- |\n| P01 | novice | 2026-08-23T12:00:00+09:00 | 2026-08-23T12:03:00+09:00 | Exact answer | fail | docs/research/QX-R4-R00/reused-evidence.json | ${reusedSha} |`);
    await writeFile(humanPath, human, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["HUMAN_RAW", "HUMAN_REJECT"]));
  });

  it("computes metric direction and numeric hard-gate outcomes", async () => {
    const root = await makeRoot();
    await copySample(root);
    const path = join(root, "docs/research/QX-R4-R00/evidence.json");
    const evidence = JSON.parse(await readFile(path, "utf8")) as {
      metrics: { load: { baseline: number; candidate: number; direction: string; max_regression_pct: number; regression: boolean } };
      numeric_hard_gates: Array<{ target: { operator: string; value: number }; observed: number; result: string }>;
      gates: { complete: string };
    };
    evidence.metrics.load = { ...evidence.metrics.load, baseline: 1, candidate: 999999, direction: "lower-is-better", max_regression_pct: 0, regression: false };
    evidence.numeric_hard_gates[0].target = { ...evidence.numeric_hard_gates[0].target, operator: "lte", value: 0 };
    evidence.numeric_hard_gates[0].observed = 1;
    evidence.numeric_hard_gates[0].result = "passed";
    evidence.gates.complete = "passed";
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["METRICS_GATE", "HARD_GATE"]));
  });

  it("rejects directories and symlinks as evidence artifacts", async () => {
    const root = await makeRoot();
    await copySample(root);
    const pack = join(root, "docs/research/QX-R4-R00");
    await symlink("rollback.md", join(pack, "rollback-link.md"));
    const path = join(pack, "evidence.json");
    const evidence = JSON.parse(await readFile(path, "utf8")) as { rollback: { artifact: string }; baseline: { build_artifact: string } };
    evidence.rollback.artifact = "rollback-link.md";
    evidence.baseline.build_artifact = "docs/";
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["BASELINE_BUILD_BINDING", "ROLLBACK_SHA256", "ROLLBACK_ARTIFACT"]));
  });

  it("rejects a symlinked required Research Pack file", async () => {
    const root = await makeRoot();
    await copySample(root);
    const pack = join(root, "docs/research/QX-R4-R00");
    await rename(join(pack, "evidence.json"), join(pack, "evidence-real.json"));
    await symlink("evidence-real.json", join(pack, "evidence.json"));
    const result = runValidator(root, "QX-R4-R00");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("PACK_FILE_TYPE");
  });

  it("rejects invalid scale and an official label without matching Primary proof", async () => {
    const root = await makeRoot();
    await copySample(root);
    const evidencePath = join(root, "docs/research/QX-R4-R00/evidence.json");
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as { scale: string };
    evidence.scale = "gigantic";
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const comparablePath = join(root, "docs/research/QX-R4-R00/comparable-games.csv");
    await writeFile(comparablePath, (await readFile(comparablePath, "utf8")).replace("https://www.playstation.com/en-gb/games/journey/", "https://example.com/not-official"), "utf8");
    const result = runValidator(root, "QX-R4-R00");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["SCALE", "COMPARABLE_OFFICIAL_PROOF"]));
  });

  it("rejects blank library fields, arbitrary decisions, missing comparable hypothesis, and missing Sites rollback boundary", async () => {
    const root = await makeRoot();
    await copySample(root);
    const pack = join(root, "docs/research/QX-R4-R00");
    const scorecardPath = join(pack, "library-scorecard.md");
    const scorecard = (await readFile(scorecardPath, "utf8")).replace("| Not in game frame |", "|  |").replace("| Adopt |", "| Maybe |");
    await writeFile(scorecardPath, scorecard, "utf8");
    const comparablePath = join(pack, "comparable-games.csv");
    await writeFile(comparablePath, (await readFile(comparablePath, "utf8")).replace("A persistent route landmark visible for at least three seconds improves first-time direction answers.", ""), "utf8");
    const rollbackPath = join(pack, "rollback.md");
    await writeFile(rollbackPath, (await readFile(rollbackPath, "utf8")).replace(/- Expected Sites rollback version[^\n]*\n/, ""), "utf8");
    const result = runValidator(root, "QX-R4-R00");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["LIBRARY_FIELD", "LIBRARY_DECISION", "COMPARABLE_FIELD", "ROLLBACK_SITES"]));
  });

  it("accepts commits but rejects Git tree objects as commit identities", async () => {
    const { isGitCommit } = await import("../scripts/validate-research-pack.mjs");
    const commit = execFileSync("git", ["-C", projectRoot.pathname, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", projectRoot.pathname, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    expect(isGitCommit(projectRoot.pathname, commit)).toBe(true);
    expect(isGitCommit(projectRoot.pathname, tree)).toBe(false);
  });

  it("rejects moving GitHub labels and duplicate or unofficial comparables", async () => {
    const root = await makeRoot();
    await copySample(root);
    const referencesPath = join(root, "docs/research/QX-R4-R00/references.csv");
    const references = (await readFile(referencesPath, "utf8"))
      .replace("v8.17.1,MIT", "latest,MIT")
      .replace("https://openai.com/index/introducing-the-codex-app/", "https://app.notion.com/p/3c59b8d39c28817f9f6fc3db42f623fd?duplicate=1#same");
    await writeFile(referencesPath, references, "utf8");
    const scorecardPath = join(root, "docs/research/QX-R4-R00/library-scorecard.md");
    await writeFile(scorecardPath, (await readFile(scorecardPath, "utf8")).replace("| v8.17.1 | MIT |", "| latest | MIT |"), "utf8");
    const comparablePath = join(root, "docs/research/QX-R4-R00/comparable-games.csv");
    const comparable = (await readFile(comparablePath, "utf8"))
      .replace("ABZU,https://www.playstation.com/en-cz/games/abzu/,Official", "Journey,https://www.playstation.com/en-gb/games/journey/,Community");
    await writeFile(comparablePath, comparable, "utf8");
    const result = runValidator(root, "QX-R4-R00");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["SOURCE_DISTINCT", "GITHUB_PIN", "LIBRARY_PIN", "COMPARABLE_OFFICIAL", "COMPARABLE_DISTINCT"]));
  });

  it("requires reusable source, build, and rollback SHA-256 bindings", async () => {
    const root = await makeRoot();
    await copySample(root);
    const path = join(root, "docs/research/QX-R4-R00/evidence.json");
    const evidence = JSON.parse(await readFile(path, "utf8")) as {
      baseline: { source_sha256?: string; build_sha256?: string };
      rollback: { source_sha256?: string; build_sha256?: string };
    };
    delete evidence.baseline.source_sha256;
    delete evidence.baseline.build_sha256;
    delete evidence.rollback.source_sha256;
    delete evidence.rollback.build_sha256;
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["BASELINE_SHA256", "ROLLBACK_SHA256"]));
  });

  it("fails an unknown library license", async () => {
    const root = await makeRoot();
    await copySample(root);
    const path = join(root, "docs/research/QX-R4-R00/library-scorecard.md");
    const scorecard = (await readFile(path, "utf8"))
      .replaceAll("MIT / No third-party library added", "Unknown")
      .replaceAll("MIT |", "Unknown |");
    await writeFile(path, scorecard, "utf8");
    const result = runValidator(root, "QX-R4-R00");
    expect(result.status).toBe(1);
    expect(result.report.issues?.some((entry) => entry.code === "LICENSE")).toBe(true);
  });

  it("fails an invalid baseline SHA binding", async () => {
    const root = await makeRoot();
    await copySample(root);
    const path = join(root, "docs/research/QX-R4-R00/evidence.json");
    const evidence = JSON.parse(await readFile(path, "utf8")) as { baseline: { source_commit: string } };
    evidence.baseline.source_commit = "not-a-full-sha";
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["BASELINE_SHA", "BASELINE_BINDING"]));
  });

  it("fails a missing rollback binding", async () => {
    const root = await makeRoot();
    await copySample(root);
    const path = join(root, "docs/research/QX-R4-R00/evidence.json");
    const evidence = JSON.parse(await readFile(path, "utf8")) as { rollback: { commit: string } };
    evidence.rollback.commit = "missing";
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const result = runValidator(root, "QX-R4-R00");
    expect(result.status).toBe(1);
    expect(result.report.issues?.some((entry) => entry.code === "ROLLBACK")).toBe(true);
  });

  it("rejects rollback document commit and gameplay-hash mismatch", async () => {
    const root = await makeRoot();
    await copySample(root);
    const path = join(root, "docs/research/QX-R4-R00/rollback.md");
    const rollback = (await readFile(path, "utf8"))
      .replace(/Rollback commit: [0-9a-f]{40}/, `Rollback commit: ${"1".repeat(40)}`)
      .replace(/- Expected gameplay hash:[^\n]*/, "- Expected gameplay hash: wrong");
    await writeFile(path, rollback, "utf8");
    const result = runValidator(root, "QX-R4-R00");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["ROLLBACK_FILE", "ROLLBACK_GAMEPLAY"]));
  });

  it("does not overwrite an existing Research Pack", async () => {
    const root = await makeRoot();
    execFileSync(process.execPath, [initializer.pathname, "QX-NO-OVERWRITE", "--root", root]);
    const before = await readFile(join(root, "docs/research/QX-NO-OVERWRITE/research-card.md"), "utf8");
    const second = spawnSync(process.execPath, [initializer.pathname, "QX-NO-OVERWRITE", "--root", root], { encoding: "utf8" });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("already exists");
    expect(await readFile(join(root, "docs/research/QX-NO-OVERWRITE/research-card.md"), "utf8")).toBe(before);
  });
});
