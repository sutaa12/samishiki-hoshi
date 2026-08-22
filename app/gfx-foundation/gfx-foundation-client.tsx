"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreeBackendRequest } from "@/src/gfx/v2/backend/backend-adapter";
import {
  createGfxFoundationRuntime,
  type FoundationQualityId,
  type GfxFoundationRuntime,
  type GfxFoundationSnapshot,
} from "@/src/gfx/v2/integration/foundation-runtime";
import { RuntimeCleanupTombstone } from "@/src/gfx/v2/integration/runtime-cleanup-tombstone";
import styles from "./gfx-foundation.module.css";

type Status = "initializing" | "ready" | "disposed" | "error";

// The owner outlives a component mount, so a failed route-unmount cleanup
// remains an admission gate for every later SPA remount in this document.
const foundationRuntimeCleanupOwner = new RuntimeCleanupTombstone<GfxFoundationRuntime>();
let foundationRuntimeLifecycleTail: Promise<void> = Promise.resolve();

function options(): { request: ThreeBackendRequest; qa: boolean } {
  const params = new URLSearchParams(window.location.search);
  return {
    request: params.get("backend") === "webgpu" ? "webgpu-preferred" : "forced-webgl2",
    qa: params.get("qa") === "1" && ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname),
  };
}

function statusFrom(snapshot: Readonly<GfxFoundationSnapshot>): Status {
  if (snapshot.host.lifecycle === "ready") return "ready";
  if (snapshot.host.lifecycle === "disposed") return "disposed";
  if (snapshot.host.lifecycle === "failed") return "error";
  return "initializing";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "GFX foundation operation failed.";
}

export function GfxFoundationClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<GfxFoundationRuntime | null>(null);
  const unsubscribeRef = useRef<() => void>(() => undefined);
  const mountedRef = useRef(true);
  const bindAttemptRef = useRef(0);
  const recreateRef = useRef<Promise<void> | null>(null);
  const generationRef = useRef(1);
  const [generation, setGeneration] = useState(1);
  const [status, setStatus] = useState<Status>("initializing");
  const [snapshot, setSnapshot] = useState<Readonly<GfxFoundationSnapshot> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const drainCleanupTombstone = useCallback(async (): Promise<void> => {
    await foundationRuntimeCleanupOwner.drain();
  }, []);

  const disposeWithTombstone = useCallback(async (runtime: GfxFoundationRuntime): Promise<void> => {
    await foundationRuntimeCleanupOwner.dispose(runtime);
  }, []);

  const bindRuntime = useCallback(async (
    nextGeneration: number,
    attempt: number,
  ): Promise<void> => {
    if (!mountedRef.current || bindAttemptRef.current !== attempt) return;
    await drainCleanupTombstone();
    if (!mountedRef.current || bindAttemptRef.current !== attempt) return;
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("The GFX foundation canvas is unavailable.");
    const runtime = await createGfxFoundationRuntime({ canvas, ...options(), generation: nextGeneration });
    if (!mountedRef.current || bindAttemptRef.current !== attempt) {
      await disposeWithTombstone(runtime);
      return;
    }
    runtimeRef.current = runtime;
    setGeneration(nextGeneration);
    setFailure(null);
    let lastLifecycle = "";
    let lastFrame = -1;
    let terminalPolling = false;
    const sync = () => {
      if (!mountedRef.current) return;
      const next = runtime.getSnapshot();
      const frame = next.host.counters.submittedFrames;
      if (next.host.lifecycle === lastLifecycle && frame !== 0 && frame - lastFrame < 8) return;
      lastLifecycle = next.host.lifecycle;
      lastFrame = frame;
      setSnapshot(next);
      const nextStatus = statusFrom(next);
      setStatus(nextStatus);
      if (nextStatus === "error") {
        setFailure(next.host.error?.message ?? "Graphics foundation failed closed.");
        unsubscribeRef.current();
        unsubscribeRef.current = () => undefined;
        if (!terminalPolling) {
          terminalPolling = true;
          void (async () => {
            for (let attempt = 0; attempt < 100; attempt += 1) {
              await new Promise((resolve) => window.setTimeout(resolve, 20));
              if (!mountedRef.current) return;
              const settled = runtime.getSnapshot();
              setSnapshot(settled);
              if (settled.backendLifecycle.state === "disposed") return;
            }
          })();
        }
      }
    };
    unsubscribeRef.current = runtime.subscribe(sync);
    sync();
  }, [disposeWithTombstone, drainCleanupTombstone]);

  const scheduleBind = useCallback((nextGeneration: number, attempt: number): Promise<void> => {
    const operation = foundationRuntimeLifecycleTail
      .catch(() => undefined)
      .then(() => bindRuntime(nextGeneration, attempt));
    foundationRuntimeLifecycleTail = operation.catch(() => undefined);
    return operation;
  }, [bindRuntime]);

  useEffect(() => {
    mountedRef.current = true;
    const attempt = ++bindAttemptRef.current;
    void scheduleBind(generationRef.current, attempt).catch((error: unknown) => {
      if (!mountedRef.current || bindAttemptRef.current !== attempt) return;
      setFailure(message(error));
      setStatus("error");
    });
    return () => {
      mountedRef.current = false;
      bindAttemptRef.current += 1;
      unsubscribeRef.current();
      unsubscribeRef.current = () => undefined;
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      if (runtime) void disposeWithTombstone(runtime).catch(() => undefined);
    };
  }, [disposeWithTombstone, scheduleBind]);

  const run = async (operation: (runtime: GfxFoundationRuntime) => void | Promise<void>) => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      await operation(runtime);
      setSnapshot(runtime.getSnapshot());
    } catch (error: unknown) {
      setFailure(message(error));
      setStatus("error");
    }
  };

  const dispose = () => run(async (runtime) => {
    unsubscribeRef.current();
    unsubscribeRef.current = () => undefined;
    await runtime.dispose();
    setStatus("disposed");
  });

  const recreate = (): Promise<void> => {
    if (recreateRef.current) return recreateRef.current;
    const operation = (async () => {
      const attempt = ++bindAttemptRef.current;
      const previous = runtimeRef.current;
      setStatus("initializing");
      setFailure(null);
      unsubscribeRef.current();
      unsubscribeRef.current = () => undefined;
      if (previous) {
        await disposeWithTombstone(previous);
        if (runtimeRef.current === previous) runtimeRef.current = null;
      }
      generationRef.current += 1;
      setGeneration(generationRef.current);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await scheduleBind(generationRef.current, attempt);
    })();
    const settled = operation.finally(() => {
      if (recreateRef.current === settled) recreateRef.current = null;
    });
    recreateRef.current = settled;
    return settled;
  };

  const quality = (id: FoundationQualityId) => run((runtime) => runtime.setQuality(id));
  const actual = snapshot?.backendFacts.actualApi?.toLowerCase() ?? "pending";

  return (
    <main
      className={styles.shell}
      data-testid="gfx-foundation"
      data-status={status}
      data-generation={snapshot?.generation ?? generation}
      data-actual-backend={actual}
      data-plan-digest={snapshot?.planDigest ?? "pending"}
    >
      <div className={styles.stage}>
        <canvas
          key={generation}
          ref={canvasRef}
          className={styles.canvas}
          data-testid="gfx-foundation-canvas"
          aria-label="GFX-004 through GFX-006 streaming foundation scene"
        />
      </div>
      <section className={styles.panel} aria-labelledby="gfx-foundation-title">
        <p className={styles.warning}>INTEGRATION LAB · REAL WORKER · NOT FINAL ART</p>
        <p className={styles.eyebrow}>R2 FOUNDATION · GFX-004 / GFX-005 / GFX-006</p>
        <h1 id="gfx-foundation-title">Streaming world + Linear HDR + telemetry</h1>
        <p className={styles.summary}>
          canonical world plan を Dedicated Worker へ転送し、最大4chunkを常駐GPU poolへ1ms刻みで反映しながら600frameを計測します。
        </p>
        <dl className={styles.facts}>
          <div><dt>status</dt><dd data-testid="gfx-foundation-status">{status}</dd></div>
          <div><dt>backend</dt><dd>{actual}</dd></div>
          <div><dt>focus</dt><dd data-testid="gfx-foundation-focus">{snapshot?.chunks.focusChunkId ?? "pending"}</dd></div>
          <div><dt>active</dt><dd data-testid="gfx-foundation-active">{snapshot?.chunks.activeChunkIds.length ?? 0}</dd></div>
          <div><dt>GPU owners</dt><dd>{snapshot?.chunks.gpuOwnedCount ?? 0}</dd></div>
          <div><dt>quality</dt><dd>{snapshot?.quality.id ?? "pending"}</dd></div>
          <div><dt>program growth</dt><dd>{snapshot?.pipeline.programGrowthAfterReady ?? 0}</dd></div>
          <div><dt>pool slots</dt><dd>{snapshot?.uploader.poolSlots ?? 0}</dd></div>
          <div><dt>steady frames</dt><dd>{snapshot?.telemetry.window.steadyFrames ?? 0}</dd></div>
          <div><dt>frame P95</dt><dd>{snapshot?.telemetry.frameIntervalMs.p95?.toFixed(2) ?? "pending"}</dd></div>
          <div><dt>main P95</dt><dd>{snapshot?.telemetry.mainThreadWorkMs.p95?.toFixed(2) ?? "pending"}</dd></div>
          <div><dt>GPU P95</dt><dd>{snapshot?.telemetry.gpuTimeMs.p95?.toFixed(2) ?? "unsupported"}</dd></div>
        </dl>
        {failure ? <p className={styles.failure} data-testid="gfx-foundation-failure">{failure}</p> : null}
        <div className={styles.actions}>
          <button type="button" disabled={status !== "ready"} onClick={() => void run((runtime) => runtime.seek("S08"))}>Seek S08</button>
          <button type="button" disabled={status !== "ready"} onClick={() => void run((runtime) => runtime.seek("S21"))}>Seek S21</button>
          <button type="button" disabled={status !== "ready"} onClick={() => void run((runtime) => runtime.seek("S24"))}>Seek S24</button>
          <button type="button" disabled={status !== "ready"} onClick={() => void quality("high-temporal")}>High</button>
          <button type="button" disabled={status !== "ready"} onClick={() => void quality("low-static")}>Low</button>
          <button type="button" disabled={status !== "ready"} onClick={() => void quality("balanced-static")}>Balanced</button>
          <button type="button" disabled={status !== "ready"} onClick={() => void dispose()}>Dispose runtime</button>
          <button type="button" disabled={status === "initializing"} onClick={() => void recreate().catch((error: unknown) => {
            setFailure(message(error));
            setStatus("error");
          })}>Recreate runtime</button>
        </div>
        <pre className={styles.output} data-testid="gfx-foundation-snapshot">
          {snapshot ? JSON.stringify(snapshot, null, 2) : "initializing"}
        </pre>
      </section>
    </main>
  );
}
