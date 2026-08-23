# QX-R4-R00 independent review — round 1

- Isolation: artifact-only, `fork_turns=none`
- Reviewer role: independent SolMax acceptance reviewer
- Reviewed snapshot: `01a74d4704d07f8dcc12e0fc83a57da4a2f165ba`
- Reviewed tree: `0121aaa123661a1c2d5c36eef0a60465b0ef4d63`
- Verdict: REJECT
- Score: 22/32
- Severity: S0=0, S1=0, S2=3 open, S3=1 mitigated

## Blocking findings

1. `QX-F01` — S2, open at review: complete-stage validation trusted status/count flags without checking structured raw human rows, metric payloads, trace artifacts, or owner evidence.
2. `QX-F02` — S2, open at review: research validation counted syntactic rows without enforcing distinct official comparable sources, distinct frames, or immutable GitHub pins.
3. `QX-F03` — S2, open at review: reusable Evidence Pack templates and validation did not require and recompute source/build SHA-256 bindings.

## Nonblocking diagnostic

`QX-F04` — S3, mitigated: the legacy `data-webgl=true` expectation fails identically at baseline and candidate. The paired diagnostics, runtime-source diff, and selected 9/9 Production checks show it was not introduced by QX-R4-R00.

## Remediation status

The three S2 findings are not considered closed by the implementer. A new frozen snapshot must demonstrate the remediation through negative tests and a second independent review before acceptance.
