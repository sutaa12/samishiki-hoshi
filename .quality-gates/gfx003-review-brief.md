# Independent review brief: GFX-003

Review implementation commit `c0245667b00e80fe68a511eb0fc206e14f5ead9a`
and tree `ecb7523dc0cf29fb1ec0c7c96bdb1a56d5c74bb0` against the current
evidence HEAD. Treat the implementation commit, complete source archive,
preserved build tar, extracted content digest, focused Vitest report, canonical
world-plan pins, lockfile, and frozen-file hashes as independent bindings to
reproduce.

Required methods:

1. Read `docs/GFX_FOUNDATION_DESIGN.md`, `docs/evidence/GFX-003.md`, the
   artifact JSON, production source under `src/world/v2/**`, and all
   `tests/world-v2/**` tests.
2. Re-run `rtk npm run verify` and the six-file world-v2 Vitest suite. Inspect
   the preserved JSON report rather than accepting only its exit code.
3. Recreate `git archive` for the implementation commit and verify its embedded
   commit, SHA-256, byte count, entry count, and absence of symlinks.
4. Extract `.quality-gates/gfx003-c024566-dist.tar` into a new empty directory.
   Verify that it contains only `dist/`, has no symlinks, contains 70 files,
   reproduces the sorted per-file record digest and BUILD_ID, and matches every
   archive binding in the artifact JSON.
5. Recompute the seed `20260818` canonical plan digest, SHA-256, and byte count.
   Exercise reverse and shuffled generation/chunk schedules and unrelated
   named streams.
6. Attack strict canonical input ownership and work bounds with stateful
   Proxies, accessors, sparse/hidden/symbol/extra keys, cycles, deep/wide/large
   values, infinite schedules, and invalid seed/version tuples.
7. Mutate story order/timing, S08/S14 branches, safe corridors, hydrology,
   descriptors, seven material families, S20/S21 reveal semantics, quality and
   backend fields, and the runtime-exported `SHOT_TABLE`.
8. Attack Twinkle ledger ordering, duplicates, descriptor ownership, signed
   zero, phase-boundary rounding, 0/180-second edges, quality independence,
   signature binding, source immutability, and hostile world plans.
9. Confirm accepted GFX-001/GFX-002 evidence and all frozen game files remain
   byte-exact.
10. Report independent S0/S1/S2/S3 counts and `pass` or `reject`. Any open
    S0-S2 rejects GFX-003. Do not infer GFX-004–006, Hero Slice, performance,
    hardware, human, integration, release, or Sites acceptance from this
    ticket.
