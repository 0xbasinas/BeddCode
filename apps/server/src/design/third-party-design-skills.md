# Design knowledge sources

The design agent's `design-quality`, `layout-review`, `typography-review`, and `color-and-surfaces` guides adapt principles from [Interfaces skills](https://github.com/jakubkrehel/skills), commit `60bf140e43c98b248e6594487384ec967e89d98a`, copyright 2026 Jakub Krehel. The source license is in `LICENSE.krehel-skills.txt`. The guide is adapted for BeddCode's editable canvas and does not reproduce the source's code-review workflows.

`uiUxCatalog.ts` contains selected fields from the product, styles, colors, typography, UX guidelines and app interface CSV files of [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill), commit `3a13158ff1f32156cbe144108de48eda2ecaed9a`, copyright 2024 Next Level Builder. The source license is in `LICENSE.ui-ux-pro-max.txt`. Only active style entries are included. Catalog results are advisory; they do not establish that a particular font is installed or that a design is accessible.

The catalog is bundled so search works offline and without Python. To update it, regenerate the selected fields from the upstream CSV files and update the pinned revision and license if applicable.
