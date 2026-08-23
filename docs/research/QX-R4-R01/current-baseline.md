# Current baseline

Task ID: QX-R4-R01
Source commit: 1323ade4c4c9197609f88593dbf6510b7c088f9b
Captured at: 2026-08-23T05:13:05.988Z (2026-08-23 14:13:05 JST)

## Fixed conditions

- Source binding: the harness verified clean HEAD `1323ade4c4c9197609f88593dbf6510b7c088f9b`, rejected any pre-existing server, and launched `npm run dev -- --host localhost --port 4174` from that worktree
- Device and toolchain: macOS desktop; Playwright 1.62.1; Chromium 151.0.7922.34; FFmpeg 8.1.2
- Viewport and DPR: 1920x1080, DPR 1
- Backend and quality: requested/actual WebGL2, high, full motion, standard contrast, seed 20260818
- Query checkpoints: LIFE `at=10`/S03, EARTH `at=48`/S08, SOLITUDE `at=142`/S18
- Actual screenshot story times: LIFE 11.43s, EARTH 49.10s, SOLITUDE 143.08s after the explicit one-second renderer-settle wait
- Actual applied exposure: LIFE 1.05, EARTH 1.12, SOLITUDE 1.00
- Timestamped input trace: no steering or pulse input; automatic progression after checkpoint setup

## Evidence

- Screenshots: `.quality-gates/QX-R4-R01/current-life-10s.png`, `current-earth-48s.png`, and `current-solitude-142s.png`
- 12-second moving clip: `.quality-gates/QX-R4-R01/current-earth-moving-12s.webm`, 72 project-owned frames at 6 fps, actual story time 49.03-60.90s
- Complete Production file manifest: `.quality-gates/QX-R4-R01/production-complete-files.sha256`, 106 files including runtime JavaScript, server output, CSS, and owned assets
- Frame timing P95: LIFE 9.90ms, EARTH 10.20ms, SOLITUDE 9.90ms; P50/P75/P99 and CPU/GPU memory were not exposed and are not inferred
- Gameplay hashes at actual screenshot times: LIFE `e3f6eb11`, EARTH `705b4853`, SOLITUDE `b32248a0`
- Human raw findings: `baseline-human-findings.md`; R01-specific viewer answers remain pending

## Direct visual observations

- LIFE: the protagonist is near center, but large rectilinear forms compete with the route ring.
- EARTH: a flat green field and floating boxes do not expose a stable protagonist silhouette, vanishing point, route corridor, or goal landmark.
- SOLITUDE: a near-black field, one dominant rectangular mass, and one small pale object do not expose protagonist, route, or goal.

These are observations, not claims that a future candidate will improve play. A later candidate must reproduce the actual conditions above and record any timing drift; query `at` values are not mislabeled as screenshot story times.
