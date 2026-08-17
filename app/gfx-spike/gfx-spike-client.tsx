"use client";

import { useEffect, useRef, useState } from "react";
import {
  createGfxSpike,
  type GfxDisposeSnapshot,
  type GfxLifecycleProbe,
  type GfxRuntimeSnapshot,
  type GfxSpikeRuntime,
} from "@/src/gfx/gfx-spike";
import type { GfxRequestedBackend } from "@/src/gfx/telemetry";
import styles from "./gfx-spike.module.css";

type SpikeStatus = "initializing" | "ready" | "disposed" | "error";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLocalQa(params: URLSearchParams): boolean {
  return params.get("qa") === "1"
    && ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

export function GfxSpikeClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<GfxSpikeRuntime | null>(null);
  const [status, setStatus] = useState<SpikeStatus>("initializing");
  const [requested, setRequested] = useState<GfxRequestedBackend>("webgpu-preferred");
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<GfxRuntimeSnapshot | null>(null);
  const [disposeSnapshot, setDisposeSnapshot] = useState<GfxDisposeSnapshot | null>(null);
  const [lifecycleProbe, setLifecycleProbe] = useState<GfxLifecycleProbe | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [qaMode, setQaMode] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const params = new URLSearchParams(window.location.search);
    const forceWebGL = params.get("backend") === "webgl2";
    setRequested(forceWebGL ? "forced-webgl2" : "webgpu-preferred");
    setQaMode(isLocalQa(params));
    let cancelled = false;
    let unsubscribe: () => void = () => undefined;

    createGfxSpike({ canvas, forceWebGL })
      .then((created) => {
        if (cancelled) {
          void created.dispose();
          return;
        }
        runtimeRef.current = created;
        const syncSnapshot = () => setRuntimeSnapshot(created.getSnapshot());
        unsubscribe = created.subscribe(syncSnapshot);
        syncSnapshot();
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailure(errorMessage(error));
        setStatus("error");
      });

    return () => {
      cancelled = true;
      unsubscribe();
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      if (runtime) void runtime.dispose();
    };
  }, []);

  const telemetry = runtimeSnapshot?.telemetry ?? null;
  const actualBackend = telemetry?.actualBackend ?? "pending";
  const tier = telemetry?.capabilityTier ?? "pending";

  const disposeRuntime = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const snapshot = await runtime.dispose();
    setDisposeSnapshot(snapshot);
    setLifecycleProbe(runtime.probeLifecycle());
    setStatus("disposed");
  };

  const probeRuntime = () => {
    const runtime = runtimeRef.current;
    if (runtime) setLifecycleProbe(runtime.probeLifecycle());
  };

  const injectRendererError = () => {
    runtimeRef.current?.diagnostics.emitRendererError({
      api: actualBackend === "webgpu" ? "WebGPU" : "WebGL2",
      type: "GFXSyntheticDiagnostic",
      message: "GFX-001 live renderer diagnostic",
      reason: "qa-injected",
      diagnostic: true,
    });
  };

  return (
    <main
      className={styles.shell}
      data-testid="gfx-spike"
      data-status={status}
      data-requested-backend={requested}
      data-actual-backend={actualBackend}
      data-capability-tier={tier}
      data-lab-scope={telemetry?.scope ?? "pending"}
      data-node-material-count={telemetry?.sceneEvidence.nodeMaterialCount ?? 0}
      data-precompile-completed={telemetry?.precompile.completed ?? false}
      data-webgpu-api-exposed={telemetry?.webgpuApiExposed ?? false}
      data-webgpu-adapter-probe-available={telemetry?.webgpuAdapterProbeAvailable ?? false}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        data-testid="gfx-canvas"
        aria-label="TSLで描画するWebGPUレンダリング検証シーン"
      />

      <section className={styles.panel} aria-labelledby="gfx-spike-title">
        <p className={styles.labWarning}>EXPERIMENTAL · LAB ONLY · NOT THE GAME RUNTIME</p>
        <p className={styles.eyebrow}>ISOLATED MEGADEMO · GFX-001</p>
        <h1 id="gfx-spike-title">WebGPU / TSL backend spike</h1>
        <p className={styles.summary}>
          ゲームのmodel・simulation・input・replayから隔離した、renderer初期化とshader事前compileの検証面です。
          navigatorのadapter probeはrenderer実体のidentityを保証しません。
        </p>

        <dl className={styles.statusGrid}>
          <div><dt>status</dt><dd data-testid="gfx-status">{status}</dd></div>
          <div><dt>requested</dt><dd>{requested}</dd></div>
          <div><dt>actual</dt><dd data-testid="gfx-backend">{actualBackend}</dd></div>
          <div><dt>tier</dt><dd data-testid="gfx-tier">{tier}</dd></div>
        </dl>

        <nav className={styles.switcher} aria-label="backend検証ルート">
          <a href="/gfx-spike">WebGPU preferred</a>
          <a href="/gfx-spike?backend=webgl2">Force WebGL2</a>
        </nav>

        {qaMode && (
          <section className={styles.qaPanel} aria-label="localhost QA diagnostics">
            <p>LOCAL QA DIAGNOSTICS · single runtime only · R2-G6 10-cycle gate is separate</p>
            <div>
              <button type="button" onClick={injectRendererError}>Inject renderer diagnostic</button>
              <button type="button" onClick={() => void disposeRuntime()}>Dispose runtime</button>
              <button type="button" onClick={probeRuntime}>Probe lifecycle</button>
            </div>
          </section>
        )}

        {failure && <p className={styles.error} role="alert" data-testid="gfx-error">{failure}</p>}
        {telemetry && (
          <pre className={styles.telemetry} data-testid="gfx-telemetry">
            {JSON.stringify(telemetry, null, 2)}
          </pre>
        )}
        {qaMode && (
          <>
            <pre className={styles.telemetry} data-testid="gfx-runtime-events">
              {JSON.stringify(runtimeSnapshot?.events ?? [], null, 2)}
            </pre>
            <pre className={styles.telemetry} data-testid="gfx-dispose-snapshot">
              {JSON.stringify(disposeSnapshot, null, 2)}
            </pre>
            <pre className={styles.telemetry} data-testid="gfx-lifecycle-probe">
              {JSON.stringify(lifecycleProbe ?? runtimeSnapshot?.lifecycle ?? null, null, 2)}
            </pre>
          </>
        )}
      </section>
    </main>
  );
}
