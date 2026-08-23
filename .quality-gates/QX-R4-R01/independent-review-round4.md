# QX-R4-R01 independent review round 4

Verdict: ACCEPT — research stage only  
Score: 30/32  
Reviewer severities: S0 0, S1 0, S2 0, S3 2

R01 must not be marked complete: the two-person semantic test remains `HUMAN_PENDING`, and complete-stage validation correctly fails closed.

## Rubric

| Category | Score | Basis |
| --- | ---: | --- |
| Notion fit | 3/4 | Six represented games, 12+ frames, required composition fields, epistemic separation, current capture, non-redistribution, and an honest two-person gate are present. The current baseline is not annotated in quite the same numeric schema as the external frames. |
| Corpus/coverage | 4/4 | Six distinct official games and 13 distinct official URL/frame or timecode locators; 6 Primary, 2 pinned GitHub, and 2 Community rows. |
| Annotation reproducibility | 4/4 | Origin, axes, exclusions, rounding, uncertainty, localization, silhouette height, and a 20x20 cell-center area method are defined. |
| Measurement/evidence integrity | 4/4 | Before/after time and gameplay-hash intervals, exposure, source-bound conditions, digests, and metric limitations are preserved. |
| Legal/rights posture | 4/4 | External imagery remains URL/timecode-only; only project-owned captures are committed. |
| Deterministic source/build binding | 4/4 | Runtime source, complete 106-file build manifest, frozen research snapshot, validation receipt, captures, rollback, and gameplay hash are cross-bound. |
| Validation/negative tests | 3/4 | 28/28 tests cover forged digests, still TTC, embedded media, chronology, interval synchronization, symlinks/aliases, and forged human completion. |
| Rollback/human-gate honesty | 4/4 | Completion needs two distinct timestamped participants, separate raw/trace/owner evidence, and owner sign-off. |

## Explicit checks

- No observed external TTC or latency is inferred from a still; numeric values are future LonelyStar hypotheses only.
- Screenshot intervals match receipt, `current-baseline.md`, and `ablation.md`: LIFE `11.05-11.42s` / `6349ca8e->1f1a2cc7`; EARTH `48.95-49.07s` / `36cccfbf->a2b5274b`; SOLITUDE `143.03-143.03s` / `9997894d->9997894d`.
- Capture time `2026-08-23T05:37:52.711Z` precedes validation time `2026-08-23T15:01:12+09:00`; chronology and interval tampering have negative tests.
- `hash-production-build.mjs` refuses a dirty worktree before hashing or writing.
- Research-stage validation passed with zero issues; complete-stage validation failed closed with 15 pending candidate, metrics, and human issues.
- Research tests passed 28/28. The previously run full suite passed 808/808.

## S3 hardening notes

1. The current build has same-condition captures and qualitative observations, but not current-frame rows using every external-frame numeric column.
2. The manifest dirty-worktree guard lacks a dedicated negative test; `annotation-method.md` is not itself a validator-required file; timing negative coverage is centered on TTC.

## Limitations

Strict blindness was preserved: the reviewer did not inspect Git status/history/log/blame, prior reviews, or team state. Only the permitted R01 Notion page was fetched. Capture/build generators were not rerun under the read-only review. No human answers were collected.
