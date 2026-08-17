"use client";

import { useEffect, useRef, useState } from "react";

type Bloom = { x: number; y: number; born: number };

export function GamePreview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const targetRef = useRef({ x: 0.5, y: 0.48 });
  const bloomsRef = useRef<Bloom[]>([]);
  const [hasMoved, setHasMoved] = useState(false);
  const [hasPulsed, setHasPulsed] = useState(false);

  const pulse = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    bloomsRef.current.push({
      x: targetRef.current.x * canvas.clientWidth,
      y: targetRef.current.y * canvas.clientHeight,
      born: performance.now(),
    });
    setHasPulsed(true);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let frame = 0;
    let width = 0;
    let height = 0;
    const player = { x: 0, y: 0 };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (player.x === 0) {
        player.x = width * 0.48;
        player.y = height * 0.58;
      }
    };

    const drawCoral = (x: number, y: number, scale: number, color: string) => {
      context.save();
      context.translate(x, y);
      context.strokeStyle = color;
      context.lineCap = "round";
      context.shadowBlur = 16;
      context.shadowColor = color;
      const branch = (
        bx: number,
        by: number,
        length: number,
        angle: number,
        depth: number,
      ) => {
        if (depth <= 0) return;
        const ex = bx + Math.cos(angle) * length;
        const ey = by + Math.sin(angle) * length;
        context.lineWidth = Math.max(1.2, depth * 1.8 * scale);
        context.beginPath();
        context.moveTo(bx, by);
        context.lineTo(ex, ey);
        context.stroke();
        branch(ex, ey, length * 0.7, angle - 0.48, depth - 1);
        branch(ex, ey, length * 0.68, angle + 0.55, depth - 1);
      };
      branch(0, 0, 18 * scale, -Math.PI / 2, 4);
      context.restore();
    };

    const render = (time: number) => {
      const t = time * 0.001;
      const target = targetRef.current;
      const tx = target.x * width;
      const ty = target.y * height;
      player.x += (tx - player.x) * 0.045;
      player.y += (ty - player.y) * 0.045;

      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "#0e8692");
      gradient.addColorStop(0.48, "#07536d");
      gradient.addColorStop(1, "#031b31");
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);

      context.globalCompositeOperation = "screen";
      for (let i = 0; i < 9; i += 1) {
        const sx = ((i * 0.137 + 0.04) % 1) * width;
        const ray = context.createLinearGradient(sx, 0, sx + 90, height * 0.74);
        ray.addColorStop(0, "rgba(204,255,243,.16)");
        ray.addColorStop(1, "rgba(204,255,243,0)");
        context.fillStyle = ray;
        context.beginPath();
        context.moveTo(sx - 28, 0);
        context.lineTo(sx + 22, 0);
        context.lineTo(sx + 170, height * 0.72);
        context.lineTo(sx + 55, height * 0.72);
        context.closePath();
        context.fill();
      }

      for (let i = 0; i < 72; i += 1) {
        const lane = (i % 8) / 7;
        const phase = (t * (0.035 + (i % 5) * 0.008) + i * 0.137) % 1;
        const x = width * (0.12 + lane * 0.76) + Math.sin(t + i) * 16;
        const y = height * (1.08 - phase * 1.18);
        const radius = 1.3 + (i % 4) * 0.65;
        context.fillStyle = `rgba(190,255,240,${0.18 + (i % 3) * 0.09})`;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
      context.globalCompositeOperation = "source-over";

      const floorY = height * 0.88;
      context.fillStyle = "#083a40";
      context.beginPath();
      context.moveTo(0, floorY);
      for (let x = 0; x <= width + 30; x += 30) {
        context.lineTo(x, floorY + Math.sin(x * 0.018 + t * 0.2) * 12);
      }
      context.lineTo(width, height);
      context.lineTo(0, height);
      context.fill();

      const coralColors = ["#ff9a81", "#7ee8c6", "#f9d56e", "#bda7ff"];
      for (let i = 0; i < 15; i += 1) {
        const x = (i / 14) * width + Math.sin(i * 2.1) * 18;
        const y = floorY + 8 + Math.cos(i) * 7;
        drawCoral(
          x,
          y,
          0.55 + (i % 4) * 0.12,
          coralColors[i % coralColors.length],
        );
      }

      for (const bloom of bloomsRef.current) {
        const age = Math.min(1, (time - bloom.born) / 1150);
        context.strokeStyle = `rgba(190,255,245,${1 - age})`;
        context.lineWidth = 2;
        context.beginPath();
        context.arc(
          bloom.x,
          bloom.y,
          age * Math.min(width, height) * 0.34,
          0,
          Math.PI * 2,
        );
        context.stroke();
        drawCoral(bloom.x, floorY + 8, 0.6 + age * 0.9, "#ff9fa2");
      }
      bloomsRef.current = bloomsRef.current.filter(
        (bloom) => time - bloom.born < 1500,
      );

      for (let i = 0; i < 13; i += 1) {
        const fx =
          ((t * (18 + (i % 3) * 4) + i * width * 0.12) % (width + 120)) - 60;
        const fy =
          height * (0.22 + (i % 6) * 0.085) + Math.sin(t * 1.7 + i) * 14;
        context.fillStyle =
          i % 3 === 0 ? "rgba(255,220,153,.72)" : "rgba(196,247,244,.62)";
        context.beginPath();
        context.ellipse(fx, fy, 9, 3.5, 0, 0, Math.PI * 2);
        context.fill();
        context.beginPath();
        context.moveTo(fx - 8, fy);
        context.lineTo(fx - 16, fy - 5);
        context.lineTo(fx - 16, fy + 5);
        context.closePath();
        context.fill();
      }

      const breathe = 1 + Math.sin(t * 3.1) * 0.06;
      context.save();
      context.translate(player.x, player.y);
      context.rotate(Math.atan2(ty - player.y, tx - player.x) + Math.PI / 2);
      context.shadowBlur = 26;
      context.shadowColor = "#b9fff7";
      context.fillStyle = "rgba(226,255,250,.56)";
      context.beginPath();
      context.ellipse(-17, 3, 15 * breathe, 7, -0.55, 0, Math.PI * 2);
      context.ellipse(17, 3, 15 * breathe, 7, 0.55, 0, Math.PI * 2);
      context.fill();
      const core = context.createRadialGradient(0, -2, 2, 0, 0, 15 * breathe);
      core.addColorStop(0, "#fff5c8");
      core.addColorStop(0.35, "#eaffff");
      core.addColorStop(1, "rgba(123,228,239,.25)");
      context.fillStyle = core;
      context.beginPath();
      context.moveTo(0, -18 * breathe);
      context.bezierCurveTo(15, -2, 12, 16, 0, 20);
      context.bezierCurveTo(-12, 16, -15, -2, 0, -18 * breathe);
      context.fill();
      context.restore();

      frame = requestAnimationFrame(render);
    };

    resize();
    window.addEventListener("resize", resize);
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const position = { ...targetRef.current };
      const step = 0.06;
      if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a")
        position.x -= step;
      if (event.key === "ArrowRight" || event.key.toLowerCase() === "d")
        position.x += step;
      if (event.key === "ArrowUp" || event.key.toLowerCase() === "w")
        position.y -= step;
      if (event.key === "ArrowDown" || event.key.toLowerCase() === "s")
        position.y += step;
      if (event.code === "Space") {
        event.preventDefault();
        pulse();
        return;
      }
      position.x = Math.min(0.92, Math.max(0.08, position.x));
      position.y = Math.min(0.78, Math.max(0.18, position.y));
      targetRef.current = position;
      setHasMoved(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <main
      aria-label="さみしき星のまたたきよ — 豊かな海を進む生命のしずく"
      style={{ position: "relative", width: "100vw", height: "100dvh" }}
      onPointerMove={(event) => {
        if (event.pointerType === "touch" && event.buttons === 0) return;
        targetRef.current = {
          x: event.clientX / window.innerWidth,
          y: event.clientY / window.innerHeight,
        };
        setHasMoved(true);
      }}
      onPointerDown={(event) => {
        targetRef.current = {
          x: event.clientX / window.innerWidth,
          y: event.clientY / window.innerHeight,
        };
        setHasMoved(true);
        pulse();
      }}
    >
      <canvas ref={canvasRef} aria-label="豊かな珊瑚礁を泳ぐ生命のしずく" />
      <div
        aria-live="polite"
        style={{
          position: "absolute",
          inset: "0 0 auto 0",
          padding: "clamp(18px, 4vw, 44px)",
          pointerEvents: "none",
          textShadow: "0 2px 20px rgba(0,20,34,.72)",
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: "clamp(11px, 1.1vw, 15px)",
            letterSpacing: ".3em",
            opacity: 0.72,
          }}
        >
          TWINKLE, O LONELY STAR
        </p>
        <h1
          style={{
            margin: ".35rem 0 0",
            fontSize: "clamp(22px, 3.2vw, 52px)",
            fontWeight: 400,
            letterSpacing: ".14em",
          }}
        >
          さみしき星のまたたきよ
        </h1>
      </div>
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: "max(24px, env(safe-area-inset-bottom))",
          transform: "translateX(-50%)",
          width: "min(92vw, 620px)",
          textAlign: "center",
          pointerEvents: "none",
          letterSpacing: ".24em",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          fontSize: "clamp(11px, 1.4vw, 15px)",
          textShadow: "0 2px 12px rgba(0,10,22,.9)",
        }}
      >
        <p
          style={{
            margin: 0,
            opacity: hasMoved ? 0.32 : 0.94,
            transition: "opacity .8s",
          }}
        >
          FOLLOW THE FLOW
        </p>
        <p
          style={{
            margin: ".55rem 0 0",
            opacity: hasMoved && !hasPulsed ? 0.94 : 0.32,
            transition: "opacity .8s",
          }}
        >
          GIVE LIFE · TAP / SPACE
        </p>
      </div>
    </main>
  );
}
