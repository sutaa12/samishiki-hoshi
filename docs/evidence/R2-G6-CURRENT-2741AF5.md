# R2-G6 current evidence candidate 2741af5

> **Automated R2-G6 scope accepted.** Independent full-source, artifact-binding,
> blind visual, narrow adjudication, and final integration review report final
> S0=0, S1=0, S2=0, S3=0 for the exact implementation and evidence hashes.
> This does not authorize Main integration, Sites deployment, public-use rights,
> human visual acceptance, reference hardware, or contest submission.

## Exact identity

- Implementation: `2741af51e277bdaa76ac97ee8b207bbfb1683cee`
- Tree: `42e3e57e03915bf75770156951f905cc4949ffc9`
- Branch: `graphics-photoreal-megademo`
- Ordered 129-file manifest:
  `.quality-gates/r2-g6-current-2741af5-files.sha256`
- Manifest SHA-256:
  `34afcd9d5f852013b8167e2f1ab708ddacfeaea0e8edd81304f0e2c2da783e0d`
- Rebuilt source archive SHA-256:
  `42afe8d299071ee198d95c6dfb5a3e775716f1c5a12425c2dcda9b22b7c130f7`
- Source archive: 323,420,160 bytes, 351 entries, 306 regular files,
  45 directories, zero symlinks; embedded commit equals the implementation.

## Closed Q2 visual blocker

The rejected Q2 candidate visibly showed the Hero A rectilinear vehicle in both
12-second LIFE frames. The current implementation captures all 92 descendants
of that human-artifact graph, hides them before initialization/warmup, reveals
them exactly at story time 18 seconds, and hides them again on seek-back.

During diagnosis, a separate runtime defect was found: Three r185 `PassNode`
FRAME updates were not advancing under the external browser frame loop, so the
canvas could remain on its warmup image while snapshots advanced. The current
pipeline explicitly draws each captured runtime scene topology once per submit,
then draws the output quad once while suppressing duplicate automatic updates.
Failure restoration and retry are covered by exact regressions.

Scoped and full independent source reviews report S0=0, S1=0, S2=0 for the
18-second boundary, runtime scene refresh, and complete combined implementation.

## Build and automated gates

| Check | Exact result |
| --- | --- |
| Complete verify | Typecheck, global lint, 37/37 files, 716/716 tests, production build PASS |
| Full Vitest JSON | 80/80 suites and 716/716 tests; SHA-256 `dafa2a7a54a5cadd67edec6643d8a62e6a792c96465a84230d5bc65cfedef6f1` |
| Focused Vitest JSON | 10 requested files, 20/20 suites, 177/177 tests; SHA-256 `6fd322b4a385a8575b1af970e5f6df42978106e621c925a7a2939d52bf589366` |
| Production audit | 0 vulnerabilities; SHA-256 `41e0957f81e8db3f722663db2e5f7c20bacfd3ceb9caba5820b350f3b86c18bd` |
| Preserved dist | `.quality-gates/r2-g6-current-2741af5-dist.tar`; SHA-256 `3041b21238ff82738b1aca0485e70eca230d433532ecdffaa5416e59e64c8741` |

The dist archive has one reader-independent inventory: 132 members, 110
regular files, 22 directories, zero symlinks, zero AppleDouble, zero duplicate,
and zero unsafe members. Empty Python extraction reproduces 110 files and the
canonical content digest
`3d08b61c28ede6d715d4c30ab76d491215798a74c0af049973265d509c4a65d0`.
The exact tested dist is preserved; Vinext output is not claimed byte
reproducible.

## Browser evidence

- Report: `.quality-gates/r2-g6-current-2741af5-playwright.json`
- Report SHA-256:
  `2ae5328fd47c0e1b811d24e0b56ce79e60233dad2891e9f379a47d58aee7ff2e`
- Summary: `.quality-gates/r2-g6-current-2741af5-browser-summary.json`
- Summary SHA-256:
  `39aa4e035a29032c90e8501a844de9a228033e6493aed13c4b96f01f326a580a`
- Start: `2026-08-21T14:14:47.488Z`
- Result: Foundation plus Hero A/B/C on forced WebGL2 and host Metal WebGPU,
  8/8 passed; retry, skipped, unexpected, flaky, and errors all zero.
- Attachments: 30 total; 10 JSON and 20 strictly decoded, unique 1920×1080
  PNGs.

| Route/backend | Compile actions | Maximum action | Programs ready | Growth | >50 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Foundation WebGL2 | 88 | 24.300 ms | — | — | 0 |
| Foundation WebGPU | 176 | 33.600 ms | — | — | 0 |
| Hero A WebGL2 | 1,210 | 40.900 ms | 91 | 0 | 0 |
| Hero A WebGPU | 2,420 | 28.400 ms | 189 | 0 | 0 |
| Hero B WebGL2 | 660 | 35.400 ms | 94 | 0 | 0 |
| Hero B WebGPU | 1,320 | 34.100 ms | 189 | 0 | 0 |
| Hero C WebGL2 | 258 | 32.400 ms | 54 | 0 | 0 |
| Hero C WebGPU | 516 | 38.200 ms | 105 | 0 | 0 |

Every compile, upload, and activation operation is at or below 50 ms; all
upload/activation maxima are at or below 0.3 ms. Ten live restarts remain below
the 16 MiB heap-spread limit and finish with programs 21, geometries 3, and four
active pool owners. Ten complete disposal generations end with every tracked
owner, retained failure reference, pool slot, and runtime spike at zero.

The twenty frames contain separate 12-second and 27-second Hero A captures for
both backends. The 12-second frames show living ocean nature with no vehicle;
the 27-second frames show the intended empty-seat artifact. The independent
artifact reviewer reproduced all bindings and required scene content.

## Independent review and preserved dissent

- Full source: `r2g6_2741_source_acceptance` — ACCEPT, S0=S1=S2=S3=0.
- Artifact-only: `r2g6_n7_artifact_blind` — 20/20 frames and every binding
  reproduced; one locked S2 alleged missing overlay glyphs in two previews.
- Narrow raw-pixel adjudication: `r2g6_overlay_adjudication` — ACCEPT,
  S0=S1=S2=S3=0. Every glyph, line, marker, and divider was complete.
- Final integration: `r2g6_2741_final_integration_verdict` — ACCEPT,
  S0=S1=S2=S3=0. High/Fallback position masks were byte-identical for six exact
  CSS colors, proving the apparent difference came from the inspection display
  rather than the PNG or game. The original dissent remains preserved as
  `MITIGATED_NON_REPRODUCED`; no source change is claimed.
- Receipt: `.quality-gates/receipts/r2-g6-current-review.json`.

## Gate boundary

The automated R2-G6 gate is complete for the exact hashes. The next gate is the
Human Acceptance Owner's D-005 `Merge` / `Partial Merge` / `Reject` decision and
public-use/contest-rights acceptance. Reference hardware remains
`HARDWARE_PENDING`; human play/visual, rights, Main integration, Sites
deployment, and contest submission remain `HUMAN_PENDING`.
