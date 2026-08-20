# R2-G6 current combined Foundation and Hero evidence

> **Candidate frozen; independent source, artifact, and visual review pending.**
> This record binds the current Foundation plus Hero A/B/C implementation to
> exact source, build, automated-test, browser, restart, lifecycle, and visual
> attachments. It does not authorize Main integration, Sites deployment,
> reference-hardware acceptance, public-use rights, human play/visual
> acceptance, or contest submission.

## Exact identity

- Implementation: `9688a1d211b6f0a821bc5b4900628cd825e9aab3`
- Tree: `d25426bd725ac3bbbb8821eab094c07b5317faca`
- Branch: `graphics-photoreal-megademo`
- Ordered 129-file manifest:
  `.quality-gates/r2-g6-current-9688a1d-files.sha256`
- Ordered manifest SHA-256:
  `87627070ef14e7a48916d9f0ed6c695c501e8da9270d41502e9fbc3d7d9864b6`
- Rebuilt source archive SHA-256:
  `c13188ac36f0d5b5831bbf14d982486047900b4d87a945f6301757b9f2beea53`
- Source archive: 222,545,920 bytes, 326 entries, 282 regular files,
  44 directories, zero symlinks; embedded commit equals the implementation.

## Build and automated gates

| Check | Exact result |
| --- | --- |
| Complete verify | Typecheck, global lint, 37/37 files, 712/712 tests, and production build pass |
| Full Vitest JSON | `.quality-gates/r2-g6-current-9688a1d-full-vitest.json`; SHA-256 `1b7f9d0e76d6410e6f2a323c537828fb334180ccf8efb0180aa033808d1daa90`; 80/80 suites and 712/712 tests |
| Focused Vitest JSON | `.quality-gates/r2-g6-current-9688a1d-vitest.json`; SHA-256 `b9d5d322da4bc3778f6755e99aef1c54b8fd27ee0345783b41bc0f52a8686817`; 8 requested files, 16/16 suites, 60/60 tests |
| Production audit | 0 vulnerabilities; SHA-256 `41e0957f81e8db3f722663db2e5f7c20bacfd3ceb9caba5820b350f3b86c18bd` |
| Preserved dist | `.quality-gates/r2-g6-current-9688a1d-dist.tar`; SHA-256 `89663292510cafeb2ce94e4cddf2109543faf5f469a8c1fef96dd6e257649a7b` |

The dist archive contains 110 regular files and zero symlinks. Extraction into
an empty directory reproduces the content-record digest
`27d1525fe6e3e15ca0108aa7577b754403b2902a1d2fbcad9aaa58a0e85e7f3b`,
BUILD_ID `78336128-b734-46fa-af91-2a2853057fbc`, the exact runtime notice,
and three identical compiled Worker copies. No raw TypeScript Worker is shipped.
Vinext output is not claimed byte-reproducible; the exact tested output is
preserved.

## Exact browser run

- Report: `.quality-gates/r2-g6-current-9688a1d-playwright.json`
- Report SHA-256:
  `01fa8d2c932240a107ea4ec7d895e8dd6bf524a87d242c028ca333acd947d413`
- Summary: `.quality-gates/r2-g6-current-9688a1d-browser-summary.json`
- Summary SHA-256:
  `1920dec58554585a780e07a7f16f5484f8b5c6e863b2c8153786f61dc165b5d6`
- Start: `2026-08-20T07:10:51.654Z`
- Result: Foundation plus Hero A/B/C, forced-WebGL2 plus host-Metal WebGPU,
  8/8 passed, retry 0, skipped/unexpected/flaky 0, and no top-level or result
  errors.
- Attachments: 30 total; 10 JSON and 20 strictly decoded, unique, embedded
  1920×1080 PNGs.

| Route/backend | Compile actions | Maximum action | Programs at ready | Growth after ready | >50 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Foundation WebGL2 | 88 | 24.900 ms | — | — | 0 |
| Foundation WebGPU | 176 | 34.300 ms | — | — | 0 |
| Hero A WebGL2 | 1,210 | 32.000 ms | 91 | 0 | 0 |
| Hero A WebGPU | 2,420 | 28.900 ms | 189 | 0 | 0 |
| Hero B WebGL2 | 660 | 23.300 ms | 94 | 0 | 0 |
| Hero B WebGPU | 1,320 | 35.800 ms | 189 | 0 | 0 |
| Hero C WebGL2 | 258 | 30.500 ms | 54 | 0 | 0 |
| Hero C WebGPU | 516 | 38.400 ms | 105 | 0 | 0 |

Every compile, upload, and activation action is at or below 50 ms in this run;
all upload/activation maxima are at or below 0.3 ms. Compile action timing is
measured around the exact renderer-facing operation. The 500 ms initial
renderer settle and 4 ms post-action cooperative cooldown occur while the Host
is initializing and outside action timing; story time does not advance.

## Restart, disposal, and visual evidence

- Ten live restart generations end at programs 21, geometries 3, GPU owners 4,
  logical owners 4, and pool slots 4. The final-five heap spread is 507,212
  bytes against a 16 MiB regression limit.
- Ten complete runtime generations each terminate with GPU owners, logical
  owners, pool slots, backend-retained failure references, and runtime spikes
  at zero; telemetry is disposed.
- The twenty embedded Hero frames cover both backends and the story markers for
  ocean life/waterline, forest/waterfall/empty city, seven rectilinear human
  forms, three peripheral arcs, exactly three curved ribbon shells around an
  open void, living-Earth lights, and the formal title.
- Image, procedural-source, and asset checks remain engineering evidence only.
  Human public-use and rights approval remain pending.

## Review and release boundary

The accepted anchors remain shared Foundation implementation `3b57eeb` with
evidence `6e1ff9b`, and Hero R33 implementation `e1b101b` with evidence
`0c869ab`. This current candidate supersedes those scopes only after an
independent exact-pin source/artifact/visual review reports no blocking
S0/S1/S2 and a reviewed evidence commit is recorded.

Reference hardware remains `HARDWARE_PENDING`. Human play/visual, public-use
rights, R2-G7 `Merge` / `Partial Merge` / `Reject`, Main integration, Sites
deployment, and contest submission remain `HUMAN_PENDING` and are not implied
by any automated result above.
