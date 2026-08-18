# R2 graphics foundation design

This document is the production boundary for GFX-002 through GFX-006. The
accepted GFX-001 laboratory is immutable evidence, not a module to refactor or
reuse. The release line, legacy renderer, simulation, input, replay, audio, and
Sites state stay frozen until the three Hero Slices have passed and a human has
chosen `Merge`, `Partial Merge`, or `Reject`.

## Frozen inputs

| File | SHA-256 |
| --- | --- |
| `src/game/model.ts` | `9aa6b27123431ccde694f0ecd31e03c66093c4aa04575e05399f82fcb75001b2` |
| `src/game/simulation.ts` | `5aafeb15658888315532fb22176e4da1aec14487dd690866f5456c51ba841fd7` |
| `src/game/procedural.ts` | `a47ac1b6e2191aadf4d3ef391d5409791d87431f886588e9ecdcbc314843fbb5` |
| `src/game/audio.ts` | `c86f1881832ea45a025f9c580afdc5396a53f9e199afab061dfaf3c0f6a7f57f` |
| `app/game-client.tsx` | `680a8297c274d3bd73f299f1c6eb2c44be13b2681ede2a089d16d5f4803987d2` |

Legacy `src/game/world.ts` and `src/game/visual-assets.ts` also remain
untouched through the shared-foundation tickets. GFX-001's `src/gfx/*.ts`,
`app/gfx-spike/**`, `tests/e2e/gfx-spike.spec.ts`, and bound evidence remain
unchanged after acceptance commit `296ee12`.

## Dependency boundary

- `src/world/v2/**` is canonical generation data. It may type-import model
  vocabulary and read the immutable shot score. It may not import Three.js,
  DOM APIs, backend/quality types, or the simulation implementation.
- `src/gfx/v2/**` is renderer-facing. It may type-import model vocabulary and
  consume immutable projected snapshots. It may not import simulation, input,
  replay, audio, React, or legacy world implementations.
- Model and simulation never import either v2 namespace.
- Backend and quality values never enter world generation context, canonical
  plans, chunk IDs or hashes, safe-corridor choices, or Twinkle semantic hashes.
- A feature receives a copied and deeply frozen `JourneyRenderSnapshot`, never
  a `JourneyState` reference. Story time and visual clock remain separate.
- Only `RenderHost` owns the animation loop, lifecycle, feature ordering, and
  final backend submission. Features record named pass requests; they do not
  call a raw renderer or apply an output transform.
- The dependency direction is strictly one-way: backend, service, feature,
  quality-provider, loop, observer, and unsubscribe callbacks never call a
  public `RenderHost` method, synchronously or after an `await`. Synchronous
  violations fail closed as `INVALID_LIFECYCLE`; production composition must
  not capture the Host in dependency closures and is reviewed against this rule.

## Ticket order

```text
GFX-001 accepted and frozen
          |
       GFX-002  Render contract and backend abstraction
          |
       GFX-003  Deterministic world plan and named seed streams
         / \
  GFX-004   GFX-005  Chunk/worker lifecycle and TSL/HDR pipeline
         \ /
       GFX-006  Telemetry, quality boundary, parity and lifecycle receipt
```

GFX-004 and GFX-005 may proceed in parallel only after GFX-003 freezes the
world and material descriptor contracts.

## GFX-002 acceptance

- Lifecycle is `new -> initializing -> ready -> disposing -> disposed`, with a
  terminal `failed` state for initialization or live-backend failure.
- Initialize and dispose are idempotent. Partial initialization unwinds all
  completed features in reverse order and disposes backend ownership.
- `whenIdle()` is an external barrier for active initialization, the current
  frame, queued controls, explicit disposal, and terminal-failure cleanup. It
  is not callable from an owned dependency callback under the one-way rule.
- Fake features prove exact initialize/update/render/quality ordering and
  reverse disposal. Exactly one animation-loop owner is observable.
- Raw `WebGPURenderer` is private to the backend adapter. Requested backend,
  actual backend, API exposure, navigator adapter probe, compatibility mode,
  and laboratory launch flags remain separate facts.
- Forced WebGL2 and host-Metal WebGPU each complete create, compile, render,
  dispose, and recreate. Late renderer/device events leave `ready`, surface a
  structured error, and dispose all ownership.
- After disposal there are no additional loop ticks or resize calls; host,
  runtime, and backend subscribers are zero; the event bridge and render-pass
  ownership are detached; every contract-scene geometry/material disposal call
  completed; and the upload queue reports no pending work.
- Renderer disposal return, observable Three backend disposal return, and the
  post-dispose `renderer.info` observation are separate facts. Three r185 resets
  its counters before backend cleanup, so a zero post-dispose counter is never
  used by itself as GPU-release proof. Asynchronous GPU cleanup remains outside
  GFX-002 and must be drained explicitly if later timestamp features enable it.
- The accepted GFX-001 five-case suite remains unchanged and green.
- A fixed replay fixture has the same gameplay and ledger hash through both
  backend harnesses; the renderer cannot mutate its frozen projection.
- An architecture test rejects all forbidden import edges and checks every
  frozen file digest.

## GFX-003 acceptance

- Use one canonical chunk for each `S01` through `S24`; hero and shared lighting
  resources are not story chunks.
- Named ASCII seed streams derive only from world seed, registered system name,
  shot chunk, generator version, and an optional system-owned substream.
- Seed `20260818` receives a pinned canonical plan digest. Output is byte-stable
  regardless of generation order and unrelated streams remain unchanged.
- Exactly 24 contiguous nodes cover six phases and 180 seconds. S20 contains
  only incomplete peripheral arcs; a complete unknown ship cannot begin before
  S21 at 161 seconds.
- One thousand seeds contain no invalid numbers, missing or reordered story
  nodes, blocked safe corridor, disconnected required hydrology, or more than
  two authored flow branches.
- Twinkle semantic projection neither mutates nor reorders the immutable ledger.

## GFX-004 acceptance

- Chunk state follows `absent -> queued -> generating -> generated -> uploading
  -> active -> retiring -> disposed`, plus terminal `failed`.
- The resident window is current shot, two ahead, and one behind: at most four
  GPU-resident world chunks. A leaving chunk is retired before a fifth activates.
- Worker generation is canonical and quality/backend-free. Generation tokens
  reject stale, aborted, and out-of-order replies.
- Upload jobs use a documented `1 ms` scheduling target, `2 ms` warning, and
  `4 ms` absolute per-frame pump cap. A delay or failure records telemetry and
  may display a degraded placeholder, but never changes or stalls story time.
- Rapid seek, cancellation, randomized response order, and ten fake lifecycle
  cycles prove no stale activation, double disposal, or ownership growth.

## GFX-005 acceptance

- Seven exact TSL material families cover water, terrain, foliage, concrete,
  metal, glass/foil, and alien surfaces. No `ShaderMaterial` or copied demo
  shader enters production v2.
- Scene rendering uses Linear HDR intermediates. One pipeline-owned output
  transform applies ACES and sRGB conversion exactly once.
- One owner manages depth, velocity, temporal history, resize, and invalidation.
  Unsupported forced-WebGL2 temporal capability is explicitly disabled and
  uses a non-temporal fallback.
- Warm-up covers every reachable material, pass, and runtime-selectable profile
  before `ready`. Program and compile-event counts do not grow after ready.
- Temporal history resets at initialization, resize, backend/profile change,
  restart/QA seek, camera discontinuity, S21/S23 cuts, and final life-light
  injection.

## GFX-006 acceptance

- Telemetry separately reports nearest-rank P50/P95/P99 for RAF interval,
  main-thread work, and GPU time over an unfiltered 600-frame rolling window
  with at least 120 samples. Unsupported GPU timestamps remain `null`.
- Init, compile, upload, and activation events are not folded into steady-state
  samples. Backend facts, quality changes, passes, draws, programs, nodes,
  transparent draws, fullscreen passes, resources/bytes, and late errors remain
  observable.
- Quality may alter pixel ratio, LOD selection, draw/instance ranges, optional
  passes, shadow resolution, and temporal mode only. It may not regenerate or
  mutate world/story/corridor/input/ledger/hash semantics.
- Identical timestamped replay produces identical game, ledger, world-plan, and
  chunk hashes for WebGPU and forced WebGL2 and for all requested/effective
  quality profiles.
- Ten actual create/render/restart/dispose cycles return counters to zero and a
  reused renderer plateaus after forced-GC samples. No compile, upload, or chunk
  activation event exceeds 50 milliseconds.
- Source archive, exact build artifact, report, lockfile, and receipt are bound
  by SHA-256 and independently reviewed. Reference hardware remains
  `HARDWARE_PENDING` even when laboratory checks pass.

## Stop conditions

Stop the affected ticket and reopen its gate for any open S0-S2 finding, any
gameplay/replay hash change, more than four resident chunks, post-ready program
growth, steady-state compile/upload/activation event above 50 milliseconds,
resource growth across the required lifecycle sample, or a visual result that
cannot be traced to the Notion gameplay-reference contract. No shared-foundation
result authorizes Main integration, Sites deployment, or contest submission.
