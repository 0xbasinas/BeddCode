# CAD third-party code

## Chili3D

Interaction patterns adapted from [xiangechen/chili3d](https://github.com/xiangechen/chili3d), which is AGPL-3.0. BeddCode does not copy, vendor, or link Chili3D source. No Chili3D file, class, or stylesheet is reproduced here.

What was studied and rewritten as original React and TypeScript:

- The floating numeric box over the viewport (`packages/ui/src/viewport/flyout`). Ours is `flyout/NumericFlyout.tsx` plus `flyout/inputState.ts`. The behaviour kept is that a drag can push a value in while typing always wins. The state machine that decides this is ours and is covered by `flyout/inputState.test.ts`.
- Step-by-step command prompts (`packages/core/src/command/multistepCommand.ts`). Ours is `steps/steps.ts` and `steps/toolSteps.ts`, a plain reducer with no Chili3D types.
- The per-kind snap switches in the status bar (`packages/ui/src/statusbar/snapConfig.ts`). Ours is `SnapMenu.tsx`, and it drives the snap resolver in `sketcher/snap.ts` which predates this work.
- The ribbon with pulldown buttons (`packages/ui/src/ribbon`). Ours is the `RIBBON_SLOTS` model and `ToolPulldownButton` in `Toolbar.tsx`.

If this ever needs more than patterns, read Chili3D's license first: AGPL-3.0 would apply to anything copied from it.

## replicad

Vendored from [sgenoud/replicad](https://github.com/sgenoud/replicad) (`packages/replicad/src`) under the MIT license.

Copyright 2023 QuaroTech Sàrl.

BeddCode keeps the sketch, shape, geometry, OpenCascade binding, and export code used for box, cylinder, sphere, extrude, revolve, fillet, chamfer, boolean, STEP, STL, and triangle meshes.

Not vendored, because this kernel does not use them:

- `text.ts` and `utils/opentype.ts` (the opentype.js font path)
- `manifoldlib.ts` and `meshShapes.ts` (manifold-3d mesh booleans)

`meshShape` and `importSTLAsMesh` were removed with the manifold files. STL import and export go through OpenCascade. `drawText` was removed with the font path. Each vendored file has the MIT header. The license text is `vendor/replicad/LICENSE`.

`lib2d/stitching.ts` imports the npm package `flatbush` (ISC, Vladimir Agafonkin). That package is a dependency, not copied source.

## OpenCascade WASM

The kernel loads the npm package `replicad-opencascadejs` (LGPL-2.1) at runtime. The WASM binary ships unmodified from that package. BeddCode does not copy or change OpenCascade C++ or the opencascade.js glue.

Source for this WASM build: [replicad-opencascadejs](https://github.com/sgenoud/replicad/tree/main/packages/replicad-opencascadejs).

Open Cascade Technology: [OCCT](https://github.com/Open-Cascade-SAS/OCCT) (LGPL-2.1).

The LGPL-2.1 text is the `LICENSE` file of the `replicad-opencascadejs` package.
