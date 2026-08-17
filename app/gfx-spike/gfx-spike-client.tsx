"use client";

import { useEffect, useRef, useState } from "react";
import { createGfxSpike, type GfxSpikeRuntime } from "@/src/gfx/gfx-spike";
import type { GfxRequestedBackend, GfxTelemetry } from "@/src/gfx/telemetry";
import styles from "./gfx-spike.module.css";

type SpikeStatus = "initializing" | "ready" | "error";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function GfxSpikeClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<SpikeStatus>("initializing");
  const [requested, setRequested] = useState<GfxRequestedBackend>("webgpu-preferred");
  const [telemetry, setTelemetry] = useState<GfxTelemetry | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const forceWebGL = new URLSearchParams(window.location.search).get("backend") === "webgl2";
    setRequested(forceWebGL ? "forced-webgl2" : "webgpu-preferred");
    let cancelled = false;
    let runtime: GfxSpikeRuntime | null = null;

    createGfxSpike({ canvas, forceWebGL })
      .then((created) => {
        if (cancelled) {
          void created.dispose();
          return;
        }
        runtime = created;
        setTelemetry(created.telemetry);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailure(errorMessage(error));
        setStatus("error");
      });

    return () => {
      cancelled = true;
      if (runtime) void runtime.dispose();
    };
  }, []);

  const actualBackend = telemetry?.actualBackend ?? "pending";
  const tier = telemetry?.capabilityTier ?? "pending";

  return (
    <main
      className={styles.shell}
      data-testid="gfx-spike"
      data-status={status}
      data-requested-backend={requested}
      data-actual-backend={actualBackend}
      data-capability-tier={tier}
      data-tsl-material={telemetry?.tslMaterial ?? false}
      data-compile-async={telemetry?.compileAsync ?? false}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        data-testid="gfx-canvas"
        aria-label="TSLで描画するWebGPUレンダリング検証シーン"
      />

      <section className={styles.panel} aria-labelledby="gfx-spike-title">
        <p className={styles.eyebrow}>ISOLATED MEGADEMO · GFX-001</p>
        <h1 id="gfx-spike-title">WebGPU / TSL backend spike</h1>
        <p className={styles.summary}>
          ゲームのmodel・simulation・input・replayから隔離した、renderer初期化とshader事前compileの検証面です。
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

        {failure && <p className={styles.error} role="alert" data-testid="gfx-error">{failure}</p>}
        {telemetry && (
          <pre className={styles.telemetry} data-testid="gfx-telemetry">
            {JSON.stringify(telemetry, null, 2)}
          </pre>
        )}
      </section>
    </main>
  );
}
