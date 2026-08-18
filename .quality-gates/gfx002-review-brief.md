# Independent review brief: GFX-002

Review implementation commit `f613ae780cd651aa77d633c40351da2180ba2acd`
against the current evidence HEAD. Treat the implementation commit, source
archive, preserved build tar, extracted content digest, Playwright report,
lockfile hash, and frozen-file hashes as independent bindings to reproduce.

Required methods:

1. Read `docs/GFX_FOUNDATION_DESIGN.md`, `docs/evidence/GFX-002.md`, the artifact
   JSON, production source under `src/gfx/v2/**`, the `/gfx-contract` route, and
   all GFX-002 tests.
2. Re-run `rtk npm run verify`.
3. Use a new explicit port and `playwright.gfx002.config.ts` to run both GFX-002
   and the unchanged GFX-001 browser specs.
4. Independently verify every archive/report/build/hash binding and that the
   preserved build contains the reviewed implementation behavior.
5. Exercise forced WebGL2 lifecycle, host-Metal actual WebGPU health, fresh-canvas
   recreation, and late device loss. Inspect console/page errors and the full
   JSON probe rather than relying only on `data-status`.
6. Attack lifecycle races, partial initialization, snapshot mutation, backend
   fact overclaim, forbidden imports, subscriber/listener cleanup, resource
   zeroing, replay identity, and accidental changes to GFX-001.
7. Report independent S0/S1/S2/S3 counts and `pass` or `reject`. Any open S0-S2
   rejects GFX-002. Do not infer GFX-003–006, Hero Slice, performance, hardware,
   human, integration, release, or Sites acceptance from this ticket.
