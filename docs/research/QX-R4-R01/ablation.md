# Ablation and same-condition comparison

Task ID: QX-R4-R01
Source commit: a091772372c0253098ebfb0efb11450c2acbba27

| Candidate | Single changed hypothesis | Camera/input/device/viewport/exposure/backend/quality match | Load | Frame P50/P75/P95/P99 | Memory | Human free answer | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Current | none | Reference condition: Production camera, no input, macOS Chromium, 1920x1080 DPR1, exposure 1.0, WebGL2/high | Not instrumented | P95 LIFE 10.10ms; EARTH 9.90ms; SOLITUDE 10.00ms; other percentiles not exposed | Not exposed | Prior owner rejection is context only; R01 viewer answers pending | Baseline captured |
| R01 corpus | Documentation and evidence only | Exact same Production runtime; no visual candidate generated | Same runtime by construction | No candidate runtime; no performance claim | No candidate runtime | `HUMAN_PENDING` | Research-only; no Production ablation |

R01 deliberately does not infer motion or gameplay improvement from official screenshots. The moving baseline clip and fixed conditions are recorded so a later one-variable candidate can be compared honestly.
