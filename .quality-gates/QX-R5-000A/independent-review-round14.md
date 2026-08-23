# Independent Blind Acceptance Review — QX-R5-000A

Candidate: `ae4d5e95bbaa4b7afb425f1fdfcb57c5d4d0990e`  
Verdict: REJECT — 22/32  
Severities: S0 0, S1 2, S2 1, S3 1

## Findings

### S1 — Human Reject context aliases fail open

An artificial top-level `base line` key was exempted like the exact historical `baseline` field. Nested `reviewer: {role: "Human"}` and plural `reviewer_roles: ["Human"]` did not propagate Human context to sibling failure status fields.

### S1 — Gameplay relationships are not strict enough

Descriptions saying the droplet moves beside a ring, or assigning the final light action to a camera, passed. Token proximity did not prove ring traversal or preserve the player as the implied subject across sequential clauses.

### S2 — Internal-insertion expected-answer copy bypass

Japanese descriptions preserving the canonical answer as an ordered subsequence while inserting adjectives passed the copy check.

### S3 — Local trust boundary

Local review and pixel evidence cannot authenticate external reviewer identity or semantics. This remains non-blocking.

## Verified evidence

- Research tests 107/107 passed.
- R01 AI migration passed; R01 Human release failed closed.
- Runtime trees remained unchanged: app `42df35f01b63990c436d7cc5c45bc3b23cbb155d`, src `a15e510ca1c8c632652e53f043b1ec128d25f728`, public `dbf15b05e8811c7636af5482d777b35bf07cc647`.
