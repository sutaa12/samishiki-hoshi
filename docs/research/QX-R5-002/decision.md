# Decision

Task ID: QX-R5-002
Source commit: a4965e4a172d48661d6685111e69a44c2b868637

## Options considered

| Option | Evidence for | Evidence against | Cost | Fallback | Decision |
| --- | --- | --- | --- | --- | --- |
| Distance-bound ConveyorRail | One state drives render Z and encounter crossings; measured flow passes | Adds a small explicit rail abstraction | No new dependency | Revert runtime commit | Adopt |
| 2x playback | More screen change per second | 7.52s sequence violates 15s and compresses contacts | Identification loss | 1200mm/s rail | Reject |
| Camera sway/roll | Adds visible motion | Does not prove translation and weakens comfort parity | Comfort risk | Fixed camera | Reject |

## Chosen option

Decision: Adopt the actual-distance ConveyorRail with a fixed player plane and 62-degree FOV.

Rationale: This is the smallest deterministic change that binds visible approach, collision crossing, layer repetition, and Reduced Motion to the same distanceMm.

Rejected: 2x playback because it shortens the contract and camera sway because it substitutes viewpoint motion for actual travel.

Expected measurable improvement: the longest low-difference run drops from 33 to 2 frames; Near flow is positive in 100% of samples; marker passes are 592-608ms.

Known side effects: explicit rail markers make the graybox more geometric; later art work must preserve their motion function.

Human evidence still required: yes, before Human Release or Main acceptance.
