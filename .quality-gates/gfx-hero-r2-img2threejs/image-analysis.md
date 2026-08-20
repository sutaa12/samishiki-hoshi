# Hero A/B/C reference-board intake

## Intended use

- Engine: real-time Three.js/WebGPU and WebGL2 fallback.
- Runtime use: three animated Hero scene slices inside the existing 180-second journey.
- Quality tier: high; close framing, publication evidence, realistic material response, and multiple story states are all required.

## Layered observations

1. Identification: the source is a composite art-direction board containing many separate ocean, forest, cloud, and space screenshots. It is not one isolated object and has no single reconstructable camera. Confidence: 1.0.
2. Overall form: each panel is a perspective environment composition. The recurring protagonist is a translucent droplet; environments combine organic terrain, vegetation, water, particles, volumetric light, and distant depth layers.
3. Macro systems: ocean reef and fish; river/forest/waterfall and later rectilinear ruins; space debris, nebulae, stars, Earth, and three curvilinear alien ribbons around a void. Meso systems include coral branches, foliage clusters, river banks, ruined floor/column grids, particle flows, and ribbon cross-sections. Micro systems include surface grain, leaf/reef breakup, mist, life lights, and material-response variation.
4. Spatial relationships: nature occupies foreground/midground/depth layers around a clear traversal corridor. Human structures remain rectilinear and partly obscured by nature. Alien ribbons orbit a shared empty center without cockpit, front, or thruster grammar.
5. Materials: ocean/river are rough clearcoat dielectrics; living protagonist is semi-translucent; foliage and coral are high-roughness dielectrics with meso/micro variation; ruins mix weathered concrete, glass, and metal; alien ribbons use light mineral/pearl response with low-saturation iridescence.
6. Color/finish: ocean uses deep cyan with localized coral accents; forest uses dark green/cool atmospheric depth with warm shafts; space uses near-black/navy with bounded nebular color and warm/cool life-light accents.
7. Identity features: one anonymous living droplet; dense life without narration; a clear empty human seat/city; exactly three non-human ribbons and a real central void; ordered Twinkle lights.
8. Uncertainty: every panel uses a different inferred camera and lighting setup. Hidden geometry, exact PBR values, and actual volumetric media are not observable. The board is suitable for composition/material targets, not exact object reconstruction.

## Current-render diagnosis

- Hero A: the updated render has useful depth and a readable reef, but fish and coral still use simplified silhouettes and the water column lacks the reference board's micro-detail and soft volumetric scattering.
- Hero B: smooth multi-lobe crowns, denser grass, cool atmosphere, light shafts, and fireflies improve depth, but tree/ruin silhouettes remain visibly procedural and no shadow/AO layer presently grounds them.
- Hero C: the revised wide, near-neutral ribbons now preserve a large central void and no longer read as three candy-colored tubes; nebulae and debris remain deliberately procedural rather than photographic.

## Suitability verdict

`reject-for-single-object-reconstruction`, `usable-as-art-direction`.

The upstream object-reconstruction rubric explicitly rejects a scene rather than one target object. Therefore the img2threejs object factory/spec/export stages must not be misapplied to this composite board. The existing project-native Hero feature, lifecycle, warm-up, deterministic inventory, browser capture, and QA workflow remain authoritative. The high-tier skill contributes the staged observation, PBR vocabulary, raw-render comparison, and no-overclaiming rules only.
