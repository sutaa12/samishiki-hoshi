# Hero Slice A frozen review brief

Review the exact implementation commit
`67dea2b1589c0e7f862cf76674b45b3cffbc04f1` and the evidence commit that adds
this brief. Stop on the first reproducible S0, S1, or S2. Do not edit, rebuild
over the preserved artifacts, or treat browser-lab, AI visual review, or human
gates as interchangeable.

## Reproduce the bindings

1. Verify the ten implementation file hashes and ordered manifest in
   `.quality-gates/hero-a-67dea2b-artifact.json`.
2. Reproduce `git archive` for the implementation commit: SHA-256
   `0c005f320a9333230857bb956f06f0909caec7d6b9f23db70f78c81a43256a1e`,
   46,264,320 bytes, 236 entries, zero symlinks, embedded commit `67dea2b`.
3. Extract `.quality-gates/hero-a-67dea2b-dist.tar` into an empty directory and
   verify archive SHA-256
   `fdc4cc67f41249335d46f00f9d58fb061fad7def7b4ea2f934cc013e597b32c2`,
   89 files, zero symlinks, content-record digest
   `2305e051e3744d9c094ebd89f6c4d7b25b17162b6ac296246d14b1f02e8e943b`,
   BUILD_ID `8ef869f9-4197-4232-97db-90ec00a4a25c`, and compiled-JS-only
   Worker outputs.
4. Verify the focused Vitest JSON is 2 files / 10 assertions with no failed,
   pending, or todo tests.
5. Verify the Playwright JSON is 2/2 passed, retry 0, error fields 0, and has
   six embedded 1920×1080 PNGs whose hashes match the artifact manifest.

## Functional attack surfaces

- Exact 17.999/18-second human-artifact boundary, 12/27-second fixed markers,
  37-second waterline evidence, seed `20260818`, and unchanged canonical plan
  digest.
- No human artifact before 18 seconds; after 18 seconds the vehicle remains
  rectilinear with five pale empty seats, seven window cells, and seven rails.
- Player, flow, and pulse target readability; abundant life inventory; High ↔
  Low density changes must be visual-only.
- No post-initialize allocation, post-ready compile growth, stale chunk
  activation, pending upload, orphan lease/job, or ownership growth.
- All geometry, material, texture, background, scene membership, and worker
  ownership release exactly once under concurrent and repeated disposal.
- Built-in physical-material transmission remains zero; no reference image is
  shipped as a scene background.

## Visual review rubric

Review the WebGPU and forced-WebGL2 12-second frames anonymously, then the
27-second frames; inspect the WebGL2 37-second transition and Low fallback
separately. Score functional readability, composition, material/light realism,
natural abundance, human-absence storytelling, backend parity, and temporal
stability independently. A merely functional or stylized procedural scene is
not sufficient for Cinematic Procedural Realism.

## Required verdict

Return exact start/end hashes, drift status, commands, artifact statistics,
visual scores, and `ACCEPT` or `REJECT` with S0/S1/S2/S3 counts. Acceptance
applies only to R2-G3 Hero Slice A. GFX-004/GFX-005, GFX-006, reference
hardware, Hero B/C, human/rights gates, Main integration, Sites deployment,
and contest submission remain separate.
