/**
 * Guides an agent loads on demand with design_skill. They sit behind a tool, not in the always-on
 * instructions, so every agent harness can use them and the standing prompt stays short.
 */
export interface DesignSkill {
  name: string
  summary: string
  body: string
}

export const DESIGN_SKILLS: readonly DesignSkill[] = [
  {
    name: 'workflow',
    summary: 'How to build a screen from a request or a reference image, step by step. Start here.',
    body: `Workflow for any design
1. design_list / design_read to see what exists. Make a design only if none fits (design_create).
2. Plan the regions on paper first: outer frame size, then header / body / footer, then the repeated rows. Note the sizes, the 3 to 4 surface colours, the 2 to 3 text colours, the corner radius and the type scale.
3. Build the outer frame and its regions in ONE design_add call with children nested inside (up to 800 elements and 8 levels per call). Prefer one call per region over many tiny ones.
4. Use auto layout on every row, list and stack (skill: auto-layout). Never hand-compute x/y inside them.
5. Draw every icon with design_add_svg (skill: icons).
6. Repeat rows with design_duplicate, then design_update the text of each copy.
7. design_screenshot (scale 2 for detail). Compare with the reference or request; list each difference; fix with design_update; screenshot again. Two passes minimum.
8. Name layers (Header, File row, Primary button) so the user can find them.

Mistakes to avoid: letters or emoji as icons; text on a fill instead of textColor; giving children x/y inside an auto layout frame; one huge flat frame with absolute positions; forgetting corner radius and 1px borders; stopping after the first screenshot.`,
  },
  {
    name: 'auto-layout',
    summary: 'Rows, lists, stacks, buttons, padding and spacing without computing positions.',
    body: `Auto layout
A frame with autoLayout places its children in a row or column. Do not give those children x or y.

autoLayout fields: direction "horizontal"|"vertical", gap, padding (all sides) or paddingTop/Right/Bottom/Left, alignItems "start"|"center"|"end" (cross axis), justifyContent "start"|"center"|"end"|"space-between", primaryAxisSizing and counterAxisSizing "fixed"|"hug", wrap (true for wrapping rows).
Child fields: layoutSizingH and layoutSizingV "fixed"|"hug"|"fill". "fill" stretches along the frame, "hug" fits the content, "fixed" uses the width/height you set. layoutPositioning "absolute" opts a child out (badges, overlays).
Text without a width hugs its content; with a width it wraps and grows taller.

Patterns
- Row: {type:"frame", name:"Row", width:260, height:32, fill:"transparent", autoLayout:{direction:"horizontal", gap:8, paddingLeft:12, paddingRight:12, alignItems:"center"}, children:[icon, {type:"text", textContent:"name", layoutSizingH:"fill"}, {type:"text", textContent:"+3"}]}
  The "fill" text pushes whatever follows to the right edge.
- List: a vertical frame, width 260, primaryAxisSizing "hug", gap 0 or 2, whose children are rows with layoutSizingH "fill".
- Button: horizontal frame, primaryAxisSizing "hug", counterAxisSizing "hug", padding 8 and 14, gap 6, alignItems "center", cornerRadius 8, a fill, a label text.
- Card: vertical frame, padding 16, gap 12, cornerRadius 12, 1px stroke; header row, body text, footer row.
- Toolbar or tab bar: horizontal frame, gap 4 to 8, alignItems "center"; tabs are buttons.
- Space between: justifyContent "space-between" with two children (title left, actions right).
- Centering: alignItems "center" and justifyContent "center" on a fixed-size frame.

The app works out the real sizes after each edit, so design_read shows the final x, y, width and height. To change spacing, design_update the parent's autoLayout.gap or padding; every child follows.`,
  },
  {
    name: 'icons',
    summary: 'Drawing icons and logos as vectors with design_add_svg, plus ready-made snippets.',
    body: `Icons
Always design_add_svg, never characters. Write a 24x24 viewBox SVG; stroke icons use stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none". Pass width (the drawn size, usually 14 to 20) and color (the icon colour). Put it in the row with parent, and give the returned frame no x/y inside auto layout.

Snippets (the inside of the svg element; wrap in <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">)
- chevron-down: <path d="m6 9 6 6 6-6"/>      chevron-right: <path d="m9 6 6 6-6 6"/>
- check: <path d="M20 6 9 17l-5-5"/>
- close: <path d="M18 6 6 18M6 6l12 12"/>      plus: <path d="M12 5v14M5 12h14"/>
- search: <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
- folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
- file: <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>
- git-branch: <circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 7"/>
- terminal: <path d="m4 17 6-6-6-6M12 19h8"/>
- globe: <circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>
- settings (sliders): <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>
- more (dots): <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/> (fill="currentColor")
- sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>
- arrow-up: <path d="M12 19V5M5 12l7-7 7 7"/>      arrow-down: <path d="M12 5v14M5 12l7 7 7-7"/>
- minimize: <path d="M5 12h14"/>   maximize: <rect x="5" y="5" width="14" height="14" rx="1"/>
- checkbox (checked): a 16x16 frame, cornerRadius 4, fill the accent colour, with a white check svg inside. Unchecked: same frame, fill transparent, 1.5px stroke in a muted grey.
- avatar: an ellipse with a fill and a one-letter text centred on it (a letter is fine inside an avatar).

Match the reference: stroke width 1.5 for thin UIs, 2 for bold ones; same size as the reference icon; same colour as its neighbouring text.
For logos or odd shapes, trace the reference as paths in a larger viewBox (e.g. 0 0 100 100) and keep curves as C or Q commands.`,
  },
  {
    name: 'reference-matching',
    summary:
      'Recreating a screenshot or mock closely: measuring, colours, spacing, and the compare loop.',
    body: `Matching a reference image
1. Size: make the outer frame the reference's pixel size (or exact aspect ratio at a round scale). Everything else is measured against it.
2. Regions: name them (title bar, tabs, section header, rows, footer). Draw them top to bottom as nested frames.
3. Measure, do not guess: row height, horizontal padding, gap between icon and text, icon size, font size of each text role. Rows in dense dev tools are 24 to 32 tall; body text 12 to 14; labels 11 to 12; titles 14 to 16.
4. Colours: pick them from the image and reuse. Dark UI typical: window #1a1a1a, panel #202020, raised row #2a2a2a, border #ffffff14 to #ffffff1f, text #e6e6e6, muted text #8a8a8a, accent from the image. Diff colours: add #4ade80 or #3fb950, remove #f87171 or #f85149, modified #fbbf24.
5. Type: UI text "Inter"; code, paths, numbers "JetBrains Mono" when the reference is monospace. Weight 500 for emphasis rather than 700. Check letterSpacing on small caps labels.
6. Details people notice: corner radius on the window and on selected rows, 1px borders, a subtle shadow on floating panels, selected-row background, count badges (a small rounded frame with text), the exact icon shapes.
7. Compare loop: design_screenshot, then write a list of differences, most visible first (layout, size, colour, spacing, type weight, icons), fix them in a batch with design_update, screenshot again. Repeat at least twice. Say honestly what still differs.
8. Do not tell the user it is done until the last screenshot matches on layout, colour and icons.`,
  },
  {
    name: 'ui-patterns',
    summary:
      'Ready-made structures for common UI: lists with badges, tabs, inputs, cards, panels, toolbars.',
    body: `UI patterns (all with auto layout; sizes are starting points)
- Panel / window: vertical frame, width 360 to 480, cornerRadius 12 to 16, fill surface, 1px border, padding 0. Children: title bar (horizontal, height 36 to 44, padding 12), content (vertical, layoutSizingV "fill"), footer if any.
- Tabs: horizontal frame, gap 4. Each tab: horizontal, padding 6/10, cornerRadius 6, text 13. Active tab: raised fill and bright text; inactive: transparent and muted text. A count badge is a small frame (cornerRadius 8, padding 2/6, text 11).
- Section header: horizontal, height 28, padding 12, gap 6, icon (chevron + folder), label, muted count or path suffix.
- Selectable row: horizontal, height 28 to 32, padding 12, gap 8, alignItems "center": checkbox, name (fill), +added in green, -removed in red, status letter. Selected row: raised fill and cornerRadius 6.
- Text input: horizontal frame, height 36, padding 10/12, gap 8, cornerRadius 8, 1px border, fill surface; icon and placeholder text in muted colour.
- Button primary: accent fill, white text weight 500, cornerRadius 8. Secondary: raised fill or 1px border, normal text. Icon button: 28x28 frame, centred icon, cornerRadius 6.
- Card: vertical, padding 16, gap 12, cornerRadius 12, border or soft shadow; title weight 600, body muted.
- Sidebar rail: vertical frame, width 40 to 48, padding 8, gap 8, icon buttons; the active one gets a raised fill.
- Table row: horizontal, fixed-width cells with layoutSizingH "fixed" for columns that must align, one "fill" cell for the main text.
- Badge / pill: horizontal hug frame, padding 2/8, cornerRadius 999, small text; tint fill (accent at 15% opacity, e.g. #4ade8026) with accent text.
- Divider: a frame height 1, layoutSizingH "fill", fill the border colour.

Repeat a row 5 times: build one, design_duplicate it, then design_update each copy's text. Keep the ids from the add result.`,
  },
]

export const DESIGN_SKILL_NAMES: readonly string[] = DESIGN_SKILLS.map((s) => s.name)

/** What design_skill returns: the list with no name, otherwise one skill's guide. */
export function designSkill(name: unknown): unknown {
  if (typeof name !== 'string' || !name) {
    return { skills: DESIGN_SKILLS.map(({ name, summary }) => ({ name, summary })) }
  }
  const hit = DESIGN_SKILLS.find((s) => s.name === name)
  if (!hit) throw new Error(`No skill "${name}". Available: ${DESIGN_SKILL_NAMES.join(', ')}`)
  return hit.body
}
