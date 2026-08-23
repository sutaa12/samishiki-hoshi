#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const TASK_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PIN_PATTERN = /^(?:[0-9a-f]{40}|v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
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

function uniqueNonempty(rows, field) {
  const values = rows.map((row) => row[field]?.trim().toLowerCase()).filter(Boolean);
  return values.length === rows.length && new Set(values).size === values.length;
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function artifactPath(root, packDirectory, artifact) {
  if (!meaningful(artifact)) return null;
  const path = resolve(artifact.includes("/") ? root : packDirectory, artifact);
  const rootPath = resolve(root);
  const within = relative(rootPath, path);
  return within && !within.startsWith("..") && !isAbsolute(within) ? path : null;
}

async function regularArtifact(root, packDirectory, artifact) {
  const path = artifactPath(root, packDirectory, artifact);
  if (!path) return { ok: false, reason: "path is missing or outside the repository", path: null, sha256: null };
  try {
    const lexical = await lstat(path);
    if (lexical.isSymbolicLink() || !lexical.isFile()) return { ok: false, reason: "path is not a regular non-symlink file", path, sha256: null };
    const resolvedPath = await realpath(path);
    const rootPath = await realpath(root);
    const within = relative(rootPath, resolvedPath);
    if (!within || within.startsWith("..") || isAbsolute(within) || !(await stat(resolvedPath)).isFile()) return { ok: false, reason: "resolved path is outside the repository or not a regular file", path, sha256: null };
    return { ok: true, reason: null, path: resolvedPath, sha256: createHash("sha256").update(await readFile(resolvedPath)).digest("hex") };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), path, sha256: null };
  }
}

async function validArtifactRef(root, packDirectory, reference) {
  if (!reference || typeof reference !== "object" || !meaningful(reference.path) || !SHA256_PATTERN.test(reference.sha256 ?? "")) return false;
  const artifact = await regularArtifact(root, packDirectory, reference.path);
  return artifact.ok && artifact.sha256 === reference.sha256;
}

async function readArtifactJson(root, packDirectory, reference) {
  if (!(await validArtifactRef(root, packDirectory, reference))) return null;
  const artifact = await regularArtifact(root, packDirectory, reference.path);
  try {
    return JSON.parse(await readFile(artifact.path, "utf8"));
  } catch {
    return null;
  }
}

function comparisonPasses(target, observed) {
  if (!target || typeof target !== "object" || !Number.isFinite(target.value) || !meaningful(target.unit) || !Number.isFinite(observed)) return false;
  if (target.operator === "eq") return observed === target.value;
  if (target.operator === "lte") return observed <= target.value;
  if (target.operator === "gte") return observed >= target.value;
  return false;
}

function metricPasses(metric) {
  if (!metric || !Number.isFinite(metric.baseline) || !Number.isFinite(metric.candidate) || !Number.isFinite(metric.max_regression_pct) || metric.max_regression_pct < 0 || !meaningful(metric.unit) || !meaningful(metric.observation)) return false;
  const tolerance = metric.max_regression_pct / 100;
  let noRegression = false;
  if (metric.direction === "lower-is-better") noRegression = metric.candidate <= metric.baseline * (1 + tolerance);
  else if (metric.direction === "higher-is-better") noRegression = metric.candidate >= metric.baseline * (1 - tolerance);
  else if (metric.direction === "equal-only") noRegression = metric.candidate === metric.baseline;
  return noRegression && metric.regression === false;
}

function gitArchiveSha256(root, commit) {
  if (!SHA_PATTERN.test(commit ?? "")) return null;
  const result = spawnSync("git", ["-C", root, "archive", "--format=tar", commit], { maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout) return null;
  return createHash("sha256").update(result.stdout).digest("hex");
}

export function isGitCommit(root, object) {
  if (!SHA_PATTERN.test(object ?? "")) return false;
  const result = spawnSync("git", ["-C", root, "cat-file", "-t", object], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "commit";
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
    const artifact = await regularArtifact(root, directory, file);
    if (!artifact.ok) {
      const missing = /ENOENT|no such file/i.test(artifact.reason ?? "");
      issues.push(issue(missing ? "MISSING_FILE" : "PACK_FILE_TYPE", missing ? `${file} is required.` : `${file} must be a repository-contained regular non-symlink file.`, file));
      continue;
    }
    try {
      const fileText = await readFile(artifact.path, "utf8");
      files.set(file, fileText);
      if (!fileText.trim()) issues.push(issue("EMPTY_FILE", `${file} is empty.`, file));
    } catch {
      issues.push(issue("MISSING_FILE", `${file} is required.`, file));
    }
  }
  if (issues.some((entry) => entry.code === "MISSING_FILE" || entry.code === "PACK_FILE_TYPE")) {
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
      if (!PIN_PATTERN.test(row.VersionOrCommit ?? "")) issues.push(issue("GITHUB_PIN", `GitHub row ${index + 2} needs a semantic version tag or full 40-character commit, not a moving label.`, "references.csv"));
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\/|$)/.test(row.URL ?? "")) issues.push(issue("GITHUB_URL", `GitHub row ${index + 2} needs a github.com repository or release URL.`, "references.csv"));
      if (!meaningful(row.License) || /unknown|unclear/i.test(row.License)) issues.push(issue("LICENSE", `GitHub row ${index + 2} needs a known license.`, "references.csv"));
    }
  }
  if (!uniqueNonempty(references, "ID")) issues.push(issue("SOURCE_DISTINCT", "Reference IDs must be nonempty and distinct.", "references.csv"));
  const canonicalReferenceUrls = references.map((row) => canonicalUrl(row.URL));
  if (canonicalReferenceUrls.some((url) => !url) || new Set(canonicalReferenceUrls).size !== canonicalReferenceUrls.length) issues.push(issue("SOURCE_DISTINCT", "Reference URLs must be valid HTTPS and canonically distinct after removing query, fragment, www, and trailing-slash differences.", "references.csv"));

  let evidence;
  try {
    evidence = JSON.parse(files.get("evidence.json"));
  } catch (error) {
    issues.push(issue("INVALID_JSON", `evidence.json is invalid: ${error instanceof Error ? error.message : String(error)}`, "evidence.json"));
    evidence = {};
  }
  const scale = evidence.scale;
  if (!new Set(["standard", "large"]).has(scale)) issues.push(issue("SCALE", "evidence.json scale must be standard or large.", "evidence.json"));
  const minimumGames = scale === "large" ? 5 : 3;
  const minimumFrames = scale === "large" ? 12 : 6;
  if (comparableGames.length < minimumGames) {
    issues.push(issue("COMPARABLE_COUNT", `${scale} research requires ${minimumGames} comparable games; found ${comparableGames.length}.`, "comparable-games.csv"));
  }
  if (frames.length < minimumFrames) {
    issues.push(issue("FRAME_COUNT", `${scale} research requires ${minimumFrames} annotated frames or timecodes; found ${frames.length}.`, "frame-analysis.csv"));
  }
  for (const [index, row] of comparableGames.entries()) {
    for (const field of ["Game", "Source", "SourceKind", "OfficialEvidenceID", "Publisher", "Observed", "Inference", "TestableHypothesis", "AdoptOrReject"]) {
      if (!meaningful(row[field])) issues.push(issue("COMPARABLE_FIELD", `comparable-games.csv row ${index + 2} needs ${field}.`, "comparable-games.csv"));
    }
    if (row.SourceKind !== "Official" || !isHttpsUrl(row.Source)) issues.push(issue("COMPARABLE_OFFICIAL", `comparable-games.csv row ${index + 2} must use an HTTPS Official source.`, "comparable-games.csv"));
    const proof = primary.find((entry) => entry.ID === row.OfficialEvidenceID);
    if (!proof || canonicalUrl(proof.URL) !== canonicalUrl(row.Source) || !meaningful(proof.ObservedFact)) issues.push(issue("COMPARABLE_OFFICIAL_PROOF", `comparable-games.csv row ${index + 2} must cite a Primary evidence ID with the same canonical official URL.`, "comparable-games.csv"));
  }
  const comparableCanonicalUrls = comparableGames.map((row) => canonicalUrl(row.Source));
  if (!uniqueNonempty(comparableGames, "Game") || comparableCanonicalUrls.some((url) => !url) || new Set(comparableCanonicalUrls).size !== comparableCanonicalUrls.length) issues.push(issue("COMPARABLE_DISTINCT", "Comparable games and canonical official source URLs must be distinct.", "comparable-games.csv"));
  for (const [index, row] of frames.entries()) {
    for (const field of ["FrameID", "Game", "Source", "SourceKind", "TimecodeOrFrame", "Observed", "Inference", "TestableHypothesis", "Rights"]) {
      if (!meaningful(row[field])) issues.push(issue("FRAME_FIELD", `frame-analysis.csv row ${index + 2} needs ${field}.`, "frame-analysis.csv"));
    }
    if (row.SourceKind !== "Official" || !isHttpsUrl(row.Source)) issues.push(issue("FRAME_OFFICIAL", `frame-analysis.csv row ${index + 2} must use an HTTPS Official source.`, "frame-analysis.csv"));
    const comparable = comparableGames.find((entry) => entry.Game === row.Game && canonicalUrl(entry.Source) === canonicalUrl(row.Source));
    if (!comparable) issues.push(issue("FRAME_OFFICIAL_PROOF", `frame-analysis.csv row ${index + 2} must match an officially proven comparable-game source.`, "frame-analysis.csv"));
  }
  if (!uniqueNonempty(frames, "FrameID")) issues.push(issue("FRAME_DISTINCT", "Frame identifiers must be distinct.", "frame-analysis.csv"));
  const frameLocators = frames.map((row) => `${row.Game?.trim().toLowerCase()}|${canonicalUrl(row.Source)}|${row.TimecodeOrFrame?.trim().toLowerCase()}`);
  if (new Set(frameLocators).size !== frameLocators.length) issues.push(issue("FRAME_DISTINCT", "Game, source, and timecode/frame tuples must be distinct.", "frame-analysis.csv"));

  if (evidence.schema_version !== "research-pack.v1") issues.push(issue("SCHEMA", "evidence.json schema_version must be research-pack.v1.", "evidence.json"));
  if (evidence.task_id !== taskId) issues.push(issue("TASK_ID", "evidence.json task_id must match the requested pack.", "evidence.json"));
  if (!SHA_PATTERN.test(evidence.source_commit ?? "")) issues.push(issue("SOURCE_SHA", "evidence.json source_commit must be a full Git SHA.", "evidence.json"));
  if (!SHA_PATTERN.test(evidence.baseline?.source_commit ?? "")) issues.push(issue("BASELINE_SHA", "Baseline source_commit must be a full Git SHA.", "evidence.json"));
  if (!isGitCommit(root, evidence.source_commit) || !isGitCommit(root, evidence.baseline?.source_commit)) issues.push(issue("GIT_COMMIT_TYPE", "Research and baseline source identifiers must resolve to Git commit objects, not trees, blobs, or tags.", "evidence.json"));
  if (!SHA256_PATTERN.test(evidence.baseline?.source_sha256 ?? "") || !SHA256_PATTERN.test(evidence.baseline?.build_sha256 ?? "")) issues.push(issue("BASELINE_SHA256", "Baseline needs exact 64-character source and build SHA-256 values.", "evidence.json"));
  const baselineBuildArtifact = await regularArtifact(root, directory, evidence.baseline?.build_artifact);
  if (!meaningful(evidence.baseline?.build_hash_procedure) || !baselineBuildArtifact.ok) issues.push(issue("BASELINE_BUILD_BINDING", "Baseline needs a reproducible build-hash procedure and a repository-contained regular build evidence file.", "evidence.json"));
  if (gitArchiveSha256(root, evidence.baseline?.source_commit) !== evidence.baseline?.source_sha256) issues.push(issue("BASELINE_SOURCE_DIGEST", "Baseline source SHA-256 must match the exact git archive for baseline.source_commit.", "evidence.json"));
  if (baselineBuildArtifact.sha256 !== evidence.baseline?.build_sha256) issues.push(issue("BASELINE_BUILD_DIGEST", "Baseline build SHA-256 must match the persisted build artifact.", "evidence.json"));
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
  if (!isGitCommit(root, evidence.rollback?.commit)) issues.push(issue("GIT_COMMIT_TYPE", "Rollback identifier must resolve to a Git commit object.", "evidence.json"));
  if (!SHA256_PATTERN.test(evidence.rollback?.source_sha256 ?? "") || !SHA256_PATTERN.test(evidence.rollback?.build_sha256 ?? "") || !(await regularArtifact(root, directory, evidence.rollback?.artifact)).ok) {
    issues.push(issue("ROLLBACK_SHA256", "Rollback needs source/build SHA-256 values and an existing rollback artifact.", "evidence.json"));
  }
  if (evidence.rollback?.commit !== evidence.baseline?.source_commit || evidence.rollback?.source_sha256 !== evidence.baseline?.source_sha256 || evidence.rollback?.build_sha256 !== evidence.baseline?.build_sha256) issues.push(issue("ROLLBACK_BINDING", "Rollback commit and source/build SHA-256 values must match the accepted baseline.", "evidence.json"));
  if (evidence.gates?.research !== "passed") issues.push(issue("RESEARCH_GATE", "evidence.json gates.research must be passed after the pack is complete.", "evidence.json"));

  const libraryScorecard = files.get("library-scorecard.md");
  const scorecardRows = markdownTableRows(libraryScorecard);
  if (scorecardRows.length === 0) issues.push(issue("LIBRARY_ROW", "library-scorecard.md needs at least one evaluated option.", "library-scorecard.md"));
  for (const [index, row] of scorecardRows.entries()) {
    if (row.length < 19 || row.slice(0, 19).some((cell) => !meaningful(cell))) issues.push(issue("LIBRARY_FIELD", `Library row ${index + 1} must fill every mandatory maintenance, compatibility, cost, lifecycle, determinism, browser, communication, fallback, rollback, and decision cell.`, "library-scorecard.md"));
    if (!meaningful(row[0]) || !/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\/|$)/.test(row[1] ?? "") || (!/No third-party library/.test(row[3] ?? "") && !PIN_PATTERN.test(row[2] ?? ""))) issues.push(issue("LIBRARY_PIN", `Library row ${index + 1} needs a GitHub repository and semantic version or full commit; only an explicit no-third-party option may use the existing engine contract.`, "library-scorecard.md"));
    if (!/\b(?:MIT|Apache-2\.0|BSD-[23]-Clause|MPL-2\.0|ISC|CC0-1\.0|No third-party library)\b/.test(row[3] ?? "")) issues.push(issue("LICENSE", `Library row ${index + 1} needs a known license or No third-party library.`, "library-scorecard.md"));
    if (!meaningful(row[16])) issues.push(issue("LIBRARY_FALLBACK", `Library row ${index + 1} needs a fallback.`, "library-scorecard.md"));
    if (!SHA_PATTERN.test(row[17] ?? "")) issues.push(issue("LIBRARY_ROLLBACK", `Library row ${index + 1} needs a full rollback commit.`, "library-scorecard.md"));
    if (!/^(?:Adopt|Conditional|Reject)\b/.test(row[18] ?? "")) issues.push(issue("LIBRARY_DECISION", `Library row ${index + 1} needs an Adopt, Conditional, or Reject decision.`, "library-scorecard.md"));
  }
  if (!files.get("decision.md").includes("Rejected:")) issues.push(issue("DECISION_REJECT", "decision.md must preserve a rejected option and reason.", "decision.md"));
  if (!/Rollback commit:\s*[0-9a-f]{40}/.test(files.get("rollback.md"))) issues.push(issue("ROLLBACK_FILE", "rollback.md must bind a full rollback commit.", "rollback.md"));
  if (!new RegExp(`Expected source archive SHA-256:\\s*${evidence.rollback?.source_sha256 ?? "invalid"}`).test(files.get("rollback.md")) || !new RegExp(`Expected Production build SHA-256:\\s*${evidence.rollback?.build_sha256 ?? "invalid"}`).test(files.get("rollback.md"))) {
    issues.push(issue("ROLLBACK_FILE_SHA256", "rollback.md must match the rollback source and build SHA-256 values.", "rollback.md"));
  }
  if (!/Expected Sites rollback version[^:]*:\s*(?!pending\b|none\b|not applicable\b).+/i.test(files.get("rollback.md"))) issues.push(issue("ROLLBACK_SITES", "rollback.md must preserve the prior Sites version or explicit currently deployed rollback boundary.", "rollback.md"));
  if (!files.get("research-card.md").includes(`Task ID: ${taskId}`)) issues.push(issue("CARD_TASK_ID", "research-card.md Task ID must match the directory.", "research-card.md"));
  if (!files.get("current-baseline.md").includes(`Source commit: ${evidence.source_commit}`)) issues.push(issue("BASELINE_FILE_BINDING", "current-baseline.md must bind the evidence.json source commit.", "current-baseline.md"));

  if (stage === "complete") {
    if (evidence.gates?.complete !== "passed") issues.push(issue("COMPLETE_GATE", "evidence.json gates.complete must be passed.", "evidence.json"));
    const metricEntries = [["load", evidence.metrics?.load], ["frame", evidence.metrics?.frame], ["memory", evidence.metrics?.memory]];
    const metricPayloads = metricEntries.map(([, metric]) => metric);
    if (evidence.metrics?.status !== "passed" || evidence.metrics?.performance_no_regression !== true || metricPayloads.some((metric) => !metricPasses(metric))) issues.push(issue("METRICS_GATE", "Complete evidence needs computed numeric load, frame, and memory comparisons with explicit direction and tolerance.", "evidence.json"));
    for (const [metricId, metric] of metricEntries) {
      const receipt = await readArtifactJson(root, directory, metric?.evidence);
      if (!receipt || receipt.schema_version !== "quality-metrics.v1" || receipt.task_id !== taskId || receipt.candidate_source_commit !== evidence.candidate?.source_commit || receipt.candidate_source_sha256 !== evidence.candidate?.source_sha256 || receipt.candidate_build_sha256 !== evidence.candidate?.build_sha256 || receipt.metrics?.[metricId]?.baseline !== metric?.baseline || receipt.metrics?.[metricId]?.candidate !== metric?.candidate || receipt.metrics?.[metricId]?.unit !== metric?.unit) issues.push(issue("METRICS_ARTIFACT", `Metric evidence must be a digest-bound quality-metrics.v1 receipt matching the candidate and ${metricId} values.`, "evidence.json"));
    }
    if (!Array.isArray(evidence.numeric_hard_gates) || evidence.numeric_hard_gates.length === 0 || evidence.numeric_hard_gates.some((gate) => gate.result !== "passed" || !comparisonPasses(gate.target, gate.observed))) {
      issues.push(issue("HARD_GATE", "Every numeric hard gate must satisfy an eq/lte/gte target using a numeric observation.", "evidence.json"));
    }
    for (const gate of evidence.numeric_hard_gates ?? []) {
      const receipt = await readArtifactJson(root, directory, gate.evidence);
      const received = receipt?.gates?.[gate.id];
      if (!receipt || receipt.schema_version !== "numeric-hard-gates.v1" || receipt.task_id !== taskId || receipt.candidate_source_commit !== evidence.candidate?.source_commit || receipt.candidate_source_sha256 !== evidence.candidate?.source_sha256 || receipt.candidate_build_sha256 !== evidence.candidate?.build_sha256 || received?.observed !== gate.observed || received?.unit !== gate.target?.unit || received?.result !== "passed") issues.push(issue("HARD_GATE_ARTIFACT", `Hard-gate evidence must be a digest-bound numeric-hard-gates.v1 receipt matching the candidate and ${gate.id} observation.`, "evidence.json"));
    }
    if (evidence.human?.status !== "passed" || evidence.human?.owner_decision !== "pass" || !(evidence.human?.raw_answer_count > 0)) {
      issues.push(issue("HUMAN_GATE", "Complete evidence needs a human pass and at least one preserved raw answer.", "evidence.json"));
    }
    const humanRows = markdownTableRows(files.get("human-test.md"));
    const validHumanRows = humanRows.filter((row) => {
      const started = Date.parse(row[2] ?? "");
      const completed = Date.parse(row[3] ?? "");
      return row.length >= 8 && row.slice(0, 5).every(meaningful) && Number.isFinite(started) && Number.isFinite(completed) && completed >= started && /^pass$/i.test(row[5] ?? "") && meaningful(row[6]) && SHA256_PATTERN.test(row[7] ?? "");
    });
    if (humanRows.some((row) => /^fail$/i.test(row[5] ?? ""))) issues.push(issue("HUMAN_REJECT", "Any preserved Human Reject row blocks completion for this candidate.", "human-test.md"));
    const traceArtifacts = await Promise.all(validHumanRows.map((row) => regularArtifact(root, directory, row[6])));
    const traceRealpaths = traceArtifacts.map((artifact) => artifact.path);
    const traceArtifactsValid = validHumanRows.length === humanRows.length && traceArtifacts.every((artifact, index) => artifact.ok && artifact.sha256 === validHumanRows[index][7]) && new Set(traceRealpaths).size === traceRealpaths.length;
    const rawRefValid = await validArtifactRef(root, directory, evidence.human?.raw_answers);
    const rawArtifact = await regularArtifact(root, directory, evidence.human?.raw_answers?.path);
    const ownerArtifact = await regularArtifact(root, directory, evidence.human?.owner_evidence?.path);
    const allHumanRealpaths = [rawArtifact.path, ownerArtifact.path, ...traceRealpaths];
    const evidencePathsSeparate = rawRefValid && ownerArtifact.ok && allHumanRealpaths.every(Boolean) && new Set(allHumanRealpaths).size === allHumanRealpaths.length;
    if (humanRows.length === 0 || validHumanRows.length !== humanRows.length || !traceArtifactsValid || !rawRefValid || !evidencePathsSeparate || evidence.human?.raw_answer_count !== humanRows.length) issues.push(issue("HUMAN_RAW", "Complete evidence needs counted, timestamped raw rows plus distinct digest-bound raw, trace, and owner files.", "human-test.md"));
    if (/Status:\s*pending|Decision:\s*pending/i.test(files.get("human-test.md"))) issues.push(issue("HUMAN_RAW", "human-test.md still records a pending human result.", "human-test.md"));
    const ownerReceipt = await readArtifactJson(root, directory, evidence.human?.owner_evidence);
    if (!/Owner:\s*[^\n]+/i.test(files.get("human-test.md")) || !/Decision:\s*pass\b/i.test(files.get("human-test.md")) || !ownerReceipt || ownerReceipt.schema_version !== "human-owner-decision.v1" || ownerReceipt.task_id !== taskId || ownerReceipt.decision !== "pass" || !meaningful(ownerReceipt.owner_role) || !Number.isFinite(Date.parse(ownerReceipt.signed_at ?? "")) || ownerReceipt.candidate_source_commit !== evidence.candidate?.source_commit || ownerReceipt.candidate_source_sha256 !== evidence.candidate?.source_sha256 || ownerReceipt.candidate_build_sha256 !== evidence.candidate?.build_sha256 || ownerReceipt.raw_answer_count !== humanRows.length) issues.push(issue("HUMAN_OWNER", "Complete evidence needs a distinct digest-bound owner receipt tied to the task, candidate source/build, raw-answer count, owner role, and signed pass.", "human-test.md"));
    const candidateBuildArtifact = await regularArtifact(root, directory, evidence.candidate?.build_artifact);
    if (!isGitCommit(root, evidence.candidate?.source_commit) || !SHA256_PATTERN.test(evidence.candidate?.source_sha256 ?? "") || !SHA256_PATTERN.test(evidence.candidate?.build_sha256 ?? "") || !meaningful(evidence.candidate?.build_hash_procedure) || !candidateBuildArtifact.ok) {
      issues.push(issue("CANDIDATE_SHA256", "Complete evidence needs candidate commit, source/build SHA-256 values, a reproducible build-hash procedure, and an existing build artifact.", "evidence.json"));
    }
    if (gitArchiveSha256(root, evidence.candidate?.source_commit) !== evidence.candidate?.source_sha256) issues.push(issue("CANDIDATE_SOURCE_DIGEST", "Candidate source SHA-256 must match the exact git archive for candidate.source_commit.", "evidence.json"));
    if (candidateBuildArtifact.sha256 !== evidence.candidate?.build_sha256) issues.push(issue("CANDIDATE_BUILD_DIGEST", "Candidate build SHA-256 must match the persisted build artifact.", "evidence.json"));
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
