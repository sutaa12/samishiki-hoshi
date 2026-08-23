# QX-R5-000A Blind Review — Round 25

## Verdict

**REJECT**

- Exact commit: `c323cd9cf3219c90e9f019ec4c49d151df857bb0`
- Score: **20/32**
- Severity counts: **S0 0 / S1 5 / S2 0 / S3 0**
- Isolation: read-only; no prior QX-R5-000A independent-review artifact was accessed.

## Findings

1. A syntactically valid but mismatching Human artifact digest is silently reduced to a null read instead of a blocking reference error.
2. Human `.txt` prose `result: false` and a format-only participant ID bypass rejection discovery.
3. `through zero ring` and Japanese `AIで操作して` pass gameplay semantics.
4. Copied skeletons can perturb the structure fingerprint by inserting vocabulary tokens as modifiers.
5. AI Binary accepts contradictory Human/Owner release-pass claims in the same evidence.

## Required remediation

- Validate every discovered Human reference physically; null reads, digest mismatches, missing paths, symlinks, and invalid path/inode state must fail closed.
- Detect generic false result/status/outcome/decision/verdict prose and reject format-only provenance IDs.
- Reject zero/nil/none traversal and AI/computer/unmanned/self-propelled controller wording.
- Derive duplicate structure from captured semantic roles while ignoring all modifiers.
- Reject Human, Owner, Legal, Main, Sites, Contest, and release-ready pass claims in AI Binary evidence.
- Preserve all payloads as regression tests.

## Verified checks

- Research tests: 175/175 passed.
- R4-R01 AI Binary: exit 0.
- R4-R01 Human Release: exit 1 with Human gates blocked.
- Diff check clean; candidate changed validator and tests only.

