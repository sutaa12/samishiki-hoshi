# Candidate N8 isolated review brief

Review only the frozen candidate and bound evidence identified below. Do not
inspect author identity, agent conversations, or prior candidate chronology
except the disclosed N7 rejection required to verify remediation.

## Frozen candidate

- implementation commit: `0c86173860e47a6190ae108ce2c703caeec80f1c`
- implementation tree: `a61ecec72329ed7afeb620e972e24838bb9a3dd6`
- base commit: `038d809ff1df265df2747e95faf1f725560ea21b`
- source manifest: `.quality-gates/qx-r3-005-0c86173-all-tracked-files.sha256`
- dist archive: `.quality-gates/qx-r3-005-0c86173-dist.tar`
- browser report: `.quality-gates/qx-r3-005-playwright-remediation.json`
- acceptance contract: `docs/decisions/QX-R3-005-contract.md`
- review-ready receipt: `.quality-gates/receipts/qx-r3-005-n8-review-ready.json`
- rejected predecessor: `.quality-gates/reviews/qx-r3-005-n7-reject.json`

## Required review

Verify the manifest and archive hashes independently. Re-test every N7 finding:
continuous journey-wide progress plus local mix, actual production consumption
of exposure/material/particle/audioLayer, retention of cumulative drawCalls <=
600 alongside <=5/sample, and backend program delta zero across the exact
120-frame boundary. Also inspect canonical-state isolation, rail math, reduced
motion, chunk residency, lifecycle/ownership, and evidence formulas.

Return verdict `ACCEPT` or `REJECT`, S0/S1/S2/S3 counts, findings with exact
file/line evidence, explicit confirmation whether S0=S1=S2=0, verification
results, and separate pending human/rights/deployment/hardware gates.
