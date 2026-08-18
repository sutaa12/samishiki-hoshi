# Decisions and rollback thresholds

## D-001 — Separate deterministic state from rendering

The story clock, phase selection, 24-shot index, input ledger, and final hash are pure TypeScript. Three.js consumes snapshots and cannot write story state. This makes quality settings visual-only and gives exact cross-tier replay checks.

## D-002 — A single continuous renderer contract (superseded implementation)

The journey keeps one renderer contract and morphs one continuous world between phases. The former `WebGLRenderer` implementation is retained only as the archived v1 comparison. The v2 worktree uses `WebGPURenderer + TSL`, selecting WebGPU where supported and the same renderer's forced-WebGL2 backend for compatibility. A DOM shell continues to own instructions, settings, progress, accessibility status, and renderer recovery.

## D-003 — Procedural-first asset policy

Geometry, particles, nature forms, human ruins, the unknown ship, and audio are generated locally in code. Visual-reference images are never shipped as scene backgrounds. The social preview is captured from the accepted runtime. This keeps runtime self-contained and rights review tractable.

## D-004 — Test-only acceleration

Production defaults to real-time 180 seconds. The `qa=1` query unlocks an accelerated clock only on localhost for deterministic browser verification. It does not alter phase boundaries, seed generation, scoring, or release UI and is unavailable on the public host.

## D-005 — Renderer/world v2 is isolated until human integration acceptance

The pre-rebaseline working candidate is preserved at `cbedd6d` on `archive/pre-graphics-rebaseline-20260818`; `main` remains at `6c010ee`. Graphics v2 is developed only in the `graphics-photoreal-megademo` worktree. No Sites version is saved or deployed from this branch. After all three Hero Slices pass automated and blind gates, the Human Acceptance Owner chooses `Merge`, `Partial Merge`, or `Reject`.

## D-006 — Rebuild the presentation boundary, not the game

Pure model, fixed-step simulation, 180-second phase/shot contract, inputs, replay hash, audio events, accessibility, and Twinkle ledger are reused. The eager six-scene WebGL world and direct-Object3D visual factories are not extended into v2; renderer, machine-readable world data, seed streams, feature adapters, material library, quality manager, and telemetry are rebuilt behind the existing snapshot boundary.

## D-007 — The rebaseline ticket map owns execution order

Notion page 13 contains an older task table whose `GFX-003` label refers to depth, velocity, and HDR work. The accepted R2 dependency graph in `docs/GFX_FOUNDATION_DESIGN.md` is the execution map: current `GFX-003` is the deterministic world plan and named seed streams, while the older page-13 rendering item is covered by current `GFX-005`. This is a numbering reconciliation only; none of the underlying page-13 rendering requirements are dropped.

## D-008 — Canonical generation is quality- and backend-free

Page 11's illustrative `WorldGenerationContext` includes a quality tier, but the same page and the later R2 production boundary require story nodes, flow decisions, corridors, hydrology, Twinkle semantics, chunk IDs, and hashes to be invariant across quality and backend. GFX-003 therefore defines a `CanonicalWorldGenerationContext` containing only the world seed, generator version, registered system name, shot chunk, and optional system-owned substream. Quality controls belong to a later realization context and are never serialized or hashed into the canonical plan.

## D-009 — World seeds use the frozen game's uint32 domain

The immutable game state and URL/replay contract carry the world seed as a JavaScript number. GFX-003 accepts only finite integer seeds from `0` through `2^32 - 1`, rejects rather than coerces other values, and serializes the accepted value as an unsigned decimal string inside canonical seed tuples. This preserves the frozen game boundary while avoiding floating-point aliases and JSON/BigInt incompatibility.

## Rollback

- Any open S0/S1/S2 finding blocks promotion.
- A failed deterministic replay, broken input modality, runtime exception, inaccessible settings, unavailable anonymous URL, or missing end state rolls back to the last accepted Git commit and Sites version.
- Performance measurements are hardware-specific. Failure to meet the target on reference hardware is reported as an external performance gate, never silently waived.
- A later source change invalidates all evidence bound to the old source/build hashes and requires reacceptance.
