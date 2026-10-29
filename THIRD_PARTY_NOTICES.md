# Third-party notices

BeddCode adapts code from the open-source projects below. Each adapted file says so at its top
and names what was changed. The licenses' required notices follow.

| Source                                                                                                                                                         | License    | Used in                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [T3 Code](https://github.com/pingdotgg/t3code)                                                                                                                 | MIT        | `apps/server/src/workspace/editors.ts` (editor table, install paths, launch arguments), `packages/client-runtime/src/commandRanking.ts` (match scoring), `apps/web/src/features/palette/CommandPalette.tsx` (palette interaction) |
| [paseo-worktreeinclude](https://github.com/cprecioso/paseo-worktreeinclude), via [Paseo](https://github.com/getpaseo/paseo/tree/main/plugins/worktree-include) | MIT        | `apps/server/src/workspace/worktreeInclude.ts`                                                                                                                                                                                    |
| [Paseo](https://github.com/getpaseo/paseo)                                                                                                                     | Apache-2.0 | `packages/client-runtime/src/reviewComments.ts` (diff review comments, review message format), `apps/web/src/features/git/ReviewBar.tsx`, the review mode of `apps/web/src/ui/PatchView.tsx`                                      |

Projects studied for ideas only, with no code copied: Synara (MIT, a T3 Code fork),
MonoCode (MIT), opencode (MIT), Crystal (MIT), Claude Code UI (AGPL-3.0) and Zed (GPL/AGPL).

---

## T3 Code

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## paseo-worktreeinclude (Paseo worktree-include plugin)

```
MIT License

Copyright (c) 2026 Carlos Precioso

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Paseo

```
Copyright (c) 2025-present Mohamed Boudra

Licensed under the Apache License, Version 2.0 (the "License");
you may not use these files except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

The full license text is in [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt). The files
listed above were modified for BeddCode: they work on BeddCode's unified-diff text instead of
Paseo's parsed diff model, capture the context when the comment is made, render the review as
Markdown for any agent, and use BeddCode's stores and components. Paseo ships no NOTICE file.
