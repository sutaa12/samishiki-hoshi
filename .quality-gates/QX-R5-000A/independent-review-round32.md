# QX-R5-000A independent blind review — Round 32

- Exact commit: `acdc3028e02f2da6d144c3140d67bea9fbcc2e38`
- Verdict: **REJECT**
- Score: **24/32**
- Severity: **S0=0, S1=3, S2=0, S3=0**
- Acceptance: blocked.

## Findings

1. **S1 — Human Reject sibling-metadata bypass.** `authority: Human` beside a
   rejected status did not create Human context.
2. **S1 — External-success bypasses.** `gate: Sites` beside a published status
   was not propagated, and a pending Human clause suppressed a successful Sites
   clause in the same sentence.
3. **S1 — Reference graph is one level deep.** A digest-bound JSON index could
   reference a second digest-bound Human Reject artifact without traversal.

## Verification reported by the reviewer

- Research tests: 217/217 passed; typecheck and lint passed.
- R01 AI migration passed; invalid scope failed closed.
- Invalid UTF-8 binary remained safely opaque.
- Runtime isolation remained intact and the checkout was clean.
