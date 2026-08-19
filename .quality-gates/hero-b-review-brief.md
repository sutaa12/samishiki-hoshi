# Hero Slice B frozen review brief

Review the exact implementation commit
`2fb5cade0c5e8df8b3e889a14a57867c8e0440ba` and the evidence commit that adds
this brief. Stop on the first reproducible S0, S1, or S2. Do not edit, rebuild
over the preserved artifacts, or treat browser-lab, AI visual review, or human
gates as interchangeable.

## Reproduce the bindings

1. Verify the eight implementation file hashes and ordered manifest in
   `.quality-gates/hero-b-2fb5cad-artifact.json`.
2. Reproduce `git archive` for the implementation commit: SHA-256
   `99c4e597ef273d157502037e1a2d7778bb48e60c09f1767e5ac11fdd2eb057e1`,
   61,143,040 bytes, 250 entries, zero symlinks, embedded commit `2fb5cad`.
3. Extract `.quality-gates/hero-b-2fb5cad-dist.tar` into an empty directory and
   verify archive SHA-256
   `14d25df13f65b75dbab1d283c5bd195617a5bc19684ae92d61a871d1d7545053`,
   94 files, zero symlinks, content-record digest
   `a1f50aaf8c0a0aa15d653e0e18f6061fc5022c222a99c2332c91d1d3a6d0843b`,
   BUILD_ID `dd575ac6-2ea2-47db-a73b-8a5f84b1490c`, and compiled-JS-only
   Worker outputs.
4. Verify the focused Vitest JSON is 2 files / 10 assertions with no failed,
   pending, or todo tests.
5. Verify the Playwright JSON is 2/2 passed, retry 0, error fields 0, and has
   five embedded 1920×1080 PNGs whose hashes match the artifact manifest.

## Functional attack surfaces

- Exact 61.999/62-second city-reveal boundary, 58/75-second fixed markers,
  seed `20260818`, and unchanged canonical plan digest.
- At 58 seconds, city objects are hidden while the connected river, waterfall,
  mist, living pulse, protagonist, safe corridor, dense forest, flowers, and
  birds remain readable.
- At 75 seconds, nature still reads before eight rectilinear ruin towers; check
  the empty rectangular bench, wind-moved playground, giant square observation
  frame, roof planting, window birds, and unobstructed corridor/sightline.
- High ↔ Low density changes must be visual-only and restore exact inventories.
- No post-initialize allocation, post-ready compile growth, stale chunk
  activation, pending upload, orphan lease/job, or ownership growth.
- The city visibility change must not alter light topology and create a first
  city-frame shader compile.
- All geometry, material, texture, background, scene membership, and worker
  ownership release exactly once under concurrent and repeated disposal.
- Built-in physical-material transmission remains zero; no reference image is
  shipped as a scene background.

## Visual review rubric

Review the WebGPU and forced-WebGL2 58-second frames anonymously, then the
75-second frames; inspect the WebGL2 Low fallback separately. Score functional
readability, composition, water continuity, material/light realism, natural
abundance, ruin scale, human-absence storytelling, observation-frame and empty
bench readability, backend parity, and temporal stability independently. A
merely functional or stylized procedural scene is not sufficient for Cinematic
Procedural Realism.

## Required verdict

Return exact start/end hashes, drift status, commands, artifact statistics,
visual scores, and `ACCEPT` or `REJECT` with S0/S1/S2/S3 counts. Acceptance
applies only to R2-G4 Hero Slice B. GFX-004/GFX-005, GFX-006, Hero A,
reference hardware, Hero C, human/rights gates, Main integration, Sites
deployment, and contest submission remain separate.
