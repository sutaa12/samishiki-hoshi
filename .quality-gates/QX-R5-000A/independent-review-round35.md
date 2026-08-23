# QX-R5-000A independent blind review — Round 35

- Verdict: REJECT
- Score: 22/32
- Reviewed commit: `91146ea5f43189f2393dd40b0156ebd2de49fad7`
- Severity: S0 0, S1 3, S2 1, S3 0
- Proceed: no

## Open findings

- S1: string-form `evidence.artifacts` paths were validated as files but were not
  semantically scanned. A mapped file containing Human Reject and Sites success
  passed AI Binary.
- S1: a textual `.json` encoded as UTF-16LE failed open because non-UTF-8 decode
  errors or control-byte text were skipped.
- S1: Japanese plain text such as `人間の判定：不合格` and `サイト公開：完了`
  was not recognized by the English-only artifact scanner.
- S2: public lifecycle aliases such as `deployment.status` were outside the
  external-gate namespace.

## Verification

- Exact commit and clean status: exit 0.
- R4-R01 complete AI Binary: exit 0, `ok: true`.
- Unknown acceptance mode: exit 1.
- Isolated adversarial probe: 5/5 passed, including one control and all four
  acceptance bypass reproductions.

Runtime trees remained unchanged. Review writes were confined to a temporary
directory, and no prior independent-review contents were read.
