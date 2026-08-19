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

## D-010 — The R2 map supersedes every older renderer ticket number

Notion page 13 still contains an older renderer task table in which its
`GFX-003`, `GFX-004`, and `GFX-005` labels refer to depth/HDR, atmosphere, and
ocean work. Those functional requirements remain authoritative, but those old
labels are not executable ticket identities. The current R2 dependency graph
in `docs/GFX_FOUNDATION_DESIGN.md` and the current Notion progress page are the
only execution map: current GFX-004 owns chunk/worker/upload lifecycle, current
GFX-005 owns TSL materials/Linear HDR/temporal ownership, and atmosphere/ocean
requirements are realized through GFX-005 plus Hero Slices A and B. Evidence
and receipts must always name the current R2 ticket and may cite an older page
13 label only as source provenance.

## D-011 — Chunk upload uses a one/two/four millisecond envelope

The updated performance page targets one millisecond of chunk upload work per
frame and marks two milliseconds as a warning, while the accepted local
foundation contract documents a four-millisecond default pump budget. GFX-004
uses all three values without weakening any source: `1 ms` is the scheduling
target, `2 ms` records a warning, and `4 ms` is the absolute per-frame hard cap.
Upload jobs must therefore expose bounded incremental steps and use an injected
monotonic clock; an atomic job whose duration cannot be bounded is not admitted.
Exceeding the soft thresholds records telemetry and may select a degraded visual
placeholder, but it never pauses or rewrites story time.

## D-012 — GFX-004/005 extend the accepted host through one serial contract owner

The accepted GFX-002 API intentionally proved a smaller lifecycle surface. It
did not expose a live upload budget, initial viewport to services/features,
feature resize/history invalidation hooks, logical resource adoption, or a
multi-profile warm-up inventory. GFX-004 and GFX-005 require those capabilities,
so `contracts.ts` and `render-host.ts` are extended once by the integration
owner with backward-compatible optional hooks. Chunk and pipeline implementers
consume that frozen extension and do not edit the shared host independently.
Any change to these accepted GFX-002 source files invalidates the old artifact
binding for the new HEAD; the original GFX-002 receipt remains an accurate
historical baseline, while the combined foundation must rerun its complete
GFX-002 regression suite and receive new source/artifact review before GFX-004
or GFX-005 can be promoted.

## D-013 — Transmission remains inside the Linear HDR graph

Three r185's built-in physical-material transmission copies the current
framebuffer into a shared BGRA8 viewport texture. The GFX-005 production graph
renders scene passes into RGBA16F targets, so enabling that path creates an
invalid cross-format framebuffer copy on actual WebGPU even when shader warm-up
passes. Water and glass/foil therefore keep their descriptor IOR and thickness
semantics but realize positive transmission with a TSL-owned opacity node inside
the half-float graph; built-in `transmission` stays zero. This preserves one HDR
topology on WebGPU and forced WebGL2, avoids post-ready program growth, and is
covered by both material-contract tests and actual host-Metal browser evidence.

## D-014 — GFX-006 measures one unfiltered RAF window without becoming lifecycle authority

Each foundation runtime owns one telemetry collector shared by RenderHost, the
incremental upload queue, and the chunk manager. The collector retains the last
600 RAF callbacks in callback order and publishes nearest-rank P50/P95/P99 only
after 120 samples. RAF intervals include dropped callbacks; main-work and GPU
samples exist only for submitted frames. Upload and activation mark their exact
frame as operational so it is excluded from steady-state percentiles, while
initialization, compile, quality, and history events remain separately counted.
Unsupported GPU timestamps are represented only as `null`, never estimated.

Telemetry is diagnostic, bounded, and one-way: caller inputs are captured,
operation events are capped, and telemetry callbacks cannot mutate renderer,
queue, or chunk lifecycle. A sink failure is contained. The current
`mainThreadWorkMs` value is the Host-owned frame-work wall-time envelope around
upload, update, pass recording, and backend submission; it is not a CPU profiler
or reference-device result. Browser-lab percentiles and forced-GC plateaus are
preserved as automated evidence, while reference CPU/GPU acceptance remains
`HARDWARE_PENDING` until the designated machine supplies timestamp support and
the required measurements.

## D-015 — Hero Slice art is a preallocated presentation layer over the canonical chunk lifecycle

Hero Slice A keeps the accepted GFX-003 world plan, GFX-004 Worker/chunk/upload
lifecycle, GFX-005 HDR pipeline, and GFX-006 telemetry active. Its dedicated
`OceanHeroFeature` owns the high-detail procedural geometry, materials,
textures, scene membership, and fixed-marker camera presentation. The generic
chunk uploader continues to generate, adopt, retire, and account for the four
canonical resident chunks, but its diagnostic placeholder boxes are hidden for
the Hero route so they do not become the shipped art direction.

Every Hero resource is allocated before ready, quality changes alter only
visibility counts, and disposal releases the dedicated graph before the shared
pipeline. The feature never writes story time, shot, seed, world-plan, or
Twinkle state. Reference images remain review inputs only and are not shipped
as backgrounds under D-003; built-in physical-material transmission remains
zero under D-013. This pattern may be reused by Hero B/C only if each slice
retains the same deterministic, preallocated, exact-ownership boundary.

## D-016 — Hero B keeps nature and renderer topology continuous across the city reveal

Hero Slice B reuses the D-015 presentation-layer boundary over the unchanged
canonical plan and chunk lifecycle. The forest, river, waterfall, mist, birds,
and protagonist remain present through the city phase; a separately owned
rectilinear city root becomes visible at the exact 62-second boundary. Ruin
towers stay outside the measured safe corridor, while the empty bench,
playground, observation frame, rooftop planting, and window birds communicate
human absence and continued non-human life without narration or revival.

All city resources are visible during precompile and are only hidden after the
Host reaches ready. The amber city light remains attached to the persistent
Hero root at every marker and changes intensity rather than scene membership,
so the 58-to-75-second transition cannot introduce a new light-topology shader
variant. High/Low changes alter instance visibility only; no geometry,
material, texture, light, story, seed, plan, or Twinkle ownership is allocated
or replaced after initialization.

## Rollback

- Any open S0/S1/S2 finding blocks promotion.
- A failed deterministic replay, broken input modality, runtime exception, inaccessible settings, unavailable anonymous URL, or missing end state rolls back to the last accepted Git commit and Sites version.
- Performance measurements are hardware-specific. Failure to meet the target on reference hardware is reported as an external performance gate, never silently waived.
- A later source change invalidates all evidence bound to the old source/build hashes and requires reacceptance.
