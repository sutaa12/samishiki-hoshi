import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = new URL("../", import.meta.url);
const initializer = new URL("../scripts/init-research-pack.mjs", import.meta.url);
const validator = new URL("../scripts/validate-research-pack.mjs", import.meta.url);
const temporaryRoots: string[] = [];

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

function runValidator(root: string, taskId: string, stage = "research", acceptance = "human-release") {
  const result = spawnSync(process.execPath, [validator.pathname, taskId, "--root", root, "--stage", stage, "--acceptance", acceptance], { encoding: "utf8" });
  return { ...result, report: JSON.parse(result.stdout || "{}") as { ok?: boolean; issues?: Array<{ code: string }> } };
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function prepareValidAiBinaryPack(root: string) {
  await copySample(root);
  const pack = join(root, "docs/research/QX-R4-R00");
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

  const build = await artifact("ai-build.manifest", "app.js  fixture-runtime\n");
  const baselineScreenshot = await artifact("baseline-shot.bin", "baseline screenshot");
  const baselineClip = await artifact("baseline-clip.bin", "baseline clip");
  const baselineMetrics = await artifact("baseline-metrics.json", { result: "baseline" });
  const screenshot = await artifact("candidate-shot.bin", "candidate screenshot");
  const video = await artifact("candidate-video.webm", "candidate video bytes");
  const inputTrace = await artifact("candidate-input.json", { events: [{ at_ms: 100, input: "left" }] });
  const captureReceipt = await artifact("candidate-capture.json", {
    schema_version: "capture-set.v1",
    task_id: "QX-R4-R00",
    candidate_source_commit: commit,
    candidate_source_sha256: sourceSha,
    candidate_build_sha256: build.sha256,
    artifacts: { screenshot, clip: video, input_trace: inputTrace },
  });
  const buildReceipt = await artifact("candidate-build.json", {
    schema_version: "build-command.v1",
    task_id: "QX-R4-R00",
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
    task_id: "QX-R4-R00",
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
    task_id: "QX-R4-R00",
    candidate_source_commit: commit,
    candidate_source_sha256: sourceSha,
    candidate_build_sha256: build.sha256,
    gates: { ai_binary_fixture: { observed: 1, unit: "pass", result: "passed" } },
  });
  const telemetry = await artifact("telemetry.json", {
    schema_version: "ai-binary-telemetry.v1",
    task_id: "QX-R4-R00",
    result: "passed",
    subject_source_sha256: sourceSha,
    subject_build_sha256: build.sha256,
    subject_video_sha256: video.sha256,
    recorded_at: "2026-08-23T07:30:00Z",
    frame_count: 900,
    duration_ms: 15000,
    distance_increases_every_frame: true,
    max_still_frame_ms: 400,
    input_response_ms: 80,
    encounter_order: ["ring", "obstacle", "node"],
  });
  const eventLedger = await artifact("event-ledger.json", {
    schema_version: "ai-binary-event-ledger.v1",
    task_id: "QX-R4-R00",
    subject_source_sha256: sourceSha,
    subject_build_sha256: build.sha256,
    subject_video_sha256: video.sha256,
    recorded_at: "2026-08-23T07:30:00Z",
    events: [{ event_class: "ring", at_ms: 4000 }, { event_class: "obstacle", at_ms: 8000 }, { event_class: "node", at_ms: 11000 }, { event_class: "progress", at_ms: 14000 }],
  });
  const descriptions = [
    "A droplet steers through a hoop before avoiding a solid hazard and energizing a plant.",
    "The player moves sideways, clears a ring, dodges a rock, then sends light into a sprout.",
    "A small water character advances continuously through a gate and obstacle toward a pulse target.",
  ];
  const reviews = [];
  for (let index = 0; index < 3; index += 1) {
    reviews.push(await artifact(`review-${index + 1}.json`, {
      schema_version: "ai-binary-review.v1",
      task_id: "QX-R4-R00",
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
    task_id: "QX-R4-R00",
    subject_source_sha256: sourceSha,
    subject_build_sha256: build.sha256,
    subject_video_sha256: video.sha256,
    recorded_at: "2026-08-23T07:35:00Z",
    decision: "accept",
    observations: "All three independent reviews passed; preserve fail-to-module routing for later iterations.",
    remediation_map: {
      motion: "Return to Conveyor Rail speed, TTC, FOV, and Near markers.",
      player: "Return to Player screen size, position, silhouette, and local contrast.",
      objective: "Return to one-purpose framing, target shape, and short verb UI.",
      pulse: "Return to the light path, Node deformation, local ecology, and Progress feedback.",
      progress: "Return to encounter completion, landmark approach, and 1/3 Progress changes.",
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
  return { pack, evidencePath, reviews, telemetry, video };
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

  it("keeps Human release fail-closed when the Human file is absent", async () => {
    const root = await makeRoot();
    await prepareValidAiBinaryPack(root);
    const result = runValidator(root, "QX-R4-R00", "complete", "human-release");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("MISSING_FILE");
  });

  it("does not let AI Binary mode override a preserved Human Reject", async () => {
    const root = await makeRoot();
    const fixture = await prepareValidAiBinaryPack(root);
    await writeFile(join(fixture.pack, "human-test.md"), "# Human test\n\nDecision: reject\n", "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete", "ai-binary");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toContain("HUMAN_REJECT");
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
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["BASELINE_BUILD_BINDING", "ROLLBACK_SHA256"]));
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
