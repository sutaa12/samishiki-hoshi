# Rollback

Task ID: QX-R4-R00
Candidate source commit: pending until implementation commit
Rollback commit: 0a63c462557aad29f947a88460b0380538782d53

## Trigger

Rollback if Research validation accepts missing source classes, unknown license, missing baseline SHA, missing rejected alternative, missing rollback, or a complete claim without numeric and human evidence; also rollback for gameplay hash or Production build drift.

## Instructions

Create a new revert commit for the QX-R4-R00 implementation or resume from `0a63c462557aad29f947a88460b0380538782d53`. Do not rewrite shared history. Re-run deterministic gameplay and build-output equality after rollback.

## Verification

- Expected gameplay hash: `1d537378`
- Expected Production build archive SHA-256: `605e45b3a8f434f3f99446944dc3828712eec976c40f98fee3792a030b293257`
- Expected Sites rollback version: version 2 remains the current public human-test candidate; R00 must not deploy a replacement.
