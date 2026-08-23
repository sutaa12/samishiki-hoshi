# Independent Blind Acceptance Review — QX-R5-000A

Candidate: `f36e4ef496882571ab922048303a21bfddefca0c`  
**Verdict: REJECT — 26/32**  
Severities: S0 0, S1 2, S2 2, S3 0

## Findings

### S1 — Human Reject detection has multiple acceptance fail-opens

`human.failed=true`, `human.passed=false`, positive failed counts, Japanese reject counts, full-width numeric counts, `review_type: Human`, nested `metadata.label: Human`, and their referenced Markdown variants passed.

### S1 — Padded keyword lists pass the description gate

Ten-word concept lists joined with `and` satisfied the sentence-like heuristic without describing gameplay.

### S2 — Historical baseline exception is inconsistent

Structured content under top-level `baseline` was scanned even though historical baseline references were intentionally exempt.

### S2 — Pinned assessment names an obsolete validator digest

The assessment records an old monolithic validator SHA that cannot represent the current hardened validator revision.

## Verified evidence

- AI migration passed; Human release failed closed.
- Research tests 86/86 and full tests 866/866 passed.
- 106-file archive and 24-file stable subset recomputed.
- Runtime trees remained unchanged.
- Worktree remained clean.
