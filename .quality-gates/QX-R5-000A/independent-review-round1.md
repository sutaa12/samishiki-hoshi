# QX-R5-000A independent blind review — round 1

- Subject commit: `121cd3b752339e7ee7a0290711f71d8211f5a987`
- Reviewer route: `gpt-5.6-sol`, max reasoning, fresh artifact-only blind context
- Verdict: REJECT
- Score: 27/32
- Severity count: S0 0, S1 2, S2 2, S3 0

## Rubric

| Dimension | Score |
| --- | ---: |
| Page 19 precedence / R5 isolation | 4/4 |
| CLI default and mode documentation | 4/4 |
| Human release / Human Reject | 3/4 |
| Video, telemetry, ledger, remediation | 2/4 |
| Three blind reviewer gate | 3/4 |
| Narrow R01 closure | 4/4 |
| Negative coverage / artifact handling | 3/4 |
| Runtime invariance / release honesty | 4/4 |

## Findings

1. S1 — Arbitrary nonempty bytes could satisfy the moving-video gate because only path, size, digest, and candidate equality were checked. No container, duration, decodability, frames, or motion was verified.
2. S1 — A Human Reject preserved only as `evidence.json` fields could pass AI Binary when `human-test.md` was absent.
3. S2 — Negative timing values passed, telemetry did not preserve per-frame distance or the Ring-area and steering-movement probes, and one-character remediation-map values passed.
4. S2 — Canonical descriptions wrapped in distinct punctuation passed as both non-copies and distinct answers.

## Correctly fail-closed attacks

Two reviews, reused Reviewer IDs, mismatched Video SHA, one failed review, missing telemetry, missing ledger/remediation, exact copied descriptions, exact duplicate descriptions, missing/empty video, symlink/path aliases, and a Markdown Human Reject all failed. Missing Human evidence passed AI Binary and failed Human release as required.

## Frozen evidence

- Subject HEAD: `121cd3b752339e7ee7a0290711f71d8211f5a987`
- `app` tree: `42df35f01b63990c436d7cc5c45bc3b23cbb155d`
- `src` tree: `a15e510ca1c8c632652e53f043b1ec128d25f728`
- `public` tree: `dbf15b05e8811c7636af5482d777b35bf07cc647`
- Research tests: 41/41 passed
- Required targeted negatives: 11/11 passed
- R01 research and complete/AI Binary: passed
- R01 default and explicit Human release: failed closed

## Review limitations

The reviewer inspected only the QX-R5-000A and Page 19 Notion pages plus the authorized contract, validator, tests, R01 migration, and immutable tree evidence. Page 18 and QX-R5-001 live status, Git history/diff, runtime files, deployment state, prior reviews, and team status were intentionally excluded.
