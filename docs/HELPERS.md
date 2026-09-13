# The helpers bag (specification)

What a snippet passed to `tldrawkc run` can call. Three names are in scope:

| Name | What |
| --- | --- |
| `editor` | The live tldraw `Editor`. Full power, no guard rails. |
| `helpers` | The functions below. Prefer these; they are what keep arrows bound and layouts sane. |
| `tldraw` | The `tldraw` module: `createShapeId`, `toRichText`, `Box`, `Vec`, and every other export. |

The snippet body is wrapped in an async function, so top-level `await`
works and a `return` value comes back to the CLI as `result`. A thrown error
rolls back every change the snippet made.

This API is modelled on the tldraw offline app's `helpers`, which produced a
clean ERD with bound, right-angled arrows in the design session that started
this tool. Where the offline app has a helper, keep the same name so agents
that already know one tool know the other.

## Shapes

### `helpers.box(key, label, opts)`

Creates a labelled geo shape and returns its id. The first argument is a
shape *key*, which is what the code calls it (`ShapeKey = string | TLShapeId`)
and what `api` prints: a plain slug like `'query'`, or a real `shape:` id.
The helper calls `createShapeId` on it so ids are stable and readable
(`shape:query`, not `shape:8f3a...`). Creating a key that already exists
updates that shape instead of throwing, so snippets can be re-run. Every other
helper takes keys in the same sense, `connect`'s two endpoints included.

`createShapeId(key)` is literally `` `shape:${key}` ``, with no check for a
prefix that is already there, so feeding it a real id would give
`shape:shape:query`. The helpers strip the prefix first and accept either form.

| Option | Default | Notes |
| --- | --- | --- |
| `x`, `y` | required unless `after` or `below` is given | Page coordinates of the top-left corner |
| `w`, `h` | 180 x 64 | `h` is a minimum, not the height: tldraw grows a geo shape with `growY` when its label wraps. Read `getShapePageBounds` when placing something against a box, never `props.h` |
| `geo` | `rectangle` | Any tldraw geo: `rectangle`, `ellipse`, `oval`, `diamond`, `cloud`, `hexagon`, `triangle`, `star`, ... (`oval` is the capsule shape; there is no `pill`) |
| `color`, `fill` | `black`, `none` | tldraw style values |
| `font`, `size` | `draw`, `m` | |
| `align`, `verticalAlign` | `middle`, `middle` | A long label wants `verticalAlign: 'start'` and a taller box, not a separate text shape |
| `after: otherId, gap` | gap 120 | Place to the right of another shape, same y |
| `below: otherId, gap` | gap 120 | Place under another shape, same x |
| `parent` | page | A frame or group id. The coordinates given are page coordinates, as everywhere else in this API; the helper converts them into the parent's space, because tldraw reads a child's `x` and `y` there |

`DEFAULT_GAP` for `after` and `below` is 120 page units. A tighter gap is legal
and sometimes right, but at 60 or less tldraw has almost no line to draw a
label on and the result reads as a word floating between two boxes.

### `helpers.text(id, str, opts)`

A standalone text shape for headings and free labels. Same placement
options as `box`, plus the three below. Words that belong to a shape go in
that shape's label, not here.

### `helpers.note(id, str, opts)`

A sticky note. For asides and "why" callouts in teaching diagrams. A note
takes no `w` or `h`: `TLNoteShapeProps` carries `size`, `growY` and
`fontSizeAdjustment`, and tldraw sizes the note from its `size` style, grows
it down to fit, and shrinks the font rather than overflowing.

### Placing a `text` or a `note` against other shapes

Both take three options that position a label against what it is labelling
rather than at a coordinate.

| Option | Notes |
| --- | --- |
| `centerOn: ids` | Centres horizontally on the union bounds of those shapes, at the `y` given |
| `above: ids` | Sits `gap` clear over them, and centres |
| `below: ids` | Sits `gap` clear under them |

All three are settled after the shape exists, against the bounds tldraw
reports, so a heading that wrapped is centred by its measured width rather
than by the width it asked for. A single key in `below` still shares that
shape's left edge the way `box` does; a list, or any placement alongside
`centerOn`, uses the union bounds and centres.

### `helpers.remove(ids)` and `helpers.clear()`

Delete by id, or delete every shape on the current page. `clear` is refused
unless the current page held nothing when this `exec` started, or it is called
as `helpers.clear({ force: true })`.

That is what "the snippet did not create the document" had to become in
practice. The bridge records how many shapes each page held in `beginExec()`,
once, before the snippet runs, so the permission is per page and per `exec`: a
snippet that draws a page and then clears it to start over still passes,
because the check reads the state at the start rather than the state now, and
`editor.setCurrentPage` onto a page full of someone else's work does not
inherit the permission from the page the snippet did create.

A page the snippet itself added is not in that record at all, which reads as
zero and is correct: a page that did not exist when `exec` started is as owned
as a page can get. It used to be read as "not permitted", so `helpers.page(...)`
followed by `clear()` was refused with a message that also misquoted the count,
saying the page "already held 1 shape(s) when the snippet started" about a page
that had not existed. The refusal now quotes the count it actually checked.

Commands are stateless (D2), so the permission does not survive one. A second
`run` against a saved document loads a page with shapes on it, that page was
not empty when its `exec` started, and `clear()` is refused. Wiping a document
a previous command wrote needs `{ force: true }`, which is the point.

### `helpers.page(name)`

Switch to the page with that name, adding it when the document has none, and
return its id. Everything drawn after the call lands there, and the same name
is what `--page` takes on `run`, `shot`, `inspect`, `export` and
`from-mermaid`.

Select-or-create rather than create, because `editor.createPage` uniquifies a
name it has seen before: creating `details` twice leaves a second page called
`details (1)`, so a snippet re-run against its own document would stack a new
page on every pass. For the same reason the id is read back by diffing the page
list rather than by looking the name up again.

Two things follow from how a `.tldr` is loaded. The page **order** survives a
save and a load, but the **current page** does not: the file is read back
document-scope only, so every command opens on the first page and `--page` is
how to say otherwise. And the lint pass reads the current page, so a `run` that
ends on page two is linted against page two, and a finding on one page never
appears in the other page's `inspect`.

### `helpers.plainText(shape)`

The visible text of a shape, read from its rich text. Use this rather than
parsing `props.richText`.

## Connections

### `helpers.connect(fromId, toId, opts)`

The only sanctioned way to draw a meaningful arrow. Creates an arrow shape
with a real binding at both ends and returns the arrow id. Both ends follow
their shapes when moved.

| Option | Default | Notes |
| --- | --- | --- |
| `label` | none | Arrow label text |
| `kind` | `elbow` | `elbow` for horizontal and vertical segments with right-angle bends, `arc` for a straight or curved line |
| `start`, `end` | auto | Anchor on each shape as `{ x: 0..1, y: 0..1 }`, or a side name: `top`, `right`, `bottom`, `left`. Auto picks the facing sides. |
| `bend` | 0 | For `arc` only |
| `mid` | 0.5 | For `elbow`: where along the path the bend lands, 0..1. Use it to keep parallel arrows in separate lanes. |
| `head` | `end` | `end`, `both`, `none` |
| `labelPosition` | 0.5 | 0..1 along the arrow |
| `color`, `size`, `dash` | `black`, `s`, `draw` | |

The arrow's id is derived from the pair, `shape:arrow:<from>-><to>`, which is
what makes `connect` idempotent: re-running a snippet updates the same arrow
instead of stacking a second one on it. A shape id containing `->` is refused
rather than encoded, because `a->b` to `c` and `a` to `b->c` would derive the
same arrow id and the second call would silently steal the first one's arrow.
`opts.id` names a second arrow between the same pair.

`connect` derives nothing beyond that pair: it has no automatic repeat
handling, so a caller drawing the same pair twice has to pass `opts.id`.
`applyPlan` is the caller that does, appending `#2`, `#3` and so on to the
derived key (`arrow:<from>-><to>#2`) and nudging each repeat's `mid` by 0.15
so the lanes separate instead of stacking. A back edge, one whose target sits
at an earlier rank, is not routed as an elbow at all: the elbow router only
knows its two endpoints, so a `look --> cli` in a top-down flowchart drew a
vertical line through six boxes. `applyPlan` switches it to an `arc` anchored
on the outside face of both shapes, with a bend that puts the apex clear of
the widest shape on that side.

The binding's props also include `snap`, an `ElbowArrowSnap` (`center`,
`edge-point`, `edge` or `none`) that the validator requires.
`ArrowBindingUtil.getDefaultProps()` supplies it, so the helper passes a
partial `props` and does not set it. The same goes for `isExact`.

The arrow schema's own default `kind` is `arc`, not `elbow`, so `connect` sets
`kind` on every arrow rather than relying on the shape default. Elbow routing
reads `props.elbowMidPoint` (that is what `mid` sets); `bend` is an arc-only
field and the two are separate.

Every binding is `isPrecise: true`, auto ends included, because an imprecise
binding ignores `normalizedAnchor` and aims the terminal at the shape's centre.
Two boxes whose centres differ (any row where one label wrapped and grew its
box) then get a short dog-leg that the arrow label sits on top of, and it reads
as a broken arrow. `opts.precise: false` hands the entry point back to tldraw's
router for the rare case that wants it.

An end the caller did not name gets its anchor from the band where the two
shapes' extents overlap: one page-space line is run down that band and both
anchors are put on it, so the arrow is straight whenever a straight arrow is
possible. Shapes that do not overlap at all fall back to the plain side
midpoint, where a bend is unavoidable anyway.

The elbow router is tldraw's own; the helper's job is anchors, mid point and
binding, not path maths.

### `helpers.attribute(ownerId, label, side, opts)`

An ERD convenience: a short text shape placed off one side of a box and
joined by a bound line with no arrowhead. `side` is `top`, `right`,
`bottom` or `left`; `opts.at` (0..1) spaces several attributes along the
same side; `opts.gap` is the stub length. Returns `{ textId, lineId }`.

The "line" is an arrow shape with `arrowheadStart` and `arrowheadEnd` both
`none`, because an arrow is the only tldraw shape that can carry a binding. A
real `line` shape would be a loose mark that stays put when its owner moves.

### `helpers.line(id, x1, y1, x2, y2, opts)`

An unbound mark between two page points: an axis, a tick, a vector, a rule
under a heading. It binds to nothing, so it stays where it was put; anything
joining two shapes is `connect` instead.

| Option | Default | Notes |
| --- | --- | --- |
| `color`, `size`, `dash` | `black`, `s`, `draw` | |
| `head` | `none` | `none`, `end`, `start`, `both` |
| `kind` | `arc` | `arc` for a straight or curved line, `elbow` for right-angled segments |
| `bend` | 0 | For `arc` only |
| `label`, `labelColor` | none, follows `color` | |
| `parent` | page | A frame or group id. The points given stay page coordinates; the helper converts them |
| `meta` | none | Arbitrary record metadata |
| `lintIgnore` | `['friendless-arrow', 'arrow-crosses-shape']` | Rule names, or `true` for all of them |

It mutes `friendless-arrow` and `arrow-crosses-shape` by default, because
neither rule means anything for geometry that never claimed to join two
shapes; pass `lintIgnore: []` to have it linted like any other arrow. The id
is derived from the key, so re-running a snippet moves the line rather than
stacking a second one on it.

### `helpers.stub(id, x, y, dx, dy, opts)`

`line` with a delta instead of a second point, which is the convenient form
for the loose marks in a legend. It takes the same options and now honours
them: it used to accept `color`, `size` and `dash` and throw them away, so a
legend dash asked for in red came out black.

## Layout

### `helpers.row(ids, opts)` and `helpers.column(ids, opts)`

Lay existing shapes out in a line with `gap` (default 40), aligned on
`align` (`start`, `center`, `end`), starting from the first shape's
position or from `opts.x`, `opts.y`.

### `helpers.grid(ids, cols, opts)`

Rows of `cols` shapes with `gapX`, `gapY`.

### `helpers.boxShapes(ids, opts)`

Draws a labelled container behind a set of shapes with a margin (default
40) and returns the container id. `opts.label`, `opts.color`,
`opts.shapeId`. Used for grouping ("events", "browser process") and for
mermaid subgraphs. The container is a geo rectangle, sent to back, not a
frame, so the enclosed shapes keep page coordinates. It carries
`meta.container = true`, which is how the lint pass knows to exempt it from
`overlapping-shapes`, `empty-label` and `arrow-crosses-shape`. The third is
the one phase 3 added: an arrow that enters or leaves a group has to cross
the box drawn round it, so a container that counted as something to run
through would fire on every edge into a subgraph.

`opts.matchSize: otherContainerId` puts this container and that one on one
size, and `opts.minW` and `opts.minH` put a floor under it whatever its
members need.

### `helpers.alignContainers(ids, opts)`

Puts every listed container on one size, the largest width and the largest
height in the set taken independently, each keeping its own top-left. That is
`matchSize` generalised past a pair, and it exists because two panels drawn
round different numbers of shapes otherwise come out visibly different sizes
and the reader takes the difference for meaning. `opts.axis` is `both`
(default), `x` or `y`.

The size is applied as a difference to `props.w` and `props.h` rather than
assigned, because `growY` on a wrapped label means two shapes given the same
`props.h` still render at different heights. Containers are sent to the back
again afterwards, since resizing one is an update and an update lifts it over
its own members.

### `helpers.translate(ids, dx, dy)`

Move shapes and let bound arrows follow.

### `helpers.fitCamera(opts)`

Fits the camera to all shapes. With no options it is `editor.zoomToFit()`;
with `opts.padding` it computes the page bounds and calls
`editor.zoomToBounds(bounds, { inset: padding })`, because `zoomToFit`
itself takes no padding. Exports frame to shape bounds on their own, so
this matters only for `--headed` runs and serve mode.

## Import

### `helpers.mermaid(source, opts)`

Parses a mermaid `flowchart` or `graph` and creates boxes, bound arrows and
containers for subgraphs. `opts.direction` overrides the header,
`opts.origin` sets the top-left, `opts.spacing` sets rank and node gaps.
Returns five keys, not three: `{ nodes: { mermaidId: shapeId }, edges:
[arrowIds], containers: [containerIds], unsupported: [lines], lints: Lint[] }`.
`from-mermaid` in [CLI.md](CLI.md) is this helper behind a command.

Internally it is two functions, and the split is what makes the parser
unit-testable without a browser:

| Function | Where | What |
| --- | --- | --- |
| `parseMermaid(source, opts): Plan` | `page/helpers/mermaid.ts`, pure, no editor | Tokenises the flowchart, assigns each node a rank (longest path from the sources) and a slot within the rank, and returns a `Plan`. |
| `applyPlan(plan): result` | `page/helpers/mermaid-apply.ts`, needs `editor` | Creates the shapes with `box`, the arrows with `connect`, the subgraph containers with `boxShapes`. |

`applyPlan` lives in its own file rather than beside the parser, because
`mermaid.ts` must stay importable with no tldraw in scope: that is what lets
the unit suite run `parseMermaid` in node.

```ts
type Plan = {
  direction: 'TD' | 'TB' | 'LR' | 'RL' | 'BT'
  nodes: Array<{ id: string; label: string; geo: 'rectangle' | 'oval' | 'ellipse' | 'diamond'; rounded?: boolean; x: number; y: number; w: number; h: number; subgraph?: string }>
  edges: Array<{ from: string; to: string; label?: string; dashed?: boolean; headless?: boolean }>
  subgraphs: Array<{ id: string; label: string; nodeIds: string[]; parent?: string }>
  unsupported: string[]
}
```

`geo` is a closed four-name union, not an open string: those are the only
shapes mermaid's node syntax can ask for. `rounded` is set only by mermaid's
`id(text)`, which has no geo of its own, and `applyPlan` turns it into `oval`
because tldraw 5 has no rounded rectangle and no corner-radius prop. The cost
is that `id(text)` and `id([text])` render identically. `headless` marks an
open link (`a --- b`, `a -.- b`, `a === b`), which is drawn as an arrow with
no head rather than declined. `parent` on a subgraph is the only record of
nesting, because `nodeIds` holds direct members and an outer block whose
children are all subgraphs has none of its own.

Three legal mermaid constructs land in `unsupported` rather than on the
canvas: a self loop (`a --> a`, which `connect` refuses and which would roll
the whole import back), a link naming a subgraph as an endpoint (`groupA -->
groupB`, mermaid's cluster link, which would invent a box beside the
container), and the styling statements `classDef`, `class`, `style`,
`linkStyle`, `click`, `direction`, `accTitle` and `accDescr`. The nodes a
declined line names are still declared.

`--append` reuses the box an existing mermaid id already has, rather than
adding a second one or refusing. That is `box`'s documented idempotence, and
it is what makes re-importing an edited flowchart work. Two independent
flowcharts on one canvas need distinct ids or separate pages.

The layout is deliberately simple. The agent is expected to look at the
result and nudge.

## Metadata

### `helpers.meta(patch)`

Read or amend what this diagram is about: the same `{ kc, title, topic,
concepts, source, created }` object `inspect --json` reports under `meta`
and `list` reports per file. See "What a diagram is about" in
[CLI.md](CLI.md) for the shape and why it lives on the document record.

With no argument it reads and returns the object, or `null` when the
document carries none. With a patch it merges into whatever is already
there, so a snippet can add a concept mid-session without restating the
title, and it lands on the document record straight away, no `save()`
required first. `created` is written once and then left alone regardless of
what a later patch says.

```js
helpers.meta({ topic: 'dot-product', concepts: ['vector-as-a-list-of-numbers'] })
const topic = helpers.meta()?.topic ?? '(none)'
```

## Reading and checking

### `helpers.describe()`

The same structure `inspect` prints: every shape with bounds and text,
every binding, every lint. Snippets call it to decide what to do next
without a second CLI round trip.

### `helpers.getLints()`

Returns `Lint[]`, the same array the bridge's `lints()` returns. Nine rules:
six from v1, `arrow-crosses-shape` added in phase 3, `missing-topic` added
alongside document metadata, and `missing-glyph` added in phase 4.

| Rule | Fires when |
| --- | --- |
| `friendless-arrow` | An arrow has no binding at one or both ends and no `meta.lintIgnore` |
| `arrow-crosses-shape` | An arrow's rendered path runs more than 4 page units inside a geo or note shape that is neither of the two it connects. Containers (`meta.container = true`) and the arrow's own parent are exempt |
| `overlapping-text` | Two text-bearing shapes' label boxes intersect |
| `overlapping-shapes` | Two geo shapes intersect by more than 10 percent of the smaller one's area. Shapes with `meta.container = true` (from `boxShapes`) are skipped on both sides of the pair. |
| `off-page` | A shape sits further than `OFF_PAGE_LIMIT` (10000 page units) from the origin in any direction, positive or negative |
| `empty-label` | A geo shape has no text and no fill and is not a container, so it renders as an unexplained outline |
| `unreadable-label` | The widest unbreakable run of a label is wider than the shape, or the widest line it renders as is wider than the outline leaves room for across the rows that line sits on |
| `missing-glyph` | A label's font has no glyph for a character in it, so the reader's machine picks the typeface. `draw` (Shantell Sans) and `mono` have no `θ λ α β σ μ`, though `π` is there; no bundled font has `⇒ ∈ ∉ ⊂ ∪ ∩ ∀ ∃ ∧ ∨ ∇`. A warning, like `missing-topic` |
| `missing-topic` | The document names no topic, so a catalog cannot file it |

Three of those rows were written from a guess and are corrected here against
what the code measures.

`missing-topic` and `missing-glyph` are the two rules at `severity: 'warn'`
rather than the implicit `error`. They print, and `helpers.getLints()` still
returns them, but `hasBlockingLints` ignores anything at `warn`, so neither
turns into exit code 3 on its own. Every `.tldr` drawn before each rule
existed would fail it on sight, and a lint that failed all of them at once
would be this tool breaking work that was already fine. The rules exist so a
catalog can say "not filed yet" and a reader can be warned that a label is
about to render in a font nobody chose, not to gate a diagram that draws
correctly.

`missing-glyph` names a family that can draw the label, usually `sans`. It
checks against a table generated from the font files themselves into
`src/page/helpers/font-coverage.ts`; `npm run generate:fonts` rewrites it and
a test regenerates and diffs, so a tldraw upgrade cannot leave it stale. The
table is read out of each woff2's own `cmap`, because neither
`document.fonts.check()` nor a canvas measurement can answer "does this face
have this glyph"; see D43 in [DECISIONS.md](DECISIONS.md).

The one character maths labels get blamed for is fine. **`√` is present in all
four families**, and in `draw` it is hand-drawn to look like a `v` beside its
own `v`, which is why it reads as a variable and why maths still looks better
in `sans`. No lint can fire on it, because nothing is missing.

`arrow-crosses-shape` is about depth, not length: the shape's outline is
eroded by 4 page units and the arrow's path is tested against what is left.
4 is tldraw's own stroke width for a size `m` shape, rounded up, so an arrow
that merely touches a box stays silent and one that disappears behind it does
not. The test runs against the rendered outline rather than the page box,
because a diamond's box has four empty corners an arrow can pass through
without touching the shape, and a concave outline (`star`, `cloud`, `heart`)
is sampled rather than eroded so a working diagram is never failed on
geometry the rule cannot model. `meta.lintIgnore: ['arrow-crosses-shape']` on
either the arrow or the shape is the opt-out, and it is the right answer for a
marker an arrow is meant to run through, such as a dot at the origin of a set
of axes.

`off-page` is not about clipping. Nothing clips at a large coordinate:
`toImage` and `getSvgString` both framed a box at x = 200000 correctly. What
breaks is the frame, because every export is framed to the union of the
shapes, so one stray shape at 10000 units makes a frame 10000 units wide and
`MAX_SHOT_EDGE` (4096 px) scales it to about 0.4 px per unit. A normal 64-unit
box then renders 26 px tall and unreadable. That measurement is where the
limit of 10000 comes from, and it is why the rule fires in every direction
rather than only at negative coordinates.

`unreadable-label` is two checks under one name, because to a reader they are
the same complaint: the shape cannot hold its label.

The first cannot be a width comparison. tldraw's label CSS is
`overflow-wrap: break-word`, so a long word is broken mid-word into stacked
fragments instead of spilling out, and a naive check never fires. The rule
measures with tldraw's own measurer,
`editor.textMeasure.measureText(text, { ..., measureScrollWidth: true,
disableOverflowWrapBreaking: true })`, whose `scrollWidth` reports the widest
run that cannot be broken, and compares it against the shape's own unrotated
width rather than its page box, which a rotation inflates.

The second is about the outline, and the first is blind to it. The box a
label wraps inside is the shape's bounding box, and a diamond is only that wide
along one line through its middle, so a label can wrap politely, break nothing,
and still run out through both slanted edges. So the rule asks the rendered
outline instead: it intersects the polygon `getShapeGeometry` reports with the
rows the text occupies, takes the narrowest horizontal run across them, and
compares that against the widest line the label actually renders as. Where the
ink sits across the shape counts as well as how wide it is, because
`align: 'start'` and `align: 'end'` push a label to one side of the bounding
box, and off to one side of a diamond a line narrower than the chord can still
cross the edge it was pushed towards. So what the run gives back is the widest
span centred on the ink that fits inside it. A
rectangle's outline gives the label every unit of its width and reports no
usable width at all, which is why this check is purely additive and cannot
change what the rule says about a plain box. `triangle`, `star`, `hexagon`,
`cloud`, `heart` and the two round geos pinch to the degree their outlines do.

That widest rendered line needs its own measurement, and `measureText` cannot
supply it: its element carries a `max-width`, so CSS shrink-to-fit reports the
smaller of the text's one-line width and that maximum, and a label that wraps at
all comes back as exactly the width it was allowed rather than the width it
used. `measureTextSpans` lays the text out and returns a box per run of
characters, which grouped by top edge gives the real lines. It runs only on a
shape whose outline pinches, since it is the most expensive measurement in the
pass and on a box it can say nothing new.

The slack on the outline check is 16 page units, tldraw's own label padding and
about half a character at the default label size, against 1 on the width check.
Both sides of that comparison approximate the picture: a curve arrives as a
sampled polygon whose chords lie inside it, and the band is taken across the
whole block of text where the top and bottom rows hold only ascenders and
descenders. Measured against the fixtures, a label that visibly crosses an
outline overshot by 34, 43 and 58 units, and one that merely touches an ellipse
overshot by 5.

Shapes whose label can never overflow are exempt from both: a note, which has no
`w` or `h` and shrinks its font instead, and an auto-sized `text` shape, which
grows.

`overlapping-shapes` and `overlapping-text` both respect rotation.
`overlapping-shapes` compares page bounds, which tldraw already computes as
the rotated shape's box. `overlapping-text` runs all four corners of the
label rectangle through `getShapePageTransform` rather than the two on one
diagonal, because under rotation those two no longer bound the box.

`run` calls this after every snippet and returns exit code 3 when the list
holds anything at error level. Lints are advisory about intent (a legend stub
is fine) but strict about the two failure modes that made hand-written SVG
unreliable: overlaps and arrows pointing at nothing.

## Example snippet

The three-box loop from the design session, written against this API:

```js
helpers.box('agent', 'agent cli', { x: 60, y: 60, w: 170, h: 64 })
helpers.box('page', 'headless page', { after: 'agent', gap: 120, w: 190, h: 64 })
helpers.box('png', 'screenshot png', { below: 'page', gap: 90, w: 190, h: 64 })
helpers.box('tab', 'browser tab', { after: 'page', gap: 140, w: 170, h: 64 })

helpers.connect('agent', 'page', { label: 'exec' })
helpers.connect('page', 'png', { label: 'toImage' })
helpers.connect('png', 'agent', { label: 'read', start: 'left', end: 'bottom' })
helpers.connect('page', 'tab', { label: 'mirror', dash: 'dashed' })

return helpers.getLints()
```

The gaps are 120 and 140 because a labelled arrow needs room: at the 80 and 60
this example used to carry, the `mirror` label covers the whole gap and lands
on both box outlines.

Followed by `tldrawkc shot loop.tldr`, a look at the PNG, and a second
snippet that nudges whatever is off.
