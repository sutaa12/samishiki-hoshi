import { describe, expect, it, vi } from "vitest";
import {
  ContractSceneFeature,
  createGfxContractResizeBinding,
  createStableGfxContractOperation,
  finalizeGfxContractRuntime,
  immutableGfxContractAggregate,
  notifyGfxContractSubscribers,
  reconcileGfxContractViewport,
  rollbackGfxContractConstruction,
} from "../../src/gfx/v2/contract-lab";

describe("GFX-002 contract lab diagnostics", () => {
  it("freezes copied aggregate evidence without collapsing repeated identities", () => {
    const first = new Error("first cleanup failure");
    const repeated = new Error("repeated cleanup failure");
    const source = [first, repeated, repeated];
    const aggregate = immutableGfxContractAggregate(source, "immutable cleanup evidence");

    source.length = 0;

    expect(aggregate.errors).toEqual([first, repeated, repeated]);
    expect(aggregate.errors[1]).toBe(repeated);
    expect(aggregate.errors[2]).toBe(repeated);
    expect(Object.isFrozen(aggregate.errors)).toBe(true);
    expect(Object.isFrozen(aggregate)).toBe(true);
    expect(() => { aggregate.errors.length = 0; }).toThrow(TypeError);
    expect(() => {
      Object.defineProperty(aggregate, "errors", { value: [] });
    }).toThrow(TypeError);
    expect(aggregate.errors).toEqual([first, repeated, repeated]);
  });

  it("retains a detach obligation when resize installation adds then throws", () => {
    const addFailure = new Error("resize listener installed before throw");
    const listeners = new Set<() => void>();
    const target = {
      addEventListener(_type: string, listener: () => void) {
        listeners.add(listener);
        throw addFailure;
      },
      removeEventListener(_type: string, listener: () => void) {
        listeners.delete(listener);
      },
    } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
    const listener = vi.fn();
    const binding = createGfxContractResizeBinding(target, listener);

    expect(() => binding.attach()).toThrow(addFailure);
    expect(binding.active).toBe(true);
    expect(listeners.size).toBe(1);
    [...listeners][0]?.();
    expect(listener).toHaveBeenCalledOnce();
    binding.detach();
    expect(binding.active).toBe(false);
    expect(listeners.size).toBe(0);
  });

  it("preserves a rollback failure occurrence equal to the construction failure", async () => {
    const sentinel = new Error("resize add and removal failed");
    const listeners = new Set<() => void>();
    const target = {
      addEventListener(_type: string, listener: () => void) {
        listeners.add(listener);
        throw sentinel;
      },
      removeEventListener() {
        throw sentinel;
      },
    } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
    const binding = createGfxContractResizeBinding(target, () => undefined);
    expect(() => binding.attach()).toThrow(sentinel);
    const host = { dispose: vi.fn(async () => { throw sentinel; }) };

    const rollbackFailures = await rollbackGfxContractConstruction(
      host,
      () => undefined,
      () => binding.detach(),
      sentinel,
    );

    expect(rollbackFailures).toEqual([sentinel]);
    expect([sentinel, ...rollbackFailures]).toEqual([sentinel, sentinel]);
    expect(binding.active).toBe(true);
    expect(listeners.size).toBe(1);
    expect(host.dispose).toHaveBeenCalledOnce();
  });

  it("revokes a retained resize callback even when DOM removal keeps failing", () => {
    const removeFailure = new Error("resize removal failed");
    const listeners = new Set<() => void>();
    const target = {
      addEventListener(_type: string, callback: () => void) {
        listeners.add(callback);
      },
      removeEventListener() {
        throw removeFailure;
      },
    } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
    const listener = vi.fn();
    const binding = createGfxContractResizeBinding(target, listener);
    binding.attach();
    const retained = [...listeners][0]!;
    retained();
    expect(listener).toHaveBeenCalledOnce();

    expect(() => binding.detach()).toThrow(removeFailure);
    expect(binding.active).toBe(true);
    retained();
    expect(listener).toHaveBeenCalledOnce();
  });


  it("defers owned geometry and material allocation until feature initialization", async () => {
    const feature = new ContractSceneFeature();
    expect(feature.snapshotEvidence()).toMatchObject({
      createdGeometries: 0,
      createdMaterials: 0,
      disposedGeometries: 0,
      disposedMaterials: 0,
    });

    await feature.initialize();
    expect(feature.snapshotEvidence()).toMatchObject({
      createdGeometries: 2,
      createdMaterials: 2,
    });
    await feature.dispose();
    expect(feature.snapshotEvidence()).toMatchObject({
      disposeStarted: true,
      disposeCompleted: true,
      disposedGeometries: 2,
      disposedMaterials: 2,
    });
  });

  it("can dispose every registered asset after a partial feature initialization", async () => {
    const allocationError = new Error("injected allocation boundary failure");
    const feature = new ContractSceneFeature((kind, count) => {
      if (kind === "geometry" && count === 1) throw allocationError;
    });

    await expect(feature.initialize()).rejects.toBe(allocationError);
    expect(feature.snapshotEvidence()).toMatchObject({
      createdGeometries: 1,
      createdMaterials: 1,
      disposedGeometries: 0,
      disposedMaterials: 0,
    });
    await feature.dispose();
    expect(feature.snapshotEvidence()).toMatchObject({
      disposeStarted: true,
      disposeCompleted: true,
      createdGeometries: 1,
      disposedGeometries: 1,
      createdMaterials: 1,
      disposedMaterials: 1,
    });
  });
  it("delivers terminal notifications after a preceding subscriber throws", () => {
    const thrower = vi.fn(() => {
      throw new Error("diagnostic subscriber failed");
    });
    const terminalSpy = vi.fn();
    const listeners = new Set([thrower, terminalSpy]);

    expect(() => notifyGfxContractSubscribers(listeners)).not.toThrow();
    expect(thrower).toHaveBeenCalledOnce();
    expect(terminalSpy).toHaveBeenCalledOnce();
  });

  it("publishes one promise before a cleanup side effect can reenter", async () => {
    let reentrant: Promise<number> | null = null;
    let calls = 0;
    const operation = createStableGfxContractOperation(async () => {
      calls += 1;
      reentrant = operation.run();
      return 42;
    });

    const first = operation.run();
    const second = operation.run();
    expect(operation.active()).toBe(true);
    expect(second).toBe(first);
    await expect(first).resolves.toBe(42);
    expect(reentrant).toBe(first);
    expect(calls).toBe(1);
  });

  it("rolls back a ready host when resize-listener installation throws", async () => {
    const addEventError = new Error("addEventListener failed");
    const host = {
      state: "ready" as const,
      dispose: vi.fn(async () => undefined),
      whenIdle: vi.fn(async () => undefined),
    };
    const unsubscribe = vi.fn();
    const detach = vi.fn();
    const addEventListener = vi.fn(() => { throw addEventError; });

    let observed: unknown = null;
    try {
      addEventListener();
    } catch (error: unknown) {
      observed = error;
      const rollbackFailures = await rollbackGfxContractConstruction(
        host,
        unsubscribe,
        detach,
      );
      expect(rollbackFailures).toEqual([]);
    }

    expect(observed).toBe(addEventError);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(host.whenIdle).not.toHaveBeenCalled();
  });

  it("preserves terminal host cleanup rejection during construction rollback", async () => {
    const cleanupError = new Error("terminal cleanup failed");
    const host = {
      state: "failed" as const,
      dispose: vi.fn(async () => { throw cleanupError; }),
      whenIdle: vi.fn(async () => undefined),
    };

    const failures = await rollbackGfxContractConstruction(
      host,
      vi.fn(),
      vi.fn(),
    );

    expect(failures).toEqual([cleanupError]);
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(host.whenIdle).not.toHaveBeenCalled();
  });

  it("retries a construction detach that fails once before releasing ownership", async () => {
    const detachError = new Error("first detach failed");
    let calls = 0;
    const detach = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw detachError;
    });
    const host = { dispose: vi.fn(async () => undefined) };

    const failures = await rollbackGfxContractConstruction(
      host,
      vi.fn(),
      detach,
    );

    expect(failures).toEqual([detachError]);
    expect(detach).toHaveBeenCalledTimes(2);
    expect(host.dispose).toHaveBeenCalledOnce();
  });

  it("reconciles a viewport change that occurred while the host initialized", async () => {
    const initial = { width: 800, height: 450, pixelRatio: 1 } as const;
    const current = { width: 960, height: 540, pixelRatio: 2 } as const;
    const resize = vi.fn(async () => undefined);

    await expect(reconcileGfxContractViewport(initial, initial, resize)).resolves.toBe(false);
    expect(resize).not.toHaveBeenCalled();
    await expect(reconcileGfxContractViewport(initial, current, resize)).resolves.toBe(true);
    expect(resize).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledWith(current);
  });

  it("continues runtime cleanup after detach failure and retries without lying about ownership", async () => {
    const detachError = new Error("removeEventListener failed");
    let detachCalls = 0;
    const detach = vi.fn(() => {
      detachCalls += 1;
      if (detachCalls === 1) throw detachError;
    });
    const unsubscribe = vi.fn();
    const host = { dispose: vi.fn(async () => undefined) };
    const listeners = new Set<() => void>();
    const finalSnapshot = vi.fn(() => {
      expect(listeners.size).toBe(0);
    });
    listeners.add(finalSnapshot);

    const failures = await finalizeGfxContractRuntime(
      host,
      unsubscribe,
      detach,
      listeners,
    );

    expect(failures).toEqual([detachError]);
    expect(detach).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(finalSnapshot).toHaveBeenCalledOnce();
  });

  it("isolates final runtime subscribers while preserving host cleanup failure", async () => {
    const cleanupError = new Error("host cleanup failed");
    const host = { dispose: vi.fn(async () => { throw cleanupError; }) };
    const unsubscribe = vi.fn();
    const detach = vi.fn();
    const thrower = vi.fn(() => { throw new Error("subscriber failed"); });
    const later = vi.fn();
    const listeners = new Set([thrower, later]);

    const failures = await finalizeGfxContractRuntime(
      host,
      unsubscribe,
      detach,
      listeners,
    );

    expect(failures).toEqual([cleanupError]);
    expect(listeners.size).toBe(0);
    expect(thrower).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledOnce();
  });
});
