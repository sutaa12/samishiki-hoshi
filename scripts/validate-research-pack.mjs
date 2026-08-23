#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const TASK_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PIN_PATTERN = /^(?:[0-9a-f]{40}|v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const PLACEHOLDER_PATTERN = /\{\{[^}]+\}\}|REPLACE_(?:ME|WITH_[A-Z_]+)|\bTBD\b/;
const EXTERNAL_MEDIA_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpeg", ".jpg", ".m4a", ".mp3", ".mp4", ".ogg", ".png", ".wav", ".webm", ".webp"]);
const R5_EXPECTED_DESCRIPTION = "小さな水滴を左右に動かし、リングをくぐり、岩を避け、芽へ光を渡すゲーム";
const R01_MIGRATION_ASSESSMENT_SHA256 = "23125b75bc1ecdfa12bf0d9a2833829e554f0e778f3bf1195184673e97183f9f";
const R01_MIGRATION_POLICY_SHA256 = "59fd54dc9d948828e13ab4dca4cadac8e31cb7d9d9521ba08eded686b6b28e7e";
const R00_PRODUCTION_STABLE_MANIFEST_SHA256 = "03e23eeb422a8292503b43da33cdead2629be3be9774c3f351b865dba5303c25";
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
  let acceptance = "human-release";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      root = resolve(argv[index + 1] ?? "");
      index += 1;
    } else if (argument === "--stage") {
      stage = argv[index + 1] ?? "";
      index += 1;
    } else if (argument === "--acceptance") {
      acceptance = argv[index + 1] ?? "";
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
  if (!new Set(["human-release", "ai-binary"]).has(acceptance)) {
    throw new Error("Acceptance must be human-release or ai-binary.");
  }
  return { root: resolve(root), taskId, stage, acceptance };
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

function normalizedDescription(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") : "";
}

const SECURITY_CONFUSABLES = new Map(Object.entries({
  "а": "a", "е": "e", "і": "i", "ј": "j", "к": "k", "о": "o", "р": "p", "с": "c", "т": "t", "х": "x", "у": "y",
  "Α": "a", "Β": "b", "Ε": "e", "Ι": "i", "Κ": "k", "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t", "Χ": "x", "Υ": "y",
  "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ο": "o", "ρ": "p", "τ": "t", "χ": "x", "υ": "y",
}));

function securityFingerprint(value) {
  if (typeof value !== "string") return "";
  return [...value.normalize("NFKD").toLowerCase()]
    .map((character) => SECURITY_CONFUSABLES.get(character) ?? character)
    .join("")
    .replace(/[\p{P}\p{S}\p{Z}\p{Cf}\p{M}\s]+/gu, "");
}

function descriptionFingerprint(value) {
  return securityFingerprint(normalizedDescription(value));
}

function isOrderedSubsequence(needle, haystack) {
  if (!needle || !haystack) return false;
  let needleIndex = 0;
  for (const character of haystack) {
    if (character === needle[needleIndex]) needleIndex += 1;
    if (needleIndex === needle.length) return true;
  }
  return false;
}

function containsReject(value) {
  const compact = securityFingerprint(normalizedDescription(value));
  return /fail(?:ed|ure|ing)?|reject(?:ed|ion|ing)?|(?:deny|denies|denied|denial|denying)|declin(?:e|ed|ing)|refus(?:e|ed|al|ing)|veto(?:ed|ing)?|disapprov(?:e|ed|ing|al)|unsuccessful|unsatisfactory|invalid|blocked|prohibited|disallowed|aborted|cancel(?:ed|led|ing)|nogo/i.test(compact) || /拒否|拒絶|否認|不合格|不承認|不採用|未達|不可|却下|失敗/.test(compact);
}

function containsHumanFailureText(value) {
  const compact = securityFingerprint(normalizedDescription(value));
  return containsReject(value)
    || /(?:pass|passed|accept|accepted|approve|approved)(?:is|was)?false/.test(compact)
    || /(?:didnot|doesnot|donot|didnt|doesnt|dont|isnt|wasnt|werent|hasnt|havent|couldnt|wouldnt|wont|cant|not)(?:a)?(?:pass|passes|passed|passing|accept|accepts|accepted|accepting|approve|approves|approved|approving|success|successful|succeed|succeeds|succeeded|succeeding|granted)/.test(compact)
    || /notgranted/.test(compact)
    || /(?:承認|合格)(?:(?:され)?ず|(?:され)?ません(?:で|て)した|(?:され)?なかった)|未承認/.test(compact);
}

function communicatesR5Gameplay(value) {
  const text = normalizedDescription(value);
  const concepts = [
    /\b(?:droplet|drop|water|player|avatar|character|orb|bead)\b|水滴|雫|プレイヤー|自機|キャラ/iu,
    /\b(?:steer|move|moves|moving|sideways|advance|advances|travel|guide|control|dodge|veer|navigate)\b|操作|移動|左右|進む|進行|避け/iu,
    /\b(?:ring|hoop|gate|circle|arch|loop)\b|リング|輪|門|ゲート|円/iu,
    /\b(?:rock|hazard|obstacle|barrier|boulder)\b|岩|障害|壁|危険/iu,
    /\b(?:pulse|energize|energizing|energy|light|sprout|plant|node|target|charge|activate|bloom)\b|パルス|光|芽|植物|ノード|対象|生命|起動/iu,
  ];
  const latinWords = text.match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
  const hasJapanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text);
  const englishNegative = /\b(?:never|not|no|without|cannot|can't|fails?\s+to|doesn't|does\s+not|didn't|did\s+not)\b/.test(text);
  const englishActorMotion = /^(?:(?:a|an|the)\s+)?(?:(?:small|tiny|little|water|shining|blue)\s+){0,3}(?:droplet|drop|player|avatar|character|orb|bead)\b(?:\s+(?:continuously|steadily|sideways|forward|automatically|laterally)){0,3}\s+(?:(?:is|keeps?|can)\s+)?(?:steers?|steering|moves?|moving|advances?|advancing|travels?|traveling|guides?|guiding|controls?|controlling|veers?|veering|navigates?|navigating)\b/;
  const englishWrongActor = /\b(?:rock|ring|hoop|gate|hazard|obstacle|barrier|boulder|plant|sprout|node|target|pulse|light)\b\s+(?:(?:it|then|also)\s+)?(?:steers?|moves?|advances?|travels?|guides?|controls?|dodges?|veers?|navigates?|clears?|avoids?|energizes?|pulses?|passes?|activates?|charges?|sends?)\b/;
  const englishRing = /(?:\b(?:steers?|steering|moves?|moving|advances?|advancing|travels?|traveling|navigates?|navigating|goes?|going)\b(?:\s+(?:continuously|steadily|sideways|forward|automatically|laterally))*\s+through\s+(?:(?:a|an|the)\s+)?(?:[a-z]+\s+){0,2}(?:ring|hoop|gate|circle|arch|loop)\b|\b(?:clears?|clearing)\b\s+(?:(?:a|an|the)\s+)?(?:[a-z]+\s+){0,2}(?:ring|hoop|gate|circle|arch|loop)\b)/;
  const englishObstacle = /\b(?:avoids?|avoiding|dodges?|dodging|veers?\s+(?:around|past)|steers?\s+(?:around|past))\b[^,;.!?]{0,28}\b(?:rock|hazard|obstacle|barrier|boulder)\b/;
  const englishPulse = /(?:\b(?:energizes?|energizing|pulses?|pulsing|activates?|activating|charges?|charging)\b[^,;.!?]{0,28}\b(?:sprout|plant|node|target)\b|\b(?:sends?|sending|passes?|passing|delivers?|delivering)\b[^,;.!?]{0,12}\b(?:light|energy|pulse)\b\s+(?:into|to|toward|towards)\s+(?:(?:a|an|the)\s+)?(?:[a-z]+\s+){0,2}(?:sprout|plant|node|target)\b)/;
  const englishRingMatch = englishRing.exec(text);
  const englishObstacleMatch = englishObstacle.exec(text);
  const englishPulseMatch = englishPulse.exec(text);
  const englishActorMotionMatch = englishActorMotion.exec(text);
  const englishConnector = /^[\s,]*(?:(?:and|then|before|after)[\s,]*)?$/;
  const englishActorToRingConnector = /^[\s,]*(?:(?:sideways|forward|continuously|steadily|laterally)[\s,]*)?(?:(?:and|then)[\s,]*)?$/;
  const englishRelationsValid = Boolean(englishActorMotionMatch && englishRingMatch && englishObstacleMatch && englishPulseMatch)
    && englishRingMatch.index < englishObstacleMatch.index
    && englishObstacleMatch.index < englishPulseMatch.index
    && (englishRingMatch.index <= englishActorMotionMatch.index + englishActorMotionMatch[0].length
      || englishActorToRingConnector.test(text.slice(englishActorMotionMatch.index + englishActorMotionMatch[0].length, englishRingMatch.index)))
    && englishConnector.test(text.slice(englishRingMatch.index + englishRingMatch[0].length, englishObstacleMatch.index))
    && englishConnector.test(text.slice(englishObstacleMatch.index + englishObstacleMatch[0].length, englishPulseMatch.index))
    && /^[.!?]+$/.test(text.slice(englishPulseMatch.index + englishPulseMatch[0].length));
  const japaneseNegative = /ない|なかった|なければ|ず|ぬ|ません|できな|不能|失敗/.test(text);
  const japaneseActorMotion = /^(?:(?:この|小さな|ちいさな|青い|光る))*(?:水滴|雫|プレイヤー|自機|キャラ)(?:が|は|を)?(?:(?![がは]).){0,20}?(?:動か|移動|進|操作|操縦)/;
  const japaneseWrongActor = /(?:岩|リング|輪|門|ゲート|障害|壁|植物|芽|ノード|対象|パルス|光)(?:が|は).{0,10}(?:動|移動|進|操作|避け|くぐ|通|渡|送|起動)/;
  const japaneseRing = /(?:リング|輪|門|ゲート|円)を?(?:くぐ|通|抜け)/;
  const japaneseObstacle = /(?:岩|障害|壁|危険)を?(?:避け|かわし)/;
  const japanesePulse = /(?:芽|植物|ノード|対象)(?:へ|に)(?:光|パルス|生命)を?(?:渡(?:す|し)?|送(?:る|り)?(?:起動)?|届け(?:る)?|当て(?:る)?|光らせ(?:る)?|起動(?:する)?|照ら(?:す|し)?)/;
  const japaneseActorMotionMatch = japaneseActorMotion.exec(text);
  const japaneseRingMatch = japaneseRing.exec(text);
  const japaneseObstacleMatch = japaneseObstacle.exec(text);
  const japanesePulseMatch = japanesePulse.exec(text);
  const japaneseConnector = /^[\s、,]*(?:(?:り|て|し|して|そして|次に|その後)[\s、,]*)?$/;
  const japaneseRelationsValid = Boolean(japaneseActorMotionMatch && japaneseRingMatch && japaneseObstacleMatch && japanesePulseMatch)
    && japaneseRingMatch.index < japaneseObstacleMatch.index
    && japaneseObstacleMatch.index < japanesePulseMatch.index
    && japaneseConnector.test(text.slice(japaneseActorMotionMatch.index + japaneseActorMotionMatch[0].length, japaneseRingMatch.index))
    && japaneseConnector.test(text.slice(japaneseRingMatch.index + japaneseRingMatch[0].length, japaneseObstacleMatch.index))
    && japaneseConnector.test(text.slice(japaneseObstacleMatch.index + japaneseObstacleMatch[0].length, japanesePulseMatch.index))
    && /^(?:(?:遊び|ゲーム)です|ます|します)?[。！？]$/.test(text.slice(japanesePulseMatch.index + japanesePulseMatch[0].length));
  const japaneseSubjectSwap = Boolean(japaneseActorMotionMatch && japanesePulseMatch
    && /[がはもで]/.test(text.slice(japaneseActorMotionMatch.index + japaneseActorMotionMatch[0].length, japanesePulseMatch.index + japanesePulseMatch[0].length)));
  const sentenceLike = hasJapanese
    ? text.length >= 20 && /[。！？]$/.test(text) && /を|へ|から|して|ながら|あと|後|前|次|そして|つぎ/.test(text) && !japaneseNegative && !japaneseWrongActor.test(text) && !japaneseSubjectSwap && japaneseRelationsValid
    : latinWords.length >= 10 && /[.!?]$/.test(text) && /\b(?:through|before|after|then|toward|towards|while|into|until|and)\b/.test(text) && !englishNegative && !englishWrongActor.test(text) && englishRelationsValid;
  return concepts.filter((pattern) => pattern.test(text)).length >= 4 && sentenceLike;
}

function valueContainsReject(value) {
  if (typeof value === "string") return containsReject(value);
  if (Array.isArray(value)) return value.some(valueContainsReject);
  if (value && typeof value === "object") return Object.values(value).some(valueContainsReject);
  return false;
}

function hasHumanReject(human) {
  const normalizedScalar = (value) => typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : value;
  const isPositive = (value) => {
    const normalized = normalizedScalar(value);
    return normalized === true || normalized === "true" || normalized === "yes" || normalized === "on" || (Number.isFinite(Number(normalized)) && Number(normalized) > 0);
  };
  const isNegative = (value) => {
    const normalized = normalizedScalar(value);
    return normalized === false || normalized === 0 || normalized === "false" || normalized === "no" || normalized === "off" || normalized === "0";
  };
  const successKeyPattern = /(?:pass|accept|approve|approval|success|successful|合格|承認)/;
  const visit = (value, inheritedFailureKey = false, inheritedSuccessKey = false) => {
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) => {
      const normalizedKey = descriptionFingerprint(key);
      const failureKey = inheritedFailureKey || containsReject(normalizedKey);
      const successKey = inheritedSuccessKey || successKeyPattern.test(normalizedKey);
      if (failureKey && isPositive(child)) return true;
      if (successKey && isNegative(child)) return true;
      return child && typeof child === "object" ? visit(child, failureKey, successKey) : false;
    });
  };
  const containsFailureString = (value) => {
    if (typeof value === "string") return containsHumanFailureText(value);
    if (Array.isArray(value)) return value.some(containsFailureString);
    if (value && typeof value === "object") return Object.values(value).some(containsFailureString);
    return false;
  };
  return containsFailureString(human) || visit(human);
}

function containsHumanFailureArtifact(value) {
  if (containsHumanFailureText(value)) return true;
  if (typeof value !== "string") return false;
  try {
    return hasHumanReject(JSON.parse(value));
  } catch {
    return false;
  }
}

function declaresHumanContext(value) {
  if (!value || typeof value !== "object") return false;
  const descriptorKey = /(?:label|labels|type|types|kind|kinds|category|categories|scope|scopes|subject|subjects|role|roles|reviewer|reviewers|descriptor|descriptors|audience|audiences)$/;
  const metadataKey = /^(?:metadata|meta|context|descriptor|descriptors|classification|reviewmetadata|auditmetadata)$/;
  const entries = Object.entries(value);
  const containsHumanMarker = (child) => {
    if (typeof child === "string") return descriptionFingerprint(child).includes("human");
    if (Array.isArray(child)) return child.some(containsHumanMarker);
    if (child && typeof child === "object") return Object.values(child).some(containsHumanMarker);
    return false;
  };
  if (entries.some(([key, child]) => descriptorKey.test(descriptionFingerprint(key)) && containsHumanMarker(child))) return true;
  return entries.some(([key, child]) => metadataKey.test(descriptionFingerprint(key)) && child && typeof child === "object" && declaresHumanContext(child));
}

function hasHumanRejectAnywhere(value) {
  const visit = (current, inheritedHumanContext = false, depth = 0) => {
    if (!current || typeof current !== "object") return false;
    const entries = Object.entries(current);
    const labeledHuman = inheritedHumanContext || declaresHumanContext(current);
    if (labeledHuman && hasHumanReject(current)) return true;
    return entries.some(([key, child]) => {
      const normalizedKey = descriptionFingerprint(key);
      if (depth === 0 && key === "baseline") return false;
      const childHumanContext = labeledHuman || normalizedKey.includes("human");
      if (child && typeof child === "object") return visit(child, childHumanContext, depth + 1);
      return childHumanContext && hasHumanReject({ [key]: child });
    });
  };
  return visit(value);
}

function humanArtifactReferences(value) {
  const references = [];
  const visit = (current, inheritedHumanContext = false, depth = 0) => {
    if (!current || typeof current !== "object") return;
    const entries = Object.entries(current);
    const labeledHuman = inheritedHumanContext || declaresHumanContext(current);
    if (labeledHuman && meaningful(current.path) && SHA256_PATTERN.test(current.sha256 ?? "")) references.push(current);
    for (const [key, child] of entries) {
      const normalizedKey = descriptionFingerprint(key);
      if (depth === 0 && key === "baseline") continue;
      if (child && typeof child === "object") visit(child, labeledHuman || normalizedKey.includes("human"), depth + 1);
    }
  };
  visit(value);
  return [...new Map(references.map((reference) => [`${reference.path}|${reference.sha256}`, reference])).values()];
}

function probeMovingVideo(path) {
  if (!path) return { ok: false, reason: "missing path" };
  const probe = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-count_frames",
    "-show_entries", "stream=codec_type,width,height,nb_read_frames:format=duration",
    "-of", "json",
    path,
  ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (probe.status !== 0) return { ok: false, reason: "ffprobe failed" };
  let payload;
  try {
    payload = JSON.parse(probe.stdout);
  } catch {
    return { ok: false, reason: "ffprobe returned invalid JSON" };
  }
  const stream = payload.streams?.[0];
  const durationMs = Number(payload.format?.duration) * 1000;
  const decodedFrames = Number(stream?.nb_read_frames);
  if (stream?.codec_type !== "video"
    || !Number.isInteger(stream.width) || stream.width <= 0
    || !Number.isInteger(stream.height) || stream.height <= 0
    || !Number.isFinite(durationMs) || durationMs < 15000
    || !Number.isInteger(decodedFrames) || decodedFrames < 2) {
    return { ok: false, reason: "video metadata is incomplete or shorter than 15 seconds" };
  }
  const frameProbe = spawnSync("ffmpeg", [
    "-nostdin", "-v", "error", "-i", path,
    "-map", "0:v:0", "-vf", "fps=10", "-f", "framemd5", "-",
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (frameProbe.status !== 0) return { ok: false, reason: "video frames could not be decoded" };
  const sampledHashes = frameProbe.stdout
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1)?.trim())
    .filter(Boolean);
  let longestIdenticalRun = 0;
  let currentIdenticalRun = 0;
  let changedTransitions = 0;
  for (let index = 0; index < sampledHashes.length; index += 1) {
    if (index === 0 || sampledHashes[index] !== sampledHashes[index - 1]) {
      if (index > 0) changedTransitions += 1;
      currentIdenticalRun = 1;
    } else {
      currentIdenticalRun += 1;
    }
    longestIdenticalRun = Math.max(longestIdenticalRun, currentIdenticalRun);
  }
  const transitionRatio = sampledHashes.length > 1 ? changedTransitions / (sampledHashes.length - 1) : 0;
  const differenceProbe = spawnSync("ffmpeg", [
    "-nostdin", "-v", "info", "-i", path,
    "-map", "0:v:0", "-vf", "fps=10,tblend=all_mode=difference,signalstats,metadata=print", "-f", "null", "-",
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (differenceProbe.status !== 0) return { ok: false, reason: "video motion could not be measured" };
  const differenceOutput = `${differenceProbe.stdout}\n${differenceProbe.stderr}`;
  const yAverage = [...differenceOutput.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map((match) => Number(match[1]));
  const yMinimum = [...differenceOutput.matchAll(/lavfi\.signalstats\.YMIN=([0-9.]+)/g)].map((match) => Number(match[1]));
  const yMaximum = [...differenceOutput.matchAll(/lavfi\.signalstats\.YMAX=([0-9.]+)/g)].map((match) => Number(match[1]));
  const spatialRanges = yMinimum.map((minimum, index) => yMaximum[index] - minimum).filter(Number.isFinite);
  const median = (values) => {
    const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  };
  const activeDifferenceRatio = yAverage.length ? yAverage.filter((value) => value >= 1).length / yAverage.length : 0;
  const nativeDifferenceProbe = spawnSync("ffmpeg", [
    "-nostdin", "-v", "info", "-i", path,
    "-map", "0:v:0", "-vf", "tblend=all_mode=difference,signalstats,metadata=print", "-f", "null", "-",
  ], { encoding: "utf8", maxBuffer: 24 * 1024 * 1024 });
  if (nativeDifferenceProbe.status !== 0) return { ok: false, reason: "native-frame motion could not be measured" };
  const nativeDifferenceOutput = `${nativeDifferenceProbe.stdout}\n${nativeDifferenceProbe.stderr}`;
  const nativeYAverage = [...nativeDifferenceOutput.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map((match) => Number(match[1]));
  const nativeYMinimum = [...nativeDifferenceOutput.matchAll(/lavfi\.signalstats\.YMIN=([0-9.]+)/g)].map((match) => Number(match[1]));
  const nativeYMaximum = [...nativeDifferenceOutput.matchAll(/lavfi\.signalstats\.YMAX=([0-9.]+)/g)].map((match) => Number(match[1]));
  const nativeSpatialRanges = nativeYMinimum.map((minimum, index) => nativeYMaximum[index] - minimum).filter(Number.isFinite);
  const nativeActiveDifferenceRatio = nativeYAverage.length ? nativeYAverage.filter((value) => value >= 0.25).length / nativeYAverage.length : 0;
  const sceneProbe = spawnSync("ffmpeg", [
    "-nostdin", "-v", "info", "-i", path,
    "-map", "0:v:0", "-vf", "fps=10,select='gt(scene,0.3)',showinfo", "-f", "null", "-",
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (sceneProbe.status !== 0) return { ok: false, reason: "video scene continuity could not be measured" };
  const sceneCuts = (`${sceneProbe.stdout}\n${sceneProbe.stderr}`.match(/Parsed_showinfo[^\n]*\bn:\s*\d+/g) ?? []).length;
  return {
    ok: sampledHashes.length >= 149
      && new Set(sampledHashes).size >= 120
      && longestIdenticalRun <= 5
      && transitionRatio >= 0.8
      && yAverage.length >= 149
      && median(yAverage) >= 1
      && median(spatialRanges) >= 8
      && activeDifferenceRatio >= 0.8
      && nativeYAverage.length >= decodedFrames - 2
      && nativeActiveDifferenceRatio >= 0.8
      && median(nativeSpatialRanges) >= 16
      && sceneCuts <= 2,
    durationMs,
    decodedFrames,
    sampledFrames: sampledHashes.length,
    distinctSampledFrames: new Set(sampledHashes).size,
    longestIdenticalRun,
    transitionRatio,
    medianLumaDifference: median(yAverage),
    medianSpatialDifferenceRange: median(spatialRanges),
    activeDifferenceRatio,
    nativeMedianLumaDifference: median(nativeYAverage),
    nativeMedianSpatialDifferenceRange: median(nativeSpatialRanges),
    nativeActiveDifferenceRatio,
    sceneCuts,
  };
}

function textSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueNonempty(rows, field) {
  const values = rows.map((row) => row[field]?.trim().toLowerCase()).filter(Boolean);
  return values.length === rows.length && new Set(values).size === values.length;
}

function normalizedDistinct(...values) {
  const normalized = values.map((value) => value?.trim().toLowerCase()).filter(Boolean);
  return normalized.length === values.length && new Set(normalized).size === values.length;
}

function hasExactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...keys].toSorted()));
}

async function manifestMatchesArchive(root, directory, manifestReference, archiveReference, requireExactFileSet = true) {
  const manifest = await regularArtifact(root, directory, manifestReference);
  const archive = await regularArtifact(root, directory, archiveReference?.path);
  if (!manifest.ok || !archive.ok || archive.sha256 !== archiveReference?.sha256) return false;
  const lines = (await readFile(manifest.path, "utf8")).trim().split("\n");
  const entries = lines.map((line) => /^([0-9a-f]{64})\s{2}\.\/([^/].*)$/.exec(line));
  if (entries.length === 0 || entries.some((entry) => !entry || entry[2].split("/").some((segment) => !segment || segment === "." || segment === ".."))) return false;
  const listed = spawnSync("tar", ["-tzf", archive.path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (listed.status !== 0) return false;
  const archiveFiles = listed.stdout.split("\n").filter((path) => path && !path.endsWith("/"));
  const expectedFiles = entries.map((entry) => `dist/${entry[2]}`);
  if (archiveFiles.some((path) => !path.startsWith("dist/") || path.split("/").some((segment) => segment === ".."))) return false;
  if (requireExactFileSet && JSON.stringify([...archiveFiles].sort()) !== JSON.stringify([...expectedFiles].sort())) return false;
  if (!requireExactFileSet && expectedFiles.some((path) => !archiveFiles.includes(path))) return false;
  const extractionRoot = await mkdtemp(join(tmpdir(), "lonely-star-build-verify-"));
  try {
    const extracted = spawnSync("tar", ["-xzf", archive.path, "-C", extractionRoot], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (extracted.status !== 0) return false;
    const artifacts = await Promise.all(entries.map((entry) => regularArtifact(extractionRoot, extractionRoot, `dist/${entry[2]}`)));
    return artifacts.every((artifact, index) => artifact.ok && artifact.sha256 === entries[index][1])
      && new Set(artifacts.map((artifact) => artifact.identity)).size === artifacts.length;
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

function validLargePlayerOccupancy(value) {
  const match = /^x(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?) y(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?); height (\d+(?:\.\d+)?)%; area (\d+(?:\.\d+)?)%$/i.exec(value ?? "");
  if (!match) return false;
  const [xMin, xMax, yMin, yMax, height, area] = match.slice(1).map(Number);
  return [xMin, xMax, yMin, yMax, height, area].every(Number.isFinite)
    && xMin >= 0 && xMax <= 100 && xMin < xMax
    && yMin >= 0 && yMax <= 100 && yMin < yMax
    && height > 0 && height <= 100 && area > 0 && area <= 100;
}

function validPercentPoint(value) {
  const match = /^(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/.exec(value ?? "");
  return Boolean(match && match.slice(1).map(Number).every((number) => number >= 0 && number <= 100));
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
  const segments = artifact.split("/");
  if (isAbsolute(artifact) || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const path = resolve(artifact.includes("/") ? root : packDirectory, artifact);
  const rootPath = resolve(root);
  const within = relative(rootPath, path);
  return within && !within.startsWith("..") && !isAbsolute(within) ? path : null;
}

async function regularArtifact(root, packDirectory, artifact) {
  const path = artifactPath(root, packDirectory, artifact);
  if (!path) return { ok: false, reason: "path is missing or outside the repository", path: null, sha256: null };
  try {
    const rootPath = resolve(root);
    const lexicalWithin = relative(rootPath, path);
    let componentPath = rootPath;
    for (const component of lexicalWithin.split("/")) {
      componentPath = resolve(componentPath, component);
      if ((await lstat(componentPath)).isSymbolicLink()) return { ok: false, reason: "path contains a symbolic-link component", path, sha256: null };
    }
    const lexical = await lstat(path);
    if (lexical.isSymbolicLink() || !lexical.isFile()) return { ok: false, reason: "path is not a regular non-symlink file", path, sha256: null };
    const resolvedPath = await realpath(path);
    const resolvedRootPath = await realpath(root);
    const within = relative(resolvedRootPath, resolvedPath);
    if (!within || within.startsWith("..") || isAbsolute(within) || !(await stat(resolvedPath)).isFile()) return { ok: false, reason: "resolved path is outside the repository or not a regular file", path, sha256: null };
    return { ok: true, reason: null, path: resolvedPath, identity: `${lexical.dev}:${lexical.ino}`, size: lexical.size, sha256: createHash("sha256").update(await readFile(resolvedPath)).digest("hex") };
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

async function readArtifactText(root, packDirectory, reference) {
  if (!(await validArtifactRef(root, packDirectory, reference))) return null;
  const artifact = await regularArtifact(root, packDirectory, reference.path);
  try {
    return await readFile(artifact.path, "utf8");
  } catch {
    return null;
  }
}

async function mediaFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await mediaFiles(path));
    else if (entry.isFile() && EXTERNAL_MEDIA_EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(path);
  }
  return found;
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

const AI_REVIEW_BOOLEAN_FIELDS = [
  "playerIdentified",
  "continuousForwardMotion",
  "ringActionUnderstood",
  "obstacleActionUnderstood",
  "pulseTargetUnderstood",
  "resultUnderstood",
  "progressUnderstood",
];

const AI_REMEDIATION_ROUTES = {
  motion: {
    failed_answer: "continuousForwardMotion",
    first_fix: ["near_object_speed", "ttc", "z_motion", "fov", "ground_marks"],
    prohibited_first: ["bloom", "fog", "background_detail"],
  },
  player: {
    failed_answer: "playerIdentified",
    first_fix: ["screen_size", "position", "silhouette", "local_contrast"],
    prohibited_first: ["strong_player_glow"],
  },
  objective: {
    failed_answer: "ringActionUnderstood|obstacleActionUnderstood",
    first_fix: ["one_objective_per_screen", "target_shape", "short_verb_ui"],
    prohibited_first: ["long_explanation"],
  },
  pulse: {
    failed_answer: "pulseTargetUnderstood|resultUnderstood",
    first_fix: ["light_path", "node_deformation", "local_ecology", "progress"],
    prohibited_first: ["full_screen_flash"],
  },
  progress: {
    failed_answer: "progressUnderstood",
    first_fix: ["encounter_completion", "landmark_approach", "one_third_progress"],
    prohibited_first: ["time_only_scene_change"],
  },
};

async function validateResearchOnlyAiClosure(root, directory, taskId, evidence, issues) {
  const closure = await readArtifactJson(root, directory, evidence.research_only_ai_closure);
  const migrationPolicy = closure ? await readArtifactJson(root, directory, closure.migration_policy) : null;
  const reviewText = closure ? await readArtifactText(root, directory, closure.independent_review) : null;
  const researchValidation = await readArtifactJson(root, directory, evidence.research_validation);
  const normalizedReviewText = (reviewText ?? "").normalize("NFKC").replace(/\p{Cf}+/gu, "").replace(/[*_~`]+/g, "");
  const reviewScore = /\bScore\s*:\s*(\d+)\/32\b/i.exec(normalizedReviewText);
  const reviewVerdicts = normalizedReviewText.match(/\bVerdict\s*:\s*(?:ACCEPT|REJECT)\b/gim) ?? [];
  const reviewScores = normalizedReviewText.match(/\bScore\s*:\s*\d+\/32\b/gim) ?? [];
  const contradictorySeverity = /(?:open\s*)?S\s*[0-2](?:\s*findings?)?\s*[:=]?\s*[1-9]\d*\b/i.test(normalizedReviewText)
    || /^#{1,6}\s*S\s*[0-2]\b/im.test(normalizedReviewText)
    || /\bS\s*[0-2]\s+(?:blocker|finding)\b/i.test(normalizedReviewText);
  const expectedGateStates = new Map([
    ["QX-R4-R01 research-only ledger", "research-only-ai-accepted"],
    ["Production gameplay improvement", "NOT_CLAIMED"],
    ["Human acceptance", "PENDING"],
    ["Owner release decision", "PENDING"],
    ["Legal acceptance", "PENDING"],
    ["Main integration", "PENDING"],
    ["Sites publication and health", "PENDING"],
    ["Contest submission or acceptance", "PENDING"],
    ["Next executable task", "QX-R5-001"],
  ]);
  const reviewTableRows = (reviewText ?? "").split("\n")
    .filter((line) => line.trim().startsWith("|") && !/^\|\s*-/.test(line.trim()))
    .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.replaceAll("`", "").trim()));
  const gateStatesValid = [...expectedGateStates].every(([gate, expected]) => {
    const matching = reviewTableRows.filter((row) => row[0] === gate);
    return matching.length === 1 && matching[0][1] === expected;
  });
  const forbiddenClaim = /release\s*[_ -]?ready\s*[:=]\s*true|production\s*[_ -]?improvement\s*[_ -]?claimed\s*[:=]\s*true/i.test(normalizedReviewText);
  const reviewSecurityText = securityFingerprint(reviewText);
  const contradictoryClaim = /(?:humanacceptance|ownerreleasedecision|legalacceptance|mainintegration|sitespublicationandhealth|contestsubmissionoracceptance)(?:is|status)?(?:passed|complete)/.test(reviewSecurityText)
    || /(?:aiacceptance|migrationacceptance|review)(?:is)?pass(?:ed)?false/.test(reviewSecurityText);
  const buildArchiveValid = closure ? await manifestMatchesArchive(root, directory, evidence.candidate?.build_artifact, closure.build_archive) : false;
  const stableManifest = await regularArtifact(root, directory, ".quality-gates/QX-R4-R00/production-stable-assets.sha256");
  const stableProductionValid = Boolean(closure
    && stableManifest.ok
    && stableManifest.sha256 === R00_PRODUCTION_STABLE_MANIFEST_SHA256
    && await manifestMatchesArchive(root, directory, ".quality-gates/QX-R4-R00/production-stable-assets.sha256", closure.build_archive, false));
  const migrationPolicyValid = Boolean(closure && migrationPolicy
    && hasExactKeys(migrationPolicy, ["schema_version", "task_id", "allowed_result", "production_improvement_claimed", "human_gate_required", "baseline_source_commit", "baseline_source_sha256", "baseline_build_sha256", "build_archive_sha256", "stable_manifest_sha256", "historical_review_sha256", "minimum_score", "maximum_score", "maximum_open_s0_s2", "next_task", "external_gates"])
    && closure.migration_policy?.path === ".quality-gates/QX-R4-R01/migration-policy.json"
    && closure.migration_policy?.sha256 === R01_MIGRATION_POLICY_SHA256
    && migrationPolicy.schema_version === "r5-r01-migration-policy.v1"
    && migrationPolicy.task_id === taskId
    && migrationPolicy.allowed_result === closure.result
    && migrationPolicy.production_improvement_claimed === closure.production_improvement_claimed
    && migrationPolicy.human_gate_required === closure.human_gate_required
    && migrationPolicy.baseline_source_commit === closure.baseline_source_commit
    && migrationPolicy.baseline_source_sha256 === closure.baseline_source_sha256
    && migrationPolicy.baseline_build_sha256 === closure.baseline_build_sha256
    && migrationPolicy.build_archive_sha256 === closure.build_archive?.sha256
    && migrationPolicy.stable_manifest_sha256 === R00_PRODUCTION_STABLE_MANIFEST_SHA256
    && migrationPolicy.historical_review_sha256 === closure.historical_research_review?.sha256
    && migrationPolicy.minimum_score === 28
    && migrationPolicy.maximum_score === 32
    && migrationPolicy.maximum_open_s0_s2 === 0
    && migrationPolicy.next_task === closure.next_task
    && JSON.stringify(migrationPolicy.external_gates) === JSON.stringify(["Human", "Owner", "Legal", "Main", "Sites", "Contest"]));
  const migrationSubjectBound = Boolean(closure && reviewText
    && closure.independent_review?.path === ".quality-gates/QX-R4-R01/r5-migration-assessment.md"
    && closure.historical_research_review?.path === ".quality-gates/QX-R4-R01/independent-review-round4.md"
    && reviewText.includes("Subject task: `QX-R4-R01`")
    && reviewText.includes("Target classification: `research-only-ai-accepted`")
    && reviewText.includes(`Runtime source commit | \`${closure.baseline_source_commit}\``)
    && reviewText.includes(`Runtime source SHA-256 | \`${closure.baseline_source_sha256}\``)
    && reviewText.includes(`Subject build SHA-256 | \`${closure.baseline_build_sha256}\``)
    && reviewText.includes(`Preserved build archive | \`${closure.build_archive?.sha256}\``)
    && reviewText.includes(`Research-validation artifact | \`${closure.research_validation_sha256}\``)
    && reviewText.includes(`Historical round-4 review artifact | \`${closure.historical_research_review?.sha256}\``)
    && reviewText.includes(`Reviewed migration-policy artifact | \`${closure.migration_policy?.sha256}\``)
    && gateStatesValid);
  const acceptedReview = reviewVerdicts.length === 1
    && reviewScores.length === 1
    && /\bVerdict\s*:\s*ACCEPT\b/i.test(reviewVerdicts[0])
    && /research stage only/i.test(normalizedReviewText)
    && Number(reviewScore?.[1]) >= 28
    && Number(reviewScore?.[1]) <= 32
    && /Reviewer severities\s*:\s*S0\s+0,\s*S1\s+0,\s*S2\s+0\b/i.test(normalizedReviewText)
    && !contradictorySeverity
    && !containsReject(reviewText)
    && !forbiddenClaim
    && !contradictoryClaim
    && !/must not be marked complete|HUMAN_PENDING/i.test(normalizedReviewText);
  if (!closure
    || taskId !== "QX-R4-R01"
    || evidence.gates?.complete !== "research-only-ai-accepted"
    || !hasExactKeys(closure, ["schema_version", "task_id", "result", "recorded_at", "issuer", "policy_source", "production_improvement_claimed", "human_gate_required", "baseline_source_commit", "baseline_source_sha256", "baseline_build_sha256", "build_archive", "research_validation_sha256", "automated_review_result", "automated_review_score", "automated_review_open_s0_s2", "migration_policy", "independent_review", "historical_research_review", "withdrawn_gate", "retained_boundary", "next_task", "rollback_condition"])
    || closure.schema_version !== "research-only-ai-closure.v1"
    || closure.task_id !== taskId
    || closure.result !== "research-only-ai-accepted"
    || closure.production_improvement_claimed !== false
    || closure.human_gate_required !== false
    || !Number.isFinite(Date.parse(closure.recorded_at ?? ""))
    || closure.baseline_source_commit !== evidence.baseline?.source_commit
    || closure.baseline_source_sha256 !== evidence.baseline?.source_sha256
    || closure.baseline_build_sha256 !== evidence.baseline?.build_sha256
    || closure.research_validation_sha256 !== evidence.research_validation?.sha256
    || closure.automated_review_result !== "accepted-research-stage-only"
    || closure.automated_review_score !== `${reviewScore?.[1]}/32`
    || closure.automated_review_open_s0_s2 !== 0
    || !(await validArtifactRef(root, directory, closure.migration_policy))
    || !migrationPolicyValid
    || !(await validArtifactRef(root, directory, closure.independent_review))
    || closure.independent_review?.sha256 !== R01_MIGRATION_ASSESSMENT_SHA256
    || !(await validArtifactRef(root, directory, closure.historical_research_review))
    || closure.historical_research_review?.path !== researchValidation?.independent_review_artifact?.path
    || closure.historical_research_review?.sha256 !== researchValidation?.independent_review_artifact?.sha256
    || !buildArchiveValid
    || !stableProductionValid
    || !acceptedReview
    || !migrationSubjectBound
    || closure.next_task !== "QX-R5-001"
    || !/cannot prove.*Gameplay quality.*Human acceptance.*legal acceptance.*release readiness.*contest acceptance/i.test(closure.retained_boundary ?? "")
    || !hasExactKeys(evidence.candidate, ["kind", "source_commit", "source_sha256", "build_sha256", "build_artifact", "build_hash_procedure", "screenshot", "clip", "input_trace", "capture_receipt", "build_command_receipt", "branch", "worktree"])
    || evidence.candidate?.kind !== "research-only-no-runtime-change"
    || evidence.candidate?.source_commit !== evidence.baseline?.source_commit
    || evidence.candidate?.source_sha256 !== evidence.baseline?.source_sha256
    || evidence.candidate?.build_sha256 !== evidence.baseline?.build_sha256
    || evidence.candidate?.build_artifact !== evidence.baseline?.build_artifact
    || !isGitCommit(root, evidence.candidate?.source_commit)
    || gitArchiveSha256(root, evidence.candidate?.source_commit) !== evidence.candidate?.source_sha256) {
    issues.push(issue("RESEARCH_ONLY_AI_CLOSURE", "Only QX-R4-R01 may use the research-only AI migration, and it needs a digest-bound ACCEPT review scoring >=28/32 with zero S0-S2, no Production-improvement claim, no Human requirement, matching baseline source/build/research validation, and QX-R5-001 as the next task.", "evidence.json"));
  }
}

async function validateAiBinaryGameplay(root, directory, taskId, evidence, issues) {
  const ai = evidence.ai_binary_gameplay;
  const buildManifest = await regularArtifact(root, directory, evidence.candidate?.build_artifact);
  let buildEntries = [];
  let buildLinesValid = false;
  if (buildManifest.ok && buildManifest.sha256 === evidence.candidate?.build_sha256) {
    const buildText = await readFile(buildManifest.path, "utf8");
    const parsedEntries = buildText.trim().split("\n").map((line) => /^([0-9a-f]{64})\s{2}(.+)$/.exec(line));
    buildLinesValid = parsedEntries.length > 0 && parsedEntries.every(Boolean);
    buildEntries = parsedEntries.filter(Boolean);
  }
  const builtArtifacts = await Promise.all(buildEntries.map((match) => regularArtifact(root, directory, match[2])));
  if (!buildManifest.ok
    || buildManifest.sha256 !== evidence.candidate?.build_sha256
    || !buildLinesValid
    || buildEntries.length === 0
    || builtArtifacts.some((artifact, index) => !artifact.ok || artifact.sha256 !== buildEntries[index][1])
    || new Set(builtArtifacts.map((artifact) => artifact.identity)).size !== builtArtifacts.length) {
    issues.push(issue("AI_BUILD_MANIFEST", "AI Binary completion needs a digest-bound build manifest whose SHA-256 entries recompute against distinct physical build files.", "evidence.json"));
  }
  const videoArtifact = await regularArtifact(root, directory, ai?.video?.path);
  const videoProbe = videoArtifact.ok ? probeMovingVideo(videoArtifact.path) : { ok: false };
  if (!ai || !videoArtifact.ok || !(videoArtifact.size > 0) || !videoProbe.ok || !SHA256_PATTERN.test(ai.video?.sha256 ?? "") || videoArtifact.sha256 !== ai.video.sha256 || ai.video.path !== evidence.candidate?.clip?.path || ai.video.sha256 !== evidence.candidate?.clip?.sha256) {
    issues.push(issue("AI_VIDEO", "AI Binary completion needs a digest-bound, decodable video of at least 15 seconds with actual moving frames, identical to the candidate capture clip.", "evidence.json"));
  }

  const expectedAnswerSha256 = ai?.expected_answer_sha256;
  const canonicalExpectedAnswerSha256 = textSha256(normalizedDescription(R5_EXPECTED_DESCRIPTION));
  if (expectedAnswerSha256 !== canonicalExpectedAnswerSha256) {
    issues.push(issue("AI_REVIEW_DESCRIPTION", "AI Binary evidence must use the canonical Page 19 expected-answer SHA-256 so copied descriptions fail closed.", "evidence.json"));
  }

  const telemetry = await readArtifactJson(root, directory, ai?.telemetry);
  const distanceTrace = Array.isArray(telemetry?.distance_trace) ? telemetry.distance_trace : [];
  const expectedFrameIntervalMs = telemetry?.duration_ms / telemetry?.frame_count;
  const distanceTraceValid = distanceTrace.length === telemetry?.frame_count
    && telemetry?.frame_count === videoProbe.decodedFrames
    && distanceTrace.every((sample, index) => Number.isInteger(sample?.frame) && sample.frame === index
      && Number.isFinite(sample?.at_ms) && sample.at_ms >= 0 && sample.at_ms <= telemetry.duration_ms
      && Math.abs(sample.at_ms - index * expectedFrameIntervalMs) <= 1
      && Number.isFinite(sample?.distance_mm)
      && (index === 0 || sample.at_ms > distanceTrace[index - 1].at_ms)
      && (index === 0 || sample.distance_mm > distanceTrace[index - 1].distance_mm))
    && distanceTrace[0]?.at_ms <= 50
    && telemetry?.duration_ms - distanceTrace.at(-1)?.at_ms <= 50;
  const ringProbe = telemetry?.ring_probe;
  const ringProbeValid = Number.isFinite(ringProbe?.before_area_px2) && ringProbe.before_area_px2 > 0
    && Number.isFinite(ringProbe?.after_area_px2) && ringProbe.after_area_px2 >= ringProbe.before_area_px2 * 4
    && Number.isFinite(ringProbe?.started_at_ms) && ringProbe.started_at_ms >= 0
    && Number.isFinite(ringProbe?.completed_at_ms) && ringProbe.completed_at_ms >= ringProbe.started_at_ms
    && ringProbe.completed_at_ms - ringProbe.started_at_ms <= 2500
    && ringProbe.completed_at_ms <= telemetry?.duration_ms;
  const steerProbe = telemetry?.steer_probe;
  const steerLatencyMs = steerProbe?.response_at_ms - steerProbe?.input_at_ms;
  const steerDisplacementRatio = Math.abs(steerProbe?.end_x_px - steerProbe?.start_x_px) / steerProbe?.viewport_width_px;
  const steerProbeValid = Number.isFinite(steerProbe?.input_at_ms) && steerProbe.input_at_ms >= 0
    && Number.isFinite(steerProbe?.response_at_ms) && steerLatencyMs >= 0 && steerLatencyMs <= 100
    && Number.isFinite(steerProbe?.completed_at_ms) && steerProbe.completed_at_ms >= steerProbe.response_at_ms
    && steerProbe.completed_at_ms - steerProbe.input_at_ms <= 300
    && Number.isFinite(steerProbe?.viewport_width_px) && steerProbe.viewport_width_px > 0
    && Number.isFinite(steerProbe?.start_x_px) && Number.isFinite(steerProbe?.response_x_px) && Number.isFinite(steerProbe?.end_x_px)
    && [steerProbe.start_x_px, steerProbe.response_x_px, steerProbe.end_x_px].every((x) => x >= 0 && x <= steerProbe.viewport_width_px)
    && Math.abs(steerProbe.response_x_px - steerProbe.start_x_px) >= 12
    && steerDisplacementRatio >= 0.1
    && steerProbe.completed_at_ms <= telemetry?.duration_ms;
  if (!telemetry
    || !hasExactKeys(telemetry, ["schema_version", "task_id", "result", "subject_source_sha256", "subject_build_sha256", "subject_video_sha256", "recorded_at", "frame_count", "duration_ms", "distance_increases_every_frame", "distance_trace", "max_still_frame_ms", "input_response_ms", "ring_probe", "steer_probe", "encounter_order"])
    || distanceTrace.some((sample) => !hasExactKeys(sample, ["frame", "at_ms", "distance_mm"]))
    || !hasExactKeys(ringProbe, ["before_area_px2", "after_area_px2", "started_at_ms", "completed_at_ms"])
    || !hasExactKeys(steerProbe, ["input_at_ms", "response_at_ms", "completed_at_ms", "start_x_px", "response_x_px", "end_x_px", "viewport_width_px"])
    || valueContainsReject(telemetry)
    || telemetry.schema_version !== "ai-binary-telemetry.v1"
    || telemetry.task_id !== taskId
    || telemetry.result !== "passed"
    || telemetry.subject_source_sha256 !== evidence.candidate?.source_sha256
    || telemetry.subject_build_sha256 !== evidence.candidate?.build_sha256
    || telemetry.subject_video_sha256 !== ai?.video?.sha256
    || !Number.isFinite(Date.parse(telemetry.recorded_at ?? ""))
    || !Number.isInteger(telemetry.frame_count)
    || telemetry.frame_count <= 0
    || !Number.isFinite(telemetry.duration_ms)
    || telemetry.duration_ms < 15000
    || !videoProbe.ok
    || Math.abs(telemetry.duration_ms - videoProbe.durationMs) > 250
    || telemetry.distance_increases_every_frame !== true
    || !distanceTraceValid
    || !Number.isFinite(telemetry.max_still_frame_ms)
    || telemetry.max_still_frame_ms < 0
    || telemetry.max_still_frame_ms > 500
    || !Number.isFinite(telemetry.input_response_ms)
    || telemetry.input_response_ms < 0
    || telemetry.input_response_ms > 100
    || Math.abs(telemetry.input_response_ms - steerLatencyMs) > 0.001
    || !ringProbeValid
    || !steerProbeValid
    || JSON.stringify(telemetry.encounter_order) !== JSON.stringify(["ring", "obstacle", "node"])) {
    issues.push(issue("AI_TELEMETRY", "AI Binary completion needs source/build/video-bound telemetry for every decoded frame, monotonic distance across the full clip, >=4x Ring area within 2.5s, >=12px movement within a 0-100ms response, >=10%-viewport steering within 300ms, a 0-500ms still interval, and ring/obstacle/node order.", "evidence.json"));
  }

  const ledger = await readArtifactJson(root, directory, ai?.event_ledger);
  const eventClasses = (ledger?.events ?? []).map((event) => event?.event_class);
  const eventTimes = (ledger?.events ?? []).map((event) => event?.at_ms);
  const ringEventIndex = eventClasses.indexOf("ring_success");
  const rockEventIndex = eventClasses.findIndex((eventClass) => eventClass === "rock_avoid" || eventClass === "rock_contact");
  const nodeEventIndex = eventClasses.indexOf("node_pulse");
  const progressEventIndex = eventClasses.indexOf("progress_update");
  const eventOrderValid = ringEventIndex >= 0
    && rockEventIndex > ringEventIndex
    && nodeEventIndex > rockEventIndex
    && progressEventIndex > nodeEventIndex;
  if (!ledger
    || !hasExactKeys(ledger, ["schema_version", "task_id", "result", "subject_source_sha256", "subject_build_sha256", "subject_video_sha256", "recorded_at", "events"])
    || ledger.schema_version !== "ai-binary-event-ledger.v1"
    || ledger.task_id !== taskId
    || ledger.result !== "passed"
    || ledger.subject_source_sha256 !== evidence.candidate?.source_sha256
    || ledger.subject_build_sha256 !== evidence.candidate?.build_sha256
    || ledger.subject_video_sha256 !== ai?.video?.sha256
    || !Number.isFinite(Date.parse(ledger.recorded_at ?? ""))
    || !Array.isArray(ledger.events)
    || ledger.events.length !== 4
    || ledger.events.some((event) => !hasExactKeys(event, ["event_class", "at_ms"]))
    || valueContainsReject(ledger.events)
    || eventTimes.some((time) => !Number.isFinite(time))
    || eventTimes.some((time) => time < 0 || time > telemetry?.duration_ms)
    || eventTimes.some((time, index) => index > 0 && time <= eventTimes[index - 1])
    || !eventOrderValid) {
    issues.push(issue("AI_EVENT_LEDGER", "AI Binary completion needs a source/build/video-bound chronological ledger of ring_success, rock_avoid or rock_contact, node_pulse, then progress_update.", "evidence.json"));
  }

  const reviewRefs = Array.isArray(ai?.reviews) ? ai.reviews : [];
  const reviewArtifacts = await Promise.all(reviewRefs.map((reference) => regularArtifact(root, directory, reference?.path)));
  const reviews = await Promise.all(reviewRefs.map((reference) => readArtifactJson(root, directory, reference)));
  if (reviewRefs.length !== 3 || reviewArtifacts.some((artifact) => !artifact.ok) || new Set(reviewArtifacts.map((artifact) => artifact.identity)).size !== 3) {
    issues.push(issue("AI_REVIEW_COUNT", "AI Binary completion needs exactly three distinct digest-bound review artifacts.", "evidence.json"));
  }
  const reviewerIds = reviews.map((review) => descriptionFingerprint(review?.reviewer_id));
  if (reviews.some((review, index) => !meaningful(review?.reviewer_id) || reviewerIds[index].length === 0) || new Set(reviewerIds).size !== 3) {
    issues.push(issue("AI_REVIEW_ID", "AI Binary reviews need three different nonempty Reviewer IDs.", "evidence.json"));
  }
  if (reviews.some((review) => !review
    || !hasExactKeys(review, ["schema_version", "task_id", "reviewer_id", "pass", "subject_source_sha256", "subject_build_sha256", "subject_video_sha256", "isolation", "reviewed_at", "answers", "plain_description"])
    || !hasExactKeys(review.answers, AI_REVIEW_BOOLEAN_FIELDS)
    || review.schema_version !== "ai-binary-review.v1"
    || review.task_id !== taskId
    || review.subject_source_sha256 !== evidence.candidate?.source_sha256
    || review.subject_build_sha256 !== evidence.candidate?.build_sha256
    || review.subject_video_sha256 !== ai?.video?.sha256
    || review.isolation !== "artifact-only-blind"
    || !Number.isFinite(Date.parse(review.reviewed_at ?? "")))) {
    issues.push(issue("AI_REVIEW_BINDING", "Every AI review must bind the same task/source/build/video and record artifact-only blindness plus a valid review time.", "evidence.json"));
  }
  if (reviews.some((review) => review?.pass !== true || valueContainsReject(review) || AI_REVIEW_BOOLEAN_FIELDS.some((field) => review?.answers?.[field] !== true))) {
    issues.push(issue("AI_REVIEW_FAIL", "Every AI review and every required binary comprehension answer must pass.", "evidence.json"));
  }
  const descriptions = reviews.map((review) => normalizedDescription(review?.plain_description));
  const descriptionFingerprints = reviews.map((review) => descriptionFingerprint(review?.plain_description));
  const expectedDescriptionFingerprint = descriptionFingerprint(R5_EXPECTED_DESCRIPTION);
  if (descriptions.some((description) => !meaningful(description) || description.length < 12)
    || descriptionFingerprints.some((fingerprint) => fingerprint.length < 8)
    || reviews.some((review) => !communicatesR5Gameplay(review?.plain_description))
    || new Set(descriptionFingerprints).size !== 3
    || descriptions.some((description) => textSha256(description) === expectedAnswerSha256)
    || descriptionFingerprints.some((fingerprint) => fingerprint.includes(expectedDescriptionFingerprint) || isOrderedSubsequence(expectedDescriptionFingerprint, fingerprint))) {
    issues.push(issue("AI_REVIEW_DESCRIPTION", "AI review descriptions must be nonempty, mutually distinct, and not a copy of the expected answer.", "evidence.json"));
  }

  const remediation = await readArtifactJson(root, directory, ai?.remediation);
  const remediationRoutesMatch = JSON.stringify(remediation?.remediation_map) === JSON.stringify(AI_REMEDIATION_ROUTES);
  const remediationObservationCharacters = new Set(normalizedDescription(remediation?.observations).replace(/[\p{P}\p{S}\p{Z}\s]+/gu, ""));
  if (!remediation
    || !hasExactKeys(remediation, ["schema_version", "task_id", "subject_source_sha256", "subject_build_sha256", "subject_video_sha256", "recorded_at", "decision", "observations", "remediation_map", "review_ids"])
    || remediation.schema_version !== "ai-binary-remediation.v1"
    || remediation.task_id !== taskId
    || remediation.subject_source_sha256 !== evidence.candidate?.source_sha256
    || remediation.subject_build_sha256 !== evidence.candidate?.build_sha256
    || remediation.subject_video_sha256 !== ai?.video?.sha256
    || !Number.isFinite(Date.parse(remediation.recorded_at ?? ""))
    || remediation.decision !== "accept"
    || !meaningful(remediation.observations)
    || remediation.observations !== "All three independent reviews passed; preserve the canonical Page 19 remediation routes for any later failure."
    || remediationObservationCharacters.size < 12
    || !remediation.remediation_map
    || typeof remediation.remediation_map !== "object"
    || !remediationRoutesMatch
    || !Array.isArray(remediation.review_ids)
    || remediation.review_ids.length !== 3
    || new Set(remediation.review_ids.map(descriptionFingerprint)).size !== 3
    || reviewerIds.some((reviewerId) => !remediation.review_ids.map(descriptionFingerprint).includes(reviewerId))) {
    issues.push(issue("AI_REMEDIATION", "AI Binary completion needs a source/build/video-bound remediation decision covering the same three Reviewer IDs and the exact Page 19 first-fix/prohibited-first routing map.", "evidence.json"));
  }
}

export async function validateResearchPack(root, taskId, stage = "research", acceptance = "human-release") {
  const directory = resolve(root, "docs/research", taskId);
  const issues = [];
  const files = new Map();

  if (acceptance === "ai-binary" && taskId !== "QX-R4-R01" && !/^QX-R5-00[1-7]$/.test(taskId)) {
    issues.push(issue("AI_ACCEPTANCE_SCOPE", "AI Binary acceptance is restricted to QX-R5-001 through QX-R5-007, plus the dedicated QX-R4-R01 research-only migration.", "evidence.json"));
  }

  const requiredFiles = acceptance === "ai-binary" ? REQUIRED_FILES.filter((file) => file !== "human-test.md") : REQUIRED_FILES;
  for (const file of requiredFiles) {
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
  if (acceptance === "ai-binary" && !files.has("human-test.md")) {
    const optionalHuman = await regularArtifact(root, directory, "human-test.md");
    if (optionalHuman.ok) {
      const optionalHumanText = await readFile(optionalHuman.path, "utf8");
      if (optionalHumanText.trim()) files.set("human-test.md", optionalHumanText);
    } else if (!/ENOENT|no such file/i.test(optionalHuman.reason ?? "")) {
      issues.push(issue("PACK_FILE_TYPE", "Optional human-test.md must be a repository-contained regular non-symlink file when present.", "human-test.md"));
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
    for (const field of ["Game", "Source", "SourceKind", "OfficialEvidenceID", "Publisher", "Observed", "Inference", "PlayerHeightPct", "PlayerAreaPct", "VanishingPointX", "VanishingPointY", "RouteWidthPct", "TargetTTC", "FeedbackOnsetMs", "FeedbackPeakMs", "RecoveryMs", "NearObjectsPerSecond", "TestableHypothesis", "AdoptOrReject"]) {
      if (!meaningful(row[field])) issues.push(issue("COMPARABLE_FIELD", `comparable-games.csv row ${index + 2} needs ${field}.`, "comparable-games.csv"));
    }
    if (row.SourceKind !== "Official" || !isHttpsUrl(row.Source)) issues.push(issue("COMPARABLE_OFFICIAL", `comparable-games.csv row ${index + 2} must use an HTTPS Official source.`, "comparable-games.csv"));
    const proof = primary.find((entry) => entry.ID === row.OfficialEvidenceID);
    if (!proof || canonicalUrl(proof.URL) !== canonicalUrl(row.Source) || !meaningful(proof.ObservedFact)) issues.push(issue("COMPARABLE_OFFICIAL_PROOF", `comparable-games.csv row ${index + 2} must cite a Primary evidence ID with the same canonical official URL.`, "comparable-games.csv"));
    if (!normalizedDistinct(row.Observed, row.Inference, row.TestableHypothesis)) issues.push(issue("EPISTEMIC_SEPARATION", `comparable-games.csv row ${index + 2} must keep observation, inference, and hypothesis distinct.`, "comparable-games.csv"));
    const stillOnly = /still|screenshot|hero image|official page/i.test(`${row.TimeStart ?? ""} ${row.TimeEnd ?? ""}`);
    if (stillOnly && /^\d+(?:\.\d+)?(?:\s|$)/.test(row.TargetTTC ?? "")) issues.push(issue("TIMING_PROVENANCE", `comparable-games.csv row ${index + 2} cannot infer numeric TTC from still-only evidence.`, "comparable-games.csv"));
  }
  const comparableCanonicalUrls = comparableGames.map((row) => canonicalUrl(row.Source));
  if (!uniqueNonempty(comparableGames, "Game") || comparableCanonicalUrls.some((url) => !url) || new Set(comparableCanonicalUrls).size !== comparableCanonicalUrls.length) issues.push(issue("COMPARABLE_DISTINCT", "Comparable games and canonical official source URLs must be distinct.", "comparable-games.csv"));
  for (const [index, row] of frames.entries()) {
    for (const field of ["FrameID", "Game", "Source", "SourceKind", "TimecodeOrFrame", "VanishingPoint", "RouteCorridor", "GoalLandmark", "HazardSilhouette", "DepthLayers", "LuminanceHierarchy", "MaterialIdentity", "AttentionEffect", "UISafeArea", "Observed", "Inference", "TestableHypothesis", "Rights"]) {
      if (!meaningful(row[field])) issues.push(issue("FRAME_FIELD", `frame-analysis.csv row ${index + 2} needs ${field}.`, "frame-analysis.csv"));
    }
    const playerOccupancy = row.PlayerOccupancy ?? row.PlayerBox;
    if (!meaningful(playerOccupancy)) issues.push(issue("FRAME_FIELD", `frame-analysis.csv row ${index + 2} needs PlayerOccupancy or legacy PlayerBox.`, "frame-analysis.csv"));
    if (row.SourceKind !== "Official" || !isHttpsUrl(row.Source)) issues.push(issue("FRAME_OFFICIAL", `frame-analysis.csv row ${index + 2} must use an HTTPS Official source.`, "frame-analysis.csv"));
    const comparable = comparableGames.find((entry) => entry.Game === row.Game && canonicalUrl(entry.Source) === canonicalUrl(row.Source));
    if (!comparable) issues.push(issue("FRAME_OFFICIAL_PROOF", `frame-analysis.csv row ${index + 2} must match an officially proven comparable-game source.`, "frame-analysis.csv"));
    if (!normalizedDistinct(row.Observed, row.Inference, row.TestableHypothesis)) issues.push(issue("EPISTEMIC_SEPARATION", `frame-analysis.csv row ${index + 2} must keep observation, inference, and hypothesis distinct.`, "frame-analysis.csv"));
    if (/still|screenshot|hero image/i.test(row.TimecodeOrFrame ?? "") && /\bTTC\s*(?:=|of|about|estimated)?\s*\d/i.test(row.HazardSilhouette ?? "")) issues.push(issue("TIMING_PROVENANCE", `frame-analysis.csv row ${index + 2} cannot infer numeric TTC from one still.`, "frame-analysis.csv"));
    if (scale === "large") {
      if (!validLargePlayerOccupancy(playerOccupancy)) issues.push(issue("COMPOSITION_NUMERIC", `frame-analysis.csv row ${index + 2} needs normalized PlayerOccupancy syntax and in-range values.`, "frame-analysis.csv"));
      if (!validPercentPoint(row.VanishingPoint)) issues.push(issue("COMPOSITION_NUMERIC", `frame-analysis.csv row ${index + 2} needs normalized VanishingPoint x/y percentages.`, "frame-analysis.csv"));
      if (!/(?:^|\s)(?:100|\d{1,2})(?:\.\d+)?%/.test(row.RouteCorridor ?? "")) issues.push(issue("COMPOSITION_NUMERIC", `frame-analysis.csv row ${index + 2} needs a numeric route-width percentage.`, "frame-analysis.csv"));
      if (!["near", "mid", "far"].every((layer) => new RegExp(`\\b${layer}\\b`, "i").test(row.DepthLayers ?? ""))) issues.push(issue("DEPTH_LAYERS", `frame-analysis.csv row ${index + 2} needs explicit Near, Mid, and Far layers.`, "frame-analysis.csv"));
    }
  }
  if (!uniqueNonempty(frames, "FrameID")) issues.push(issue("FRAME_DISTINCT", "Frame identifiers must be distinct.", "frame-analysis.csv"));
  const frameLocators = frames.map((row) => `${row.Game?.trim().toLowerCase()}|${canonicalUrl(row.Source)}|${row.TimecodeOrFrame?.trim().toLowerCase()}`);
  if (new Set(frameLocators).size !== frameLocators.length) issues.push(issue("FRAME_DISTINCT", "Game, source, and timecode/frame tuples must be distinct.", "frame-analysis.csv"));
  const embeddedMedia = await mediaFiles(directory);
  if (embeddedMedia.length > 0) issues.push(issue("EXTERNAL_MEDIA", `Research Pack must use external URL/timecode locators; found ${embeddedMedia.length} embedded media file(s).`, "frame-analysis.csv"));

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
  const baselineCaptureEntries = [["screenshot", evidence.baseline?.screenshot], ["clip", evidence.baseline?.clip], ["metrics", evidence.baseline?.metrics]];
  if (acceptance === "human-release") baselineCaptureEntries.push(["human findings", evidence.baseline?.human_findings]);
  const baselineCaptureArtifacts = await Promise.all(baselineCaptureEntries.map(([, reference]) => regularArtifact(root, directory, reference?.path)));
  const baselineCaptureIdentities = baselineCaptureArtifacts.map((artifact) => artifact.identity);
  if (!meaningful(evidence.baseline?.gameplay_hash) || baselineCaptureEntries.some(([, reference], index) => !SHA256_PATTERN.test(reference?.sha256 ?? "") || !baselineCaptureArtifacts[index].ok || baselineCaptureArtifacts[index].sha256 !== reference.sha256) || new Set(baselineCaptureIdentities).size !== baselineCaptureIdentities.length) issues.push(issue("BASELINE_EVIDENCE", `Baseline needs a gameplay hash plus distinct digest-bound screenshot, moving clip, metrics${acceptance === "human-release" ? ", and raw human findings" : ""} files.`, "evidence.json"));
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
  if (!Array.isArray(evidence.numeric_hard_gates) || evidence.numeric_hard_gates.length === 0 || evidence.numeric_hard_gates.some((gate) => gate.result !== "passed" || !comparisonPasses(gate.target, gate.observed))) {
    issues.push(issue("RESEARCH_HARD_GATE", "Research evidence needs at least one satisfied numeric hard gate.", "evidence.json"));
  }
  for (const gate of evidence.numeric_hard_gates ?? []) {
    if (!(await validArtifactRef(root, directory, gate.evidence))) issues.push(issue("RESEARCH_HARD_GATE_EVIDENCE", `Research hard gate ${gate.id ?? "unknown"} needs a digest-bound repository artifact.`, "evidence.json"));
  }
  if (scale === "large") {
    const researchValidation = await readArtifactJson(root, directory, evidence.research_validation);
    const baselineCaptureReceipt = await readArtifactJson(root, directory, evidence.baseline?.metrics);
    const validationRecordedAt = Date.parse(researchValidation?.recorded_at ?? "");
    const captureRecordedAt = Date.parse(baselineCaptureReceipt?.captured_at ?? "");
    if (!researchValidation
      || researchValidation.schema_version !== "automation-validation.v1"
      || researchValidation.task_id !== taskId
      || researchValidation.result !== "passed"
      || !Number.isFinite(validationRecordedAt)
      || !Number.isFinite(captureRecordedAt)
      || validationRecordedAt < captureRecordedAt
      || researchValidation.runtime_source_commit !== evidence.baseline?.source_commit
      || researchValidation.runtime_source_sha256 !== evidence.baseline?.source_sha256
      || researchValidation.subject_build_sha256 !== evidence.baseline?.build_sha256
      || !isGitCommit(root, researchValidation.research_snapshot_commit)
      || gitArchiveSha256(root, researchValidation.research_snapshot_commit) !== researchValidation.research_snapshot_source_sha256) {
      issues.push(issue("RESEARCH_VALIDATION_BINDING", "Large research needs a digest-bound automation-validation.v1 receipt recorded after its capture and matching its task, runtime source/build, and frozen research snapshot.", "evidence.json"));
    }
    const expectedCaptureIntervals = (baselineCaptureReceipt?.checkpoints ?? []).map((checkpoint) => {
      const before = checkpoint.screenshot_binding?.before;
      const after = checkpoint.screenshot_binding?.after;
      return `${checkpoint.phase}: ${before?.story_time}-${after?.story_time}s; ${before?.gameplay_hash}->${after?.gameplay_hash}`;
    });
    if (expectedCaptureIntervals.length === 0 || expectedCaptureIntervals.some((interval) => !files.get("current-baseline.md").includes(interval) || !files.get("ablation.md").includes(interval))) {
      issues.push(issue("CAPTURE_INTERVAL_SYNC", "Large research must preserve every receipt story-time/gameplay-hash interval in both current-baseline.md and ablation.md.", "ablation.md"));
    }
  }

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
  if (!new RegExp(`Rollback commit:\\s*${evidence.rollback?.commit ?? "invalid"}`).test(files.get("rollback.md"))) issues.push(issue("ROLLBACK_FILE", "rollback.md must bind the exact evidence rollback and baseline commit.", "rollback.md"));
  if (!new RegExp(`Expected source archive SHA-256:\\s*${evidence.rollback?.source_sha256 ?? "invalid"}`).test(files.get("rollback.md")) || !new RegExp(`Expected Production build SHA-256:\\s*${evidence.rollback?.build_sha256 ?? "invalid"}`).test(files.get("rollback.md"))) {
    issues.push(issue("ROLLBACK_FILE_SHA256", "rollback.md must match the rollback source and build SHA-256 values.", "rollback.md"));
  }
  if (!/Expected Sites rollback version[^:]*:\s*(?!pending\b|none\b|not applicable\b).+/i.test(files.get("rollback.md"))) issues.push(issue("ROLLBACK_SITES", "rollback.md must preserve the prior Sites version or explicit currently deployed rollback boundary.", "rollback.md"));
  if (!meaningful(evidence.rollback?.gameplay_hash) || evidence.rollback?.gameplay_hash !== evidence.baseline?.gameplay_hash || !new RegExp(`Expected gameplay hash:\\s*\`?${evidence.baseline?.gameplay_hash ?? "invalid"}\`?`).test(files.get("rollback.md"))) issues.push(issue("ROLLBACK_GAMEPLAY", "rollback.md and evidence.rollback must bind the exact accepted baseline gameplay hash.", "rollback.md"));
  if (!files.get("research-card.md").includes(`Task ID: ${taskId}`)) issues.push(issue("CARD_TASK_ID", "research-card.md Task ID must match the directory.", "research-card.md"));
  if (!files.get("current-baseline.md").includes(`Source commit: ${evidence.source_commit}`)) issues.push(issue("BASELINE_FILE_BINDING", "current-baseline.md must bind the evidence.json source commit.", "current-baseline.md"));

  if (stage === "complete") {
    const optionalHumanText = files.get("human-test.md") ?? "";
    const referencedHumanTexts = await Promise.all(humanArtifactReferences(evidence).map((reference) => readArtifactText(root, directory, reference)));
    if (hasHumanRejectAnywhere(evidence)
      || containsHumanFailureArtifact(optionalHumanText)
      || /\bHUMAN_REJECT\b/i.test(optionalHumanText)
      || referencedHumanTexts.some((text) => containsHumanFailureArtifact(text))) {
      issues.push(issue("HUMAN_REJECT", "A preserved Human Reject blocks both acceptance modes, including digest-bound Human-labeled evidence outside the canonical Human file.", "human-test.md"));
    }
    const researchOnlyAiClosure = acceptance === "ai-binary" && taskId === "QX-R4-R01";
    if (researchOnlyAiClosure) {
      await validateResearchOnlyAiClosure(root, directory, taskId, evidence, issues);
    } else {
    if (evidence.gates?.complete !== "passed") issues.push(issue("COMPLETE_GATE", "evidence.json gates.complete must be passed, or research-only-ai-accepted with a valid migration receipt in AI Binary mode.", "evidence.json"));
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
    const candidateCaptureEntries = [["screenshot", evidence.candidate?.screenshot], ["clip", evidence.candidate?.clip], ["input_trace", evidence.candidate?.input_trace]];
    const candidateCaptureArtifacts = await Promise.all(candidateCaptureEntries.map(([, reference]) => regularArtifact(root, directory, reference?.path)));
    const candidateCaptureIdentities = candidateCaptureArtifacts.map((artifact) => artifact.identity);
    const allComparisonCaptureIdentities = [...baselineCaptureIdentities, ...candidateCaptureIdentities];
    const candidateCaptureRefsValid = candidateCaptureEntries.every(([, reference], index) => SHA256_PATTERN.test(reference?.sha256 ?? "") && candidateCaptureArtifacts[index].ok && candidateCaptureArtifacts[index].sha256 === reference.sha256)
      && new Set(candidateCaptureIdentities).size === candidateCaptureIdentities.length
      && new Set(allComparisonCaptureIdentities).size === allComparisonCaptureIdentities.length;
    const captureReceipt = await readArtifactJson(root, directory, evidence.candidate?.capture_receipt);
    const captureReceiptValid = captureReceipt?.schema_version === "capture-set.v1" && captureReceipt.task_id === taskId && captureReceipt.candidate_source_commit === evidence.candidate?.source_commit && captureReceipt.candidate_source_sha256 === evidence.candidate?.source_sha256 && captureReceipt.candidate_build_sha256 === evidence.candidate?.build_sha256 && candidateCaptureEntries.every(([id, reference]) => captureReceipt.artifacts?.[id]?.path === reference?.path && captureReceipt.artifacts?.[id]?.sha256 === reference?.sha256);
    if (!candidateCaptureRefsValid || !captureReceiptValid) issues.push(issue("CANDIDATE_CAPTURE", "Complete evidence needs distinct digest-bound screenshot, moving clip, and input-trace files plus a candidate-bound capture-set.v1 receipt.", "evidence.json"));
    const buildReceipt = await readArtifactJson(root, directory, evidence.candidate?.build_command_receipt);
    if (!buildReceipt || buildReceipt.schema_version !== "build-command.v1" || buildReceipt.task_id !== taskId || buildReceipt.candidate_source_commit !== evidence.candidate?.source_commit || buildReceipt.candidate_source_sha256 !== evidence.candidate?.source_sha256 || buildReceipt.candidate_build_sha256 !== evidence.candidate?.build_sha256 || buildReceipt.command !== "npm run build" || buildReceipt.exit_code !== 0 || !Number.isFinite(Date.parse(buildReceipt.recorded_at ?? "")) || !meaningful(buildReceipt.observations)) issues.push(issue("BUILD_COMMAND", "Complete evidence needs a digest-bound successful npm run build receipt tied to the candidate source/build.", "evidence.json"));
    if (acceptance === "human-release") {
      if (evidence.human?.status !== "passed" || evidence.human?.owner_decision !== "pass" || !(evidence.human?.raw_answer_count >= 2)) {
      issues.push(issue("HUMAN_GATE", "Complete evidence needs a human pass and at least two preserved raw answers.", "evidence.json"));
      }
      const humanRows = markdownTableRows(files.get("human-test.md"));
      const validHumanRows = humanRows.filter((row) => {
        const started = Date.parse(row[2] ?? "");
        const completed = Date.parse(row[3] ?? "");
        return row.length >= 8 && row.slice(0, 5).every(meaningful) && Number.isFinite(started) && Number.isFinite(completed) && completed >= started && /^pass$/i.test(row[5] ?? "") && meaningful(row[6]) && SHA256_PATTERN.test(row[7] ?? "");
      });
      if (humanRows.some((row) => /^fail$/i.test(row[5] ?? ""))) issues.push(issue("HUMAN_REJECT", "Any preserved Human Reject row blocks completion for this candidate.", "human-test.md"));
      const traceArtifacts = await Promise.all(validHumanRows.map((row) => regularArtifact(root, directory, row[6])));
      const traceIdentities = traceArtifacts.map((artifact) => artifact.identity);
      const traceArtifactsValid = validHumanRows.length === humanRows.length && traceArtifacts.every((artifact, index) => artifact.ok && artifact.sha256 === validHumanRows[index][7]) && new Set(traceIdentities).size === traceIdentities.length;
      const rawRefValid = await validArtifactRef(root, directory, evidence.human?.raw_answers);
      const rawArtifact = await regularArtifact(root, directory, evidence.human?.raw_answers?.path);
      const ownerArtifact = await regularArtifact(root, directory, evidence.human?.owner_evidence?.path);
      const allHumanIdentities = [rawArtifact.identity, ownerArtifact.identity, ...traceIdentities];
      const evidencePathsSeparate = rawRefValid && ownerArtifact.ok && allHumanIdentities.every(Boolean) && new Set(allHumanIdentities).size === allHumanIdentities.length;
      const distinctParticipants = new Set(validHumanRows.map((row) => row[0]?.trim().toLowerCase())).size === validHumanRows.length;
      if (humanRows.length < 2 || validHumanRows.length !== humanRows.length || !distinctParticipants || !traceArtifactsValid || !rawRefValid || !evidencePathsSeparate || evidence.human?.raw_answer_count !== humanRows.length) issues.push(issue("HUMAN_RAW", "Complete evidence needs at least two distinct participants with counted, timestamped raw rows plus distinct digest-bound raw, trace, and owner files.", "human-test.md"));
      if (/Status:\s*pending|Decision:\s*pending/i.test(files.get("human-test.md"))) issues.push(issue("HUMAN_RAW", "human-test.md still records a pending human result.", "human-test.md"));
      const ownerReceipt = await readArtifactJson(root, directory, evidence.human?.owner_evidence);
      if (!/Owner:\s*[^\n]+/i.test(files.get("human-test.md")) || !/Decision:\s*pass\b/i.test(files.get("human-test.md")) || !ownerReceipt || ownerReceipt.schema_version !== "human-owner-decision.v1" || ownerReceipt.task_id !== taskId || ownerReceipt.decision !== "pass" || !meaningful(ownerReceipt.owner_role) || !Number.isFinite(Date.parse(ownerReceipt.signed_at ?? "")) || ownerReceipt.candidate_source_commit !== evidence.candidate?.source_commit || ownerReceipt.candidate_source_sha256 !== evidence.candidate?.source_sha256 || ownerReceipt.candidate_build_sha256 !== evidence.candidate?.build_sha256 || ownerReceipt.raw_answer_count !== humanRows.length) issues.push(issue("HUMAN_OWNER", "Complete evidence needs a distinct digest-bound owner receipt tied to the task, candidate source/build, raw-answer count, owner role, and signed pass.", "human-test.md"));
    } else {
      await validateAiBinaryGameplay(root, directory, taskId, evidence, issues);
    }
    const candidateBuildArtifact = await regularArtifact(root, directory, evidence.candidate?.build_artifact);
    if (!isGitCommit(root, evidence.candidate?.source_commit) || !SHA256_PATTERN.test(evidence.candidate?.source_sha256 ?? "") || !SHA256_PATTERN.test(evidence.candidate?.build_sha256 ?? "") || !meaningful(evidence.candidate?.build_hash_procedure) || !candidateBuildArtifact.ok) {
      issues.push(issue("CANDIDATE_SHA256", "Complete evidence needs candidate commit, source/build SHA-256 values, a reproducible build-hash procedure, and an existing build artifact.", "evidence.json"));
    }
    if (gitArchiveSha256(root, evidence.candidate?.source_commit) !== evidence.candidate?.source_sha256) issues.push(issue("CANDIDATE_SOURCE_DIGEST", "Candidate source SHA-256 must match the exact git archive for candidate.source_commit.", "evidence.json"));
    if (candidateBuildArtifact.sha256 !== evidence.candidate?.build_sha256) issues.push(issue("CANDIDATE_BUILD_DIGEST", "Candidate build SHA-256 must match the persisted build artifact.", "evidence.json"));
    if (/\| Candidate \|[\s\S]*\| pending \|/i.test(files.get("ablation.md"))) issues.push(issue("ABLATION", "Candidate ablation result cannot remain pending.", "ablation.md"));
    }
  }

  const counts = {
    primary: primary.length,
    github: github.length,
    community: community.length,
    comparable_games: comparableGames.length,
    frames: frames.length,
  };
  return { ok: issues.length === 0, task_id: taskId, stage, acceptance, scale, counts, issues };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { root, taskId, stage, acceptance } = parseArguments(process.argv.slice(2));
    const result = await validateResearchPack(root, taskId, stage, acceptance);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
