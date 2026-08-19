# Hero Slice C space/alien/Twinkle evidence

> **Current verdict: candidate frozen; independent review pending.** The exact
> implementation `69fe2e47c5269ccc407c95a6c6491fbbff1ceb8c` passes local
> verification and both real-browser Hero gates. This evidence does not accept
> R2-G5, reference-hardware performance, human visual quality, or any release.

## Bound identity

- Implementation commit: `69fe2e47c5269ccc407c95a6c6491fbbff1ceb8c`
- Implementation tree: `a34cb017c28f638e251e4c978881fd6806d4f1eb`
- Parent evidence commit: `ba69c882cbc61f5482c8030790bcdcca49580871`
- Ordered eight-file implementation manifest SHA-256:
  `aa37822e9818959acd4d305d7741fe758a822df6a858eb1b67109620bde3e2c1`
- Complete source archive SHA-256:
  `bad0fdf9399afdb474e7dd9f81f47cf7c2a0d549b29f77fecbdb31cd7c04fdc4`
- Complete source archive: 75,540,480 bytes; 264 entries; zero symlinks
- Preserved exact build: `.quality-gates/hero-c-69fe2e4-dist.tar`
- Build archive SHA-256:
  `9eddb1b93ad5998730a981bcdf05e90d1a54df816ec216d390e8ecab32567379`
- Build archive: 5,219,840 bytes; 99 regular files; zero symlinks
- Sorted build content-record digest:
  `9f8393d53669553bf5c48e0c00a1742b0eed5c654cb0be1b3cf7ba8e9e6b4a0c`
- Vinext BUILD_ID: `1a90dd05-1a36-4560-be80-0340c9d303dd`
- Focused Vitest JSON: `.quality-gates/hero-c-69fe2e4-vitest.json`, SHA-256
  `5240f859e4285537e997833336b168e6422eb5f5fa6046fe34f028f0b9800e0a`
- Playwright JSON: `.quality-gates/hero-c-69fe2e4-playwright.json`, SHA-256
  `2da130a841ad943b013a7461d2bf0853deff836d5574a5947076e0ef7cdbe70f`
- `package-lock.json` SHA-256:
  `6711ba750c0c2e1a3a50d20464a24e2cdd4bd1e7236516f9d69a85f0ff3391d8`

The archived build was extracted into an empty temporary directory and
reproduced the same 99-file content-record digest, BUILD_ID, and zero-symlink
inventory. Vinext rebuilds are not claimed to be byte-reproducible; the exact
tested output is preserved.

## Automated evidence exercised on 2026-08-20 JST

| Check | Result |
| --- | --- |
| Complete verification | `rtk npm run verify`: typecheck, global lint, 34/34 files and 613/613 tests, production build pass |
| Focused Hero C | 2/2 files and 10/10 assertions pass; failed, pending, and todo are zero |
| Real-browser Hero C | fresh-port forced-WebGL2 plus host-Metal WebGPU: 2/2 passed, retry 0, top-level/result errors 0 |
| Production dependency audit | `rtk npm audit --omit=dev --json`: 0 vulnerabilities |
| Visual attachments | nine embedded 1920×1080 PNGs: WebGL2 142s/158s/166s/176s/179s and WebGPU 142s/158s/166s/176s |

## Marker and lifecycle evidence

- Seed `20260818` retains canonical plan digest
  `world-plan-v1:75d93cbb8e0580cd`. The isolated exact replay has journey hash
  `09780631` and supplies three frozen ordered TwinkleSeed records without a
  production import of `src/game/simulation.ts`.
- At 142 seconds/S18, seven readable rectilinear human remnants are present:
  one solar panel, straight truss, habitat module, slab radiator, rectangular
  airlock, broken square observation frame, and empty box cockpit. The single
  amber beacon is visible at 142 seconds, gone at 143 seconds, and machinery is
  never reactivated.
- At 158 seconds/S20, only three faint incomplete peripheral arcs preview the
  unknown presence. At 160.999 seconds the full ship and center void remain
  absent; at exactly 161 seconds/S21 the arcs are replaced by exactly three
  thick closed cubic B-spline ribbon shells.
- Each alien shell uses parallel-transport frames, a constrained superformula
  cross-section, and thickness `0.1`. The minimum generated ship-vertex radius
  is greater than `1.5`, leaving a genuine open center. No cockpit, window,
  panel, thruster, front, or other human grammar is present.
- At 166 seconds the three-shell answer scene is visible. The fixed replay
  receives the ANSWER pulse at `166.400001` seconds. At 171.4/173/175/176
  seconds, High stages exactly one/eight/40/160 ledger-derived life lights; Low
  changes only the final visible density to 64 and restoring High restores 160.
  The source ledger remains frozen, ordered, and unchanged.
- At 176 seconds/S23, living Earth returns and the protagonist wings are open.
  At 179 seconds/S24, the only title overlay is the formal two-line Japanese
  `さみしき星の` / `またたきよ`.
- Both backend paths keep runtime compile events and post-ready program growth
  at zero. Geometry/material/texture/object ownership is unchanged across all
  marker transitions; `allocationsAfterInitialize` remains zero. The canonical
  chunk window converges to its desired inventory and never owns more than four
  GPU leases.
- Repeated/concurrent disposal removes the Hero scene root, restores the prior
  scene background and fog, and reports zero owned geometry, material, texture,
  and object counts.
- Built-in physical-material transmission remains zero under D-013. All Hero
  visuals are runtime procedural assets; no reference image is shipped as a
  background under D-003.

## Performance interpretation

The browser tests require a steady telemetry window, non-null frame P95,
main-thread P95 at or below 50 ms, no upload/activation event over 50 ms, and
zero runtime spikes. They are regression gates, not reference-device
acceptance. Forced-WebGL2 uses SwiftShader; the host-Metal WebGPU run is not the
designated reference machine and supplies no accepted GPU timestamp result.
Reference CPU/GPU performance therefore remains `HARDWARE_PENDING`.

## Visual interpretation and remaining gates

The bound frames establish the rectilinear-versus-curvilinear grammar split,
S20/S21 reveal boundary, three-shell/open-void silhouette, ledger-driven final
lights, formal title, and backend parity. They do not independently prove the
requested Cinematic Procedural Realism. Independent blind visual review must
still judge debris readability, nebula restraint, pearl/mineral material and
lighting realism, alien silhouette originality, open-center legibility,
Twinkle staging, backend parity, fallback quality, and temporal stability.
Human visual/play acceptance remains `HUMAN_PENDING` even if an AI review later
accepts the candidate.

GFX-004/GFX-005, GFX-006, and Hero A/B remain review-pending. Reference
hardware, human play and visual acceptance, rights acceptance, 180-second
combined parity/restart review, Main integration, Sites save/deployment, and
contest submission remain separate pending or frozen gates. The release branch
and public Sites version remain frozen until the Human Acceptance Owner
explicitly chooses `Merge`, `Partial Merge`, or `Reject` after all three Hero
Slices are reviewed.
