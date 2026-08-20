export type OwnedFailureSnapshot = Readonly<{
  readonly kind: "primitive" | "object" | "cycle" | "truncated" | "uninspectable";
  readonly type: string;
  readonly value?: string | number | boolean | null;
  readonly name?: string;
  readonly message?: string;
  readonly code?: string | number;
  readonly textTruncated?: true;
  readonly cause?: OwnedFailureSnapshot;
  readonly errors?: readonly OwnedFailureSnapshot[];
}>;

type FailureEvidenceBudget = {
  remainingNodes: number;
  remainingTextUnits: number;
  limitMarkerEmitted: boolean;
};

type BoundedText = Readonly<{
  value?: string;
  truncated: boolean;
}>;

type PrimitiveField = Readonly<{
  value?: string | number;
  textTruncated: boolean;
}>;

const maximumSnapshots = 16;
const maximumNestedFailures = 4;
const maximumDepth = 3;
const maximumEvidenceNodes = 256;
const maximumRetainedTextUnits = 4_096;
const maximumTextFieldUnits = 256;
const maximumInlineBigIntMagnitude = BigInt(`1${"0".repeat(128)}`);
const evidenceBudgetMessage = "Failure evidence node budget exhausted.";

function boundedText(
  value: string,
  budget: FailureEvidenceBudget,
  prefix = "",
  suffix = "",
): BoundedText {
  const wrapperLength = prefix.length + suffix.length;
  const maximumOutputLength = Math.min(maximumTextFieldUnits, budget.remainingTextUnits);
  if (wrapperLength > maximumOutputLength) return { truncated: true };
  const maximumValueOutputLength = maximumOutputLength - wrapperLength;
  if (value.length <= maximumValueOutputLength) {
    const output = `${prefix}${value}${suffix}`;
    budget.remainingTextUnits -= output.length;
    return { value: output, truncated: false };
  }
  let retainedLength = maximumValueOutputLength;
  let truncationSuffix = "";
  for (;;) {
    truncationSuffix = `[truncated ${value.length - retainedLength} UTF-16 code units]`;
    const nextRetainedLength = Math.max(
      0,
      maximumValueOutputLength - truncationSuffix.length,
    );
    if (nextRetainedLength === retainedLength) break;
    retainedLength = nextRetainedLength;
  }
  if (truncationSuffix.length > maximumValueOutputLength) return { truncated: true };
  const output = `${prefix}${value.slice(0, retainedLength)}${truncationSuffix}${suffix}`;
  budget.remainingTextUnits -= output.length;
  return { value: output, truncated: true };
}

function takeEvidenceBudgetMarker(
  budget: FailureEvidenceBudget,
): OwnedFailureSnapshot | null {
  if (budget.limitMarkerEmitted) return null;
  budget.limitMarkerEmitted = true;
  const text = boundedText(evidenceBudgetMessage, budget);
  return Object.freeze({
    kind: "truncated",
    type: "evidence-budget",
    ...(text.value !== undefined ? { value: text.value } : {}),
    ...(text.truncated ? { textTruncated: true as const } : {}),
  });
}

function claimEvidenceNode(budget: FailureEvidenceBudget): boolean {
  if (budget.remainingNodes <= 0) return false;
  budget.remainingNodes -= 1;
  return true;
}

function fixedMarker(
  budget: FailureEvidenceBudget,
  kind: OwnedFailureSnapshot["kind"],
  type: string,
): OwnedFailureSnapshot | null {
  if (!claimEvidenceNode(budget)) return takeEvidenceBudgetMarker(budget);
  return Object.freeze({ kind, type });
}

function failureListMarker(
  budget: FailureEvidenceBudget,
  type: string,
  message: string,
): OwnedFailureSnapshot | null {
  if (!claimEvidenceNode(budget)) return takeEvidenceBudgetMarker(budget);
  const text = boundedText(message, budget);
  return Object.freeze({
    kind: "truncated",
    type,
    ...(text.value !== undefined ? { value: text.value } : {}),
    ...(text.truncated ? { textTruncated: true as const } : {}),
  });
}

function primitiveSnapshot(
  value: unknown,
  budget: FailureEvidenceBudget,
): OwnedFailureSnapshot | null {
  if (value === null) return Object.freeze({ kind: "primitive", type: "null", value: null });
  switch (typeof value) {
    case "undefined": {
      const text = boundedText("undefined", budget);
      return Object.freeze({
        kind: "primitive",
        type: "undefined",
        ...(text.value !== undefined ? { value: text.value } : {}),
        ...(text.truncated ? { textTruncated: true as const } : {}),
      });
    }
    case "string": {
      const text = boundedText(value, budget);
      return Object.freeze({
        kind: "primitive",
        type: "string",
        ...(text.value !== undefined ? { value: text.value } : {}),
        ...(text.truncated ? { textTruncated: true as const } : {}),
      });
    }
    case "boolean":
      return Object.freeze({ kind: "primitive", type: "boolean", value });
    case "number": {
      if (Number.isFinite(value)) {
        return Object.freeze({ kind: "primitive", type: "number", value });
      }
      const text = boundedText(String(value), budget);
      return Object.freeze({
        kind: "primitive",
        type: "number",
        ...(text.value !== undefined ? { value: text.value } : {}),
        ...(text.truncated ? { textTruncated: true as const } : {}),
      });
    }
    case "bigint": {
      const text = value > -maximumInlineBigIntMagnitude && value < maximumInlineBigIntMagnitude
        ? value.toString()
        : `${value < BigInt(0) ? "-" : ""}[bigint omitted beyond 128 decimal digits]`;
      const bounded = boundedText(text, budget);
      return Object.freeze({
        kind: "primitive",
        type: "bigint",
        ...(bounded.value !== undefined ? { value: bounded.value } : {}),
        ...(bounded.truncated ? { textTruncated: true as const } : {}),
      });
    }
    case "symbol": {
      const description = value.description;
      const text = description === undefined
        ? boundedText("Symbol()", budget)
        : boundedText(description, budget, "Symbol(", ")");
      return Object.freeze({
        kind: "primitive",
        type: "symbol",
        ...(text.value !== undefined ? { value: text.value } : {}),
        ...(text.truncated ? { textTruncated: true as const } : {}),
      });
    }
    default:
      return null;
  }
}

function ownPrimitive(
  record: object,
  key: string,
  budget: FailureEvidenceBudget,
): PrimitiveField {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) return { textTruncated: false };
  const value = descriptor.value;
  if (typeof value === "string") {
    const text = boundedText(value, budget);
    return {
      ...(text.value !== undefined ? { value: text.value } : {}),
      textTruncated: text.truncated,
    };
  }
  return typeof value === "number"
    ? { value, textTruncated: false }
    : { textTruncated: false };
}

function snapshotObject(
  value: object,
  budget: FailureEvidenceBudget,
  activePath: Set<object>,
  depth: number,
): OwnedFailureSnapshot {
  if (activePath.has(value)) return Object.freeze({ kind: "cycle", type: "object" });
  if (depth >= maximumDepth) return Object.freeze({ kind: "truncated", type: "object" });
  activePath.add(value);
  try {
    const name = ownPrimitive(value, "name", budget);
    const message = ownPrimitive(value, "message", budget);
    const code = ownPrimitive(value, "code", budget);
    const causeDescriptor = Object.getOwnPropertyDescriptor(value, "cause");
    const cause = causeDescriptor && "value" in causeDescriptor
      ? snapshotFailure(causeDescriptor.value, budget, activePath, depth + 1) ?? undefined
      : undefined;
    const errorsDescriptor = Object.getOwnPropertyDescriptor(value, "errors");
    let errors: readonly OwnedFailureSnapshot[] | undefined;
    if (errorsDescriptor && "value" in errorsDescriptor && Array.isArray(errorsDescriptor.value)) {
      const source = errorsDescriptor.value;
      if (activePath.has(source)) {
        const marker = fixedMarker(budget, "cycle", "failure-list");
        errors = Object.freeze(marker ? [marker] : []);
      } else {
        activePath.add(source);
        try {
          const lengthDescriptor = Object.getOwnPropertyDescriptor(source, "length");
          const sourceLength = lengthDescriptor && "value" in lengthDescriptor
            && Number.isSafeInteger(lengthDescriptor.value) && lengthDescriptor.value >= 0
            ? lengthDescriptor.value
            : 0;
          const length = Math.min(sourceLength, maximumNestedFailures);
          const nested: OwnedFailureSnapshot[] = [];
          for (let index = 0; index < length; index += 1) {
            if (budget.remainingNodes <= 0) {
              const marker = takeEvidenceBudgetMarker(budget);
              if (marker) nested.push(marker);
              break;
            }
            const entry = Object.getOwnPropertyDescriptor(source, String(index));
            if (!entry) {
              const marker = fixedMarker(budget, "uninspectable", "missing-failure-slot");
              if (marker) nested.push(marker);
              continue;
            }
            if (!("value" in entry)) {
              const marker = fixedMarker(budget, "uninspectable", "accessor-failure-slot");
              if (marker) nested.push(marker);
              continue;
            }
            const nestedSnapshot = snapshotFailure(
              entry.value,
              budget,
              activePath,
              depth + 1,
            );
            if (nestedSnapshot) nested.push(nestedSnapshot);
          }
          if (sourceLength > length && !budget.limitMarkerEmitted) {
            const marker = failureListMarker(
              budget,
              "failure-list",
              `${sourceLength - length} additional nested failures omitted`,
            );
            if (marker) nested.push(marker);
          }
          errors = Object.freeze(nested);
        } finally {
          activePath.delete(source);
        }
      }
    }
    return Object.freeze({
      kind: "object",
      type: typeof value === "function" ? "function" : "object",
      ...(typeof name.value === "string" ? { name: name.value } : {}),
      ...(typeof message.value === "string" ? { message: message.value } : {}),
      ...(code.value !== undefined ? { code: code.value } : {}),
      ...(name.textTruncated || message.textTruncated || code.textTruncated
        ? { textTruncated: true as const }
        : {}),
      ...(cause ? { cause } : {}),
      ...(errors ? { errors } : {}),
    });
  } catch {
    return Object.freeze({ kind: "uninspectable", type: "object" });
  } finally {
    activePath.delete(value);
  }
}

function snapshotFailure(
  value: unknown,
  budget: FailureEvidenceBudget,
  activePath = new Set<object>(),
  depth = 0,
): OwnedFailureSnapshot | null {
  if (!claimEvidenceNode(budget)) return takeEvidenceBudgetMarker(budget);
  const primitive = primitiveSnapshot(value, budget);
  if (primitive) return primitive;
  return snapshotObject(value as object, budget, activePath, depth);
}

export function ownedAggregateError(
  failures: readonly unknown[],
  message: string,
): AggregateError {
  const budget: FailureEvidenceBudget = {
    // Reserve the final node for the one shared limit marker.
    remainingNodes: maximumEvidenceNodes - 1,
    remainingTextUnits: maximumRetainedTextUnits,
    limitMarkerEmitted: false,
  };
  const boundedMessage = boundedText(message, budget).value ?? "";
  const lengthDescriptor = Object.getOwnPropertyDescriptor(failures, "length");
  const failureCount = lengthDescriptor && "value" in lengthDescriptor
    && Number.isSafeInteger(lengthDescriptor.value) && lengthDescriptor.value >= 0
    ? lengthDescriptor.value
    : 0;
  const retainedLength = Math.min(
    failureCount,
    failureCount > maximumSnapshots ? maximumSnapshots - 1 : maximumSnapshots,
  );
  const mutableSnapshots: OwnedFailureSnapshot[] = [];
  for (let index = 0; index < retainedLength; index += 1) {
    if (budget.remainingNodes <= 0) {
      const marker = takeEvidenceBudgetMarker(budget);
      if (marker) mutableSnapshots.push(marker);
      break;
    }
    const entry = Object.getOwnPropertyDescriptor(failures, String(index));
    if (!entry) {
      const marker = fixedMarker(budget, "uninspectable", "missing-failure-slot");
      if (marker) mutableSnapshots.push(marker);
      continue;
    }
    if (!("value" in entry)) {
      const marker = fixedMarker(budget, "uninspectable", "accessor-failure-slot");
      if (marker) mutableSnapshots.push(marker);
      continue;
    }
    const snapshot = snapshotFailure(entry.value, budget);
    if (snapshot) mutableSnapshots.push(snapshot);
  }
  if (failureCount > retainedLength && !budget.limitMarkerEmitted) {
    const marker = failureListMarker(
      budget,
      "failure-list",
      `${failureCount - retainedLength} additional failures omitted`,
    );
    if (marker) mutableSnapshots.push(marker);
  }
  const snapshots = Object.freeze(mutableSnapshots);
  const aggregate = new AggregateError(snapshots, boundedMessage);
  Reflect.deleteProperty(aggregate, "stack");
  Object.freeze(aggregate.errors);
  return Object.freeze(aggregate);
}
