# LonelyStar implementation contract

This repository implements the Notion-defined game `さみしき星のまたたきよ`.

## Source-of-truth precedence

1. Notion page 19 (`R5 Minimum Communicative Game Reset`) is the R5 Gameplay source of truth.
2. Notion page 18 (`Codex Evidence-Driven Game Quality Protocol`), with page 19's R5 AI Binary policy taking precedence where the two differ.
3. Notion page 16 (`Human Reject再設計`) for the accepted failure analysis and measurable failure thresholds.
4. Notion page 17 (`Perceptual Realism Pipeline`), frozen until QX-R5-005 passes.
5. Existing long-term product, narrative, renderer, generation, visual-production, and executable specifications in Notion pages 01–13, `docs/SPEC.md`, and `docs/GFX_REBASELINE_PLAN.md`.
6. Tests and implementation. If these conflict with a higher source, fix the lower source and record the decision.

## R5 isolation and AI Binary acceptance

- QX-R5-001 through QX-R5-005 live only under `/r5-minimum`, `app/r5-minimum/`, `src/game/r5/`, `src/gfx/r5/`, and `tests/r5/` until their declared integration gate passes.
- QX-R5-001 through QX-R5-007 use the `ai_binary_gameplay` acceptance mode. Human raw rows, Human scores, and an Owner receipt are not completion requirements for Research, Graybox, or AI-comprehension gates in this isolated pre-Human candidate workflow.
- This exception does not override or erase a Human Reject. Human play acceptance, rights/legal acceptance, Main integration, final public release, and contest submission remain separate Human or external gates.
- The 15-second loop is the active Gameplay contract. Do not import the legacy 180-second renderer, six-phase journey, PRP, or a new graphics library into `/r5-minimum` before QX-R5-005 passes.
- AI Binary completion uses `npm run research:validate -- <task-id> --stage complete --acceptance ai-binary` and requires telemetry, a directly decoded continuously moving video of at least 15.000 seconds, a semantic event ledger, the exact Page 19 remediation routing map, and three distinct physical artifact-only blind AI reviews bound to one source, build, and video digest. Media validation must reject hard-cut slideshows and imperceptible pixel churn through luma-difference, spatial-range, and scene-cut checks. Telemetry frame count must equal decoded video frames and contain the complete monotonic distance trace; Ring area must grow at least 4x within 2.5 seconds; steering must move at least 12px within 100ms and at least 10% of the viewport within 300ms.
- The default and release command remains `--acceptance human-release`; its raw Human rows and responsible Owner receipt stay fail-closed.
- The `research-only-ai-accepted` exception is valid only for QX-R4-R01 and only with a digest-bound independent `ACCEPT` review scoring at least 28/32 with zero S0-S2 findings. No R5 task may use this exception.
- Repository-local validation proves task scope, physical artifact identity, build-manifest recomputation, media activity, telemetry semantics, and digest consistency. It cannot cryptographically authenticate the external Codex reviewer process or prove gameplay meaning from arbitrary pixels. The orchestrator must actually run three isolated reviewers and preserve their invocation provenance; do not describe locally forgeable JSON as a cryptographic trust root.

## Evidence-driven quality gate

Before changing graphics, geometry, camera, controls, onboarding, feedback, or adding a third-party library:

1. Create `docs/research/<task-id>/research-card.md` with `npm run research:init -- <task-id>`.
2. Use at least two distinct primary sources, two distinct maintained GitHub items pinned to semantic versions or full commits, three distinct comparable games from official HTTPS sources, six distinct official frames or timecodes, and two distinct community observations. Large tasks require five comparable games and twelve frames or timecodes.
3. Separate observed facts, inference, and testable hypotheses in every evidence record.
4. Record license, locked version or commit, load/frame/memory cost, fallback, and rollback for every library candidate.
5. Implement one hypothesis in an isolated worktree or behind a feature flag. Do not combine unrelated visual, camera, speed, and post-effect hypotheses in one spike.
6. Compare Current and Candidate under the same camera, input, device, viewport, exposure, backend, and quality.
7. Run `npm run research:validate -- <task-id>` before implementation and `npm run research:validate -- <task-id> --stage complete` before claiming completion.
8. In `human_release` mode, do not mark the task complete without measurable improvement, a committed Evidence Pack, digest-bound Current/Candidate screenshot, moving clip and input trace evidence, a candidate-bound successful build receipt, Git-commit-bound recomputed source/build SHA-256 values, computed numeric comparisons backed by receipts, all-pass timestamped raw-human rows with distinct trace realpaths, and a separate responsible-owner receipt bound to the same candidate. Any Human Reject blocks completion. In `ai_binary_gameplay` mode, replace only the Human rows/Owner requirement with the R5 telemetry/video/event/remediation/three-review gate described above. Rollback document commit, gameplay hash, source/build SHA-256, and Sites boundary must match the accepted baseline in both modes. Required Pack files and evidence paths must be repository-contained regular non-symlink files.
9. Reddit, forum posts, AI vision, automated screenshots, object counts, effect counts, and test pass counts cannot override a Human Reject.

External video frames may be inspected only in the minimum amount needed for analysis. Store third-party URLs and timecodes, not redistributed media, unless the repository has explicit reuse rights.

The project-local workflow is `.openai/skills/evidence-driven-game-quality/SKILL.md`. QX-R4-R00 has passed. R5 now follows page 19's critical path; new graphics libraries, PRP, and post effects remain frozen until QX-R5-005 passes.

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
