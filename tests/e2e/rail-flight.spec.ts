import { expect, test, type Page } from "@playwright/test";

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("rail distance advances without input while score and seeds stay zero", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop rail acceptance");
  const errors = captureRuntimeErrors(page);
  await page.goto("/?qa=1&backend=webgl2&seed=20260818");
  const shell = page.getByTestId("game-shell");
  await expect(shell).toHaveAttribute("data-renderer-status", "ready", { timeout: 120_000 });
  await page.getByRole("button", { name: "旅をはじめる" }).click();
  const before = Number(await shell.getAttribute("data-distance-mm"));
  await expect.poll(async () => Number(await shell.getAttribute("data-distance-mm")), { timeout: 4_000 })
    .toBeGreaterThan(before + 3_000);
  await expect(shell).toHaveAttribute("data-score", "0");
  await expect(shell).toHaveAttribute("data-pulses", "0");
  expect(errors).toEqual([]);
});

test("an arbitrary pulse is empty but a nearby Life Node creates exactly one Seed", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop rail acceptance");
  const errors = captureRuntimeErrors(page);

  await page.goto("/?qa=1&backend=webgl2&seed=20260818&at=20");
  let shell = page.getByTestId("game-shell");
  await expect(shell).toHaveAttribute("data-renderer-status", "ready", { timeout: 120_000 });
  await page.getByRole("button", { name: "旅をはじめる" }).click();
  await page.keyboard.press("Space");
  await expect(shell).toHaveAttribute("data-gameplay-event", "pulse-empty");
  await expect(shell).toHaveAttribute("data-pulses", "0");

  await page.goto("/?qa=1&backend=webgl2&seed=20260818&at=24");
  shell = page.getByTestId("game-shell");
  await expect(shell).toHaveAttribute("data-renderer-status", "ready", { timeout: 120_000 });
  await page.getByRole("button", { name: "旅をはじめる" }).click();
  await page.keyboard.press("Space");
  await expect.poll(async () => Number(await shell.getAttribute("data-pulses"))).toBe(1);
  await expect.poll(async () => await shell.getAttribute("data-gameplay-event"))
    .toMatch(/node-perfect|node-good/);
  await page.keyboard.press("Space");
  await expect(shell).toHaveAttribute("data-pulses", "1");
  await expect(shell).toHaveAttribute("data-gameplay-event", "pulse-cooldown");
  expect(errors).toEqual([]);
});

test("the normal journey never synthesizes ANSWER without a valid node pulse", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "desktop rail acceptance");
  const errors = captureRuntimeErrors(page);
  await page.goto("/?qa=1&backend=webgl2&seed=20260818&at=169");
  const shell = page.getByTestId("game-shell");
  await expect(shell).toHaveAttribute("data-renderer-status", "ready", { timeout: 120_000 });
  await page.getByRole("button", { name: "旅をはじめる" }).click();
  await page.waitForTimeout(900);
  await expect(shell).toHaveAttribute("data-answer-at", "");
  await expect(shell).toHaveAttribute("data-render-answer-at", "");
  expect(errors).toEqual([]);
});
