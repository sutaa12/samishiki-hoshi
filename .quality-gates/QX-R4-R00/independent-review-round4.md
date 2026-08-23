# QX-R4-R00 independent review — round 4

- Isolation: fresh artifact-only context, `fork_turns=none`; prior review and acceptance files prohibited
- Reviewer role: independent SolMax acceptance reviewer
- Reviewed snapshot: `bce184dd411241c1f5fb1b99ae4eae280f271c8c`
- Reviewed tree: `cd3e0bae33abfdb47ab2a137197e94d3d692e00d`
- Verdict: REJECT
- Score: 25/32
- Severity: S0=0, S1=2 open, S2=0, S3=1 open and 1 mitigated

## Blocking findings

1. Completion did not require digest-bound Current/Candidate screenshot, moving clip, and input-trace artifacts or a candidate-bound capture receipt; baseline capture fields were only nonempty strings.
2. `rollback.md` accepted any 40-hex document commit and did not bind the expected gameplay hash to the accepted baseline.

## Nonblocking findings

- S3 open at review: no explicit candidate-bound successful `npm run build` receipt was available.
- S3 mitigated: the paired legacy Journey diagnostics fail identically at baseline and candidate and are not a QX-R4-R00 regression.

## Remediation status

The S1 findings are not considered closed by the implementer. A new snapshot must validate digest-bound baseline captures, distinct Candidate screenshot/clip/input trace plus a task/source/build-bound capture receipt, a candidate-bound successful build receipt, exact rollback document commit equality, and exact baseline gameplay-hash equality. Negative tests must cover missing, outside, directory, symlink, realpath alias, digest mismatch, and rollback mismatch.
