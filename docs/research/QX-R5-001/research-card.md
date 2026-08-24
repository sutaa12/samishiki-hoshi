# Research Card

Task ID: QX-R5-001
Owner agent: Codex Orchestrator
Date: 2026-08-23
Source commit: 0a63c462557aad29f947a88460b0380538782d53
Candidate branch/worktree: codex/qx-r4-r00-evidence-protocol
Scale: standard

## Player-facing failure

Quality-sensitive changes can pass automated tests while a first-time player still cannot recognize the intended material, shape, route, action, or feedback because the repository does not require external comparison, a same-condition baseline, or raw human evidence before implementation and completion.

## Questions

- Which repository-local contract makes missing primary, GitHub, comparable-game, community, baseline, license, decision, and rollback evidence fail closed?
- Can the workflow remain dependency-free and leave gameplay hashes and Production output unchanged?

## Current baseline

- URL or build: public R3 test candidate and local QX-R3-006 build
- Source SHA: 0a63c462557aad29f947a88460b0380538782d53
- Device: Apple host used for QX-R3-006 evidence
- Viewport: 1920x1080
- Backend and quality: actual host-Metal WebGPU High plus forced WebGL2
- Screenshot: `.quality-gates/screenshots/qx-r3-006-moving-master-start.png`
- Moving clip: `.quality-gates/qx-r3-006-moving-master-12s.webm`
- Load, frame, and memory: `.quality-gates/qx-r3-006-playwright-o2-accepted.json`
- Human raw findings: Notion page 16 records the R3 Human Reject and five binary failure categories; it supersedes the former median score.

## External evidence

See `references.csv`. Observed facts, inference, and hypotheses are separate columns.

## Similar games

See `comparable-games.csv` and `frame-analysis.csv`. QX-R5-001 uses official-page frames only as a structural sample. Quantitative 12-frame analysis belongs to QX-R4-R01.

## GitHub candidates

See `library-scorecard.md`. Ajv and Zod were evaluated as maintained MIT schema validators but rejected here because native Node validation covers the fixed repository schema without a new dependency.

## Options

- A: Dependency-free Node scripts plus Markdown/CSV/JSON templates and Vitest subprocess tests.
- B: Add Ajv and JSON Schema for `evidence.json` while leaving Markdown and CSV checks bespoke.
- C: Add Zod and build a TypeScript-only validator bundled through the project toolchain.

## Chosen option

Choose A. It validates every required file and cross-file invariant without affecting runtime dependencies, bundle size, browser code, or gameplay. Ajv/Zod remain candidates if later schema evolution makes native checks materially harder to maintain.

Budget: zero runtime or development dependencies; repository scripts only.

Fallback: remove the QX-R5-001 commit and return to the accepted R3 candidate.

Rollback: `0a63c462557aad29f947a88460b0380538782d53`

## Acceptance

### Numeric hard gates

- Empty pack fails, community-only pack fails, complete sample passes, all required file/count/license/SHA/rollback checks are exercised, and existing verification/build pass without runtime-source changes.

### Human binary question

- For future quality tasks: can a first-time human describe the Candidate improvement under the same conditions? QX-R5-001 itself changes process only and does not claim a gameplay-quality Human pass.

## Gate status

- Research: passed by `npm run research:validate -- QX-R5-001`
- Implementation: isolated in `codex/qx-r4-r00-evidence-protocol`
- Completion: governed by QX-R5-001 explicit tests and independent review; generic quality-task completion remains fail-closed without human evidence.
