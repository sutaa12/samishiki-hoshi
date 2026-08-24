# Current baseline

Task ID: QX-R5-002
Source commit: 814e879557b26d71c7453bdde5a95caa81d9bb75
Captured at: 2026-08-24

## Fixed conditions

- Route: /r5-minimum
- Viewport: 1920x1080
- Duration/rate: 15 seconds at native 25 fps
- Timestamped input: QX-R5-001 accepted replay
- Baseline video SHA-256: d20f427dec59d9fcc10acf507d39320c5a236ee6b5bb39cb426015f8ad82385e

## Evidence

- Video: .quality-gates/QX-R5-001/candidate-video-1920x1080.webm
- Screenshot: .quality-gates/QX-R5-001/screenshots/desktop-1920x1080-complete.png
- Metrics: .quality-gates/QX-R5-001/metrics.json
- Observed baseline failure: longest <0.2% frame-difference run is 33 frames, including a 33-frame trailing interval.
- Candidate comparison: same route, viewport, duration, encounter order, and final 3/3 result.
