# QX-R5-000A Blind Review — Round 24

## Verdict

**REJECT**

- Exact commit: `6c9c2b5ea3e657dd22c2e761ad5d7b7eaae44f33`
- Score: **21/32**
- Severity counts: **S0 0 / S1 4 / S2 0 / S3 0**
- Isolation: read-only; no prior QX-R5-000A independent-review artifact was opened or inspected.

## Rubric

| Dimension | Score |
|---|---:|
| Source/task scope | 4/4 |
| Fail-closed acceptance separation | 1/4 |
| Evidence/hash/path integrity | 3/4 |
| Gameplay semantic validation | 1/4 |
| Adversarial malformed robustness | 1/4 |
| Migration integrity | 4/4 |
| Test/regression safety | 3/4 |
| Repository/delivery hygiene | 4/4 |

## S1 findings

### Malformed digest-bound Human JSON can conceal rejection

A correctly digest-bound Human-labeled artifact containing the malformed JSON prefix `{"result":false` was accepted because parse failure was treated as no rejection.

Required remediation: distinguish prose from JSON-looking content; malformed JSON, scalar JSON, and arrays must produce a blocking format/reference issue.

### Numeric Human provenance IDs bypass Human context

`participant_id: 7` did not establish Human context because provenance detection accepted strings only. A nested digest-bound `{"result":false}` artifact was therefore accepted.

Required remediation: presence of participant/tester/evaluator ID must establish Human context; validate string and integer forms separately and reject malformed IDs.

### Contrary or self-controlled gameplay descriptions pass

Descriptions containing `steers through neither ring`, `dodges neither rock`, and `pulses neither target` passed. Japanese `水滴が自身で操作して...` also passed.

Required remediation: reject negating quantifiers and reflexive/autonomous constructions after normalized fingerprinting, and strengthen the affirmative controller-to-action relation.

### Arbitrary adjectives evade near-duplicate detection

Copies of one sentence template with different modifiers around actor, ring, obstacle, and target passed the trigram threshold.

Required remediation: compare action/role skeletons and token-edit similarity after removing arbitrary modifiers, not a fixed adjective list.

## Verified checks

- Research tests: 166/166 passed.
- External probes: 5/5 bypasses reproduced.
- R4-R01 AI Binary: exit 0.
- R4-R01 Human Release: exit 1 with Human gates blocked.
- Migration policy, assessment, and stable Production manifest hashes matched pinned constants.
- Candidate diff touched only validator and tests.
- No changes under `app`, `src`, or `public`.

## Continuation point

Resume from the four S1 findings above. Do not mark QX-R5-000A complete or update QX-R5-001 until a fresh isolated review scores at least 28/32 with S0=S1=S2=0.

