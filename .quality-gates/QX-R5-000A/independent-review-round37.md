# QX-R5-000A independent blind review — Round 37

- Verdict: REJECT
- Score: 26/32
- Reviewed commit: `69e3cca9564abf0b95a53de917940a4b5a5eb5eb`
- Severity: S0 0, S1 2, S2 0, S3 0
- Proceed: no

## Open findings

- S1: UTF-8 C1 controls remained valid input. `Human status: RE<U+0080>JECT`
  therefore bypassed the rejection vocabulary and passed the R01 AI migration.
- S1: a prior negative token masked a later current success in
  `Human acceptance changed from rejected to passed.`. Spanish prose
  `La aceptación humana fue aprobada.` also remained outside the external-gate
  vocabulary.

## Verification

- Exact commit and clean status: exit 0.
- R4-R01 AI Binary baseline: exit 0.
- Runtime-scoped diff against the parent: empty.
- All three isolated adversarial probes unexpectedly exited 0.

The review was read-only and prior independent-review files were not inspected.
