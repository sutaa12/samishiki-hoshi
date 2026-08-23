# Annotation measurement method

Task ID: QX-R4-R01

All values are manual normalized-screen estimates from the official URL and exact timecode/frame locator. The coordinate origin is the top-left visible media pixel; x increases rightward and y downward. Measurements exclude letterbox bars, browser chrome, captions, and publisher overlays. They are rounded to the nearest whole percentage point and carry an expected reading uncertainty of plus or minus 2 percentage points. They are corpus observations, not source-authoritative telemetry.

`PlayerOccupancy` intentionally records three independent quantities:

- `xA-B yC-D` is the normalized localization band in which an uninformed viewer should search for the protagonist. It is not a tight geometric bounding box.
- `height H%` is the protagonist's visible vertical silhouette span, including attached trails or limbs when they are visually continuous.
- `area A%` is approximate non-background protagonist occupancy, estimated independently of the localization band. Divide the visible media into a 20x20 grid, count cells whose centers fall on the protagonist's contiguous silhouette, count attached trails or limbs only when visually continuous, and divide by 400; isolated particles and shadows are background.

`VanishingPoint` is normalized x/y. `RouteCorridor` is the route width at player depth. Near/Mid/Far are categorical depth layers. Material identity records only separability of broad surface classes.

TTC, feedback onset, peak, recovery, and objects-per-second require a moving source plus a frame-by-frame procedure. A single official still is recorded as `N/A official still`; no timing value is inferred from apparent scale. The current R01 corpus does not claim measured external-game timing. Numeric TTC or latency values in hypotheses are future LonelyStar test thresholds, not observed reference facts.
