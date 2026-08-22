# Candidate N7 isolated review brief

Review only the frozen candidate and bound evidence identified below. Do not
inspect author identity, agent conversations, prior candidate chronology, or
Git history beyond confirming the two exact object IDs.

## Frozen candidate

- implementation commit: `6354357120e92de7d29b8f5b1fd181aade97b5c7`
- implementation tree: `1ea751833045a3a3caad21f1aab40b7e688c73b0`
- base commit: `038d809ff1df265df2747e95faf1f725560ea21b`
- source manifest: `.quality-gates/qx-r3-005-6354357-all-tracked-files.sha256`
- dist archive: `.quality-gates/qx-r3-005-6354357-dist.tar`
- browser report: `.quality-gates/qx-r3-005-playwright-relevant.json`
- acceptance contract: `docs/decisions/QX-R3-005-contract.md`
- review-ready receipt: `.quality-gates/receipts/qx-r3-005-review-ready.json`

## Required review

Verify the manifest and archive hashes independently. Inspect camera and phase
math, canonical-state separation, reduced-motion behavior, chunk residency,
boundary instrumentation, lifecycle/ownership, tests, and evidence binding.
Apply the repository and acceptance-contract requirements exactly. Return:

1. verdict `ACCEPT` or `REJECT`;
2. S0/S1/S2/S3 counts;
3. each finding with file/line and evidence;
4. explicit confirmation whether S0=S1=S2=0;
5. any separate human, rights, deployment, or reference-hardware gates that
   remain pending.

Do not treat the legacy Hero cold-compile laboratory as passing evidence for
this task. Determine whether its classification outside the predeclared
production/rail scope is accurate and whether it reveals a QX-R3-005 S0-S2
regression.
