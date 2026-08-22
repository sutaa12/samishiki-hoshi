import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

/**
 * Remediation evidence must not overwrite either the immutable GFX-001 report
 * or the rejected f613ae7 GFX-002 candidate report.
 * Port validation and explicit-port server-reuse policy remain inherited from
 * the accepted base configuration.
 */
export default defineConfig({
  ...baseConfig,
  reporter: [
    ["line"],
    [
      "json",
      {
        outputFile:
          ".quality-gates/gfx002-remediation-accepted-20260818-playwright-report.json",
      },
    ],
  ],
  outputDir: ".quality-gates/gfx002-remediation-accepted-20260818-output",
});
