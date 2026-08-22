# QX-R3-006 delivery contract

## Goal

Turn the public production journey's LIFE segment from 0 through 36 seconds
into a production moving-master slice. The accepted slice combines the
canonical rail and real gameplay input with a layered PBR underwater world,
legible gameplay encounters, and a restrained reveal of the rectilinear
submerged vehicle after 18 seconds.

## Source of truth

1. Repository `AGENTS.md` and the locked Notion product pages it names.
2. Notion task `QX-R3-006` and Notion page 14's independent human visual gate.
3. `docs/SPEC.md`.
4. The accepted QX-R3-005 evidence commit
   `2ae33e5c9a905a8ba43c35fb92bd5ec1e47e608a`.

## Locked constraints

- The public route remains anonymous, free, browser-playable, and independent
  of runtime AI and paid APIs.
- The journey remains exactly 180 seconds. LIFE occupies the half-open range
  `[0, 36)` and the accepted QX-R3-005 rail camera and phase blend stay
  continuous at the 36-second boundary.
- Simulation, WorldPlan, replay, TwinkleSeed, and hashes stay canonical. Visual
  quality, backend, geometry, materials, camera presentation, and capture
  controls never feed back into gameplay state.
- The public interaction vocabulary remains steer and give life. All existing
  pointer, touch, keyboard, reduced-motion, high-contrast, auto-give,
  wide-flow, mute, and colour-independent cues remain functional.
- The production rail camera and PhaseDirector remain the sole owners of the
  camera and phase environment. LIFE art may consume their presentation state
  but may not overwrite it.
- Human works remain rectilinear. The submerged vehicle and empty seat are not
  visible before 18 seconds. The unknown ship contract remains unchanged.
- The renderer retains one persistent production scene/pass and bounded,
  prewarmed runtime resources. QX-R3-006 may not introduce ready-state shader
  compilation, unbounded scene growth, or an additional presentation loop.
- Main, public Sites health, human visual acceptance, human play, rights,
  reference hardware, and contest submission remain separate gates.

## Owned implementation surface

- a production presentation mode for the existing LIFE underwater feature
- production runtime composition and lifecycle integration
- production-safe material, geometry, encounter-legibility, and reveal fixes
- observability required to bind the 0-36 second master evidence
- focused unit, integration, material, lifecycle, deterministic, and browser
  tests

## Predeclared automated acceptance

- The public `/` route presents layered underwater geometry throughout
  `[0, 36)`: macro terrain or rock masses, meso coral/kelp/ruins, micro
  particles or small life, and distinct near/mid/far parallax layers.
- Player, Flow Gate, Obstacle, and Life Node are each identifiable by both form
  and a colour-independent cue. Automated inventory and projected-screen
  separation checks prove that none is substituted by an overlay-only marker.
- The submerged rectilinear vehicle and an empty seat have zero visible
  presentation before 18 seconds and become visible at or after 18 seconds.
- Natural, concrete, painted metal, and glass material families are distinct in
  roughness and normal response. No non-emissive `MeshBasicMaterial` or
  `MeshBasicNodeMaterial` is present in the LIFE production feature.
- With bloom, fog, and particles disabled, the geometry/material inventory and
  encounter silhouettes remain present and screen-space legible.
- The neutral illumination baseline is locked to a 6500 K equivalent white
  point, with finite light intensities and exposure.
- A public-root 1920x1080 capture covers 12 continuous seconds with actual
  player steer and give-life input and records at least one Gate Pass, one
  Obstacle Near Miss, and one Node Perfect outcome without test-only simulation
  mutation.
- High and forced WebGL2 captures use the same canonical rail camera samples,
  encounter descriptors, input stream, replay/TwinkleSeed ledger, and final
  hash. Backend-specific visual fallback may not change gameplay.
- After ready, shader/program compile count and persistent feature topology do
  not grow during the 12-second master or across the 18- and 36-second reveal
  boundaries.
- QX-R3-005 camera/phase continuity metrics remain within their accepted
  thresholds, including zero black/monochrome boundary frames and zero program
  growth.
- Focused tests, typecheck, lint, the complete Vitest suite, production build,
  deterministic replay/hash checks, and relevant production browser gates pass
  without weakening prior assertions.
- Independent isolated SolMax review reports S0=0, S1=0, and S2=0 before the
  automated candidate is accepted.

## Human Visual Gate

Automated acceptance does not complete QX-R3-006. Independent human reviewers
must score depth, material distinction, lighting, motion stability,
player/route visibility, and completeness. The gate remains `HUMAN_PENDING`
until the recorded median is at least 4/5. AI-generated reviews, screenshots,
or browser automation may prepare the package but may not replace this gate.

## Rollback

Any S0-S2 finding, deterministic/hash drift, camera or environment ownership
conflict, reveal before 18 seconds, LIFE/EARTH discontinuity, ready-state
compile growth, unbounded lifecycle growth, inaccessible gameplay cue, or
public-route major-flow regression returns the branch to the accepted
QX-R3-005 commit above. Main and public Sites remain unchanged until their
separate gates are authorized and verified.
