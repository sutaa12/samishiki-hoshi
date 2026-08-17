# Graphics rebaseline R2

## Objective

Keep the deterministic three-minute game intact while rebuilding its renderer and procedural-world presentation as **Cinematic Procedural Realism**. Prove three representative Hero Slices in WebGPU High and forced-WebGL2 before any integration with `main` or Sites publication.

## Decision

| Option | Decision | Reason |
| --- | --- | --- |
| Rebuild the entire game | Reject | Reimplements accepted simulation, input, story, replay, accessibility, and evidence contracts without benefit. |
| Add effects to the current renderer on `main` | Reject | Couples experimental graphics to the release line and makes rejection or rollback costly. |
| Replace renderer/world generation behind the snapshot API in an isolated worktree | Adopt | Preserves game truth, gives v2 a clean data/feature boundary, and can be rejected without touching `main`. |

The implementation is therefore a **presentation-boundary rebuild**, not a game rewrite and not a v1 renderer extension.

## Immutable baseline

- Release-line pointer: `main` at `6c010ee228ace28e655ceeba764513806505b03e`.
- Preserved pre-rebaseline WIP: `archive/pre-graphics-rebaseline-20260818` at `cbedd6d`.
- Isolated branch/worktree: `graphics-photoreal-megademo` / `/Users/snari/Documents/GitProject/LonelyStar-graphics-photoreal-megademo`.
- No merge, Sites version save, or deployment before the integration decision.

## Reuse and replacement boundary

Reuse unchanged:

- `src/game/model.ts`: 180 seconds, six phases, 24 shots, normalized inputs.
- `src/game/simulation.ts`: fixed 60 Hz step, replay, pulse, auto-answer, deterministic hash.
- Input, accessibility, UI, story events, audio-event semantics, and Twinkle ledger behavior.

Extend behind versioned contracts:

- named seed-stream registry;
- machine-readable `WorldGenerationContext` and chunk data;
- Story-first flow graph and safe corridor;
- Twinkle semantic metadata without renderer-tier data;
- renderer telemetry and adaptive visual quality.

Replace in v2 runtime:

- eager `WebGLRenderer` scene construction in `src/game/world.ts`;
- renderer-object-returning factories in `src/game/visual-assets.ts`;
- flat individual-mesh nature, simplified water/atmosphere, and the v1 alien-strip generator.

## Gate sequence

### R2-G0 — Rebaseline and isolation

- Updated Notion pages 05, 07, 10, 11, 12, and 13 are captured as source of truth.
- WIP is recoverably committed and pushed; `main` is unchanged.
- Worktree, rollback SHA, and no-deploy rule are recorded locally and in Notion.

### R2-G1 — GFX-001 renderer spike

- `three/webgpu` `WebGPURenderer` initializes asynchronously.
- Default WebGPU and `forceWebGL: true` modes share one adapter contract.
- A TSL node material renders a deterministic minimal scene.
- Backend, capabilities, tier, initialization, compile, draw, resource, and error telemetry are observable.
- No game model or simulation file changes.

Stop if forced-WebGL2 cannot render, backend choice changes a game hash, or the renderer cannot be disposed without leaked resources. WebGPU unavailability on this host is recorded honestly and may remain an environment/hardware gate, but it cannot be silently reported as passing.

### R2-G2 — Shared rendering foundation

- `RenderFeature` lifecycle: initialize, update, render, quality, dispose.
- Linear HDR lighting with exactly one final tone-map stage.
- Depth, velocity/history ownership, warm-up, preallocation, and upload queue.
- TSL material families for water, terrain, foliage, concrete, metal, glass/foil, and alien surface.
- P50/P95/P99 main/frame/GPU timing, pass inventory, draw/program/node/transparent/fullscreen counts, and resource snapshots.
- `DEMO_SOURCE_PROVENANCE.csv` and `THIRD_PARTY_NOTICES.md` stay complete.

### R2-G3 — Hero Slice A: ocean

Fixed replay markers: 12s and 27s, seed `20260818`.

- abundant bright underwater world before 18s;
- water surface, absorption, caustics, foam, coral, kelp, fish;
- zero visible human artifact before 18s;
- submerged rectilinear vehicle/empty-seat motif after 18s;
- waterline transition;
- player, flow, and pulse target found within one second.

### R2-G4 — Hero Slice B: city

Fixed replay markers: 58s and 75s.

- terrain and hydrology, wide river/waterfall, forest LOD;
- shared sunset atmosphere, cloud, aerial perspective, and non-crushed shadows;
- nature reads first, rectilinear ruin reads second;
- no foliage shimmer while the camera moves;
- safe corridor and story sightlines remain open.

### R2-G5 — Hero Slice C: space

Fixed replay markers: 142s, 158s, 166s, and 176s.

- five to nine readable human PBR debris forms in dark negative space;
- S20 keeps only incomplete peripheral arcs before 161s;
- unknown ship uses exactly three closed B-spline ribbon shells, parallel-transport frames, constrained superformula sections, real open center, and no human grammar;
- surface pattern is optional to silhouette recognition;
- Twinkle progresses one → few → tens → many without uniform starfield or rigid trail;
- temporal history does not smear final life lights.

### R2-G6 — Parity and integration evidence

- WebGPU High, WebGPU/Balanced where available, and forced-WebGL2 use identical state/input fixtures.
- Story events, collision, flow decisions, and Twinkle ledger hash match exactly.
- 1,000 seeds: no NaN, missing story node, river disconnect, corridor obstruction, non-manifold required mesh, or missing ledger entry.
- Ten restarts: geometry, texture, GPU resources, and heap do not grow monotonically.
- Exact sources, licenses, locked versions/commits, modified files, notices, and tests are recorded.
- Independent blind review covers graphics, performance evidence, human/alien classification, and final-story comprehension.

## Performance acceptance

Reference High:

- frame P95 ≤ 16.67 ms and P99 ≤ 25 ms;
- main-thread P95 ≤ 8 ms;
- GPU P95 ≤ 11 ms;
- compile, upload, and chunk activation spikes over 50 ms: zero.

Compatible Low:

- frame P95 ≤ 33.33 ms;
- gameplay, silhouettes, story events, and hashes are unchanged.

Initial warning ceilings (investigate rather than silently raise):

- High: 180 draw calls, 40 programs, 2,500 nodes, 40 transparent draws, two fullscreen passes.
- Low: 100 draw calls, 24 programs, 1,200 nodes, 20 transparent draws, one fullscreen pass.

Reference-device GPU acceptance remains `HARDWARE_PENDING` until measured on the named device. Automated or SwiftShader timing is not relabeled as reference hardware.

## Human integration gate

After R2-G0 through R2-G6, provide High/fallback screenshots, replay hashes, P50/P95/P99 and GPU-pass evidence, restart resources, license audit, blind-review findings, exact diff, and rollback SHA. Then stop and request one human decision:

- `Merge`: integrate all accepted renderer/world v2 work;
- `Partial Merge`: name the accepted features and keep rejected features behind or outside the adapter;
- `Reject`: leave `main` and the published candidate unchanged.

Only `Merge` or explicit `Partial Merge` authorizes main integration, complete regression acceptance, Git push, Notion completion, public Sites deployment, and anonymous interaction smoke testing.
