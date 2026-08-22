"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  JOURNEY_SECONDS,
  phaseAt,
  shotAt,
  type JourneyPhase,
  type JourneyState,
  type QualityLevel,
} from "@/src/game/model";
import {
  createJourneyState,
  advanceJourneyTo,
  hashJourney,
  stepJourney,
} from "@/src/game/simulation";
import type { ThreeBackendRequest } from "@/src/gfx/v2/backend/backend-adapter";
import type { GfxFoundationSnapshot } from "@/src/gfx/v2/integration/foundation-runtime";
import {
  createProductionJourneyRuntime,
  type ProductionGfxRuntime,
} from "@/src/gfx/v2/integration/production-journey-runtime";
import { RuntimeCleanupTombstone } from "@/src/gfx/v2/integration/runtime-cleanup-tombstone";
import { projectJourneyState } from "@/src/gfx/v2/project-journey";
import { GFX_TELEMETRY_MINIMUM_PERCENTILE_SAMPLES } from "@/src/gfx/v2/telemetry";
import {
  createJourneyAudio,
  type JourneyAudio,
} from "@/src/game/audio";

const FIXED_STEP = 1 / 60;
const DEFAULT_SEED = 20_260_818;

const productionRuntimeCleanupOwner = new RuntimeCleanupTombstone<ProductionGfxRuntime>();
let productionRuntimeLifecycleTail: Promise<void> = Promise.resolve();

type Settings = {
  reducedMotion: boolean;
  highContrast: boolean;
  autoGive: boolean;
  wideFlow: boolean;
  muted: boolean;
  quality: QualityLevel;
};

type HudSnapshot = {
  time: number;
  phase: JourneyPhase;
  shot: string;
  pulses: number;
  answerAt: number | null;
  finished: boolean;
  hash: string;
  p95FrameMs: number;
  frameSampleCount: number;
  frameMetricsReady: boolean;
  metrics: ProductionRendererMetrics | null;
  x: number;
  y: number;
};

type ProductionRendererMetrics = {
  actualBackend: string | null;
  requestedBackend: string;
  planDigest: string;
  generation: number;
  quality: QualityLevel;
  drawCalls: number;
  triangles: number;
  storyTime: number;
  positionX: number;
  positionY: number;
  velocityX: number;
  velocityY: number;
  pulseCount: number;
  answerAt: number | null;
  programs: number;
  geometries: number;
  gpuOwners: number;
  logicalOwners: number;
  poolSlots: number;
  resizeListenerActive: boolean;
  subscribers: number;
};

const INITIAL_SETTINGS: Settings = {
  reducedMotion: false,
  highContrast: false,
  autoGive: false,
  wideFlow: false,
  muted: false,
  quality: "balanced",
};

function makeSnapshot(
  state: JourneyState,
  metrics: ProductionRendererMetrics | null = null,
  p95FrameMs = 0,
  frameSampleCount = 0,
): HudSnapshot {
  const shot = shotAt(state.time);
  return {
    time: state.time,
    phase: phaseAt(state.time),
    shot: shot.id,
    pulses: state.pulses.length,
    answerAt: state.answerAt,
    finished: state.finished,
    hash: hashJourney(state),
    p95FrameMs,
    frameSampleCount,
    frameMetricsReady: frameSampleCount >= GFX_TELEMETRY_MINIMUM_PERCENTILE_SAMPLES,
    metrics,
    x: state.position.x,
    y: state.position.y,
  };
}

function qualityFromFoundation(id: GfxFoundationSnapshot["quality"]["id"]): QualityLevel {
  if (id.startsWith("high")) return "high";
  if (id.startsWith("balanced")) return "balanced";
  return "low";
}

function rendererEvidence(runtime: ProductionGfxRuntime): {
  metrics: ProductionRendererMetrics;
  p95FrameMs: number;
  frameSampleCount: number;
} {
  const snapshot = runtime.getSnapshot();
  const journey = runtime.getJourneySnapshot();
  const latest = snapshot.telemetry.latestFrame?.renderer;
  return {
    metrics: {
      actualBackend: snapshot.backendFacts.actualApi,
      requestedBackend: snapshot.backendFacts.requestedApi,
      planDigest: snapshot.planDigest,
      generation: snapshot.generation,
      quality: qualityFromFoundation(snapshot.quality.id),
      drawCalls: latest?.drawCalls ?? 0,
      triangles: latest?.triangles ?? 0,
      storyTime: journey.storyTime,
      positionX: journey.position.x,
      positionY: journey.position.y,
      velocityX: journey.velocity.x,
      velocityY: journey.velocity.y,
      pulseCount: journey.pulses.length,
      answerAt: journey.answerAt,
      programs: snapshot.backendLifecycle.resources.programs,
      geometries: snapshot.backendLifecycle.resources.geometries,
      gpuOwners: snapshot.chunks.gpuOwnedCount,
      logicalOwners: snapshot.logicalResources.owners,
      poolSlots: snapshot.uploader.poolSlots,
      resizeListenerActive: snapshot.runtime.resizeListenerActive,
      subscribers: snapshot.runtime.subscribers,
    },
    p95FrameMs: Number((snapshot.telemetry.frameIntervalMs.p95 ?? 0).toFixed(2)),
    frameSampleCount: snapshot.telemetry.frameIntervalMs.sampleCount,
  };
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, input, select, [role='dialog']"));
}

export function GameClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameContentRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsPanelRef = useRef<HTMLElement>(null);
  const settingsCloseButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const rendererRef = useRef<ProductionGfxRuntime | null>(null);
  const audioRef = useRef<JourneyAudio | null>(null);
  const seedRef = useRef(DEFAULT_SEED);
  const stateRef = useRef<JourneyState>(createJourneyState({ seed: DEFAULT_SEED }));
  const settingsRef = useRef<Settings>(INITIAL_SETTINGS);
  const startedRef = useRef(false);
  const settingsOpenRef = useRef(false);
  const pendingPulseRef = useRef(false);
  const keysRef = useRef(new Set<string>());
  const pointerRef = useRef({ x: 0, y: -0.72, active: false });
  const lastAutoPulseRef = useRef(-10);
  const lastUiUpdateRef = useRef(0);
  const qaRestartCheckpointRef = useRef(0);

  const [settings, setSettings] = useState<Settings>(INITIAL_SETTINGS);
  const [snapshot, setSnapshot] = useState<HudSnapshot>(() =>
    makeSnapshot(createJourneyState({ seed: DEFAULT_SEED })),
  );
  const [runSeed, setRunSeed] = useState(DEFAULT_SEED);
  const [started, setStarted] = useState(false);
  const [restartCount, setRestartCount] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasMoved, setHasMoved] = useState(false);
  const [rendererReady, setRendererReady] = useState(false);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [qaMode, setQaMode] = useState(false);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reducedMotion) return;
    const frame = requestAnimationFrame(() => {
      setSettings((current) => ({ ...current, reducedMotion: true }));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
    audioRef.current?.setMuted(settings.muted);
  }, [settings]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    void renderer.setQuality(settings.quality).catch((error: unknown) => {
      setRendererError(error instanceof Error ? error.message : "描画品質を変更できませんでした。");
    });
  }, [settings.quality]);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;

    const background = gameContentRef.current;
    const canvas = canvasRef.current;
    const panel = settingsPanelRef.current;
    const opener = restoreFocusRef.current ?? settingsButtonRef.current;
    if (!panel) return;

    const focusableSelector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "a[href]",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");
    const focusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
      );

    (settingsCloseButtonRef.current ?? focusables()[0] ?? panel).focus();
    background?.setAttribute("inert", "");
    background?.setAttribute("aria-hidden", "true");
    canvas?.setAttribute("inert", "");
    canvas?.setAttribute("aria-hidden", "true");

    const onModalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSettingsOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const available = focusables();
      if (available.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = available[0];
      const last = available[available.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onModalKeyDown);
    return () => {
      document.removeEventListener("keydown", onModalKeyDown);
      background?.removeAttribute("inert");
      background?.removeAttribute("aria-hidden");
      canvas?.removeAttribute("inert");
      canvas?.removeAttribute("aria-hidden");
      requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus();
      });
    };
  }, [settingsOpen]);

  const begin = useCallback(() => {
    if (startedRef.current || rendererError || !rendererReady) return;
    startedRef.current = true;
    setStarted(true);
    audioRef.current?.start().catch(() => undefined);
  }, [rendererError, rendererReady]);

  const restart = useCallback(() => {
    const initial = createJourneyState({ seed: seedRef.current });
    stateRef.current = qaRestartCheckpointRef.current > 0
      ? advanceJourneyTo(initial, qaRestartCheckpointRef.current)
      : initial;
    pendingPulseRef.current = false;
    pointerRef.current = { x: 0, y: -0.72, active: false };
    lastAutoPulseRef.current = -10;
    setHasMoved(false);
    setRestartCount((count) => count + 1);
    const renderer = rendererRef.current;
    if (renderer) {
      renderer.update(projectJourneyState(stateRef.current));
      const evidence = rendererEvidence(renderer);
      setSnapshot(makeSnapshot(
        stateRef.current,
        evidence.metrics,
        evidence.p95FrameMs,
        evidence.frameSampleCount,
      ));
    } else {
      setSnapshot(makeSnapshot(stateRef.current));
    }
    startedRef.current = true;
    setStarted(true);
    audioRef.current?.start().catch(() => undefined);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    const params = new URLSearchParams(window.location.search);
    const requestedSeed = Number(params.get("seed"));
    const seed = Number.isFinite(requestedSeed) ? requestedSeed >>> 0 : DEFAULT_SEED;
    const localHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
    const isQa = localHost && params.get("qa") === "1";
    const qualityParam = params.get("quality");
    const qaQuality: QualityLevel | null = isQa && (qualityParam === "low" || qualityParam === "balanced" || qualityParam === "high")
      ? qualityParam
      : null;
    if (qaQuality) {
      settingsRef.current = { ...settingsRef.current, quality: qaQuality };
      queueMicrotask(() => {
        if (!cancelled) setSettings((current) => ({ ...current, quality: qaQuality }));
      });
    }
    const requestedSpeed = Number(params.get("speed"));
    const speed = isQa && Number.isFinite(requestedSpeed)
      ? Math.max(1, Math.min(60, requestedSpeed))
      : 1;
    seedRef.current = seed;
    setRunSeed(seed);
    const requestedCheckpoint = Number(params.get("at"));
    const checkpoint = isQa && Number.isFinite(requestedCheckpoint)
      ? Math.max(0, Math.min(179.9, requestedCheckpoint))
      : 0;
    qaRestartCheckpointRef.current = checkpoint;
    stateRef.current = advanceJourneyTo(createJourneyState({ seed }), checkpoint);
    setSnapshot(makeSnapshot(stateRef.current));
    setQaMode(isQa);
    setRendererReady(false);
    setRendererError(null);

    const backendRequest: ThreeBackendRequest = isQa && params.get("backend") === "webgl2"
      ? "forced-webgl2"
      : "webgpu-preferred";
    let raf = 0;
    let lastRealTime = performance.now();
    let accumulator = 0;
    let wasFinished = false;
    let listenersAttached = false;

    const frame = (now: number) => {
      const renderer = rendererRef.current;
      if (!renderer || cancelled) return;
      const realDelta = Math.min(0.05, Math.max(0, (now - lastRealTime) / 1000));
      lastRealTime = now;

      if (startedRef.current && !settingsOpenRef.current && !document.hidden) {
        accumulator += realDelta * speed;
        while (accumulator >= FIXED_STEP && !stateRef.current.finished) {
          const state = stateRef.current;
          const keys = keysRef.current;
          let moveX = Number(keys.has("ArrowRight") || keys.has("KeyD")) - Number(keys.has("ArrowLeft") || keys.has("KeyA"));
          let moveY = Number(keys.has("ArrowUp") || keys.has("KeyW")) - Number(keys.has("ArrowDown") || keys.has("KeyS"));

          if (pointerRef.current.active) {
            const strength = settingsRef.current.wideFlow ? 2.8 : 1.9;
            moveX += (pointerRef.current.x - state.position.x) * strength;
            moveY += (pointerRef.current.y - state.position.y) * strength;
          }

          let pulse = pendingPulseRef.current;
          if (
            settingsRef.current.autoGive &&
            state.time - lastAutoPulseRef.current >= 4
          ) {
            pulse = true;
            lastAutoPulseRef.current = state.time;
          }
          pendingPulseRef.current = false;

          const previousPulseCount = state.pulses.length;
          const previousAnswer = state.answerAt;
          stateRef.current = stepJourney(state, { moveX, moveY, pulse }, FIXED_STEP);
          if (stateRef.current.pulses.length > previousPulseCount) {
            audioRef.current?.emitPulse(phaseAt(stateRef.current.time));
          }
          if (previousAnswer === null && stateRef.current.answerAt !== null) {
            audioRef.current?.answer();
          }
          accumulator -= FIXED_STEP;
        }
      } else {
        accumulator = 0;
      }

      const state = stateRef.current;
      const phase = phaseAt(state.time);
      audioRef.current?.update(phase, state.time);
      try {
        renderer.update(projectJourneyState(state));
      } catch (error: unknown) {
        setRendererError(error instanceof Error ? error.message : "Production rendererの更新に失敗しました。");
        setRendererReady(false);
        return;
      }
      const finishedChanged = state.finished !== wasFinished;
      wasFinished = state.finished;
      if (now - lastUiUpdateRef.current >= 120 || finishedChanged) {
        lastUiUpdateRef.current = now;
        const evidence = rendererEvidence(renderer);
        setSnapshot(
          makeSnapshot(
            state,
            evidence.metrics,
            evidence.p95FrameMs,
            evidence.frameSampleCount,
          ),
        );
      }
      raf = requestAnimationFrame(frame);
    };
    const clearHeldInput = () => {
      keysRef.current.clear();
      pointerRef.current.active = false;
      lastRealTime = performance.now();
      accumulator = 0;
    };

    const initialize = async () => {
      const operation = productionRuntimeLifecycleTail
        .catch(() => undefined)
        .then(async () => {
          await productionRuntimeCleanupOwner.drain();
          const runtime = await createProductionJourneyRuntime({
            canvas,
            request: backendRequest,
            qa: isQa,
            generation: 1,
            quality: settingsRef.current.quality,
            initialSnapshot: projectJourneyState(stateRef.current),
          });
          if (cancelled) {
            await productionRuntimeCleanupOwner.dispose(runtime);
            return null;
          }
          return runtime;
        });
      productionRuntimeLifecycleTail = operation.then(() => undefined, () => undefined);
      const runtime = await operation;
      if (!runtime || cancelled) return;
      rendererRef.current = runtime;
      audioRef.current = createJourneyAudio({ muted: settingsRef.current.muted });
      const evidence = rendererEvidence(runtime);
      setSnapshot(makeSnapshot(
        stateRef.current,
        evidence.metrics,
        evidence.p95FrameMs,
        evidence.frameSampleCount,
      ));
      setRendererReady(true);
      window.addEventListener("blur", clearHeldInput);
      document.addEventListener("visibilitychange", clearHeldInput);
      listenersAttached = true;
      raf = requestAnimationFrame(frame);
    };

    void initialize().catch((error: unknown) => {
      if (cancelled) return;
      setRendererError(error instanceof Error ? error.message : "Production rendererを開始できませんでした。");
      setRendererReady(false);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (listenersAttached) {
        window.removeEventListener("blur", clearHeldInput);
        document.removeEventListener("visibilitychange", clearHeldInput);
      }
      const runtime = rendererRef.current;
      rendererRef.current = null;
      if (runtime) {
        const disposal = productionRuntimeLifecycleTail
          .catch(() => undefined)
          .then(() => productionRuntimeCleanupOwner.dispose(runtime));
        productionRuntimeLifecycleTail = disposal.then(() => undefined, () => undefined);
      }
      audioRef.current?.dispose();
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isInteractiveTarget(event.target)) return;
      if (!startedRef.current && (event.code === "Space" || event.code === "Enter")) {
        event.preventDefault();
        begin();
        return;
      }
      if (!startedRef.current || settingsOpenRef.current) return;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(event.code)) {
        event.preventDefault();
      }
      if (event.code === "Space" && !event.repeat) pendingPulseRef.current = true;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
        keysRef.current.add(event.code);
        setHasMoved(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => keysRef.current.delete(event.code);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [begin]);

  const updatePointer = (event: ReactPointerEvent<HTMLElement>, active: boolean) => {
    pointerRef.current = {
      x: Math.max(-0.94, Math.min(0.94, (event.clientX / window.innerWidth) * 1.88 - 0.94)),
      y: Math.max(-0.94, Math.min(0.94, 0.94 - (event.clientY / window.innerHeight) * 1.88)),
      active,
    };
    setHasMoved(true);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!startedRef.current || settingsOpenRef.current || isInteractiveTarget(event.target)) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updatePointer(event, true);
    pendingPulseRef.current = true;
    audioRef.current?.start().catch(() => undefined);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!startedRef.current || settingsOpenRef.current || isInteractiveTarget(event.target)) return;
    if (event.pointerType === "touch" && event.buttons === 0) return;
    updatePointer(event, event.pointerType === "mouse" || event.buttons > 0);
  };

  const downloadPostcard = () => {
    const source = canvasRef.current;
    if (!source) return;
    const card = document.createElement("canvas");
    card.width = 1600;
    card.height = 900;
    const context = card.getContext("2d");
    if (!context) return;
    context.drawImage(source, 0, 0, card.width, card.height);
    const shade = context.createLinearGradient(0, 430, 0, 900);
    shade.addColorStop(0, "rgba(2,7,20,0)");
    shade.addColorStop(1, "rgba(2,7,20,.88)");
    context.fillStyle = shade;
    context.fillRect(0, 0, card.width, card.height);
    context.fillStyle = "#effffa";
    context.textAlign = "center";
    context.font = '400 62px "Hiragino Mincho ProN", "Yu Mincho", serif';
    context.fillText("さみしき星のまたたきよ", 800, 770);
    context.font = "500 22px system-ui, sans-serif";
    context.fillStyle = "rgba(220,255,248,.76)";
    context.fillText(`WORLD ${seedRef.current} · TWINKLE ${snapshot.pulses.toString().padStart(3, "0")} · ${snapshot.hash}`, 800, 824);
    card.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `samishiki-hoshi-${seedRef.current}.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  };

  const newWorld = () => {
    const values = new Uint32Array(1);
    window.crypto.getRandomValues(values);
    window.location.href = `/?seed=${values[0]}`;
  };

  const progress = Math.min(100, (snapshot.time / JOURNEY_SECONDS) * 100);
  const showFormalTitle = snapshot.time >= 178;
  const alienState = snapshot.time >= 155 && snapshot.time < 161
    ? "silhouette"
    : snapshot.time >= 161
      ? "revealed"
      : "hidden";
  const assistiveStatus = rendererError
    ? "光景を描画できませんでした。再読み込みしてください。"
    : !rendererReady
      ? "光景を準備しています。"
      : !started
        ? "旅を始める準備ができました。EnterまたはSpaceでも開始できます。"
    : settingsOpen
      ? "旅の設定を開きました。Tabで項目を移動し、Escapeで旅へ戻れます。"
      : snapshot.finished
        ? `3分間の旅が完了しました。生命の光を${snapshot.pulses}回わたしました。`
        : snapshot.answerAt !== null
          ? "応答を受け取りました。移動と生命の光の操作を続けられます。"
          : snapshot.pulses > 0
            ? `生命の光を${snapshot.pulses}回わたしました。移動操作も続けられます。`
            : hasMoved
              ? "移動操作を受け付けています。クリック、タップ、またはSpaceで生命の光をわたせます。"
              : "移動できます。クリック、タップ、またはSpaceで生命の光をわたせます。";
  const classes = [
    "game-shell",
    settings.highContrast ? "is-high-contrast" : "",
    settings.reducedMotion ? "is-reduced-motion" : "",
  ].filter(Boolean).join(" ");

  return (
    <main
      className={classes}
      aria-label="生命のしずくを導く三分間の旅"
      data-testid="game-shell"
      data-phase={snapshot.phase}
      data-shot={snapshot.shot}
      data-story-time={snapshot.time.toFixed(2)}
      data-pulses={snapshot.pulses}
      data-gameplay-hash={snapshot.hash}
      data-position-x={snapshot.x.toFixed(5)}
      data-position-y={snapshot.y.toFixed(5)}
      data-finished={snapshot.finished ? "true" : "false"}
      data-answer-at={snapshot.answerAt === null ? "" : snapshot.answerAt.toFixed(2)}
      data-alien-state={alienState}
      data-webgl={rendererReady ? "true" : "false"}
      data-renderer-status={rendererError ? "error" : rendererReady ? "ready" : "initializing"}
      data-actual-backend={snapshot.metrics?.actualBackend?.toLowerCase() ?? "pending"}
      data-requested-backend={snapshot.metrics?.requestedBackend.toLowerCase() ?? "pending"}
      data-render-quality={snapshot.metrics?.quality ?? settings.quality}
      data-render-plan-digest={snapshot.metrics?.planDigest ?? "pending"}
      data-render-generation={snapshot.metrics?.generation ?? 0}
      data-render-story-time={snapshot.metrics?.storyTime.toFixed(2) ?? ""}
      data-render-position-x={snapshot.metrics?.positionX.toFixed(5) ?? ""}
      data-render-position-y={snapshot.metrics?.positionY.toFixed(5) ?? ""}
      data-render-velocity-x={snapshot.metrics?.velocityX.toFixed(5) ?? ""}
      data-render-velocity-y={snapshot.metrics?.velocityY.toFixed(5) ?? ""}
      data-render-pulses={snapshot.metrics?.pulseCount ?? 0}
      data-render-answer-at={snapshot.metrics?.answerAt?.toFixed(2) ?? ""}
      data-render-programs={snapshot.metrics?.programs ?? 0}
      data-render-geometries={snapshot.metrics?.geometries ?? 0}
      data-render-gpu-owners={snapshot.metrics?.gpuOwners ?? 0}
      data-render-logical-owners={snapshot.metrics?.logicalOwners ?? 0}
      data-render-pool-slots={snapshot.metrics?.poolSlots ?? 0}
      data-render-resize-listener={snapshot.metrics?.resizeListenerActive ? "true" : "false"}
      data-render-subscribers={snapshot.metrics?.subscribers ?? 0}
      data-restarts={restartCount}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => {
        if (event.pointerType !== "mouse") pointerRef.current.active = false;
      }}
      onPointerCancel={() => { pointerRef.current.active = false; }}
    >
      <div ref={gameContentRef} className="game-content">
        <canvas ref={canvasRef} className="world-canvas" aria-label="海から宇宙へ続く手続き生成の世界" />

      {!started && !rendererError && (
        <section className="start-screen" aria-label="旅を始める">
          <div className="start-mark" aria-hidden="true"><span /></div>
          <p className="start-tagline">ひとりの光を、流れの先へ</p>
          <button className="primary-button" type="button" disabled={!rendererReady} onClick={begin}>
            {rendererReady ? "旅をはじめる" : "光景を準備しています"}
          </button>
          <p className="start-controls">
            <span>移動：MOUSE · TOUCH · WASD · 矢印</span>
            <span>生命：TAP · SPACE</span>
          </p>
        </section>
      )}

      {rendererError && (
        <section className="fallback-panel" role="alert">
          <div className="start-mark" aria-hidden="true"><span /></div>
          <h1>光を描けませんでした</h1>
          <p>{rendererError}</p>
          <p>WebGPUまたはWebGL2対応ブラウザで再読み込みしてください。</p>
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>再読み込み</button>
        </section>
      )}

      {started && rendererReady && !rendererError && (
        <>
          {!showFormalTitle && (
            <>
              <div className="journey-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
              <div className="corner-meta" aria-hidden="true">
                <span className="seed-mark">{runSeed.toString(36).toUpperCase()}</span>
                <span className="twinkle-count">✦ {snapshot.pulses.toString().padStart(3, "0")}</span>
              </div>
              <button
                ref={settingsButtonRef}
                className="settings-button"
                type="button"
                aria-label="設定を開く"
                aria-expanded={settingsOpen}
                aria-controls="journey-settings"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  restoreFocusRef.current = event.currentTarget;
                  setSettingsOpen(true);
                }}
              >
                <span aria-hidden="true">◌</span>
              </button>
            </>
          )}

          {!snapshot.finished && snapshot.time < 171 && (
            <div className="control-hints" aria-hidden="true">
              <p className={hasMoved ? "is-learned" : ""}>流れへ導く</p>
              <span />
              <p className={snapshot.pulses > 0 ? "is-learned" : hasMoved ? "is-current" : ""}>光をわたす</p>
            </div>
          )}

          {snapshot.time >= 161 && snapshot.time < 171 && snapshot.answerAt === null && (
            <div className="answer-cue" aria-hidden="true"><span /> <span /> <span /></div>
          )}

          {showFormalTitle && (
            <div className={`formal-title ${snapshot.finished ? "is-finished" : ""}`}>
              <h1 aria-label="さみしき星のまたたきよ">
                <span className="title-line">さみしき星の</span>
                <span className="title-line">またたきよ</span>
              </h1>
            </div>
          )}

          {snapshot.finished && (
            <section className="end-actions" aria-label="旅の記録">
              <p className="visually-hidden">WORLD {runSeed} · {snapshot.pulses} TWINKLES · {snapshot.hash}</p>
              <div>
                <button type="button" onClick={restart}>同じ星を飛ぶ</button>
                <button type="button" onClick={newWorld}>新しい星へ</button>
                <button type="button" onClick={downloadPostcard}>光景を残す</button>
              </div>
            </section>
          )}
        </>
      )}

        {qaMode && (
          <output
            className="qa-metrics"
            data-testid="qa-metrics"
            data-draw-calls={snapshot.metrics?.drawCalls ?? 0}
            data-triangles={snapshot.metrics?.triangles ?? 0}
            data-p95-frame-ms={snapshot.p95FrameMs.toFixed(2)}
            data-frame-samples={snapshot.frameSampleCount}
            data-frame-metrics-ready={snapshot.frameMetricsReady}
            data-frame-warmup-ms={0}
            data-frame-metric="gfx-v2-raf-interval"
            data-quality={snapshot.metrics?.quality ?? settings.quality}
            data-actual-backend={snapshot.metrics?.actualBackend?.toLowerCase() ?? "pending"}
            data-requested-backend={snapshot.metrics?.requestedBackend.toLowerCase() ?? "pending"}
            data-plan-digest={snapshot.metrics?.planDigest ?? "pending"}
            data-render-story-time={snapshot.metrics?.storyTime.toFixed(2) ?? ""}
            data-render-position-x={snapshot.metrics?.positionX.toFixed(5) ?? ""}
            data-render-position-y={snapshot.metrics?.positionY.toFixed(5) ?? ""}
            data-render-pulses={snapshot.metrics?.pulseCount ?? 0}
          >
            {snapshot.time.toFixed(2)}s · {snapshot.shot} · P95 {snapshot.p95FrameMs.toFixed(2)}ms · {snapshot.metrics?.drawCalls ?? 0} calls
          </output>
        )}
      </div>

      {settingsOpen && (
        <div className="settings-backdrop" role="presentation" onPointerDown={(event) => event.stopPropagation()}>
          <section
            ref={settingsPanelRef}
            id="journey-settings"
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            tabIndex={-1}
          >
            <header>
              <div><p>JOURNEY OPTIONS</p><h2 id="settings-title">旅の設定</h2></div>
              <button ref={settingsCloseButtonRef} type="button" aria-label="設定を閉じる" onClick={() => setSettingsOpen(false)}>×</button>
            </header>
            <Toggle label="動きを抑える" hint="カメラと視差を穏やかにします" checked={settings.reducedMotion} onChange={(value) => setSettings((current) => ({ ...current, reducedMotion: value }))} />
            <Toggle label="高コントラスト" hint="光と輪郭の差を強めます" checked={settings.highContrast} onChange={(value) => setSettings((current) => ({ ...current, highContrast: value }))} />
            <Toggle label="生命を自動でわたす" hint="約4秒ごとに波紋を放ちます" checked={settings.autoGive} onChange={(value) => setSettings((current) => ({ ...current, autoGive: value }))} />
            <Toggle label="広い流れ" hint="少ない操作で進路へ寄れます" checked={settings.wideFlow} onChange={(value) => setSettings((current) => ({ ...current, wideFlow: value }))} />
            <Toggle label="音を消す" hint="無音でも最後まで遊べます" checked={settings.muted} onChange={(value) => setSettings((current) => ({ ...current, muted: value }))} />
            <label className="quality-field" htmlFor="quality-level">
              <span><strong>描画品質</strong><small>物語と記録は変わりません</small></span>
              <select id="quality-level" aria-label="描画品質" value={settings.quality} onChange={(event) => setSettings((current) => ({ ...current, quality: event.target.value as QualityLevel }))}>
                <option value="low">LOW</option>
                <option value="balanced">BALANCED</option>
                <option value="high">HIGH</option>
              </select>
            </label>
            <button className="done-button" type="button" onClick={() => setSettingsOpen(false)}>旅へ戻る</button>
          </section>
        </div>
      )}

      <p className="visually-hidden" role="status" aria-live="polite" data-testid="assistive-status">
        {assistiveStatus}
      </p>
    </main>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <label className="toggle-row" htmlFor={id}>
      <span><strong>{label}</strong><small>{hint}</small></span>
      <input id={id} aria-label={label} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}
