import { chromium, expect, test, type Page } from "@playwright/test";
import type { GfxFoundationSnapshot } from "../../src/gfx/v2/integration/foundation-runtime";

const HERO_PLAN_DIGEST = "world-plan-v1:75d93cbb8e0580cd";

type HeroSnapshot = Readonly<GfxFoundationSnapshot>;

async function snapshot(page: Page): Promise<HeroSnapshot> {
  const value = await page.getByTestId("gfx-hero-c-snapshot").textContent();
  if (!value || value === "initializing") throw new Error("Hero Slice C snapshot is unavailable.");
  return JSON.parse(value) as HeroSnapshot;
}

async function waitForSnapshot(
  page: Page,
  predicate: (value: HeroSnapshot) => boolean,
  timeout = 10_000,
): Promise<HeroSnapshot> {
  await expect.poll(async () => predicate(await snapshot(page)), { timeout }).toBe(true);
  return snapshot(page);
}

function expectRuntimeBounded(value: HeroSnapshot): void {
  expect(value.pipeline).toMatchObject({
    state: "ready",
    runtimeCompileEvents: 0,
    programGrowthAfterReady: 0,
  });
  expect(value.backendLifecycle.resources.pendingUploads).toBe(0);
  expect(value.chunks.workerInboxCount).toBe(0);
  expect(value.chunks.placeholderChunkIds).toEqual([]);
  expect(value.chunks.activeChunkIds).toEqual(value.chunks.desiredChunkIds);
  expect(value.chunks.gpuOwnedCount).toBe(value.chunks.desiredChunkIds.length);
  expect(value.chunks.gpuOwnedCount).toBeGreaterThan(0);
  expect(value.chunks.gpuOwnedCount).toBeLessThanOrEqual(4);
  expect(value.chunks.uploadQueue).toMatchObject({
    pending: 0,
    failed: 0,
    orphanLeaseCount: 0,
    orphanJobCount: 0,
  });
  expect(value.telemetry.runtimeSpikesOver50Ms).toBe(0);
  for (const event of value.telemetry.events) {
    if (event.kind !== "upload" && event.kind !== "activation") continue;
    expect(event.durationMs, `${event.kind} event duration`).toBeLessThanOrEqual(50);
  }
}

function chunksSettled(value: HeroSnapshot): boolean {
  return value.chunks.workerInboxCount === 0
    && value.chunks.uploadQueue.pending === 0
    && value.chunks.placeholderChunkIds.length === 0
    && value.chunks.activeChunkIds.length === value.chunks.desiredChunkIds.length
    && value.chunks.gpuOwnedCount === value.chunks.desiredChunkIds.length;
}

test.describe("R2-G5 Hero Slice C real browser candidate", () => {
  test.skip(({ isMobile }) => isMobile, "Hero Slice C is reviewed at the required 1920×1080 desktop size.");

  test("binds debris, S20 arcs, three-shell answer, and Twinkle without runtime growth", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1_920, height: 1_080 });
    await page.goto("/gfx-hero-c?backend=webgl2&qa=1");
    await expect(page.getByTestId("gfx-hero-c")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("gfx-hero-c")).toHaveAttribute("data-actual-backend", "webgl2");

    const debris = await waitForSnapshot(page, (value) => (
      value.heroC?.storyTime === 142
      && value.chunks.focusChunkId === "S18"
      && value.chunks.activeChunkIds.length === 4
      && chunksSettled(value)
    ));
    expect(page.viewportSize()).toEqual({ width: 1_920, height: 1_080 });
    expect(debris.planDigest).toBe(HERO_PLAN_DIGEST);
    expect(debris.heroA).toBeNull();
    expect(debris.heroB).toBeNull();
    expect(debris.heroC).toMatchObject({
      state: "ready",
      storyTime: 142,
      shotId: "S18",
      qualityTier: "high",
      humanDebrisVisible: true,
      humanDebrisForms: 7,
      humanGrammarRectilinear: true,
      amberBeaconVisible: true,
      machineReactivated: false,
      nebulaVisible: false,
      peripheralArcsVisible: false,
      unknownShipVisible: false,
      visibleTwinkles: 0,
      allocationsAfterInitialize: 0,
    });
    if (!debris.heroC) throw new Error("Hero Slice C ownership evidence is unavailable.");
    expect(debris.heroC.ownedGeometries).toBeGreaterThan(0);
    expect(debris.heroC.ownedMaterials).toBeGreaterThan(0);
    expect(debris.heroC.ownedTextures).toBe(0);
    expect(debris.heroC.ownedObjects).toBeGreaterThan(0);
    expectRuntimeBounded(debris);
    await testInfo.attach("hero-c-webgl2-142s-human-debris", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    const baselinePrograms = debris.pipeline.programCountAtReady;
    const baselineGeometries = debris.backendLifecycle.resources.geometries;
    const baselineHeroOwnership = Object.freeze({
      ownedGeometries: debris.heroC.ownedGeometries,
      ownedMaterials: debris.heroC.ownedMaterials,
      ownedTextures: debris.heroC.ownedTextures,
      ownedObjects: debris.heroC.ownedObjects,
    });

    await page.getByRole("button", { name: "158s Arcs" }).click();
    const arcs = await waitForSnapshot(page, (value) => (
      value.heroC?.storyTime === 158
      && value.chunks.focusChunkId === "S20"
      && chunksSettled(value)
    ));
    expect(arcs.heroC).toMatchObject({
      humanDebrisVisible: false,
      nebulaVisible: true,
      darkNegativeSpaceClear: true,
      peripheralArcsVisible: true,
      peripheralArcCount: 3,
      peripheralArcsIncomplete: true,
      unknownShipVisible: false,
      alienRibbonShellCount: 0,
      centralVoidOpen: false,
      visibleTwinkles: 0,
      allocationsAfterInitialize: 0,
    });
    expect(arcs.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(arcs.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(arcs.heroC).toMatchObject(baselineHeroOwnership);
    expectRuntimeBounded(arcs);
    await testInfo.attach("hero-c-webgl2-158s-peripheral-arcs", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    await page.getByRole("button", { name: "166s Answer" }).click();
    const answer = await waitForSnapshot(page, (value) => (
      value.heroC?.storyTime === 166
      && value.chunks.focusChunkId === "S22"
      && chunksSettled(value)
    ));
    expect(answer.heroC).toMatchObject({
      peripheralArcsVisible: false,
      peripheralArcCount: 0,
      unknownShipVisible: true,
      alienRibbonShellCount: 3,
      alienRibbonInventory: 3,
      closedBsplineShells: true,
      parallelTransportFrames: true,
      constrainedSuperformulaSections: true,
      centralVoidOpen: true,
      alienUsesHumanGrammar: false,
      alienHasCockpitWindowThrusterOrFront: false,
      responseWindowOpen: true,
      answerReceived: false,
      visibleTwinkles: 0,
      allocationsAfterInitialize: 0,
    });
    expect(answer.heroC?.minimumShipVertexRadius).toBeGreaterThan(1.5);
    expect(answer.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(answer.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(answer.heroC).toMatchObject(baselineHeroOwnership);
    expectRuntimeBounded(answer);
    await testInfo.attach("hero-c-webgl2-166s-three-ribbon-answer", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    await page.getByRole("button", { name: "176s Twinkle" }).click();
    const twinkle = await waitForSnapshot(page, (value) => (
      value.heroC?.storyTime === 176
      && value.chunks.focusChunkId === "S23"
      && chunksSettled(value)
    ));
    expect(twinkle.heroC).toMatchObject({
      unknownShipVisible: true,
      alienRibbonShellCount: 3,
      centralVoidOpen: true,
      answerReceived: true,
      protagonistWingsOpen: true,
      earthVisible: true,
      twinkleStage: "many",
      visibleTwinkles: 160,
      twinkleSourceCount: 3,
      ledgerOrderPreserved: true,
      finalLifeLightsTemporalStable: true,
      allocationsAfterInitialize: 0,
    });
    expect(twinkle.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(twinkle.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(twinkle.heroC).toMatchObject(baselineHeroOwnership);
    expectRuntimeBounded(twinkle);
    await testInfo.attach("hero-c-webgl2-176s-many-life-lights", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    await page.getByRole("button", { name: "Fallback" }).click();
    const fallback = await waitForSnapshot(page, (value) => value.quality.id === "low-static");
    expect(fallback.heroC).toMatchObject({
      qualityTier: "low",
      alienRibbonShellCount: 3,
      centralVoidOpen: true,
      visibleTwinkles: 64,
      twinkleSourceCount: 3,
      allocationsAfterInitialize: 0,
    });
    expect(fallback.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(fallback.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(fallback.heroC).toMatchObject(baselineHeroOwnership);
    expectRuntimeBounded(fallback);

    await page.getByRole("button", { name: "High", exact: true }).click();
    const restored = await waitForSnapshot(page, (value) => value.quality.id === "high-temporal");
    expect(restored.heroC).toMatchObject({
      qualityTier: "high",
      visibleTwinkles: 160,
      alienRibbonShellCount: 3,
      centralVoidOpen: true,
      allocationsAfterInitialize: 0,
    });
    expect(restored.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(restored.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(restored.heroC).toMatchObject(baselineHeroOwnership);
    expectRuntimeBounded(restored);

    await page.getByRole("button", { name: "179s Title" }).click();
    const title = await waitForSnapshot(
      page,
      (value) => value.heroC?.storyTime === 179 && chunksSettled(value),
    );
    expect(title.heroC).toMatchObject({
      shotId: "S24",
      formalTitleVisible: true,
      unknownShipVisible: true,
      earthVisible: true,
      twinkleStage: "many",
      finalLifeLightsTemporalStable: true,
      allocationsAfterInitialize: 0,
    });
    await expect(page.getByTestId("gfx-hero-c-title")).toHaveAccessibleName("さみしき星のまたたきよ");
    await expect(page.getByTestId("gfx-hero-c-title")).toContainText("さみしき星の");
    await expect(page.getByTestId("gfx-hero-c-title")).toContainText("またたきよ");
    expect(title.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(title.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(title.heroC).toMatchObject(baselineHeroOwnership);
    expectRuntimeBounded(title);
    await testInfo.attach("hero-c-webgl2-179s-formal-title", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    const steady = await waitForSnapshot(
      page,
      (value) => value.telemetry.window.steadyFrames >= 120,
      30_000,
    );
    expect(steady.telemetry.frameIntervalMs.p95).not.toBeNull();
    expect(steady.telemetry.mainThreadWorkMs.p95).not.toBeNull();
    expect(steady.telemetry.mainThreadWorkMs.p95!).toBeLessThanOrEqual(50);
    expectRuntimeBounded(steady);
  });

  test("keeps the host-Metal WebGPU alien/Twinkle graph warm across S20 and S21", async ({ browserName }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "single desktop WebGPU Hero acceptance");
    test.setTimeout(90_000);
    expect(browserName).toBe("chromium");
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error("Hero Slice C WebGPU gate requires a configured baseURL.");
    }

    const browser = await chromium.launch({
      headless: true,
      args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=metal"],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1_920, height: 1_080 } });
      const runtimeErrors: string[] = [];
      page.on("pageerror", (error) => runtimeErrors.push(error.message));
      page.on("console", (entry) => {
        if (entry.type() === "error") runtimeErrors.push(entry.text());
      });
      await page.goto(new URL("/gfx-hero-c?backend=webgpu&qa=1", baseURL).toString());
      await expect(page.getByTestId("gfx-hero-c")).toHaveAttribute(
        "data-status",
        "ready",
        { timeout: 30_000 },
      );
      await expect(page.getByTestId("gfx-hero-c")).toHaveAttribute("data-actual-backend", "webgpu");

      const debris = await waitForSnapshot(page, (value) => (
        value.heroC?.storyTime === 142
        && value.chunks.focusChunkId === "S18"
        && chunksSettled(value)
      ));
      expect(debris.planDigest).toBe(HERO_PLAN_DIGEST);
      expect(debris.quality.id).toBe("high-temporal");
      expect(debris.heroC).toMatchObject({
        humanDebrisVisible: true,
        humanDebrisForms: 7,
        unknownShipVisible: false,
        allocationsAfterInitialize: 0,
      });
      expectRuntimeBounded(debris);
      const baselinePrograms = debris.pipeline.programCountAtReady;
      const baselineGeometries = debris.backendLifecycle.resources.geometries;
      await testInfo.attach("hero-c-webgpu-142s-human-debris", {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      await page.getByRole("button", { name: "158s Arcs" }).click();
      const arcs = await waitForSnapshot(page, (value) => (
        value.heroC?.storyTime === 158
        && value.chunks.focusChunkId === "S20"
        && chunksSettled(value)
      ));
      expect(arcs.heroC).toMatchObject({
        peripheralArcCount: 3,
        unknownShipVisible: false,
        centralVoidOpen: false,
        allocationsAfterInitialize: 0,
      });
      expect(arcs.pipeline.programCountAtReady).toBe(baselinePrograms);
      expect(arcs.backendLifecycle.resources.geometries).toBe(baselineGeometries);
      expectRuntimeBounded(arcs);
      await testInfo.attach("hero-c-webgpu-158s-peripheral-arcs", {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      await page.getByRole("button", { name: "166s Answer" }).click();
      const answer = await waitForSnapshot(page, (value) => (
        value.heroC?.storyTime === 166
        && value.chunks.focusChunkId === "S22"
        && chunksSettled(value)
      ));
      expect(answer.heroC).toMatchObject({
        unknownShipVisible: true,
        alienRibbonShellCount: 3,
        centralVoidOpen: true,
        peripheralArcCount: 0,
        allocationsAfterInitialize: 0,
      });
      expect(answer.pipeline.programCountAtReady).toBe(baselinePrograms);
      expect(answer.backendLifecycle.resources.geometries).toBe(baselineGeometries);
      expectRuntimeBounded(answer);
      await testInfo.attach("hero-c-webgpu-166s-three-ribbon-answer", {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      await page.getByRole("button", { name: "176s Twinkle" }).click();
      const twinkle = await waitForSnapshot(page, (value) => (
        value.heroC?.storyTime === 176
        && value.chunks.focusChunkId === "S23"
        && chunksSettled(value)
      ));
      expect(twinkle.heroC).toMatchObject({
        alienRibbonShellCount: 3,
        centralVoidOpen: true,
        earthVisible: true,
        twinkleStage: "many",
        visibleTwinkles: 160,
        twinkleSourceCount: 3,
        finalLifeLightsTemporalStable: true,
        allocationsAfterInitialize: 0,
      });
      expect(twinkle.pipeline.programCountAtReady).toBe(baselinePrograms);
      expect(twinkle.backendLifecycle.resources.geometries).toBe(baselineGeometries);
      expectRuntimeBounded(twinkle);
      await testInfo.attach("hero-c-webgpu-176s-many-life-lights", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.waitForTimeout(2_500);
      await expect(page.getByTestId("gfx-hero-c")).toHaveAttribute("data-status", "ready");
      expect(runtimeErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
