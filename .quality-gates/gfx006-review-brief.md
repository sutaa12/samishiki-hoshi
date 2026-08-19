# GFX-006 frozen review brief

Review the exact implementation commit
`9597d9b8f905b492359590eed2cf3dbfdb5e73d8` and the evidence commit that
adds this brief. Stop on the first reproducible S0, S1, or S2. Do not edit,
rebuild over preserved artifacts, run a broad screenshot suite, or treat
reference-hardware/human gates as automated acceptance.

## Reproduce the bindings

1. Verify the seventeen implementation file hashes and ordered manifest in
   `.quality-gates/gfx006-9597d9b-artifact.json`.
2. Reproduce `git archive` for the implementation commit: SHA-256
   `dfc657f16c112bd77b1fc7b8fb3de7ccd6ada6f3cbfc818e449c9b8ca628fb4b`,
   40,949,760 bytes, 220 entries, zero symlinks.
3. Extract `.quality-gates/gfx006-9597d9b-dist.tar` into an empty directory and
   verify archive SHA-256
   `3266c87766500b389cc0105d528b3e990a74d5ca67fe89b48986a2c2d7afdb60`,
   82 files, zero symlinks, content-record digest
   `51d3b08114e5bf0a680725ec2eef8dc7b75243ce14daa63ea0bc43d3e5c11dba`,
   BUILD_ID `9070c0ea-5af1-4814-804d-51450c5dc656`, and only compiled JS
   Worker outputs.
4. Verify the preserved Vitest JSON is 21 files / 499 assertions with no
   failed, pending, todo, or error fields.
5. Verify the Playwright JSON is 2/2 passed, retry 0, and contains four embedded
   JSON attachments: WebGL2/WebGPU steady telemetry, ten-restart plateau, and
   ten-generation lifecycle evidence.

## Attack surfaces

- Nearest-rank boundaries at 119/120, 599/600/601, dropped RAF ordering, and
  exact upload/activation frame exclusion.
- Descriptor/accessor/Proxy/signed-zero/reentry attacks at telemetry, Host,
  queue, manager, backend counter, and disposal boundaries.
- Sink failure isolation and terminal disposal while an ingress capture is in
  progress; no caller callback may mutate lifecycle.
- Late asynchronous frame failure, dropped-frame buffer release, event/ring
  capacity, subscriber/resource snapshots, and terminal raw reference zero.
- Backend/quality parity for game hash, ledger, world-plan, Twinkle signatures,
  and all 24 chunk digests; browser worker digest literals must be independent
  from the production generator call.
- Ten rapid restart cycles and ten complete runtime generations: no stale
  activation, compile growth, Worker/listener/lease/orphan retention, resource
  count growth, or false terminal zero.

## Required verdict

Return exact start/end hashes, drift status, commands, artifact statistics, and
`ACCEPT` or `REJECT` with S0/S1/S2/S3 counts. `ACCEPT` applies only to GFX-006;
GFX-004/GFX-005 review, reference hardware, Hero Slices, human/rights gates,
Main integration, Sites deployment, and contest submission remain separate.
