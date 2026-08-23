# QX-R5-000A independent blind review — Round 30

- Exact commit: `804876f82850972e98e7089fcd9aa9865b1aaf73`
- Verdict: **REJECT**
- Score: **27/32**
- Severity: **S0=0, S1=2, S2=0, S3=0**
- Acceptance: blocked.

## Findings

1. **S1 — Neutral digest-bound artifacts can launder Human Reject and external
   pass claims.** A neutrally named JSON receipt containing a Human Reject and
   Sites/release success remained semantically unscanned.
2. **S1 — The reference graph is fail-open for malformed and string-form
   references.** An object with malformed `path`/`sha256` was omitted by the
   collector, and an escaping path in `evidence.artifacts` was not validated.

## Verification reported by the reviewer

- Research tests: 209/209 passed.
- R01 AI Binary positive control passed.
- Runtime isolation diff was empty and the checkout remained clean.
