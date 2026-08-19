# Hero Slice A ocean evidence

> **Current verdict: candidate frozen; independent review pending.** The exact
> implementation `67dea2b1589c0e7f862cf76674b45b3cffbc04f1` passes local
> verification and both real-browser Hero gates. This evidence does not accept
> R2-G3, reference-hardware performance, human visual quality, or any release.

## Bound identity

- Implementation commit: `67dea2b1589c0e7f862cf76674b45b3cffbc04f1`
- Implementation tree: `1ed67a9ca783905034b7dbb496040b2f8416a8a1`
- Parent evidence commit: `f2a4dc0c840b875afbbf0f8c43c8c2be55572f8d`
- Ordered ten-file implementation manifest SHA-256:
  `94342b494c93fb9eed59e2cc40a594459ec0c21c235b0b5a1a42b220b5c25a31`
- Complete source archive SHA-256:
  `0c005f320a9333230857bb956f06f0909caec7d6b9f23db70f78c81a43256a1e`
- Complete source archive: 46,264,320 bytes; 236 entries; zero symlinks
- Preserved exact build: `.quality-gates/hero-a-67dea2b-dist.tar`
- Build archive SHA-256:
  `fdc4cc67f41249335d46f00f9d58fb061fad7def7b4ea2f934cc013e597b32c2`
- Build archive: 5,069,824 bytes; 89 regular files; zero symlinks
- Sorted build content-record digest:
  `2305e051e3744d9c094ebd89f6c4d7b25b17162b6ac296246d14b1f02e8e943b`
- Vinext BUILD_ID: `8ef869f9-4197-4232-97db-90ec00a4a25c`
- Focused Vitest JSON: `.quality-gates/hero-a-67dea2b-vitest.json`, SHA-256
  `0ae27b9647397c32f4066fbda3fef4b13e14ffaf83a3de9e535b669b0db548ad`
- Playwright JSON: `.quality-gates/hero-a-67dea2b-playwright.json`, SHA-256
  `09fe279d19de944679a9ae4a8a866b38740eb236230fe8cee1a97104eca290ce`
- `package-lock.json` SHA-256:
  `6711ba750c0c2e1a3a50d20464a24e2cdd4bd1e7236516f9d69a85f0ff3391d8`

The archived build was extracted into an empty temporary directory and
reproduced the same 89-file content-record digest, BUILD_ID, and zero-symlink
inventory. Vinext rebuilds are not claimed to be byte-reproducible; the exact
tested output is preserved.

## Automated evidence exercised on 2026-08-19/20 JST

| Check | Result |
| --- | --- |
| Complete verification | `rtk npm run verify`: typecheck, global lint, 32/32 files and 603/603 tests, production build pass |
| Focused Hero A | 2/2 files and 10/10 assertions pass; failed, pending, and todo are zero |
| Real-browser Hero A | fresh-port forced-WebGL2 plus host-Metal WebGPU: 2/2 passed, retry 0, top-level/result errors 0 |
| Production dependency audit | `rtk npm audit --omit=dev --json`: 0 vulnerabilities |
| Visual attachments | six embedded 1920×1080 PNGs: WebGL2 12s/27s/37s/Low and WebGPU 12s/27s |

## Marker and lifecycle evidence

- Seed `20260818` retains canonical plan digest
  `world-plan-v1:75d93cbb8e0580cd`.
- At 12 seconds/S03, human artifacts are absent; player, flow guide, pulse
  target, water surface, seabed, caustic texture, foam, coral, kelp, fish, and
  bubbles are present. High exposes 28 fish, 20 coral clusters, 18 kelp, and 36
  bubbles.
- The human-artifact boundary is exact: absent at 17.999 seconds and present at
  18 seconds. At 27 seconds/S05, the submerged rectilinear vehicle has five
  pale empty seats, seven window cells, and seven rails.
- At 37 seconds/S07, the camera crosses the waterline while the story model and
  preallocated ownership remain unchanged.
- Low fallback retains story/world identity and uses 16 fish, 13 coral
  clusters, 11 kelp, and 20 bubbles; restoring High restores the exact High
  inventory.
- Both backend paths keep runtime compile events and post-ready program growth
  at zero. Geometry/material/texture/object ownership is unchanged across the
  marker transitions; `allocationsAfterInitialize` remains zero.
- Repeated/concurrent disposal removes the Hero scene root, restores the prior
  scene background, and reports zero owned geometry, material, texture, and
  object counts.
- Built-in physical-material transmission remains zero, preserving D-013. All
  visuals are runtime procedural assets; no reference image is shipped as a
  background, preserving D-003.

## Performance interpretation

The browser tests require a steady telemetry window, non-null frame P95,
main-thread P95 at or below 50 ms, no upload/activation event over 50 ms, and
zero runtime spikes. They are regression gates, not reference-device
acceptance. Forced-WebGL2 uses SwiftShader; the host-Metal WebGPU run is not the
designated reference machine and supplies no accepted GPU timestamp result.
Reference CPU/GPU performance therefore remains `HARDWARE_PENDING`.

## Visual interpretation and remaining gates

The bound frames establish functional scene markers and backend parity. They
do not yet prove the requested Cinematic Procedural Realism. Independent blind
visual review must judge natural abundance, material and lighting realism,
composition, human-absence storytelling, silhouette readability, fallback
quality, and temporal stability. Human visual/play acceptance remains
`HUMAN_PENDING` even if an AI review accepts the candidate.

GFX-004/GFX-005 and GFX-006 remain review-pending. Hero Slices B and C,
reference hardware, human play and visual acceptance, rights acceptance, Main
integration, Sites save/deployment, and contest submission remain separate
pending or frozen gates. The release branch and public Sites version remain
frozen until the Human Acceptance Owner explicitly chooses `Merge`, `Partial
Merge`, or `Reject` after all three Hero Slices are reviewed.
