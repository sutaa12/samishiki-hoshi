# Notion gameplay reference intake

## Scope

Reference: Notion 05 current LIFE gallery (`reference-05.svg`). It is a four-panel, low-resolution scene collage. It is not accepted as a single-object or pixel-aligned reconstruction target. It is conditionally accepted for the recurring luminous-droplet protagonist and for scene-level color, density, and silhouette direction.

Stable source: Notion page `3bf9b8d3-9c28-8116-934d-e0f478f7f563`. Downloaded SVG evidence hashes: reference-05 `b3e516472cc96401eb93262b2107d10f10efded9faa466daeea4fe88c07a2617`, reference-06 `2a58cdb9c221a72183b43a347736767673b27f6fcc0d49ebc5cea1ca078a6c49`, reference-07 `ccaca616f0e4eb0ad60dfdcbb10f26c90147337ebfc6e7ef2205775ad35d5b5`, reference-08 `4828db7ca077c68095f4e4ab216fddd0a4b3656e65926ac12dbdf3d05d61ca7c`.

## Bottom-up observation

1. **Identification** — Each panel depicts a small non-humanoid player form in an underwater environment. The recurring player form is the bounded reconstruction subject (`primaryDomain: object`, confidence 0.78); coral, fish, rocks, and water are context.
2. **Overall form** — The subject has an organic, approximately bilateral silhouette: a rounded/teardrop central volume, two lateral membrane-like fins or leaves, and a short trailing water tail. It is not a flat icon; highlights and overlap imply a compact translucent volume.
3. **Macro/meso/micro** — Macro: central droplet body, paired fins, short tail. Meso: bright inner nucleus and outer translucent envelope. Micro: soft rim highlight and warm core accent. No face, limbs, logo, text, or hard seam is visibly supported.
4. **Relationships** — Fins overlap the lateral body and sweep rearward; the tail attaches to the posterior/lower body; the nucleus is embedded inside the envelope. Exact back-side attachment and thickness are hidden.
5. **Materials** — The envelope and fins read as semi-translucent dielectric/liquid-like material with a bright cyan-white rim. The embedded nucleus is emissive white/cyan with a restrained warm center. The reference does not support exact glass caustics or a manufacturing-grade material model.
6. **Color/finish** — Neutral white and pale cyan dominate the player, with a small warm yellow/coral accent. The underwater context uses deep blue/cyan and localized warm coral/fish accents rather than uniform neon.
7. **Identity features** — Identity is carried by the clear droplet core, paired soft fins, tiny water tail, and motion/tilt; there is deliberately no facial expression.
8. **Uncertainty** — The collage is only about 520x293 internally, the subject occupies a small region, and no orthographic/back view exists. Back-side topology, true index of refraction, and exact fin thickness are undetermined. Fidelity is therefore a stylized game-readable approximation, not an exact reconstruction.

## Suitability verdict

`conditional`: usable for a stylized procedural hero and art-direction grammar. The full scene is rejected as a single-object reconstruction target. The user explicitly requested these gameplay images as reference, and the game requires real-time procedural Three.js rather than mesh extraction.

## Quality contract

- The player must read immediately as a luminous living water droplet at normal gameplay scale.
- Required macro forms: one volumetric droplet envelope, two distinct swept fins, one attached water tail.
- Required meso forms: embedded bright nucleus and an outer translucent/rim layer.
- Required material layers: neutral translucent envelope, cyan-white emission, restrained warm nucleus; no flat opaque blob.
- Required views: gameplay three-quarter/front view plus an offset/orbit view that proves the fins and body are volumetric.
- Blocking failures: facial features, hard mechanical seams, opaque single primitive, detached fins/tail, uniformly saturated neon, or a silhouette that loses either paired fins or the short tail.
- Scene contract outside the object pipeline: rich natural silhouettes remain primary; human traces are warm and orthogonal; the alien is three curved shells around a void; particles support rather than replace large readable forms.

## Practical fidelity ceiling

Target 0.75 for a real-time stylized hero. A claim above 0.85 is not supported by this single low-resolution collage.
