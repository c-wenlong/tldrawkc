# tldrawkc

Draw a diagram on a real [tldraw](https://tldraw.dev) canvas from the command
line, take a picture of it, look, and fix it. Built for coding agents, which
write code well and read images well but cannot see what they just drew unless
something renders it.

**Status: phase 3.** `new`, `run`, `shot`, `inspect`, `export`, `from-mermaid`,
`list`, `meta set`, `api` and `doctor` work. The human view (`serve`) is
specified and not written yet; `tldrawkc help` lists which phase brings it.

## What it draws

The example snippet from the helper reference, run end to end and screenshotted
by the tool itself:

![Four boxes joined by bound arrows: agent cli to headless page labelled exec, headless page to screenshot png labelled toImage, screenshot png back to agent cli labelled read, and a dashed arrow from headless page to browser tab labelled mirror](docs/example-loop.png)

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

```bash
tldrawkc run loop.tldr --code loop.js --shot loop.png --create
```

Every arrow is bound at both ends, so moving a box drags its arrows with it.
The labels are tldraw's own Shantell Sans, bundled into the page so nothing
is fetched at render time.

## Beyond boxes and arrows

A teaching diagram is rarely only boxes and arrows. Three helpers cover what
the first real diagrams drawn with this tool had to hand-roll: geometry that is
not a connection, two panels that have to read as the same size, and a title
that belongs over the middle of both.

![Two identically sized panels side by side under a centred heading reading One vector, drawn and written. The left panel, outlined blue and labelled the arrow, holds a pair of blue axes with arrowheads, dashed blue guide lines, and a thick red arrow from the origin labelled v = (2, 3). The right panel, outlined violet and labelled the list, holds three boxes reading slot 1, slot 2 and slot 3. Under both runs a red dashed line with an arrowhead at each end, labelled the same thing](docs/example-helpers.png)

```js
helpers.line('x-axis', 120, 480, 460, 480, { color: 'blue', head: 'end' })
helpers.line('guide-across', 160, 300, 320, 300, { color: 'blue', dash: 'dashed' })
helpers.line('vector', 160, 480, 320, 300, { color: 'red', size: 'm', head: 'end' })

const left = helpers.boxShapes(['x-axis', 'y-axis', 'vector'], { label: 'the arrow' })
helpers.boxShapes(['slot-1', 'slot-2', 'slot-3'], { label: 'the list', matchSize: left })

helpers.text('title', 'One vector, drawn and written', { above: [left, 'the list'], gap: 60 })
helpers.line('rule', 120, 760, 1000, 760, { head: 'both', dash: 'dashed', label: 'the same thing' })
```

`line` is an unbound mark between two page points, for an axis, a tick, a
vector or a rule. It mutes `friendless-arrow` and `arrow-crosses-shape`,
because neither means anything for a line that was never claiming to join two
shapes. `connect` remains the only way to draw a real connection.

`matchSize` on `boxShapes`, and `alignContainers` for three or more, grow every
container to the largest width and the largest height in the set, each keeping
its own top-left. Two panels holding different numbers of shapes otherwise come
out different sizes and a reader takes the difference for meaning.

`centerOn`, `above` and `below` on `text` and `note` place a label against the
union bounds of other shapes rather than at a coordinate, and are settled after
the shape exists, so a heading that wrapped is centred on the width tldraw
measured rather than the width it was asked for.

## From mermaid

Most diagrams that already exist are mermaid, so `from-mermaid` lifts one onto
the canvas and leaves it editable. This is `test/fixtures/mermaid/subgraph-8-9.mmd`,
8 nodes, 9 edges and a subgraph, run through the command and screenshotted by
the tool:

```
flowchart TD
  agent[agent cli] --> cli[tldrawkc]
  cli --> browser[chromium]
  browser --> page[tldraw page]
  subgraph render [rendering]
    page --> shapes[shapes and arrows]
    shapes --> png[png export]
    shapes --> svg[svg export]
  end
  png --> look{Looks right?}
  svg --> look
  look -->|no| cli
```

```bash
tldrawkc from-mermaid eight.tldr --source subgraph-8-9.mmd --shot eight.png
```

![A top-down flowchart on a tldraw canvas: agent cli to tldrawkc to chromium to tldraw page, then a labelled rendering container holding shapes and arrows above png export and svg export, both feeding a Looks right? diamond, and a curved arrow labelled no running back up to tldrawkc](docs/example-mermaid.png)

Every edge is a bound arrow, the subgraph is a labelled container behind its
shapes, and the back edge is an arc routed around the column rather than a
straight line through six boxes. Anything the parser cannot read is listed
under `unsupported` instead of being dropped: mermaid's `classDef` and `class`
styling lines are the usual ones.

## The loop

One Node program and one browser page. Every command launches headless
Chromium, loads a `.tldr` file into a live tldraw editor, runs a JavaScript
snippet against it with a `helpers` bag in scope, saves the file, and
optionally writes a PNG or an SVG. The agent reads the PNG with its own image
tooling and sends the next snippet. A lint pass flags the things that go wrong
with generated diagrams, overlapping shapes, arrows pointing at nothing and
arrows drawn through boxes they have nothing to do with, and makes them a
non-zero exit code so nobody declares the drawing finished without looking. There is no daemon, no sync server, and no React in
the dependency tree of whatever repo installs this.

## Install

Needs Node 22 or newer and a Chromium. Most machines already have Google
Chrome, which is enough.

```bash
git clone https://github.com/c-wenlong/tldrawkc.git
cd tldrawkc
npm ci
npm run build
node dist/cli/index.js doctor
```

`doctor` prints one line per check and tells you which browser it picked. If
it cannot find one, either pass `--chromium <path>`, set `TLDRAWKC_CHROMIUM`,
or run `npx playwright install chromium`.

As a git submodule, which is how [self-learn](https://github.com/c-wenlong/self-learn)
uses it:

```bash
git submodule update --init tools/tldrawkc
(cd tools/tldrawkc && npm ci && npm run build)
npm run canvas -- doctor
```

## Commands

```bash
tldrawkc new diagram.tldr                 # an empty document, refuses to overwrite
tldrawkc run diagram.tldr --code draw.js --create --shot out.png
tldrawkc shot diagram.tldr                # a PNG in the temp directory, path printed
tldrawkc inspect diagram.tldr             # every shape, binding and lint. Exits 3 on lints
tldrawkc export diagram.tldr --svg out.svg --png out.png
tldrawkc from-mermaid map.tldr --source map.mmd
tldrawkc list                             # every .tldr in learn/assets, with its topic
tldrawkc meta set diagram.tldr --topic dot-product
tldrawkc api                              # what a snippet can call
tldrawkc doctor                           # node, the bundle, Chromium, the page, fonts, write access
```

`run` is the verb that matters. It loads the file, runs your snippet with
`editor`, `helpers` and `tldraw` in scope, saves, and then exports. `--code -`
reads the snippet from stdin, so an agent can heredoc one without leaving a
file behind:

```bash
tldrawkc run loop.tldr --create --shot /tmp/loop.png --code - <<'JS'
helpers.box('agent', 'agent cli', { x: 60, y: 60, w: 170, h: 64 })
helpers.box('page', 'headless page', { after: 'agent', gap: 120 })
helpers.connect('agent', 'page', { label: 'exec' })
return helpers.getLints()
JS
```

Add `--json` to any command for one machine-readable object on stdout.

### Reading, exporting, importing

`inspect` is how an agent looks before it edits: one line per shape with its
geo, position, size and label, then the bindings, then the lints. With `--json`
it prints the bridge's own structure, so the same object backs the printed view
and any other consumer.

`export` writes the files that get committed: a self-contained SVG with the
fonts inlined, a PNG, or both. Nothing is executed and nothing is saved, so the
`.tldr` cannot be damaged by an export. The SVG carries the document's title and
topic, if it has any; see below.

`from-mermaid` lifts an existing flowchart onto the canvas, which is the point
of the whole tool for a repo whose diagrams are all mermaid today:

```bash
tldrawkc from-mermaid map.tldr --source learn/map.mmd --shot /tmp/map.png
```

Without `--append` the document must not already exist, so a canvas someone has
since fixed by hand is never overwritten. Any line the parser cannot read is
reported, in the result and on stderr, and never silently dropped.

### What a diagram is about

A drawing that nothing can file is a drawing nobody finds again. Every document
can carry a small versioned object on its tldraw document record, which travels
inside the `.tldr` and needs no sidecar:

```json
{ "kc": 1,
  "title": "A vector as a list of numbers",
  "topic": "vector-and-linear-algebra-basics",
  "concepts": ["vector-as-a-list-of-numbers"],
  "source": "learn/concepts/linear-algebra/vector-as-a-list-of-numbers.md",
  "created": "2026-09-13T10:00:00.000Z" }
```

`topic` is one slug from whatever vocabulary the consuming repo keeps; in
self-learn that is `content/topics.yaml`, and `concepts` are concept ids under
it. `source` is free text: a session id, a note path, whatever prompted the
diagram. `kc` is the schema version, so a reader can refuse a shape it was not
written against. A reader keeps a version it does not know; a writer refuses
one, because this build emits the six fields it knows and rewriting a newer
object would drop what that version added. Nothing here is required, and a
document with none of it still draws, exports and loads.

Four ways in and one way out:

```bash
tldrawkc new v.tldr --topic vector-and-linear-algebra-basics --title "Vectors" \
  --concept vector-as-a-list-of-numbers --source session-42
tldrawkc meta set v.tldr --topic vector-and-linear-algebra-basics   # backfill, no browser
tldrawkc run v.tldr --eval "helpers.meta({ concepts: ['dot-product'] })"
tldrawkc inspect v.tldr --json                                      # reads it back under "meta"
```

`meta set` is idempotent: `created` is written once and preserved, so a second
identical call leaves the file alone and says `unchanged`. `helpers.meta(patch)`
merges rather than replaces, so a snippet can add a concept without restating
the title, and `helpers.meta()` with no argument reads.

`export --svg` copies the title and topic onto the exported file, as a `<title>`
element and a `data-kc-topic` attribute on the root. The `.tldr` stays the source
of truth; the SVG is derived, and it should still be able to say what it is
about when it turns up on its own.

### Listing a directory of diagrams

```bash
tldrawkc list                     # learn/assets under the working directory
tldrawkc list docs/diagrams --json
```

No browser, so it is cheap enough to run on every index. Per `.tldr`: the path,
the `.svg` and `.png` beside it and whether they exist, the metadata or `null`,
the shape count, and the mtime, sorted by path. A file that will not parse goes
in `errors` and never throws past, because one corrupt document in a directory
of thirty should not cost the answer for the other twenty-nine.

The human view is a table with the topic first:

```
topic                            shapes  svg  path
vector-and-linear-algebra-basics     43  yes  vector-as-a-list-of-numbers.tldr
(none)                               12  no   scratch.tldr
2 diagrams, 1 with a topic, 0 unreadable
```

### The lint pass

`run`, `inspect` and `from-mermaid` all report it, and a finding at error level
is exit code 3. Eight rules:

| Rule | Fires when |
| --- | --- |
| `friendless-arrow` | An arrow has no binding at one or both ends |
| `arrow-crosses-shape` | An arrow's rendered path runs through a geo or note shape that is neither of the two it connects |
| `overlapping-text` | Two text-bearing shapes' label boxes intersect |
| `overlapping-shapes` | Two shapes intersect by more than a tenth of the smaller one's area |
| `off-page` | A shape sits further than 10000 page units from the origin |
| `empty-label` | A geo shape has no text and no fill, so it renders as an unexplained outline |
| `unreadable-label` | The widest unbreakable run of a label is wider than the room the shape gives it |
| `missing-topic` | The document names no topic, so a catalog cannot file it. A **warning**: printed, and never an exit code |

`missing-topic` is the only warning. Every `.tldr` drawn before metadata existed
has no topic, and failing them all would be this tool breaking work that is
fine. It prints as `warn` rather than `lint` and `hasBlockingLints` ignores it,
so exit code 3 still means the picture is wrong.

`meta.lintIgnore` on a shape mutes a rule for it: an array of rule names, or
`true` for all of them. `helpers.stub` sets it, which is the only reason a
decorative line pointing at nothing survives the pass. A container drawn by
`helpers.boxShapes` carries `meta.container` and is exempt from
`overlapping-shapes`, `empty-label` and `arrow-crosses-shape`, because covering
its members and being crossed by arrows is what a container is for.

`arrow-crosses-shape` reads tldraw's own geometry on both sides, so an elbow
route is tested leg by leg, an arc as the polyline tldraw samples it into, and a
diamond as a diamond rather than as the page box whose four corners it leaves
empty. A shape counts as crossed only once the line is more than 4 page units
inside its outline, which is about the combined width of the two strokes: an
arrow that touches a box is two lines meeting, not a line disappearing behind
one. A concave geo (`star`, `cloud`, `heart`) is walked by sampling rather than
eroded, so an arrow threaded through a star's notch stays quiet.

### The helper reference

`tldrawkc api` prints what a snippet can call, generated from the helpers' own
JSDoc so the docs and the code cannot drift. `npm run build` regenerates
`dist/api.json` as part of the build.

The convention, which the page side has to keep to for a helper to appear:

- a `/** ... */` block sits **directly** above the declaration, with no blank
  line between them
- the declaration is a named function (`function name(`, optionally `export`
  and `async`, at any indentation) or an interface method signature
- the block carries an `@example`, because the point of the reference is a line
  an agent can copy

The first paragraph becomes the summary, `@param` lines are kept, and the
signature is the parameters as written.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done, no lints |
| 1 | Bad arguments, a missing file, or the environment (no Chromium, the page never answered, the snippet ran past `--timeout`) |
| 2 | The snippet threw. The document is untouched. |
| 3 | Saved, but lints remain. Read them and run again, or pass `--allow-lints`. |
| 4 | The export failed after a successful save. The `.tldr` is safe; run `shot` again. |

3 is deliberate. The work is real, so it is written, and the non-zero code is
what stops an agent calling a diagram finished without looking at it.

## For agents

`.claude/skills/tldrawkc-diagram/SKILL.md` is the skill a coding agent loads to
use this tool: the draw, look, fix, export loop, the snippet conventions, and
where the committed files go in self-learn, which symlinks it into its own
`.claude/skills/`.

## Design

The brief this is built from lives in the self-learn repo under
[tldraw-integration/](https://github.com/c-wenlong/self-learn/tree/main/tldraw-integration):
the decisions already made, the architecture, the full CLI reference, the
helper vocabulary, and the phase roadmap. [AGENTS.md](AGENTS.md) is the
operating manual for working in this repo.

## Licence

MIT. See [LICENSE](LICENSE).
