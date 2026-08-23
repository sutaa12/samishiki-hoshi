# QX-R5-000A independent blind review — round 5

- Subject commit: `33a78a2b1720f4bc59f088110d9d9fdcb28d30e0`
- Reviewer route: `gpt-5.6-sol`, max reasoning, fresh artifact-only blind context
- Verdict: REJECT
- Score: 21/32
- Severity count: S0 0, S1 2, S2 4, S3 2

## Findings

1. S1 — Arbitrary moving imagery plus fully forged local review receipts can satisfy a repository-local gate; direct pixel metrics prove activity rather than gameplay semantics.
2. S1 — Reject tokens split by punctuation, whitespace, combining marks, Japanese spacing, or alternate count keys remained bypasses.
3. S2 — AI Binary acceptance was not restricted to QX-R5-001 through QX-R5-007; the positive fixture still used QX-R4-R00.
4. S2 — Extra boolean and semantic fields could contradict otherwise passing review or ledger schemas.
5. S2 — The dedicated R01 assessment was digest-bound but not fully parsed for task/source/build/historical review/retained external-boundary subjects; its evidence digest predated final closure rebinding.
6. S2 — The candidate build SHA bound a declared manifest file without verifying each manifest entry against a physical build file.
7. S3 — Remediation observations used only length and character diversity.
8. S3 — Baseline and Candidate captures were inode-distinct within each group but not across the complete comparison set.

## Verified evidence

- Research tests passed 64/64.
- R01 AI Binary passed; default and explicit Human release failed closed.
- Runtime trees matched the frozen base.
- Closure, validation, and migration-assessment digests matched their direct references.

## Frozen evidence

- Subject HEAD: `33a78a2b1720f4bc59f088110d9d9fdcb28d30e0`
- Frozen source archive SHA-256: `95d2c6c23e8fc09e0cba732268d4f8fda8f3b0400240a725bee02259d1e69d9b`
- `app` tree: `42df35f01b63990c436d7cc5c45bc3b23cbb155d`
- `src` tree: `a15e510ca1c8c632652e53f043b1ec128d25f728`
- `public` tree: `dbf15b05e8811c7636af5482d777b35bf07cc647`
- Validator SHA-256: `eb0c169725c69f39cc85eee20389c6f6fd4608bae3d1d5197e2db0c58e8514d4`
- Tests SHA-256: `11fb8fbae53e52a31dee03bcde9b74670af19273ca379d03cc2e7ce94ee93f6d`

## Review limitations

This was artifact-only and intentionally excluded runtime contents, Git history/diff/status/blame, deployment, prior QX-R5 reviews, team state, and external approvals. Temporary adversarial media stayed outside the repository and was removed.
