# QX-R5-000A independent blind review — Round 36

- Verdict: REJECT
- Score: 26/32
- Reviewed commit: `faa505baf42a896053084e5f534b574cfa7c8ee6`
- Severity: S0 0, S1 2, S2 0, S3 0
- Proceed: no

## Open findings

- S1: removing `evidence.artifacts.human_test` and rewriting the still-present
  optional `human-test.md` as UTF-16LE allowed a preserved Human Reject to pass
  AI Binary. Optional canonical Human text used non-fatal UTF-8 decoding outside
  the strict mapped/reference scanner.
- S1: invoking the validator from a script path containing spaces returned exit
  0 with no output because the CLI main guard compared an encoded URL with an
  unencoded `file://` string.

## Verification

- R4-R01 AI Binary: exit 0.
- R4-R01 Human Release: exit 1 with Human and completion gates closed.
- UTF-16LE omitted-map probe: unexpected exit 0.
- space-path CLI probe: unexpected exit 0 with no report.
- Reviewed worktree remained clean and runtime trees were unchanged.

The review was read-only and did not inspect prior independent-review files.
