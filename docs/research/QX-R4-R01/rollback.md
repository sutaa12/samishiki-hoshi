# Rollback

Task ID: QX-R4-R01
Candidate source commit: documentation-only commit to be reverted if a trigger fires
Rollback commit: 1323ade4c4c9197609f88593dbf6510b7c088f9b

## Trigger

Revert R01 if any third-party screenshot/video is committed, a human result is represented as passed without raw answers from two uninformed viewers, Production runtime/assets drift, or a digest no longer verifies.

## Instructions

Create a new revert commit for the R01 documentation/capture commit or restore the prior accepted branch. Do not rewrite shared history. Remove no external system state: R01 does not publish a Sites version. Re-run the baseline capture and deterministic checks after rollback.

## Verification

- Expected gameplay hash: `LIFE@11.43=e3f6eb11;EARTH@49.10=705b4853;SOLITUDE@143.08=b32248a0`
- Expected source archive SHA-256: 7b89aef037af74af47e0af20121ae7ef04e7d41cf3b37941d656d390c032f397
- Expected Production build SHA-256: 56cad6377aa570f785580998e42c27db8ff57880c796b96df52329197d841a5c
- Expected Sites rollback version, when applicable: prior public Sites version remains the explicit rollback boundary; R01 creates no deployment
