# Quality and release matrix

> **Release work is frozen.** The renderer/world-generation R2 spike runs only in `graphics-photoreal-megademo`. Neither this branch nor saved Sites v1 is a deployment candidate. `main` stays at `6c010ee`; the pre-rebaseline WIP is preserved at `cbedd6d`.

| Gate | Automated evidence | Status |
| --- | --- | --- |
| G0 Foundation | source-of-truth snapshot, dependency audit, Git baseline | passed |
| G1 Deterministic core | phase/shot/ledger/replay/1,000-seed and visual-asset contract tests | passed: 16 automated tests in working candidate |
| G2 Playable journey | production build plus desktop/mobile browser flows | archived WIP only; not a release claim under the revised graphics source |
| G3 Accessibility and presentation | settings/input/audio/end-card/focus/reference-gallery checks | archived WIP only; contracts are inputs to R2 |
| G4 Independent acceptance | isolated artifact review; S0–S2 = 0 | v1 rejected; pre-rebaseline visual pass is superseded by Cinematic Procedural Realism |
| G5 Public release | anonymous HTTPS smoke interaction and version receipt | frozen; Sites v1 exists but must not be deployed |

## R2 graphics rebaseline gates

| Gate | Acceptance | Status |
| --- | --- | --- |
| R2-G0 Isolation | WIP pushed, `main` unchanged, worktree and no-deploy rule recorded | passed: `cbedd6d`, `2bde78e` |
| R2-G1 Renderer spike | WebGPURenderer + TSL; default WebGPU and forced-WebGL2 telemetry; no simulation changes | in progress |
| R2-G2 Shared foundation | RenderFeature, Linear HDR, warm-up, temporal ownership, metrics, provenance | pending |
| R2-G3 Slice A | ocean/submerged ruin High + fallback | pending |
| R2-G4 Slice B | sunset forest/city High + fallback | pending |
| R2-G5 Slice C | human debris/alien/Twinkle High + fallback | pending |
| R2-G6 Parity and acceptance | 180s hash, 1,000 seeds, restart resources, performance, license, blind review | pending |
| R2-G7 Human integration | explicit `Merge` / `Partial Merge` / `Reject` | `HUMAN_PENDING` |

## Performance targets

Reference targets from the production plan are P95 frame ≤16.67ms, P99 ≤25ms, main-thread work ≤8ms, and GPU work ≤11ms on the reference machine; low tier targets ≤33.33ms. Automated telemetry is evidence, but actual reference-device acceptance remains an external hardware gate. The archived SwiftShader main-thread-render-duration samples are not reference-frame or GPU acceptance.

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
- Rejected candidate v1: `6c010ee228ace28e655ceeba764513806505b03e`; S0=0, S1=1, S2=3, S3=3. Its immutable receipt is stored at `.quality-gates/receipts/blind-review-v1.json`; it was never deployed.
- Preserved pre-rebaseline WIP: `cbedd6d` on `archive/pre-graphics-rebaseline-20260818` (not deployable).
- Graphics rebaseline plan: `2bde78e` on `graphics-photoreal-megademo`.
- Notion progress: https://app.notion.com/p/3bf9b8d39c2881e7ac83ef4245a80311?pvs=204
