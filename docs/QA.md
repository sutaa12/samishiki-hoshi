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
| R2-G1 Renderer spike | WebGPURenderer + TSL; healthy actual WebGPU and forced-WebGL2 telemetry; no simulation changes | passed: implementation `86928ca`, reviewed evidence `bd34c30`; independent review S0=0, S1=0, S2=0, S3=0 |
| R2-G2 Shared foundation | RenderFeature, deterministic WorldPlan, named seed streams, Linear HDR, warm-up, temporal ownership, metrics, provenance | in progress: GFX-002 and GFX-003 accepted; GFX-004/GFX-005 remain review-pending; GFX-006 candidate `9597d9b` passes 597 complete tests, 499 focused assertions, and both real-browser gates, but independent source/artifact review and reference-hardware performance remain pending |
| R2-G3 Slice A | ocean/submerged ruin High + fallback | candidate `67dea2b`: 603 complete tests, 10 focused assertions, and forced-WebGL2/host-Metal WebGPU 2/2 pass; exact evidence frozen, independent source/artifact/visual review pending |
| R2-G4 Slice B | sunset forest/city High + fallback | candidate `2fb5cad`: 608 complete tests, 10 focused assertions, and forced-WebGL2/host-Metal WebGPU 2/2 pass; exact evidence frozen, independent source/artifact/visual review pending |
| R2-G5 Slice C | human debris/alien/Twinkle High + fallback | candidate `69fe2e4`: 613 complete tests, 10 focused assertions, and forced-WebGL2/host-Metal WebGPU 2/2 pass; exact evidence frozen, independent source/artifact/visual review pending |
| R2-G6 Parity and acceptance | 180s hash, 1,000 seeds, restart resources, performance, license, blind review | candidate `cbbd4e5`: 617 complete tests, 54 focused assertions, combined browser 8/8, 10 restart plateaus and 10 zero-owner generations; exact evidence frozen, independent source/artifact/visual review pending |
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
- Notion gameplay visual-target snapshot: `8794258` (reference-only; excluded from runtime and Sites package).
- Accepted GFX-001 renderer spike: implementation `86928ca987814aa161003bd3ac588d37c95d9a9c`, reviewed evidence HEAD `bd34c30999417b2fcb13c113f3be5a778d7e7ec8`; independent review S0=0, S1=0, S2=0, S3=0. Bound evidence is in `docs/evidence/GFX-001.md`, `.quality-gates/gfx001-86928ca-artifact.json`, and `.quality-gates/receipts/gfx001-review.json`. GFX-001 is frozen; this does not accept R2-G2–G7.
- Accepted GFX-002 render contract: implementation `2cfaafb5cbecca816cccabff6ddce3af83a207dc`, reviewed evidence HEAD `9f3286d1d01bed21e3f5814cb506fc6814c18e9a`; independent source and artifact reviews are S0=0, S1=0, S2=0, S3=0. Exact build and fresh-port 9/9 browser evidence are bound in `docs/evidence/GFX-002.md`, `.quality-gates/gfx002-2cfaafb-artifact.json`, and `.quality-gates/receipts/gfx002-review.json`. That receipt accepts only GFX-002; later GFX-003 acceptance is recorded separately, while GFX-004–006 remain pending.
- Accepted GFX-003 deterministic world plan: implementation `c0245667b00e80fe68a511eb0fc206e14f5ead9a`, reviewed evidence HEAD `a4bcfdf9af4d560360e1e875328a26fbc3d390cb`; independent source and artifact reviews are S0=0, S1=0, S2=0, S3=0. Seed `20260818` is pinned to `world-plan-v1:75d93cbb8e0580cd`, 1,000 seed properties pass, and exact source/build/test evidence is bound in `docs/evidence/GFX-003.md`, `.quality-gates/gfx003-c024566-artifact.json`, and `.quality-gates/receipts/gfx003-review.json`. This accepts only GFX-003; GFX-004–006 remain pending.
- Frozen GFX-004/GFX-005 combined candidate: GFX-004 `370b019f5aee868449117b51a0da114b35ffc045`, GFX-005 `c6dd34dd9082e437e04d2fc7ccd1045a9a59ae1d` plus `170c0898e5223f46aaaaf03b5eee6a906602e9de`, and integration `e81c47846291018c37c3496c47b547fb0100375d`. Complete verification passes 29/29 files and 579/579 tests; focused GFX-v2 passes 19/19 files and 481/481 tests; actual forced-WebGL2 and host-Metal WebGPU browser gates pass 2/2 with program growth 0 and terminal ownership 0. Exact source/build/test/browser bindings are recorded in `docs/evidence/GFX-004.md`, `docs/evidence/GFX-005.md`, `.quality-gates/gfx005-e81c478-artifact.json`, and `.quality-gates/receipts/gfx005-review.json`. The receipt is deliberately `review_pending`; it does not yet accept either gate or R2-G2.
- Frozen GFX-006 candidate: implementation `9597d9b8f905b492359590eed2cf3dbfdb5e73d8`, tree `1f17032cd8cda87b187c7e881bf32b7ad5567104`. Complete verification passes 31/31 files and 597/597 tests; focused GFX-v2 passes 21/21 files and 499/499 assertions; fresh-port Playwright passes forced-WebGL2 and host-Metal WebGPU 2/2. The forced-WebGL2 ten-restart tail has a 668,368-byte forced-GC heap spread with exact program/geometry/owner plateaus, and ten complete runtime generations end with every tracked owner at zero. Exact bindings are in `docs/evidence/GFX-006.md`, `.quality-gates/gfx006-9597d9b-artifact.json`, and `.quality-gates/receipts/gfx006-review.json`. The receipt remains `review_pending`; Metal GPU timestamps and reference-device performance are `HARDWARE_PENDING`, and no Hero Slice, Main merge, or Sites release is authorized.
- Frozen Hero Slice A candidate: implementation `67dea2b1589c0e7f862cf76674b45b3cffbc04f1`, tree `1ed67a9ca783905034b7dbb496040b2f8416a8a1`. Complete verification passes 32/32 files and 603/603 tests; focused Hero tests pass 2/2 files and 10/10 assertions; fresh-port Playwright passes forced-WebGL2 and host-Metal WebGPU 2/2 with six bound 1920×1080 frames. The exact 12-second abundant-life marker, 18-second human-artifact boundary, 27-second rectilinear empty-seat motif, 37-second waterline, High/Low visual-only density, zero post-ready compile growth, and zero post-initialize Hero allocations are covered. Exact bindings are in `docs/evidence/HERO-A.md`, `.quality-gates/hero-a-67dea2b-artifact.json`, and `.quality-gates/receipts/hero-a-review.json`. R2-G3 remains `review_pending`; independent source/artifact/visual review, reference hardware, human visual/play acceptance, Hero B/C, Main integration, and Sites release remain pending or frozen.
- Frozen Hero Slice B candidate: implementation `2fb5cade0c5e8df8b3e889a14a57867c8e0440ba`, tree `a213bd89ecccae584a24b02ef95ccc62971f5d7a`. Complete verification passes 33/33 files and 608/608 tests; focused Hero tests pass 2/2 files and 10/10 assertions; fresh-port Playwright passes forced-WebGL2 and host-Metal WebGPU 2/2 with five bound 1920×1080 frames. The exact 58-second abundant forest, 61.999/62-second city boundary, 75-second empty rectilinear city, connected river/waterfall, High/Low visual-only density, zero post-ready compile growth, and zero post-initialize Hero allocations are covered. Exact bindings are in `docs/evidence/HERO-B.md`, `.quality-gates/hero-b-2fb5cad-artifact.json`, and `.quality-gates/receipts/hero-b-review.json`. R2-G4 remains `review_pending`; independent source/artifact/visual review, reference hardware, human visual/play acceptance, Hero A/C, Main integration, and Sites release remain pending or frozen.
- Frozen Hero Slice C candidate: implementation `69fe2e47c5269ccc407c95a6c6491fbbff1ceb8c`, tree `a34cb017c28f638e251e4c978881fd6806d4f1eb`. Complete verification passes 34/34 files and 613/613 tests; focused Hero tests pass 2/2 files and 10/10 assertions; fresh-port Playwright passes forced-WebGL2 and host-Metal WebGPU 2/2 with nine bound 1920×1080 frames. The 142-second seven-form debris marker and dying beacon, 160.999/161-second incomplete-arc to three-shell boundary, 166-second open-center answer scene, ordered one/few/tens/many Twinkle realization, 176-second living-Earth return, 179-second formal title, High/Low visual-only density, zero post-ready compile growth, and zero post-initialize Hero allocations are covered. Exact bindings are in `docs/evidence/HERO-C.md`, `.quality-gates/hero-c-69fe2e4-artifact.json`, and `.quality-gates/receipts/hero-c-review.json`. R2-G5 remains `review_pending`; independent source/artifact/visual review, reference hardware, human visual/play acceptance, Hero A/B, Main integration, and Sites release remain pending or frozen.
- Frozen R2-G6 combined candidate: implementation `cbbd4e5e0824846c1172c60fa24476ae973de8ca`, tree `85f624d0b0543da91674cf69c60b2ecc3fe0a934`. Complete verification passes 36/36 files and 617/617 tests; the focused parity/world/Hero/license/telemetry set passes 8 requested files and 54/54 assertions; one fresh-port serial browser run passes Foundation plus Hero A/B/C on forced-WebGL2 and host-Metal WebGPU 8/8. The exact evidence includes 1,000 seed validation, quality/backend-invariant replay, sequential A/B/C scene restoration, ten constant resource plateaus, ten zero-owner runtime generations, twenty embedded Hero frames, the four-package MIT runtime closure, and the byte-identical shipped notice. Bindings are in `docs/evidence/R2-G6.md`, `.quality-gates/r2-g6-cbbd4e5-artifact.json`, and `.quality-gates/receipts/r2-g6-review.json`. R2-G6 remains `review_pending`; independent frozen-scope and visual review, the underlying review-pending gates, reference hardware, human visual/play and rights acceptance, Main integration, Sites deployment, and contest submission remain separate.
- Notion progress: https://app.notion.com/p/3bf9b8d39c2881e7ac83ef4245a80311?pvs=204
