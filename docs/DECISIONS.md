# Decisions and rollback thresholds

## D-001 — Separate deterministic state from rendering

The story clock, phase selection, 24-shot index, input ledger, and final hash are pure TypeScript. Three.js consumes snapshots and cannot write story state. This makes quality settings visual-only and gives exact cross-tier replay checks.

## D-002 — A single continuous WebGL scene

The journey uses one renderer and morphs palettes, procedural fields, camera, and symbolic geometry between phases. A DOM shell owns instructions, settings, progress, accessibility status, and recovery if WebGL is unavailable.

## D-003 — Procedural-first asset policy

Geometry, particles, nature forms, human ruins, the unknown ship, and audio are generated locally in code. The only bitmap planned for release is a generated social preview image. This keeps runtime self-contained and rights review tractable.

## D-004 — Test-only acceleration

Production defaults to real-time 180 seconds. The `qa=1` query unlocks an accelerated clock only on localhost for deterministic browser verification. It does not alter phase boundaries, seed generation, scoring, or release UI and is unavailable on the public host.

## Rollback

- Any open S0/S1/S2 finding blocks promotion.
- A failed deterministic replay, broken input modality, runtime exception, inaccessible settings, unavailable anonymous URL, or missing end state rolls back to the last accepted Git commit and Sites version.
- Performance measurements are hardware-specific. Failure to meet the target on reference hardware is reported as an external performance gate, never silently waived.
- A later source change invalidates all evidence bound to the old source/build hashes and requires reacceptance.
