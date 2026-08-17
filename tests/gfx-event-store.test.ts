import { describe, expect, it, vi } from "vitest";
import { createGfxEventStore, structureGfxError } from "../src/gfx/event-store";

describe("GFX runtime event store", () => {
  it("preserves structured renderer errors and publishes events emitted after the initial snapshot", () => {
    let now = 40;
    const store = createGfxEventStore(() => now);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(store.getSnapshot()).toEqual([]);
    store.emit("renderer-error", {
      api: "WebGPU",
      type: "GPUValidationError",
      message: "late validation failure",
      reason: "qa-injected",
      diagnostic: true,
      originalEvent: new Event("uncapturederror"),
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual([
      {
        id: 1,
        occurredAtMs: 40,
        kind: "renderer-error",
        error: {
          api: "WebGPU",
          type: "GPUValidationError",
          message: "late validation failure",
          reason: "qa-injected",
          originalEventType: "Event",
          details: { diagnostic: true },
        },
      },
    ]);

    unsubscribe();
    now = 80;
    store.emit("device-lost", { api: "WebGPU", message: "device removed", reason: "unknown" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toHaveLength(2);
  });

  it("normalizes primitive errors without discarding their message", () => {
    expect(structureGfxError("plain backend failure")).toMatchObject({
      message: "plain backend failure",
      api: null,
      reason: null,
    });
  });
});
