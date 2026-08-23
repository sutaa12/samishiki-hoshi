---
name: evidence-driven-game-quality
description: Research, compare, spike, measure, and human-test changes to graphics, geometry, camera, controls, onboarding, feedback, or third-party game libraries in LonelyStar. Use before implementing those quality-sensitive changes; do not use for unrelated code maintenance that cannot affect player-perceived quality.
acceptance_modes:
  human_release:
    requires_human_rows: true
    requires_owner_receipt: true
  ai_binary_gameplay:
    requires_human_rows: false
    requires_owner_receipt: false
    requires_telemetry: true
    requires_three_blind_ai_reviews: true
    requires_video: true
    requires_remediation_map: true
---

# Evidence-driven game quality

Apply Notion page 19 as the R5 Gameplay source of truth, then page 18 as the evidence process source of truth. Page 19's AI Binary policy wins where it conflicts with the older Human-first completion loop. A task without a task-appropriate Research Card cannot start implementation, and a task without a complete Evidence Pack cannot be marked complete.

## Choose the acceptance mode before implementation

- `human_release` is the default and remains fail-closed for raw Human rows, a separate responsible-Owner receipt, and every release or external boundary.
- `ai_binary_gameplay` is mandatory for QX-R5-001 through QX-R5-007 while the isolated 15-second candidate is being built. It removes only Human rows, Human scores, and Owner receipt from the pre-Human completion gate.
- AI Binary completion requires one digest-bound moving video, telemetry receipt, event ledger, remediation decision, and exactly three distinct artifact-only blind AI reviews. Every review must bind the same Task, Source SHA-256, Build SHA-256, and Video SHA-256; every binary answer and `pass` must be true; Reviewer IDs and free descriptions must be distinct; descriptions may not copy the expected answer.
- A Human Reject is never replaced by AI acceptance. Human play, legal/rights, Main integration, final Sites release, and contest submission remain separate gates.

Run the chosen mode explicitly:

```bash
npm run research:validate -- <task-id> --stage complete --acceptance human-release
npm run research:validate -- <task-id> --stage complete --acceptance ai-binary
```

The AI Binary `evidence.json` section uses `ai_binary_gameplay.video`, `telemetry`, `event_ledger`, `remediation`, `reviews`, and `expected_answer_sha256` artifact references. Normalize the Page 19 expected sentence with Unicode NFKC, trim it, lowercase it, and collapse whitespace before hashing. The canonical forbidden copied answer is `小さな水滴を左右に動かし、リングをくぐり、岩を避け、芽へ光を渡すゲーム`. Reviewers receive only the neutral video and rubric, never this sentence, the Source, Task name, or prior reviews.

Telemetry must record at least 15 seconds, a positive frame count, monotonic `distanceMm`, maximum continuous-still duration, input response, and `ring → obstacle → node` order. Event ledger entries must carry monotonic `at_ms` values and cover `ring`, `obstacle`, `node`, and `progress`. The remediation receipt must preserve the Page 19 routing for `motion`, `player`, `objective`, `pulse`, and `progress`, even when all three reviews pass and the decision is `accept`.

## Start from the player-facing failure

Before opening implementation files, express the failure in one sentence from a first-time player's perspective. Name the missing perception or decision, not an effect to add. Put this sentence in `docs/research/<task-id>/research-card.md`; it determines the queries, reference selection, hypotheses, and acceptance gates.

Create the pack and validate its research stage:

```bash
npm run research:init -- <task-id>
npm run research:validate -- <task-id>
```

The initializer refuses to overwrite an existing pack. Fix evidence rather than relaxing validation.

## Gather evidence in this order

1. Use official specifications, documentation, research papers, and source code for technical constraints.
2. Inspect maintained GitHub repositories and pinned releases, commits, issues, or pull requests for implementation and maintenance evidence.
3. Analyze official game pages, trailers, screenshots, developer talks, and press kits for comparable visual and interaction patterns.
4. Use Reddit, forums, and player reviews only to discover hypotheses. Corroborate every community observation with a stronger source and a local measurement.
5. Capture the Current build under the exact device, viewport, backend, quality, camera, input, time, and exposure intended for the Candidate comparison.

The standard minimum is two canonically distinct primary sources, two canonically distinct GitHub evidence items pinned to a semantic version or full commit, three distinct comparable games from HTTPS official sources, six distinct official frames or timecodes, two canonically distinct community observations, one same-condition Current capture, and one rejected alternative. A large task requires five comparable games and twelve frames or timecodes. Each comparable source must cite a Primary evidence ID with the same canonical URL, each comparable record must separate Observed, Inference, and TestableHypothesis, and each frame must match that proven comparable source. Moving labels such as `latest`, `main`, and `master`, canonical URL duplicates, invalid scale labels, or self-declared official sources without Primary proof fail validation.

Generate separate queries rather than blending evidence classes:

```text
Primary: <player-facing failure> official specification documentation paper source
GitHub: site:github.com <candidate technique> release issue PR WebGPU WebGL2 dispose benchmark
Comparable: <game name> official trailer screenshot developer talk press kit
Community: <player-facing failure words> onboarding confusion feedback site:reddit.com OR forum
```

Record the exact query and accessed date in the Research Card when it materially affected source selection. A search result or AI summary is only a route to a source; cite and inspect the source itself.

In every record, keep these separate:

```text
Observed: directly visible or quoted evidence.
Inference: the interpretation that may explain it.
Testable hypothesis: a measurable prediction for LonelyStar.
```

Do not treat AI summaries, AI vision scores, upvotes, object counts, triangle counts, effect counts, or test counts as acceptance evidence.

## Evaluate libraries before adoption

For each candidate, record its repository and pinned version or commit, license and notices, release recency, maintainer and issue state, Three.js compatibility, WebGPU and WebGL2 behavior, bundle/WASM/worker/assets, initialization, frame and memory costs, allocations, disposal and restart behavior, determinism, browser/mobile support, external communication, fallback, and rollback commit.

Reject a candidate if its license is unknown, its compatibility is unverified, it worsens start or frame gates without human-recognized benefit, it lacks disposal/context-loss handling, it breaks WebGL2 or gameplay hashes, or it works only in a repository demo without a Production integration test.

## Spike one hypothesis

Use an isolated `codex/qx-r4-*` worktree or a disabled-by-default feature flag. Change one hypothesis per spike. Preserve simulation, timestamped input, replay, story, accessibility, and TwinkleSeed hashes.

Compare Current, Candidate, and any reference-derived target with the same camera, input, device, viewport, exposure, backend, and quality. For graphics, include post-off, neutral-light, Production-light, balanced-post, and a moving 12-second clip. For gameplay, retain input traces, time-to-contact, screen travel, causal event timings, and free-form answers.

Use browser developer instrumentation, CDP, and Playwright when available to retain console, network, DOM, input, load, frame, and memory evidence. Ask for human approval before enabling a privileged Full CDP mode.

Adapt the test selector to the task, but retain the commands and raw output in `evidence.json`:

```bash
npx playwright test <task-spec> --workers=1 --trace=on --reporter=json
npm run test -- --reporter=json
node scripts/hash-tree.mjs dist
```

For browser A/B capture, use one deterministic replay and one viewport/backend/quality matrix for both labels. Capture post-off and Production states before the moving clip. Record Network transfer bytes, FCP/ready/input-to-frame, frame P50/P75/P95/P99, memory/owners, console errors, and any runtime compile events. Never use a successful build status as a substitute for opening the route and executing a real input.

## Complete honestly

Bind screenshots, clips, input traces, frame/load/memory measurements, acceptance receipts, decision, rejected alternatives, hashes, and rollback to one source commit. For Human release, run:

```bash
npm run research:validate -- <task-id> --stage complete --acceptance human-release
```

Human release completion requires digest-bound Current captures; distinct digest-bound Candidate screenshot, moving clip, and input trace plus a task/source/build-bound capture receipt; a successful candidate-bound build receipt; numeric hard gates with `eq`/`lte`/`gte` targets and matching machine receipts; numeric before/after load, frame, and memory payloads with an explicit comparison direction and tolerance; no computed regression; timestamped all-pass raw human-answer rows with distinct digest-bound trace realpaths; a separate candidate-bound owner decision receipt; and a rollback commit, gameplay hash, and prior Sites boundary exactly matching the accepted baseline.

AI Binary Gameplay completion retains the same source/build/capture/metrics/rollback chain, but uses the mode-specific video, telemetry, event ledger, remediation, and three-review receipts instead of Human rows and Owner receipt. An empty or absent `human-test.md` is allowed only in this mode. A research-only task with no runtime candidate may close only through the narrow digest-bound `research-only-ai-closure.v1` migration receipt and must explicitly claim no Production improvement.

Any Human Reject row blocks Human release. Required Pack files and referenced evidence must be repository-contained regular files, never directories or symlinks or aliases to one physical file. The validator requires Git commit objects, recomputes the exact Git archive SHA-256, and hashes every persisted artifact instead of trusting `passed`, `regression`, path-existence, or copied digest claims. Human Reject remains final for that candidate; begin a new Research iteration rather than averaging it away or replacing it with AI review. Local receipt shape validation does not replace the responsible human or an external trust root.

Templates live in `docs/research/_templates/`: `research-card.md`, `references.csv`, `comparable-games.csv`, `frame-analysis.csv`, `library-scorecard.md`, `current-baseline.md`, `decision.md`, `rollback.md`, `ablation.md`, `human-test.md`, and `evidence.json`. Third-party video remains URL/timecode-only unless explicit reuse rights are recorded. Keep local automation, human acceptance, rights, reference hardware, Main integration, Sites deployment, and contest submission as separate gates.
