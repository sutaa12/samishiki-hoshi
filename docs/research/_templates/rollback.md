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
- Expected Production build digest: {{PRODUCTION_BUILD_DIGEST}}
- Expected Sites rollback version, when applicable: {{SITES_ROLLBACK_VERSION}}
