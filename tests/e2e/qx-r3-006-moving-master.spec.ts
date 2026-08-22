import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

const MASTER_VIEWPORT = Object.freeze({ width: 1_920, height: 1_080 });
const LIFE_MARKERS = Object.freeze([
  "life-node-tutorial",
  "gate-tutorial",
  "gate-life-02",
  "obstacle-life-01",
  "gate-life-03",
  "obstacle-life-02",
  "life-node-life-02",
  "gate-life-04",
  "obstacle-life-03",
  "gate-life-05",
  "life-node-life-03",
]);

function baseUrl(testInfo: { readonly project: { readonly use: { readonly baseURL?: string } } }): string {
  const value = testInfo.project.use.baseURL;
  if (typeof value !== "string") throw new Error("QX-R3-006 requires a Playwright baseURL.");
  return value;
}

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function launchHostMetalBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=metal"],
  });
}

async function waitForMaster(page: Page) {
  const shell = page.getByTestId("game-shell");
  await expect(shell).toHaveAttribute("data-renderer-status", "ready", { timeout: 120_000 });
  await expect(shell).toHaveAttribute("data-render-life-master-mode", "production");
  return shell;
}

test("QX-R3-006 records a 1920x1080 12-second public moving master with real input", async ({ browser: fixtureBrowser }, testInfo) => {
  void fixtureBrowser;
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop moving-master gate");
  test.setTimeout(210_000);
  const browser = await launchHostMetalBrowser();
  const videoDirectory = ".quality-gates/qx-r3-006-video-raw";
  const context = await browser.newContext({
    viewport: MASTER_VIEWPORT,
    recordVideo: { dir: videoDirectory, size: MASTER_VIEWPORT },
  });
  const page = await context.newPage();
  const video = page.video();
  const errors = captureRuntimeErrors(page);
  try {
    await page.goto(new URL(
      "/?qa=1&backend=webgl2&quality=high&seed=20260818&at=4&speed=1",
      baseUrl(testInfo),
    ).toString());
    const shell = await waitForMaster(page);
    await expect(shell).toHaveAttribute("data-actual-backend", "webgl2");
    await expect(shell).toHaveAttribute("data-render-quality", "high");
    await expect(shell).toHaveAttribute("data-render-life-master-camera-owned", "false");
    await expect(shell).toHaveAttribute("data-render-life-master-environment-owned", "false");
    await expect(shell).toHaveAttribute("data-render-life-master-white-point-k", "6500");
    await expect(shell).toHaveAttribute("data-render-life-master-gates", "5");
    await expect(shell).toHaveAttribute("data-render-life-master-obstacles", "3");
    await expect(shell).toHaveAttribute("data-render-life-master-nodes", "3");
    await expect(shell).toHaveAttribute("data-render-life-master-marker-ids", LIFE_MARKERS.join(","));
    await expect(shell).toHaveAttribute("data-render-life-master-non-emissive-basic", "0");
    await expect(shell).toHaveAttribute("data-render-life-master-runtime-allocations", "0");

    const startPrograms = Number(await shell.getAttribute("data-render-programs"));
    const startScreenshot = testInfo.outputPath("qx-r3-006-master-start.png");
    await page.screenshot({ path: startScreenshot });
    await testInfo.attach("qx-r3-006-master-start", { path: startScreenshot, contentType: "image/png" });

    await page.getByRole("button", { name: "旅をはじめる" }).click();
    // A 30% ArrowDown duty cycle is a real digital steer input that preserves
    // the tutorial lane. Space is pressed at the tutorial node near 5.5 s.
    for (let second = 0; second < 12; second += 1) {
      await page.keyboard.down("ArrowDown");
      await page.waitForTimeout(300);
      await page.keyboard.up("ArrowDown");
      if (second === 1) {
        await page.waitForTimeout(200);
        await page.keyboard.press("Space");
        await page.waitForTimeout(500);
      } else {
        await page.waitForTimeout(700);
      }
      if (second === 5) {
        const midpointScreenshot = testInfo.outputPath("qx-r3-006-master-midpoint.png");
        await page.screenshot({ path: midpointScreenshot });
        await testInfo.attach("qx-r3-006-master-midpoint", {
          path: midpointScreenshot,
          contentType: "image/png",
        });
      }
    }

    await expect.poll(async () => Number(await shell.getAttribute("data-story-time")), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(15.8);
    await expect(shell).toHaveAttribute("data-pulses", "1");
    await expect(shell).toHaveAttribute("data-steer-learned", "true");
    await expect(shell).toHaveAttribute("data-pulse-learned", "true");
    await expect(shell).toHaveAttribute("data-gameplay-event", "obstacle-near-miss");
    await expect(shell).toHaveAttribute("data-render-life-master-runtime-allocations", "0");
    expect(Number(await shell.getAttribute("data-render-programs"))).toBe(startPrograms);

    const endScreenshot = testInfo.outputPath("qx-r3-006-master-end.png");
    await page.screenshot({ path: endScreenshot });
    await testInfo.attach("qx-r3-006-master-end", { path: endScreenshot, contentType: "image/png" });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await context.close();
    if (video) {
      await testInfo.attach("qx-r3-006-moving-master-raw", {
        path: await video.path(),
        contentType: "video/webm",
      });
    }
    await browser.close();
  }
});

test("QX-R3-006 High WebGPU and forced WebGL2 keep one camera, world, and hash", async ({ browser: fixtureBrowser }, testInfo) => {
  void fixtureBrowser;
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop backend-parity gate");
  test.setTimeout(210_000);
  const browser = await launchHostMetalBrowser();
  try {
    const results: Array<Record<string, string | null>> = [];
    for (const backend of ["webgpu", "webgl2"] as const) {
      const page = await browser.newPage({ viewport: MASTER_VIEWPORT });
      const errors = captureRuntimeErrors(page);
      await page.goto(new URL(
        `/?qa=1&backend=${backend}&quality=high&seed=20260818&at=18&speed=1`,
        baseUrl(testInfo),
      ).toString());
      const shell = await waitForMaster(page);
      results.push(await shell.evaluate((element) => ({
        actualBackend: element.getAttribute("data-actual-backend"),
        requestedBackend: element.getAttribute("data-requested-backend"),
        hash: element.getAttribute("data-gameplay-hash"),
        plan: element.getAttribute("data-render-plan-digest"),
        cameraX: element.getAttribute("data-render-camera-position-x"),
        cameraY: element.getAttribute("data-render-camera-position-y"),
        cameraZ: element.getAttribute("data-render-camera-position-z"),
        targetX: element.getAttribute("data-render-camera-target-x"),
        targetY: element.getAttribute("data-render-camera-target-y"),
        targetZ: element.getAttribute("data-render-camera-target-z"),
        markers: element.getAttribute("data-render-life-master-marker-ids"),
        humanVisible: element.getAttribute("data-render-life-master-human-visible"),
      })));
      expect(errors).toEqual([]);
      await page.close();
    }

    expect(results[0]).toMatchObject({ actualBackend: "webgpu", requestedBackend: "webgpu" });
    expect(results[1]).toMatchObject({ actualBackend: "webgl2", requestedBackend: "webgl2" });
    const comparable = (entry: Record<string, string | null>) => ({
      hash: entry.hash,
      plan: entry.plan,
      cameraX: entry.cameraX,
      cameraY: entry.cameraY,
      cameraZ: entry.cameraZ,
      targetX: entry.targetX,
      targetY: entry.targetY,
      targetZ: entry.targetZ,
      markers: entry.markers,
      humanVisible: entry.humanVisible,
    });
    expect(comparable(results[0]!)).toEqual(comparable(results[1]!));
    await testInfo.attach("qx-r3-006-high-webgpu-webgl2-parity", {
      body: Buffer.from(JSON.stringify(results, null, 2)),
      contentType: "application/json",
    });
  } finally {
    await browser.close();
  }
});

test("QX-R3-006 forms remain present with fog and CSS particles disabled", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop forms-only gate");
  test.setTimeout(150_000);
  const errors = captureRuntimeErrors(page);
  await page.setViewportSize(MASTER_VIEWPORT);
  await page.goto(new URL(
    "/?qa=1&backend=webgl2&quality=high&seed=20260818&at=18&speed=1&forms=1",
    baseUrl(testInfo),
  ).toString());
  const shell = await waitForMaster(page);
  await expect(shell).toHaveAttribute("data-render-forms-only", "true");
  await expect(shell).toHaveAttribute("data-render-scene-fog-active", "false");
  await expect(page.getByTestId("phase-particle-layer")).toBeHidden();
  await expect(shell).toHaveAttribute("data-render-life-master-gates", "5");
  await expect(shell).toHaveAttribute("data-render-life-master-obstacles", "3");
  await expect(shell).toHaveAttribute("data-render-life-master-nodes", "3");
  await expect(shell).toHaveAttribute("data-render-life-master-human-visible", "true");
  const screenshot = testInfo.outputPath("qx-r3-006-forms-only.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("qx-r3-006-forms-only", { path: screenshot, contentType: "image/png" });
  expect(errors).toEqual([]);
});
