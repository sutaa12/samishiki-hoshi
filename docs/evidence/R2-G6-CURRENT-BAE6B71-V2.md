# R2-G6 corrected evidence package v2

> **Candidate frozen; source review accepted; fresh artifact and blind visual
> review pending.** The game implementation and tested dist contents are
> unchanged from `bae6b71`; only the tar packaging was corrected.

## Exact subject

- Implementation: `bae6b717431bfea1d5a9b50fa61a6af07396a596`
- Tree: `631a910e98c1a741627167d071b4e0482ee3fe9e`
- Ordered 129-file manifest SHA-256:
  `a58db45cacfc3b0d3fc1dfa8e35b541a53af6a1241928d6bdc14d62bdde786ef`
- Source archive SHA-256:
  `c535a63c7e91e98413ee497e066b9b8cab9bae854434517c26655068016cb922`

## Packaging remediation

The first evidence tar preserved the right 110-file dist contents, but macOS
metadata added 132 AppleDouble `._*` members. A raw tar reader therefore saw a
different inventory than `bsdtar`; independent review correctly rejected that
evidence as S2 before visual review.

The v2 archive `.quality-gates/r2-g6-current-bae6b71-v2-dist.tar` was made from
the same extracted tested content with macOS metadata disabled:

- SHA-256: `a6a980e35d281fadfc5141ed34e5a6dee3644e81ce1145ce63bb83eb7abc4797`
- Bytes: 8,894,464
- Raw inventory: 132 members, 110 regular files, 22 directories, 0 symlinks,
  0 AppleDouble members
- Extracted regular bytes: 8,658,603
- Fresh Python extraction: 110 files, 22 directories, 0 symlinks
- Original dist and fresh extraction content digest:
  `916a28e95b0a60e8297930f763a87c705383f5428fe0a9cb022b2a220a7a782b`

BUILD_ID, runtime notice, and all three JS Worker copies remain identical; no
raw TypeScript Worker is present.

## Unchanged validation

- Complete verification: 37 files / 714 tests, typecheck, lint, build PASS.
- Focused current gate: 9 requested files, 18 suites / 87 tests PASS.
- Browser: 8/8, retry/error 0, 10 JSON and 20 unique 1920x1080 PNGs.
- Maximum atomic compile: 43.4 ms; compile/upload/activation >50 ms: 0.
- Post-ready program growth: 0.
- Ten restarts plateau; ten complete generations end with all tracked terminal
  ownership and retained failure references at zero.

## Gate boundary

The next action is a fresh artifact-only blind review of the v2 evidence commit,
including all 20 visual frames. Reference hardware, human play/visual, public
rights, D-005 integration, Main, Sites, and contest submission remain pending.
