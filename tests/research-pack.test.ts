import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

function runValidator(root: string, taskId: string, stage = "research") {
  const result = spawnSync(process.execPath, [validator.pathname, taskId, "--root", root, "--stage", stage], { encoding: "utf8" });
  return { ...result, report: JSON.parse(result.stdout || "{}") as { ok?: boolean; issues?: Array<{ code: string }> } };
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evidence-driven Research Pack", () => {
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
      expect.arrayContaining(["COMPLETE_GATE", "METRICS_GATE", "HARD_GATE", "HUMAN_GATE"]),
    );
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
    const reusedRef = { path: "reused-evidence.json", sha256: sha256(reusedReceipt) };
    evidence.human.status = "passed";
    evidence.human.raw_answer_count = 1;
    evidence.human.owner_decision = "pass";
    evidence.human.raw_answers = reusedRef;
    evidence.human.owner_evidence = reusedRef;
    evidence.gates.complete = "passed";
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    const humanPath = join(root, "docs/research/QX-R4-R00/human-test.md");
    const human = (await readFile(humanPath, "utf8"))
      .replace("Owner: not applicable to this process-only task", "Owner: Human Acceptance Owner")
      .replace("Decision: not applicable to QX-R4-R00. This file is a validated sample; it cannot be reused as a Human pass for another task.", "Decision: pass")
      .replace("| --- | --- | --- | --- | --- | --- | --- | --- |", `| --- | --- | --- | --- | --- | --- | --- | --- |\n| P01 | novice | 2026-08-23T12:00:00+09:00 | 2026-08-23T12:03:00+09:00 | Exact answer | pass | reused-evidence.json | ${reusedRef.sha256} |`);
    await writeFile(humanPath, human, "utf8");
    const result = runValidator(root, "QX-R4-R00", "complete");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["HUMAN_RAW"]));
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

  it("rejects moving GitHub labels and duplicate or unofficial comparables", async () => {
    const root = await makeRoot();
    await copySample(root);
    const referencesPath = join(root, "docs/research/QX-R4-R00/references.csv");
    await writeFile(referencesPath, (await readFile(referencesPath, "utf8")).replace("v8.17.1,MIT", "latest,MIT"), "utf8");
    const scorecardPath = join(root, "docs/research/QX-R4-R00/library-scorecard.md");
    await writeFile(scorecardPath, (await readFile(scorecardPath, "utf8")).replace("| v8.17.1 | MIT |", "| latest | MIT |"), "utf8");
    const comparablePath = join(root, "docs/research/QX-R4-R00/comparable-games.csv");
    const comparable = (await readFile(comparablePath, "utf8"))
      .replace("ABZU,https://www.playstation.com/en-cz/games/abzu/,Official", "Journey,https://www.playstation.com/en-gb/games/journey/,Community");
    await writeFile(comparablePath, comparable, "utf8");
    const result = runValidator(root, "QX-R4-R00");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(expect.arrayContaining(["GITHUB_PIN", "LIBRARY_PIN", "COMPARABLE_OFFICIAL", "COMPARABLE_DISTINCT"]));
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
