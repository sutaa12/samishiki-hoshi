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
import {
  createLonelyStarWorld,
  type LonelyStarWorld,
  type WorldMetrics,
} from "@/src/game/world";
import {
  createJourneyAudio,
  type JourneyAudio,
} from "@/src/game/audio";

const FIXED_STEP = 1 / 60;
const DEFAULT_SEED = 20_260_818;

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
  cue: string;
  pulses: number;
  answerAt: number | null;
  finished: boolean;
  hash: string;
  p95FrameMs: number;
  metrics: WorldMetrics | null;
  x: number;
  y: number;
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
  metrics: WorldMetrics | null = null,
  p95FrameMs = 0,
): HudSnapshot {
  const shot = shotAt(state.time);
  return {
    time: state.time,
    phase: phaseAt(state.time),
    shot: shot.id,
    cue: shot.cue,
    pulses: state.pulses.length,
    answerAt: state.answerAt,
    finished: state.finished,
    hash: hashJourney(state),
    p95FrameMs,
    metrics,
    x: state.position.x,
    y: state.position.y,
  };
}

function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, input, select, [role='dialog']"));
}

export function GameClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<LonelyStarWorld | null>(null);
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
  const frameSamplesRef = useRef<number[]>([]);
  const lastUiUpdateRef = useRef(0);
  const lastAnswerRef = useRef<number | null>(null);

  const [settings, setSettings] = useState<Settings>(INITIAL_SETTINGS);
  const [snapshot, setSnapshot] = useState<HudSnapshot>(() =>
    makeSnapshot(createJourneyState({ seed: DEFAULT_SEED })),
  );
  const [runSeed, setRunSeed] = useState(DEFAULT_SEED);
  const [started, setStarted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasMoved, setHasMoved] = useState(false);
  const [webglError, setWebglError] = useState<string | null>(null);
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
    worldRef.current?.setOptions({
      quality: settings.quality,
      accessibility: {
        reducedMotion: settings.reducedMotion,
        highContrast: settings.highContrast,
        wideFlow: settings.wideFlow,
        colorIndependentCues: true,
      },
    });
    audioRef.current?.setMuted(settings.muted);
  }, [settings]);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  const begin = useCallback(() => {
    if (startedRef.current || webglError) return;
    startedRef.current = true;
    setStarted(true);
    audioRef.current?.start().catch(() => undefined);
  }, [webglError]);

  const restart = useCallback(() => {
    stateRef.current = createJourneyState({ seed: seedRef.current });
    pendingPulseRef.current = false;
    pointerRef.current = { x: 0, y: -0.72, active: false };
    lastAutoPulseRef.current = -10;
    lastAnswerRef.current = null;
    frameSamplesRef.current = [];
    setHasMoved(false);
    setSnapshot(makeSnapshot(stateRef.current, worldRef.current?.metrics ?? null));
    startedRef.current = true;
    setStarted(true);
    audioRef.current?.start().catch(() => undefined);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const params = new URLSearchParams(window.location.search);
    const requestedSeed = Number(params.get("seed"));
    const seed = Number.isFinite(requestedSeed) ? requestedSeed >>> 0 : DEFAULT_SEED;
    const localHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
    const isQa = localHost && params.get("qa") === "1";
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
    stateRef.current = advanceJourneyTo(createJourneyState({ seed }), checkpoint);
    setSnapshot(makeSnapshot(stateRef.current));
    setQaMode(isQa);

    let world: LonelyStarWorld;
    try {
      world = createLonelyStarWorld({
        canvas,
        seed,
        quality: settingsRef.current.quality,
        accessibility: {
          reducedMotion: settingsRef.current.reducedMotion,
          highContrast: settingsRef.current.highContrast,
          wideFlow: settingsRef.current.wideFlow,
          colorIndependentCues: true,
        },
      });
      worldRef.current = world;
      audioRef.current = createJourneyAudio({ muted: settingsRef.current.muted });
    } catch (error) {
      setWebglError(error instanceof Error ? error.message : "WebGLを開始できませんでした。");
      return;
    }

    const resize = () => worldRef.current?.resize(window.innerWidth, window.innerHeight);
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let lastRealTime = performance.now();
    let accumulator = 0;
    let wasFinished = false;

    const frame = (now: number) => {
      const world = worldRef.current;
      if (!world) return;
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
            lastAnswerRef.current = stateRef.current.answerAt;
          }
          accumulator -= FIXED_STEP;
        }
      } else {
        accumulator = 0;
      }

      const state = stateRef.current;
      const phase = phaseAt(state.time);
      audioRef.current?.update(phase, state.time);
      world.update(
        {
          storyTime: state.time,
          phase,
          shot: shotAt(state.time).id,
          position: state.position,
          pulseCount: state.pulses.length,
          answerAt: state.answerAt,
          finished: state.finished,
        },
        now / 1000,
      );

      frameSamplesRef.current.push(world.metrics.frameMs);
      if (frameSamplesRef.current.length > 600) frameSamplesRef.current.shift();
      const finishedChanged = state.finished !== wasFinished;
      wasFinished = state.finished;
      if (now - lastUiUpdateRef.current >= 120 || finishedChanged) {
        lastUiUpdateRef.current = now;
        const p95 = percentile95(frameSamplesRef.current);
        setSnapshot(makeSnapshot(state, world.metrics, Number(p95.toFixed(2))));
      }
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    const clearHeldInput = () => {
      keysRef.current.clear();
      pointerRef.current.active = false;
      lastRealTime = performance.now();
      accumulator = 0;
    };
    window.addEventListener("blur", clearHeldInput);
    document.addEventListener("visibilitychange", clearHeldInput);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", clearHeldInput);
      document.removeEventListener("visibilitychange", clearHeldInput);
      world.dispose();
      audioRef.current?.dispose();
      worldRef.current = null;
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
      data-position-x={snapshot.x.toFixed(5)}
      data-position-y={snapshot.y.toFixed(5)}
      data-finished={snapshot.finished ? "true" : "false"}
      data-answer-at={snapshot.answerAt === null ? "" : snapshot.answerAt.toFixed(2)}
      data-webgl={webglError ? "false" : "true"}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => {
        if (event.pointerType !== "mouse") pointerRef.current.active = false;
      }}
      onPointerCancel={() => { pointerRef.current.active = false; }}
    >
      <canvas ref={canvasRef} className="world-canvas" aria-label="海から宇宙へ続く手続き生成の世界" />

      {!started && !webglError && (
        <section className="start-screen" aria-label="旅を始める">
          <div className="start-mark" aria-hidden="true"><span /></div>
          <p className="start-tagline">ひとりの光を、流れの先へ</p>
          <button className="primary-button" type="button" onClick={begin}>
            旅をはじめる
          </button>
          <p className="start-controls">移動：MOUSE · TOUCH · WASD · 矢印 / 生命：TAP · SPACE</p>
        </section>
      )}

      {webglError && (
        <section className="fallback-panel" role="alert">
          <div className="start-mark" aria-hidden="true"><span /></div>
          <h1>光を描けませんでした</h1>
          <p>{webglError}</p>
          <p>WebGL対応ブラウザで再読み込みしてください。</p>
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>再読み込み</button>
        </section>
      )}

      {started && !webglError && (
        <>
          <div className="journey-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
          <div className="corner-meta" aria-hidden="true">
            <span className="seed-mark">{runSeed.toString(36).toUpperCase()}</span>
            <span className="twinkle-count">✦ {snapshot.pulses.toString().padStart(3, "0")}</span>
          </div>
          <button
            className="settings-button"
            type="button"
            aria-label="設定を開く"
            aria-expanded={settingsOpen}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setSettingsOpen(true)}
          >
            <span aria-hidden="true">◌</span>
          </button>

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
              <p>TWINKLE, O LONELY STAR</p>
              <h1>さみしき星のまたたきよ</h1>
              {snapshot.finished && <p className="final-tagline">ひとりの光は、やがて無数のまたたきになる。</p>}
            </div>
          )}

          {snapshot.finished && (
            <section className="end-actions" aria-label="旅の記録">
              <p className="world-memory">WORLD {runSeed} · {snapshot.pulses} TWINKLES · {snapshot.hash}</p>
              <div>
                <button type="button" onClick={restart}>同じ星を飛ぶ</button>
                <button type="button" onClick={newWorld}>新しい星へ</button>
                <button type="button" onClick={downloadPostcard}>光景を残す</button>
              </div>
            </section>
          )}
        </>
      )}

      {settingsOpen && (
        <div className="settings-backdrop" role="presentation" onPointerDown={(event) => event.stopPropagation()}>
          <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header>
              <div><p>JOURNEY OPTIONS</p><h2 id="settings-title">旅の設定</h2></div>
              <button type="button" aria-label="設定を閉じる" onClick={() => setSettingsOpen(false)}>×</button>
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

      <p className="visually-hidden" aria-live="polite">{started ? snapshot.cue : "旅を始める準備ができました。"}</p>
      {qaMode && (
        <output className="qa-metrics" data-testid="qa-metrics">
          {snapshot.time.toFixed(2)}s · {snapshot.shot} · P95 {snapshot.p95FrameMs.toFixed(2)}ms · {snapshot.metrics?.drawCalls ?? 0} calls
        </output>
      )}
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
