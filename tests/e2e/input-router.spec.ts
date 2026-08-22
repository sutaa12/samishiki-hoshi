import { expect, test, type Page } from "@playwright/test";

async function startAt(page: Page, at: number) {
  await page.goto(`/?qa=1&backend=webgl2&seed=20260818&at=${at}`);
  const shell = page.getByTestId("game-shell");
  await expect(shell).toHaveAttribute("data-renderer-status", "ready", { timeout: 120_000 });
  const start = page.getByRole("button", { name: "旅をはじめる" });
  if (await start.isVisible()) await start.click();
  return shell;
}

async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y, id: 17, radiusX: 4, radiusY: 4, force: 1 }],
  });
  await session.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: to.x, y: to.y, id: 17, radiusX: 4, radiusY: 4, force: 1 }],
  });
  await page.waitForTimeout(300);
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
}

test("mouse click and Space emit one edge each while mouse drag emits none", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop input acceptance");
  const shell = await startAt(page, 20);

  const beforeClick = Number(await shell.getAttribute("data-gameplay-events"));
  await page.mouse.click(520, 400);
  await expect.poll(async () => Number(await shell.getAttribute("data-gameplay-events"))).toBe(beforeClick + 1);

  const beforeDrag = Number(await shell.getAttribute("data-gameplay-events"));
  await page.mouse.move(420, 400);
  await page.mouse.down();
  await page.mouse.move(620, 400, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  expect(Number(await shell.getAttribute("data-gameplay-events"))).toBe(beforeDrag);

  const beforeSpace = Number(await shell.getAttribute("data-gameplay-events"));
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", repeat: false }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", repeat: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
  });
  await expect.poll(async () => Number(await shell.getAttribute("data-gameplay-events"))).toBe(beforeSpace + 1);
});

test("left touch drag steers without a pulse and right touch tap creates one Seed", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile input acceptance");
  let shell = await startAt(page, 1);
  const beforeDragPulses = Number(await shell.getAttribute("data-pulses"));
  const beforeDragX = Number(await shell.getAttribute("data-position-x"));
  await touchDrag(page, { x: 70, y: 430 }, { x: 230, y: 430 });
  await page.waitForTimeout(250);
  expect(Number(await shell.getAttribute("data-pulses"))).toBe(beforeDragPulses);
  expect(Number(await shell.getAttribute("data-position-x"))).toBeGreaterThan(beforeDragX);

  shell = await startAt(page, 24);
  const beforeTapEvents = Number(await shell.getAttribute("data-gameplay-events"));
  await page.touchscreen.tap(340, 410);
  await expect.poll(async () => Number(await shell.getAttribute("data-pulses"))).toBe(1);
  await expect.poll(async () => Number(await shell.getAttribute("data-gameplay-events"))).toBe(beforeTapEvents + 1);
  await expect.poll(async () => await shell.getAttribute("data-gameplay-event"))
    .toMatch(/node-perfect|node-good/);
});

test("settings, cancel, blur, and visibility changes cannot leak held input", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile input isolation acceptance");
  const shell = await startAt(page, 20);
  const beforeSettings = Number(await shell.getAttribute("data-gameplay-events"));
  await page.getByRole("button", { name: "設定を開く" }).tap();
  await page.getByLabel("広い流れ").check();
  await page.getByRole("button", { name: "旅へ戻る" }).tap();
  await page.waitForTimeout(250);
  expect(Number(await shell.getAttribute("data-gameplay-events"))).toBe(beforeSettings);

  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 80, y: 430, id: 23, radiusX: 4, radiusY: 4, force: 1 }],
  });
  await expect(shell).toHaveAttribute("data-input-pointer-active", "true");
  await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await expect(shell).toHaveAttribute("data-input-pointer-active", "false");
  await session.detach();

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down("ArrowRight");
  await expect(shell).toHaveAttribute("data-input-held-keys", "1");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(shell).toHaveAttribute("data-input-held-keys", "0");

  await page.keyboard.down("ArrowLeft");
  await expect(shell).toHaveAttribute("data-input-held-keys", "1");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(shell).toHaveAttribute("data-input-held-keys", "0");
  await page.keyboard.up("ArrowLeft");
  await page.keyboard.up("ArrowRight");
});
