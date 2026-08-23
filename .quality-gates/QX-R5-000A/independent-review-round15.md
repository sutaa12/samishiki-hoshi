# Independent Blind Acceptance Review — QX-R5-000A

Candidate: `25615df0869a96f3478c2c4bf739c332594bfb6d`  
Verdict: REJECT — 22/32  
Severities: S0 0, S1 3, S2 0, S3 0

## Findings

### S1 — Japanese description semantics fail open

Japanese descriptions passed despite reversing the pulse, obstacle, and ring order; assigning actions to a camera; or negating ring traversal with `なかった`. Japanese relations were tested independently rather than as one ordered player-owned sequence.

### S1 — Nested plural Human descriptors fail open

`descriptors: [{roles: ["Human"]}]` did not propagate Human context to sibling failure results or artifact references.

### S1 — Contracted Human failure prose fails open

Canonical and referenced `didn’t pass` text normalized to `didntpass`, which was not recognized.

## Verified evidence

- Research tests 112/112, typecheck, and lint passed.
- R01 AI migration passed; default and explicit Human-release failed closed.
- Exact top-level `baseline` was exempt while aliases were not.
- Runtime trees remained unchanged: app `42df35f01b63990c436d7cc5c45bc3b23cbb155d`, src `a15e510ca1c8c632652e53f043b1ec128d25f728`, public `dbf15b05e8811c7636af5482d777b35bf07cc647`.
