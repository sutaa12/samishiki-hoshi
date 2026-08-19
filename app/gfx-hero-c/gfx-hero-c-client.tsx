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
import styles from "./gfx-hero-c.module.css";

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
  return error instanceof Error ? error.message : "Hero Slice C operation failed.";
}

function markerLabel(storyTime: number): string {
  if (storyTime < 155) return "142s · HUMAN DEBRIS";
  if (storyTime < 161) return "158s · THREE PERIPHERAL ARCS";
  if (storyTime < 171) return "166s · THE ANSWER";
  if (storyTime < 178) return "176s · LIVING LIGHTS";
  return "179s · FINAL TITLE";
}

export function GfxHeroCClient() {
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
    if (!canvas) throw new Error("Hero Slice C canvas is unavailable.");
    const runtime = await createGfxFoundationRuntime({
      canvas,
      ...launchOptions(),
      generation: 1,
      experience: "hero-c",
      initialStoryTime: 142,
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
        setFailure(next.host.error?.message ?? "Hero Slice C failed closed.");
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
  const hero = snapshot?.heroC;
  const actual = snapshot?.backendFacts.actualApi?.toLowerCase() ?? "pending";
  const titleVisible = hero?.formalTitleVisible ?? false;

  return (
    <main
      className={styles.shell}
      data-testid="gfx-hero-c"
      data-status={status}
      data-marker={hero?.storyTime ?? "pending"}
      data-ship-visible={hero?.unknownShipVisible ? "true" : "false"}
      data-title-visible={titleVisible ? "true" : "false"}
      data-actual-backend={actual}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        data-testid="gfx-hero-c-canvas"
        aria-label="矩形の人類宇宙船片から三枚の曲線リボン船と地球の生命光へ続く Hero Slice C"
      />
      {titleVisible ? (
        <h1 className={styles.finalTitle} data-testid="gfx-hero-c-title" aria-label="さみしき星のまたたきよ">
          <span>さみしき星の</span>
          <span>またたきよ</span>
        </h1>
      ) : (
        <>
          <header className={styles.heading}>
            <p className={styles.eyebrow}>R2-G5 · HERO SLICE C · ISOLATED REVIEW</p>
            <h1>残された箱の先に、<br />三つの曲線が応える。</h1>
            <p className={styles.marker} data-testid="gfx-hero-c-marker">
              {hero ? markerLabel(hero.storyTime) : "INITIALIZING DEEP SPACE"}
            </p>
          </header>
          <section className={styles.readout} aria-label="Hero Slice C evidence readout">
            <span>{actual}</span>
            <span>{hero?.qualityTier ?? "pending"}</span>
            <span>{hero?.humanDebrisForms ?? 0} human forms</span>
            <span>{hero?.alienRibbonShellCount ?? 0} ribbon shells</span>
            <span>{hero?.visibleTwinkles ?? 0} life lights</span>
          </section>
          <nav className={styles.controls} aria-label="Fixed replay markers">
            <button type="button" disabled={status !== "ready"} onClick={() => void seek(142)}>142s Debris</button>
            <button type="button" disabled={status !== "ready"} onClick={() => void seek(158)}>158s Arcs</button>
            <button type="button" disabled={status !== "ready"} onClick={() => void seek(166)}>166s Answer</button>
            <button type="button" disabled={status !== "ready"} onClick={() => void seek(176)}>176s Twinkle</button>
            <button type="button" disabled={status !== "ready"} onClick={() => void seek(179)}>179s Title</button>
            <button type="button" disabled={status !== "ready"} onClick={() => void quality("high-temporal")}>High</button>
            <button type="button" disabled={status !== "ready"} onClick={() => void quality("low-static")}>Fallback</button>
          </nav>
        </>
      )}
      {failure ? <p className={styles.failure} data-testid="gfx-hero-c-failure">{failure}</p> : null}
      <pre className={styles.snapshot} data-testid="gfx-hero-c-snapshot">
        {snapshot ? JSON.stringify(snapshot, null, 2) : "initializing"}
      </pre>
    </main>
  );
}
