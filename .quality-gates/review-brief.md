# Artifact-only release review

Review the playable artifact and supplied evidence without using repository history, implementation chat, author identity, or prior-agent conclusions.

## Acceptance contract

- Inspect the running candidate at the supplied localhost URL on desktop and mobile-sized viewports.
- Compare it with `spec.md`, the three checkpoint screenshots, the generated thumbnail, and the automated report.
- Judge visual craft, story legibility, input clarity, exact end-state presentation, responsive layout, accessibility, runtime safety, privacy, and public-release readiness.
- Confirm that the unknown ship reads as exactly three curved ribbon shells around a central void and not as human machinery.
- Confirm that the human visual grammar is rectilinear, the final Japanese title is legible, and no premature text/narration/game-over language breaks the wordless journey.
- Treat reference-device performance and human contest consent as external gates; evaluate whether they are honestly separated rather than claiming them complete.

## Severity rubric

- `S0`: catastrophic harm, destructive behavior, credential/privacy exposure, or an unsafe public artifact.
- `S1`: release-blocking functional failure, inaccessible core journey, broken ending, or a fundamental contract violation.
- `S2`: major quality/readability/usability defect that materially weakens release acceptance.
- `S3`: minor polish, advisory, or external follow-up that does not block this automated public release.

Return a strict report containing: artifact hash/identity reviewed; findings grouped by S0–S3 with concrete evidence; severity counts; strengths; residual external gates; and a final `accept` or `reject`. Acceptance requires zero open S0, S1, and S2 findings.
