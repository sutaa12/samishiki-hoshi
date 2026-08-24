# Rollback

Task ID: QX-R5-002
Candidate source commit: a4965e4a172d48661d6685111e69a44c2b868637
Rollback commit: 814e879557b26d71c7453bdde5a95caa81d9bb75

## Trigger

Rollback for evidence digest drift, a five-frame still interval, Ring ratio below 4x, pass interval outside 500-1000ms, distance/render mismatch, comfort parity loss, or a live deployment fault.

## Instructions

Create a new revert commit or resume from bc3e9776da340bcb711db1a97ab2efe46a333668; do not rewrite shared history. Restore prior Sites version 3, then re-run the QX-R5-001 15-second replay.

## Verification

- Expected gameplay hash: `3699fab551ade24295887731234fd42e9e2d25116de9e80fc5c734be8d20cff3`
- Expected source archive SHA-256: 23a24d2e9653e109a4f1f30103ddf12dede64f1a09537b5c30bd473c49d01b96
- Expected Production build SHA-256: bd0ba727b4798f7415c2fb0c723ee585894c063708a6d4e226e94a10ff1a04f9
- Expected Sites rollback version: version 3 at /r5-minimum
