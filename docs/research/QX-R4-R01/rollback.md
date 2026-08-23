# Rollback

Task ID: QX-R4-R01
Candidate source commit: documentation-only commit to be reverted if a trigger fires
Rollback commit: a091772372c0253098ebfb0efb11450c2acbba27

## Trigger

Revert R01 if any third-party screenshot/video is committed, a human result is represented as passed without raw answers from two uninformed viewers, Production runtime/assets drift, or a digest no longer verifies.

## Instructions

Create a new revert commit for the R01 documentation/capture commit or restore the prior accepted branch. Do not rewrite shared history. Remove no external system state: R01 does not publish a Sites version. Re-run the baseline capture and deterministic checks after rollback.

## Verification

- Expected gameplay hash: `LIFE=1f1a2cc7;EARTH=a2b5274b;SOLITUDE=b32248a0`
- Expected source archive SHA-256: a97889a7356150ee91d151f2e8de4cc4398b585cb00bc0465ac88281cb571a19
- Expected Production build SHA-256: 65809abff8795a21dc89e6743d5e5c4c1bcb2165eb34331fe4aed0dbfc2f7d77
- Expected Sites rollback version, when applicable: prior public Sites version remains the explicit rollback boundary; R01 creates no deployment
