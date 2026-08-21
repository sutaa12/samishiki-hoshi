# Quality and release matrix

> **Release work is frozen.** The renderer/world-generation R2 spike runs only in `graphics-photoreal-megademo`. Neither this branch nor saved Sites v1 is a deployment candidate. `main` stays at `6c010ee`; the pre-rebaseline WIP is preserved at `cbedd6d`.

| Gate | Automated evidence | Status |
| --- | --- | --- |
| G0 Foundation | source-of-truth snapshot, dependency audit, Git baseline | passed |
| G1 Deterministic core | phase/shot/ledger/replay/1,000-seed and visual-asset contract tests | passed: 16 automated tests in working candidate |
| G2 Playable journey | production build plus desktop/mobile browser flows | archived WIP only; not a release claim under the revised graphics source |
| G3 Accessibility and presentation | settings/input/audio/end-card/focus/reference-gallery checks | archived WIP only; contracts are inputs to R2 |
| G4 Independent acceptance | isolated artifact review; S0–S2 = 0 | automated combined scope accepted at `2741af5` / reviewed evidence `ba38e66`; human visual/play remains separate |
| G5 Public release | anonymous HTTPS smoke interaction and version receipt | frozen; Sites v1 exists but must not be deployed |

## R2 graphics rebaseline gates

| Gate | Acceptance | Status |
| --- | --- | --- |
| R2-G0 Isolation | WIP pushed, `main` unchanged, worktree and no-deploy rule recorded | passed: `cbedd6d`, `2bde78e` |
| R2-G1 Renderer spike | WebGPURenderer + TSL; healthy actual WebGPU and forced-WebGL2 telemetry; no simulation changes | passed: implementation `86928ca`, reviewed evidence `bd34c30`; independent review S0=0, S1=0, S2=0, S3=0 |
| R2-G2 Shared foundation | RenderFeature, deterministic WorldPlan, named seed streams, Linear HDR, warm-up, temporal ownership, metrics, provenance | passed for the exact automated foundation at implementation `3b57eeb` and reviewed evidence `6e1ff9b`: GFX-004, GFX-005, and GFX-006 independent source/artifact reviews report S0–S3=0; reference-hardware performance remains separate `HARDWARE_PENDING` |
| R2-G3 Slice A | ocean/submerged ruin High + fallback | passed in exact Hero R33 implementation `e1b101b`, reviewed evidence `0c869ab`; independent technical, artifact, and visual review S0=0, S1=0, S2=0, S3=0 |
| R2-G4 Slice B | sunset forest/city High + fallback | passed in exact Hero R33 implementation `e1b101b`, reviewed evidence `0c869ab`; independent technical, artifact, and visual review S0=0, S1=0, S2=0, S3=0 |
| R2-G5 Slice C | human debris/alien/Twinkle High + fallback | passed in exact Hero R33 implementation `e1b101b`, reviewed evidence `0c869ab`; independent technical, artifact, and visual review S0=0, S1=0, S2=0, S3=0 |
| R2-G6 Parity and acceptance | 180s hash, 1,000 seeds, restart resources, performance, license, blind review | passed for exact implementation `2741af5` and reviewed evidence `ba38e66`; reference hardware, human visual/play, and rights remain pending |
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

## 2026-08-20 internal visual remediation audit

- Internal review of all 20 R2-G6 Hero frames found that the procedural scenes were functionally correct but did not yet establish the required Cinematic Procedural Realism. Repeated primitive silhouettes were most visible in Hero A coral/fish, Hero B vegetation, and Hero C nebula/ship framing. This is a blocking internal visual finding, not an independent-review verdict.
- Hero A implementation `8ca6e9a23930184454c1653131c637c5e1795f1c` replaces repeated straight coral stems with preallocated tapered branches, adds deterministic kelp blades and fish fins/eyes, adds four deterministic rock silhouettes, replaces ring-line caustics with textured floor patches, and adds one bounded organic detail texture. The existing world-plan, story, Twinkle, worker, upload, HDR, temporal, and light-cardinality boundaries are unchanged.
- `npm run verify` passes 36/36 files and 618/618 tests. Focused Hero tests pass 2/2 files and 7/7 assertions. Fresh-port forced-WebGL2 passes the 12→27→37→Low→High sequence plus 120 steady frames; host-Metal WebGPU passes the 12→27 reveal sequence. Both retain `programGrowthAfterReady=0`, `runtimeCompileEvents=0`, and zero post-initialize Hero allocations.
- Hero B implementation `de559f8a60a9d838bd428ca8e604a6ee94efd4f7` adds layered tree crowns and branches, grass tufts, birds, clustered clouds, a sunset dome, richer procedural surface response, and an organic protagonist without changing the rectilinear empty-city grammar.
- Hero C implementation `1d097899f08a74cfd649b91f48dc7ea1b20a43ef` adds a deterministic depth starfield, layered nebulae, higher-resolution iridescent ribbon shells, a procedural living Earth, and an organic protagonist while retaining exactly three incomplete S20 arcs and the open-center three-shell S21 answer.
- Current provenance commit `b84a267ad6cb174af30ef11b6055889f6180e519` binds all three remediations. `npm run verify` passes 36/36 files and 620/620 tests; the focused parity/world/Hero/license/telemetry set passes 57/57; one serial real-browser run passes Foundation plus Hero A/B/C on forced-WebGL2 and host-Metal WebGPU 8/8 with 20 bound frames, zero post-ready program growth/runtime compile events/post-initialize Hero allocations, and zero terminal Hero ownership.
- The earlier `b84a267` remediation was frozen only as a `review_pending` implementation checkpoint. It is retained as historical evidence and is superseded for Hero acceptance by the R33 record below.
- Superseding Hero R33 implementation `e1b101b9438097f739437e0a50af80774fd707ed` and reviewed evidence `0c869ab1087f8940015706c2f4d83977ec1bab05` close the automated Hero-only gate. Complete verification passes 36/36 files and 620/620 tests; focused Hero unit evidence passes 3/3 files and 18/18 assertions; browser evidence passes 6/6 with retry/error 0 and twenty valid 1920x1080 PNGs. Independent technical, visual, and artifact reviews report S0=0, S1=0, S2=0, S3=0. The exact source archive, 23-file manifest, extracted 110-file build digest, runtime notice, Worker copies, production audit, and 10/10 asset list reproduce without drift. This does not promote combined R2-G6, reference hardware, human visual/play, rights, Main, Sites, or submission.

## 2026-08-20 GFX-004/GFX-005/GFX-006 acceptance

- Implementation `3b57eeb213df7a945f13b93c62188f62a9c003b5` and evidence `6e1ff9b7c6f4c790035aa54eb608861bf54617b6` bind the current chunk/Worker lifecycle, TSL material/HDR pipeline, and telemetry foundation. GFX-004 transport, GFX-005 release QA, GFX-006 blind source review, and the final combined artifact review each report no actionable S0/S1/S2; the artifact review also reports S3=0.
- Complete verification passes 37 files and 708 tests. The preserved Vitest JSON reports 80/80 suites and 708/708 tests with failed/pending/todo 0. GFX-005 focused evidence passes 5 files / 315 tests, GFX-006 focused evidence passes 8 files / 326 tests, and production dependency audit reports 0 vulnerabilities.
- Fresh local Chromium evidence passes forced-WebGL2 and host-Metal WebGPU 2/2 with retry/error 0. WebGL2 records 88 compile actions at maximum 16.700000048 ms; WebGPU records 176 at maximum 19.800000191 ms. Both record 32 uploads and 4 activations, with compile/upload/activation >50 ms count 0 and post-ready program growth 0.
- The aggregate initialization event is 202.2 ms on WebGL2 and 292.3 ms on WebGPU. It remains visible but is not misrepresented as one atomic compile action. GPU timestamps are unsupported in both runs; SwiftShader is not reference hardware. Reference performance remains `HARDWARE_PENDING`.
- Ten live restart cycles retain programs 21, geometries 3, GPU/logical owners 4, and pool slots 4; the last-five forced-GC heap spread is 322,464 bytes. Ten complete runtime generations submit frames and finish with every attached terminal owner/reference/spike value at zero.
- Exact source/build/test/browser bindings are in `docs/evidence/GFX-004.md`, `docs/evidence/GFX-005.md`, `docs/evidence/GFX-006.md`, `.quality-gates/gfx005-006-3b57eeb-artifact.json`, and the GFX-005/GFX-006 receipts. This automated acceptance does not promote combined Hero-current-runtime evidence or authorize reference-hardware, human visual/play, rights/legal, Main, Sites, or contest gates.

## 2026-08-22 R2-G6 combined automated acceptance

- Exact implementation `2741af51e277bdaa76ac97ee8b207bbfb1683cee`,
  evidence `ba38e664cf6245a45cfa4eeaf1002de8036e2045`, and receipt
  `.quality-gates/receipts/r2-g6-current-review.json` close the automated
  combined Foundation plus Hero A/B/C gate with S0=S1=S2=S3=0.
- Complete verification is 37 files / 716 tests; focused evidence is 10 files /
  177 tests; typecheck, lint, build, and production audit pass. Browser evidence
  is 8/8 with retry/error 0 and twenty unique 1920×1080 PNGs.
- Both 12-second Hero A frames contain nature only; the 27-second frames contain
  the intended empty-seat artifact. Runtime scene passes refresh exactly once
  per submit without post-ready program growth.
- Source archive, 129-file manifest, reader-independent 110-file dist, runtime
  notice, compiled Workers, Vitest, Playwright, restart plateau, and ten
  zero-owner lifecycle generations reproduce without drift.
- One artifact reviewer perceived overlay clipping and locked an S2. The dissent
  is preserved, but independent raw-pixel adjudication and final integration
  proved identical High/Fallback glyph-position masks for all exact overlay
  colors. It is closed as `MITIGATED_NON_REPRODUCED`, without a source-change
  claim.
- Reference hardware stays `HARDWARE_PENDING`. Human visual/play, rights,
  D-005 integration, Main, Sites, and contest submission stay `HUMAN_PENDING`.

## Release record

- GitHub: https://github.com/sutaa12/samishiki-hoshi (public, main)
- Sites project: `samishiki-hoshi-seoul` (production URL pending)
- Rejected candidate v1: `6c010ee228ace28e655ceeba764513806505b03e`; S0=0, S1=1, S2=3, S3=3. Its immutable receipt is stored at `.quality-gates/receipts/blind-review-v1.json`; it was never deployed.
- Preserved pre-rebaseline WIP: `cbedd6d` on `archive/pre-graphics-rebaseline-20260818` (not deployable).
- Graphics rebaseline plan: `2bde78e` on `graphics-photoreal-megademo`.
- Notion gameplay visual-target snapshot: `8794258` (reference-only; excluded from runtime and Sites package).
- Accepted GFX-001 renderer spike: implementation `86928ca987814aa161003bd3ac588d37c95d9a9c`, reviewed evidence HEAD `bd34c30999417b2fcb13c113f3be5a778d7e7ec8`; independent review S0=0, S1=0, S2=0, S3=0. Bound evidence is in `docs/evidence/GFX-001.md`, `.quality-gates/gfx001-86928ca-artifact.json`, and `.quality-gates/receipts/gfx001-review.json`. GFX-001 is frozen; this does not accept R2-G2–G7.
- Accepted GFX-002 render contract: implementation `2cfaafb5cbecca816cccabff6ddce3af83a207dc`, reviewed evidence HEAD `9f3286d1d01bed21e3f5814cb506fc6814c18e9a`; independent source and artifact reviews are S0=0, S1=0, S2=0, S3=0. Exact build and fresh-port 9/9 browser evidence are bound in `docs/evidence/GFX-002.md`, `.quality-gates/gfx002-2cfaafb-artifact.json`, and `.quality-gates/receipts/gfx002-review.json`. That receipt accepts only GFX-002; later ticket acceptances are recorded separately.
- Accepted GFX-003 deterministic world plan: implementation `c0245667b00e80fe68a511eb0fc206e14f5ead9a`, reviewed evidence HEAD `a4bcfdf9af4d560360e1e875328a26fbc3d390cb`; independent source and artifact reviews are S0=0, S1=0, S2=0, S3=0. Seed `20260818` is pinned to `world-plan-v1:75d93cbb8e0580cd`, 1,000 seed properties pass, and exact source/build/test evidence is bound in `docs/evidence/GFX-003.md`, `.quality-gates/gfx003-c024566-artifact.json`, and `.quality-gates/receipts/gfx003-review.json`. That receipt accepts only GFX-003; later GFX-004–006 acceptance is recorded below.
- Historical GFX-004/GFX-005 checkpoint `e81c47846291018c37c3496c47b547fb0100375d` was deliberately `review_pending`. Its old artifact, build, test, and browser files remain preserved under the `gfx005-e81c478` names and are superseded by the accepted current foundation.
- Historical GFX-006 checkpoint `9597d9b8f905b492359590eed2cf3dbfdb5e73d8` was deliberately `review_pending`. Its old artifact, build, test, and browser files remain preserved under the `gfx006-9597d9b` names and are superseded by the accepted current foundation.
- Accepted GFX-004/GFX-005/GFX-006 automated foundation: implementation `3b57eeb213df7a945f13b93c62188f62a9c003b5`, reviewed evidence `6e1ff9b7c6f4c790035aa54eb608861bf54617b6`. Exact bindings and limitations are in `docs/evidence/GFX-004.md`, `docs/evidence/GFX-005.md`, `docs/evidence/GFX-006.md`, `.quality-gates/gfx005-006-3b57eeb-artifact.json`, `.quality-gates/receipts/gfx005-review.json`, and `.quality-gates/receipts/gfx006-review.json`. This accepts R2-G2's automated shared foundation only; combined Hero-current-runtime, reference hardware, human/rights, Main, Sites, and submission remain pending.
- Frozen Hero Slice A candidate: implementation `67dea2b1589c0e7f862cf76674b45b3cffbc04f1`, tree `1ed67a9ca783905034b7dbb496040b2f8416a8a1`. Complete verification passes 32/32 files and 603/603 tests; focused Hero tests pass 2/2 files and 10/10 assertions; fresh-port Playwright passes forced-WebGL2 and host-Metal WebGPU 2/2 with six bound 1920×1080 frames. The exact 12-second abundant-life marker, 18-second human-artifact boundary, 27-second rectilinear empty-seat motif, 37-second waterline, High/Low visual-only density, zero post-ready compile growth, and zero post-initialize Hero allocations are covered. Exact bindings are in `docs/evidence/HERO-A.md`, `.quality-gates/hero-a-67dea2b-artifact.json`, and `.quality-gates/receipts/hero-a-review.json`. R2-G3 remains `review_pending`; independent source/artifact/visual review, reference hardware, human visual/play acceptance, Hero B/C, Main integration, and Sites release remain pending or frozen.
- Superseding Hero A visual-remediation implementation: `8ca6e9a23930184454c1653131c637c5e1795f1c`, tree `989fc6f47d902812685e5362111f3d4a3e3d1086`. Its complete/focused/browser checks are green as recorded above, but the `67dea2b` artifact and receipt remain historical evidence only and do not accept this new source. New frozen artifacts and blind review are required before R2-G3 can be promoted.
- Frozen Hero Slice B candidate: implementation `2fb5cade0c5e8df8b3e889a14a57867c8e0440ba`, tree `a213bd89ecccae584a24b02ef95ccc62971f5d7a`. Complete verification passes 33/33 files and 608/608 tests; focused Hero tests pass 2/2 files and 10/10 assertions; fresh-port Playwright passes forced-WebGL2 and host-Metal WebGPU 2/2 with five bound 1920×1080 frames. The exact 58-second abundant forest, 61.999/62-second city boundary, 75-second empty rectilinear city, connected river/waterfall, High/Low visual-only density, zero post-ready compile growth, and zero post-initialize Hero allocations are covered. Exact bindings are in `docs/evidence/HERO-B.md`, `.quality-gates/hero-b-2fb5cad-artifact.json`, and `.quality-gates/receipts/hero-b-review.json`. R2-G4 remains `review_pending`; independent source/artifact/visual review, reference hardware, human visual/play acceptance, Hero A/C, Main integration, and Sites release remain pending or frozen.
- Superseding Hero B visual-remediation implementation: `de559f8a60a9d838bd428ca8e604a6ee94efd4f7`. The `2fb5cad` artifact and receipt remain historical evidence only; current source is bound through the combined `b84a267` candidate and still requires independent review.
- Frozen Hero Slice C candidate: implementation `69fe2e47c5269ccc407c95a6c6491fbbff1ceb8c`, tree `a34cb017c28f638e251e4c978881fd6806d4f1eb`. Complete verification passes 34/34 files and 613/613 tests; focused Hero tests pass 2/2 files and 10/10 assertions; fresh-port Playwright passes forced-WebGL2 and host-Metal WebGPU 2/2 with nine bound 1920×1080 frames. The 142-second seven-form debris marker and dying beacon, 160.999/161-second incomplete-arc to three-shell boundary, 166-second open-center answer scene, ordered one/few/tens/many Twinkle realization, 176-second living-Earth return, 179-second formal title, High/Low visual-only density, zero post-ready compile growth, and zero post-initialize Hero allocations are covered. Exact bindings are in `docs/evidence/HERO-C.md`, `.quality-gates/hero-c-69fe2e4-artifact.json`, and `.quality-gates/receipts/hero-c-review.json`. R2-G5 remains `review_pending`; independent source/artifact/visual review, reference hardware, human visual/play acceptance, Hero A/B, Main integration, and Sites release remain pending or frozen.
- Superseding Hero C visual-remediation implementation: `1d097899f08a74cfd649b91f48dc7ea1b20a43ef`. The `69fe2e4` artifact and receipt remain historical evidence only; current source is bound through the combined `b84a267` candidate and still requires independent review.
- Frozen R2-G6 combined candidate: implementation `cbbd4e5e0824846c1172c60fa24476ae973de8ca`, tree `85f624d0b0543da91674cf69c60b2ecc3fe0a934`. Complete verification passes 36/36 files and 617/617 tests; the focused parity/world/Hero/license/telemetry set passes 8 requested files and 54/54 assertions; one fresh-port serial browser run passes Foundation plus Hero A/B/C on forced-WebGL2 and host-Metal WebGPU 8/8. The exact evidence includes 1,000 seed validation, quality/backend-invariant replay, sequential A/B/C scene restoration, ten constant resource plateaus, ten zero-owner runtime generations, twenty embedded Hero frames, the four-package MIT runtime closure, and the byte-identical shipped notice. Bindings are in `docs/evidence/R2-G6.md`, `.quality-gates/r2-g6-cbbd4e5-artifact.json`, and `.quality-gates/receipts/r2-g6-review.json`. R2-G6 remains `review_pending`; independent frozen-scope and visual review, the underlying review-pending gates, reference hardware, human visual/play and rights acceptance, Main integration, Sites deployment, and contest submission remain separate.
- Superseding R2-G6 visual-remediation candidate: implementation `b84a267ad6cb174af30ef11b6055889f6180e519`, tree `9600aec0c9edbcff211a092bed34fb2231047dbe`. Complete verification passes 36/36 files and 620/620 tests; focused evidence passes 57/57; combined Foundation plus Hero A/B/C browser evidence passes 8/8 with four JSON and twenty PNG attachments. Exact bindings are in `docs/evidence/R2-G6-VISUAL-REMEDIATION.md`, `.quality-gates/r2-g6-b84a267-artifact.json`, and `.quality-gates/receipts/r2-g6-visual-remediation-review.json`. The older `cbbd4e5` evidence remains historical; this candidate remains `review_pending` with all human/external release gates unchanged.
- Accepted Hero R33 automated scope: implementation `e1b101b9438097f739437e0a50af80774fd707ed`, tree `5c7540fdb86831d46411c7d7aadbabc0e75770ba`, reviewed evidence `0c869ab1087f8940015706c2f4d83977ec1bab05`. The exact accepted bindings are in `docs/evidence/HERO-R33.md`, `.quality-gates/hero-r33-e1b101b-artifact.json`, and `.quality-gates/receipts/hero-r33-review.json`. This supersedes the old Hero source/visual acceptance only; combined R2-G6 remains pending.
- Accepted current R2-G6 automated scope: implementation `2741af51e277bdaa76ac97ee8b207bbfb1683cee`, tree `42e3e57e03915bf75770156951f905cc4949ffc9`, reviewed evidence `ba38e664cf6245a45cfa4eeaf1002de8036e2045`. Exact bindings and preserved dissent are in `docs/evidence/R2-G6-CURRENT-2741AF5.md`, `.quality-gates/r2-g6-current-2741af5-artifact.json`, and `.quality-gates/receipts/r2-g6-current-review.json`. This completes only automated R2-G6; D-005 and all human/external release gates remain pending.
- Notion progress: https://app.notion.com/p/3bf9b8d39c2881e7ac83ef4245a80311?pvs=204
