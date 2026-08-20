# Hero R33 artifact-only blind-review brief

Review only the exact Hero R33 bundle bound below. Work read-only, stop at the
first reproducible S0, S1, or S2, and report start/end hash drift. Do not infer
acceptance for R2-G6 as a whole, GFX-004/005/006, reference hardware, human
play/visual approval, rights, Main integration, Sites deployment, or contest
submission.

## Exact implementation

- commit `e1b101b9438097f739437e0a50af80774fd707ed`
- tree `5c7540fdb86831d46411c7d7aadbabc0e75770ba`
- artifact manifest `.quality-gates/hero-r33-e1b101b-artifact.json`

## Reproduction obligations

1. Recreate a `git archive` of the implementation commit and verify embedded
   commit, SHA-256 `7167c754d0c43fc89e91463969bc79a8ab8071d322ec298aee118abb655c971b`,
   165,591,040 bytes, 267 regular files, and zero symlinks.
2. Validate every implementation file hash and the ordered 23-file manifest
   SHA-256 `32e450a006ef177557cd019422af61561ee4ebf3f70290c48f45bd7f9032aafb`.
3. Extract the preserved dist only into a fresh temporary directory. Confirm
   archive SHA, 110 files, zero symlinks, content-record digest, BUILD_ID,
   notices, three identical JavaScript Worker copies, and no raw TypeScript
   Worker artifact.
4. Parse the Vitest, Playwright, and production-audit JSON rather than trusting
   prose. Verify 18/18 focused assertions, 6/6 browser cases, retry/error fields,
   exactly 20 PNG attachments, and zero production vulnerabilities.
5. Decode all Playwright PNG bodies and compare byte-for-byte with the supplied
   attachment set if available. Confirm that evidence contains only Hero A/B/C
   cases, not Foundation acceptance.
6. Validate the generated asset checksum list 10/10. Treat its SHA
   `63c02536...` as distinct from the intake manifest SHA `7b030d03...`.
7. Inspect the Hero A sea-fan geometry and tests, Hero B wet-cliff PBR channel
   separation, Hero C story geometry, source READMEs, and provenance boundary.
8. Confirm human art/rights, human play/visual, reference hardware, Main/Sites,
   R2-G6 combined acceptance, and submission remain explicitly pending.

Accept only if S0=0, S1=0, S2=0 and all exact bindings reproduce without drift.
