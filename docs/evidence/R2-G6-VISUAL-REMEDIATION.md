# R2-G6 visual-remediation parity, restart, and release-boundary evidence

> **Current verdict: candidate frozen; independent review pending.** The exact
> implementation `b84a267ad6cb174af30ef11b6055889f6180e519` passes the local
> parity, 1,000-seed, three-Hero, restart, browser, build, provenance, and
> runtime-license gates below. This evidence does not accept R2-G3 through
> R2-G7, Cinematic Procedural Realism, reference hardware, public rights,
> human play/visual quality, Main integration, Sites deployment, or submission.

## Bound identity

- Implementation commit: `b84a267ad6cb174af30ef11b6055889f6180e519`
- Implementation tree: `9600aec0c9edbcff211a092bed34fb2231047dbe`
- Prior combined evidence commit: `2b0f4db40a668dfae428a886d4c118781599dea5`
- Hero A visual remediation: `8ca6e9a23930184454c1653131c637c5e1795f1c`
- Hero B visual remediation: `de559f8a60a9d838bd428ca8e604a6ee94efd4f7`
- Hero C visual remediation: `1d097899f08a74cfd649b91f48dc7ea1b20a43ef`
- Ordered 11-file remediation/provenance manifest SHA-256:
  `3600ea30d111013892a0417adfc3e9f16966ed7d631315e309379eaeee1082f9`
- Complete Git source archive SHA-256:
  `0ecd3258f54a73f113e057d9b28ceed988675041adbddc32a05d8e6609fadfab`
- Source archive: 123,043,840 bytes; 282 entries; zero symlinks; embedded
  commit `b84a267ad6cb174af30ef11b6055889f6180e519`
- Preserved tested build: `.quality-gates/r2-g6-b84a267-dist.tar`
- Build archive SHA-256:
  `f6eaff660192ebbbbde507b43aa10557b44978c46e0c21fdd622e528a0a71c35`
- Build archive: 5,246,976 bytes; 100 regular files; zero symlinks
- Sorted build content-record digest:
  `46405d4a1eecd911542e03558194c12f94f1ffe5b3819d42682ec07fb4fad28e`
- Vinext BUILD_ID: `476500e3-ee38-46da-9595-f2b67a372121`
- Focused Vitest JSON: `.quality-gates/r2-g6-b84a267-vitest.json`, SHA-256
  `0eef71dd3e7b00acda6e51ad2fc1e615042d8e3efe0a9cfa23090e58419365b3`
- Combined Playwright JSON: `.quality-gates/r2-g6-b84a267-playwright.json`,
  SHA-256
  `8e0a3a531fea072ce60c4217ce1e7ed969a6e2785148376e5c565e3eb0d88fa8`
- Production audit JSON: `.quality-gates/r2-g6-b84a267-npm-audit.json`,
  SHA-256
  `41e0957f81e8db3f722663db2e5f7c20bacfd3ceb9caba5820b350f3b86c18bd`
- Artifact manifest: `.quality-gates/r2-g6-b84a267-artifact.json`, SHA-256
  `770ad3382fa6a758dc18a0d6ef38dd9a99a58bb1c743de1745549920568ab763`
- `package-lock.json` SHA-256:
  `6711ba750c0c2e1a3a50d20464a24e2cdd4bd1e7236516f9d69a85f0ff3391d8`

The archived build was extracted into an empty directory and reproduced the
same 100-file content-record digest, BUILD_ID, runtime notice, compiled Worker
hash, and zero-symlink inventory. Vinext rebuilds are not claimed to be byte
reproducible; the exact tested output is preserved.

## Automated evidence exercised on 2026-08-20 JST

| Check | Result |
| --- | --- |
| Complete verification | `rtk npm run verify`: typecheck, global lint, 36/36 files and 620/620 tests, production build pass |
| Focused R2-G6 oracle | 8 requested files and 57/57 assertions pass; failed, pending, and todo are zero |
| Combined real browser | Foundation plus Hero A/B/C, forced-WebGL2 plus host-Metal WebGPU: 8/8 passed, retry 0, top-level/result errors 0 |
| Production dependency audit | `rtk npm audit --omit=dev --json`: 0 vulnerabilities |
| Browser attachments | four bound telemetry/lifecycle JSON records and twenty embedded 1920×1080 PNGs |

## Visual remediation without simulation drift

- Hero A replaces repeated primitive reef silhouettes with preallocated tapered
  coral, kelp blades, fish detail, organic rocks, and textured floor caustics.
- Hero B adds layered crowns, branch silhouettes, grass tufts, flying birds,
  clustered clouds, a vertex-colored sunset dome, and richer living-surface
  material response while preserving the rectilinear empty city.
- Hero C adds a deterministic depth starfield, layered nebula lobe/halo fields,
  higher-resolution iridescent three-shell ribbons, a procedurally colored
  living Earth, and a deformed protagonist. S20 remains exactly three incomplete
  peripheral arcs; S21 remains three closed curvilinear shells around an open
  central void.
- Added decorative variation is seed-derived and presentation-owned. The
  canonical world plan, 180-second story, phase boundaries, frozen replay,
  Twinkle ledger, chunk ownership, and runtime light/program topology do not
  change.
- One integration oracle runs Hero A, B, and C sequentially through one scene.
  High → Balanced → Low → High remains visual-only; story and ledger inputs do
  not mutate; scene children/background/fog restore by identity; every Hero
  geometry, material, and texture owner returns to zero.

## Restart, browser, and performance evidence

- The forced-WebGL2 ten-restart plateau keeps programs `22`, geometries `3`,
  GPU owners `4`, logical owners `4`, and pool slots `4` on every cycle.
  Forced-GC heap use ranges from 18,352,632 to 19,630,968 bytes, a 1,278,336-byte
  spread. This is a browser-lab regression result, not reference-device memory
  acceptance.
- Ten complete construction/render/disposal generations each end with GPU
  owners, logical owners, pool slots, and retained backend failure references
  at zero; telemetry is disposed and records no runtime spike over 50 ms.
- The forced-WebGL2 steady window has 139 samples, RAF interval P95 42.0 ms,
  main-thread-work P95 0.70 ms, and no runtime spike. SwiftShader performance is
  not a frame-rate acceptance result.
- The host-Metal WebGPU window has 239 samples, RAF interval P95 8.5 ms,
  main-thread-work P95 0.60 ms, and no runtime spike. GPU timestamp support is
  absent and this host is not the designated reference machine.
- All six Hero backend cases retain post-ready program growth `0`, runtime
  compile events `0`, post-initialize Hero allocations `0`, and terminal Hero
  ownership `0`.

## Runtime license and provenance boundary

- The non-dev browser package closure remains React `19.2.6`, React DOM
  `19.2.6`, Scheduler `0.27.0`, and Three.js `0.185.1`; each declares MIT.
- `dist/client/THIRD_PARTY_NOTICES.txt` is byte-identical to the repository
  notice, SHA-256
  `db77168a3a9106f127514a3eff4c59c99872885a85b8baea3ca2c0eaa14fb8ac`.
- `DEMO_SOURCE_PROVENANCE.csv` now binds the current Hero A/B/C remediation
  commits. Production source does not import the Notion reference boards,
  remote models/textures/fonts, recordings, demo shaders, or runtime AI.
- These checks establish engineering inventory only. Final public-use and
  contest-rights attestation remains `HUMAN_PENDING`.

## Interpretation and remaining gates

This run establishes a fresh exact candidate after all three visual
remediations. It confirms deterministic/backend parity, bounded canonical
generation, three-Hero lifecycle isolation, restart/resource plateaus, terminal
cleanup, compiled Worker packaging, runtime notices, and live route health on
the tested host. It does not independently establish visual acceptance,
reference-hardware performance, legal acceptance, or human play acceptance.

Earlier Hero and R2-G6 receipts remain accurate historical evidence only for
their older source commits. The new receipt remains `review_pending` until a
frozen full-scope source/artifact review and blind visual review report no
blocking S0/S1/S2. Main integration, Sites save/deployment, and contest
submission remain frozen or pending until the Human Acceptance Owner explicitly
chooses `Merge`, `Partial Merge`, or `Reject`.
