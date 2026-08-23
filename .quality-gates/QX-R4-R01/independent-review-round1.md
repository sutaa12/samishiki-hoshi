# QX-R4-R01 independent review round 1

Isolation: artifact-only, `fork_turns=none`; reviewer was prohibited from reading implementation history, Git history, or prior reviews.

Verdict: REJECT
Score: 23/32
Open findings: S0 0, S1 0, S2 5, S3 1

## Findings preserved before remediation

1. S2: TTC and feedback timing values were not reproducible; Star Fox values lacked an event locator/procedure and Rez mixed a still-image estimate with a not-measurable statement.
2. S2: baseline prose mislabeled query times and exposure as actual screenshot conditions.
3. S2: the capture harness accepted a pre-existing localhost server and therefore could not bind served bytes to the asserted source.
4. S2: the recorded Production digest covered only selected stable assets and omitted runtime JavaScript; the research subject identity was also absent.
5. S2: research validation checked counts but did not enforce the substantive annotation columns, numeric gate artifacts, or absence of embedded media.
6. S3: Playwright used a range in `package.json`, and the receipt omitted exact Playwright, Chromium, and FFmpeg versions.

## Remediation boundary

Round 1 did not grant acceptance. The next review must independently verify the source-owned server launch, actual receipt values, complete 106-file build manifest, substantive validator fields, media scan, exact tool versions, and rewritten timing claims. Human acceptance remains separate and pending.
