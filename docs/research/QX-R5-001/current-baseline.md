# Current baseline

Task ID: QX-R5-001
Source commit: 814e879557b26d71c7453bdde5a95caa81d9bb75
Captured at: 2026-08-23

## Fixed conditions

- URL or build: public R3 human-test candidate and the exact local QX-R3-006 source
- Device and OS: Apple host recorded by the QX-R3-006 browser report
- Viewport and DPR: 1920x1080 at the browser-test DPR
- Backend and quality: actual host-Metal WebGPU High and forced WebGL2
- Camera, time, and exposure: canonical QX-R3-006 12-second replay conditions
- Timestamped input trace: 25-entry QX-R3-006 replay ledger

## Evidence

- Screenshot: `.quality-gates/screenshots/qx-r3-006-moving-master-start.png`
- 12-second moving clip: `.quality-gates/qx-r3-006-moving-master-12s.webm`
- Resource waterfall: `.quality-gates/qx-r3-006-production-regression-o2.json`
- Frame timing and browser behavior: `.quality-gates/qx-r3-006-playwright-o2-accepted.json`
- CPU/GPU memory: existing production regression and lifecycle receipts; R4-R01 will establish new critical-path metrics
- Gameplay hash: `1d537378`
- Human raw findings: Notion page 16 rejects R3 for any start wait, oversized protagonist, input lag, unclear objective, or unclear Pulse causality; the old median score is not used.

QX-R5-001 changes only process files. Future Candidate captures must use the same conditions unless a condition itself is the single tested hypothesis.
