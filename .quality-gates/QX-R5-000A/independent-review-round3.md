# QX-R5-000A independent blind review — round 3

- Subject commit: `f4a4ceaccf0dfecdc3a48e68da2381ca49bd080e`
- Reviewer route: `gpt-5.6-sol`, max reasoning, fresh artifact-only blind context
- Verdict: REJECT
- Score: 22/32
- Severity count: S0 0, S1 1, S2 4, S3 1

## Findings

1. S1 — Human Reject could be hidden behind `Status:`, a full-width colon, Markdown emphasis/list markers, or an invisible format character.
2. S2 — Frame-hash continuity accepted both 150 hard-cut static plates and a black still with one changing pixel.
3. S2 — Zero-width Unicode made one visible Reviewer ID appear distinct and made visible expected-answer copies produce distinct fingerprints.
4. S2 — The R01 closure parser accepted an indented, quoted, or bulleted contradictory Reject and open S2 prose after an accepted header.
5. S2 — Hard links to one inode counted as distinct review/capture artifacts because only real paths were compared.
6. S3 — All semantic ledger events could share one timestamp because timestamp ordering was nondecreasing rather than strictly increasing.

## Verified positives

- Research tests passed 53/53.
- R01 AI Binary passed; default and explicit Human release failed closed.
- Numeric Ring and steering thresholds, per-decoded-frame telemetry, normal ordering failures, canonical remediation map, ordinary copy attacks, direct symlinks, lexical aliases, and R01-only migration boundaries passed the requested attacks.
- Runtime trees matched the frozen base exactly.

## Frozen evidence

- Subject HEAD: `f4a4ceaccf0dfecdc3a48e68da2381ca49bd080e`
- `app` tree: `42df35f01b63990c436d7cc5c45bc3b23cbb155d`
- `src` tree: `a15e510ca1c8c632652e53f043b1ec128d25f728`
- `public` tree: `dbf15b05e8811c7636af5482d777b35bf07cc647`
- R01 closure SHA-256: `f4c0dde9b24f48e409ef8a8ad42e30e9fbff2c629e7f8fff15175a6ae6d90e08`
- Research validation SHA-256: `6561475d17170dde7b37a0bf41a9bcc6bf8c86227c1ef811c4927f48f29b779e`
- Bound R01 review SHA-256: `4b6b14b9ba94708815e4677eea0d663f4a21c962405f225b0121a077272bfc79`
- Production-stable manifest SHA-256: `03e23eeb422a8292503b43da33cdead2629be3be9774c3f351b865dba5303c25`

## Review limitations

The review used only the authorized artifacts and the QX-R5-000A plus Page 19 Notion pages. Git history/diff/status/blame, runtime contents, deployment state, team state, prior reviews, and unlisted repository artifacts were excluded. Temporary adversarial fixtures were removed and repository files were not modified.
