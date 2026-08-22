import { expect, test, type Page } from "@playwright/test";
import type { JourneyPhase, QualityLevel } from "../../src/game/model";

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function captureEvidence(page: Page, path: string, settleMs = 0): Promise<void> {
  if (settleMs > 0) await page.waitForTimeout(settleMs);
  await page.getByTestId("qa-metrics").evaluate((element) => {
    (element as HTMLElement).style.display = "none";
  });
  await page.screenshot({ path });
}

test("desktop steering, pulse, settings, and human motif checkpoint", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop acceptance");
  const errors = captureRuntimeErrors(page);
  await page.goto("/?qa=1&speed=1&at=24&seed=20260818");
  const shell = page.getByTestId("game-shell");
  await expect(page.getByTestId("qa-metrics")).toBeVisible();
  await expect(shell).toHaveAttribute("data-webgl", "true");
  await page.getByRole("button", { name: "旅をはじめる" }).click();
  await expect(shell).toHaveAttribute("data-shot", "S05");

  const canvas = page.locator("canvas");
  await canvas.click({ position: { x: 720, y: 340 } });
  await expect.poll(async () => Number(await shell.getAttribute("data-pulses"))).toBeGreaterThanOrEqual(1);

  const beforeX = Number(await shell.getAttribute("data-position-x"));
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(350);
  await page.keyboard.up("ArrowRight");
  await expect.poll(async () => Number(await shell.getAttribute("data-position-x"))).toBeGreaterThan(beforeX);

  await page.getByRole("button", { name: "設定を開く" }).click();
  const dialog = page.getByRole("dialog", { name: "旅の設定" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("button", { name: "設定を閉じる" })).toBeFocused();
  await expect(page.locator("canvas")).toHaveAttribute("inert", "");
  await page.getByLabel("動きを抑える").check();
  await page.getByLabel("高コントラスト").check();
  await page.getByLabel("音を消す").check();
  await page.getByLabel("描画品質").selectOption("low");
  await page.getByRole("button", { name: "旅へ戻る" }).click();
  await expect(page.getByRole("button", { name: "設定を開く" })).toBeFocused();
  await expect(shell).toHaveClass(/is-reduced-motion/);
  await expect(shell).toHaveClass(/is-high-contrast/);

  await captureEvidence(page, ".quality-gates/screenshots/desktop-s05-human-motif.png");
  expect(errors).toEqual([]);
});

test("Notion-reference phase gallery renders every natural-to-space transition", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop visual acceptance");
  const errors = captureRuntimeErrors(page);
  const checkpoints = [
    { at: 10, phase: "LIFE", shot: "S03", file: "desktop-ref-life.png" },
    { at: 48, phase: "EARTH", shot: "S08", file: "desktop-ref-earth.png" },
    { at: 105, phase: "ASCENT", shot: "S14", file: "desktop-ref-ascent.png" },
    { at: 142, phase: "SOLITUDE", shot: "S18", file: "desktop-ref-solitude.png" },
  ] as const;

  for (const checkpoint of checkpoints) {
    await page.goto(`/?qa=1&speed=1&at=${checkpoint.at}&seed=20260818`);
    const shell = page.getByTestId("game-shell");
    await expect(page.getByTestId("qa-metrics")).toBeVisible();
    await page.getByRole("button", { name: "旅をはじめる" }).click();
    await expect(shell).toHaveAttribute("data-phase", checkpoint.phase);
    await expect(shell).toHaveAttribute("data-shot", checkpoint.shot);
    await captureEvidence(page, `.quality-gates/screenshots/${checkpoint.file}`, 450);
  }
  expect(errors).toEqual([]);
});

test("all six phases keep visual density inside automated safety ceilings", async ({ page }, testInfo) => {
  // This deliberately performs a fresh navigation for every phase/quality so
  // shader startup is isolated from each steady-state sample generation.
  // SwiftShader needs more wall time than the normal interaction tests.
  test.setTimeout(testInfo.project.name === "mobile-chromium" ? 90_000 : 150_000);
  const errors = captureRuntimeErrors(page);
  const checkpoints = [
    { at: 10, phase: "LIFE" },
    { at: 48, phase: "EARTH" },
    { at: 105, phase: "ASCENT" },
    { at: 142, phase: "SOLITUDE" },
    { at: 166, phase: "ANSWER" },
    { at: 176, phase: "TWINKLE" },
  ] as const;
  const qualities: QualityLevel[] = testInfo.project.name === "mobile-chromium" ? ["low"] : ["low", "high"];
  // QX-R3-001 connects the already accepted v2 foundation whose current
  // per-frame inventory is larger than the retired canvas renderer. This is
  // a connection-regression guard, not a replacement for the stricter target
  // budgets and reference-hardware gate documented in GFX_REBASELINE_PLAN.
  const productionConnectionDrawCeiling = 600;
  const samples: Array<{
    quality: QualityLevel;
    phase: JourneyPhase;
    drawCalls: number;
    triangles: number;
    p95FrameMs: number;
    frameSamples: number;
    warmupMs: number;
  }> = [];

  for (const quality of qualities) {
    for (const checkpoint of checkpoints) {
      await page.goto(`/?qa=1&speed=1&at=${checkpoint.at}&seed=20260818&quality=${quality}`);
      const shell = page.getByTestId("game-shell");
      const metrics = page.getByTestId("qa-metrics");
      await page.getByRole("button", { name: "旅をはじめる" }).click();
      await expect(shell).toHaveAttribute("data-phase", checkpoint.phase);
      await expect(metrics).toHaveAttribute("data-quality", quality);
      await expect(metrics).toHaveAttribute("data-frame-metric", "gfx-v2-raf-interval");
      await expect(metrics).toHaveAttribute("data-frame-metrics-ready", "true", { timeout: 6_000 });
      const drawCalls = Number(await metrics.getAttribute("data-draw-calls"));
      const triangles = Number(await metrics.getAttribute("data-triangles"));
      const p95FrameMs = Number(await metrics.getAttribute("data-p95-frame-ms"));
      const frameSamples = Number(await metrics.getAttribute("data-frame-samples"));
      const warmupMs = Number(await metrics.getAttribute("data-frame-warmup-ms"));
      samples.push({
        quality,
        phase: checkpoint.phase,
        drawCalls,
        triangles,
        p95FrameMs,
        frameSamples,
        warmupMs,
      });
      const sampleLabel = `${testInfo.project.name}/${quality}/${checkpoint.phase}`;
      expect.soft(drawCalls, `${sampleLabel} draw calls`).toBeGreaterThan(0);
      expect.soft(drawCalls, `${sampleLabel} connection draw-call ceiling`).toBeLessThanOrEqual(productionConnectionDrawCeiling);
      expect.soft(triangles, `${sampleLabel} triangles`).toBeGreaterThan(0);
      expect.soft(triangles, `${sampleLabel} triangle ceiling`).toBeLessThanOrEqual(250_000);
      expect.soft(frameSamples, `${sampleLabel} steady sample count`).toBeGreaterThanOrEqual(120);
      expect.soft(warmupMs, `${sampleLabel} fixed startup warmup`).toBe(0);
      expect.soft(p95FrameMs, `${sampleLabel} measured P95`).toBeGreaterThan(0);
      expect.soft(p95FrameMs, `${sampleLabel} steady P95 ceiling`).toBeLessThanOrEqual(50);
    }
  }

  await testInfo.attach("visual-performance-samples", {
    body: Buffer.from(JSON.stringify(samples, null, 2)),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
});

test("S20 keeps the unknown craft as a peripheral silhouette", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop timeline acceptance");
  const errors = captureRuntimeErrors(page);
  await page.goto("/?qa=1&speed=1&at=155.5&seed=20260818");
  const shell = page.getByTestId("game-shell");
  await expect(page.getByTestId("qa-metrics")).toBeVisible();
  await page.getByRole("button", { name: "旅をはじめる" }).click();
  await expect(shell).toHaveAttribute("data-phase", "SOLITUDE");
  await expect(shell).toHaveAttribute("data-shot", "S20");
  await expect(shell).toHaveAttribute("data-alien-state", "silhouette");
  await expect(page.getByTestId("assistive-status")).not.toContainText(/未知|三本|三枚|リボン|船|操縦席/);
  await captureEvidence(page, ".quality-gates/screenshots/desktop-s20-silhouette.png", 500);
  expect(errors).toEqual([]);
});

test("final journey checkpoint reaches the exact title and automatic answer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop acceptance");
  const errors = captureRuntimeErrors(page);
  // The simulation's full 180-second fixed-step path is covered by unit and
  // replay tests. Start immediately before the ending here so this UI gate
  // does not turn the production streamer's 60x QA seek into a requirement.
  await page.goto("/?qa=1&speed=1&at=179.9&seed=20260818");
  const shell = page.getByTestId("game-shell");
  await expect(page.getByTestId("qa-metrics")).toBeVisible();
  await page.getByRole("button", { name: "旅をはじめる" }).click();
  await expect(shell).toHaveAttribute("data-finished", "true", { timeout: 12_000 });
  await expect(shell).toHaveAttribute("data-shot", "S24");
  await expect(shell).toHaveAttribute("data-answer-at", "168.50");
  await expect(page.getByRole("heading", { name: "さみしき星のまたたきよ" })).toBeVisible();
  await expect(page.locator(".journey-progress, .corner-meta, .settings-button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "同じ星を飛ぶ" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新しい星へ" })).toBeVisible();
  await expect(page.getByRole("button", { name: "光景を残す" })).toBeVisible();
  await captureEvidence(page, ".quality-gates/screenshots/desktop-final.png", 1_900);
  expect(errors).toEqual([]);
});

test("mobile touch, settings, and alien response remain usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile acceptance");
  const errors = captureRuntimeErrors(page);
  await page.goto("/?qa=1&speed=1&at=166&seed=20260818");
  const shell = page.getByTestId("game-shell");
  await expect(page.getByTestId("qa-metrics")).toBeVisible();
  const legendStyle = await page.locator(".start-controls").evaluate((element) => {
    const style = getComputedStyle(element);
    return { fontSize: Number.parseFloat(style.fontSize), background: style.backgroundColor, color: style.color };
  });
  expect(legendStyle.fontSize).toBeGreaterThanOrEqual(12);
  expect(legendStyle.background).not.toBe("rgba(0, 0, 0, 0)");
  await page.getByRole("button", { name: "旅をはじめる" }).tap();
  await expect(shell).toHaveAttribute("data-shot", "S22");
  await expect(shell).toHaveAttribute("data-alien-state", "revealed");
  await page.locator("canvas").tap({ position: { x: 195, y: 410 } });
  await expect.poll(async () => Number(await shell.getAttribute("data-pulses"))).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => await shell.getAttribute("data-answer-at")).not.toBe("");
  const hintStyle = await page.locator(".control-hints").evaluate((element) => {
    const container = getComputedStyle(element);
    const learned = getComputedStyle(element.querySelector("p.is-learned") ?? element.querySelector("p")!);
    return {
      fontSize: Number.parseFloat(learned.fontSize),
      opacity: Number.parseFloat(learned.opacity),
      background: container.backgroundColor,
    };
  });
  expect(hintStyle.fontSize).toBeGreaterThanOrEqual(12);
  expect(hintStyle.opacity).toBeGreaterThanOrEqual(0.55);
  expect(hintStyle.background).not.toBe("rgba(0, 0, 0, 0)");

  await page.getByRole("button", { name: "設定を開く" }).tap();
  await expect(page.getByRole("dialog", { name: "旅の設定" })).toBeVisible();
  await page.getByLabel("生命を自動でわたす").check();
  await page.getByLabel("広い流れ").check();
  await page.getByRole("button", { name: "旅へ戻る" }).tap();
  const fitsViewport = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fitsViewport).toBe(true);
  await captureEvidence(page, ".quality-gates/screenshots/mobile-s22-alien.png");
  expect(errors).toEqual([]);
});

test("compact 320 by 568 ending keeps two title lines and 44px actions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "compact acceptance");
  const errors = captureRuntimeErrors(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/?qa=1&speed=60&at=177.5&seed=20260818");
  const shell = page.getByTestId("game-shell");
  await expect(page.getByTestId("qa-metrics")).toBeVisible();
  await page.getByRole("button", { name: "旅をはじめる" }).click();
  await expect(shell).toHaveAttribute("data-finished", "true", { timeout: 8_000 });
  await expect(shell).toHaveAttribute("data-alien-state", "revealed");

  const titleLines = page.locator(".formal-title .title-line");
  await expect(titleLines).toHaveCount(2);
  const lineBoxes = await titleLines.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { top: box.top, height: box.height, width: box.width };
  }));
  expect(Math.abs(lineBoxes[0].top - lineBoxes[1].top)).toBeGreaterThan(10);
  expect(lineBoxes.every((box) => box.width <= 280)).toBe(true);

  for (const name of ["同じ星を飛ぶ", "新しい星へ", "光景を残す"]) {
    const box = await page.getByRole("button", { name }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator(".final-tagline")).toHaveCount(0);
  await expect(page.getByText("TWINKLE, O LONELY STAR", { exact: true })).toHaveCount(0);
  const titleBox = await page.locator(".formal-title h1").boundingBox();
  const actionsBox = await page.locator(".end-actions").boundingBox();
  expect((titleBox?.y ?? 999) + (titleBox?.height ?? 999)).toBeLessThan(actionsBox?.y ?? 0);
  await captureEvidence(page, ".quality-gates/screenshots/compact-final.png", 1_900);
  expect(errors).toEqual([]);
});
