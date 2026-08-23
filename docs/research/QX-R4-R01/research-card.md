# Research Card

Task ID: QX-R4-R01
Owner agent: Codex
Date: 2026-08-23
Source commit: 1323ade4c4c9197609f88593dbf6510b7c088f9b
Candidate branch/worktree: codex/qx-r4-r01-reference-corpus
Scale: large

## Player-facing failure

Under one fixed 1920x1080 WebGL2/high capture condition, the current EARTH and SOLITUDE checkpoints do not make the protagonist, direction, goal, and hazard confidently identifiable; LIFE identifies the protagonist but rectilinear foreground forms obscure the route.

## Questions

- Which composition measures recur in official imagery for forward-moving, low-UI 3D games?
- Which measures can become falsifiable constraints without copying protected expression or changing deterministic simulation?

## Current baseline

- URL or build: committed source served at `http://localhost:4174/`; no public deployment changed
- Source SHA: 1323ade4c4c9197609f88593dbf6510b7c088f9b
- Device: macOS desktop Chromium through Playwright 1.62.1
- Viewport: 1920x1080, DPR 1
- Backend and quality: WebGL2, high, full motion, standard contrast, seed 20260818
- Screenshot: `.quality-gates/QX-R4-R01/current-earth-48s.png`
- Moving clip: `.quality-gates/QX-R4-R01/current-earth-moving-12s.webm`
- Load, frame, and memory: `.quality-gates/QX-R4-R01/current-capture-metrics.json`
- Human raw findings: `baseline-human-findings.md`; the R01 two-viewer test remains `HUMAN_PENDING`

## External evidence

`references.csv` separates observed facts, inference, and testable hypotheses. Official sources establish six comparable games; GitHub and community rows are supporting evidence only.

## Similar games

`comparable-games.csv` and `frame-analysis.csv` contain 13 URL/timecode or official-frame locators. No third-party screenshot or video is redistributed.

## GitHub candidates

`library-scorecard.md` records the existing capture dependency, offline encoder boundary, and no-new-library SVG/JSON path. No new runtime package is adopted.

## Options

- A: Commit a data-only corpus, numeric annotations, project-owned current captures, and testable future constraints.
- B: Embed third-party screenshots or footage in the repository for a richer visual board.
- C: Change Production rendering immediately from qualitative references before blind human validation.

## Chosen option

Option A. It preserves rights and deterministic runtime while turning observations into measurable R4 hypotheses. B is rejected because redistribution rights are not granted. C is rejected because references alone are not acceptance evidence.

Budget: 6 official games, 13 annotated frames, one reproducible capture pass, and zero external-media files in the repository.

Fallback: retain the current Production build and use the CSV corpus only as planning evidence.

Rollback: `1323ade4c4c9197609f88593dbf6510b7c088f9b`

## Acceptance

### Numeric hard gates

- At least 5 games, at least 12 official frame/timecode annotations, at least 1 same-condition current capture, and exactly 0 redistributed third-party media files.

### Human binary question

- Can each of two people unfamiliar with the plan point to the protagonist, travel direction, goal, and hazard for every selected frame without being told the intended answer?

## Gate status

- Research: passed after `npm run research:validate -- QX-R4-R01`
- Implementation: not applicable; this task changes no Production runtime
- Completion: `HUMAN_PENDING` until the two-viewer frame-identification receipt exists
