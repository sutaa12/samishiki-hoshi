import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

const PLAN_DIGEST = "world-plan-v1:75d93cbb8e0580cd";
const CHECKPOINT_HASH = "4a833c85";

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function waitForProductionRenderer(page: Page) {
  const shell = page.getByTestId("game-shell");
  await expect(shell).toHaveAttribute("data-renderer-status", "ready", { timeout: 120_000 });
  await expect(shell).not.toHaveAttribute("data-actual-backend", "pending");
  return shell;
}

async function expectGameAndRendererMatch(page: Page): Promise<void> {
  const shell = page.getByTestId("game-shell");
  await expect.poll(async () => {
    const values = await Promise.all([
      shell.getAttribute("data-story-time"),
      shell.getAttribute("data-render-story-time"),
      shell.getAttribute("data-position-x"),
      shell.getAttribute("data-render-position-x"),
      shell.getAttribute("data-position-y"),
      shell.getAttribute("data-render-position-y"),
      shell.getAttribute("data-pulses"),
      shell.getAttribute("data-render-pulses"),
      shell.getAttribute("data-answer-at"),
      shell.getAttribute("data-render-answer-at"),
    ]);
    return values[0] === values[1]
      && values[2] === values[3]
      && values[4] === values[5]
      && values[6] === values[7]
      && values[8] === values[9];
  }).toBe(true);
}

async function launchHostMetalBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=metal"],
  });
}

function productionBaseUrl(testInfo: { readonly project: { readonly use: { readonly baseURL?: string } } }): string {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Production renderer gate requires baseURL.");
  return baseURL;
}

test("public root uses the forced WebGL2 v2 runtime and latches live game state", async ({ browser: fixtureBrowser }, testInfo) => {
  void fixtureBrowser;
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop production integration gate");
  test.setTimeout(90_000);
  const browser = await launchHostMetalBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = captureRuntimeErrors(page);
    await page.goto(new URL("/?qa=1&backend=webgl2&seed=20260818&at=48", productionBaseUrl(testInfo)).toString());
    const shell = await waitForProductionRenderer(page);

    await expect(shell).toHaveAttribute("data-actual-backend", "webgl2");
    await expect(shell).toHaveAttribute("data-requested-backend", "webgl2");
    await expect(shell).toHaveAttribute("data-render-quality", "balanced");
    await expect(shell).toHaveAttribute("data-render-plan-digest", PLAN_DIGEST);
    await expect(shell).toHaveAttribute("data-gameplay-hash", CHECKPOINT_HASH);
    await expectGameAndRendererMatch(page);

    await page.getByRole("button", { name: "旅をはじめる" }).click();
    const beforeX = Number(await shell.getAttribute("data-position-x"));
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(400);
    await page.keyboard.up("ArrowRight");
    await expect.poll(async () => Number(await shell.getAttribute("data-position-x"))).toBeGreaterThan(beforeX);
    await page.keyboard.press("Space");
    await expect.poll(async () => Number(await shell.getAttribute("data-pulses"))).toBe(1);
    await expectGameAndRendererMatch(page);

    await page.getByRole("button", { name: "設定を開く" }).click();
    await page.getByLabel("動きを抑える").check();
    await page.getByLabel("高コントラスト").check();
    await page.getByLabel("描画品質").selectOption("low");
    await page.getByRole("button", { name: "旅へ戻る" }).click();
    await expect(shell).toHaveAttribute("data-render-quality", "low");
    await expect(shell).toHaveAttribute("data-render-profile", "low-static");
    await expect(shell).toHaveAttribute("data-render-motion", "reduced");
    await expect(shell).toHaveAttribute("data-render-contrast", "high");
    await expect(page.locator("canvas")).toHaveAttribute("data-render-motion", "reduced");
    await expect(page.locator("canvas")).toHaveAttribute("data-render-contrast", "high");
    await expect.poll(async () => page.locator("canvas").evaluate((canvas) => getComputedStyle(canvas).filter))
      .toContain("contrast(1.2)");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("public root latches the real answer state into the production renderer", async ({ browser: fixtureBrowser }, testInfo) => {
  void fixtureBrowser;
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop answer-state gate");
  test.setTimeout(90_000);
  const browser = await launchHostMetalBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = captureRuntimeErrors(page);
    await page.goto(new URL("/?qa=1&backend=webgl2&seed=20260818&at=166.4", productionBaseUrl(testInfo)).toString());
    const shell = await waitForProductionRenderer(page);
    await page.getByRole("button", { name: "旅をはじめる" }).click();
    await page.keyboard.press("Space");
    await expect.poll(async () => shell.getAttribute("data-answer-at")).not.toBe("");
    await expectGameAndRendererMatch(page);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("public root prefers actual host-Metal WebGPU without changing the checkpoint hash", async ({ browser: fixtureBrowser }, testInfo) => {
  void fixtureBrowser;
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop WebGPU production gate");
  test.setTimeout(90_000);
  const browser = await launchHostMetalBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = captureRuntimeErrors(page);
    await page.goto(new URL("/?qa=1&backend=webgpu&seed=20260818&at=48", productionBaseUrl(testInfo)).toString());
    const shell = await waitForProductionRenderer(page);
    await expect(shell).toHaveAttribute("data-actual-backend", "webgpu");
    await expect(shell).toHaveAttribute("data-requested-backend", "webgpu");
    await expect(shell).toHaveAttribute("data-render-plan-digest", PLAN_DIGEST);
    await expect(shell).toHaveAttribute("data-gameplay-hash", CHECKPOINT_HASH);
    await expectGameAndRendererMatch(page);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("ten same-star restarts keep the production renderer ownership plateau", async ({ browser: fixtureBrowser }, testInfo) => {
  void fixtureBrowser;
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop restart gate");
  test.setTimeout(120_000);
  const browser = await launchHostMetalBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = captureRuntimeErrors(page);
    await page.goto(new URL("/?qa=1&backend=webgl2&speed=60&seed=20260818&at=179.9", productionBaseUrl(testInfo)).toString());
    const shell = await waitForProductionRenderer(page);
    await page.getByRole("button", { name: "旅をはじめる" }).click();
    await expect(shell).toHaveAttribute("data-finished", "true", { timeout: 10_000 });

    const evidence: Array<Record<string, number | string>> = [];
    for (let cycle = 1; cycle <= 10; cycle += 1) {
      await page.getByRole("button", { name: "同じ星を飛ぶ" }).click();
      await expect(shell).toHaveAttribute("data-restarts", String(cycle));
      await expect(shell).toHaveAttribute("data-finished", "true", { timeout: 10_000 });
      await expect(shell).toHaveAttribute("data-render-story-time", "180.00");
      evidence.push({
        cycle,
        programs: Number(await shell.getAttribute("data-render-programs")),
        geometries: Number(await shell.getAttribute("data-render-geometries")),
        gpuOwners: Number(await shell.getAttribute("data-render-gpu-owners")),
        logicalOwners: Number(await shell.getAttribute("data-render-logical-owners")),
        poolSlots: Number(await shell.getAttribute("data-render-pool-slots")),
        resizeListener: await shell.getAttribute("data-render-resize-listener") ?? "missing",
        subscribers: Number(await shell.getAttribute("data-render-subscribers")),
      });
    }

    const baseline = evidence[0];
    expect(baseline).toBeDefined();
    for (const entry of evidence) {
      expect(entry.programs).toBe(baseline.programs);
      expect(entry.geometries).toBe(baseline.geometries);
      expect(entry.gpuOwners).toBe(baseline.gpuOwners);
      expect(entry.logicalOwners).toBe(baseline.logicalOwners);
      expect(entry.poolSlots).toBe(baseline.poolSlots);
      expect(entry.resizeListener).toBe("true");
      expect(entry.subscribers).toBe(baseline.subscribers);
    }
    await testInfo.attach("qx-r3-001-ten-restart-plateau", {
      body: Buffer.from(JSON.stringify(evidence, null, 2)),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
