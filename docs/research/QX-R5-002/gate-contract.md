# QX-R5-002 gate contract

Status: implementation in progress. This contract was frozen before behavior
tuning on 2026-08-24.

## Subject and rollback

- Subject route: `/r5-minimum` on branch `codex/qx-r5-002-conveyor-rail`.
- Baseline: QX-R5-001 accepted runtime `814e879557b26d71c7453bdde5a95caa81d9bb75`.
- Public rollback: Sites v3 and Git commit `bc3e977`.
- Production v2, the 180-second journey, `main`, and external gate states are
  outside this implementation slice.

## Locked pass thresholds

| Gate | Sample | Pass threshold | Rollback threshold |
|---|---:|---|---|
| Near optical flow | native 25fps, full 15 seconds | median tracked Near-marker motion is greater than 0px on at least 90% of comparable frames | below 90% |
| Still-frame rejection | native 25fps, full 15 seconds | no five-frame run has every adjacent changed-pixel ratio below 0.2% | any violating run |
| Ring approach | every fixed simulation frame before first contact | projected bounding-box area is non-decreasing and final/start area is at least 4.0× within at most 2.5 seconds | decrease beyond pixel rounding tolerance, ratio below 4.0×, or duration above 2.5 seconds |
| Near-marker cadence | all rail crossings in 15 seconds | median and every interior interval are 500–1,000ms | any interior interval outside the range |
| Far landmark | every fixed simulation frame | remains visible and within 12% of viewport diagonal from the vanishing point | missing frame or larger deviation |
| Encounter exit | Ring, Obstacle, Node | after crossing the Player plane, each continues toward and exits the viewport/camera side | any encounter remains visibly parked after contact |
| Distance binding | every fixed simulation frame | render Z is reproduced from `anchorDistanceMm - state.distanceMm` and the shared rail scale | any mismatch above 1e-9 world units |
| FOV selection | 55°, 62°, 70° candidates | deterministic scorer selects one value in 55–70° and records every candidate | missing or out-of-range selection |
| 2× speed ablation | same candidate video at 2× | never used as the accepted candidate; reject if encounter telegraph/readability thresholds fail | accepted build depends on speed doubling |
| Reduced Motion | native 25fps, full 15 seconds | conveyor travel and the Near optical-flow threshold remain; decorative rotation is suppressed | forward travel disappears or flow drops below 90% |

## Required evidence

- Baseline and candidate 15-second video.
- Optical-flow motion-vector heatmap and numeric Near-marker flow series.
- Frame-difference strip and per-frame changed-pixel ratios.
- Ring area curve, Near-marker pass intervals, and distance-to-render-Z table.
- Standard / Reduced Motion comparison and 2× speed ablation decision.
- Exact source archive SHA-256, build-manifest SHA-256, capture SHA-256, commands,
  exit codes, independent artifact-only review, limitations, and rollback.

AI/local acceptance cannot advance Human, Legal, Main integration, final release,
or contest-submission gates.
