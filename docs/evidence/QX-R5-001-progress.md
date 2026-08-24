# QX-R5-001 AI Binary acceptance

Status: `AI_BINARY_ACCEPTED`, `PUBLIC_TEST_DEPLOYED` — actual Human Release and
the remaining external gates stay pending.

## Accepted subject

- Runtime source commit: `814e879557b26d71c7453bdde5a95caa81d9bb75`.
- Source archive SHA-256: `23a24d2e9653e109a4f1f30103ddf12dede64f1a09537b5c30bd473c49d01b96`.
- Build manifest SHA-256: `bd0ba727b4798f7415c2fb0c723ee585894c063708a6d4e226e94a10ff1a04f9`.
- 1920×1080 muted video: 15.000 seconds, native 25fps, 375 decoded frames.
- Video SHA-256: `d20f427dec59d9fcc10acf507d39320c5a236ee6b5bb39cb426015f8ad82385e`.
- Exact Research Pack: `docs/research/QX-R5-001/evidence.json`.

## Binary evidence

- Player projected height: 79px; contract range 64–88px.
- Ring projected-area ratio: 4.435636 within 2.496 seconds.
- Steer response: 12px in 32ms; 192px in 288ms at 1920px width.
- Successful real-input replay: Ring pass, Obstacle dodge, Node perfect, Progress 3/3.
- Frame telemetry: 375 uniformly timed, strictly increasing `distance_mm` samples.
- Event ledger: `ring_success` → `rock_avoid` → `node_pulse` → `progress_update`.
- Desktop, Portrait 390×844, and neutral grayscale 0/4/8/12-second captures are stored under `.quality-gates/QX-R5-001/screenshots/`.

## Independent blind review

Three fresh isolated SolMax reviewers received only the muted video. They all
identified the same controllable droplet, continuous forward travel, ring
pass, solid-object avoidance, pulse target, result, and progress, and each
returned `accept`. Raw free descriptions and normalized validator records are
preserved under `.quality-gates/QX-R5-001/`.

Disclosed minor findings for later R5 tasks: small peripheral UI, weak
event-local Ring/Obstacle feedback, little persistent target deformation after
Pulse, and early silhouette overlap between the obstacle and later target.
These do not fail the QX-R5-001 Binary contract and are not silently discarded.

## Verification

- `npm run verify`: 45/45 test files, 1043/1043 tests, typecheck, lint, and build passed.
- `npm run research:validate -- QX-R5-001 --stage complete --acceptance ai-binary`: exit 0, `issues: []`.
- Human-release invocation: exit 1 with `MISSING_FILE human-test.md`, as required before actual human play acceptance.

## Public human-test distribution

- Sites v3 route: <https://samishiki-hoshi-seoul.narinarinari.chatgpt.site/r5-minimum>.
- Saved version: `appgprj_6a837fe8fec08191aeb514bf721a0634~appgver_b3df52b30fc88191ba82881bd0981b7f`.
- Deployment: `appgdep_6a8ba68867d08191905ada044bc5184a`, status `succeeded`.
- Public smoke: HTTP 200 on desktop and 390×844; zero console/page errors;
  real Arrow/Space input produced Ring pass, Obstacle dodge, Node perfect, and
  Progress 3/3.
- Sites source `a8165962bbf2dc2131c7325a49a457835edfb3f4` excludes generated
  `.quality-gates` files only. Its `app` and `src` tree objects are byte-identical
  to frozen runtime source `814e879557b26d71c7453bdde5a95caa81d9bb75`.
- Publication receipt: `.quality-gates/QX-R5-001/sites-v3-publication.json`.

Actual human play, Legal, Main integration, final release acceptance, and
contest submission remain separate and pending. Successful public deployment
and automated smoke do not advance those human or external gates.
