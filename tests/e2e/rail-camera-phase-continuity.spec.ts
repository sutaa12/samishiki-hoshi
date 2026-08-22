import { expect, test, type Page } from "@playwright/test";

const PIXEL_TRACE_FRAMES = 120;
const PIXEL_TRACE_WIDTH = 128;
const PIXEL_TRACE_HEIGHT = 72;
const BLACK_MEAN_LUMINANCE_THRESHOLD = 0.01 * 255;
const MONOCHROME_MIN_QUANTIZED_COLOR_BINS = 16;
const MONOCHROME_MIN_LUMINANCE_STD_DEV_NORMALIZED = 0.005;
const STILL_MIN_CHANGED_PIXEL_RATIO = 0.001;
const PIXEL_CHANNEL_CHANGE_THRESHOLD = 2;
const MAX_STILL_FRAME_RATIO = 0.05;
const MAX_CAMERA_JUMP_SCENE_UNITS = 0.25;

type PixelFrameSample = {
  readonly frame: number;
  readonly storyTime: number;
  readonly meanLuminance: number;
  readonly meanChroma: number;
  readonly quantizedColorBins: number;
  readonly luminanceStdDevNormalized: number;
  readonly meanAbsoluteRgbDelta: number | null;
  readonly changedPixelRatio: number | null;
};

type PixelTrace = {
  readonly frames: number;
  readonly width: number;
  readonly height: number;
  readonly blackFrames: number;
  readonly monochromeFrames: number;
  readonly stillFrames: number;
  readonly stillFrameRatio: number;
  readonly readErrors: readonly string[];
  readonly samples: readonly PixelFrameSample[];
};

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function installPixelTrace(page: Page): Promise<void> {
  await page.evaluate((config) => {
    type TraceScope = Window & { __qxR3005PixelTrace?: Promise<PixelTrace> };
    const source = document.querySelector<HTMLCanvasElement>("canvas.world-canvas");
    if (!source) throw new Error("QX-R3-005 pixel trace could not find the production canvas.");
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = config.width;
    sampleCanvas.height = config.height;
    const context = sampleCanvas.getContext("2d", {
      alpha: false,
      colorSpace: "srgb",
      willReadFrequently: true,
    });
    if (!context) throw new Error("QX-R3-005 pixel trace could not acquire a 2D readback context.");
    const scope = window as TraceScope;
    scope.__qxR3005PixelTrace = new Promise<PixelTrace>((resolve) => {
      const samples: PixelFrameSample[] = [];
      const readErrors: string[] = [];
      let previousPixels: Uint8ClampedArray | null = null;
      let previousStoryTime: number | null = null;
      let blackFrames = 0;
      let monochromeFrames = 0;
      let stillFrames = 0;

      const sample = () => {
        const storyTime = Number(source.dataset.renderStoryTimeExact);
        if (
          !Number.isFinite(storyTime)
          || storyTime <= 35
          || storyTime === previousStoryTime
        ) {
          requestAnimationFrame(sample);
          return;
        }
        previousStoryTime = storyTime;
        try {
          context.drawImage(source, 0, 0, config.width, config.height);
          const pixels = context.getImageData(0, 0, config.width, config.height).data;
          const pixelCount = config.width * config.height;
          let luminanceTotal = 0;
          let luminanceSquaredTotal = 0;
          let chromaTotal = 0;
          let rgbDeltaTotal = 0;
          let changedPixels = 0;
          const quantizedColorBins = new Set<number>();
          for (let offset = 0; offset < pixels.length; offset += 4) {
            const r = pixels[offset]!;
            const g = pixels[offset + 1]!;
            const b = pixels[offset + 2]!;
            const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
            luminanceTotal += luminance;
            luminanceSquaredTotal += luminance * luminance;
            chromaTotal += Math.max(r, g, b) - Math.min(r, g, b);
            quantizedColorBins.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
            if (previousPixels) {
              const redDelta = Math.abs(r - previousPixels[offset]!);
              const greenDelta = Math.abs(g - previousPixels[offset + 1]!);
              const blueDelta = Math.abs(b - previousPixels[offset + 2]!);
              rgbDeltaTotal += redDelta + greenDelta + blueDelta;
              if (
                redDelta > config.pixelChannelChangeThreshold
                || greenDelta > config.pixelChannelChangeThreshold
                || blueDelta > config.pixelChannelChangeThreshold
              ) changedPixels += 1;
            }
          }
          const meanLuminance = luminanceTotal / pixelCount;
          const luminanceVariance = Math.max(
            0,
            luminanceSquaredTotal / pixelCount - meanLuminance * meanLuminance,
          );
          const luminanceStdDevNormalized = Math.sqrt(luminanceVariance) / 255;
          const meanChroma = chromaTotal / pixelCount;
          const meanAbsoluteRgbDelta = previousPixels
            ? rgbDeltaTotal / (pixelCount * 3)
            : null;
          const changedPixelRatio = previousPixels ? changedPixels / pixelCount : null;
          if (meanLuminance <= config.blackThreshold) blackFrames += 1;
          if (
            quantizedColorBins.size < config.monochromeMinQuantizedColorBins
            || luminanceStdDevNormalized < config.monochromeMinLuminanceStdDevNormalized
          ) monochromeFrames += 1;
          if (
            changedPixelRatio !== null
            && changedPixelRatio < config.stillMinChangedPixelRatio
          ) stillFrames += 1;
          samples.push({
            frame: samples.length + 1,
            storyTime,
            meanLuminance,
            meanChroma,
            quantizedColorBins: quantizedColorBins.size,
            luminanceStdDevNormalized,
            meanAbsoluteRgbDelta,
            changedPixelRatio,
          });
          previousPixels = new Uint8ClampedArray(pixels);
        } catch (error: unknown) {
          readErrors.push(error instanceof Error ? error.message : String(error));
        }

        if (samples.length >= config.frames || readErrors.length > 0) {
          resolve({
            frames: samples.length,
            width: config.width,
            height: config.height,
            blackFrames,
            monochromeFrames,
            stillFrames,
            stillFrameRatio: samples.length <= 1 ? 0 : stillFrames / (samples.length - 1),
            readErrors,
            samples,
          });
          return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  }, {
    frames: PIXEL_TRACE_FRAMES,
    width: PIXEL_TRACE_WIDTH,
    height: PIXEL_TRACE_HEIGHT,
    blackThreshold: BLACK_MEAN_LUMINANCE_THRESHOLD,
    monochromeMinQuantizedColorBins: MONOCHROME_MIN_QUANTIZED_COLOR_BINS,
    monochromeMinLuminanceStdDevNormalized: MONOCHROME_MIN_LUMINANCE_STD_DEV_NORMALIZED,
    stillMinChangedPixelRatio: STILL_MIN_CHANGED_PIXEL_RATIO,
    pixelChannelChangeThreshold: PIXEL_CHANNEL_CHANGE_THRESHOLD,
  });
}

async function readPixelTrace(page: Page): Promise<PixelTrace> {
  return page.evaluate(async () => {
    const scope = window as Window & { __qxR3005PixelTrace?: Promise<PixelTrace> };
    if (!scope.__qxR3005PixelTrace) throw new Error("QX-R3-005 pixel trace was not installed.");
    return scope.__qxR3005PixelTrace;
  });
}

test("QX-R3-005 LIFE to EARTH keeps 120 actual WebGL2 frames continuous", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "single desktop continuity gate");
  test.setTimeout(120_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/?qa=1&backend=webgl2&seed=20260818&at=35&speed=0.25");
  const shell = page.getByTestId("game-shell");
  await expect(shell).toHaveAttribute("data-renderer-status", "ready", { timeout: 120_000 });
  await expect(shell).toHaveAttribute("data-actual-backend", "webgl2");
  await expect(shell).toHaveAttribute("data-render-current-chunk-ready", "true", { timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-render-camera-chunk-ready", "true", { timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-render-next-chunk-ready", "true", { timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-render-camera-look-ahead", "0.75");
  await expect(shell).toHaveAttribute("data-render-camera-fov", "60.00");

  await installPixelTrace(page);
  await page.getByRole("button", { name: "旅をはじめる" }).click();
  const pixelTrace = await readPixelTrace(page);
  await page.waitForTimeout(250);
  const runtimeTrace = await shell.evaluate((element) => ({
    samples: Number(element.getAttribute("data-render-continuity-samples")),
    blackFrames: Number(element.getAttribute("data-render-continuity-black-frames")),
    monochromeFrames: Number(element.getAttribute("data-render-continuity-monochrome-frames")),
    runtimeCompileDelta: Number(element.getAttribute("data-render-continuity-runtime-compile-delta")),
    maxCameraJump: Number(element.getAttribute("data-render-continuity-max-camera-jump")),
    stillFrameRatio: Number(element.getAttribute("data-render-continuity-still-ratio")),
    currentChunkMissing: Number(element.getAttribute("data-render-continuity-current-chunk-missing")),
    cameraChunkMissing: Number(element.getAttribute("data-render-continuity-camera-chunk-missing")),
    nextChunkMissing: Number(element.getAttribute("data-render-continuity-next-chunk-missing")),
    phaseFrom: element.getAttribute("data-render-phase-from"),
    phaseTo: element.getAttribute("data-render-phase-to"),
    phaseBlend: Number(element.getAttribute("data-render-phase-blend")),
  }));
  await testInfo.attach("qx-r3-005-life-earth-120-frame-trace", {
    body: Buffer.from(JSON.stringify({
      thresholds: {
        blackMeanLuminance: BLACK_MEAN_LUMINANCE_THRESHOLD,
        monochromeMinQuantizedColorBins: MONOCHROME_MIN_QUANTIZED_COLOR_BINS,
        monochromeMinLuminanceStdDevNormalized: MONOCHROME_MIN_LUMINANCE_STD_DEV_NORMALIZED,
        stillMinChangedPixelRatio: STILL_MIN_CHANGED_PIXEL_RATIO,
        pixelChannelChangeThreshold: PIXEL_CHANNEL_CHANGE_THRESHOLD,
        maxStillFrameRatio: MAX_STILL_FRAME_RATIO,
        maxCameraJumpSceneUnits: MAX_CAMERA_JUMP_SCENE_UNITS,
      },
      pixelTrace,
      runtimeTrace,
    }, null, 2)),
    contentType: "application/json",
  });

  await expect(shell).toHaveAttribute("data-render-continuity-complete", "true", { timeout: 20_000 });
  await expect(shell).toHaveAttribute("data-render-continuity-passed", "true");

  expect(pixelTrace.frames).toBe(PIXEL_TRACE_FRAMES);
  expect(pixelTrace.readErrors).toEqual([]);
  expect(pixelTrace.blackFrames).toBe(0);
  expect(pixelTrace.monochromeFrames).toBe(0);
  expect(pixelTrace.stillFrameRatio).toBeLessThanOrEqual(MAX_STILL_FRAME_RATIO);
  expect(pixelTrace.samples[0]?.storyTime).toBeGreaterThan(35);
  expect(pixelTrace.samples.at(-1)?.storyTime).toBeGreaterThanOrEqual(36.9);
  expect(runtimeTrace).toMatchObject({
    samples: 120,
    blackFrames: 0,
    monochromeFrames: 0,
    runtimeCompileDelta: 0,
    currentChunkMissing: 0,
    cameraChunkMissing: 0,
    nextChunkMissing: 0,
    phaseFrom: "LIFE",
    phaseTo: "EARTH",
  });
  expect(runtimeTrace.maxCameraJump).toBeLessThanOrEqual(MAX_CAMERA_JUMP_SCENE_UNITS);
  expect(runtimeTrace.stillFrameRatio).toBeLessThanOrEqual(MAX_STILL_FRAME_RATIO);
  expect(runtimeTrace.phaseBlend).toBeGreaterThan(0.5);
  expect(errors).toEqual([]);
});
