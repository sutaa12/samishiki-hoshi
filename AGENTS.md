# LonelyStar implementation contract

This repository implements the Notion-defined game `さみしき星のまたたきよ`.

## Source-of-truth precedence

1. Evidence and acceptance protocol in Notion page 18 (`Codex Evidence-Driven Game Quality Protocol`) and R4 hard gates in page 16.
2. Graphics, renderer, material, temporal, backend, and Hero Slice constraints in Notion page 13 (`写実グラフィック・Mega Demo参照・レンダリング設計`).
3. Product and generation constraints in Notion pages 02, 08, 09, 10, 11, and 12.
4. Visual targets and production process in pages 01, 03, 05, 06, and 07.
5. The executable specification and rebaseline plan in `docs/SPEC.md` and `docs/GFX_REBASELINE_PLAN.md`.
6. Tests and implementation. If these conflict with a higher source, fix the lower source and record the decision.

## Evidence-driven quality gate

Before changing graphics, geometry, camera, controls, onboarding, feedback, or adding a third-party library:

1. Create `docs/research/<task-id>/research-card.md` with `npm run research:init -- <task-id>`.
2. Use at least two distinct primary sources, two distinct maintained GitHub items pinned to semantic versions or full commits, three distinct comparable games from official HTTPS sources, six distinct official frames or timecodes, and two distinct community observations. Large tasks require five comparable games and twelve frames or timecodes.
3. Separate observed facts, inference, and testable hypotheses in every evidence record.
4. Record license, locked version or commit, load/frame/memory cost, fallback, and rollback for every library candidate.
5. Implement one hypothesis in an isolated worktree or behind a feature flag. Do not combine unrelated visual, camera, speed, and post-effect hypotheses in one spike.
6. Compare Current and Candidate under the same camera, input, device, viewport, exposure, backend, and quality.
7. Run `npm run research:validate -- <task-id>` before implementation and `npm run research:validate -- <task-id> --stage complete` before claiming completion.
8. Do not mark the task complete without measurable improvement, a committed Evidence Pack, Git-commit-bound recomputed source/build SHA-256 values, computed numeric comparisons backed by digest-bound receipts, all-pass timestamped raw-human rows with distinct trace realpaths, and a separate responsible-owner receipt bound to the same candidate. Any Human Reject blocks completion. Required Pack files and evidence paths must be repository-contained regular non-symlink files.
9. Reddit, forum posts, AI vision, automated screenshots, object counts, effect counts, and test pass counts cannot override a Human Reject.

External video frames may be inspected only in the minimum amount needed for analysis. Store third-party URLs and timecodes, not redistributed media, unless the repository has explicit reuse rights.

The project-local workflow is `.openai/skills/evidence-driven-game-quality/SKILL.md`. QX-R4-R00 must pass before any new graphics library, geometry generator, or post effect enters Production.

## R4 isolation and release boundary

- Start R4 work from accepted candidate `0a63c462557aad29f947a88460b0380538782d53` in `codex/qx-r4-*` worktrees.
- QX-R4-R00 may change only the research workflow, templates, validation, tests, package commands, decisions, and evidence. Gameplay state, hashes, runtime source, and Production build output must remain unchanged.
- Keep QX-R4-001 through QX-R4-009 blocked until their declared predecessors and Research Gates pass.
- Do not merge to Main or deploy a replacement Sites version until the R4 Human Owner explicitly passes the required binary acceptance gate.

## Isolated graphics rebaseline

- Work only on branch/worktree `graphics-photoreal-megademo` until the integration decision.
- Do not merge to `main`, save or deploy a Sites version, or replace the accepted public candidate from this worktree.
- Preserve the deterministic simulation, input, story timing, replay, accessibility, audio-event, and Twinkle ledger contracts.
- Replace renderer/world-generation internals behind an adapter; visual tier and backend may never mutate gameplay state or hashes.
- Validate Hero Slice A, B, and C in WebGPU High and forced-WebGL2 before proposing integration.
- Generated reference images are targets, never runtime background plates or copied textures.
- Only permissively licensed code may be imported. Record source, locked version/commit, license, modified files, tests, and notices before use.
- Stop at the integration gate and ask the Human Acceptance Owner to choose `Merge`, `Partial Merge`, or `Reject`.

## Non-negotiable behavior

- The public experience is anonymous, free, browser-playable, and has no runtime AI or paid API dependency.
- The default journey lasts exactly 180 seconds and follows LIFE, EARTH, ASCENT, SOLITUDE, ANSWER, TWINKLE in order.
- There are only two actions: steer and give life. Pointer, touch, WASD, arrows, click/tap, and Space are supported.
- Human absence is communicated without narration, dialogue, corpses, or an extinction explanation.
- A pulse affects living nature only and never revives machinery.
- Human works stay rectilinear. The unknown ship stays curvilinear and has three ribbon shells around a central void.
- The same seed plus the same timestamped input stream produces the same TwinkleSeed ledger and hash. Visual quality must never alter simulation state.
- Reduced motion, high contrast, auto-give, wide-flow assistance, mute, and color-independent cues remain functional.

## Delivery rules

- Keep specs, decisions, QA receipts, and release evidence in this repository.
- Bind acceptance evidence to exact source and build SHA-256 values.
- Treat local automation, public deployment health, human play acceptance, rights acceptance, and contest submission as separate gates.
- Never mark a human or legal gate complete without the responsible person.
- Roll back through the prior Git commit and prior Sites version.
