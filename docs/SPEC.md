# Executable specification

Status: graphics rebaseline R2, isolated implementation on 2026-08-18 JST. Canonical source is the Notion production plan rooted at `3bf9b8d3-9c28-8188-8819-dda26e08db71`; page 13 overrides lower sources for renderer, material, temporal, backend, and Hero Slice decisions.

## Experience contract

- Title: `さみしき星のまたたきよ` / `TWINKLE, O LONELY STAR`
- Tagline: `ひとりの光は、やがて無数のまたたきになる。`
- Format: one continuous, wordless, 180-second browser journey.
- Actions: steer and give life only.
- Input: mouse follow or drag, left-70%-screen touch drag, WASD, and arrows steer.
  Mouse click, right-30%-screen touch tap, and non-repeat Space emit one Pulse
  edge. A pointer gesture is locked to one route and can never both steer and
  pulse; settings controls never reach the gameplay router.
- Runtime: TypeScript + Three.js. `WebGPURenderer + TSL` uses WebGPU as the capable High path and the same renderer's WebGL2 backend as fallback. Procedural geometry/effects and generated Web Audio require no account, personal data, runtime network service, paid API, game over, dialogue, narration, audio log, corpse, or stated extinction cause.

## Exact timeline

| Phase | Seconds | Required event |
| --- | ---: | --- |
| LIFE | 0–36 | Abundant ocean; first pulse; no human artifact before 18s; submerged rectilinear ruin appears only after 18s. |
| EARTH | 36–88 | River, forest, animals, and a warm reclaimed city crossed by recurring human motifs. |
| ASCENT | 88–130 | Rectilinear observatory, wings, clouds, aurora, and a clearly living Earth. |
| SOLITUDE | 130–161 | Color-rich deep space and negative space; rectilinear human spacecraft debris and one amber beacon. S20 (155–161) adds only three faint, incomplete peripheral arcs—never the full ship or central void. |
| ANSWER | 161–171 | Unknown ship: three phase-shifted curved ribbon shells around a central void. The response window opens at 166s; only a valid player or opt-in auto-give Life Node pulse creates the Answer. |
| TWINKLE | 171–180 | Turn toward Earth; few lights become tens, then countless living lights; formal Japanese title appears only at 178–180s. |

The runtime exposes the exact 24 authored shot boundaries from 0–3 through 178–180 seconds. Production timing is never shortened by quality settings. A localhost-only test query may accelerate wall-clock playback while retaining story time.

## Visual grammar

- Notion page 05's updated references and page 13 define **Cinematic Procedural Realism**. Reference images are translated into procedural Three.js geometry, TSL materials, atmosphere, water, lighting, and temporal behavior; they are never pasted as runtime backgrounds or claimed as pixel-exact reconstruction.
- One Linear HDR light/exposure pipeline governs water, atmosphere, cloud, terrain, foliage, concrete, metal, glass/foil, alien surfaces, and emission. Tone mapping occurs exactly once at the end. Bloom, fog, flare, and noise may not hide missing geometry or readability failures.
- The protagonist is a faceless, luminous living droplet: one translucent volumetric envelope, paired swept membrane fins, one attached short water tail, a white/cyan nucleus, and one restrained warm core. It has no eye, mouth, hard seam, or mechanical part.
- Natural forms remain the first read: layered terrain/hydrology, physically plausible water absorption/foam/caustics, coral/kelp/fish ecology, forest LOD, river/waterfall, shared atmosphere/cloud/aerial perspective, a living Earth, restrained deep space, and life-wave clusters. Supporting particles never replace large silhouettes.
- Human structures use 1:1, 1:2, and 1:4 rectilinear ratios: boxes, slabs, beams, columns, panels, and trusses. Damage may break pieces but the grid stays legible.
- The unknown ship uses exactly three closed B-spline center curves, parallel-transport frames, constrained superformula sections, true-thickness ribbon shells, and a genuinely open SDF/geometry center. Dark pearl/translucent mineral material carries restrained teal/coral/warm subsurface response light. It has no cockpit, window, box, panel, thruster, weapon, mechanical seam, or obvious front. It signals recognition, not rescue, and remains beside the protagonist through TWINKLE after the 161-second reveal.
- Repeated human motifs are an empty rectangular seat, a square observation frame, and a thin amber line light.
- The opening must read as abundant life, not apocalypse. Every biome keeps local color contrast and a readable route.
- The 178–180 second formal title card contains only `さみしき星のまたたきよ`, fixed as two intentional lines. It preserves a text-safe view of the small distant Earth, protagonist, three-shell craft, and living-light waves; the English title, tagline, and story explanation are not shown simultaneously.

## Simulation and generation

- The run seed is explicit and stable. Random values come only from a deterministic generator.
- Each valid Life Node pulse appends one immutable `TwinkleSeed` containing sequence, story time, phase, normalized position, local biome, and deterministic signature. Empty-space and cooldown pulses append none.
- Same seed plus same timestamped input stream yields the same ledger and final hash on every quality tier.
- Independent named seed streams derive from world seed, system name, chunk id, and generator version so a parameter change in one system cannot perturb another system's random sequence.
- Renderer-independent world data owns Story nodes, safe corridor, at most two flow branches, terrain/hydrology, ecology, atmosphere, space, and Twinkle semantics. Renderer features consume this data but cannot write simulation state.
- Runtime keeps at most forward-two/current-one/behind-one chunks active, generates off-thread where practical, uploads in bounded slices, batches or instances repeated forms, and disposes inactive resources.
- WebGPU and forced-WebGL2 may use different algorithms or densities, but must preserve gameplay, safe corridor, story silhouettes, collision, flow decisions, Twinkle ledger, and hashes.
- Pulse feedback awakens nearby coral, moss, grass, birds, or microbes. It never powers a human machine.
- 1,000-seed property verification rejects invalid timelines, impossible route bounds, broken phase order, or non-finite generated values.

## Accessibility and controls

- Reduced motion lowers camera sway, parallax amplitude, streak velocity, and transition displacement without changing phase time.
- High contrast adds luminance separation and stronger silhouettes; color meaning is duplicated by shape and motion.
- Auto-give waits for a nearby Life Node and emits a valid life pulse. Wide flow reduces steering pressure. Mute never blocks progress.
- Rail flight advances automatically in integer millimetres. Gate, obstacle,
  and Life Node outcomes use deterministic 3D rail/corridor distance and fire
  once per encounter.
- Pulse cooldown is 0.7 seconds of journey time without per-slice millisecond
  rounding. Empty-space pulses do not create Twinkle Seeds, and normal play
  does not synthesize an automatic Answer.
- UI controls are keyboard-focusable, have visible focus states, and remain usable at 320×568, 390×844, tablet, and desktop widths.
- Audio starts only after user input and is synthesized with Web Audio. The experience remains fully understandable when muted.

## Acceptance

- Before broad integration, Hero Slice A (ocean/submerged ruin), B (sunset forest/city), and C (human debris/alien/Twinkle) pass at fixed replay markers in WebGPU High and forced-WebGL2.
- Reference High targets frame P95 ≤16.67 ms, P99 ≤25 ms, main P95 ≤8 ms, GPU P95 ≤11 ms, and zero compile/upload/activation spikes over 50 ms. Compatible Low targets frame P95 ≤33.33 ms. Reference-device proof remains `HARDWARE_PENDING` until measured there.
- Ten restart cycles show no monotonic geometry, texture, GPU-resource, or heap growth. Every imported technique has a permissive license, locked version/commit, provenance row, test, and required notice.
- Typecheck, lint, unit/property tests, production build, rendered HTML checks, and Playwright desktop/mobile flows pass.
- Default timeline equals 180 seconds; all phase boundaries and 24 shots are covered by tests.
- No external runtime request is needed for play, and no secret is present in source or build output.
- Automated browser QA confirms start, steer, pulse ledger, settings, accelerated end sequence, restart, backend selection, and renderer initialization.
- Independent artifact-only review reports zero open S0, S1, and S2 findings.
- The Human Acceptance Owner chooses `Merge`, `Partial Merge`, or `Reject` after all Hero Slice evidence is available. Only explicit `Merge`/`Partial Merge` authorizes `main` integration and release acceptance.
- An authorized public Sites deployment is anonymous and smoke-tested with a real interaction. Human play acceptance, contest consent, personal information, rights guarantee, Seoul attendance, and final submission remain separate.
