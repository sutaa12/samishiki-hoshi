# QX-R5-000A Blind Acceptance Review — Round 6

**Verdict: REJECT**  
**Score: 18/32**  
**Findings: S0 0 · S1 5 · S2 1 · S3 1**

| Dimension | /4 |
|---|---:|
| Contract / precedence | 4 |
| Mode isolation | 2 |
| Artifact identity / build recomputation | 2 |
| Video / telemetry semantics | 2 |
| Three-review enforcement | 3 |
| Reject / description hardening | 1 |
| R01 migration binding | 1 |
| Tests / docs / rollback | 3 |
| **Total** | **18/32** |

## Findings

### S1-01 — R01 can bypass its mandatory migration classification

`validate-research-pack.mjs:699` admits QX-R4-R01 into AI mode, while `validate-research-pack.mjs:908` chooses the migration validator only when `gates.complete` already equals `research-only-ai-accepted`. Otherwise R01 enters ordinary AI gameplay validation.

Reproduction: a valid QX-R5 AI fixture retagged as `QX-R4-R01`, with `gates.complete: "passed"` and no migration closure, returned exit `0`, `ok: true`. This violates the one-time R01-migration-only route.

### S1-02 — R01 does not prove candidate identity or recompute its physical build

The migration predicate at `validate-research-pack.mjs:484` checks candidate source/build digest strings but not `candidate.source_commit`; it also bypasses the candidate commit/archive and build checks at lines 967–972 and the manifest-entry recomputation at lines 513–525.

Two reproductions passed:

- Changed `candidate.source_commit` to `bae8d1f…` and added `candidate.production_improvement_claimed: true`; validation still returned `ok: true`.
- The committed R01 command returned `ok: true`, while checking `.quality-gates/QX-R4-R01/production-complete-files.sha256` against physical `dist` returned exit `1`: 17 missing entries and 11 digest mismatches.

### S1-03 — Contradictory telemetry fields are accepted

Telemetry validation at `validate-research-pack.mjs:539` validates selected fields but has neither exact-key enforcement nor recursive false/reject detection.

Reproduction: adding both `"verdict": "REJECT"` and `"accepted": false` to an otherwise valid, rehashed telemetry receipt returned exit `0`, `ok: true`.

### S1-04 — Required reject normalization remains bypassable

`validate-research-pack.mjs:112` does not map Unicode homoglyphs, and the positive-count logic at line 124 recognizes `reject_count`/`rejection_count` but not `rejected_count`.

Both rehashed AI packs returned `ok: true`:

- `human.status: "r\u0435ject"` using Cyrillic `е`.
- `human.rejected_count: 1`.

### S1-05 — R01 assessment binding is presence-based and contradiction-tolerant

The R01 parser at `validate-research-pack.mjs:456` misses spaced reject/severity text. Pending boundaries at line 463 require only the presence of `PENDING` rows, while line 499 accepts any digest-valid file as the historical review.

All these mutations returned `ok: true` after legitimate digest rebinding:

- Appended `Verdict: R E J E C T` and `S 2 findings: 1`.
- Appended contradictory Human/Sites `PASSED` rows and added `release_ready: true`.
- Replaced the historical-review reference with `current-capture-metrics.json`.

Thus rejection, pending-boundary retention, and separate historical-review preservation are not enforced.

### S2-01 — A format-only reviewer ID counts as a third reviewer

At `validate-research-pack.mjs:638`, raw `meaningful()` is checked separately from the normalized fingerprint. One reviewer ID containing only U+200B normalizes to an empty fingerprint but still passes when the other two IDs are distinct. The rehashed three-review/remediation pack returned `ok: true`.

### S3-01 — R01 negative tests exercise the wrong artifact

The tests at `research-pack.test.ts:917` and `research-pack.test.ts:937` mutate the historical round-4 file, although the validator parses `r5-migration-assessment.md`. They therefore fail through a digest mismatch rather than testing contradictory text in the dedicated assessment.

## Verification

- `npm run test:research`: **66/66 passed**
- `npm run lint`: exit `0`
- `npm run typecheck`: exit `0`
- Exact R01 AI command: exit `0`, `ok: true`
- Exact R01 Human-release command: exit `1`, including `HUMAN_GATE`, `HUMAN_RAW`, and `HUMAN_OWNER`
- `app`, `src`, and `public` tree IDs are unchanged from the parent commit; Production manifests also have no candidate diff.
- Worktree remained clean.

The exploits concern local integrity and semantic consistency only; none relies on treating the validator as a cryptographic reviewer-identity authority or general visual-semantic model.
