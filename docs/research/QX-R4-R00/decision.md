# Decision

Task ID: QX-R4-R00
Source commit: 0a63c462557aad29f947a88460b0380538782d53

## Options considered

| Option | Evidence for | Evidence against | Cost | Fallback | Decision |
| --- | --- | --- | --- | --- | --- |
| A: Native Node scripts | Node core already exists and can validate files/JSON/CSV invariants | Custom schema code must be tested carefully | No dependency or game bundle change | Revert workflow commit | Adopt |
| B: Ajv | Maintained MIT JSON validator with pinned release | Does not validate Markdown/CSV semantics and adds a dependency | Package/lock churn and schema maintenance | Native validation | Rejected: added dependency has no measurable player benefit |
| C: Zod | Maintained MIT typed schema library | Requires TypeScript/tooling path and still needs bespoke cross-file checks | Package/lock churn and compile surface | Native validation | Rejected: unnecessary for a repository-only fixed schema |

## Chosen option

Decision: Adopt native Node scripts and repository templates.

Rationale: The smallest complete solution enforces the Notion protocol while adding zero runtime/development dependencies and leaving browser output untouched.

Expected measurable improvement: empty and community-only packs fail; a complete minimum pack passes; completion without numeric/human evidence fails.

Known side effects: maintainers must update the native validator when the pack schema changes.

Human evidence still required: yes for future player-facing Candidates, not for this process-only foundation task.

## Binding

All R00 evidence binds to baseline commit `0a63c462557aad29f947a88460b0380538782d53`. Runtime-source and Production-output equality are separate acceptance checks.
