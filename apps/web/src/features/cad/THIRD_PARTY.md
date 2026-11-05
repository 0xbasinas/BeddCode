# CAD third-party code

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
