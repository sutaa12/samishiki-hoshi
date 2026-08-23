# QX-R5-000A independent blind review — Round 29

- Exact commit: `621c049b31dff35a7f347cc41410cb11f4cafef7`
- Verdict: **REJECT**
- Score: **30/32**
- Severity: **S0=0, S1=0, S2=1, S3=0**
- Acceptance: blocked until the S2 finding is fixed and independently rerun.

## Finding

**S2 — R01's historical-baseline exception disables artifact integrity, not
only Reject semantics.** `baseline.human_findings` is intentionally skipped by
R01 Human-Reject interpretation, but its referenced file was consequently not
required to remain regular, repository-contained, and SHA-256 exact. Tampering
`docs/research/QX-R4-R01/baseline-human-findings.md` left R01 AI Binary accepted.

The exception must apply only to semantic Reject interpretation. Artifact path,
file type, physical identity, and digest validation must remain mandatory.

## Verification reported by the reviewer

- Research tests: 208/208 passed.
- R01 AI Binary positive control passed; Human Release failed closed.
- QX-R5-000A was correctly outside AI Binary acceptance scope.
- Runtime-path diff was empty and the checkout remained clean.
- All other reviewed areas were satisfactory.
