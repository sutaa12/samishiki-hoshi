"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InputRouter } from "@/src/game/input/input-router";
import type { PointerGestureSample } from "@/src/game/input/pointer-gesture";
import { MINIMUM_DURATION_MS } from "@/src/game/r5/minimum-encounters";
import { createMinimumLoopState, stepMinimumLoop, type MinimumLoopState } from "@/src/game/r5/minimum-loop";
import { createMinimumWorld, type MinimumWorldTelemetry } from "@/src/gfx/r5/minimum-world";
import styles from "./r5-minimum.module.css";

type FrameReceipt = Readonly<{
  frame: number;
  timeMs: number;
  distanceMm: number;
  playerXPermille: number;
  activeStep: MinimumLoopState["activeStep"];
  progress: MinimumLoopState["progress"];
  pulse: boolean;
  screen: MinimumWorldTelemetry;
}>;

declare global {
  interface Window {
    __R5_MINIMUM_TELEMETRY__?: readonly FrameReceipt[];
    __R5_MINIMUM_STATE__?: MinimumLoopState;
  }
}

const FIXED_STEP_MS = 16;
const ALLOWED_KEYS = new Set(["ArrowLeft", "ArrowRight", "KeyA", "KeyD", "Space"]);

function pointerSample(event: PointerEvent, canvas: HTMLCanvasElement): PointerGestureSample {
  const bounds = canvas.getBoundingClientRect();
  return {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    clientX: event.clientX - bounds.left,
    clientY: event.clientY - bounds.top,
    buttons: event.buttons,
    timeStamp: event.timeStamp,
    viewportWidth: bounds.width,
    viewportHeight: bounds.height,
  };
}

function resultLabel(state: MinimumLoopState): string {
  if (state.timeMs < MINIMUM_DURATION_MS) return `${Math.ceil((MINIMUM_DURATION_MS - state.timeMs) / 1_000)}s`;
  const successes = Number(state.ringResult === "pass") + Number(state.obstacleResult === "dodge") + Number(state.nodeResult === "perfect" || state.nodeResult === "good");
  return `${successes}/3 CLEAR`;
}

export function R5MinimumClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resetNonceRef = useRef(0);
  const [resetNonce, setResetNonce] = useState(0);
  const [snapshot, setSnapshot] = useState<MinimumLoopState>(() => createMinimumLoopState());
  const restart = useCallback(() => {
    resetNonceRef.current += 1;
    setResetNonce(resetNonceRef.current);
    setSnapshot(createMinimumLoopState());
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const router = new InputRouter();
    const world = createMinimumWorld(canvas);
    let state = createMinimumLoopState();
    let animationFrame = 0;
    let priorNow = performance.now();
    let accumulator = 0;
    let frame = 0;
    let lastUiSync = -100;
    const receipts: FrameReceipt[] = [];

    const onKeyDown = (event: KeyboardEvent) => {
      if (!ALLOWED_KEYS.has(event.code)) return;
      const routed = router.keyDown(event.code, event.repeat);
      if (routed.handled) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!ALLOWED_KEYS.has(event.code)) return;
      if (router.keyUp(event.code)) event.preventDefault();
    };
    const onPointerDown = (event: PointerEvent) => {
      const result = router.pointerDown(pointerSample(event, canvas));
      if (result.capturePointer) canvas.setPointerCapture(event.pointerId);
      if (result.handled) event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.buttons === 0 && event.pointerType === "mouse") return;
      if (router.pointerMove(pointerSample(event, canvas)).handled) event.preventDefault();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (router.pointerUp(pointerSample(event, canvas)).handled) event.preventDefault();
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    const onPointerCancel = (event: PointerEvent) => router.pointerCancel(event.pointerId);
    const onResize = () => world.resize();
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp, { passive: false });
    window.addEventListener("resize", onResize);
    canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
    canvas.addEventListener("pointermove", onPointerMove, { passive: false });
    canvas.addEventListener("pointerup", onPointerUp, { passive: false });
    canvas.addEventListener("pointercancel", onPointerCancel);

    const tick = (now: number) => {
      accumulator += Math.min(100, now - priorNow);
      priorNow = now;
      while (accumulator >= FIXED_STEP_MS && state.timeMs < MINIMUM_DURATION_MS) {
        const input = router.consumeFrame();
        state = stepMinimumLoop(state, {
          moveX: Math.sign(input.moveX) as -1 | 0 | 1,
          pointerXPermille: input.pointer.active ? Math.round(input.pointer.x * 1_000) : null,
          pulse: input.pulse,
        }, FIXED_STEP_MS);
        const screen = world.telemetry(state);
        receipts.push(Object.freeze({
          frame,
          timeMs: state.timeMs,
          distanceMm: state.distanceMm,
          playerXPermille: state.playerXPermille,
          activeStep: state.activeStep,
          progress: state.progress,
          pulse: input.pulse,
          screen,
        }));
        frame += 1;
        accumulator -= FIXED_STEP_MS;
      }
      world.render(state);
      window.__R5_MINIMUM_STATE__ = state;
      window.__R5_MINIMUM_TELEMETRY__ = receipts;
      if (state.timeMs - lastUiSync >= 96 || state.timeMs >= MINIMUM_DURATION_MS) {
        lastUiSync = state.timeMs;
        setSnapshot(state);
      }
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(animationFrame);
      router.reset();
      world.dispose();
      delete window.__R5_MINIMUM_STATE__;
      delete window.__R5_MINIMUM_TELEMETRY__;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [resetNonce]);

  return (
    <main className={styles.shell} data-testid="r5-minimum" data-step={snapshot.activeStep} data-progress={snapshot.progress}>
      <canvas ref={canvasRef} className={styles.canvas} aria-label="15秒の海底Grayboxゲーム" />
      <header className={styles.hud}>
        <div>
          <p className={styles.eyebrow}>R5 MINIMUM LOOP · 15 SECONDS</p>
          <h1>水滴を導き、命へ光を渡す</h1>
        </div>
        <div className={styles.timer} data-testid="r5-time">{resultLabel(snapshot)}</div>
      </header>
      <section className={styles.progress} aria-label="Encounter progress">
        <div data-active={snapshot.activeStep === "ring"} data-result={snapshot.ringResult}><span>1</span> RING <strong>{snapshot.ringResult}</strong></div>
        <div data-active={snapshot.activeStep === "obstacle"} data-result={snapshot.obstacleResult}><span>2</span> DODGE <strong>{snapshot.obstacleResult}</strong></div>
        <div data-active={snapshot.activeStep === "node"} data-result={snapshot.nodeResult}><span>3</span> PULSE <strong>{snapshot.nodeResult}</strong></div>
      </section>
      <aside className={styles.controls}>
        <p><kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd> / DRAG</p>
        <p><kbd>SPACE</kbd> / CLICK / TAP = PULSE</p>
      </aside>
      <div className={styles.readout} data-testid="r5-readout">
        <span>DIST {snapshot.distanceMm}mm</span>
        <span>X {snapshot.playerXPermille}</span>
        <span>PROGRESS {snapshot.progress}/3</span>
      </div>
      {snapshot.timeMs >= MINIMUM_DURATION_MS && (
        <section className={styles.result} role="dialog" aria-label="15秒Loop result">
          <p>LOOP COMPLETE</p>
          <h2>{resultLabel(snapshot)}</h2>
          <button type="button" onClick={restart}>もう一度</button>
        </section>
      )}
    </main>
  );
}
