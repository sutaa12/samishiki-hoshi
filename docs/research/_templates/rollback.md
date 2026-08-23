# Rollback

Task ID: {{TASK_ID}}
Candidate source commit: {{CANDIDATE_SOURCE_COMMIT}}
Rollback commit: {{SOURCE_COMMIT}}

## Trigger

{{ROLLBACK_TRIGGER}}

## Instructions

Use a new revert commit or restore the prior accepted branch/Sites version. Do not rewrite shared history. Re-run the baseline and deterministic gameplay-hash checks after rollback.

## Verification

- Expected gameplay hash: {{GAMEPLAY_HASH}}
- Expected source archive SHA-256: {{ROLLBACK_SOURCE_SHA256}}
- Expected Production build SHA-256: {{ROLLBACK_BUILD_SHA256}}
- Expected Sites rollback version, when applicable: {{SITES_ROLLBACK_VERSION}}
