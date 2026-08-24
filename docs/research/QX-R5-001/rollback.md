# Rollback

Task ID: QX-R5-001
Candidate source commit: 814e879557b26d71c7453bdde5a95caa81d9bb75
Rollback commit: 814e879557b26d71c7453bdde5a95caa81d9bb75

## Trigger

Rollback if Research validation accepts missing source classes, unknown license, missing baseline SHA, missing rejected alternative, missing rollback, or a complete claim without numeric and human evidence; also rollback for gameplay hash or Production build drift.

## Instructions

Create a new revert commit for the QX-R5-001 implementation or resume from `0a63c462557aad29f947a88460b0380538782d53`. Do not rewrite shared history. Re-run deterministic gameplay and build-output equality after rollback.

## Verification

- Expected gameplay hash: `3699fab551ade24295887731234fd42e9e2d25116de9e80fc5c734be8d20cff3`
- Expected source archive SHA-256: 23a24d2e9653e109a4f1f30103ddf12dede64f1a09537b5c30bd473c49d01b96
- Expected Production build SHA-256: 303f1b23420491d2ef83cbd3cc252cb022f4aa8ba6059b7fc4f256365f415d9e
- Expected Sites rollback version: version 2 remains the current public human-test candidate; R00 must not deploy a replacement.
