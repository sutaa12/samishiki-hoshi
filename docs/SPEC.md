# Executable specification

Status: locked for implementation on 2026-08-18 JST. Canonical source is the Notion production plan rooted at `3bf9b8d3-9c28-8188-8819-dda26e08db71`.

## Experience contract

- Title: `さみしき星のまたたきよ` / `TWINKLE, O LONELY STAR`
- Tagline: `ひとりの光は、やがて無数のまたたきになる。`
- Format: one continuous, wordless, 180-second browser journey.
- Actions: steer and give life only.
- Input: pointer/touch/WASD/arrows for movement; click/tap/Space for pulse.
- Runtime: Three.js/WebGL, procedural geometry/effects, generated Web Audio; no account, personal data, runtime network service, paid API, game over, dialogue, narration, audio log, corpse, or stated extinction cause.

## Exact timeline

| Phase | Seconds | Required event |
| --- | ---: | --- |
| LIFE | 0–36 | Abundant ocean; first pulse; no human artifact before 18s; submerged rectilinear ruin appears only after 18s. |
| EARTH | 36–88 | River, forest, animals, and a warm reclaimed city crossed by recurring human motifs. |
| ASCENT | 88–130 | Rectilinear observatory, wings, clouds, aurora, and a clearly living Earth. |
| SOLITUDE | 130–161 | Color-rich deep space and negative space; rectilinear human spacecraft debris and one amber beacon. |
| ANSWER | 161–171 | Unknown ship: three phase-shifted curved ribbon shells around a central void. The response window opens at 166s; auto-answer at 168.5s prevents a stall. |
| TWINKLE | 171–180 | Turn toward Earth; few lights become tens, then countless living lights; formal Japanese title appears only at 178–180s. |

The runtime exposes the exact 24 authored shot boundaries from 0–3 through 178–180 seconds. Production timing is never shortened by quality settings. A localhost-only test query may accelerate wall-clock playback while retaining story time.

## Visual grammar

- Human structures use 1:1, 1:2, and 1:4 rectilinear ratios: boxes, slabs, beams, columns, panels, and trusses. Damage may break pieces but the grid stays legible.
- The unknown ship uses only smooth swept curves: three ribbon shells, surface light, and a central void. It has no cockpit, window, box, panel, thruster, weapon, or mechanical seam. It signals recognition, not rescue.
- Repeated human motifs are an empty rectangular seat, a square observation frame, and a thin amber line light.
- The opening must read as abundant life, not apocalypse. Every biome keeps local color contrast and a readable route.

## Simulation and generation

- The run seed is explicit and stable. Random values come only from a deterministic generator.
- Each pulse appends one immutable `TwinkleSeed` containing sequence, story time, phase, normalized position, local biome, and deterministic signature.
- Same seed plus same timestamped input stream yields the same ledger and final hash on every quality tier.
- Pulse feedback awakens nearby coral, moss, grass, birds, or microbes. It never powers a human machine.
- 1,000-seed property verification rejects invalid timelines, impossible route bounds, broken phase order, or non-finite generated values.

## Accessibility and controls

- Reduced motion lowers camera sway, parallax amplitude, streak velocity, and transition displacement without changing phase time.
- High contrast adds luminance separation and stronger silhouettes; color meaning is duplicated by shape and motion.
- Auto-give periodically emits life pulses. Wide flow reduces steering pressure. Mute never blocks progress.
- UI controls are keyboard-focusable, have visible focus states, and remain usable at 320×568, 390×844, tablet, and desktop widths.
- Audio starts only after user input and is synthesized with Web Audio. The experience remains fully understandable when muted.

## Acceptance

- Typecheck, lint, unit/property tests, production build, rendered HTML checks, and Playwright desktop/mobile flows pass.
- Default timeline equals 180 seconds; all phase boundaries and 24 shots are covered by tests.
- No external runtime request is needed for play, and no secret is present in source or build output.
- Automated browser QA confirms start, steer, pulse ledger, settings, accelerated end sequence, restart, and WebGL canvas.
- Independent artifact-only review reports zero open S0, S1, and S2 findings.
- Public Sites deployment is anonymous and smoke-tested with a real interaction. Human play acceptance, contest consent, personal information, rights guarantee, Seoul attendance, and final submission remain separate.
