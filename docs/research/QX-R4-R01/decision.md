# Decision

Task ID: QX-R4-R01
Source commit: be0eb51661df90bc21bdb471a8a626078ff92ce3

## Options considered

| Option | Evidence for | Evidence against | Cost | Fallback | Decision |
| --- | --- | --- | --- | --- | --- |
| A: data-only reference corpus | Six official sources support 13 measurable compositions; local captures expose current failures | Still needs two uninformed humans to test semantic readability | Documentation and offline capture only | Keep current Production unchanged | Selected |
| B: embed third-party media | Easier visual browsing | Redistribution permission was not established and pixels are unnecessary for reproducible locators | Rights review and repository growth | Official URL/timecode locators | Rejected: rights and provenance risk outweigh convenience |
| C: immediate visual rewrite | Could act on observations quickly | Confounds multiple hypotheses and substitutes reference taste for acceptance evidence | Runtime change and revalidation | Defer to later R4 implementation tasks | Rejected: no blind human evidence yet |

## Chosen option

Decision: adopt the data-only corpus and current project-owned baseline; do not change Production rendering in R01.

Rationale: official evidence repeatedly exposes player occupancy, route width, vanishing structure, depth bands, contrast roles, TTC, and feedback timing as measurable dimensions. The current captures show failures on these dimensions, but no external source proves a particular solution.

Expected measurable improvement: this task itself targets 6 official games, at least 12 annotated frames, at least 1 current same-condition capture, and 0 redistributed third-party media. Later candidates must test a single constraint against human semantic answers.

Known side effects: repository growth from three project-owned PNGs and one 12-second WebM; no runtime dependency, public deployment, simulation, or Production asset change.

Human gameplay/release evidence: still pending and not supplied by this research-only ledger. The former two-person R4 frame condition is retained as historical context, not as R01's current completion gate.

## Binding

All baseline evidence and rollback values bind to the source SHA in `evidence.json`. External observations bind to official HTTPS URLs plus timecodes/frame labels, never copied media.
