import { expect, test } from "@playwright/test";

test("records the 30-second QX-R3-002 graybox rail loop", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop evidence recording");
  test.setTimeout(120_000);
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Graybox recording requires a Playwright baseURL.");

  const videoDir = testInfo.outputPath("rail-graybox-video");
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const video = page.video();
  await page.goto(new URL("/?qa=1&backend=webgl2&seed=20260818&speed=10", baseURL).toString());
  const shell = page.getByTestId("game-shell");
  await expect(shell).toHaveAttribute("data-renderer-status", "ready", { timeout: 120_000 });
  await page.getByRole("button", { name: "旅をはじめる" }).click();

  await page.keyboard.press("Space");
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(3_200);
  await page.keyboard.up("ArrowRight");
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(1_500);
  await page.keyboard.up("ArrowUp");
  await page.keyboard.press("Space");
  await page.keyboard.down("ArrowLeft");
  await page.waitForTimeout(5_300);
  await page.keyboard.up("ArrowLeft");
  await page.keyboard.down("ArrowDown");
  await page.waitForTimeout(4_000);
  await page.keyboard.up("ArrowDown");
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(5_000);
  await page.keyboard.up("ArrowRight");
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(4_800);
  await page.keyboard.up("ArrowUp");
  await page.keyboard.press("Space");
  await page.keyboard.down("ArrowLeft");
  await page.waitForTimeout(5_000);
  await page.keyboard.up("ArrowLeft");

  await expect.poll(async () => Number(await shell.getAttribute("data-distance-mm")))
    .toBeGreaterThan(250_000);
  await context.close();
  if (!video) throw new Error("Playwright did not create the graybox video.");
  await video.saveAs(".quality-gates/qx-r3-002-graybox-30s.webm");
});
