import { chromium } from "@playwright/test";

const baseUrl = process.argv[2] ?? "http://localhost:3000";
const outputPath = new URL("../public/og.png", import.meta.url).pathname;
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader"],
});

try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
  });
  await page.goto(`${baseUrl}/?qa=1&speed=1&at=179.05&seed=20260818`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "旅をはじめる" }).click();
  await page.locator('[data-testid="game-shell"][data-shot="S24"]').waitFor();
  await page.locator(".formal-title.is-finished").waitFor({ timeout: 4_000 });
  await page.locator(".end-actions").waitFor();
  await page.waitForTimeout(1_250);
  await page.getByTestId("qa-metrics").evaluate((element) => {
    element.style.display = "none";
  });
  await page.screenshot({ path: outputPath });
  process.stdout.write(`${outputPath}\n`);
} finally {
  await browser.close();
}
