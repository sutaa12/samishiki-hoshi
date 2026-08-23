# QX-R5-000A independent blind review — round 4

- Subject commit: `a7e9f5d82654a9d466b3c4fa40b26e57d55d7b16`
- Reviewer route: `gpt-5.6-sol`, max reasoning, fresh artifact-only blind context
- Verdict: REJECT
- Score: 20/32
- Severity count: S0 0, S1 2, S2 3, S3 0

## Findings

1. S1 — Human Reject could be hidden by split Markdown emphasis, Japanese labels, alternate evidence fields, Japanese failure words, or a string-valued positive reject count.
2. S1 — Fully rebound rapid patch cuts and subtle full-frame churn satisfied the media thresholds without depicting gameplay.
3. S2 — Compressed frame timestamps, out-of-viewport steering, failed/duplicate ledger events, contradictory review fields, and a repeated-character remediation observation passed.
4. S2 — Lexical `..` and a symlinked intermediate directory passed despite final-component symlink and hard-link protection.
5. S2 — Bold Markdown could hide contradictory R01 verdict, score, and open severity. The old review's historically correct Human-pending wording also needed a dedicated post-Page19 migration assessment rather than reinterpretation.

## Verified positives

- Research tests passed 60/60.
- R01 AI Binary passed while default and explicit Human release failed closed.
- Exact Ring and steering numeric boundaries, ordinary negative review/video cases, inode hard links, zero-width IDs/descriptions, plain contradictory R01 lines, and Runtime tree invariance passed their attacks.

## Frozen evidence

- Subject HEAD: `a7e9f5d82654a9d466b3c4fa40b26e57d55d7b16`
- `app` tree: `42df35f01b63990c436d7cc5c45bc3b23cbb155d`
- `src` tree: `a15e510ca1c8c632652e53f043b1ec128d25f728`
- `public` tree: `dbf15b05e8811c7636af5482d777b35bf07cc647`
- Frozen source archive SHA-256: `2c157d127092d8097ffb735bc07258243dd622471a0deda0774a883dd1a45aaf`
- Validator SHA-256: `f08a16a502cffdb2dba472bf1a47af51ac62a75efe82803ba34dc3e5c5dc4e0b`
- Tests SHA-256: `ed4e86fb8e6f8c90b19a7e6a6b95aef83a700fe310e4f99d5f15dc4e022aa334`

## Review limitations

Only the authorized artifacts and the QX-R5-000A plus Page 19 Notion pages were inspected. Git history/diff/status/blame, runtime contents, deployment state, team state, prior reviews, and unlisted artifacts were excluded. Temporary adversarial fixtures stayed outside the repository and repository files were not modified.
