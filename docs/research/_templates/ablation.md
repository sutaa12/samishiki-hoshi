# Ablation and same-condition comparison

Task ID: {{TASK_ID}}
Source commit: {{SOURCE_COMMIT}}

| Candidate | Single changed hypothesis | Camera/input/device/viewport/exposure/backend/quality match | Load | Frame P50/P75/P95/P99 | Memory | Human free answer | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Current | none | reference condition | {{CURRENT_LOAD}} | {{CURRENT_FRAME}} | {{CURRENT_MEMORY}} | {{CURRENT_HUMAN}} | baseline |
| Candidate | {{SINGLE_HYPOTHESIS}} | {{CONDITION_MATCH}} | {{CANDIDATE_LOAD}} | {{CANDIDATE_FRAME}} | {{CANDIDATE_MEMORY}} | {{CANDIDATE_HUMAN}} | {{ABLATION_RESULT}} |

Do not infer motion or gameplay improvement from one screenshot. Attach a moving clip and input trace to `evidence.json`.
