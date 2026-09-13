# tldrawkc, the agent guide

A command line tool that draws diagrams on a real tldraw canvas, screenshots
them, and lets the agent that asked look and iterate. One Node program and one
browser page: the page owns every drawing decision, and Node only launches it,
moves files and prints.

This file is the operating manual. [README.md](README.md) says what the tool
is for, and [docs/](docs/README.md) holds the design docs it is built from:
the decisions, the architecture, the CLI reference, the helper vocabulary, the
roadmap and the prior art.

**Status: phase 4, complete.** Every verb in [docs/CLI.md](docs/CLI.md) is
built: `new`, `run`,
`shot`, `inspect`, `export`, `from-mermaid`, `list`, `meta set`, `serve`, `api`
and `doctor`. `PLANNED_COMMANDS` in `src/cli/args.ts` is empty and stays as the
place to name the next specified-but-unbuilt verb.

## What lives where

| Path | What it is |
| --- | --- |
| `bin/tldrawkc` | shell shim, `exec node ../dist/cli/index.js "$@"`. Needs a build to have run |
| `src/cli/index.ts` | the only module that prints. Dispatches on the first positional, owns every exit code |
| `src/cli/args.ts` | `parseCommand(argv, env)`, pure: no printing, no exiting, no throwing. Returns a parsed command or an error string |
| `src/lib/paths.ts` | every path the tool computes. Nothing else builds one |
| `src/lib/files.ts` | every file write, all atomic (temp sibling, then rename) |
| `src/lib/browser.ts` | resolving Chromium, opening the page, the typed wrapper over every bridge call, and `withCanvas` |
| `src/lib/server.ts` | the static server for `dist/page`, on 127.0.0.1 and a random free port, plus the three `/api/*` routes serve mode mounts over one `.tldr` |
| `src/lib/serve.ts` | `serve`: start that server on a fixed port, open the machine's own browser, hand back a handle the caller closes |
| `src/lib/canvas.ts` | one function per verb that needs a browser: `run`, `shot`, `newDocument`, `inspect`, `exportCanvas`, `fromMermaid`. Takes data, returns data |
| `src/lib/fonts.ts` | the SVG font subsetter: which characters a document draws, and the `@font-face` surgery. Pure apart from the one call into harfbuzz |
| `src/lib/meta.ts` | the document metadata: the shape, the `.tldr` JSON surgery, `meta set`, and the SVG stamp. No browser |
| `src/lib/list.ts` | `list`: a directory of `.tldr` files as data. No browser |
| `src/lib/api.ts` | the helper reference: a parser over the page's JSDoc, plus the build step that writes `dist/api.json` |
| `src/lib/errors.ts` | the failures the tool raises on purpose, each carrying its exit code |
| `src/lib/doctor.ts` | the environment checks, as data |
| `src/lib/index.ts` | the public API, what `exports["."]` points at |
| `src/page/` | the Vite app: `<Tldraw>`, the bridge, and (from phase 1) the helpers bag, mermaid importer and lint pass |
| `test/unit/` | node only, no browser, runs on every push |
| `test/e2e/` | real Chromium. CI installs one first |
| `dist/` | build output, gitignored: `dist/cli/`, `dist/lib/`, `dist/page/`, `dist/api.json` |
| `.claude/skills/tldrawkc-diagram/` | the agent-facing skill: the draw, look, fix, export loop and the self-learn conventions. Symlinked into self-learn's `.claude/skills/`, the way `manimkc-video` is |

## Build and test

```bash
npm ci
npm run build          # tsc for src/cli and src/lib, the api reference, vite for src/page
npm run lint
npm run typecheck
npm test               # unit
npm run test:e2e       # needs a Chromium and a build; see below
node dist/cli/index.js doctor
```

`npm run build` is three steps: `build:node` (tsc), `build:api` (the helper
reference, which needs `build:node` to have run) and `build:page` (Vite). It
has to have run before anything works: `bin/tldrawkc` executes
`dist/cli/index.js`, and every command serves `dist/page/`. `doctor` warns
when `dist/page` is older than `src/page` rather than failing, because a stale
bundle still runs.

### Three environments, three tsconfigs

They are genuinely different: the node side must not see the DOM, the page
must see it, and the tests live outside `src/`.

| Config | Covers | Emits |
| --- | --- | --- |
| `tsconfig.json` | `src/cli`, `src/lib` | yes, to `dist/` (this is `npm run build:node`) |
| `tsconfig.test.json` | the same plus `test/` and the root config files | no, typecheck only |
| `tsconfig.page.json` | `src/page` (JSX, DOM lib, bundler resolution) | no, Vite emits the page |

`npm run typecheck` runs the last two. ESLint's type-aware rules point at the
same two, which is how every source file ends up covered by exactly one
project.

### Chromium

The tool depends on `playwright-core`, which ships no browser. `doctor`
reports which executable was picked and how. The order is fixed by D9 in the
design docs (D9) and implemented in `src/lib/browser.ts`:

1. `--chromium <path>`
2. `TLDRAWKC_CHROMIUM`
3. what `playwright-core` would launch, if `npx playwright install chromium`
   has been run
4. Chrome, Chromium, Edge and Brave in their usual macOS and Linux locations

Each candidate has to both exist and answer `--version`, because a stale
Playwright registry entry points at a directory that was deleted.

A browser the caller **named** is not a suggestion: when `--chromium` or
`TLDRAWKC_CHROMIUM` points at something unusable, that is an error rather than
a reason to fall through to a different browser. The whole point of naming one
is to control which engine drew the picture. Only steps 3 and 4 fall through.

`--headed` shows the window, and it reaches `withCanvas` from every verb that
opens one: `run`, `shot`, `new`, `inspect`, `export`, `from-mermaid` and
`doctor`. It is a flag that fails silently when a verb drops it, since nothing
errors and a window simply never appears, so `test/unit/headed.test.ts` records
the options each verb passes and asserts the list of verbs as well. A headed
Chromium needs a display: macOS always has one, a Linux runner needs
`xvfb-run`, and `test/e2e/headed.test.ts` skips without either.

`playwright` is a devDependency pinned to the **exact same version** as
`playwright-core`. It has no install script of its own (checked against
1.63.0: the published `package.json` has no `scripts` block at all), so it
downloads nothing at `npm install` time. What it buys is that `npx playwright
install chromium` resolves the local copy and fetches the browser revision
`playwright-core` expects, instead of whatever the registry serves that day.
Bump the two together or not at all.

## Verbs

Three of them are not in `canvas.ts` at all. `list` and `meta set` never open a
browser: one walks a directory and parses JSON, the other rewrites one record
in a `.tldr`. Putting them through `withCanvas` would buy nothing and cost a
Chromium launch per call, and a catalog runs `list` on every index. `serve` is
the third, for the opposite reason: it wants the human's own browser rather
than a headless one this process owns, so it lives in `src/lib/serve.ts` and
never calls `withCanvas`. Add a verb to `canvas.ts` when it needs a live
editor, and beside it when it does not.

Every other verb is one function in `src/lib/canvas.ts` that takes an options
object and returns a result object. None of them print, none of them exit, and none
of them open a browser directly. They all have the same shape:

```ts
export async function run(options: RunOptions): Promise<RunResult> {
  // 1. Resolve paths and read the document. A missing file without --create
  //    is a UsageError here, before anything is launched.
  // 2. withCanvas(...) for everything that needs the page.
  // 3. Return data. The CLI decides what to print and what to exit with.
}
```

`withCanvas(options, fn)` starts the page server, opens the page, waits for the
bridge, runs `fn`, and closes the browser and the server in a `finally`. That
is layering rule 7 in one function: no verb has its own cleanup to forget, and
a snippet that hangs still leaves a clean process behind. Add a verb by adding
a function that calls it, never by calling `openCanvasPage` yourself.

Inside `fn`, the order for anything that writes is fixed:

1. Check the bridge implements what this verb needs (`canvas.has(...)`), so a
   page bundle older than the command says so in one line.
2. `load`, then `setPage` when `--page` was given.
3. `exec`, bounded by `--timeout`.
4. `save`, through `files.ts`.
5. Export, last.

Save before export is the reason exit 4 exists as its own code: a broken export
costs a picture, never the work.

Two verbs deliberately skip steps 3 and 4. `inspect` loads and reads, so the
document is never written: reading is not editing, and a read that rewrites the
file it read is a trap. `export` loads and exports, so the only thing that can
fail is the export itself.

`from-mermaid` owns one rule the others do not: without `--append` the target
must not already exist. The command's job is migration, and overwriting a
canvas someone has since fixed by hand is the one unrecoverable mistake
available here. It also embeds the flowchart into the snippet as JSON and
parses it back at runtime rather than concatenating it into the program text: a
diagram is arbitrary text, and one quote in a node label would otherwise end
the literal and let the rest of the file run as code.

### serve

The one long-lived command, and the only place two of the rules bend.

- **It keeps a server and a browser alive on purpose.** Layering rule 6 says a
  command never leaves a browser running, and `serve` is the named exception in
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): it runs until SIGINT. The CLI owns that wait, in
  `untilSignal()`, and closes the server before returning 0. Nothing in
  `src/lib/serve.ts` waits or prints.
- **The signal listener goes on before the server, not after the URL.**
  `watchForSignal()` is called first and awaited last. Installing it by
  awaiting it at the end left a window between the URL reaching stdout and the
  handler existing, and a Ctrl+C or a script that reads the URL and kills at
  once met Node's default handling: exit 130, server never closed. Anything
  added to `runServe` goes between the two, never before the watch.
- **The browser is not Chromium.** `serve` spawns the platform's own opener
  (`open`, `xdg-open`, `cmd /c start`), detached, with every failure ignored:
  the URL is already on stdout, so a box with no opener should still serve the
  page. `--no-open` skips it. Do not reach for `withCanvas` here, and do not add
  a dependency to open a URL.
- **The `/api/*` routes exist only in serve mode.** `startServeServer` mounts
  them; `startPageServer`, which every headless verb uses, does not. That is
  layering rule 2 enforced by the server rather than promised by the page: a
  snippet runs with the page's full power, so an `/api/document` that were
  always mounted would be a write to any file behind one `fetch`.
  `test/unit/serve.test.ts` asserts a headless server 404s it.
- **A PUT is checked before anything touches disk.** Over 50 MB is 413, not
  JSON or no `tldrawFileFormatVersion` is 400, and the write itself goes
  through `files.ts` like every other one. An oversized body is drained and the
  connection closed, never destroyed: destroying the request destroys the
  response with it, and the client waits for a 413 that was thrown away.
- **The port is a preference, not a promise.** 7240 by default so a tab can be
  bookmarked, falling back to a free one on EADDRINUSE and reporting which.
  `startPageServer` only falls back when asked, because a verb that named a
  port and silently got another one would be hiding something.
- **`/favicon.ico` answers 204, in serve mode only.** A real tab asks for an
  icon whether or not the page declares one, and the bundle ships none, so
  without the route every serve session logs a 404 that layering rule 8 counts
  as a failed request. It is mounted beside the API rather than everywhere,
  because a headless verb's tab never asks; it defers to a real
  `dist/page/favicon.ico` if one ever lands there, so the 204 cannot quietly
  shadow an icon someone added.

### Exit codes

A failure is one of the classes in `src/lib/errors.ts` and carries its own
code, so `src/cli/index.ts` reads a property instead of matching on message
text. Never throw a bare `Error` out of `src/lib/` for something a caller could
act on.

| Class | Code | Raised when |
| --- | --- | --- |
| `UsageError` | 1 | Bad arguments, a missing file, a flag that contradicts another, an unknown `--page` |
| `EnvironmentError` | 1 | No Chromium, the page never answered, the bridge is missing a function, the snippet ran past `--timeout` |
| `ChromiumNotFoundError` | 1 | No usable browser (a subclass in `browser.ts`, because it carries the list of paths it tried) |
| `SnippetError` | 2 | The snippet threw. The page rolled back and nothing was written. |
| `ExportError` | 4 | The PNG or SVG failed after the document was saved |

Exit 3 is not an error. The command succeeded, so `run` returns normally with
its `lints` list and an `exitCode` of 3, and `--allow-lints` turns that into 0.
The file is saved either way, because the work is real.

A lint carries an optional `severity`. Absent means `error`, which is what
drives exit 3; `warn` is printed and ignored by the exit code. `missing-topic`
and `missing-glyph` are the two warnings, because every diagram drawn before
those rules existed would fail on them and the tool must not break work that is
fine. `hasBlockingLints` in `src/lib/browser.ts` is the one place that decides,
so `run`, `inspect` and `from-mermaid` cannot disagree.

## Document metadata

A diagram carries what it is about on the tldraw **document record**
(`document:document`), under one key in its `meta` bag:

```json
"meta": { "tldrawkc": { "kc": 1, "title": "", "topic": "", "concepts": [],
                        "source": "", "created": "" } }
```

Three things to know before touching it.

- **The document record, not a page record.** A diagram is one document, and
  pages get added, renamed and reordered. `editor.getDocumentSettings()` and
  `updateDocumentSettings()` reach it from the page, and it is a plain JSON
  record in the file, which is what lets `list` and `meta set` work with no
  browser.
- **`kc` is the schema version, not a copy of the key.** An indexer reads it
  first and can refuse a shape it was not written against. Bump it only with a
  reader that handles both. A **reader** keeps a version it does not know; a
  **writer** refuses one. This build emits exactly the six fields it knows, so
  folding a patch into a version 2 object would drop what version 2 added and
  stamp the result as version 1, which is silent data loss in a file whose
  whole job is to be read by something else.
- **The rules exist twice**, in `src/lib/meta.ts` and `src/page/helpers/meta.ts`,
  because layering rule 1 stops the node side importing the page and the page
  has to amend the bag while a snippet runs. `test/unit/meta.test.ts` imports
  both and runs them over one table, so a change to one that the other does not
  make is a red test. Change both, or delete the test and find a better answer.

`--source` means a path to read from on `from-mermaid` and free text on `new`
and `meta set`. The allowlist in `args.ts` is per command so nothing collides,
but do not "unify" them.

## The helper reference

`tldrawkc api` prints what a snippet can call, and it is generated rather than
written: `npm run build:api` reads `src/page/helpers/index.ts` as text and
writes `dist/api.json`, which the command prints. Reading the page's sources
from Node is fine; importing them would break layering rule 1, which is why
`src/lib/api.ts` is a parser and not an import.

For a helper to appear, three things have to hold in the page:

1. The `/** ... */` block sits **directly** above the declaration, with no
   blank line between them. A blank line means the block documents the file or
   the section, and picking it up would fill the reference with prose that
   describes nothing.
2. The declaration is a named function (`function name(`, optionally `export`
   and/or `async`, at any indentation, so one inside `createHelpers` counts) or
   an interface method signature (`name(...): Type;`).
3. The block carries an `@example`. Without one the entry is dropped, because
   the point of the reference is a line an agent can copy.

The first paragraph is the summary, `@param` lines are kept, and the signature
is the parameters as written. When a name is documented twice, once on the
`Helpers` interface and once on the function that implements it, the function
wins: it cannot drift from what runs. `src/lib/paths.ts` owns both the source
list and where the JSON lands, and `test/unit/api.test.ts` pins every form the
parser accepts and every near miss it must ignore.

## Layering rules

The full list is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The ones
that bite:

1. **`src/lib/` and `src/cli/` never import `tldraw`, `react` or `src/page/`.**
   Those live only in the page bundle. `test/unit/layering.test.ts` greps for
   them and fails. This is what keeps React out of the dependency tree of any
   repo that installs the tool.
2. **`src/page/` never touches the filesystem or the network.** It takes
   strings and returns strings through the bridge. Serve mode's two fetches to
   `/api/document` are the one exception, and they are the whole of it.
3. **`src/cli/index.ts` is the only module that prints.** Everything under
   `src/lib/` returns data. That is why `--json` and the human summary come
   from one call.
4. **Nothing outside `src/lib/paths.ts` builds a path.**
5. **Every file write is atomic** and goes through `src/lib/files.ts`.
6. **A command never leaves a browser running.** `withCanvas` is the only
   place that opens one, and it closes it in a `finally`.
7. **No network access at runtime.** The page bundle is self-contained, fonts
   included.

## tldraw gotchas

Collected as they are found, so they are not rediscovered.

- **This is tldraw 5, not 4.** The design docs were written against 4.x;
  `npm view tldraw version` says 5.4.2 as of September 2026, and the whole
  API this tool needs is present there. Nothing in the design had to change,
  but do not trust a 4.x changelog entry without checking the installed
  `.d.mts`.
- **`editor.mark` does not exist.** It was removed in v4. The rollback pair is
  `const mark = editor.markHistoryStoppingPoint('exec')` and
  `editor.bailToMark(mark)`. Both are on the v5 `Editor`.
- **Fonts do not ship in the `tldraw` package.** There are no `.woff2` files
  anywhere under `node_modules/tldraw` or `node_modules/@tldraw/editor`.
  tldraw's `FontManager` asks for a font by key (`tldraw_draw`,
  `tldraw_mono_italic_bold` and so on) and, when nothing supplies a URL for
  that key, falls back to requesting the bare key as a relative URL. That
  404s, and the export silently degrades to a system font rather than
  erroring. The fix is `@tldraw/assets`, a devDependency that holds the actual
  woff2 files: `getAssetUrlsByImport()` from `@tldraw/assets/imports.vite`
  imports each one with `?url`, so Vite emits them into `dist/page/assets/`
  and `<Tldraw assetUrls={...}>` points at them. With `base: './'` in
  `vite.config.ts` those URLs are relative, which is what keeps rendering
  offline. Sixteen `.woff2` files in `dist/page/assets/` after a build is the
  check.
- **`@tldraw/assets` also drags in every translation file**, about forty JSON
  blobs, because `imports.vite` is generated and has no opt-out. The page
  bundle is around 5 MB on disk as a result. Harmless for a local headless
  page; worth revisiting only if startup time ever shows up in a measurement.
- **The fonts still need a rendered check.** Phase 1 should screenshot a
  one-box fixture and confirm the label comes out in Shantell Sans rather than
  a system fallback, because the failure mode here is silent. Bundling them is
  necessary, not proof.
- **`serializeTldrawJson` returns a promise.** Await it.
- **`zoomToFit()` takes no padding.** Compute the bounds and call
  `zoomToBounds(bounds, { inset })` when padding matters.
- **`createShapeId` and `toRichText` come from the `tldraw` module**, which
  re-exports `@tldraw/editor` and `@tldraw/tlschema` wholesale. A snippet gets
  the whole module in scope, so reach for the re-export rather than a
  sub-package.
- **The fonts are confirmed rendered, as of phase 1.** The page was driven
  headless through a real Chrome, the example snippet from `HELPERS.md` was
  run, and the PNG was looked at: the labels come out in Shantell Sans with
  its single-storey `a` and marker stroke ends, not a system fallback. The run
  logged zero failed requests and zero responses at 400 or worse, and
  `document.fonts` reported `tldraw_draw`, `tldraw_sans`, `tldraw_serif` and
  `tldraw_mono` all loaded. This is the rendered check phase 1 owed.
- **`parseTldrawJsonFile` hands back a `TLStore`, not a file object.** The
  result is a `Result<TLStore, TldrawFileParseError>`, so the success path is
  `parsed.value.getStoreSnapshot("document")`. Pass the scope explicitly:
  the argument defaults to `document` today, and `"all"` would drag session
  records into a snapshot meant only for `loadSnapshot`.
- **`toImage` reports its size in page units, not pixels.** The `width` and
  `height` on the result are the framed region before the pixel ratio, so at
  the default ratio of 2 they are half the PNG. Multiplying them back does not
  reproduce the file either: 1288.5024 units at ratio 2 came back as a
  2576-pixel PNG, not the 2577 the arithmetic predicts. The bridge reads the
  size out of the PNG's own IHDR chunk instead, because CLI.md promises pixels
  and the file is the only thing a caller can check against.
- **`toImage`'s `padding` defaults to `'auto'`, not to a number.** `'auto'`
  trims to visual content bounds and captures overflow like thick strokes and
  arrowheads; a number is fixed padding with no trimming, and anything beyond
  it is clipped. The bridge passes a number because the CLI exposes
  `--padding`. `background` is a boolean and defaults to true.
- **An arrow binding's `props.snap` is required by the validator** (an
  `ElbowArrowSnap`: `center`, `edge-point`, `edge` or `none`), but
  `ArrowBindingUtil.getDefaultProps()` supplies `none`, so a partial `props`
  on `editor.createBindings` is fine. The same goes for `normalizedAnchor`,
  `isPrecise` and `isExact`.
- **The arrow schema's default `kind` is `arc`.** `HELPERS.md` wants `elbow`
  as the helper default, so `connect` sets it on every arrow rather than
  relying on the shape default. Elbow routing reads `props.elbowMidPoint`
  (0..1); `props.bend` is arc only, and the two are separate fields.
- **A snippet's stack line numbers are two higher than the source, and the
  bridge now corrects them.** The `AsyncFunction` constructor prepends a
  header, so line 4 of a snippet reports at line 6. The offset was measured,
  not guessed, and it is constant. `helpers/stack.ts` subtracts it in `exec`'s
  catch, before the error crosses the bridge, and adds a `snippet.js:4:3  <the
  line>` pointer above the frames. Two things make that safe rather than a
  blind search and replace. The snippet is compiled with a trailing
  `//# sourceURL=snippet.js`, appended so it cannot shift the numbers it exists
  to fix, which is what lets a snippet frame be told apart from the
  `<anonymous>` frames playwright's own injected script contributes to the same
  stack. And a frame that lands on line 1 or 2, inside the generated header, is
  left alone rather than renumbered to zero.
- **`createShapeId(id)` is literally `` `shape:${id}` ``**, with no check for a
  prefix that is already there. Feeding it a real id gives `shape:shape:x`,
  which is why `helpers/keys.ts` strips the prefix first and every helper takes
  either form.
- **A box's `h` is a minimum, not the height.** tldraw grows a geo shape with
  `growY` when its label wraps, so `getShapePageBounds` can be taller than
  `props.h`. Read the bounds, never `props.h`, when placing something against
  a box.
- **A child shape's `x` and `y` are in its parent's space, not the page's.**
  The helpers' vocabulary is page coordinates throughout, so `box` with a
  `parent` converts the resolved point through
  `editor.getShapePageTransform(parent).clone().invert()`. Without that, a box
  placed at page (440, 340) inside a frame at (400, 300) lands at (840, 640).
- **`document.fonts.ready` resolves later than the bridge answers `ping`.**
  tldraw kicks its woff2 fetches off during mount and carries on, so a
  failed-request snapshot taken when the bridge answers can miss the 404 the
  fonts check exists for. `doctor` awaits `canvas.fontsReady()` first and then
  names the `tldraw_*` families that actually came back loaded.
- **An imprecise arrow binding throws the anchor away.** With
  `isPrecise: false` tldraw ignores `normalizedAnchor` and aims the terminal at
  the shape's centre. Two boxes in a row whose centres differ (which is any row
  where one label wrapped to a second line and grew the box) then get a short
  dog-leg that the arrow label sits on top of, and it reads as a broken arrow.
  `connect` therefore binds every end precisely, auto or named, and
  `geometry.autoAnchors` picks an auto anchor on the band where the two boxes
  overlap so the line is straight whenever a straight line is possible.
- **Sixty page units is not enough room for a labelled arrow.** The example
  snippet in `HELPERS.md` uses `gap: 80` and `gap: 60`, and at those distances
  tldraw has to draw the label over almost the whole line: the arrowhead
  shrinks to a stub and `mirror` lands on the box outline. The same snippet at
  120 and 140 renders clean, with arrowheads touching the box edges and every
  label clear of everything. `DEFAULT_GAP` is 120 for that reason. Re-checked
  after the precise-anchor fix above: the arrows are straight at 80 and 60 now,
  but `mirror` still covers the whole 60-unit gap and lands on both box
  outlines, so this is a gap problem and not a helper bug, and the example in
  [docs/HELPERS.md](docs/HELPERS.md) carries the wider gaps for that reason.

- **There are two option types with `Line` in the name.** `layout.ts` has had
  `LineOptions` since phase 1 and it is the gap and alignment for `row` and
  `column`. The options for `helpers.line`, the unbound mark, are
  `DrawLineOptions` in `connect.ts`. Both are re-exported from
  `helpers/index.ts`, so reaching for the wrong one gets a confusing error
  about `gap` rather than an obvious one about the name.
- **A geo shape's page bounds are not its props.** Anything that puts two
  containers on the same size has to read the bounds, work out the difference
  and add that to `props.w` and `props.h`, because `growY` on a wrapped label
  means two shapes handed the same `props.h` can still render at different
  heights. `resizeBoundsTo` in `layout.ts` is the one place that does it.
- **tldraw 5 has no rounded rectangle.** `GeoShapeGeoStyle` is a fixed enum
  (`rectangle`, `ellipse`, `oval`, `diamond`, `cloud`, `hexagon`, `star`,
  `heart`, ...) and `TLGeoShapeProps` carries nothing to round a corner with,
  so mermaid's `id(text)` has no exact home. The importer maps it to `oval`,
  the capsule, which is the nearest silhouette and the only one that reads as
  "not a plain box". The cost is that `id(text)` and `id([text])` come out
  identical.
- **`getSvgString` puts labels in a `<foreignObject>`, not in `<text>`.** The
  export of an eight-box canvas had zero `<text>` and zero `<tspan>` elements
  and ten `<foreignObject>` elements holding ordinary HTML `<div>` and `<p>`.
  The label text is still there as a plain string, so grepping an SVG for a
  label works, but anything that walks `<text>` nodes will find nothing, and a
  rasteriser with no foreignObject support (librsvg, ImageMagick, older
  Inkscape) will drop every label. Browsers render it correctly. Fonts are
  inlined the way the design assumed: the SVG opens with `@font-face` blocks
  whose `src` is a `data:font/woff2;base64,` URL.
- **The fonts must stay inline, and that is why they are subset instead.** An
  SVG a reader loads as an image (an Obsidian embed, a GitHub blob, an
  `<img src>`) is in a document context that fetches nothing: no stylesheet,
  no font file, no anything. A family that is not in the file is a family that
  silently falls back to a system font, and nobody notices until they look at
  the picture. So "link the fonts instead of inlining them" is not an option
  and never will be, which is what leaves subsetting as the way to get the
  weight down. `src/lib/fonts.ts` does it on the Node side, over the string
  the page handed back, after `stampSvg`: it collects every character the
  document draws, hands each face to harfbuzz with that set, and splices the
  smaller payload back in. Measured on the eight-node mermaid fixture,
  205 kB of base64 became 32 kB and the rendered PNG was pixel for pixel
  identical.
- **tldraw inlines only the families the drawing uses, not all four.** Checked
  against real exports: a canvas of `font: 'draw'` labels gets one
  `@font-face`, and adding one `font: 'sans'` label gets a second. So the
  "drop what nothing references" pass in `fonts.ts` is a guard rather than the
  win it was expected to be, and the win is the subsetting.
- **The subsetter over-collects on purpose.** A missing glyph is invisible
  until somebody looks at the picture; an extra glyph costs about half a
  kilobyte. That is why the scanner walks tags rather than stripping them with
  `<[^>]*>` (an attribute value may contain `>`), decodes entities and leaves
  the ones it does not know intact so their letters still land in the set, and
  why a fixed safety set of digits and punctuation goes in whatever the
  document says. It is also why a face harfbuzz refuses keeps its whole
  payload and becomes a warning: subsetting is an optimisation over a picture
  that is already correct, so it must never be able to fail an export.
- **The font bytes are not the whole file.** After subsetting, a committed SVG
  is mostly path data: the two self-learn diagrams came out at 213 kB and
  312 kB from 454 kB and 560 kB, and the remainder is the drawing. Do not
  expect a diagram with a lot of geometry in it to reach "tens of kB" on the
  strength of the fonts alone.
- **The four label fonts cannot draw most maths, and Shantell Sans is the
  worst of them. Measured 2026-09-13** against `@tldraw/assets` 5.4.2, by
  reading the `cmap` of every woff2 in `node_modules/@tldraw/assets/fonts/`
  and confirming each character by rendering it in a real Chrome. Over the set
  `√ · × ÷ ≤ ≥ ≠ ≈ ∞ ∑ ∏ π θ λ α β σ μ ² ³ ° ← → ↔ ⇒ ∈ ∉ ⊂ ∪ ∩ ∀ ∃ ¬ ∧ ∨ ∂ ∇ ∫ − – — ‘ ’ “ ” …`
  plus printable ASCII, what each font lacks is:

  | `font` | Face measured | Has no glyph for |
  | --- | --- | --- |
  | `draw` | Shantell Sans Informal | `θ λ α β σ μ ⇒ ∈ ∉ ⊂ ∪ ∩ ∀ ∃ ∧ ∨ ∇` |
  | `sans` | IBM Plex Sans | `⇒ ∈ ∉ ⊂ ∪ ∩ ∀ ∃ ∧ ∨ ∇` |
  | `serif` | IBM Plex Serif | `⇒ ∈ ∉ ⊂ ∪ ∩ ∀ ∃ ∧ ∨ ∇` |
  | `mono` | IBM Plex Mono | `θ λ α β σ μ ⇒ ∈ ∉ ⊂ ∪ ∩ ∀ ∃ ∧ ∨ ∇` |

  Printable ASCII is complete in all four, and all four faces of a family
  (regular, italic, bold, bold italic) cover exactly the same set. Two things
  to take from it. **`√` is present everywhere**, so the thing that looks like
  a plain `v` in a `draw` label is Shantell's own hand-drawn radical and not a
  fallback; no lint can fire on it. And **`⇒ ∈ ∉ ⊂ ∪ ∩ ∀ ∃ ∧ ∨ ∇` are in none
  of the four**, so set-theory notation has no font to switch to and has to be
  written out in words. That table is what `missing-glyph` checks against,
  generated into `src/page/helpers/font-coverage.ts`.
- **Neither `document.fonts.check()` nor canvas can tell you whether a font has
  a glyph.** Both were tried before the `cmap` reader was written.
  `document.fonts.check('40px tldraw_draw', 'θ')` is true, because the method
  answers "is a face matching this family loaded", not "can it draw this": it
  reported every character present in all four families. Canvas is no better,
  because `ctx.font` takes a family list but ignores everything past the first
  resolvable entry when it falls back, so a missing glyph lands in a system
  font rather than the next family named and cannot be told from a hit. The DOM
  does fall through, so `font-family: A, B` measuring exactly as wide as
  `font-family: B` is a usable oracle, and it is the one
  `test/e2e/font-coverage.test.ts` uses. It has two limits: the witness must
  have different advance widths from the font under test (the three IBM Plex
  faces share metrics, so only Shantell can witness them), and a character no
  bundled font has cannot be ruled on at all.
- **`src/lib/font-coverage.ts` reads woff2 with `node:zlib` and no third
  dependency.** A woff2 is a table directory plus one brotli stream holding the
  table data, and `cmap` is never one of the three tables woff2 transforms, so
  its bytes come out of the stream exactly as they went in. Two traps: the
  tables in the decompressed stream are **contiguous with no padding** (the
  four-byte alignment belongs to the reconstructed sfnt, not to the stream),
  and `glyf` and `loca` invert the transform flag, where version 0 means
  transformed and version 3 means null.
- **Nothing clips at a large coordinate; the export frame is what breaks.**
  Measured in a real Chrome: `toImage` and `getSvgString` both framed a box at
  x = 200000 correctly. What goes wrong is that every export is framed to the
  union of the shapes, so one stray shape at x = 10000 makes a frame 10000
  units wide, and against `MAX_SHOT_EDGE` (4096 px) that renders at about 0.4
  px per unit: a normal 64-unit box comes out 26 px tall and unreadable. Past
  roughly 100000 units the raster is also wrong, because tldraw quietly
  downscales to stay inside the browser's canvas limits (a frame 128 units
  tall came back as 126.96 at x = 100000 and 125.28 at x = 200000). That
  measurement is where `OFF_PAGE_LIMIT` of 10000 comes from.
- **The label rectangle in a shape's geometry is clamped to the shape.**
  `GeoShapeUtil.getGeometry` returns a `Group2d` whose second child is a
  `Rectangle2d` with `isLabel: true`, and it is `Math.min`ed against the
  shape's own width and height. It is the right thing to read for "where does
  this label sit" (`overlapping-text`), and useless for "is this label too
  big", because it can never report a size the shape does not have.
- **tldraw breaks a long word mid-word rather than letting it overflow.** The
  label CSS is `overflow-wrap: break-word`, so `antidisestablishmentarianism`
  in a 90-unit box renders as six stacked fragments rather than spilling out.
  A naive "is the text wider than the shape" check therefore never fires. The
  measurement that does is
  `editor.textMeasure.measureText(text, { ..., maxWidth: innerWidth, measureScrollWidth: true, disableOverflowWrapBreaking: true })`,
  whose `scrollWidth` reports the widest unbreakable run. That is what
  `unreadable-label` compares against the shape width.
- **The label metrics are `@internal`.** `LABEL_FONT_SIZES`,
  `ARROW_LABEL_FONT_SIZES`, `LABEL_PADDING`, `ARROW_LABEL_PADDING` and
  `TEXT_PROPS` live in
  `node_modules/tldraw/src/lib/shapes/shared/default-shape-constants.ts` and
  are not on the public entry point; `getFontFamily(theme, font)` is. Anything
  that measures a label the way tldraw does has to copy the numbers, so
  `helpers/read.ts` keeps them together with a pointer at the source file. The
  live values come off `editor.getCurrentTheme()`, which carries `fontSize`,
  `lineHeight` and `strokeWidth`.
- **An arrow is the only shape that can carry a binding.** There is no line
  binding, so `helpers.attribute`'s "bound line with no arrowhead" is an arrow
  shape with `arrowheadStart` and `arrowheadEnd` both `none`. A real `line`
  shape would be a loose mark that stays put when its box moves.
- **An elbow arrow between two shapes in the same column routes straight
  through everything between them.** The router only knows its two endpoints,
  so a mermaid back edge (`look --> cli` in a top-down flowchart) drew a
  vertical line through six boxes. `mermaid-apply.ts` detects a back edge from
  the rank map and switches it to an `arc` anchored on the outside face of
  both shapes, with a bend that puts the apex clear of the widest shape.
- **An arc's `bend` is the distance from the chord midpoint to the apex, and a
  positive one pushes it a quarter turn anticlockwise from the direction of
  travel.** Measured, not assumed: an arrow running straight up between two
  right-edge anchors with `bend: 300` came back with page bounds 300 units
  wider on its right. So compute the sign as a dot product against the side
  you want rather than guessing.
- **An arrow's `getGeometry` is a `Group2d` with exactly one non-label child.**
  `ArrowShapeUtil` builds an `Edge2d` for a straight arrow, a `Polyline2d` of
  the elbow route, or an `Arc2d` for a bend, and adds a `Rectangle2d` with
  `isLabel: true` when there is a label. `Geometry2d`'s `vertices` getter asks
  for them with `EXCLUDE_LABELS`, so it is the path and nothing else, and an
  arc arrives already sampled into a polyline. That is what
  `arrow-crosses-shape` walks. `Group2d.getVertices` concatenates its children
  with no separator, so this only reads as one path because the arrow has one
  body; do not assume it for another shape type.
- **A note shape has no `w` or `h`.** `TLNoteShapeProps` carries `size`,
  `growY` and `fontSizeAdjustment`; tldraw sizes the note from its `size`
  style, grows it down to fit, and shrinks the font rather than overflowing.
  That is also why `unreadable-label` exempts notes.
- **`editor.getShapePageBounds` on a geo shape already includes `growY`.** A
  box whose label wrapped to three lines reported `h` of 122 against a
  declared 64, so every layout helper reads the page bounds and never
  `props.h`. `respaceRanks` in the mermaid importer exists entirely because of
  this: the parser sizes boxes by counting characters, and the real heights
  only exist after the shapes do.
- **`store.listen` is flushed on the next frame, not with the change.** The
  store's history reactor schedules with `throttleToNextFrame`, so a listener
  hears about a mutation a frame after it happened. Any code that clears a
  flag "right after" a write it made itself is wrong: the listener has not run
  yet, and it sets the flag straight back. The mirror's dirty flag was written
  that way first and reported every reload as an unsaved local edit.
- **`store.history.get()` is the change counter the flush cannot lie about.**
  It is a public atom, read synchronously, and only a real mutation moves it.
  That is what makes a clean-or-dirty answer possible at all: a save reads the
  counter before serialising, and after the PUT it clears the flag only if the
  counter has not moved, so an edit made while the write was in flight is
  still reported unsaved. The listener refuses to set the flag when the
  counter equals the saved one, which is how the tail of a drag, flushed a
  frame after the save that already wrote it, stops re-dirtying the tab. A
  first attempt cleared the flag at serialisation time instead and made every
  drag-then-save read as unsaved for ever, which `test/e2e/mirror.test.ts`
  catches.
- **A poll compares the bytes, not the mtime.** The GET carries the whole
  document every second, so comparing it with what the tab last saw costs a
  string compare and cannot miss a write two coarse-clock ticks apart. The
  mtime is still read and reported; it is no longer the trigger. The poll also
  captures a save counter before its request and drops the answer if it moved,
  because a GET issued before a PUT can land after it and would otherwise
  reload the pre-save document over the edit just written.
- **`loadSnapshot` writes as `source: 'user'` unless you say otherwise.** It
  is an ordinary store write, so a listener filtered to `source: 'user'`
  cannot tell a load from a human. `editor.store.mergeRemoteChanges(() =>
  loadSnapshot(...))` tags the whole load `remote`, which is what mirror mode
  uses to keep a poll's reload out of its own dirty flag. The nesting is safe:
  `mergeRemoteChanges` refuses to start *inside* an atomic op, but
  `loadSnapshot`'s own `store.atomic` nested inside it is fine.
- **`user` is a document-scoped record, and the full UI creates one on
  mount.** `{ source: 'user', scope: 'document' }` therefore fires once on
  every mirror tab before anybody touches anything, with a `user:...` record
  carrying a name and a cursor colour. `comment` is document-scoped too.
  Filter on `typeName` (`shape`, `binding`, `page`, `asset`, `document`) when
  what you mean is "the drawing changed", because scope alone does not mean
  it.
- **`serializeTldrawJson` writes `editor.store.allRecords()`, every scope.** A
  `.tldr` this tool writes carries `camera`, `instance`, `instance_page_state`
  and `pointer` records alongside the shapes, from the CLI and from the mirror
  alike. Harmless, because `load` reads back through
  `getStoreSnapshot("document")` and drops them, but it is why a saved file
  has record types the document scope has never heard of.
- **A snapshot with a `session` key moves the camera.** `loadSnapshot(store,
  { document })` keeps the viewer's camera, selection and current page;
  adding `session` replaces all three with whoever wrote the file. Mirror mode
  passes `document` alone for exactly that reason, and calls `zoomToFit()`
  once, on the first load only.
- **tldraw's own UI does not bind Cmd+S.** The `save-file-copy` action lives
  in the tldraw.com app, not in the library, so mirror mode's handler has
  nothing to fight. It still listens on `window` in the capture phase and
  calls `preventDefault`, because the browser's own "save this page" dialog is
  the thing that would otherwise open.

## Where the design lives

[docs/](docs/README.md), in this repo. [DECISIONS.md](docs/DECISIONS.md) for
the calls already made, [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
package layout and the bridge, [CLI.md](docs/CLI.md) for every command, flag,
JSON shape and exit code, [HELPERS.md](docs/HELPERS.md) for the snippet
vocabulary and the nine lint rules, [ROADMAP.md](docs/ROADMAP.md) for the
phase checklists and the known gaps, and [PRIOR-ART.md](docs/PRIOR-ART.md) for
what was checked and ruled out. Those files are the contract. Tick a roadmap
item in the PR that completes it, and record a decision there when you make
one, not here.

They were written in the self-learn repo, at `tldraw-integration/`, before any
of this existed, and lived there through phases 0 to 4 (D12) because that is
where the tool was being consumed. They moved here once it was finished. What
stayed behind is the part that was about that repo rather than about the tool:
where its assets live, how its tutoring loop calls this, and which of its
documents had to change.

## Relation to self-learn

`tldrawkc` is a git submodule of
[self-learn](https://github.com/c-wenlong/self-learn) at `tools/tldrawkc/`, the
same arrangement `manimkc/` has. That means:

- **Commits here belong to this repo.** Commit and push here first, then bump
  the submodule pointer in self-learn. Never leave a pointer at an unpushed
  commit.
- self-learn drives the tool through `npm run canvas -- <command>`, which is
  `node tools/tldrawkc/dist/cli/index.js`. A fresh clone needs
  `git submodule update --init tools/tldrawkc` and then `npm ci && npm run build`
  in here before that works.
- `tools/tldrawkc/**` is in self-learn's ESLint ignore block. Lint this repo
  with this repo's own config.
- Committed artefacts (the `.tldr` source and the exported `.svg`) live in
  self-learn under `learn/assets/`, not here. PNGs are for looking at and are
  never committed anywhere.

## Conventions

- Branch from `main`, never commit to it. One concern per PR. Run
  `npm run lint && npm run typecheck && npm test && npm run build` before
  opening one.
- Justify a new runtime dependency in the PR body. There are exactly two today
  (`playwright-core` and `subset-font`) and `test/unit/layering.test.ts` pins
  that list, so adding a third is a deliberate act with a red test in front of
  it. `subset-font` is harfbuzz's own `hb-subset` as wasm, with no native
  build, no install script and no postinstall download; its tree is about
  4.7 MB on disk and every licence in it is permissive (BSD-3-Clause or MIT).
- Add a unit test for anything in `src/lib` or `src/cli`. The page is checked
  end to end, by looking at what it drew.
- `test/e2e/node-side.test.ts` drives the library against the stand-in bridge
  in `test/e2e/fixtures/stand-in-page/`, which answers the bridge contract
  without tldraw. Use it for anything Node decides, and keep it a stand-in: the
  moment it starts emulating tldraw it stops telling you anything.
- No em dashes in prose. Commas, colons, or two sentences.
