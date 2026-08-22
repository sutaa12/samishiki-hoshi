# Candidate N9 isolated review brief

Review only the frozen candidate and bound evidence identified below. Do not
inspect author identity or agent conversations. The disclosed N7 and N8
rejections are required review inputs because N9 claims to remediate them.

## Frozen candidate

- implementation commit: `45244df6d22d98f90e3c298552b9e5e30a2f6435`
- implementation tree: `eb528d5c41aee1c3f4eb5819029f0e3f5d6c99ae`
- base commit: `038d809ff1df265df2747e95faf1f725560ea21b`
- source manifest: `.quality-gates/qx-r3-005-45244df-all-tracked-files.sha256`
- dist archive: `.quality-gates/qx-r3-005-45244df-dist.tar`
- final browser report: `.quality-gates/qx-r3-005-playwright-n9-final.json`
- acceptance contract: `docs/decisions/QX-R3-005-contract.md`
- review-ready receipt: `.quality-gates/receipts/qx-r3-005-n9-review-ready.json`
- rejected predecessors: `.quality-gates/reviews/qx-r3-005-n7-reject.json` and
  `.quality-gates/reviews/qx-r3-005-n8-reject.json`

## Required review

Verify the implementation tree, manifest, archive, browser reports, and all
reported hashes independently. Re-inject failures at every phase-audio graph
construction stage, especially the second oscillator start, and prove that all
started oscillators stop, all partial nodes disconnect, the context closes,
cleanup continues after cleanup errors, the original construction error remains
first, and dispose is idempotent.

Re-test every N7 finding. Confirm that the unchanged cumulative draw-call ceiling
is tested at the first actual 120-frame minimum rather than at a variable UI
polling time, while raw live telemetry remains exposed. Challenge canonical-state
isolation, rail math, reduced motion, chunk residency, lifecycle/ownership, and
the exact 120-frame pixel and backend-program formulas.

Return verdict `ACCEPT` or `REJECT`, S0/S1/S2/S3 counts, findings with exact
file/line evidence, explicit confirmation whether S0=S1=S2=0, verification
results, and separate pending human/rights/deployment/hardware gates.
