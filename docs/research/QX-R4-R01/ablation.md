# Ablation and same-condition comparison

Task ID: QX-R4-R01
Source commit: be0eb51661df90bc21bdb471a8a626078ff92ce3

| Candidate | Single changed hypothesis | Camera/input/device/viewport/exposure/backend/quality match | Load | Frame P50/P75/P95/P99 | Memory | Human free answer | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Current | none | Production camera, no input, macOS Chromium, 1920x1080 DPR1, WebGL2/high; exposure LIFE 1.05, EARTH 1.12, SOLITUDE 1.00 | Not instrumented | P95 LIFE 10.10ms; EARTH 10.20ms; SOLITUDE 10.10ms; other percentiles not exposed | Not exposed | Prior owner rejection is context only; R01 viewer answers pending | Baseline captured |
| R01 corpus | Documentation and evidence only | Exact same Production runtime; no visual candidate generated | Same runtime by construction | No candidate runtime; no performance claim | No candidate runtime | `HUMAN_PENDING` | Research-only; no Production ablation |

R01 deliberately does not infer motion or gameplay improvement from official screenshots. The moving baseline clip and fixed conditions are recorded so a later one-variable candidate can be compared honestly.

## Screenshot binding copied from the capture receipt

- LIFE: 11.05-11.42s; 6349ca8e->1f1a2cc7
- EARTH: 48.95-49.07s; 36cccfbf->a2b5274b
- SOLITUDE: 143.03-143.03s; 9997894d->9997894d

These closed intervals, rather than a single post-capture value, bind each screenshot to its story time and gameplay state. The validator compares this section and `current-baseline.md` against `current-capture-metrics.json`.
