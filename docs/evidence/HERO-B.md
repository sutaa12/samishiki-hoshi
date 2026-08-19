# Hero Slice B sunset forest/city evidence

> **Current verdict: candidate frozen; independent review pending.** The exact
> implementation `2fb5cade0c5e8df8b3e889a14a57867c8e0440ba` passes local
> verification and both real-browser Hero gates. This evidence does not accept
> R2-G4, reference-hardware performance, human visual quality, or any release.

## Bound identity

- Implementation commit: `2fb5cade0c5e8df8b3e889a14a57867c8e0440ba`
- Implementation tree: `a213bd89ecccae584a24b02ef95ccc62971f5d7a`
- Parent evidence commit: `ef3b157a8c3f4b2939de82dfe71c1ac9ebc55051`
- Ordered eight-file implementation manifest SHA-256:
  `f49b92e4a9ba693887b54c2f613484c80a856db18d01d29d22fcd499c62985a1`
- Complete source archive SHA-256:
  `99c4e597ef273d157502037e1a2d7778bb48e60c09f1767e5ac11fdd2eb057e1`
- Complete source archive: 61,143,040 bytes; 250 entries; zero symlinks
- Preserved exact build: `.quality-gates/hero-b-2fb5cad-dist.tar`
- Build archive SHA-256:
  `14d25df13f65b75dbab1d283c5bd195617a5bc19684ae92d61a871d1d7545053`
- Build archive: 5,145,600 bytes; 94 regular files; zero symlinks
- Sorted build content-record digest:
  `a1f50aaf8c0a0aa15d653e0e18f6061fc5022c222a99c2332c91d1d3a6d0843b`
- Vinext BUILD_ID: `dd575ac6-2ea2-47db-a73b-8a5f84b1490c`
- Focused Vitest JSON: `.quality-gates/hero-b-2fb5cad-vitest.json`, SHA-256
  `d5a66b514a78be1d4338ccbfb1d2d393e17df0862c8be0ae6b490e3a50945ef4`
- Playwright JSON: `.quality-gates/hero-b-2fb5cad-playwright.json`, SHA-256
  `1f1427b66b6ed7fd0c63846368de8d8209e2652f663fe4a394191476e5dd3f9b`
- `package-lock.json` SHA-256:
  `6711ba750c0c2e1a3a50d20464a24e2cdd4bd1e7236516f9d69a85f0ff3391d8`

The archived build was extracted into an empty temporary directory and
reproduced the same 94-file content-record digest, BUILD_ID, and zero-symlink
inventory. Vinext rebuilds are not claimed to be byte-reproducible; the exact
tested output is preserved.

## Automated evidence exercised on 2026-08-20 JST

| Check | Result |
| --- | --- |
| Complete verification | `rtk npm run verify`: typecheck, global lint, 33/33 files and 608/608 tests, production build pass |
| Focused Hero B | 2/2 files and 10/10 assertions pass; failed, pending, and todo are zero |
| Real-browser Hero B | fresh-port forced-WebGL2 plus host-Metal WebGPU: 2/2 passed, retry 0, top-level/result errors 0 |
| Production dependency audit | `rtk npm audit --omit=dev --json`: 0 vulnerabilities |
| Visual attachments | five embedded 1920×1080 PNGs: WebGL2 58s/75s/Low and WebGPU 58s/75s |

## Marker and lifecycle evidence

- Seed `20260818` retains canonical plan digest
  `world-plan-v1:75d93cbb8e0580cd`.
- At 58 seconds/S09, the connected river, waterfall, mist, forest, flowers,
  birds, living pulse target, protagonist, and safe flow corridor are visible
  while every city ruin remains hidden. High exposes 48 trees, 72 grass
  clusters, 36 flowers, 22 birds, 20 mist clusters, and 12 clouds.
- The city boundary is exact: absent at 61.999 seconds and present at 62
  seconds/S10. At 75 seconds/S11, nature remains dominant around eight
  rectilinear ruin towers, 36 floor slabs, 32 column-grid segments, 48 facade
  cells, three empty bench seats, the wind-moved playground, and one giant
  square observation frame.
- Eight rooftop trees and eight window birds make continued life explicit
  without adding humans, narration, corpses, or an extinction explanation.
  The river corridor and story sightline remain clear.
- Low fallback retains story/world identity and uses 24 trees, 28 grass
  clusters, 14 flowers, 10 birds, eight mist clusters, and six clouds;
  restoring High restores the exact High inventory.
- Both backend paths keep runtime compile events and post-ready program growth
  at zero. Geometry/material/texture/object ownership is unchanged across the
  marker transitions; `allocationsAfterInitialize` remains zero.
- Repeated/concurrent disposal removes the Hero scene root, restores the prior
  scene background, and reports zero owned geometry, material, texture, and
  object counts.
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

The bound frames establish the nature-first composition, connected water,
empty rectilinear city vocabulary, fixed markers, and backend parity. The
implementation self-review also checked the two-line heading, visible safe
corridor, attached rooftop planting, window birds, and separated square
observation-frame silhouette. It does not independently prove the requested
Cinematic Procedural Realism.

Independent blind source, artifact, and visual review must still judge material
and lighting realism, natural abundance, ruin scale, human-absence
storytelling, backend parity, fallback quality, and temporal stability. Human
visual/play acceptance remains `HUMAN_PENDING` even if an AI review later
accepts the candidate.

GFX-004/GFX-005, GFX-006, Hero A, and this Hero B candidate remain
review-pending. Hero Slice C, reference hardware, human play and visual
acceptance, rights acceptance, Main integration, Sites save/deployment, and
contest submission remain separate pending or frozen gates. The release branch
and public Sites version remain frozen until the Human Acceptance Owner
explicitly chooses `Merge`, `Partial Merge`, or `Reject` after all three Hero
Slices are reviewed.
