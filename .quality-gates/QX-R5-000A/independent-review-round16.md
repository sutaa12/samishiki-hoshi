# Independent Blind Acceptance Review — QX-R5-000A

Candidate: `2d920d13e4de8aa3fa0abda86fb4467b46189075`  
Verdict: REJECT — 25/32  
Severities: S0 0, S1 2, S2 0, S3 0

## Findings

### S1 — Human refusal gerund bypass

A Human-labeled digest-bound artifact containing `Reviewer is refusing approval.` passed because `refusing` was not recognized with the other refusal forms.

### S1 — Japanese inline subject-swap bypass

Inserting `カメラが` between the ring, obstacle, or target object and its action passed the Japanese relation checks.

## Verified evidence

- Research tests 116/116 and typecheck passed.
- R01 AI migration passed and Human release failed closed.
- AI Binary scope and exact CLI rejected out-of-range and alias variants.
- Runtime trees remained unchanged: app `42df35f01b63990c436d7cc5c45bc3b23cbb155d`, src `a15e510ca1c8c632652e53f043b1ec128d25f728`, public `dbf15b05e8811c7636af5482d777b35bf07cc647`.
