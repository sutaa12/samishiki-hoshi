# QX-R5-000A independent blind review — Round 40

- Verdict: REJECT
- Score: 23/32
- Reviewed commit: `8613e8ee465e0912362d4472122f885314615af8`
- Reviewed tree: `ebc57811292aaddfa29bb71d906c5b9b01aecb11`
- Severity: S0 0, S1 2, S2 0, S3 0
- Proceed: no

## Open findings

### S1 — Confusable gate keys in mapped JSON artifacts bypass validation

Digest-referenced and `evidence.artifacts` string-map JSON files containing
mixed-script or all-Cyrillic lookalikes for Sites or Human returned exit 0.
The parsed artifact objects were semantically scanned but did not receive the
confusable-key check applied to `evidence.json` and the R4-R01 closure.

### S1 — Explicit terminal Human rejects in neutral evidence prose are accepted

English, Spanish, and Japanese terminal Human rejection sentences stored under
`audit_note` returned exit 0 because the neutral key did not establish Human
context.

## Verification

- Full research suite: 246/246 passed.
- R4-R01 AI Binary: exit 0.
- R4-R01 Human Release: exit 1 with Human and completion gates closed.
- Runtime trees remained unchanged: `app` `42df35f01b63990c436d7cc5c45bc3b23cbb155d`, `src` `a15e510ca1c8c632652e53f043b1ec128d25f728`, `public` `dbf15b05e8811c7636af5482d777b35bf07cc647`.
- Reviewed repository remained clean and unchanged.

No prior independent-review content was used.
