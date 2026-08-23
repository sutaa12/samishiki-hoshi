#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const TASK_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PLACEHOLDER_PATTERN = /\{\{[^}]+\}\}|REPLACE_(?:ME|WITH_[A-Z_]+)|\bTBD\b/;
const REQUIRED_FILES = [
  "research-card.md",
  "references.csv",
  "comparable-games.csv",
  "frame-analysis.csv",
  "library-scorecard.md",
  "current-baseline.md",
  "decision.md",
  "rollback.md",
  "ablation.md",
  "human-test.md",
  "evidence.json",
];

function parseArguments(argv) {
  let root = process.cwd();
  let taskId;
  let stage = "research";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      root = resolve(argv[index + 1] ?? "");
      index += 1;
    } else if (argument === "--stage") {
      stage = argv[index + 1] ?? "";
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
  if (!new Set(["research", "complete"]).has(stage)) {
    throw new Error("Stage must be research or complete.");
  }
  return { root: resolve(root), taskId, stage };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field.trim());
      field = "";
    } else if (character === "\n") {
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function meaningful(value) {
  return typeof value === "string" && value.trim().length > 0 && !PLACEHOLDER_PATTERN.test(value);
}

function issue(code, message, file) {
  return { code, message, ...(file ? { file } : {}) };
}

function markdownTableRows(text) {
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("|") && !/^\|\s*-/.test(line.trim()))
    .slice(1)
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
}

export async function validateResearchPack(root, taskId, stage = "research") {
  const directory = resolve(root, "docs/research", taskId);
  const issues = [];
  const files = new Map();

  for (const file of REQUIRED_FILES) {
    try {
      const fileText = await readFile(resolve(directory, file), "utf8");
      files.set(file, fileText);
      if (!fileText.trim()) issues.push(issue("EMPTY_FILE", `${file} is empty.`, file));
    } catch {
      issues.push(issue("MISSING_FILE", `${file} is required.`, file));
    }
  }
  if (issues.some((entry) => entry.code === "MISSING_FILE")) {
    return { ok: false, task_id: taskId, stage, issues, counts: {} };
  }

  for (const [file, fileText] of files) {
    if (PLACEHOLDER_PATTERN.test(fileText)) {
      issues.push(issue("PLACEHOLDER", `${file} still contains an unfinished placeholder.`, file));
    }
  }

  const references = parseCsv(files.get("references.csv"));
  const comparableGames = parseCsv(files.get("comparable-games.csv"));
  const frames = parseCsv(files.get("frame-analysis.csv"));
  const primary = references.filter((row) => row.SourceType === "Primary");
  const github = references.filter((row) => row.SourceType === "GitHub");
  const community = references.filter((row) => row.SourceType === "Community");

  for (const [kind, rows, minimum] of [["Primary", primary, 2], ["GitHub", github, 2], ["Community", community, 2]]) {
    if (rows.length < minimum) {
      issues.push(issue("SOURCE_COUNT", `${kind} evidence requires at least ${minimum} rows; found ${rows.length}.`, "references.csv"));
    }
  }
  for (const [index, row] of references.entries()) {
    for (const field of ["ID", "SourceType", "Title", "URL", "ObservedFact", "Inference", "TestableHypothesis", "AccessedAt"]) {
      if (!meaningful(row[field])) issues.push(issue("SOURCE_FIELD", `references.csv row ${index + 2} needs ${field}.`, "references.csv"));
    }
    if (row.SourceType === "GitHub") {
      if (!meaningful(row.VersionOrCommit)) issues.push(issue("GITHUB_PIN", `GitHub row ${index + 2} needs a locked version or commit.`, "references.csv"));
      if (!meaningful(row.License) || /unknown|unclear/i.test(row.License)) issues.push(issue("LICENSE", `GitHub row ${index + 2} needs a known license.`, "references.csv"));
    }
  }

  let evidence;
  try {
    evidence = JSON.parse(files.get("evidence.json"));
  } catch (error) {
    issues.push(issue("INVALID_JSON", `evidence.json is invalid: ${error instanceof Error ? error.message : String(error)}`, "evidence.json"));
    evidence = {};
  }
  const scale = evidence.scale === "large" ? "large" : "standard";
  const minimumGames = scale === "large" ? 5 : 3;
  const minimumFrames = scale === "large" ? 12 : 6;
  if (comparableGames.length < minimumGames) {
    issues.push(issue("COMPARABLE_COUNT", `${scale} research requires ${minimumGames} comparable games; found ${comparableGames.length}.`, "comparable-games.csv"));
  }
  if (frames.length < minimumFrames) {
    issues.push(issue("FRAME_COUNT", `${scale} research requires ${minimumFrames} annotated frames or timecodes; found ${frames.length}.`, "frame-analysis.csv"));
  }
  for (const [index, row] of comparableGames.entries()) {
    for (const field of ["Game", "Source", "Observed", "Inference", "AdoptOrReject"]) {
      if (!meaningful(row[field])) issues.push(issue("COMPARABLE_FIELD", `comparable-games.csv row ${index + 2} needs ${field}.`, "comparable-games.csv"));
    }
  }
  for (const [index, row] of frames.entries()) {
    for (const field of ["FrameID", "Game", "Source", "TimecodeOrFrame", "Observed", "Inference", "TestableHypothesis", "Rights"]) {
      if (!meaningful(row[field])) issues.push(issue("FRAME_FIELD", `frame-analysis.csv row ${index + 2} needs ${field}.`, "frame-analysis.csv"));
    }
  }

  if (evidence.schema_version !== "research-pack.v1") issues.push(issue("SCHEMA", "evidence.json schema_version must be research-pack.v1.", "evidence.json"));
  if (evidence.task_id !== taskId) issues.push(issue("TASK_ID", "evidence.json task_id must match the requested pack.", "evidence.json"));
  if (!SHA_PATTERN.test(evidence.source_commit ?? "")) issues.push(issue("SOURCE_SHA", "evidence.json source_commit must be a full Git SHA.", "evidence.json"));
  if (!SHA_PATTERN.test(evidence.baseline?.source_commit ?? "")) issues.push(issue("BASELINE_SHA", "Baseline source_commit must be a full Git SHA.", "evidence.json"));
  if (evidence.baseline?.source_commit !== evidence.source_commit) issues.push(issue("BASELINE_BINDING", "Baseline and Research Pack must bind to the same source SHA before a Candidate is created.", "evidence.json"));
  if (!meaningful(evidence.baseline?.screenshot) || !meaningful(evidence.baseline?.clip) || !meaningful(evidence.baseline?.metrics) || !meaningful(evidence.baseline?.human_findings)) {
    issues.push(issue("BASELINE_EVIDENCE", "Baseline needs screenshot, moving clip, metrics, and raw human findings.", "evidence.json"));
  }
  if (!Array.isArray(evidence.options) || !evidence.options.some((option) => option.decision === "rejected" && meaningful(option.reason))) {
    issues.push(issue("REJECTED_ALTERNATIVE", "Record at least one rejected alternative and its reason.", "evidence.json"));
  }
  if (!meaningful(evidence.decision?.selected_option) || !meaningful(evidence.decision?.rationale)) issues.push(issue("DECISION", "A selected option and evidence-based rationale are required.", "evidence.json"));
  if (!SHA_PATTERN.test(evidence.rollback?.commit ?? "") || !meaningful(evidence.rollback?.condition) || !meaningful(evidence.rollback?.instructions)) {
    issues.push(issue("ROLLBACK", "Rollback needs a full commit, trigger condition, and instructions.", "evidence.json"));
  }
  if (evidence.gates?.research !== "passed") issues.push(issue("RESEARCH_GATE", "evidence.json gates.research must be passed after the pack is complete.", "evidence.json"));

  const libraryScorecard = files.get("library-scorecard.md");
  const scorecardRows = markdownTableRows(libraryScorecard);
  if (scorecardRows.length === 0) issues.push(issue("LIBRARY_ROW", "library-scorecard.md needs at least one evaluated option.", "library-scorecard.md"));
  for (const [index, row] of scorecardRows.entries()) {
    if (!meaningful(row[0]) || !meaningful(row[1]) || !meaningful(row[2])) issues.push(issue("LIBRARY_PIN", `Library row ${index + 1} needs candidate, repository, and locked version or commit.`, "library-scorecard.md"));
    if (!/\b(?:MIT|Apache-2\.0|BSD-[23]-Clause|MPL-2\.0|ISC|CC0-1\.0|No third-party library)\b/.test(row[3] ?? "")) issues.push(issue("LICENSE", `Library row ${index + 1} needs a known license or No third-party library.`, "library-scorecard.md"));
    if (!meaningful(row[16])) issues.push(issue("LIBRARY_FALLBACK", `Library row ${index + 1} needs a fallback.`, "library-scorecard.md"));
    if (!SHA_PATTERN.test(row[17] ?? "")) issues.push(issue("LIBRARY_ROLLBACK", `Library row ${index + 1} needs a full rollback commit.`, "library-scorecard.md"));
    if (!meaningful(row[18])) issues.push(issue("LIBRARY_DECISION", `Library row ${index + 1} needs an Adopt, Conditional, or Reject decision.`, "library-scorecard.md"));
  }
  if (!files.get("decision.md").includes("Rejected:")) issues.push(issue("DECISION_REJECT", "decision.md must preserve a rejected option and reason.", "decision.md"));
  if (!/Rollback commit:\s*[0-9a-f]{40}/.test(files.get("rollback.md"))) issues.push(issue("ROLLBACK_FILE", "rollback.md must bind a full rollback commit.", "rollback.md"));
  if (!files.get("research-card.md").includes(`Task ID: ${taskId}`)) issues.push(issue("CARD_TASK_ID", "research-card.md Task ID must match the directory.", "research-card.md"));
  if (!files.get("current-baseline.md").includes(`Source commit: ${evidence.source_commit}`)) issues.push(issue("BASELINE_FILE_BINDING", "current-baseline.md must bind the evidence.json source commit.", "current-baseline.md"));

  if (stage === "complete") {
    if (evidence.gates?.complete !== "passed") issues.push(issue("COMPLETE_GATE", "evidence.json gates.complete must be passed.", "evidence.json"));
    if (evidence.metrics?.status !== "passed" || evidence.metrics?.performance_no_regression !== true) issues.push(issue("METRICS_GATE", "Complete evidence needs passed metrics and no load/frame/memory regression.", "evidence.json"));
    if (!Array.isArray(evidence.numeric_hard_gates) || evidence.numeric_hard_gates.length === 0 || evidence.numeric_hard_gates.some((gate) => gate.result !== "passed" || !meaningful(gate.evidence))) {
      issues.push(issue("HARD_GATE", "Every numeric hard gate must pass with evidence.", "evidence.json"));
    }
    if (evidence.human?.status !== "passed" || evidence.human?.owner_decision !== "pass" || !(evidence.human?.raw_answer_count > 0)) {
      issues.push(issue("HUMAN_GATE", "Complete evidence needs a human pass and at least one preserved raw answer.", "evidence.json"));
    }
    if (/Status:\s*pending|Decision:\s*pending/i.test(files.get("human-test.md"))) issues.push(issue("HUMAN_RAW", "human-test.md still records a pending human result.", "human-test.md"));
    if (/\| Candidate \|[\s\S]*\| pending \|/i.test(files.get("ablation.md"))) issues.push(issue("ABLATION", "Candidate ablation result cannot remain pending.", "ablation.md"));
  }

  const counts = {
    primary: primary.length,
    github: github.length,
    community: community.length,
    comparable_games: comparableGames.length,
    frames: frames.length,
  };
  return { ok: issues.length === 0, task_id: taskId, stage, scale, counts, issues };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { root, taskId, stage } = parseArguments(process.argv.slice(2));
    const result = await validateResearchPack(root, taskId, stage);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
