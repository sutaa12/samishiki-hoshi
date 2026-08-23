import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      counts: { primary: 3, github: 2, community: 2, comparable_games: 3, frames: 6 },
    });
  });

  it("keeps completion blocked without numeric and raw human evidence", () => {
    const result = runValidator(projectRoot.pathname, "QX-R4-R00", "complete");
    expect(result.status).toBe(1);
    expect(result.report.issues?.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["COMPLETE_GATE", "METRICS_GATE", "HARD_GATE", "HUMAN_GATE"]),
    );
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
