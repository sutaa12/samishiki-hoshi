# QX-R5-000A Blind Review — Round 22

## Verdict

**REJECT**

- Exact commit: `7b2eae8e30bc5e27263bbf1f29ff1ef9d27dfceb`
- Score: **23/32**
- Severity counts: **S0 0, S1 2, S2 0, S3 0**
- Isolation: read-only; no prior `independent-review*` file was opened. The target checkout remained clean.

## Rubric

| Dimension | Score | Assessment |
|---|---:|---|
| Source-of-truth/task scope | 4/4 | Exact R5-001…007 whitelist plus R4-R01 migration; no runtime-tree changes. |
| Fail-closed acceptance separation | 1/4 | Multiple Human-failure encodings pass AI Binary completion. |
| Evidence/hash/path integrity | 4/4 | Strong regular-file, symlink, inode, digest, archive, and build-entry recomputation. |
| AI gameplay semantic validation | 2/4 | Ordered relations are checked, but explicitly automatic play passes as steering comprehension. |
| Adversarial robustness/malformed input | 2/4 | Extensive defenses exist, but ordinary alternate Human result shapes/text bypass them. |
| Migration integrity/immutability | 4/4 | R4-R01 policy, assessment, stable manifest, source/build, classification, and successor are pinned. |
| Test coverage/regression safety | 2/4 | 144 tests pass, but four concise adversarial cases expose two blocking gaps. |
| Repository/delivery hygiene | 4/4 | Checkout clean; runtime/public game surface untouched. |

## S1 findings

### Human Reject/result detection is not fail-closed

The detector misses common Human-result encodings. Each of these mutations to an otherwise valid AI Binary fixture returned exit 0 with `ok: true`:

```json
{"human":{"result":false}}
```

```json
{"human":{"notes":"The acceptance criteria were not met."}}
```

```json
{"audit_record":{"reviewer_id":"Human-42","result":false}}
```

The implementation did not treat generic Human `result` fields as failure, did not recognize `reviewer_id` as Human context, and missed passive “acceptance criteria were not met” prose.

Required remediation: under Human context, fail closed on negative generic result/status/outcome/decision scalars; recognize reviewer ID and equivalent descriptor keys; add passive/unmet acceptance forms and digest-bound artifact variants.

### Automatic play satisfies the steering semantic proof

The actor-motion grammar accepted `automatically`, allowing three distinct descriptions that explicitly contradict player steering:

```text
A droplet automatically moves through a ring, avoids a rock, and energizes a plant.
The player automatically advances through a hoop, dodges a boulder, then sends light to a sprout.
A water character automatically travels through a gate before avoiding a barrier and pulsing a target.
```

Required remediation: reject automatic/autopilot language and require player steering/control or left-right agency; add equivalent Japanese rejection for `自動` and `オート`.

## Verification performed by reviewer

- Exact target commit and clean status verified.
- No diff under `app`, `src`, or `public`.
- Research tests: 144/144 passed.
- R4-R01 AI Binary: exit 0, `ok: true`.
- R4-R01 Human Release: exit 1 with Human gate failures.
- QX-R5-008 AI Binary: exit 1 with `AI_ACCEPTANCE_SCOPE`.
- Four external adversarial assertions reproduced the two blockers.

