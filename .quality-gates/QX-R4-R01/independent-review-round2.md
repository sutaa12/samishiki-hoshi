# QX-R4-R01 independent review round 2

Isolation: fresh artifact-only `fork_turns=none`; prior review and implementation history were prohibited.

Verdict: REJECT
Score: 24/32
Open findings: S0 0, S1 0, S2 4, S3 2

## Findings preserved before remediation

1. S2: `PlayerBox` localization ranges and adjacent height values lacked a measurement definition; F04/F05 still inferred numeric TTC from single stills.
2. S2: the screenshot was taken between metric and shell reads, so post-screenshot times/hashes were mislabeled as pixel-atomic.
3. S2: `ablation.md` retained stale exposure and P95 values.
4. S2: validation checked nonempty composition strings but not numeric syntax, ranges, still-image TTC provenance, epistemic separation, or the required two distinct humans.
5. S3: the complete-build manifest generator checked HEAD but not complete worktree cleanliness.
6. S3: the automation receipt and frozen research snapshot were recorded but not digest-validated by the Research Pack validator.

## Remediation boundary

Round 2 grants no acceptance. The next review must inspect the documented `PlayerOccupancy` method, still-only timing rejection, screenshot before/after interval receipt, current ablation values, semantic validator tests, two-participant enforcement, clean build-manifest source check, and digest-bound research receipt.
