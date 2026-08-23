# QX-R4-R00 independent review — round 2

- Isolation: fresh artifact-only context, `fork_turns=none`
- Reviewer role: independent SolMax acceptance reviewer
- Reviewed snapshot: `9155ce4ae8eefb377368ec73c1955fbd0902bec6`
- Reviewed tree: `502a844f586cb23cff7786a229e2b092d208c95b`
- Verdict: REJECT
- Score: 24/32
- Severity: S0=0, S1=2 open, S2=2 open, S3=0

## Blocking findings

1. `F-01` — S1, open at review: numeric completion evidence accepted copied `regression: false` and `passed` flags without evaluating comparison direction, tolerance, target, observation, or receipt contents.
2. `F-02` — S1, open at review: one fabricated file could be reused as raw answers, participant trace, and owner evidence without candidate-bound owner receipt validation.
3. `F-03` — S2, open at review: evidence paths accepted directories and could follow repository-local symlinks outside the intended evidence boundary.
4. `F-04` — S2, open at review: invalid scale values fell back to standard, official-source labels were self-declared, and URL query/fragment variants bypassed exact duplicate checks.

## Remediation status

The findings are not considered closed by the implementer. A new frozen snapshot must demonstrate computed numeric comparisons, digest-bound machine receipts, distinct human/trace/owner files, regular non-symlink repository containment, explicit scale validation, canonical URLs, and Primary proof for official sources. A fresh isolated reviewer must confirm zero open S0-S2.
