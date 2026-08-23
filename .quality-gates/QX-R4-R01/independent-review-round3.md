# QX-R4-R01 independent review round 3

Verdict: REJECT  
Score: 28/32  
Open severity counts: S0 0, S1 0, S2 2, S3 2

## Rubric

| Category | Score |
| --- | ---: |
| Notion fit | 4/4 |
| Corpus/coverage | 4/4 |
| Annotation reproducibility | 3/4 |
| Measurement/evidence integrity | 2/4 |
| Legal/rights posture | 4/4 |
| Deterministic source/build binding | 4/4 |
| Validation/negative tests | 3/4 |
| Rollback/human-gate honesty | 4/4 |

## Findings

- S2: `research-validation.json.recorded_at` preceded the capture it claimed to validate by 1,132.711 seconds. The validator did not check chronology.
- S2: receipt and `current-baseline.md` agreed on all three screenshot time/hash intervals, but `ablation.md` did not preserve them and the validator did not enforce three-way synchronization.
- S3: PlayerOccupancy was reproducible only as a manual estimate because coordinate origin and area segmentation were not defined.
- S3: negative coverage did not exercise chronology or interval synchronization.

## Verified results

- Research validation passed with 6 Primary, 2 GitHub, 2 Community, 6 comparable games, and 13 frames.
- Complete-stage validation failed closed with the expected 15 pending candidate, metrics, and human issues.
- Research tests passed 26/26; full tests passed 806/806; typecheck and lint passed.
- Artifact hashes matched; the WebM was VP9, 1920x1080, 6 fps, 12 seconds.
- `HUMAN_PENDING` was honest and correctly blocked R01 completion.

## Limitation

After the reviewer had already derived and reported the chronology finding, a team-status lookup unexpectedly exposed a prior review summary. No prohibited prior-review file was opened and that summary was not used, but this round is not the sole zero-exposure blind authority.
