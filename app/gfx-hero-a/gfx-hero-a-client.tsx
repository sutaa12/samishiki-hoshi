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
import styles from "./gfx-hero-a.module.css";

type Status = "initializing" | "ready" | "disposed" | "error";

const heroRuntimeCleanupOwner = new RuntimeCleanupTombstone<GfxFoundationRuntime>();
let heroRuntimeLifecycleTail: Promise<void> = Promise.resolve();

function launchOptions(): { request: ThreeBackendRequest; qa: boolean } {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Hero Slice A operation failed.";
}

function markerLabel(storyTime: number): string {
  if (storyTime < 18) return "12s · ABUNDANT LIFE";
  if (storyTime < 34) return "27s · THE EMPTY SEAT";
  return "37s · WATERLINE";
}

export function GfxHeroAClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<GfxFoundationRuntime | null>(null);
  const unsubscribeRef = useRef<() => void>(() => undefined);
  const mountedRef = useRef(true);
  const attemptRef = useRef(0);
  const [status, setStatus] = useState<Status>("initializing");
  const [snapshot, setSnapshot] = useState<Readonly<GfxFoundationSnapshot> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const disposeOwned = useCallback(async (runtime: GfxFoundationRuntime): Promise<void> => {
    await heroRuntimeCleanupOwner.dispose(runtime);
  }, []);

  const bind = useCallback(async (attempt: number): Promise<void> => {
    if (!mountedRef.current || attemptRef.current !== attempt) return;
    await heroRuntimeCleanupOwner.drain();
    if (!mountedRef.current || attemptRef.current !== attempt) return;
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("Hero Slice A canvas is unavailable.");
    const runtime = await createGfxFoundationRuntime({
      canvas,
      ...launchOptions(),
      generation: 1,
      experience: "hero-a",
      initialStoryTime: 12,
    });
    if (!mountedRef.current || attemptRef.current !== attempt) {
      await disposeOwned(runtime);
      return;
    }
    runtimeRef.current = runtime;
    let lastFrame = -1;
    let lastLifecycle = "";
    const sync = () => {
      if (!mountedRef.current) return;
      const next = runtime.getSnapshot();
      const frame = next.host.counters.submittedFrames;
      if (next.host.lifecycle === lastLifecycle && frame !== 0 && frame - lastFrame < 6) return;
      lastLifecycle = next.host.lifecycle;
      lastFrame = frame;
      setSnapshot(next);
      const nextStatus = statusFrom(next);
      setStatus(nextStatus);
      if (nextStatus === "error") {
        setFailure(next.host.error?.message ?? "Hero Slice A failed closed.");
      }
    };
    unsubscribeRef.current = runtime.subscribe(sync);
    sync();
  }, [disposeOwned]);

  useEffect(() => {
    mountedRef.current = true;
    const attempt = ++attemptRef.current;
    const operation = heroRuntimeLifecycleTail
      .catch(() => undefined)
      .then(() => bind(attempt));
    heroRuntimeLifecycleTail = operation.catch(() => undefined);
    void operation.catch((error: unknown) => {
      if (!mountedRef.current || attemptRef.current !== attempt) return;
      setFailure(errorMessage(error));
      setStatus("error");
    });
    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;
      unsubscribeRef.current();
      unsubscribeRef.current = () => undefined;
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      if (runtime) void disposeOwned(runtime).catch(() => undefined);
    };
  }, [bind, disposeOwned]);

  const run = async (operation: (runtime: GfxFoundationRuntime) => void | Promise<void>) => {
    const runtime = runtimeRef.current;
    if (!runtime || status !== "ready") return;
    try {
      await operation(runtime);
      setSnapshot(runtime.getSnapshot());
      setFailure(null);
    } catch (error: unknown) {
      setFailure(errorMessage(error));
      setStatus("error");
    }
  };

  const seek = (storyTime: number) => run((runtime) => runtime.seekTime(storyTime));
  const quality = (id: FoundationQualityId) => run((runtime) => runtime.setQuality(id));
  const hero = snapshot?.heroA;
  const actual = snapshot?.backendFacts.actualApi?.toLowerCase() ?? "pending";

  return (
    <main
      className={styles.shell}
      data-testid="gfx-hero-a"
      data-status={status}
      data-marker={hero?.storyTime ?? "pending"}
      data-human-visible={hero?.humanArtifactsVisible ? "true" : "false"}
      data-actual-backend={actual}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        data-testid="gfx-hero-a-canvas"
        aria-label="豊かな海底から水没した空席と水面へ続く Hero Slice A"
      />
      <header className={styles.heading}>
        <p className={styles.eyebrow}>R2-G3 · HERO SLICE A · ISOLATED REVIEW</p>
        <h1>生命に満ちた海から、<br />ひとの空席へ。</h1>
        <p className={styles.marker} data-testid="gfx-hero-a-marker">
          {hero ? markerLabel(hero.storyTime) : "INITIALIZING OCEAN"}
        </p>
      </header>
      <section className={styles.readout} aria-label="Hero Slice A evidence readout">
        <span>{actual}</span>
        <span>{hero?.qualityTier ?? "pending"}</span>
        <span>{hero?.visibleFish ?? 0} fish</span>
        <span>{hero?.visibleCoralClusters ?? 0} coral</span>
        <span>{hero?.humanArtifactsVisible ? "rectilinear trace" : "nature only"}</span>
      </section>
      <nav className={styles.controls} aria-label="Fixed replay markers">
        <button type="button" disabled={status !== "ready"} onClick={() => void seek(12)}>12s Life</button>
        <button type="button" disabled={status !== "ready"} onClick={() => void seek(27)}>27s Empty seat</button>
        <button type="button" disabled={status !== "ready"} onClick={() => void seek(37)}>37s Waterline</button>
        <button type="button" disabled={status !== "ready"} onClick={() => void quality("high-temporal")}>High</button>
        <button type="button" disabled={status !== "ready"} onClick={() => void quality("low-static")}>Fallback</button>
      </nav>
      {failure ? <p className={styles.failure} data-testid="gfx-hero-a-failure">{failure}</p> : null}
      <pre className={styles.snapshot} data-testid="gfx-hero-a-snapshot">
        {snapshot ? JSON.stringify(snapshot, null, 2) : "initializing"}
      </pre>
    </main>
  );
}
