# tldrawkc

Draw a diagram on a real [tldraw](https://tldraw.dev) canvas from the command
line, take a picture of it, look, and fix it. Built for coding agents, which
write code well and read images well but cannot see what they just drew unless
something renders it.

**Status: phase 4, complete.** Every verb in the reference works: `new`, `run`,
`shot`, `inspect`, `export`, `from-mermaid`, `list`, `meta set`, `serve`, `api`
and `doctor`.

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
non-zero exit code so nobody declares the drawing finished without looking.
There is no daemon, no sync server, and no React in the dependency tree of
whatever repo installs this. `serve` is the one command that stays up, and it
is for a human to watch: see "Watching it, and nudging it" below.

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

## Ways in

Five surfaces over the same library. Each row links the section that covers it.

| Way in | What it is |
| --- | --- |
| CLI | `tldrawkc <verb>` after a build, or `npm run --silent canvas -- <verb>` from a host repo that wires it as a script. See [Commands](#commands) |
| Agent skill | `.claude/skills/tldrawkc-diagram/SKILL.md`, the draw, look, fix, export loop a coding agent loads. See [For agents](#for-agents) |
| Library | `import { ... } from "tldrawkc"`, JSON in and JSON out, for Node code that wants the verbs without spawning a shell. See [Library](#library) |
| `serve` | A real browser tab with tldraw's full UI, for a human to watch and nudge while an agent draws. See [Watching it, and nudging it](#watching-it-and-nudging-it) |
| MCP | Not built. Phase 5 of the [roadmap](docs/ROADMAP.md), waiting on a second client such as Claude Desktop or Cursor. The library API is JSON in and out, so the wrapper would be thin |

## Commands

```bash
tldrawkc new diagram.tldr                 # an empty document, refuses to overwrite
tldrawkc run diagram.tldr --code draw.js --create --shot out.png
tldrawkc shot diagram.tldr                # a PNG in the temp directory, path printed
tldrawkc inspect diagram.tldr             # every shape, binding and lint. Exits 3 on lints
tldrawkc export diagram.tldr --svg out.svg --png out.png
tldrawkc export diagram.tldr --svg out.svg --no-subset-fonts   # whole fonts, for a hand edit
tldrawkc from-mermaid map.tldr --source map.mmd
tldrawkc list                             # every .tldr in learn/assets, with its topic
tldrawkc meta set diagram.tldr --topic dot-product
tldrawkc serve diagram.tldr               # open it in a real browser tab, until Ctrl+C
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

#### The fonts in an exported SVG

The fonts have to be inline. An SVG that a reader loads as an image (an
Obsidian embed, a GitHub blob, an `<img src>`) fetches nothing at all, so a
family that is not in the file is a family the reader never sees, and the
labels silently come out in a system font.

Inlining the whole of every family is expensive: Shantell Sans alone is about
205 kB of base64, and a teaching diagram uses forty characters of it. So
`export --svg` and `run --svg` cut each inlined face down to the characters the
document actually draws, and drop any family nothing references. On the
eight-node flowchart in `test/fixtures/mermaid/subgraph-8-9.mmd` that is
205 kB of font down to 32 kB, with the picture rendering pixel for pixel the
same.

Pass `--no-subset-fonts` to inline the whole families instead. That is what a
diagram you mean to edit by hand in the SVG later wants: a subset font has no
glyph for a letter the drawing does not already contain.

`--json` reports `svg.bytes` and `svg.fontsSubset` on `export`, and `svgBytes`
and `svgFontsSubset` on `run`. A face the subsetter cannot read keeps its whole
payload and is named in `svg.fontWarnings`; subsetting never fails an export.

`from-mermaid` lifts an existing flowchart onto the canvas, which is the point
of the whole tool for a repo whose diagrams are all mermaid today:

```bash
tldrawkc from-mermaid map.tldr --source learn/map.mmd --shot /tmp/map.png
```

Without `--append` the document must not already exist, so a canvas someone has
since fixed by hand is never overwritten. Any line the parser cannot read is
reported, in the result and on stderr, and never silently dropped.

### Watching it, and nudging it

`serve diagram.tldr` is the one command that does not exit. It starts the page
with three routes over that one file and opens it in the machine's own browser,
with tldraw's full UI rather than the headless canvas every other verb uses.

```bash
tldrawkc serve learn/assets/dot-product.tldr        # opens a tab, prints the URL
tldrawkc serve learn/assets/dot-product.tldr --no-open --port 7300
```

| Route | Method | What |
| --- | --- | --- |
| `/api/document` | GET | The file and its `mtimeMs`. The page polls it and reloads when the mtime moves, which keeps the camera where it is. |
| `/api/document` | PUT | The page posts the document back on Cmd+S. The write is atomic and the body has to be a `.tldr`. |
| `/api/health` | GET | `{ ok: true, file }` |
| `/favicon.ico` | GET | 204. The bundle ships no icon and a real tab asks for one anyway, so the route exists to keep a served session's request log clean. |

The agent and the human write the same file and the last write wins. Draw with
`run` in one terminal and the tab picks it up within a second, leaving the
camera where it was. Drag a box in the tab and press Cmd+S (Ctrl+S elsewhere):
the page serialises the document and PUTs it, and the next `inspect` from any
terminal reports the new position. Nothing else in the tab writes the file, so
an accidental nudge costs nothing until you save it. A reload that landed on
top of unsaved edits says so in a banner. There is no sync server and none is
planned.

![The mirror tab: tldraw's full UI around a canvas with two boxes, alpha and beta, joined by a bound arrow. Alpha has just been dragged down and right and is still selected; the arrow has re-routed to follow it. An overlay in the top right reads p4.tldr, Saved 21:20:11, watching for changes](docs/serve-mirror.png)

The port is 7240 by default, so the tab can be bookmarked, and falls back to a
free one when something else has it, saying which. The routes exist only while
`serve` is running: a headless verb's server has no `/api/*` at all, because a
snippet runs with the page's own power and would otherwise be one `fetch` away
from writing an arbitrary file.

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
is exit code 3. Nine rules:

| Rule | Fires when |
| --- | --- |
| `friendless-arrow` | An arrow has no binding at one or both ends |
| `arrow-crosses-shape` | An arrow's rendered path runs through a geo or note shape that is neither of the two it connects |
| `overlapping-text` | Two text-bearing shapes' label boxes intersect |
| `overlapping-shapes` | Two shapes intersect by more than a tenth of the smaller one's area |
| `off-page` | A shape sits further than 10000 page units from the origin |
| `empty-label` | A geo shape has no text and no fill, so it renders as an unexplained outline |
| `unreadable-label` | The widest unbreakable run of a label is wider than the room the shape gives it |
| `missing-glyph` | A label asks for a character its font has no glyph for, so the reader's machine picks the typeface. A **warning** |
| `missing-topic` | The document names no topic, so a catalog cannot file it. A **warning**: printed, and never an exit code |

`missing-glyph` and `missing-topic` are the two warnings. No `.tldr` written
before either rule existed should go red over them, so both print as `warn`
rather than `lint` and `hasBlockingLints` ignores them: exit code 3 still means
the picture is wrong.

`missing-glyph` matters most in the `draw` font. Shantell Sans, tldraw's
default, has no Greek past pi and none of the set-theory signs, so `angle θ`
comes out in whatever font the reader's machine falls back to, which is not the
same font on two machines. The finding names a family that can draw the label,
usually `sans`. The coverage it checks against is generated from the font files
themselves into `src/page/helpers/font-coverage.ts`; `npm run generate:fonts`
rewrites it and a test regenerates and diffs, so a tldraw upgrade cannot leave
it stale.

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

## Library

`exports["."]` in `package.json` points at `dist/lib/index.js`, so everything
re-exported from `src/lib/index.ts` is importable as `tldrawkc`. Nothing there
prints and nothing calls `process.exit`: each function takes an options object
and returns data. The options and the returned shapes are the ones the CLI
parses and prints with `--json`, so [CLI.md](docs/CLI.md) is the contract for
both.

One function per verb. Four are named differently from the verb they back:
`new` and `export` are reserved words in JavaScript, `meta set` is two words,
and `api` reads a file the build generated rather than doing the work itself.

| Function | Verb | Signature |
| --- | --- | --- |
| `run` | `run` | `run(options: RunOptions): Promise<RunResult>` |
| `shot` | `shot` | `shot(options: ShotCommandOptions): Promise<ShotCommandResult>` |
| `inspect` | `inspect` | `inspect(options: InspectOptions): Promise<InspectCommandResult>` |
| `newDocument` | `new` | `newDocument(options: NewDocumentOptions): Promise<NewDocumentResult>` |
| `exportCanvas` | `export` | `exportCanvas(options: ExportOptions): Promise<ExportResult>` |
| `fromMermaid` | `from-mermaid` | `fromMermaid(options: FromMermaidOptions): Promise<FromMermaidResult>` |
| `list` | `list` | `list(options?: ListOptions): Promise<ListResult>` |
| `setMeta` | `meta set` | `setMeta(options: SetMetaOptions): Promise<SetMetaResult>` |
| `serve` | `serve` | `serve(options: ServeOptions): Promise<ServeHandle>` |
| `doctor` | `doctor` | `doctor(options?: DoctorOptions): Promise<DoctorReport>` |
| `readApiReference` | `api` | `readApiReference(target?: string): Promise<HelperDoc[]>` |

Every option and result type is exported beside its function. The defaults for
the flags live in the CLI's argument parser and not in the library, so several
fields a flag would have filled in are required by the option types that carry
them: `padding`, `pixelRatio` and `timeoutMs`, where the CLI's own values are
32, 2 and 30000, and the booleans behind `--create`, `--no-save`,
`--allow-lints`, `--append` and `--no-open`. Which of them a given verb takes
is on its own type.

### A worked example

```ts
import { run, isTldrawkcError } from "tldrawkc";

const snippet = `
helpers.box('agent', 'agent cli', { x: 60, y: 60, w: 170, h: 64 })
helpers.box('page', 'headless page', { after: 'agent', gap: 120, w: 190, h: 64 })
helpers.connect('agent', 'page', { label: 'exec' })
return helpers.getLints()
`;

try {
  const result = await run({
    file: "loop.tldr",
    evalSource: snippet,
    shot: "loop.png",
    create: true,
    save: true,
    allowLints: false,
    padding: 32,
    pixelRatio: 2,
    timeoutMs: 30_000,
  });

  console.log(result.shot, result.shapeCount, "shapes");
  for (const lint of result.lints) console.log(lint.rule, lint.message);
  console.log("exitCode", result.exitCode);
} catch (error) {
  if (isTldrawkcError(error)) {
    console.error(error.message);
    process.exitCode = error.exitCode;
  } else throw error;
}
```

`--code <path>` on the CLI is `code` here and `--eval <source>` is `evalSource`;
pass one or the other. The browser is launched and closed inside the call.

### Failures

Every failure the library raises on purpose extends `TldrawkcError` and carries
the exit code the CLI would use, so a caller reads a property rather than
matching on message text. `isTldrawkcError(error)` narrows to that base, and
`EXIT_CODES` is the table of the five codes by name.

| Error | `exitCode` | Raised when |
| --- | --- | --- |
| `UsageError` | 1 | Bad arguments, a missing file, a flag that contradicts another. Nothing was written |
| `EnvironmentError` | 1 | The machine could not do the job: the browser would not launch, the page never answered, the bundle is stale, the snippet ran past its timeout |
| `ChromiumNotFoundError` | 1 | No browser could be used. Carries `tried`, every path with its source and why it was rejected. Exported from `browser.ts`, not from `errors.ts` |
| `SnippetError` | 2 | The snippet threw. Carries `snippetStack`, the stack the page reported, which points into the snippet's own lines. The document is untouched |
| `ExportError` | 4 | The export failed after the document was saved. The `.tldr` is safe |

Exit 3 is not an error. Lints are a normal result, so `run`, `inspect` and
`fromMermaid` all resolve and report it as `exitCode` on the returned object,
0 or 3, next to the `lints` array itself. `hasBlockingLints` is the one
function that decides, and `severityOf` applies the default. `exportCanvas`
runs no lint pass at all: its `ExportResult` has no `lints` and its `exitCode`
is always 0, because an export neither executes nor saves anything.

### Beyond the verbs

The rest of `src/lib/` is exported too, which is what lets the CLI be a thin
layer over it. The pieces worth knowing about:

| Group | What it holds |
| --- | --- |
| Browser | `withCanvas`, `openCanvasPage`, `resolveChromium`, `installedBrowserPaths`, `isOffHost`, plus `BRIDGE_TIMEOUT_MS`, `EXEC_TIMEOUT_MS` and `VIEWPORT` |
| Lints | `hasBlockingLints`, `severityOf` |
| Metadata | `readMeta`, `readTldrFacts`, `readDocumentMeta`, `applyMeta`, `mergeDocumentMeta`, `validatePatch`, `isEmptyPatch`, `stampSvg`, plus `META_KEY`, `META_VERSION`, `SLUG_PATTERN` and `SVG_TOPIC_ATTRIBUTE`. Pure functions over the file's JSON, so none of them launches a browser |
| SVG fonts | `subsetSvgFonts`, `findFontFaces`, `spliceFontFaces`, `collectSvgCharacters`, `decodeEntities`, `SAFETY_CHARACTERS` |
| Helper reference | `buildApiReference`, `readApiSources`, `extractHelperDocs`, `selectHelperDocs` |
| Servers | `startPageServer`, `startServeServer`, `mirrorUrl`, `resolveStaticPath`, `contentTypeFor`, `openInBrowser`, `openCommandFor`, plus `DEFAULT_SERVE_PORT`, `MAX_DOCUMENT_BYTES`, `MIRROR_QUERY`, `CONTENT_TYPES` and `FALLBACK_CONTENT_TYPE` |
| Paths and files | `resolveTldrPath`, `resolveOutputPath`, `resolveListDir`, `siblingPath`, `tempShotPath`, `tempSiblingPath`, `relativeToDir`, `doctorProbePath`, `readText`, `writeText`, `writeAtomic`, `writePng`, `modifiedAt`, `newestMtime`, and the `PACKAGE_ROOT`, `DIST_DIR`, `PAGE_DIST_DIR`, `PAGE_INDEX_HTML`, `PAGE_SRC_DIR`, `HELPERS_SRC_DIR`, `API_JSON`, `API_SOURCE_FILES`, `CLI_ENTRY` and `DEFAULT_LIST_DIR` constants |
| Doctor | `isFontUrl`, `MINIMUM_NODE_MAJOR` |

`serve` is the exception to every other verb. It returns while its server is
still listening, so the handle it hands back carries the `close()` the caller
owes it, along with `url`, `port`, the resolved `file` and `fellBackFrom` when
the port it asked for was taken. Every verb that opens a browser closes it
before it resolves, in a `finally`, whether the call succeeded or threw, and
`list`, `setMeta` and `readApiReference` never open one at all.

## For agents

`.claude/skills/tldrawkc-diagram/SKILL.md` is the skill a coding agent loads to
use this tool: the draw, look, fix, export loop, the snippet conventions, and
where the committed files go in self-learn, which symlinks it into its own
`.claude/skills/`.

## Design docs

The brief this tool was built from, in [docs/](docs/README.md). It was written
before any of the code existed and corrected against the code as each phase
landed, so it says why as well as what.

| Document | What it settles |
| --- | --- |
| [DECISIONS.md](docs/DECISIONS.md) | The forty-three calls already made, each with its verdict and the reason, so none of them is relitigated |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | The package layout, the Node to browser bridge, one command end to end, serve mode, and the eight layering rules |
| [CLI.md](docs/CLI.md) | Every command, flag, `--json` shape and exit code. The contract other tools parse |
| [HELPERS.md](docs/HELPERS.md) | The `helpers` bag a snippet can call, and what each of the nine lint rules fires on |
| [ROADMAP.md](docs/ROADMAP.md) | Seven phases with checklists, the five that are done, and the gaps still known and open |
| [PRIOR-ART.md](docs/PRIOR-ART.md) | What tldraw actually supports, the tools that already exist, and what was checked and ruled out, with a source per claim |

[AGENTS.md](AGENTS.md) is the operating manual for working in this repo.

## Licence

MIT. See [LICENSE](LICENSE).
