# Notion gameplay visual targets — 2026-08-18

These four boards were downloaded from the user-maintained Notion specification after the graphics rebaseline. They are authoritative **visual targets**, not runtime textures, background plates, or shippable game assets.

## Source and scope

- Root specification: `OpenAI Game Builders Seoul 2026`
- Notion root page ID: `3bf9b8d3-9c28-8188-8819-dda26e08db71`
- Visual specification page ID: `3bf9b8d3-9c28-8116-934d-e0f478f7f563`
- Retrieved: `2026-08-18` (Asia/Tokyo)
- Provenance: supplied and maintained by the project owner in Notion
- Allowed use in this repository: composition, lighting, material, atmosphere, scale, and gameplay-readability reference
- Forbidden use: loading these PNGs at runtime, using them as skyboxes/background plates, tracing UI text or unrelated mechanics into the game, or treating them as proof that a generated scene passed review

Pages 08, 09, and 13 override any conflicting text, UI, story timing, object identity, or implementation implication visible in these boards. In particular, the existing two-action input contract and wordless 180-second journey remain authoritative.

## Integrity manifest

| File | Dimensions | SHA-256 |
|---|---:|---|
| `cinematic-gallery-01.png` | 1536×1024 | `a48f3863f59732b2e98579af01461913c432239de572a86388f015ffba4c74fd` |
| `cinematic-gallery-02.png` | 1536×1024 | `9cae3a1eaf2e5b7bf424450977ee006793d9a098a7d369c30031d172f7ca3325` |
| `cinematic-gallery-03.png` | 1298×1212 | `04663d646c6bf419b01472adb6dcec926002ad426733152f894b2e7e016b018a` |
| `cinematic-gallery-04.png` | 1536×1024 | `fa3d0dabd4824d75f9f36a66ef0d3870c64e23129c49e63d113addcceb864f20` |

## Hero Slice routing

- Slice A — ocean / submerged ruin: prioritize depth layers, volumetric water, bioluminescent life, restrained cinematic contrast, and clear hero silhouette.
- Slice B — sunset forest / human city: prioritize warm atmospheric perspective, believable natural surfaces, rectilinear human construction, and readable transition from nature to industry.
- Slice C — human debris / alien answer / final twinkle: prioritize deep negative space, materially distinct human debris, a non-human three-ribbon shell with a true void, and the exact late reveal timing.

Acceptance is based on live procedural rendering in both WebGPU and forced-WebGL2 modes, not resemblance from a static screenshot alone.
