# R2-G6 frozen review brief

Review exact implementation commit
`cbbd4e5e0824846c1172c60fa24476ae973de8ca` and the evidence commit that adds
this brief. Stop on the first reproducible S0, S1, or S2. Do not edit, rebuild
over preserved artifacts, or collapse browser-lab, reference-hardware, visual,
rights, human-play, Main, Sites, and submission gates.

## Reproduce the bindings

1. Verify the six implementation file hashes and sorted manifest in
   `.quality-gates/r2-g6-cbbd4e5-artifact.json`.
2. Reproduce `git archive` for the implementation commit: SHA-256
   `1e75703d0233ae8982adf609219c73cb42b46e8e35ce70483d38b17f7251985b`,
   89,845,760 bytes, 274 entries, zero symlinks, embedded commit `cbbd4e5`.
3. Extract `.quality-gates/r2-g6-cbbd4e5-dist.tar` into an empty directory and
   verify archive SHA-256
   `08def5b7e01ad50a1431cead2767003d044c12638b65778d49eccc1d132c9726`,
   100 files, zero symlinks, content-record digest
   `c65dee41fdf5f41d369c448fed7d253dba78cb677a33ed8748fab4266aedaf53`,
   BUILD_ID `ed723687-abcb-4f10-95db-d83872b9b3b2`, the exact runtime notice,
   and compiled-JS-only Worker outputs.
4. Verify the focused Vitest JSON is 8 requested files / 54 assertions with no
   failed, pending, or todo tests.
5. Verify the Playwright JSON is 8/8 passed, retry 0, error fields 0, and has
   four JSON plus twenty 1920×1080 PNG attachments matching the artifact.
6. Verify the production npm audit report has zero vulnerabilities.

## Functional attack surfaces

- Exactly 180 seconds, seed `20260818`, canonical digest
  `world-plan-v1:75d93cbb8e0580cd`, quality/backend-invariant replay, detached
  renderer containers, and 1,000-seed canonical world-plan properties.
- A/B/C sequentially share one scene without story/ledger mutation, cross-slice
  scene membership, replaced background/fog identity, or retained Hero resource.
- All existing exact Hero marker and reveal-boundary contracts remain intact;
  High/Balanced/Low affect realization only.
- Ten live-runtime restarts keep exact program/geometry/GPU/logical/pool
  plateaus. Ten complete runtime generations end at zero ownership, zero retained
  backend failure references, disposed telemetry, and no over-50-ms runtime
  spike.
- No post-ready compilation, post-initialize Hero allocation, stale chunk
  activation, pending upload, orphan lease/job, or lifecycle identity drift.
- Runtime notice and lockfile must describe the complete four-package MIT
  browser closure. Hero provenance pins must be exact, and production sources
  must not import reference-gallery assets.
- Treat SwiftShader and this host's Metal WebGPU measurements as regression
  evidence only. GPU timestamps are unsupported and reference hardware remains
  `HARDWARE_PENDING`.

## Visual and release review

Use the twenty embedded frames to compare the same Hero markers between
forced-WebGL2 and host-Metal WebGPU. Judge backend parity, fallback readability,
cinematic realism, composition, material/light quality, temporal stability,
human-versus-alien grammar, and the three-Hero journey as one experience. A
functional test pass is not sufficient visual acceptance.

Return exact start/end hashes, drift status, commands, artifact statistics,
visual scores, and `ACCEPT` or `REJECT` with S0/S1/S2/S3 counts. Acceptance may
apply only to R2-G6 and must not silently accept the still-review-pending
underlying gates or any human/external gate.
