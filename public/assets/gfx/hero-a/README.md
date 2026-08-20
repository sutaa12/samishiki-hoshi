# Hero A static surface assets

These two images are build-time art inputs for the deterministic Hero A ocean scene. The browser only loads the committed WebP files; there is no runtime AI or external API dependency.

## `reef-seabed-v1.webp`

- Source: GPT Image generation in Codex built-in mode.
- Prompt summary: seamless orthographic photoreal reef rock and seabed, porous limestone/volcanic texture, sand-filled crevices, subtle coralline algae and muted underwater mineral color; no scene, objects, text, shadows, or baked highlights.
- Source file: `/Users/snari/.codex/generated_images/01a01182-684b-7290-a227-189d370d3623/exec-f23a426d-fbf9-401c-bfda-a02c43a12bfe.png`
- Conversion: `cwebp -q 84 -m 6 -resize 1024 1024`.

## `coral-cluster-v1.webp`

- Source: GPT Image generation in Codex built-in mode.
- Prompt summary: asymmetric photoreal temperate coral, sea-fan, sponge and hydroid cluster with genuine transparent negative space; no rock, sand, fish, bubbles, background, glow, text, or border.
- Source file: `/Users/snari/.codex/generated_images/01a01182-684b-7290-a227-189d370d3623/exec-d621993f-3584-48d7-b85d-e20d8400ed38.png`
- Conversion: `cwebp -q 88 -alpha_q 95 -m 6 -resize 1024 0`.

## `fish-scales-v1.webp`

- Source: GPT Image generation in Codex built-in mode.
- Prompt summary: seamless orthographic fish-skin material with fine natural scales, subtle teal/silver/olive/coral iridescence and diffuse underwater light; no fish silhouette, anatomy, scene, text, border, or baked highlight.
- Source file: `/Users/snari/.codex/generated_images/01a01182-684b-7290-a227-189d370d3623/exec-d3258441-6cf5-40aa-8205-44e347b5ded0.png`
- Conversion: `cwebp -q 86 -m 6 -resize 1024 1024`.

Human art-direction and rights acceptance remain pending. These files must not be treated as satisfying either gate by themselves.
