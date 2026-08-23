# Research Card

Task ID: {{TASK_ID}}
Owner agent: {{OWNER_AGENT}}
Date: {{DATE}}
Source commit: {{SOURCE_COMMIT}}
Candidate branch/worktree: {{CANDIDATE_BRANCH}}
Scale: standard

## Player-facing failure

{{PLAYER_FACING_FAILURE}}

## Questions

- {{RESEARCH_QUESTION}}
- {{DECISION_QUESTION}}

## Current baseline

- URL or build: {{BASELINE_URL}}
- Source SHA: {{SOURCE_COMMIT}}
- Device: {{DEVICE}}
- Viewport: {{VIEWPORT}}
- Backend and quality: {{BACKEND_QUALITY}}
- Screenshot: {{BASELINE_SCREENSHOT}}
- Moving clip: {{BASELINE_CLIP}}
- Load, frame, and memory: {{BASELINE_METRICS}}
- Human raw findings: {{BASELINE_HUMAN_FINDINGS}}

## External evidence

See `references.csv`. Every row must keep Observed, Inference, and Testable hypothesis separate.

## Similar games

See `comparable-games.csv` and `frame-analysis.csv`. Store third-party URLs and timecodes, not redistributed media.

## GitHub candidates

See `library-scorecard.md`. Pin every evaluated repository to a version or commit and record license, cost, fallback, and rollback.

## Options

- A: {{OPTION_A}}
- B: {{OPTION_B}}
- C: {{OPTION_C}}

## Chosen option

{{CHOSEN_OPTION}}

Budget: {{BUDGET}}

Fallback: {{FALLBACK}}

Rollback: `{{SOURCE_COMMIT}}`

## Acceptance

### Numeric hard gates

- {{NUMERIC_HARD_GATE}}

### Human binary question

- {{HUMAN_BINARY_QUESTION}}

## Gate status

- Research: pending
- Implementation: blocked until `npm run research:validate -- {{TASK_ID}}` passes
- Completion: blocked until `npm run research:validate -- {{TASK_ID}} --stage complete` passes
