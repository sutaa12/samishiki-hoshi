# Independent review brief: GFX-004/GFX-005 combined foundation

Review implementation commit `e81c47846291018c37c3496c47b547fb0100375d`
and tree `9406bb8492d1bf22e26554d96785a5b524cef787` against the candidate
evidence commit. Treat the implementation commit, complete source archive,
preserved build tar, focused Vitest report, Playwright report, lockfile, and
accepted GFX-001 through GFX-003 pins as independent bindings to reproduce.

Required methods:

1. Read `docs/GFX_FOUNDATION_DESIGN.md`, `docs/evidence/GFX-004.md`,
   `docs/evidence/GFX-005.md`, this brief, the artifact JSON, and every changed
   source/test file from GFX-003 acceptance `32658deb` through `e81c478`.
2. Re-run `rtk npm run verify`, the nineteen-file `tests/gfx-v2/**` suite, and
   the two-case `tests/e2e/gfx-foundation.spec.ts` browser gate. Inspect the
   preserved JSON reports, including every result/error field.
3. Recreate `git archive` for `e81c478`, then verify its embedded commit,
   SHA-256, byte count, 206 entries, and zero symlinks.
4. Extract `.quality-gates/gfx005-e81c478-dist.tar` into a new empty directory.
   Verify only `dist/` is present, there are 82 files and zero symlinks, the
   sorted content-record digest and BUILD_ID match, the worker asset is
   JavaScript with its pinned hash, and no raw TypeScript worker is shipped.
5. Attack GFX-004 state transitions, token/plan binding, payload bounds,
   cancellation order, stale replies, rapid seeks, deferred adoption, upload
   clock reentry, per-job maximum slice, aggregate 1/2/4 ms limits, cleanup
   retries, optional registry pairing, and fixed-point owner release.
6. Attack Worker/client/endpoint ownership, listener acquisition/removal,
   message and messageerror terminal paths, FIFO/cancel ordering, transfer
   ownership, browser module loading, termination, and post-dispose admission.
7. Attack all seven material-family descriptors, variant inventory identity,
   caller ownership/accessors/Proxies, initialization/disposal reentry,
   partial cleanup, retry latches, and bounded frozen failure evidence.
8. Attack pipeline attach, quality, resize, history invalidation, precompile,
   submit, and dispose admission before caller input access; all callbacks and
   methods must be captured once and invoked without caller-controlled `.call`,
   iteration, `toJSON`, or prototype hooks.
9. Verify every reachable WebGPU/WebGL2 material/profile graph is warmed on its
   actual HDR target/MRT before ready, runtime material inventory cannot drift,
   transmission stays inside the half-float graph, and program growth remains
   zero through quality changes and chunk activation.
10. Attack construction, failed rollback, route StrictMode/unmount/remount,
    stale runtime, resize-reconcile races, and recreate cleanup. Exact cleanup
    owners must survive rejection and block replacement admission until zero.
11. Re-run actual forced-WebGL2 and host-Metal WebGPU browser cases. Confirm one
    real bundled Worker, at most four resident chunks, no stale activation,
    zero runtime errors/program growth, and zero terminal Host/backend/pipeline/
    material/chunk/uploader/registry/scene/Worker ownership.
12. Report independent S0/S1/S2/S3 counts and `pass` or `reject`. Any open
    S0-S2 rejects promotion. Do not infer GFX-006 telemetry/performance,
    reference hardware, Hero Slice, human integration, release, or Sites
    acceptance from this candidate.
