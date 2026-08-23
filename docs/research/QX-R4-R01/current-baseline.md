# Current baseline

Task ID: QX-R4-R01
Source commit: a091772372c0253098ebfb0efb11450c2acbba27
Captured at: 2026-08-23T17:23:02+09:00

## Fixed conditions

- URL or build: committed source at `http://localhost:4174/`; harness rejects a dirty tracked tree or wrong source commit
- Device and OS: macOS desktop, Playwright Chromium 1.62.1
- Viewport and DPR: 1920x1080, DPR 1
- Backend and quality: requested/actual WebGL2, high, full motion, standard contrast, seed 20260818
- Camera, time, and exposure: Production camera; LIFE 10s/S03, EARTH 48s/S08, SOLITUDE 142s/S18; exposure 1.0
- Timestamped input trace: no steering or pulse input; automatic fixed-step progression after checkpoint setup

## Evidence

- Screenshots: `.quality-gates/QX-R4-R01/current-life-10s.png`, `current-earth-48s.png`, and `current-solitude-142s.png`
- 12-second moving clip: `.quality-gates/QX-R4-R01/current-earth-moving-12s.webm`, 72 project-owned frames at 6 fps, story time 48.93-60.93s
- Resource waterfall: not captured because R01 changes no network/runtime asset; clean-source stable Production manifest is `.quality-gates/QX-R4-R01/baseline-production-stable-assets.sha256`
- Frame timing P95: LIFE 10.10ms, EARTH 9.90ms, SOLITUDE 10.00ms; P50/P75/P99 and CPU/GPU memory were not exposed and are not inferred
- Gameplay hashes: LIFE `1f1a2cc7`, EARTH `a2b5274b`, SOLITUDE `b32248a0`
- Human raw findings: `baseline-human-findings.md`; R01-specific viewer answers remain pending

## Direct visual observations

- LIFE: the protagonist is near center, but large rectilinear forms compete with the route ring.
- EARTH: a flat green field and floating boxes do not expose a stable protagonist silhouette, vanishing point, route corridor, or goal landmark.
- SOLITUDE: a near-black field, one dominant rectangular mass, and one small pale object do not expose protagonist, route, or goal.

These are observations, not claims that a future candidate will improve play. Candidate captures must use the same conditions unless one condition is the explicit ablation variable.
