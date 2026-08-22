export type GfxRuntimeEventKind = "renderer-error" | "device-lost";

export type GfxStructuredError = {
  api: string | null;
  type: string | null;
  message: string;
  reason: string | null;
  originalEventType: string | null;
  details: Record<string, string | number | boolean | null>;
};

export type GfxRuntimeEvent = {
  id: number;
  occurredAtMs: number;
  kind: GfxRuntimeEventKind;
  error: GfxStructuredError;
};

export type GfxEventStore = {
  emit: (kind: GfxRuntimeEventKind, error: unknown) => GfxRuntimeEvent;
  getSnapshot: () => readonly GfxRuntimeEvent[];
  subscribe: (listener: () => void) => () => void;
};

const structuredKeys = new Set(["api", "type", "message", "reason", "originalEvent"]);

function recordFrom(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function constructorName(value: unknown): string | null {
  const record = recordFrom(value);
  const constructor = record?.constructor;
  if (typeof constructor !== "function") return null;
  return constructor.name || null;
}

export function structureGfxError(value: unknown): GfxStructuredError {
  const record = recordFrom(value);
  const details: Record<string, string | number | boolean | null> = {};
  if (record) {
    for (const [key, entry] of Object.entries(record)) {
      if (structuredKeys.has(key)) continue;
      if (entry === null || ["string", "number", "boolean"].includes(typeof entry)) {
        details[key] = entry as string | number | boolean | null;
      }
    }
  }

  const originalEvent = record?.originalEvent;
  const message = stringField(record, "message")
    ?? (typeof value === "string" ? value : null)
    ?? constructorName(value)
    ?? "Unknown graphics backend error";

  return {
    api: stringField(record, "api"),
    type: stringField(record, "type") ?? constructorName(value),
    message,
    reason: stringField(record, "reason"),
    originalEventType: originalEvent === undefined ? null : constructorName(originalEvent),
    details,
  };
}

export function createGfxEventStore(now: () => number = () => performance.now()): GfxEventStore {
  const events: GfxRuntimeEvent[] = [];
  const listeners = new Set<() => void>();
  let nextId = 1;

  return {
    emit(kind, error) {
      const event: GfxRuntimeEvent = {
        id: nextId,
        occurredAtMs: Number(now().toFixed(2)),
        kind,
        error: structureGfxError(error),
      };
      nextId += 1;
      events.push(event);
      listeners.forEach((listener) => listener());
      return event;
    },
    getSnapshot() {
      return events.slice();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
