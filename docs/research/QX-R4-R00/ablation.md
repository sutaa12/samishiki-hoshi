# Ablation and same-condition comparison

Task ID: QX-R4-R00
Source commit: 0a63c462557aad29f947a88460b0380538782d53

| Candidate | Single changed hypothesis | Camera/input/device/viewport/exposure/backend/quality match | Load | Frame P50/P75/P95/P99 | Memory | Human free answer | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Current | No executable Research Gate | Exact R3 baseline retained | Existing QX-R3-006 evidence | Existing QX-R3-006 evidence | Existing lifecycle receipts | R3 Human Reject remains open | baseline |
| Native Node gate | Missing evidence fails before implementation or completion | Runtime and capture conditions unchanged because no game source changes | No runtime dependency or client-asset drift | No frame-path source change; 9/9 selected Production checks passed | No runtime ownership-path change | Not applicable to a process-only task | selected; 800/800 unit/integration and 9/9 Production checks passed |
| Ajv gate | JSON schema dependency validates one artifact class | Runtime conditions unchanged | New development dependency | No frame-path change expected | CLI allocation only | No player-recognized benefit expected | rejected before integration |

The R00 decision is based on structural fail-closed tests and exact Production equality, not a screenshot or AI vision score.
