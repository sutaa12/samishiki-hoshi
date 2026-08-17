# Asset and rights inventory

This is an engineering inventory, not the final legal attestation. The responsible human must approve the exact release.

| Asset | Origin | Runtime | Evidence / review |
| --- | --- | --- | --- |
| World geometry, particles, human grammar, unknown ship | Procedurally generated in repository source | yes | `src/game/world.ts`; no imported model or texture |
| Music and pulse/answer tones | Web Audio synthesis in repository source | yes | `src/game/audio.ts`; no recording or sample |
| UI, typography, favicon | Repository CSS/SVG using system fonts | yes | `app/globals.css`, `public/favicon.svg` |
| Social/contest thumbnail | One built-in image-generation call, no input/reference image | no, metadata only | `public/og.png`, 1600×900; prompt recorded in `docs/CODEX_COLLABORATION.md` |
| React / React DOM | npm, MIT | yes | locked in `package-lock.json` |
| Three.js | npm, MIT | yes | locked in `package-lock.json` |
| vinext and build/test tooling | npm packages | build/host | direct licenses verified from installed package metadata; transitive audit remains part of release evidence |

No account data, personal data, analytics SDK, remote font, stock image, imported audio, external model, or runtime AI API is used.

`HUMAN_PENDING`: final public-use and contest-rights guarantee, including acceptance of organizer publicity/archive rights and any winner priority-negotiation terms.

