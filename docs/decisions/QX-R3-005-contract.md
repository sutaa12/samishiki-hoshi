# QX-R3-005 delivery contract

## Goal

Make the production v2 journey visibly continuous across the LIFE to EARTH
boundary by moving the camera on the canonical rail, keeping the surrounding
chunk window resident, and blending environment parameters instead of swapping
phase groups in one frame.

## Source of truth

1. Repository `AGENTS.md` and the locked Notion product pages it names.
2. Notion task `QX-R3-005` and the R3 GitHub/public-source re-audit.
3. `docs/SPEC.md`.
4. The accepted QX-R3-004 tree at `038d809ff1df265df2747e95faf1f725560ea21b`.

## Locked constraints

- The journey remains exactly 180 seconds with the existing six phases and 24
  half-open shot ranges. LIFE to EARTH remains the exact 36-second boundary.
- Simulation distance and corridor offset are canonical. Rendering quality,
  backend, camera motion, and phase blending never feed back into simulation,
  WorldPlan, replay, TwinkleSeed, or hashes.
- The public interaction vocabulary remains steer and give life. All existing
  keyboard, pointer, touch, reduced-motion, high-contrast, auto-give,
  wide-flow, mute, and color-independent cues remain functional.
- Human works remain rectilinear. The unknown ship remains three curvilinear
  ribbon shells around a central void.
- The renderer retains a single persistent production scene/pass, four
  prewarmed GPU chunk slots, and the window behind/current/ahead-1/ahead-2.
- Main, Sites, human play, rights, reference hardware, and contest submission
  remain separate gates.

## Owned implementation surface

- `src/gfx/v2/camera/rail-camera.ts`
- `src/gfx/v2/integration/phase-director.ts`
- the production projection/runtime integration needed to pass canonical rail
  state and presentation preferences
- the existing fixed-pool chunk presentation needed to place resident chunks
  on the same rail
- focused unit, integration, and browser continuity tests

## Predeclared automated acceptance

- A 120-frame LIFE to EARTH trace has zero black frames and zero effectively
  single-colour frames. A frame is black when mean normalized luminance is at
  most `0.01`; it is effectively single-colour when its quantized colour-bin
  count is below `16` or normalized luminance standard deviation is below
  `0.005`.
- The maximum consecutive camera translation is at most `0.75` Three world
  units per rendered frame during the trace. No history invalidation is emitted
  for an ordinary phase or shot boundary.
- Ready-state runtime compile count and backend program count increase by `0`
  across the trace.
- At most `5%` of consecutive captured frames may be still. A pair is still
  when fewer than `0.1%` of sampled pixels change by more than two 8-bit levels.
- Phase blend progress is finite, clamped, continuous, and changes by at most
  `0.01` per consecutive 60 Hz frame. The exact boundary contains contributions
  from both adjacent phases.
- Reduced motion preserves camera forward travel while reducing rotational
  excursion and visual sway.
- The desired chunk IDs remain exactly the available subset of
  behind/current/ahead-1/ahead-2; the next phase chunk is active before the
  36-second boundary after the bounded preload wait.
- Focused tests, typecheck, lint, the complete Vitest suite, production build,
  deterministic replay/hash checks, and relevant production/rail browser gates
  pass without weakening prior assertions.
- Independent isolated SolMax review reports S0=0, S1=0, and S2=0 before the
  automated task is accepted.

## Rollback

Any S0-S2 finding, deterministic/hash drift not required by a canonical schema
change, missing phase overlap, camera teleport, runtime compile growth, black or
monochrome boundary frame, lifecycle leak, or browser major-flow regression
returns the branch to the accepted QX-R3-004 commit above. Public Sites and Main
remain unchanged until their separate gates are authorized and verified.
