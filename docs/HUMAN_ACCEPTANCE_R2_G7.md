# R2-G7 human acceptance packet

This packet is the resume point for the Human Acceptance Owner. It does not
record acceptance by itself and does not authorize Main integration, Sites
deployment, or contest submission.

The Human Acceptance Owner subsequently authorized a reversible public Sites
deployment for test play. That authorization changes only test distribution;
the integration, visual/play acceptance, rights, hardware, and contest gates
below remain undecided.

## Candidate identity

- Automated implementation: `2741af51e277bdaa76ac97ee8b207bbfb1683cee`
- Implementation tree: `42e3e57e03915bf75770156951f905cc4949ffc9`
- Reviewed evidence: `ba38e664cf6245a45cfa4eeaf1002de8036e2045`
- Automated acceptance record: `bd2aefd7235c2ac8a4d803438a30a6622b6e3498`
- Branch: `graphics-photoreal-megademo`
- Main remains frozen at `6c010ee228ace28e655ceeba764513806505b03e`

The automated R2-G6 review is accepted for these exact hashes with
S0=0, S1=0, S2=0, and S3=0. The evidence includes 37 files / 716 tests,
10 focused files / 177 tests, typecheck, lint, build, production audit, eight
browser cases, twenty unique 1920x1080 frames, restart/resource plateaus, and
ten zero-owner lifecycle generations. Exact bindings and the preserved review
dissent are in `docs/evidence/R2-G6-CURRENT-2741AF5.md` and
`.quality-gates/receipts/r2-g6-current-review.json`.

## Human review checklist

Review the game as a human experience, not as a replacement for the automated
evidence. The production journey is 180 seconds and supports mouse, keyboard,
and touch.

- [ ] The two actions—steer and give life—are understandable without narration.
- [ ] LIFE at 12 seconds shows abundant nature and no visible human artifact.
- [ ] The first empty human artifact appears only after the 18-second boundary.
- [ ] EARTH preserves living forest, river, waterfall, and an empty rectilinear
      city without implying that machinery has revived.
- [ ] SOLITUDE and ANSWER preserve seven rectilinear human forms, three
      peripheral arcs, and exactly three curvilinear shells around an open void.
- [ ] TWINKLE communicates the return of living light and displays the formal
      two-line Japanese title without dialogue or extinction explanation.
- [ ] Reduced motion, high contrast, auto-give, wide-flow assistance, mute,
      keyboard focus, and color-independent cues remain usable.
- [ ] The overall visual quality and pacing are acceptable for public release.

For local human review, use the accepted worktree and start the existing app:

```bash
cd /Users/snari/Documents/GitProject/LonelyStar-graphics-photoreal-megademo
npm run dev
```

Review the normal entry route for the full journey. The isolated `/gfx-hero-a`,
`/gfx-hero-b`, and `/gfx-hero-c` routes are diagnostic evidence surfaces, not
the public game.

## Required decision

Choose exactly one integration decision:

- **Merge** — integrate the complete accepted graphics branch into Main.
- **Partial Merge** — integrate only explicitly named files/features. Record
  the included and excluded scope; the resulting source requires a new build,
  regression run, browser evidence, and acceptance binding.
- **Reject** — do not integrate the candidate. Record the human blocking reason.

Also record these independent decisions:

- Human visual/play acceptance: `Accept` / `Reject` / `Defer`
- Public-use and contest-rights acceptance for all released assets and text:
  `Accept` / `Reject` / `Defer`

Reference-device performance remains `HARDWARE_PENDING` unless it is separately
measured on the designated hardware. Contest identity, eligibility, terms,
privacy/international-transfer consent, attendance, and final submission remain
the responsible person's decisions.

## Authorized continuation

Only `Merge` or a precisely scoped `Partial Merge`, together with human
visual/play acceptance and public-use rights acceptance, authorizes the next
delivery steps:

1. Integrate the approved scope into Main.
2. Re-run complete deterministic, accessibility, build, and browser regression.
3. Package and deploy the exact validated build to the existing public Sites
   project.
4. Verify anonymous reachability, shipped assets, runtime readiness, and one
   real steer/pulse interaction.
5. Bind the deployed version and URL to the accepted source/build hashes and
   update repository and Notion release receipts.

## Rollback

Before deployment, Main can remain or return to
`6c010ee228ace28e655ceeba764513806505b03e`. After deployment, use the previous
Sites version and prior Git commit. Any new open S0-S2 finding, rights rejection,
anonymous-access failure, or primary-interaction failure stops promotion and
triggers rollback.
