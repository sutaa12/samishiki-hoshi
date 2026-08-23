# Rollback

Task ID: QX-R4-R00
Candidate source commit: 88b4ddf5f8d708cf73602549bfd5ed44efe85c45
Rollback commit: 0a63c462557aad29f947a88460b0380538782d53

## Trigger

Rollback if Research validation accepts missing source classes, unknown license, missing baseline SHA, missing rejected alternative, missing rollback, or a complete claim without numeric and human evidence; also rollback for gameplay hash or Production build drift.

## Instructions

Create a new revert commit for the QX-R4-R00 implementation or resume from `0a63c462557aad29f947a88460b0380538782d53`. Do not rewrite shared history. Re-run deterministic gameplay and build-output equality after rollback.

## Verification

- Expected gameplay hash: `1d537378`
- Expected source archive SHA-256: 29c6dafed74c63c7fb03bcd5099c88830cd52742770b983252c2d46e204024eb
- Expected Production build SHA-256: 03e23eeb422a8292503b43da33cdead2629be3be9774c3f351b865dba5303c25
- Expected Sites rollback version: version 2 remains the current public human-test candidate; R00 must not deploy a replacement.
