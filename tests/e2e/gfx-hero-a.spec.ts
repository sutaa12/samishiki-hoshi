import { chromium, expect, test, type Page } from "@playwright/test";

const HERO_PLAN_DIGEST = "world-plan-v1:75d93cbb8e0580cd";

interface HeroSnapshot {
  readonly planDigest: string;
  readonly host: {
    readonly lifecycle: string;
    readonly counters: { readonly submittedFrames: number };
  };
  readonly pipeline: {
    readonly state: string;
    readonly programCountAtReady: number | null;
    readonly programGrowthAfterReady: number;
    readonly runtimeCompileEvents: number;
  };
  readonly backendLifecycle: {
    readonly state: string;
    readonly resources: {
      readonly geometries: number;
      readonly textures: number;
      readonly programs: number;
      readonly objects: number;
      readonly pendingUploads: number;
    };
  };
  readonly chunks: {
    readonly focusChunkId: string | null;
    readonly activeChunkIds: readonly string[];
    readonly gpuOwnedCount: number;
    readonly workerInboxCount: number;
    readonly uploadQueue: {
      readonly pending: number;
      readonly failed: number;
      readonly orphanLeaseCount: number;
      readonly orphanJobCount: number;
    };
  };
  readonly heroA: {
    readonly state: string;
    readonly storyTime: number;
    readonly shotId: string;
    readonly qualityTier: string;
    readonly humanArtifactsVisible: boolean;
    readonly waterlineTransition: boolean;
    readonly protagonistVisible: boolean;
    readonly pulseTargetVisible: boolean;
    readonly flowGuideVisible: boolean;
    readonly visibleFish: number;
    readonly visibleCoralClusters: number;
    readonly visibleKelp: number;
    readonly visibleBubbles: number;
    readonly vehicleModules: number;
    readonly emptySeats: number;
    readonly rectangularWindowCells: number;
    readonly railSegments: number;
    readonly ownedGeometries: number;
    readonly ownedMaterials: number;
    readonly ownedTextures: number;
    readonly ownedObjects: number;
    readonly allocationsAfterInitialize: number;
  } | null;
  readonly quality: { readonly id: string };
  readonly telemetry: {
    readonly window: { readonly steadyFrames: number };
    readonly frameIntervalMs: { readonly p95: number | null };
    readonly mainThreadWorkMs: { readonly p95: number | null };
    readonly runtimeSpikesOver50Ms: number;
    readonly events: readonly {
      readonly kind: string;
      readonly durationMs: number;
    }[];
  };
}

async function snapshot(page: Page): Promise<HeroSnapshot> {
  const value = await page.getByTestId("gfx-hero-a-snapshot").textContent();
  if (!value || value === "initializing") throw new Error("Hero Slice A snapshot is unavailable.");
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

test.describe("R2-G3 Hero Slice A real browser candidate", () => {
  test.skip(({ isMobile }) => isMobile, "Hero Slice A is reviewed at the required 1920×1080 desktop size.");

  test("binds the 12s, 27s, and waterline markers without runtime allocation growth", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1_920, height: 1_080 });
    await page.goto("/gfx-hero-a?backend=webgl2&qa=1");
    await expect(page.getByTestId("gfx-hero-a")).toHaveAttribute(
      "data-status",
      "ready",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("gfx-hero-a")).toHaveAttribute("data-actual-backend", "webgl2");

    const life = await waitForSnapshot(page, (value) => (
      value.heroA?.storyTime === 12
      && value.chunks.focusChunkId === "S03"
      && value.chunks.activeChunkIds.length === 4
      && value.chunks.workerInboxCount === 0
      && value.chunks.uploadQueue.pending === 0
    ));
    expect(page.viewportSize()).toEqual({ width: 1_920, height: 1_080 });
    expect(life.planDigest).toBe(HERO_PLAN_DIGEST);
    expect(life.heroA).toMatchObject({
      state: "ready",
      storyTime: 12,
      shotId: "S03",
      qualityTier: "high",
      humanArtifactsVisible: false,
      waterlineTransition: false,
      protagonistVisible: true,
      pulseTargetVisible: true,
      flowGuideVisible: true,
      visibleFish: 28,
      visibleCoralClusters: 20,
      visibleKelp: 18,
      visibleBubbles: 36,
      vehicleModules: 55,
      emptySeats: 5,
      rectangularWindowCells: 7,
      railSegments: 7,
      allocationsAfterInitialize: 0,
    });
    expect(life.heroA?.ownedGeometries).toBeGreaterThan(0);
    expect(life.heroA?.ownedMaterials).toBeGreaterThan(0);
    expect(life.heroA?.ownedTextures).toBe(2);
    expect(life.heroA?.ownedObjects).toBeGreaterThan(0);
    if (!life.heroA) throw new Error("Hero Slice A ownership evidence is unavailable.");
    expectRuntimeBounded(life);
    const baselinePrograms = life.pipeline.programCountAtReady;
    const baselineGeometries = life.backendLifecycle.resources.geometries;
    const baselineHeroOwnership = Object.freeze({
      ownedGeometries: life.heroA.ownedGeometries,
      ownedMaterials: life.heroA.ownedMaterials,
      ownedTextures: life.heroA.ownedTextures,
      ownedObjects: life.heroA.ownedObjects,
    });

    await page.getByRole("button", { name: "27s Empty seat" }).click();
    const emptySeat = await waitForSnapshot(page, (value) => (
      value.heroA?.storyTime === 27
      && value.chunks.focusChunkId === "S05"
      && value.chunks.activeChunkIds.length === 4
      && value.chunks.workerInboxCount === 0
      && value.chunks.uploadQueue.pending === 0
    ));
    expect(emptySeat.heroA).toMatchObject({
      shotId: "S05",
      humanArtifactsVisible: true,
      waterlineTransition: false,
      emptySeats: 5,
      rectangularWindowCells: 7,
      railSegments: 7,
      visibleCoralClusters: 6,
      allocationsAfterInitialize: 0,
    });
    expect(emptySeat.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(emptySeat.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(emptySeat.heroA).toMatchObject(baselineHeroOwnership);
    expectRuntimeBounded(emptySeat);

    await page.getByRole("button", { name: "37s Waterline" }).click();
    const waterline = await waitForSnapshot(page, (value) => (
      value.heroA?.storyTime === 37
      && value.chunks.focusChunkId === "S07"
      && value.chunks.activeChunkIds.length === 4
      && value.chunks.workerInboxCount === 0
      && value.chunks.uploadQueue.pending === 0
    ));
    expect(waterline.heroA).toMatchObject({
      shotId: "S07",
      humanArtifactsVisible: false,
      waterlineTransition: true,
      protagonistVisible: true,
      allocationsAfterInitialize: 0,
    });
    expect(waterline.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(waterline.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(waterline.heroA).toMatchObject(baselineHeroOwnership);
    expectRuntimeBounded(waterline);

    await page.getByRole("button", { name: "Fallback" }).click();
    const fallback = await waitForSnapshot(page, (value) => value.quality.id === "low-static");
    expect(fallback.planDigest).toBe(HERO_PLAN_DIGEST);
    expect(fallback.heroA).toMatchObject({
      storyTime: 37,
      shotId: "S07",
      qualityTier: "low",
      humanArtifactsVisible: false,
      waterlineTransition: true,
      visibleFish: 16,
      visibleCoralClusters: 13,
      visibleKelp: 11,
      visibleBubbles: 20,
      allocationsAfterInitialize: 0,
    });
    expect(fallback.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(fallback.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(fallback.heroA).toMatchObject(baselineHeroOwnership);
    expectRuntimeBounded(fallback);

    await page.getByRole("button", { name: "High", exact: true }).click();
    const restored = await waitForSnapshot(page, (value) => value.quality.id === "high-temporal");
    expect(restored.heroA).toMatchObject({
      storyTime: 37,
      qualityTier: "high",
      visibleFish: 28,
      visibleCoralClusters: 20,
      visibleKelp: 18,
      visibleBubbles: 36,
      allocationsAfterInitialize: 0,
    });
    expect(restored.pipeline.programCountAtReady).toBe(baselinePrograms);
    expect(restored.backendLifecycle.resources.geometries).toBe(baselineGeometries);
    expect(restored.heroA).toMatchObject(baselineHeroOwnership);
    expect(restored.host.counters.submittedFrames).toBeGreaterThan(life.host.counters.submittedFrames);
    expectRuntimeBounded(restored);

    const steady = await waitForSnapshot(
      page,
      (value) => value.telemetry.window.steadyFrames >= 120,
      30_000,
    );
    expect(steady.telemetry.frameIntervalMs.p95).not.toBeNull();
    expect(steady.telemetry.mainThreadWorkMs.p95).not.toBeNull();
    expect(steady.telemetry.frameIntervalMs.p95!).toBeGreaterThan(0);
    expect(steady.telemetry.mainThreadWorkMs.p95!).toBeLessThanOrEqual(50);
    expectRuntimeBounded(steady);
  });

  test("keeps the actual host-Metal WebGPU Hero graph warm across the human reveal", async ({ browserName }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "single desktop WebGPU Hero acceptance");
    test.setTimeout(60_000);
    expect(browserName).toBe("chromium");
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error("Hero Slice A WebGPU gate requires a configured baseURL.");
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
      await page.goto(new URL("/gfx-hero-a?backend=webgpu&qa=1", baseURL).toString());
      await expect(page.getByTestId("gfx-hero-a")).toHaveAttribute(
        "data-status",
        "ready",
        { timeout: 30_000 },
      );
      await expect(page.getByTestId("gfx-hero-a")).toHaveAttribute("data-actual-backend", "webgpu");

      const life = await waitForSnapshot(page, (value) => (
        value.heroA?.storyTime === 12
        && value.chunks.focusChunkId === "S03"
        && value.chunks.activeChunkIds.length === 4
        && value.chunks.workerInboxCount === 0
        && value.chunks.uploadQueue.pending === 0
      ));
      expect(life.planDigest).toBe(HERO_PLAN_DIGEST);
      expect(life.quality.id).toBe("high-temporal");
      expect(life.heroA).toMatchObject({
        storyTime: 12,
        shotId: "S03",
        qualityTier: "high",
        humanArtifactsVisible: false,
        ownedTextures: 2,
        allocationsAfterInitialize: 0,
      });
      expectRuntimeBounded(life);
      const baselinePrograms = life.pipeline.programCountAtReady;
      const baselineGeometries = life.backendLifecycle.resources.geometries;

      await page.getByRole("button", { name: "27s Empty seat" }).click();
      const emptySeat = await waitForSnapshot(page, (value) => (
        value.heroA?.storyTime === 27
        && value.chunks.focusChunkId === "S05"
        && value.chunks.activeChunkIds.length === 4
        && value.chunks.workerInboxCount === 0
        && value.chunks.uploadQueue.pending === 0
      ));
      expect(emptySeat.heroA).toMatchObject({
        humanArtifactsVisible: true,
        emptySeats: 5,
        rectangularWindowCells: 7,
        allocationsAfterInitialize: 0,
      });
      expect(emptySeat.pipeline.programCountAtReady).toBe(baselinePrograms);
      expect(emptySeat.backendLifecycle.resources.geometries).toBe(baselineGeometries);
      expectRuntimeBounded(emptySeat);
      await page.waitForTimeout(2_500);
      await expect(page.getByTestId("gfx-hero-a")).toHaveAttribute("data-status", "ready");
      expect(runtimeErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
