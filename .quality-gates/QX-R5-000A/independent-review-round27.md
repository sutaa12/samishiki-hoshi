# QX-R5-000A independent blind review — Round 27

- Exact commit: `0b5345df64e671d566cda756d1747c74b3f95b2f`
- Verdict: **REJECT**
- Score: **26/32**
- Severity: **S0=0, S1=2, S2=1, S3=0**
- Acceptance: blocked; requires at least 28/32 and S0=S1=S2=0.

## Findings

1. **S1 — Human/external pass claims can bypass AI Binary separation.**
   `gate: "Human Release"` with `status: "passed"`, neutral prose such as
   `audit_note: "Human release status: passed"`, `human.decision: "granted"`,
   and `human.passed: 2` all validated successfully.
2. **S1 — Physical artifact identity is not enforced globally.**
   A Human artifact could hard-link to the candidate capture receipt, and a
   candidate screenshot could hard-link to an AI review after updating the
   bound digests. Both validated successfully.
3. **S2 — Malformed Human metadata is accepted.**
   `human.status: null` validated successfully instead of failing closed.

## Verification reported by the reviewer

- `rtk npm run test:research`: 194/194 passed.
- Seven isolated Round 27 bypass probes reproduced all findings.
- QX-R4-R01 AI Binary completion passed; Human Release failed closed.
- `app`, `src`, and `public` were unchanged and matched their required tree IDs.

## Required remediation

- Detect external context through gate descriptors and neutral-key prose, and
  fail closed for broader affirmative scalar/value forms.
- Enforce physical identity uniqueness across every referenced evidence
  artifact, not selected subsets.
- Reject malformed Human result/status/outcome/decision/verdict metadata.
