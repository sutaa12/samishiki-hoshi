# Asset and rights inventory

This is an engineering inventory, not the final legal attestation. The responsible human must approve the exact release.

| Asset | Origin | Runtime | Evidence / review |
| --- | --- | --- | --- |
| Canonical world geometry and descriptors | Procedurally generated in repository source | yes | `src/world/v2/**`; no imported model or texture |
| Hero A ocean, caustics, life, and rectilinear submerged ruin | Repository-authored procedural Three.js/TSL | review route only | `src/gfx/v2/hero/ocean-hero-feature.ts`; reference gallery excluded from runtime |
| Hero B forest, hydrology, atmosphere, and rectilinear empty city | Repository-authored procedural Three.js/TSL | review route only | `src/gfx/v2/hero/forest-city-hero-feature.ts`; no imported model, texture, or demo shader |
| Hero C debris, B-spline/superformula three-shell ship, and Twinkle lights | Repository-authored procedural Three.js/TSL | review route only | `src/gfx/v2/hero/space-twinkle-hero-feature.ts`; no simulation import or external technique source |
| Music and pulse/answer tones | Web Audio synthesis in repository source | yes | `src/game/audio.ts`; no recording or sample |
| UI, typography, favicon | Repository CSS/SVG using system fonts | yes | `app/globals.css`, `public/favicon.svg` |
| Social/contest thumbnail | One built-in image-generation call, no input/reference image | no, metadata only | `public/og.png`, 1600×900; prompt recorded in `docs/CODEX_COLLABORATION.md` |
| React / React DOM / Scheduler | npm, MIT | yes | exact `19.2.6` / `19.2.6` / `0.27.0` in `package-lock.json`; release notice included |
| Three.js | npm, MIT | yes | exact `0.185.1` in `package-lock.json`; release notice included |
| vinext and build/test tooling | npm packages | build/host | direct licenses verified from installed package metadata; transitive audit remains part of release evidence |

The four Notion gameplay-gallery PNGs are review-only under
`targets/visual-reference/source-notion-20260818/`; no runtime or public build
module imports them. No account data, personal data, analytics SDK, remote
font, stock image, imported audio, external model, or runtime AI API is used.

Automated license verification checks the exact non-dev package closure, the
notice contents, Hero provenance rows, and absence of runtime reference-board
imports. It is engineering evidence, not the final public-rights guarantee.

`HUMAN_PENDING`: final public-use and contest-rights guarantee, including acceptance of organizer publicity/archive rights and any winner priority-negotiation terms.
