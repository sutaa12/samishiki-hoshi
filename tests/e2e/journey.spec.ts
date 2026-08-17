import { expect, test, type Page } from "@playwright/test";

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
  await expect(page.getByRole("dialog", { name: "旅の設定" })).toBeVisible();
  await page.getByLabel("動きを抑える").check();
  await page.getByLabel("高コントラスト").check();
  await page.getByLabel("音を消す").check();
  await page.getByLabel("描画品質").selectOption("low");
  await page.getByRole("button", { name: "旅へ戻る" }).click();
  await expect(shell).toHaveClass(/is-reduced-motion/);
  await expect(shell).toHaveClass(/is-high-contrast/);

  await captureEvidence(page, ".quality-gates/screenshots/desktop-s05-human-motif.png");
  expect(errors).toEqual([]);
});

test("accelerated journey reaches the exact final title and automatic answer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop acceptance");
  const errors = captureRuntimeErrors(page);
  await page.goto("/?qa=1&speed=60&seed=20260818");
  const shell = page.getByTestId("game-shell");
  await expect(page.getByTestId("qa-metrics")).toBeVisible();
  await page.getByRole("button", { name: "旅をはじめる" }).click();
  await expect(shell).toHaveAttribute("data-finished", "true", { timeout: 12_000 });
  await expect(shell).toHaveAttribute("data-shot", "S24");
  await expect(shell).toHaveAttribute("data-answer-at", "168.50");
  await expect(page.getByRole("heading", { name: "さみしき星のまたたきよ" })).toBeVisible();
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
  await page.getByRole("button", { name: "旅をはじめる" }).tap();
  await expect(shell).toHaveAttribute("data-shot", "S22");
  await page.locator("canvas").tap({ position: { x: 195, y: 410 } });
  await expect.poll(async () => Number(await shell.getAttribute("data-pulses"))).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => await shell.getAttribute("data-answer-at")).not.toBe("");

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
