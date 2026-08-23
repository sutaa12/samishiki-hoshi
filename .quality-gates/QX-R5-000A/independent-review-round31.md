# QX-R5-000A independent blind review — Round 31

- Exact commit: `05b25a1c6500391e3c9a7a72c0ac2475fb6d3087`
- Verdict: **REJECT**
- Score: **25/32**
- Severity: **S0=0, S1=2, S2=0, S3=0**
- Acceptance: blocked.

## Findings

1. **S1 — Digest-bound textual receipts can bypass semantic scanning.** The
   extension allowlist and narrow context rules missed ordinary Sites-success
   prose, participant CSV rejection, JSON stored under `.bin`, and
   `approved_by: Human` beside a passed status.
2. **S1 — The R01 historical exception is path-only.** An R5 fixture could
   reference the R01 historical path with matching attacker-controlled bytes and
   receive the semantic exception. It must require task, exact path, and pinned
   digest together.

## Verification reported by the reviewer

- Research tests: 212/212 passed.
- R01 AI Binary passed; Human Release and invalid scope/CLI failed closed.
- Typecheck, targeted lint, and syntax check passed.
- Runtime isolation remained intact and the checkout was clean.
