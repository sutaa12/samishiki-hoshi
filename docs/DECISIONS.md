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

## D-017 — Hero C separates human debris, alien grammar, and immutable Twinkle realization

Hero Slice C reuses the D-015 presentation-layer boundary without importing or
executing the game simulation. The isolated route supplies an exact frozen
replay ledger to the accepted render contract, while the feature only reads the
Host-owned story snapshot. At 142 seconds the seven human remnants remain
rectilinear and the single amber beacon dies without machinery revival. S20
shows exactly three incomplete peripheral arcs; the exact 161-second S21
boundary replaces them with three thick closed cubic B-spline ribbon shells,
parallel-transport frames, constrained superformula cross-sections, and a real
open center. No cockpit, window, panel, thruster, front, or other human grammar
is added to the unknown ship.

The final life lights are one preallocated `InstancedMesh` whose transforms and
visible count derive deterministically from the immutable ordered TwinkleSeed
ledger. High/Low changes only that visible density; seed, plan, story, ledger,
three-shell silhouette, and center void do not change. All reachable Hero
objects remain present for ready-time warm-up. The three point lights stay on
an always-visible root and vary only in intensity, so S18 through S24 cannot
change shader light cardinality or introduce a post-ready program. The final
two-line Japanese title is presentation-only and appears at the fixed S24
marker.

## D-018 — R2-G6 binds additive acceptance evidence without promoting external gates

R2-G6 does not change the accepted simulation, canonical world plan, renderer,
streaming, material, pipeline, telemetry, or Hero implementations. It adds one
cross-Hero lifecycle oracle, one runtime-license/provenance oracle, and a
release-copy notice. The three-Hero oracle runs A, B, and C sequentially through
one scene and proves quality-only realization, immutable story/ledger inputs,
identity restoration, and zero feature-owned resources between slices. The
existing Foundation browser gate remains the authority for ten live restart
plateaus and ten complete zero-owner runtime generations.

The release notice covers the exact non-dev browser package closure in the
lockfile: React, React DOM, Scheduler, and Three.js, all MIT. Reference-gallery
images remain review-only and are excluded from production imports. This is an
engineering provenance and packaging boundary, not a legal opinion or public
rights attestation.

Automated parity, restart, browser, build, and license success can create only a
`review_pending` R2-G6 receipt. It cannot accept the underlying review-pending
GFX/Hero candidates, Cinematic Procedural Realism, reference hardware, human
play, public rights, Main integration, Sites deployment, or contest submission.
Those gates remain independently owned and require their stated reviewers or
the Human Acceptance Owner.

## D-019 — Hero visual remediation preserves canonical and runtime topology

Internal inspection of the R2-G6 frame set found that passing story, lifecycle,
and performance checks was not sufficient evidence for Cinematic Procedural
Realism. Hero visual remediation is therefore allowed to replace presentation-
owned geometry, materials, and textures, but it may not change the canonical
world plan, simulation/Twinkle inputs, chunk ownership, runtime light
cardinality, or post-ready allocation contract.

Hero A's first remediation uses preallocated tapered coral and kelp geometry,
deterministic fish and reef detail, textured caustic patches, and one additional
procedural surface texture. New decorative variation is derived directly from
the existing seed through `hashedUnit`; it does not consume or reorder the
established placement random stream. Every reachable material variant remains
present before ready, and story visibility continues to change objects rather
than shader or light topology. Forced-WebGL2 and host-Metal WebGPU must both
retain zero post-ready program growth before a visual change is kept.

An implementation checkpoint does not inherit the prior Hero receipt. Any art
change invalidates the old source/build binding and must receive new artifact,
blind visual, reference-hardware, and human acceptance at their separate gates.

## D-020 — Hero B/C remediation adds depth through preallocated presentation layers

Hero B and C follow the same D-019 boundary as Hero A. Hero B may add layered
tree crowns and branches, grass, birds, clustered clouds, sky color, and richer
surface response only as preallocated presentation-owned geometry/material
state. Human architecture remains rectilinear and empty. Hero C may add a
deterministic starfield, layered nebulae, denser ribbon tessellation, procedural
Earth color, and iridescent material response, but S20 remains three incomplete
peripheral arcs and S21 remains three closed curvilinear shells around an open
central void with no cockpit or human-machine grammar.

All added variation derives from the existing frozen seed without consuming or
reordering canonical generation streams. Quality changes only visible density.
No remediation may allocate after feature initialization, grow programs after
ready, change runtime light cardinality, mutate story or Twinkle data, retain
resources across Hero boundaries, or import the Notion reference boards into
production. Historical Hero and R2-G6 receipts remain valid only for their exact
older commits; the combined remediation requires a new frozen artifact and
independent review before any gate can be promoted.

## D-021 — Hero R33 acceptance is Hero-only and cannot authorize release

Hero R33 binds implementation `e1b101b9438097f739437e0a50af80774fd707ed`
to independently reviewed evidence `0c869ab1087f8940015706c2f4d83977ec1bab05`.
The technical, blind visual, and artifact reviews each report no S0, S1, or S2;
the artifact recheck also reports S3=0. This accepts the automated R2-G3,
R2-G4, and R2-G5 Hero scope for that exact source and evidence only.

Hero acceptance does not inherit into R2-G6. Foundation parity, restart,
telemetry, and combined evidence remain independently gated. Generated-asset
checks and provenance are engineering evidence, not the Human Acceptance
Owner's public-use or contest-rights attestation. Reference hardware remains
`HARDWARE_PENDING`; human visual/play and rights remain `HUMAN_PENDING`.
Accordingly D-005 still prohibits Main integration, Sites save/deployment, and
submission until the Human Acceptance Owner chooses `Merge`, `Partial Merge`,
or `Reject` and records the required rights decision.

## D-022 — Compile telemetry measures atomic renderer actions, not one aggregate warm-up

GFX-006 no longer treats one multi-profile `precompile()` Promise as a compile
event. RenderHost owns a required compile-step runner; each descriptor encloses
exactly one renderer-facing action, samples one monotonic clock before and after
that action's settlement, records the result, and only then yields to the next
browser task outside the timed interval. Direct-backend and pipeline planning
capture the same bounded drawable identities used for execution. Nested
drawables are isolated, every target/MRT/visibility/renderer mutation is
restored on success or failure, and the receipt must exactly match Host-owned
IDs, phase counts, and completed steps before ready.

The default production graph is deduplicated only by topology: forced WebGL2
uses one static representative and WebGPU uses one temporal plus one static
representative. Custom graph factories retain their distinct 3/5-profile
behavior. Runtime-object compile/draw, isolated material compile,
runtime-material topology, PassNode first draw, and final quad first draw are
separate measured actions. In the accepted composition this yields 88 WebGL2
and 176 WebGPU steps; these are receipt values for this exact topology, not
universal constants.

The Page-12 spike gate applies to compile, upload, and activation whenever the
measured duration is strictly greater than 50 ms, independent of whether an
event affects story time. The composed Host initialization event remains
visible and can exceed 50 ms, but it is not relabeled as one atomic compile
spike. Constant-zero compile counters are not acceptance evidence. Local
browser timings remain laboratory evidence; GPU timestamps were unavailable
and reference-device acceptance remains `HARDWARE_PENDING`.

## D-023 — Renderer context settling precedes, but never replaces, atomic measurement

A newly initialized browser renderer receives one 500-millisecond cooperative
settle window before RenderHost opens the compile session. The scheduler is a
required captured dependency, invokes one receiver-fixed browser timer, keeps
the Host in `initializing`, and cannot advance story time or start the frame
loop. A missing or reentrant scheduler fails initialization and follows the
normal ownership cleanup path.

The settle window is not reported as a compile action because it performs no
renderer work and does not occupy the main thread. After it resolves, every
renderer-facing compile and first-draw action is still individually measured;
each completed action is followed by a four-millisecond cooperative cooldown
outside that timing interval to drain driver work before the next action.
Strict `>50 ms` telemetry and rejection remain unchanged. The value is fixed
from cold Chromium evidence: 100 milliseconds admitted an intermittent 55.9 ms
Hero C final-output draw, while five independent 500-millisecond cold runs kept
all 258 WebGL2 actions between 21.6 and 26.4 ms. This is local laboratory
evidence only; reference-device acceptance remains `HARDWARE_PENDING`.

## D-024 — Exact raw pixels adjudicate inspection-preview disagreements

The exact R2-G6 candidate binds implementation `2741af51e277bdaa76ac97ee8b207bbfb1683cee`
to reviewed evidence `ba38e664cf6245a45cfa4eeaf1002de8036e2045`.
Independent source review accepted the complete manifest and runtime contracts.
The artifact-only reviewer reproduced every source, build, test, browser,
lifecycle, and visual-content binding, but locked one S2 after its inspection
display appeared to omit fixed-overlay glyphs in two fallback frames.

That dissent is preserved. A separate isolated adjudicator and final SolMax
integrator inspected the native PNGs and reproduced identical High/Fallback
coordinate masks and counts for all six exact title, eyebrow, and marker colors.
Every glyph, punctuation mark, divider, and marker was present at the same raw
pixel coordinates. Identical mask payloads rendered differently in the review
display, so the finding is `MITIGATED_NON_REPRODUCED`, not source-fixed.

The final automated R2-G6 verdict is S0=0, S1=0, S2=0, S3=0 for the exact hashes.
This does not weaken D-005: reference hardware, human visual/play, public-use
and contest rights, Main integration, Sites deployment, and submission remain
outside automated acceptance.

## D-025 — Public human-test deployment is authorized without Main integration

On 2026-08-22 the Human Acceptance Owner explicitly requested a playable URL
for human testing. This authorizes one reversible public Sites deployment from
the exact accepted `graphics-photoreal-megademo` source, while Main remains at
`6c010ee228ace28e655ceeba764513806505b03e`.

This is a test-distribution exception to the earlier no-deploy hold, not a
`Merge`, `Partial Merge`, final human visual/play acceptance, rights guarantee,
reference-hardware acceptance, or contest submission. The deployed URL must be
anonymous, must support a real steer and give-life interaction, and must remain
bound to its exact Git source and Sites version. Any failed smoke gate or human
stop request rolls back to the prior Sites version.

The authorized deployment completed as public Sites version 2 at
<https://samishiki-hoshi-seoul.narinarinari.chatgpt.site>. Anonymous browser
smoke passed start, steering-input, and give-life paths with zero browser
errors; the pulse advanced `✦ 000` to `✦ 001`. The exact source/archive/Sites
binding and version-1 rollback target are recorded in
`.quality-gates/receipts/r2-g7-public-human-test-deployment.json`. This fact
does not change the still-pending integration, full human acceptance, rights,
hardware, final release, or contest gates.

## Rollback

- Any open S0/S1/S2 finding blocks promotion.
- A failed deterministic replay, broken input modality, runtime exception, inaccessible settings, unavailable anonymous URL, or missing end state rolls back to the last accepted Git commit and Sites version.
- Performance measurements are hardware-specific. Failure to meet the target on reference hardware is reported as an external performance gate, never silently waived.
- A later source change invalidates all evidence bound to the old source/build hashes and requires reacceptance.
