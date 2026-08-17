# LonelyStar implementation contract

This repository implements the Notion-defined game `さみしき星のまたたきよ`.

## Source-of-truth precedence

1. Product constraints in Notion pages 02, 08, 09, 10, 11, and 12.
2. Narrative and production process in pages 01, 03, 05, 06, and 07.
3. The executable specification in `docs/SPEC.md`.
4. Tests and implementation. If these conflict with a higher source, fix the lower source and record the decision.

## Non-negotiable behavior

- The public experience is anonymous, free, browser-playable, and has no runtime AI or paid API dependency.
- The default journey lasts exactly 180 seconds and follows LIFE, EARTH, ASCENT, SOLITUDE, ANSWER, TWINKLE in order.
- There are only two actions: steer and give life. Pointer, touch, WASD, arrows, click/tap, and Space are supported.
- Human absence is communicated without narration, dialogue, corpses, or an extinction explanation.
- A pulse affects living nature only and never revives machinery.
- Human works stay rectilinear. The unknown ship stays curvilinear and has three ribbon shells around a central void.
- The same seed plus the same timestamped input stream produces the same TwinkleSeed ledger and hash. Visual quality must never alter simulation state.
- Reduced motion, high contrast, auto-give, wide-flow assistance, mute, and color-independent cues remain functional.

## Delivery rules

- Keep specs, decisions, QA receipts, and release evidence in this repository.
- Bind acceptance evidence to exact source and build SHA-256 values.
- Treat local automation, public deployment health, human play acceptance, rights acceptance, and contest submission as separate gates.
- Never mark a human or legal gate complete without the responsible person.
- Roll back through the prior Git commit and prior Sites version.

