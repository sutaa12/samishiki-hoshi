# QX-R5-001 contract decision

Date: 2026-08-24 JST

## Decision

Implement the Page 19 minimum communicative game as a new `/r5-minimum` route
with pure deterministic simulation in `src/game/r5`, a standalone basic-material
Three.js world in `src/gfx/r5`, and a dedicated client under `app/r5-minimum`.

## Boundaries

- QX-R5-000A accepted source `91652071de292646e96f4f2150e7e2dab3a3ba6b`
  is the gate-contract parent.
- Production `/`, its 180-second journey, `src/gfx/v2`, Hero A/B/C, and public
  deployment remain untouched.
- The 15-second loop uses only horizontal Steer and Pulse. Up/Down inputs are
  filtered before the shared InputRouter.
- Simulation owns time, integer distance, outcomes, progress, and event order.
  Rendering consumes state and cannot mutate it.
- Human, Legal, Main, Sites, release, and contest gates stay pending.

## Rollback

Remove `app/r5-minimum`, `src/game/r5`, `src/gfx/r5`, and `tests/r5`, then revert
the QX-R5-001 commit. The accepted QX-R5-000A branch remains the recovery point.
