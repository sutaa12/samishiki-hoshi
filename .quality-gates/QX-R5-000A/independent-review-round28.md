# QX-R5-000A independent blind review — Round 28

- Exact commit: `a9fe8885efba664a11f467bea4ffec827af0da3b`
- Verdict: **REJECT**
- Score: **20/32**
- Severity: **S0=0, S1=4, S2=0, S3=0**
- Acceptance: blocked; requires at least 28/32 and S0=S1=S2=0.

## Findings

1. **S1 — External completion claims evade detection.** Completion words such
   as `cleared`, `merged`, `published`, `submitted`, and `shipped`, split gate
   names, and malformed non-Human external results validated successfully.
2. **S1 — Preserved Human Reject can be fragmented or hidden.** A Human notes
   array containing `re` and `jected`, and a top-level baseline Human rejection,
   were not detected. The baseline case must be reconciled with the explicit
   historical-baseline exception used by the R5 migration.
3. **S1 — R01 closure accepts contradictory and malformed authoritative
   metadata.** Empty issuer/policy/rollback fields and a withdrawn-gate string
   claiming external completion passed after rebinding the closure digest.
4. **S1 — Rollback evidence bypasses digest and inode separation.** The bare
   `rollback.artifact` string could point to a hard-link alias and is not
   collected by the digest-reference identity audit.

## Verification reported by the reviewer

- Research tests: 201/201 passed.
- Typecheck and lint passed.
- R01 AI migration passed and Human Release failed closed.
- QX-R5-008 and unexpected CLI arguments failed closed.
- Runtime files were unchanged and the checkout remained clean.
