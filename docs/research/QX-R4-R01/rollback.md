# Rollback

Task ID: QX-R4-R01
Candidate source commit: documentation-only commit to be reverted if a trigger fires
Rollback commit: be0eb51661df90bc21bdb471a8a626078ff92ce3

## Trigger

Revert R01 if any third-party screenshot/video is committed, a human result is represented as passed without raw answers from two uninformed viewers, Production runtime/assets drift, or a digest no longer verifies.

## Instructions

Create a new revert commit for the R01 documentation/capture commit or restore the prior accepted branch. Do not rewrite shared history. Remove no external system state: R01 does not publish a Sites version. Re-run the baseline capture and deterministic checks after rollback.

## Verification

- Expected gameplay hash: `LIFE_11.05-11.42_6349ca8e-1f1a2cc7;EARTH_48.95-49.07_36cccfbf-a2b5274b;SOLITUDE_143.03_9997894d`
- Expected source archive SHA-256: b727c78ed8512b37abe6bbac45c588dcadcfddf182201b79f7b18d4db61e31da
- Expected Production build SHA-256: 7d97e3212ae92c724697587504e9cf160a1c5f28eac8152eeec4b9be748bfb0d
- Expected Sites rollback version, when applicable: prior public Sites version remains the explicit rollback boundary; R01 creates no deployment
