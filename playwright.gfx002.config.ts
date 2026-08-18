import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

/**
 * GFX-002 evidence must not overwrite the immutable GFX-001 JSON report.
 * Port validation and explicit-port server-reuse policy remain inherited from
 * the accepted base configuration.
 */
export default defineConfig({
  ...baseConfig,
  reporter: [
    ["line"],
    ["json", { outputFile: ".quality-gates/gfx002-playwright-report.json" }],
  ],
  outputDir: ".quality-gates/gfx002-playwright-output",
});
