# R2-G6 rejected combined Foundation and Hero evidence

> **Artifact review rejected; superseded by the v2 evidence package.**
> Source review remained accepted, but the preserved dist tar contained 132
> undeclared macOS AppleDouble members. The raw archive inventory therefore
> differed across readers. No visual frame was reviewed before the mandatory
> S2 stop.
>
> This file remains as rejection history for evidence commit `4191d61`.

> This is the intentional resume point. It does not authorize Main integration,
> Sites deployment, reference-hardware acceptance, public-use rights, human
> play/visual acceptance, or contest submission.

## Exact identity

- Implementation: `bae6b717431bfea1d5a9b50fa61a6af07396a596`
- Tree: `631a910e98c1a741627167d071b4e0482ee3fe9e`
- Branch: `graphics-photoreal-megademo`
- Ordered 129-file manifest:
  `.quality-gates/r2-g6-current-bae6b71-files.sha256`
- Manifest SHA-256:
  `a58db45cacfc3b0d3fc1dfa8e35b541a53af6a1241928d6bdc14d62bdde786ef`
- Rebuilt source archive SHA-256:
  `c535a63c7e91e98413ee497e066b9b8cab9bae854434517c26655068016cb922`
- Source archive: 268,513,280 bytes, 336 entries, 292 regular files,
  44 directories, zero symlinks; embedded commit equals the implementation.

## Corrected scheduler boundary

The rejected `9688a1d` candidate allowed an asynchronous warm-up scheduler to
await, then call and await `host.dispose()`, while disposal awaited
initialization. The resulting initialization/disposal cycle could hang
bootstrap without terminal evidence.

The corrected implementation tracks each unsettled scheduler callback before
invocation. Every synchronous or post-yield disposal request in the same
unsettled window receives one stable retryable `INVALID_LIFECYCLE` Promise.
The latch clears at callback settlement, while terminal disposal retains its
own stable identity. Exact tests cover settle and yield callbacks, sync and
post-yield requests, rejection, never-settling callbacks, hostile Promises,
cleanup, retry, and identity.

Independent source review accepted the exact pin with S0/S1/S2 all zero.
Its focused lifecycle matrix passed 5 suites and 321 tests; the full run passed
37 files and 714 tests with typecheck, lint, and diff-check green and no drift.

## Build and automated gates

| Check | Exact result |
| --- | --- |
| Complete verify | Typecheck, global lint, 37/37 files, 714/714 tests, production build |
| Full Vitest | `.quality-gates/r2-g6-current-bae6b71-full-vitest.json`; SHA-256 `03fb5940c46c3ed2edbc5ef50ba387d84616702b0c1f785476aff4f988aa7839`; 80/80 suites, 714/714 tests |
| Focused Vitest | `.quality-gates/r2-g6-current-bae6b71-vitest.json`; SHA-256 `f4bd551681d9090a02275badd9ff0e35413c3d1da5a884180e420a07662274c9`; 9 requested files, 18/18 suites, 87/87 tests |
| Production audit | 0 vulnerabilities; SHA-256 `41e0957f81e8db3f722663db2e5f7c20bacfd3ceb9caba5820b350f3b86c18bd` |
| Preserved dist | `.quality-gates/r2-g6-current-bae6b71-dist.tar`; SHA-256 `8f84e74b0e838f6e62f759860d9b769cdf6c441f4f3da818e157a2d96efb02f9` |

The dist has 110 regular files and zero symlinks. Empty extraction reproduces
content-record digest
`916a28e95b0a60e8297930f763a87c705383f5428fe0a9cb022b2a220a7a782b`.
It contains BUILD_ID `cf48d846-b931-4dd6-af3a-5883e1d48aed`, three identical
JavaScript worker copies, and no raw TypeScript worker.

## Browser evidence

The exact desktop Chromium run passed all 8 tests in 200,636.226 ms with zero
retries, skips, flaky results, unexpected results, top-level errors, or result
error fields. The report SHA-256 is
`33d3e1dd7ff39efb47967546fb9c996e6c7d69de6abbf73b1b5024125aa24978`.
Its 30 embedded attachments comprise 10 JSON records and 20 strictly decoded,
hash-unique 1920x1080 PNG frames.

| Runtime | Compile steps | Maximum compile | Programs ready | Growth after ready |
| --- | ---: | ---: | ---: | ---: |
| Foundation WebGL2 | 88 | 34.000 ms | — | — |
| Foundation WebGPU | 176 | 42.600 ms | — | — |
| Hero A WebGL2 | 1210 | 43.400 ms | 91 | 0 |
| Hero A WebGPU | 2420 | 31.400 ms | 189 | 0 |
| Hero B WebGL2 | 660 | 34.000 ms | 94 | 0 |
| Hero B WebGPU | 1320 | 38.600 ms | 189 | 0 |
| Hero C WebGL2 | 258 | 32.100 ms | 54 | 0 |
| Hero C WebGPU | 516 | 38.300 ms | 105 | 0 |

Every compile, upload, and activation event is at or below 50 ms. The largest
upload event is 0.301 ms and the largest activation event is 0.100 ms.

Ten live restart generations end at programs 21, geometries 3, GPU owners 4,
logical owners 4, and pool slots 4. The final-five heap spread is 350,236 bytes
against a 16 MiB limit. Ten full runtime generations each terminate with every
tracked owner, pool slot, retained backend failure reference, and spike count at
zero; telemetry is disposed.

## Rejection boundary

The implementation is unchanged. The dist was repackaged with macOS metadata
disabled, and the corrected v2 evidence package must receive a fresh independent
exact-pin artifact binding audit plus blind review of all 20 visual frames.

Reference hardware remains `HARDWARE_PENDING`. Human play/visual acceptance,
public-use rights, the R2-G7 `Merge` / `Partial Merge` / `Reject` decision,
Main integration, Sites deployment, and contest submission remain
`HUMAN_PENDING`. No deployment is represented by this candidate.
