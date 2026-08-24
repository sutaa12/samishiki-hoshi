# Research Card

Task ID: QX-R5-002
Owner agent: Codex Orchestrator
Date: 2026-08-24
Source commit: a4965e4a172d48661d6685111e69a44c2b868637
Candidate branch/worktree: codex/qx-r5-002-conveyor-rail
Scale: standard

## Player-facing failure

The QX-R5-001 minimum game can look almost still during target-free intervals because world decoration is not governed by one actual-distance rail. A first-time player may lose the read of uninterrupted forward travel.

## Questions

- Can every render and encounter transform be derived from distanceMm while collision uses the same crossing boundary?
- Can Near objects pass every 0.5-1.0 seconds, Ring area grow at least 4x, and Reduced Motion retain the same forward-flow contract?

## Current baseline

The digest-bound QX-R5-001 15-second video has a 33-frame low-difference tail and no explicit measured Near/Mid/Far rail. See current-baseline.md.

## External evidence

See references.csv. Comparable observations remain URL-only and are used for testable depth/landmark hypotheses, not copied assets.

## Similar games

See comparable-games.csv and frame-analysis.csv. Journey supports a stable far landmark hypothesis; ABZU supports layered organic flow; Rez supports readable forward depth while objects remain identifiable.

## GitHub candidates

See library-scorecard.md. Native Three.js plus a small ConveyorRail was selected; no new runtime dependency was justified.

## Options

- A: distance-bound ConveyorRail and three explicit depth layers.
- B: 2x speed playback.
- C: camera sway and roll.

## Chosen option

Choose A. FOV 62 won the frozen 55/62/70 deterministic readability-flow score. Speed and camera motion remain rejected ablations.

Budget: zero new dependency; preserve fixed-step determinism and 15-second results.

Fallback: prior public QX-R5-001 Sites version 3 and commit bc3e9776da340bcb711db1a97ab2efe46a333668.

Rollback: bc3e9776da340bcb711db1a97ab2efe46a333668

## Acceptance

### Numeric hard gates

Near flow >=90%; no five-frame <0.2% difference run; Ring >=4x with no drops; passes 500-1000ms; far stays near the vanishing point; distance/Z error 0; encounters exit after the player plane.

### Human binary question

Can a first-time player say that the world continuously comes toward them? This remains HUMAN_PENDING and is not used for AI Binary acceptance.

## Gate status

Research, implementation, automation, and AI Binary: passed. Human, legal, Main, final release, and contest: pending.
