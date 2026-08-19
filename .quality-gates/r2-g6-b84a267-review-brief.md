# R2-G6 visual-remediation frozen review brief

Review exact implementation commit
`b84a267ad6cb174af30ef11b6055889f6180e519` and the later evidence commit that
adds this brief. Stop on the first reproducible S0, S1, or S2. Do not edit,
rebuild over preserved artifacts, or collapse browser-lab, reference-hardware,
visual, rights, human-play, Main, Sites, and submission gates.

## Reproduce the bindings

1. Verify the 11 remediation/provenance file hashes and sorted manifest in
   `.quality-gates/r2-g6-b84a267-artifact.json`.
2. Reproduce `git archive` for the implementation commit: SHA-256
   `0ecd3258f54a73f113e057d9b28ceed988675041adbddc32a05d8e6609fadfab`,
   123,043,840 bytes, 282 entries, zero symlinks, embedded commit `b84a267`.
3. Extract `.quality-gates/r2-g6-b84a267-dist.tar` into an empty directory and
   verify archive SHA-256
   `f6eaff660192ebbbbde507b43aa10557b44978c46e0c21fdd622e528a0a71c35`,
   100 files, zero symlinks, content-record digest
   `46405d4a1eecd911542e03558194c12f94f1ffe5b3819d42682ec07fb4fad28e`,
   BUILD_ID `476500e3-ee38-46da-9595-f2b67a372121`, the exact runtime notice,
   and compiled-JS-only Worker outputs.
4. Verify focused Vitest is 8 requested files / 57 assertions with no failed,
   pending, or todo tests.
5. Verify Playwright is 8/8 passed, retry 0, error fields 0, and has four JSON
   plus twenty 1920×1080 PNG attachments matching the artifact.
6. Verify the production npm audit report has zero vulnerabilities.

## Functional and visual attack surfaces

- Exactly 180 seconds, seed `20260818`, canonical digest
  `world-plan-v1:75d93cbb8e0580cd`, quality/backend-invariant replay, detached
  renderer containers, and 1,000-seed canonical properties.
- A/B/C sequentially share one scene without story/ledger mutation, cross-slice
  scene membership, background/fog identity loss, or retained Hero resources.
- Compare current frames against the historical `cbbd4e5` report. Check whether
  tapered/layered forms, material response, composition, depth, silhouette, and
  restrained density materially address the documented primitive-repetition
  finding without introducing noise or breaking story readability.
- Verify Hero B keeps human works rectilinear and empty while nature remains
  living; verify Hero C keeps S20 incomplete and peripheral, S21 three-shell and
  curvilinear, with a genuine open center and no cockpit/human grammar.
- Ten restart/resource plateaus and ten terminal generations remain constant or
  zero. No post-ready compilation, post-initialize Hero allocation, stale chunk
  activation, pending upload, orphan lease/job, or lifecycle identity drift.
- Treat SwiftShader and host-Metal measurements as regression evidence only.
  GPU timestamps are unsupported and reference hardware remains
  `HARDWARE_PENDING`.

Return exact start/end hashes, drift status, commands, artifact statistics,
visual scores, and `ACCEPT` or `REJECT` with S0/S1/S2/S3 counts. Acceptance may
apply only to this frozen candidate and must not silently accept a human or
external gate.
