import { describe, expect, it } from "vitest";
import { projectJourneyState } from "../../src/gfx/v2/project-journey";
import { hashJourney, simulateJourney } from "../../src/game/simulation";
import { generateChunkPayload } from "../../src/gfx/v2/chunks/worker-kernel";
import { makeChunkGenerationToken } from "../../src/gfx/v2/chunks/worker-client";
import {
  WORLD_GENERATOR_VERSION,
  createWorldGenerationContext,
  digestWorldPlan,
  generateWorldPlan,
  projectTwinkleSemantics,
} from "../../src/world/v2";

const REPLAY = [
  { at: 5, moveX: 0.7, moveY: 0.1, pulse: true },
  { at: 39, moveX: -0.4, moveY: 0.8, pulse: true },
  { at: 166.4, moveX: 0, moveY: 0, pulse: true },
] as const;

describe("GFX-002 frozen replay fixture", () => {
  it("keeps game, ledger, world plan, and chunk payloads identical across the GFX-006 backend-quality matrix", () => {
    const results = (["WebGPU", "WebGL2"] as const).flatMap((backend) => (
      (["low", "balanced", "high"] as const).map((quality) => {
        const state = simulateJourney(REPLAY, { seed: 778, quality });
        const plan = generateWorldPlan(createWorldGenerationContext({
          worldSeed: state.seed,
          generatorVersion: WORLD_GENERATOR_VERSION,
        }));
        const planDigest = digestWorldPlan(plan);
        const twinkles = projectTwinkleSemantics(plan, state.pulses);
        const chunkDigests = plan.chunks.map((chunk, index) => generateChunkPayload(
          plan,
          makeChunkGenerationToken({
            planDigest,
            chunkId: chunk.id,
            epoch: 1,
            requestId: index + 1,
          }),
        ).contentDigest);
        return Object.freeze({
          backend,
          quality,
          journeyHash: hashJourney(state),
          ledger: state.pulses,
          planDigest,
          twinkleSignatures: Object.freeze(twinkles.map((entry) => entry.signature)),
          chunkDigests: Object.freeze(chunkDigests),
        });
      })
    ));
    const baseline = results[0]!;
    expect(baseline.journeyHash).toBe("4001f261");
    for (const result of results) {
      expect(result.journeyHash, `${result.backend}/${result.quality}`).toBe(baseline.journeyHash);
      expect(result.ledger, `${result.backend}/${result.quality}`).toEqual(baseline.ledger);
      expect(result.planDigest, `${result.backend}/${result.quality}`).toBe(baseline.planDigest);
      expect(result.twinkleSignatures, `${result.backend}/${result.quality}`).toEqual(
        baseline.twinkleSignatures,
      );
      expect(result.chunkDigests, `${result.backend}/${result.quality}`).toEqual(
        baseline.chunkDigests,
      );
    }
  });

  it("pins the gameplay hash independently from requested render quality", () => {
    const low = simulateJourney(REPLAY, { seed: 778, quality: "low" });
    const high = simulateJourney(REPLAY, { seed: 778, quality: "high" });

    expect(hashJourney(low)).toBe("4001f261");
    expect(hashJourney(high)).toBe("4001f261");
    expect(projectJourneyState(low)).toEqual(projectJourneyState(high));
  });

  it("projects copied renderer containers without mutating or exposing the ledger", () => {
    const state = simulateJourney(REPLAY, { seed: 778 });
    const before = hashJourney(state);
    const projected = projectJourneyState(state);

    expect(projected.pulses).not.toBe(state.pulses);
    expect(projected.position).not.toBe(state.position);
    expect(projected.velocity).not.toBe(state.velocity);
    expect(projected).toMatchObject({
      seed: 778,
      storyTime: 180,
      phase: "TWINKLE",
      shotId: "S24",
      finished: true,
    });
    expect(hashJourney(state)).toBe(before);
    expect(before).toBe("4001f261");
  });
});
