# Human test

Task ID: {{TASK_ID}}
Candidate source commit: {{CANDIDATE_SOURCE_COMMIT}}
Current source commit: {{SOURCE_COMMIT}}
Blind labels: Current={{CURRENT_LABEL}}, Candidate={{CANDIDATE_LABEL}}

## Cohorts

- Experienced in 3D action or the comparable genre: {{EXPERIENCED_COUNT}}
- Regular game player without genre expertise: {{NOVICE_COUNT}}
- Low game experience, when available: {{LOW_EXPERIENCE_COUNT}}

## Binary questions

1. At 3 seconds, can the player point to the protagonist and direction of travel?
2. At 5 seconds, did input move the protagonist far enough in the intended direction?
3. At 8 seconds, can the player explain what to avoid and where to pass?
4. At 12 seconds, can the player explain what Pulse targets, when to use it, and what changed?
5. Can the player describe the task-specific improvement without being told the hypothesis?

## Raw answers

Status: pending

| Participant | Cohort | StartedAt | CompletedAt | Exact free-form answer | BinaryResult | TraceArtifact | TraceSHA256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| {{PARTICIPANT_LABEL}} | {{COHORT}} | {{STARTED_AT}} | {{COMPLETED_AT}} | {{FREE_ANSWER}} | {{PASS_OR_FAIL}} | {{TRACE_ARTIFACT}} | {{TRACE_SHA256}} |

Preserve participant label, cohort, timestamps, cursor/pointer trace, exact free-form answer, and binary result. Never replace a negative answer with an AI interpretation or an average score.

## Human owner decision

Owner: {{HUMAN_OWNER_ROLE}}
Decision: pending
Evidence: {{HUMAN_OWNER_EVIDENCE}}
Reason: {{HUMAN_DECISION_REASON}}
