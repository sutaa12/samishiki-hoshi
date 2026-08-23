# QX-R5-000A blind acceptance: REJECT

Candidate `81c0ffa5d9799761efe1e856edb00fdf3d1e0477` was clean and exact.

| Dimension | Score |
|---|---:|
| Contract / precedence | 4 |
| Mode isolation | 2 |
| Artifact identity / build recomputation | 3 |
| Video / telemetry semantics | 4 |
| Three-review enforcement | 4 |
| Reject / description hardening | 2 |
| R01 migration binding | 1 |
| Tests / docs / rollback | 3 |
| **Total** | **23/32** |

Severities: **S0 0, S1 3, S2 2, S3 0**. Acceptance requires zero S0–S2, so the verdict is **REJECT**.

## Findings

- **S1 — Positive Human Reject bypass.** `validate-research-pack.mjs:139` scans keys only for `reject...count`; boolean/number values under `reject`, `rejected`, or `rejection` are ignored. Adding `evidence.human.rejected = true` to an isolated copy of the accepted R01 pack still returned `ok: true`. This permits AI closure over preserved Human rejection.

- **S1 — Historical review is not exactly preserved.** `validate-research-pack.mjs:523` checks the fixed path and self-consistent closure/assessment digest, while `validate-research-pack.mjs:929` never compares it with the historical digest pinned by `research-validation.json:33`. Replacing the same-path historical file and rewriting only downstream self-declared hashes still returned `ok: true`, despite leaving the research-validation receipt contradictory.

- **S1 — Contradictory migration assessment passes.** The exact table-row checks at `validate-research-pack.mjs:514` and limited contradiction patterns at `validate-research-pack.mjs:521` ignore conflicting prose and `false`. Appending `Human acceptance: PASSED` and `AI acceptance pass: false`, then rebinding digests, still returned `ok: true`.

- **S2 — Scores above the rubric maximum pass.** `validate-research-pack.mjs:497` parses any integer and `validate-research-pack.mjs:539` checks only `>= 28`. A rebound `99/32` assessment passed.

- **S2 — Malformed build-manifest lines are silently discarded.** `validate-research-pack.mjs:587` applies `filter(Boolean)` after parsing. One valid entry plus malformed or contradictory lines can therefore pass; every nonblank manifest line should parse and recompute.

## Verification

- Exact AI-binary CLI: passed with zero issues.
- Human-release CLI: failed closed.
- Research tests: `74/74` passed.
- TypeScript check: passed.
- Preserved R01 archive/manifest validation: passed.
- All adversarial mutations used removed temporary clones; candidate worktree remained clean.
