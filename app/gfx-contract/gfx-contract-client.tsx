"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createGfxContractRuntime,
  type GfxContractRuntime,
  type GfxContractSnapshot,
} from "@/src/gfx/v2/contract-lab";
import type { ThreeBackendRequest } from "@/src/gfx/v2/backend/backend-adapter";
import styles from "./gfx-contract.module.css";

type ContractStatus = "initializing" | "ready" | "disposed" | "error";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localOptions(): { request: ThreeBackendRequest; qa: boolean } {
  const params = new URLSearchParams(window.location.search);
  const qa = params.get("qa") === "1"
    && ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  return {
    request: params.get("backend") === "webgl2" ? "forced-webgl2" : "webgpu-preferred",
    qa,
  };
}

function statusFrom(snapshot: GfxContractSnapshot): ContractStatus {
  if (snapshot.host.lifecycle === "ready") return "ready";
  if (snapshot.host.lifecycle === "disposed") return "disposed";
  if (snapshot.host.lifecycle === "failed") return "error";
  return "initializing";
}

export function GfxContractClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<GfxContractRuntime | null>(null);
  const unsubscribeRef = useRef<() => void>(() => undefined);
  const generationRef = useRef(1);
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<ContractStatus>("initializing");
  const [snapshot, setSnapshot] = useState<GfxContractSnapshot | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [qa, setQa] = useState(false);
  const [request, setRequest] = useState<ThreeBackendRequest>("webgpu-preferred");
  const [generation, setGeneration] = useState(1);

  const bindRuntime = useCallback(async (generation: number): Promise<void> => {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("GFX-002 contract canvas is unavailable.");
    const options = localOptions();
    const runtime = await createGfxContractRuntime({ canvas, ...options, generation });
    if (!mountedRef.current) {
      await runtime.dispose();
      return;
    }

    runtimeRef.current = runtime;
    setGeneration(generation);
    setQa(options.qa);
    setRequest(options.request);
    setFailure(null);
    let lastLifecycle = "";
    let lastPublishedFrame = -1;
    let cleanupPolling = false;
    const sync = () => {
      if (!mountedRef.current) return;
      const next = runtime.getSnapshot();
      const submitted = next.host.counters.submittedFrames;
      const lifecycleChanged = next.host.lifecycle !== lastLifecycle;
      if (!lifecycleChanged && submitted !== 0 && submitted - lastPublishedFrame < 30) return;
      lastLifecycle = next.host.lifecycle;
      lastPublishedFrame = submitted;
      setSnapshot(next);
      const nextStatus = statusFrom(next);
      setStatus(nextStatus);
      if (nextStatus === "error") {
        setFailure(next.host.error?.message ?? "Graphics contract failed closed.");
        unsubscribeRef.current();
        unsubscribeRef.current = () => undefined;
        if (!cleanupPolling) {
          cleanupPolling = true;
          void (async () => {
            for (let attempt = 0; attempt < 100; attempt += 1) {
              await new Promise((resolve) => window.setTimeout(resolve, 20));
              const settled = runtime.getSnapshot();
              if (!mountedRef.current) return;
              setSnapshot(settled);
              if (settled.backendLifecycle.state === "disposed") return;
            }
          })();
        }
      }
    };
    unsubscribeRef.current = runtime.subscribe(sync);
    sync();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void Promise.resolve()
      .then(() => bindRuntime(generationRef.current))
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setFailure(errorMessage(error));
        setStatus("error");
      });
    return () => {
      mountedRef.current = false;
      unsubscribeRef.current();
      unsubscribeRef.current = () => undefined;
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      if (runtime) void runtime.dispose();
    };
  }, [bindRuntime]);

  const disposeRuntime = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    unsubscribeRef.current();
    unsubscribeRef.current = () => undefined;
    try {
      const next = await runtime.dispose();
      setSnapshot(next);
      setStatus("disposed");
    } catch (error: unknown) {
      setFailure(errorMessage(error));
      setStatus("error");
    }
  };

  const recreateRuntime = async () => {
    const previous = runtimeRef.current;
    setStatus("initializing");
    setFailure(null);
    unsubscribeRef.current();
    unsubscribeRef.current = () => undefined;
    if (previous) await previous.dispose();
    generationRef.current += 1;
    setGeneration(generationRef.current);
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await bindRuntime(generationRef.current);
    } catch (error: unknown) {
      setFailure(errorMessage(error));
      setStatus("error");
    }
  };

  const actual = snapshot?.backendFacts.actualApi?.toLowerCase() ?? "pending";

  return (
    <main
      className={styles.shell}
      data-testid="gfx-contract"
      data-status={status}
      data-generation={snapshot?.generation ?? generation}
      data-requested-policy={request}
      data-actual-backend={actual}
      data-replay-hash={snapshot?.replayHash ?? "pending"}
    >
      <div className={styles.stage}>
        <canvas
          key={generation}
          ref={canvasRef}
          className={styles.canvas}
          data-testid="gfx-contract-canvas"
          aria-label="GFX-002 RenderHost contract verification scene"
        />
      </div>

      <section className={styles.panel} aria-labelledby="gfx-contract-title">
        <p className={styles.warning}>LOCAL LAB · NOT THE GAME · NOT PERFORMANCE ACCEPTANCE</p>
        <p className={styles.eyebrow}>R2 FOUNDATION · GFX-002</p>
        <h1 id="gfx-contract-title">RenderHost lifecycle contract</h1>
        <p className={styles.summary}>
          単一frame loop、凍結snapshot、backend事前compile、遅延error、逆順dispose、同一canvas再生成を検証する隔離面です。
        </p>

        <dl className={styles.facts}>
          <div><dt>status</dt><dd data-testid="gfx-contract-status">{status}</dd></div>
          <div><dt>generation</dt><dd>{snapshot?.generation ?? generation}</dd></div>
          <div><dt>requested</dt><dd>{request}</dd></div>
          <div><dt>actual</dt><dd data-testid="gfx-contract-actual">{actual}</dd></div>
          <div><dt>replay hash</dt><dd data-testid="gfx-contract-replay-hash">{snapshot?.replayHash ?? "pending"}</dd></div>
          <div><dt>loop starts</dt><dd>{snapshot?.frameLoop.starts ?? 0}</dd></div>
        </dl>

        {failure ? <p className={styles.failure} data-testid="gfx-contract-failure">{failure}</p> : null}

        <div className={styles.actions}>
          <button type="button" onClick={() => void disposeRuntime()}>Dispose runtime</button>
          <button type="button" onClick={() => void recreateRuntime()}>Recreate runtime</button>
          {qa ? (
            <>
              <button
                type="button"
                onClick={() => runtimeRef.current?.diagnostics.emitRendererError({
                  api: actual,
                  type: "GFX002SyntheticDiagnostic",
                  message: "GFX-002 live renderer diagnostic",
                  reason: "qa-injected",
                })}
              >
                Inject renderer failure
              </button>
              <button
                type="button"
                onClick={() => runtimeRef.current?.diagnostics.emitDeviceLost({
                  api: actual,
                  type: "GFX002SyntheticDeviceLoss",
                  message: "GFX-002 live device loss",
                  reason: "qa-injected",
                })}
              >
                Inject device loss
              </button>
            </>
          ) : null}
        </div>

        <pre className={styles.output} data-testid="gfx-contract-snapshot">
          {snapshot ? JSON.stringify(snapshot, null, 2) : "initializing"}
        </pre>
      </section>
    </main>
  );
}
