# Third-party notices

The release-copy notice is stored at `public/THIRD_PARTY_NOTICES.txt` so the
production build contains it. `package-lock.json` has exactly four non-dev
runtime packages: React `19.2.6`, React DOM `19.2.6`, Scheduler `0.27.0`, and
Three.js `0.185.1`; all four declare MIT and have installed license texts.

## React, React DOM, and Scheduler

- Versions: React `19.2.6`, React DOM `19.2.6`, Scheduler `0.27.0`
- Source: https://github.com/facebook/react
- License: MIT; installed texts are available at `node_modules/react/LICENSE`,
  `node_modules/react-dom/LICENSE`, and `node_modules/scheduler/LICENSE`.
- Copyright: Meta Platforms, Inc. and affiliates.

## three.js

- Version: `0.185.1` (locked by `package-lock.json`)
- Source: https://github.com/mrdoob/three.js
- License: MIT; the installed license text is available at `node_modules/three/LICENSE`.
- Use in this branch: existing direct dependency plus the `three/webgpu` renderer and `three/tsl` node APIs.

No external demo, shader, image, model, texture, audio source, or remote font
has been imported into the graphics-rebaseline worktree. The B-spline,
parallel-transport, superformula, procedural texture, hydrology, atmosphere,
and particle implementations are repository-authored code rather than copied
demo techniques. Final public/contest rights acceptance remains human-owned.
