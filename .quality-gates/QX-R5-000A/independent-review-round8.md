# QX-R5-000A Blind Acceptance Review

**Candidate:** `e918b8e`  
**Verdict:** **REJECT**  
**Score:** **28/32**  
**Severities:** **S0 0 · S1 1 · S2 1 · S3 0**

The numeric threshold is met, but acceptance requires zero S0–S2 findings.

## Findings

### S1 — Preserved Human rejection can escape `evidence.human`

The contract says a Reject anywhere in optional Human Markdown or `evidence.json` must block. Completion scans only the canonical subtree at `scripts/validate-research-pack.mjs:993`.

Exact disposable-fixture reproduction:

```json
"preserved_human_evidence": {
  "rejection": true
}
```

The R01 AI Binary command returned exit 0 with no issues instead of `HUMAN_REJECT`.

### S2 — Contradictory R01 assessment prose passes

The assessment validator recognizes only narrow contradiction phrases. Appending the following and correctly rebinding the assessment, closure, and evidence digests still passed:

```text
Additional gate statement: Human gate is COMPLETE.
Production gameplay is materially improved.
```

This contradicts the required pending/no-improvement states. It is a semantic-consistency gap, not a request for local reviewer-identity authentication or arbitrary visual understanding.

## Score

| Dimension | Score |
|---|---:|
| Contract/precedence | 4/4 |
| Mode isolation | 4/4 |
| Artifact/build identity | 4/4 |
| Video/telemetry | 4/4 |
| Three-review enforcement | 4/4 |
| Reject/description hardening | 2/4 |
| R01 migration binding | 2/4 |
| Tests/docs/rollback | 4/4 |
| **Total** | **28/32** |

## Verified evidence

- AI migration CLI passed; default Human release failed closed.
- Source archive, 106-file build archive/manifest, and historical upstream pin recomputed.
- Focused tests: 78/78.
- Full tests: 858/858 across 44 files.
- Typecheck and lint passed.
- Worktree remained clean.
