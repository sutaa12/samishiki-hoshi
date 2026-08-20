import { chromium, expect, test, type Page } from "@playwright/test";
import type { GfxFoundationSnapshot } from "../../src/gfx/v2/integration/foundation-runtime";

const HERO_PLAN_DIGEST = "world-plan-v1:75d93cbb8e0580cd";

type HeroSnapshot = Readonly<GfxFoundationSnapshot>;

async function snapshot(page: Page): Promise<HeroSnapshot> {
  const value = await page.getByTestId("gfx-hero-b-snapshot").textContent();
  if (!value || value === "initializing") throw new Error("Hero Slice B snapshot is unavailable.");
  return JSON.parse(value) as HeroSnapshot;
}

async function waitForSnapshot(
  page: Page,
  predicate: (value: HeroSnapshot) => boolean,
  timeout = 8_000,
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
  expect(value.chunks).toMatchObject({
    gpuOwnedCount: 4,
    workerInboxCount: 0,
  });
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

test.describe("R2-G4 Hero Slice B real browser candidate", () => {
  test.skip(({ isMobile }) => isMobile, "Hero Slice B is reviewed at the required 1920×1080 desktop size.");

  test("binds the forest and empty-city markers without runtime allocation growth", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1_920, height: 1_080 });
    await page.goto("/gfx-hero-b?backend=webgl2&qa=1");
    await expect(page.getByTestId("gfx-hero-b")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("gfx-hero-b")).toHaveAttribute("data-actual-backend", "webgl2");

    const forest = await waitForSnapshot(page, (value) => (
      value.heroB?.storyTime === 58
      && value.chunks.focusChunkId === "S09"
      && value.chunks.activeChunkIds.length === 4
      && value.chunks.workerInboxCount === 0
      && value.chunks.uploadQueue.pending === 0
    ));
    expect(page.viewportSize()).toEqual({ width: 1_920, height: 1_080 });
    expect(forest.planDigest).toBe(HERO_PLAN_DIGEST);
    expect(forest.heroA).toBeNull();
    expect(forest.heroB).toMatchObject({
      state: "ready",
      storyTime: 58,
      shotId: "S09",
      qualityTier: "high",
      forestPeakVisible: true,
      cityRuinsVisible: false,
      riverVisible: true,
      waterfallVisible: true,
      protagonistVisible: true,
      pulseTargetVisible: true,
      flowGuideVisible: true,
      natureReadsFirst: true,
      safeCorridorClear: true,
      safeCorridorHalfWidth: 2.8,
      storySightlineOpen: true,
      hydrologyConnected: true,
      foliageTemporalStable: true,
      visibleTrees: 48,
      visibleGrassClusters: 144,
      visibleFlowers: 72,
      visibleFireflies: 84,
      visibleSunbeams: 4,
      visibleBirds: 22,
      visibleMistClusters: 20,
      visibleFoamClusters: 32,
      visibleClouds: 12,
      allocationsAfterInitialize: 0,
    });
    expect(forest.heroB?.ownedGeometries).toBeGreaterThan(0);
    expect(forest.heroB?.ownedMaterials).toBeGreaterThan(0);
    expect(forest.heroB?.ownedTextures).toBe(18);
    expect(forest.heroB?.ownedObjects).toBeGreaterThan(0);
    if (!forest.heroB) throw new Error("Hero Slice B ownership evidence is unavailable.");
    expectRuntimeBounded(forest);
    await testInfo.attach("hero-b-webgl2-58s-forest", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    const baselinePrograms = forest.pipeline.programCountAtReady;
    const baselineGeometries = forest.backendLifecycle.resources.geometries;
    const baselineHeroOwnership = Object.freeze({
      ownedGeometries: forest.heroB.ownedGeometries,
      ownedMaterials: forest.heroB.ownedMaterials,
      ownedTextures: forest.heroB.ownedTextures,
      ownedObjects: forest.heroB.ownedObjects,
    });

    await page.getByRole("button", { name: "75s Empty city" }).click();
    const city = await waitForSnapshot(page, (value) => (
      value.heroB?.storyTime === 75
      && value.chunks.focusChunkId === "S11"
      && value.chunks.activeChunkIds.length === 4
      && value.chunks.workerInboxCount === 0
      && value.chunks.uploadQueue.pending === 0
    ));
    expect(city.heroB).toMatchObject({
      storyTime: 75,
      shotId: "S11",
      cityRuinsVisible: true,
      forestPeakVisible: true,
      natureReadsFirst: true,
      safeCorridorClear: true,
      storySightlineOpen: true,
      hydrologyConnected: true,
      ruinTowers: 8,
      floorSlabs: 36,
      columnGridSegments: 32,
      facadeCells: 48,
      emptyBenchSeats: 3,
      playgroundFrames: 1,
      observationFrames: 1,
      amberBeacons: 1,
      rooftopTrees: 8,
      windowBirds: 8,
      allocationsAfterInitialize: 0,
    });
    expect(city.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(city.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(city.heroB).toMatchObject(baselineHeroOwnership);
    expectRuntimeBounded(city);
    await testInfo.attach("hero-b-webgl2-75s-empty-city", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    await page.getByRole("button", { name: "Fallback" }).click();
    const fallback = await waitForSnapshot(page, (value) => value.quality.id === "low-static");
    expect(fallback.planDigest).toBe(HERO_PLAN_DIGEST);
    expect(fallback.heroB).toMatchObject({
      storyTime: 75,
      shotId: "S11",
      qualityTier: "low",
      cityRuinsVisible: true,
      safeCorridorClear: true,
      hydrologyConnected: true,
      visibleTrees: 24,
      visibleGrassClusters: 44,
      visibleFlowers: 22,
      visibleFireflies: 24,
      visibleSunbeams: 2,
      visibleBirds: 10,
      visibleMistClusters: 8,
      visibleFoamClusters: 12,
      visibleClouds: 6,
      allocationsAfterInitialize: 0,
    });
    expect(fallback.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(fallback.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(fallback.heroB).toMatchObject(baselineHeroOwnership);
    expectRuntimeBounded(fallback);
    await testInfo.attach("hero-b-webgl2-75s-fallback", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    await page.getByRole("button", { name: "High", exact: true }).click();
    const restored = await waitForSnapshot(page, (value) => value.quality.id === "high-temporal");
    expect(restored.heroB).toMatchObject({
      storyTime: 75,
      qualityTier: "high",
      visibleTrees: 48,
      visibleGrassClusters: 144,
      visibleFlowers: 72,
      visibleFireflies: 84,
      visibleSunbeams: 4,
      visibleBirds: 22,
      visibleMistClusters: 20,
      visibleFoamClusters: 32,
      visibleClouds: 12,
      allocationsAfterInitialize: 0,
    });
    expect(restored.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(restored.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(restored.heroB).toMatchObject(baselineHeroOwnership);
    expect(restored.host.counters.submittedFrames).toBeGreaterThan(forest.host.counters.submittedFrames);
    expectRuntimeBounded(restored);

    const steady = await waitForSnapshot(
      page,
      (value) => (
        value.telemetry.window.steadyFrames >= 120
        && value.telemetry.frameIntervalMs.p95 !== null
        && value.telemetry.mainThreadWorkMs.p95 !== null
      ),
      60_000,
    );
    expect(steady.telemetry.frameIntervalMs.p95).not.toBeNull();
    expect(steady.telemetry.mainThreadWorkMs.p95).not.toBeNull();
    expect(steady.telemetry.frameIntervalMs.p95!).toBeGreaterThan(0);
    expect(steady.telemetry.mainThreadWorkMs.p95!).toBeLessThanOrEqual(50);
    expectRuntimeBounded(steady);
  });

  test("keeps the host-Metal WebGPU forest/city graph warm across the city reveal", async ({ browserName }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "single desktop WebGPU Hero acceptance");
    test.setTimeout(60_000);
    expect(browserName).toBe("chromium");
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error("Hero Slice B WebGPU gate requires a configured baseURL.");
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
      await page.goto(new URL("/gfx-hero-b?backend=webgpu&qa=1", baseURL).toString());
      await expect(page.getByTestId("gfx-hero-b")).toHaveAttribute(
        "data-status",
        "ready",
        { timeout: 30_000 },
      );
      await expect(page.getByTestId("gfx-hero-b")).toHaveAttribute("data-actual-backend", "webgpu");

      const forest = await waitForSnapshot(page, (value) => (
        value.heroB?.storyTime === 58
        && value.chunks.focusChunkId === "S09"
        && value.chunks.activeChunkIds.length === 4
        && value.chunks.workerInboxCount === 0
        && value.chunks.uploadQueue.pending === 0
      ));
      expect(forest.planDigest).toBe(HERO_PLAN_DIGEST);
      expect(forest.quality.id).toBe("high-temporal");
      expect(forest.heroB).toMatchObject({
        storyTime: 58,
        shotId: "S09",
        qualityTier: "high",
        cityRuinsVisible: false,
        hydrologyConnected: true,
        ownedTextures: 18,
        allocationsAfterInitialize: 0,
      });
      expectRuntimeBounded(forest);
      await testInfo.attach("hero-b-webgpu-58s-forest", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      const baselinePrograms = forest.pipeline.programCountAtReady;
      const baselineGeometries = forest.backendLifecycle.resources.geometries;

      await page.getByRole("button", { name: "75s Empty city" }).click();
      const city = await waitForSnapshot(page, (value) => (
        value.heroB?.storyTime === 75
        && value.chunks.focusChunkId === "S11"
        && value.chunks.activeChunkIds.length === 4
        && value.chunks.workerInboxCount === 0
        && value.chunks.uploadQueue.pending === 0
      ));
      expect(city.heroB).toMatchObject({
        cityRuinsVisible: true,
        natureReadsFirst: true,
        safeCorridorClear: true,
        hydrologyConnected: true,
        emptyBenchSeats: 3,
        observationFrames: 1,
        rooftopTrees: 8,
        windowBirds: 8,
        allocationsAfterInitialize: 0,
      });
      expect(city.pipeline.programCountAtReady).toBe(baselinePrograms);
      expect(city.backendLifecycle.resources.geometries).toBe(baselineGeometries);
      expectRuntimeBounded(city);
      await testInfo.attach("hero-b-webgpu-75s-empty-city", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.waitForTimeout(2_500);
      await expect(page.getByTestId("gfx-hero-b")).toHaveAttribute("data-status", "ready");
      expect(runtimeErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
