# Current baseline

Task ID: QX-R4-R01
Source commit: be0eb51661df90bc21bdb471a8a626078ff92ce3
Captured at: 2026-08-23T05:37:52.711Z (2026-08-23 14:37:52 JST)

## Fixed conditions

- Source binding: the harness verified clean HEAD `be0eb51661df90bc21bdb471a8a626078ff92ce3`, rejected any pre-existing server, and launched `npm run dev -- --host localhost --port 4174` from that worktree
- Device and toolchain: macOS desktop; Playwright 1.62.1; Chromium 151.0.7922.34; FFmpeg 8.1.2
- Viewport and DPR: 1920x1080, DPR 1
- Backend and quality: requested/actual WebGL2, high, full motion, standard contrast, seed 20260818
- Query checkpoints: LIFE `at=10`/S03, EARTH `at=48`/S08, SOLITUDE `at=142`/S18
- Screenshot bindings: LIFE: 11.05-11.42s; 6349ca8e->1f1a2cc7
- Screenshot bindings: EARTH: 48.95-49.07s; 36cccfbf->a2b5274b
- Screenshot bindings: SOLITUDE: 143.03-143.03s; 9997894d->9997894d
- Actual applied exposure: LIFE 1.05, EARTH 1.12, SOLITUDE 1.00
- Timestamped input trace: no steering or pulse input; automatic progression after checkpoint setup

The harness samples time/hash immediately before and after screenshot production. A screenshot is bound to that closed interval; no post-capture value is mislabeled as a pixel-atomic timestamp.

## Evidence

- Screenshots: `.quality-gates/QX-R4-R01/current-life-10s.png`, `current-earth-48s.png`, and `current-solitude-142s.png`
- 12-second moving clip: `.quality-gates/QX-R4-R01/current-earth-moving-12s.webm`, 72 project-owned frames at 6 fps, actual story time 49.00-60.88s
- Complete Production file manifest: `.quality-gates/QX-R4-R01/production-complete-files.sha256`, 106 files including runtime JavaScript, server output, CSS, and owned assets
- Frame timing P95: LIFE 10.10ms, EARTH 10.20ms, SOLITUDE 10.10ms; P50/P75/P99 and CPU/GPU memory were not exposed and are not inferred
- Human raw findings: `baseline-human-findings.md`; R01-specific viewer answers remain pending

## Direct visual observations

- LIFE: the protagonist is near center, but large rectilinear forms compete with the route ring.
- EARTH: a flat green field and floating boxes do not expose a stable protagonist silhouette, vanishing point, route corridor, or goal landmark.
- SOLITUDE: a near-black field, one dominant rectangular mass, and one small pale object do not expose protagonist, route, or goal.

These are observations, not claims that a future candidate will improve play. A later candidate must reproduce the conditions and record timing intervals rather than relabeling query `at` values as screenshot times.
