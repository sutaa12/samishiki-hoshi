# QX-R5-000A Blind Review — Round 23

## Verdict

**REJECT**

- Exact commit: `b5b9c40b38582de7df67ebb300eb66f2c1d93e52`
- Score: **22/32**
- Severity counts: **S0 0 / S1 2 / S2 1 / S3 0**
- Isolation: read-only; no prior QX-R5-000A independent-review artifact was opened, listed, or inspected.

## Rubric

| Dimension | Score |
|---|---:|
| Source-of-truth/task scope | 4/4 |
| Fail-closed acceptance separation | 2/4 |
| Evidence/hash/path integrity | 2/4 |
| AI gameplay semantic validation | 2/4 |
| Adversarial robustness/malformed input | 2/4 |
| Migration integrity/immutability | 4/4 |
| Test coverage/regression safety | 2/4 |
| Repository/delivery hygiene | 4/4 |

## Findings

### S1 — Preserved Human failures can pass AI Binary

All four cases were accepted by a valid QX-R5-001 fixture:

1. Optional `human-test.md` containing `The requirements have not been met.`
2. `{"audit_record":{"participant_id":"P-001","result":false}}`
3. A Human-labeled artifact pointing to `Decision: FAIL.` with malformed `sha256`.
4. A valid digest-bound Human artifact whose entire JSON value is `false`.

Required remediation: treat Human provenance keys as Human context without a literal Human value; reject malformed Human artifact references; interpret scalar Human artifacts conservatively; extend passive failure wording.

### S1 — Autonomous Japanese motion passes as active player steering

The following was accepted:

`水滴が自ら操作してリングをくぐり、岩を避け、芽へ光を渡す遊びです。`

Required remediation: require explicit player-to-avatar control and reject reflexive/autonomous markers such as `自ら`, `自分で`, `ひとりで`, `on its own`, and `independently`.

### S2 — Copied-answer resistance does not reject semantic near duplicates

These three were simultaneously accepted:

- `A droplet steers through a ring, avoids a rock, and energizes a plant.`
- `A tiny droplet steers through a ring, avoids a rock, and energizes a plant.`
- `A small droplet steers through a ring, avoids a rock, and energizes a plant.`

Required remediation: reject near-duplicate descriptions and semantic/cross-language copies, then preserve the probes as regressions.

## Positive evidence

- R4-R01 AI Binary: exit 0.
- R4-R01 Human Release: exit 1.
- R01 closure remains `research-only-ai-accepted`, claims no Production improvement, and points to QX-R5-001.
- Typecheck passed.
- No changes under `app`, `src`, or `public`.

