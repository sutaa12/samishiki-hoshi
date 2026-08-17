# さみしき星のまたたきよ

> ひとりの光は、やがて無数のまたたきになる。

`TWINKLE, O LONELY STAR` is a three-minute, wordless procedural nature flight built with Three.js. Guide one luminous droplet from an abundant ocean, across a living Earth, and into deep space. Steer with pointer/touch/WASD/arrows; give life with click/tap/Space.

## Local development

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
npm run verify
```

The default journey is 180 seconds. For localhost automated visual QA only, `?qa=1&speed=60&seed=20260818` accelerates the same state machine without changing the production default; public hosts ignore acceleration.

## Project map

- `app/`: public UI and Three.js runtime
- `src/game/`: deterministic story, generation, and ledger model
- `tests/`: unit, property, rendered-output, and browser tests
- `docs/SPEC.md`: executable product specification
- `docs/DECISIONS.md`: implementation decisions and rollback thresholds
- `docs/QA.md`: verification matrix and external gates
- `.quality-gates/`: hash-bound release evidence

## Privacy and rights

The game requires no account, stores no personal data, and calls no external runtime service. Runtime art, geometry, effects, and audio are generated in code; the social preview image is project-owned generated art. Contest identity, consent, final rights attestation, and submission remain explicit human gates.

## Source and release

The repository and public Sites URL are recorded in `docs/QA.md` once created. The canonical planning and evidence page is [Notion progress](https://app.notion.com/p/3bf9b8d39c2881e7ac83ef4245a80311?pvs=204).
