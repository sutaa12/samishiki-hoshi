# Quality and release matrix

| Gate | Automated evidence | Status |
| --- | --- | --- |
| G0 Foundation | source-of-truth snapshot, dependency audit, Git baseline | passed |
| G1 Deterministic core | phase/shot/ledger/replay/1,000-seed tests | passed: 13 automated tests |
| G2 Playable journey | production build plus desktop/mobile browser flows | passed: production build and 3 browser flows |
| G3 Accessibility and presentation | settings/input/audio/end-card checks | passed: keyboard, pointer, touch, settings, end card |
| G4 Independent acceptance | isolated SolMax artifact review; S0–S2 = 0 | pending |
| G5 Public release | anonymous HTTPS smoke interaction and version receipt | Sites project created; deployment pending |

## Performance targets

Reference targets from the production plan are P95 frame ≤16.67ms, P99 ≤25ms, main-thread work ≤8ms, and GPU work ≤11ms on the reference machine; low tier targets ≤33.33ms. Automated telemetry is evidence, but actual reference-device acceptance remains an external hardware gate.

## Official event facts verified 2026-08-18

- Track 1 submission is shown as open; the published deadline is 2026-08-26, with no official time or timezone stated.
- Required submission fields are title, a description up to 200 characters, a publicly playable link, and a thumbnail. A demo video and Codex process record are optional scoring material.
- The playable link must remain free and directly usable during judging; Sites is acceptable but not mandated.
- Official sources: [event](https://openaigame2026.com/), [terms](https://openaigame2026.com/ko/terms), [privacy](https://openaigame2026.com/ko/privacy).

## Human and external gates

- `HUMAN_PENDING`: named representative data, age/country eligibility, team composition, all terms/privacy/international-transfer consents, and any guardian consent.
- `HUMAN_PENDING`: acceptance of publicity/recording use and the winner priority-negotiation provision.
- `HUMAN_PENDING`: final rights guarantee for every released asset and Seoul attendance on 2026-08-31 if selected.
- `HUMAN_PENDING`: Google authentication, personal-data form completion, final submission click, and monitoring email/phone on 2026-08-28–30.
- `HARDWARE_PENDING`: performance acceptance on the organizer/reference device.

## Dependency and build notes

- `npm audit --omit=dev`: 0 vulnerabilities.
- The complete install reports 17 issues in build/development tooling (2 low, 15 high), including vinext/Cloudflare/Vite transitive packages. The deployed artifact is a compiled archive with no `node_modules`, the build consumes only repository-owned inputs, and the game accepts no server-side user content. Upstream range-breaking automatic fixes were not applied; this remains disclosed supply-chain evidence rather than a hidden production claim.
- The client build reports one bundle-size advisory because Three.js is shipped in the initial game chunk. Startup and frame behavior are verified separately; reference-hardware performance remains `HARDWARE_PENDING`.

## Release record

- GitHub: https://github.com/sutaa12/samishiki-hoshi (public, main)
- Sites project: `samishiki-hoshi-seoul` (production URL pending)
- Notion progress: https://app.notion.com/p/3bf9b8d39c2881e7ac83ef4245a80311?pvs=204
