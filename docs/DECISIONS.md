# Decisions

Recorded so they are not relitigated. Each has a verdict and the reason.
Reopen one only with new information, and update this file when you do.

## D1. The browser owns all drawing logic; Node only drives it

**Verdict:** every shape, binding, layout, lint and export is computed
inside a real tldraw `Editor` in Chromium. Node never constructs records.

**Why:** there is no supported headless `Editor` (see
[PRIOR-ART.md](PRIOR-ART.md)). Building records in Node with
`@tldraw/store` is possible but throws away bound-arrow geometry, elbow
routing and text measurement, which are exactly the features that made the
ERD in this design session look right. And screenshots need a browser
anyway, so a browser is already a hard dependency.

## D2. Stateless commands, no daemon

**Verdict:** every command launches Chromium, does one job, saves and
exits. State lives only in the `.tldr` file.

**Why:** a daemon needs a state file, a port, a token, idle timeouts and a
story for stale processes, and every one of those is a bug an agent will
hit. One to two seconds of startup per command is cheap next to the model's
own turn time. A warm-browser cache is a roadmap item if latency turns out
to matter.

## D3. No sync server, no collaboration

**Verdict:** `@tldraw/sync` is not used. The human view is a page that
polls a file and saves back to it.

**Why:** the use case is one agent drawing and one person occasionally
looking or nudging. `TLSocketRoom.updateStore`, the server-side write path a
CLI would need, is deprecated with no replacement. Two writers on one file
with last-write-wins is enough, and it is honest about what it is.

## D4. Its own repo, wired in as a submodule

**Verdict:** `tldrawkc` is a separate repository (`c-wenlong/tldrawkc`,
name pending) added to self-learn as a submodule, exactly as `manimkc` is.
Not a folder inside `manimkc`, not a folder inside that repo's app.

**Why:** it is a TypeScript and browser project; manimkc is Python and
manim. Sharing a repo would mean two toolchains, two CIs and two AGENTS.md
in one place. And the stated goal is to open-source it as a tool for
agents, which needs its own README, license and issue tracker. The
submodule pattern already works in self-learn, including the symlinked skill
and the "commit inside the submodule first" rule in its root AGENTS.md.

## D5. Snippets are JavaScript, not a fixed command vocabulary

**Verdict:** `run --code` takes JavaScript with `editor`, `helpers` and
`tldraw` in scope. The helpers are the recommended vocabulary, not the only
one.

**Why:** the agents using this are Claude Code sessions that write code
well. A closed vocabulary would need extending every time a diagram wanted
something new, and the escape hatch to `editor` is what let the ERD get
right-angle lanes and custom anchors. The trade-off is that a snippet can
do anything the page can, so the page must never have filesystem or
network access of its own (layering rule 2 in
[ARCHITECTURE.md](ARCHITECTURE.md)).

## D6. MCP entry deferred

**Verdict:** not in v1. The library API is JSON in, JSON out so an MCP
wrapper is a thin later addition (roadmap phase 5).

**Why:** the consumer today is Claude Code, which runs shell commands and
reads files natively; a skill plus a CLI is the same pattern manimkc uses
and it works. MCP earns its place when a second client appears (Claude
Desktop, Cursor, an n8n flow) or when open-source users ask for it, which
[joelhooks/tldraw-agent](https://github.com/joelhooks/tldraw-agent) suggests
they will. Building it first would be building for a user we do not have.

## D7. No new frontend in self-learn for now

**Verdict:** self-learn's web app stays the course encyclopedia. The tool's
human view is
`tldrawkc serve`, a local page the tool itself serves. A combined local
"studio" that also shows manimkc jobs and videos is a separate, later
project (roadmap phase 6), and if it happens it lives in its own small app,
not in that one.

**Why:** that app deploys to Vercel. A headless-browser tool with local file
access has no business in that build, and the app's only visual component
today is a static SVG graph, so there is nothing to reuse. manimkc's server
is a JSON job API with no UI and publishes videos to Seafile, so a video
panel would be new integration work on both sides. Ship the diagram tool
first; decide on a studio once both tools have a few weeks of real use.

## D8. Exports are SVG for notes, PNG for looking

**Verdict:** the committed artefact next to a concept note stays an SVG,
embedded with `![[name.svg]]` as today. PNGs are for the agent's eyes and
are not committed. The `.tldr` source is committed alongside the SVG.

**Why:** everything downstream (Obsidian embeds, the `/learn` page, the
session log renderer) already handles SVG. Committing the `.tldr` is what
makes a diagram editable next time instead of redrawn.

## D9. `playwright-core` with a resolved Chromium, not bundled `playwright`

**Verdict:** depend on `playwright-core` and resolve a browser in this
order: `--chromium`, `TLDRAWKC_CHROMIUM`, Playwright's own registry if the
user ran `npx playwright install chromium`, then installed Chrome or
Chromium apps.

**Why:** `playwright-core` ships no browser of its own, so nothing is
downloaded at install time inside a submodule. Most machines already have a
Chrome; CI installs one explicitly. `doctor` tells the user which one was
picked.

**Corrected 2026-09-13 (phase 0).** This decision originally said the full
`playwright` package "downloads browsers on install". That was true once and
is not true of current versions: `playwright@1.63.0`'s published
`package.json` has no `scripts` block at all, so there is no `postinstall` and
no download. The verdict stands on the other reason, which is the one that
mattered: `playwright-core` is the driver without the browser, and the browser
should come from the machine. See D11 for what changed as a result.

## D10. Lints fail the command

**Verdict:** `run` exits 3 when lints remain, even though the file was
saved. `--allow-lints` plus `meta.lintIgnore` is the opt-out.

**Why:** the failure modes of the hand-written SVG this tool replaced were overlaps
and arrows pointing at nothing. Making those a non-zero exit is the
cheapest way to make an agent look again.

## D11. `playwright` is a devDependency, pinned to the `playwright-core` version

**Verdict:** `playwright-core` stays the one runtime dependency. `playwright`
is added as a devDependency at the **exact same version**, and the two are
bumped together or not at all. The resolution order in D9 is unchanged.

**Why:** `playwright` no longer has an install script (checked by unpacking
the 1.63.0 tarball, not by reading the docs), so it costs nothing at
`npm install` time. What it buys is that `npx playwright install chromium
--with-deps` in CI resolves the local copy and fetches exactly the browser
revision `playwright-core` expects, instead of whatever version the registry
serves that day. A driver and a browser from different Playwright releases
fail at launch with a protocol mismatch, and that failure reads as "the
browser is broken" rather than "the versions drifted". Pinning is the cheapest
way to never debug it.

## D12. The design docs stay in self-learn until phase 3

**Verdict:** for phases 0 to 2, `self-learn/tldraw-integration/` is the source
of truth for the brief. `tldrawkc`'s own `README.md` and `AGENTS.md` link back
to it rather than carrying a copy. Moving or splitting them is a phase 3 or
later concern.

**Why:** self-learn is where the tool is consumed, where the roadmap is
ticked, and where the decision to build it was made, so that is where someone
goes looking. Two copies would drift the way a local skill copy drifts from
the plugin it shadows, which is a trap this repo already names in its root
`AGENTS.md`. Phase 3 is when `tldrawkc` grows outward-facing docs of its own
(a skill, a published README for people who are not us), and that is the right
moment to decide what moves, what stays, and what becomes a link.

**Settled 2026-09-13, after phase 4.** They moved. This file, and the five
beside it in `docs/`, are that decision carried out: the tool is finished, it
has readers who are not self-learn, and a brief describing a tool cannot live
in one of its consumers. What stayed behind is the part that was never about
the tool, the seams with a specific repo's `learn/assets/`, its pipeline and
its plugin, which is now in self-learn's own documents. The condition this
verdict named is the one that fired, so the verdict is spent rather than
overturned.

## D13. An arrow's id is derived from the pair it joins

**Verdict:** `connect` names its arrow `shape:arrow:<from>-><to>`. A shape key
that already contains `->` is refused with a message, not escaped into the id.

**Why:** deriving the id from the pair is what makes a snippet re-runnable: the
second run updates the arrow instead of stacking another one on it. `->` is the
separator because a dash would collide (`a-b` to `c` against `a` to `b-c`).
Allowing `->` inside a key brings the collision back one level up, and since
`connect` rebinds whatever it finds at that id, the second call would silently
steal the first one's arrow. Escaping would hide that in an id nobody can read.
A second arrow between the same pair passes `opts.id`.

## D14. Auto anchors run down the overlap band, and every binding is precise

**Verdict:** an end the caller did not name gets its anchor from the band where
the two shapes' extents overlap, and every binding is created with
`isPrecise: true` whether the anchor was named or derived.

**Why:** an imprecise binding throws the anchor away. tldraw ignores
`normalizedAnchor` and aims the terminal at the shape's centre, so two boxes
whose centres differ (any row where one label wrapped to a second line and grew
its box) get a short dog-leg with the label sitting on top of it, which reads as
a broken arrow. Precise binding keeps the anchor, and putting both anchors on
one line down the overlap band is what makes the arrow straight whenever a
straight arrow is possible. Shapes that do not overlap at all fall back to the
side midpoint, where a bend was unavoidable anyway.

## D15. A failed request includes any response with status 400 or worse

**Verdict:** the page's failed-request log counts Playwright's `requestfailed`
event **and** every response that came back at 400 or above. `doctor` fails on
either.

**Why:** a missing font is a 404, not a transport failure. The request
succeeded and the answer was "no", so Chromium never fires `requestfailed`, and
a check that watched only that event would pass on the exact case it exists to
catch. The failure downstream is silent: the export falls back to a system font
and looks nearly right.

## D16. `new` goes through the browser, and claims the file exclusively

**Verdict:** `new` launches the page, calls `load(null)` and `save()`, and
writes the result with an exclusive create.

**Why:** the `.tldr` envelope carries a schema version and every record's
migration state. Letting the page serialise an empty editor means the file is
exactly what the installed tldraw writes, and it stays correct when tldraw bumps
its schema, which a hand-built envelope would not. The cost is one browser
launch for a mostly empty file, which is a second, once. The exclusive write is
what makes "refuses to overwrite" true rather than likely: the early existence
check is only there to answer fast, and it cannot cover a file created while the
page was starting up.

## D17. Every `src/lib/` failure is a typed error carrying its own exit code

**Verdict:** `src/lib/` raises one of the classes in `errors.ts`
(`UsageError`, `EnvironmentError`, `ChromiumNotFoundError`, `SnippetError`,
`ExportError`), each with an `exitCode` property. Exit 3 is not among them.

**Why:** the CLI reads a property instead of matching on message text, so
rewording an error cannot change what the shell sees. Exit 3 is deliberately
outside the scheme because nothing failed: the snippet ran, the file was saved,
and lints remain, so `run` returns normally with its lint list and an
`exitCode` of 3. Modelling "the work is done and you should look again" as an
exception would have made the successful path throw.

## D18. The end-to-end suite is split by what it is pinning

**Verdict:** `test/e2e/node-side.test.ts` drives the library against a stand-in
bridge page that answers the contract without tldraw;
`test/e2e/cli.test.ts` spawns the built binary against the real page bundle.

**Why:** they fail for different reasons, and one suite would not say which.
Everything Node decides (the order of load, exec, save and export; which exit
code each failure carries; that a throwing snippet leaves the file byte for
byte as it was) is testable without an editor, and pinning it separately means
a red `cli.test.ts` points at the page. The stand-in has to stay a stand-in:
the moment it starts emulating tldraw it stops telling anyone anything.

## D19. Paths in `--json` output are always absolute

**Verdict:** every path a command prints under `--json` is the resolved
absolute path, never the string that was typed.

**Why:** the consumer is an agent that may read the output from a different
working directory than the one the command ran in, and a relative path is only
meaningful next to a cwd that is not in the output. Absolute costs a longer
line and removes a whole class of "file not found" on a path that exists.

## D20. `withCanvas` is the only thing that opens a browser

**Verdict:** every verb goes through `withCanvas(options, fn)`, which starts the
page server, opens the page, waits for the bridge, runs `fn`, and closes the
browser and the server in a `finally`. No verb calls `openCanvasPage` itself.

**Why:** layering rule 7 says a command never leaves a browser running, and a
rule that each verb has to remember is a rule that a fifth verb will break.
One function means one place to get the cleanup right, and a snippet that hangs
until `--timeout` still leaves a clean process behind.

## D21. One PNG is committed, and it is the README's

**Verdict:** `tldrawkc/docs/example-loop.png` is committed, as the picture in
the tool's README. Every other PNG stays uncommitted, per D8.

**Why:** a tool whose whole claim is "the agent can look at what it drew"
should show the reader what it draws, and a README image has to live in the
repo to render on GitHub. That is one file with a reason, not a loosening of
D8: the working PNGs an agent makes while iterating are still scratch, and
`out/`, `scratch/` and `*.local.png` are gitignored so they stay that way.

## D22. A mermaid back edge is an arc on the outside face, not an elbow

**Verdict:** `applyPlan` detects an edge whose target sits at an earlier rank
and draws it as an `arc`, anchored on the same outside face of both shapes,
with a bend that clears the widest shape on that side.

**Why:** tldraw's elbow router only knows its two endpoints. A `look --> cli`
back edge in a top-down flowchart routed straight up the middle of the diagram
and through six boxes, which reads as a line pointing at nothing. Looping it
out to one side is the only routing available without a real path finder, and
the sign of the bend has to be computed as a dot product against the side you
want, because a positive bend pushes the apex a quarter turn anticlockwise
from the direction of travel.

## D23. A repeat edge between the same pair gets `#n` and its own lane

**Verdict:** when the importer meets the same pair a second time it passes
`opts.id` as `arrow:<from>-><to>#2`, `#3` and so on, and offsets that repeat's
`mid` by 0.15 per repeat.

**Why:** D13 derives an arrow's id from the pair, which is what makes `connect`
re-runnable, and says a second arrow between the same pair passes `opts.id`.
This is what passes it. `connect` itself still has no automatic repeat
handling, deliberately: an automatic suffix would make a re-run stack a new
arrow every time, which is the behaviour D13 exists to prevent. The `mid`
offset is what stops two repeats from landing on the same path and reading as
one arrow.

## D24. A labelled container gets 24 page units of headroom

**Verdict:** `boxShapes` adds `CONTAINER_LABEL_HEADROOM`, 24 units, above the
members when the container has a label, and nothing when it does not.

**Why:** a container is a geo rectangle sent to back, and tldraw paints its
label inside the top of that rectangle. With only the margin, the label lands
on the topmost member, which is exactly the overlap the lint pass exists to
catch, from the helper that is supposed to tidy a group up.

## D25. `applyPlan` respaces the ranks after the shapes exist

**Verdict:** shapes are created from the parser's positions, then a
`respaceRanks` pass reads the real page bounds and reflows the bands and slots.

**Why:** the parser sizes a box by counting characters, in node, with no text
measurer. The real height only exists once tldraw has laid the label out and
applied `growY`, and `getShapePageBounds` on a three-line label reported 122
against a declared 64. Spacing computed before that is spacing computed against
the wrong numbers, so the pass has to run after creation rather than instead of
it.

## D26. Mermaid's `id(text)` maps to geo `oval`

**Verdict:** the parser records `rounded: true` on a plan node and `applyPlan`
turns it into `oval`. `id(text)` and `id([text])` therefore render identically.

**Why:** `GeoShapeGeoStyle` in tldraw 5 is a fixed enum with no rounded
rectangle, and `TLGeoShapeProps` carries nothing to round a corner with. The
capsule is the nearest silhouette tldraw owns and the only one that reads as
"not a plain box". Keeping the hint in the plan rather than resolving it in the
parser leaves the door open if tldraw ever grows the shape.

## D27. SVG labels are `<foreignObject>` HTML, and that is accepted

**Verdict:** exported SVGs carry their labels as HTML inside
`<foreignObject>`, with no `<text>` or `<tspan>` anywhere. No post-processing
converts them.

**Why:** it is `getSvgString`'s own output, not a choice here, and the
alternative is re-implementing tldraw's text layout in a post-pass that would
drift from what the canvas shows. The cost is real and worth naming: a
rasteriser without foreignObject support (librsvg, ImageMagick, older
Inkscape) drops every label from a committed SVG. Every consumer known today
is a browser, so the cost is not being paid.

## D28. `from-mermaid` probes for `helpers.mermaid` and exits 1 on a stale bundle

**Verdict:** before it draws, the command runs a one-line snippet asking
whether `helpers.mermaid` is a function, and raises an `EnvironmentError`
naming the rebuild when it is not.

**Why:** the bridge's capability check sees the bridge, and the helpers bag is
one level below it, so a page bundle built before phase 2 answers every check
and then fails inside the snippet as `helpers.mermaid is not a function` with
exit 2. Exit 2 means the diagram threw, which sends the reader to the
flowchart. This is an environment problem and carries the environment's code.

## D29. The flowchart is JSON-encoded into the snippet

**Verdict:** `from-mermaid` embeds the source as a JSON string literal and
parses it back at runtime, rather than concatenating it into the program text.

**Why:** a diagram is arbitrary text. One backtick, quote or backslash in a
node label would end the literal and run the rest of the file as code, in a
snippet that already has the full `editor` in scope. The encoding costs one
`JSON.parse` and removes the class entirely.

## D30. `api` extraction is scoped to `helpers/index.ts`

**Verdict:** the reference is generated from exactly one file,
`src/page/helpers/index.ts`, and from doc blocks sitting directly above a
named function or an interface method and carrying an `@example`.

**Why:** that file is where the bag is assembled, so scoping to it means the
reference is the bag and cannot advertise a helper a snippet could not call.
The three conditions are what keep it honest in the other direction: a block
separated by a blank line documents the file or the section, and an entry with
no example is not a line an agent can copy.

## D31. Containers are built innermost first

**Verdict:** `applyPlan` sorts the subgraphs by depth and creates the deepest
ones first.

**Why:** a container is sized to the page bounds of its members, and an outer
subgraph's members include the inner containers. Building outermost first
sizes the outer box against shapes that do not exist yet, and an outer block
whose children are all subgraphs has no direct members at all, so it would get
no container. Depth order is what makes nesting come out right without a
second pass.

## D32. Every verb refuses an export aimed at its own document

**Verdict:** `run`, `shot`, `export` and `from-mermaid` all check each export
target against the `.tldr` they were given and raise a `UsageError` when they
match.

**Why:** every write is atomic, so `run map.tldr --svg map.tldr` renames an
SVG over the document and the drawing is gone with no error anywhere. It is a
plausible typo, the loss is total, and the check is one path comparison per
target. A shared guard rather than a check per verb, for the same reason
`withCanvas` is shared: a rule each verb has to remember is a rule the fifth
verb breaks.

## D33. The CLI prints a snippet's stack unadjusted

**Superseded by D34 in tldrawkc PR #5.** The stack is now rewritten. Kept for
the reasoning, which held until the follow-up it named arrived.

**Verdict:** the two-line `AsyncFunction` header offset stays in the stack the
CLI prints. [CLI.md](CLI.md) and [ARCHITECTURE.md](ARCHITECTURE.md) tell the
reader to subtract 2.

**Why:** the offset is measured and constant, so documenting it is honest and
cheap. Rewriting the stack means parsing V8's format, which differs by shape
of frame and by Node version, and a rewriter that gets one frame wrong is
worse than an offset that is written down. Adjusting it is a follow-up worth
doing once something else needs to parse that stack.

## D34. A snippet's stack is rewritten to its own line numbers

**Verdict:** the snippet source is tagged with a trailing
`//# sourceURL=snippet.js` comment, and every `snippet.js:LINE:COLUMN` frame
in the thrown stack has `SNIPPET_LINE_OFFSET` (2) subtracted from its line
before the CLI prints it. Supersedes D33.

**Why:** D33's objection was that rewriting a stack means parsing V8's format
and that a rewriter which gets one frame wrong is worse than a documented
offset. Naming the script removes that risk instead of taking it. Without a
`sourceURL`, every frame in a compiled `AsyncFunction` reads `<anonymous>`,
including the ones playwright's own injected script contributes, so there is
nothing to match on; with it, only the snippet's frames say `snippet.js` and
the regex cannot touch a frame it does not own. The rewrite is a number
substitution inside frames the snippet owns, not a re-parse of the stack.

What forced it: drawing the vector diagram meant a dozen snippet passes, and
a thrown error pointing two lines away from the real one costs a round trip
every time. "Subtract 2" written in a doc is a rule the reader applies wrong
once and then stops trusting the number at all.

## D35. `arrow-crosses-shape` uses a tolerance of 4 page units

**Verdict:** an arrow has to run more than 4 page units inside a shape's
eroded outline before the rule fires. `ARROW_CROSSING_TOLERANCE = 4`.

**Why:** it comes from stroke width, not from taste. tldraw draws a size `m`
shape at 3.5 page units, so an arrow's own half stroke plus the box outline's
half stroke is 3.5 units of overlap before a reader sees anything other than
two lines meeting. 4 is that rounded up, and the spare half unit also absorbs
the error in sampling an arc: the rule walks a curve as a polyline, and a
chord can cut a corner the curve itself clears.

It is a threshold on depth, not on length. An arrow that grazes a long box
edge for 200 units stays silent; one that dives 5 units into a small box
fires, because disappearing behind a shape is the failure, and how far it
travels while hidden is not what a reader notices.

The opt-out matters as much as the number. A marker an arrow is drawn from,
such as a dot at the origin of a pair of axes, is crossed by every axis and
every vector by design, and no tolerance distinguishes that from an arrow
routed over a box. `meta.lintIgnore: ['arrow-crosses-shape']` on the marker is
the answer, and the vector diagram is the first place it was needed.

## D36. Document metadata is a versioned object on the document record, not a sidecar file

**Verdict:** what a diagram is about, `{ kc, title, topic, concepts, source,
created }`, is stored under `meta.tldrawkc` on the tldraw `document:document`
record, inside the `.tldr` itself. There is no `.meta.json`, no front matter,
no second file next to the drawing. `kc` is a schema version: a reader keeps
a version it does not recognise, a writer refuses one, so an older build can
never fold a patch into a newer object and quietly drop what that version
added.

**Why:** a sidecar file is a second thing that can go missing, get renamed
independently of the diagram, or be copied without its partner, and every one
of those is a silent way to lose what a drawing is about. tldraw already
ships a `meta` bag on every record for exactly this purpose, JSON in, JSON
out, migrated by nothing because it is opaque to tldraw's own schema, so
using it costs no new file format and no new parser. It also means `list`
and `meta set` can read and write the metadata with `readText`/`writeText`
over the existing `.tldr`, no browser, which is the reason a catalog over a
directory of diagrams can run on every index instead of once per file per
Chromium launch.

The versioning matters because this is a file meant to be read by something
else later, possibly a future build of this same tool. Six fields is what
version 1 knows; a version 2 that added a seventh and represented it as a
plain merge would silently discard that seventh field whenever a version-1
writer touched the file again, and nothing downstream would notice until the
data was already gone. Refusing to write a version it does not know is the
one guard that catches that before it happens.

What forced it: `list` exists because a diagram nothing can file is a diagram
nobody finds again, and a directory of thirty `.tldr` files with no way to
say what any of them are about was exactly that problem. `missing-topic`
(the eighth lint rule, see [HELPERS.md](HELPERS.md)) is a warning rather than
an error for the same reason this decision keeps the metadata optional:
every diagram drawn before this shipped has none, and failing all of them at
once would be the tool breaking work that was already fine.

## D37. `line` and `stub` mute `friendless-arrow` and `arrow-crosses-shape` by default

**Verdict:** every mark `helpers.line` or `helpers.stub` draws carries
`meta.lintIgnore = ['friendless-arrow', 'arrow-crosses-shape']` unless the
caller says otherwise. `lintIgnore: []` lints it like any other arrow, and
`true` mutes every rule.

**Why:** both rules exist to catch an arrow that claims a connection it does
not have, and a line never made that claim. `friendless-arrow` fires on an
unbound end, which is the whole definition of a line; `arrow-crosses-shape`
fires on a path running through a shape that is neither endpoint, which is
what an axis through the dot at its own origin does by design. Leaving them on
would mean every axis, tick, vector and rule in a teaching diagram had to be
excused one by one, and a lint that is muted by hand at every call site is a
lint nobody reads.

The default is a default, not a rule change. `connect` is untouched, so a real
connection is still linted exactly as before, and the opt-out runs both ways:
a caller who wants a line held to the arrow rules passes `lintIgnore: []`.
What forced it was the vector redraw, which hand-rolled a raw arrow shape with
`meta.lintIgnore` set 27 times over two diagrams, which is precisely the work
the helpers bag exists to absorb.

## D38. Inlined fonts are subset, not linked

**Verdict:** `export --svg` and `run --svg` subset every inlined
`@font-face` to the glyphs the document draws and drop any family nothing
references, by default; `--no-subset-fonts` keeps the whole fonts.

**Why:** D8 wants a self-contained SVG, and an SVG loaded as an image
fetches nothing, so linking the fonts would silently degrade every label to
a system font. Whole fonts were most of the file: 294 kB of base64 against
161 kB of drawing. Subsetting takes that to 46 kB with a pixel-identical
render, verified in a real Chrome on both committed diagrams. `subset-font`
(harfbuzz as wasm, 4.7 MB installed, no native build) is the second runtime
dependency.

## D39. Mirror mode is a query parameter on the one page bundle

**Verdict:** there is one build of `src/page`. `/?mirror=1` mounts the human
mirror from `mirror.tsx` with tldraw's full UI; any other URL mounts the
headless canvas every other verb drives. No second entry point, no second
Vite build, no second bundle to ship.

**Why:** the two views have to agree about everything that matters. They load
the same `.tldr` through the same `load`, they run the same helpers and the
same lint pass, and a person dragging a box in the tab is editing the document
the next `run` will open. Two bundles would be two copies of that agreement,
kept in step by hand, and the failure would be silent: the mirror renders a
diagram slightly differently from the canvas the agent screenshotted, and
nobody can tell which one is lying. A query parameter also means `serve` needs
no build of its own and `doctor`'s page check covers the mirror's bundle too.

The cost is that the mirror's React and tldraw UI code ship inside the bundle
every headless verb loads. Measured against a page that is already about 5 MB
on disk because `@tldraw/assets` brings forty translation files with it, that
is not where the weight is.

## D40. A foreign load is applied through `mergeRemoteChanges`

**Verdict:** mirror mode applies every document it did not itself produce
inside `editor.store.mergeRemoteChanges(() => loadSnapshot(store, { document }))`.

**Why:** `loadSnapshot` is an ordinary store write, so it lands as
`source: 'user'` and is indistinguishable from a person drawing. The tab's
unsaved-edits flag listens for exactly that, so without the wrapper every poll
that reloaded the file marked the tab dirty on the strength of its own reload,
and the banner that is supposed to mean "your edits were overwritten" fired on
every quiet second. `mergeRemoteChanges` tags the whole load `remote`, which
is what the flag filters on. The nesting is safe: it refuses to start inside
an atomic op, and `loadSnapshot`'s own `store.atomic` nested inside it is
fine, which is the order this uses.

It is also why the flag is settled against `store.history`, tldraw's own
change counter, rather than against the listener alone. Store listeners are
flushed on the next frame, so any code that clears a flag "right after" a
write it made itself is cleared before the listener has run and is set
straight back by it.

## D41. `/favicon.ico` answers 204, in serve mode only

**Verdict:** the serve-mode server answers `/favicon.ico` with 204 and no
body, and only when `dist/page` has no icon of its own. `startPageServer`,
which every headless verb uses, does not mount it.

**Why:** a real browser tab asks for an icon whether or not the page declares
one, and the bundle ships none. Layering rule 8 counts a 404 as a failed
request, so without the route an honest audit of a serve session reads as
broken and the one signal that matters (a font that did not load) is buried
under noise the tool made itself. 204 rather than an inlined one-pixel image,
because the tab should fall back to the browser's own default rather than show
a blank square this repo would then own.

Two scopes, both deliberate. Serve mode only, because a headless verb's tab
never asks and a route mounted everywhere is surface with no reader. And only
when no real file is there, so the day someone adds `dist/page/favicon.ico` it
is served rather than quietly shadowed by an empty answer.

## D42. A `PUT /api/document` body is capped at 50 MB

**Verdict:** `MAX_DOCUMENT_BYTES` is 50 MB. A larger body is refused with 413
before anything touches disk, the rest of it is drained rather than the socket
destroyed, and the connection is closed afterwards.

**Why:** the page is the only client the server expects, but a server cannot
know that, and reading an unbounded body into memory because the sender
promised to be friendly is how a local tool becomes a way to exhaust a
machine. 50 MB is far above any real document (a `.tldr` with assets inlined
as data URLs is the large case, and the biggest drawn so far is under one) and
far below anything that hurts.

Draining rather than destroying is the part that is easy to get wrong.
Destroying the request destroys the response with it, so the client waits for
a 413 that was thrown away and reports a network error instead of the refusal
it was given. The body is discarded as it arrives, the 413 is flushed, and
`Connection: close` is what ends the read.

## D43. `missing-glyph` is a warning, and coverage is read from the woff2 `cmap`

**Verdict:** a label asking its font for a character that font has no glyph
for is a lint at `severity: 'warn'`, alongside `missing-topic`. The coverage
it checks against is generated from the bundled woff2 files themselves, into
`src/page/helpers/font-coverage.ts`, by parsing each face's `cmap` table.

**Why a warning:** the same reason as D36. Every diagram drawn before the rule
existed would fail it on sight wherever it used a Greek letter, and a rule
that turns work which reads correctly red is a rule people learn to pass with
`--allow-lints`, which costs the rules that do mean the picture is wrong. The
finding is worth making because the failure is silent and machine-dependent:
the character falls through to whatever the reader's system has, so the author
sees one typeface and the reader sees another.

**Why the `cmap`:** neither of the two obvious oracles can answer the
question. `document.fonts.check('40px tldraw_draw', 'θ')` is true for every
character, because the method answers "is a face matching this family loaded",
not "can it draw this". Canvas is no better: `ctx.font` takes a family list
but ignores everything past the first resolvable entry when it falls back, so
a missing glyph lands in a system font rather than the next family named and
cannot be told from a hit. Both were tried before the reader was written. A
woff2 is a table directory plus one brotli stream, `cmap` is never one of the
three tables woff2 transforms, and `node:zlib` decompresses the stream, so the
table comes out byte for byte and needs no new dependency.

Two facts from the generated table are worth stating, because they are what
the rule is for. **`√` is in all four families**, and what looks like a plain
`v` in a `draw` label is Shantell Sans' own hand-drawn radical, so no lint
fires on it and the reason to prefer `sans` for maths is legibility rather
than a missing glyph. And **`⇒ ∈ ∉ ⊂ ∪ ∩ ∀ ∃ ∧ ∨ ∇` are in none of the four**,
so the finding on one of those names no family to switch to: set-theory
notation has to be written out in words.

## D44. The importer sizes a pinched geo by measuring, in `applyPlan`

**Verdict:** `parseMermaid` keeps its character count and `applyPlan` corrects
it. A new pass between creating the shapes and re-spacing the ranks asks
`boxForLabelOf` how big each node has to be for its label's ink to clear its
own outline, and grows the ones that answer bigger than they are. The geometry
behind it is `heightForLabel` in `helpers/lints.ts`, which is
`usableWidthAtBand` inverted: same file, same numbers, opposite direction.

**Why not in the parser:** the room a label needs is a measurement, and
`mermaid.ts` has to stay importable with no editor in scope, which is what
lets the unit suite run it in node (D24). Carrying per-geo inset factors on the
`Plan` instead was the alternative and is worse twice over: it would put a
table of numbers in the parser for shapes whose outlines the page already
knows exactly, and it would still be sizing against a character count rather
than against the text tldraw laid out. `respaceRanks` already exists for the
same reason and settles the layout around whatever this pass grew, so a wider
diamond costs nothing but the room it takes.

**Why a sweep over widths:** tldraw wraps a label at the shape's width, so the
label is not a fixed thing to fit. Sizing a diamond to the ink it has lets that
ink spread onto fewer, longer lines, which needs a wider diamond again: the
first version of this pass chased itself through three rounds and left the
eight-node fixture's decision node 736 units wide, flat as a lozenge, against
320 for the rectangles above it. Measured at each width under consideration
both numbers are honest, and the cheapest box wins. The cost is `w + h` rather
than area, because area alone prefers an ever wider, ever flatter shape: the
minimum of `w * h` for a one-line label runs away to the horizon, and the
minimum of `w + h` is the one that keeps a rank of a flowchart narrow.

**Why nothing that already fits is touched:** a box that holds its label
answers with itself, so every rectangle and any node an author sized generously
comes through unchanged. Without that the sweep would happily widen a rectangle
to unwrap a two-line label, which is a different opinion about how a diagram
should look and not this tool's to have. Measured on the 32-node `learn-map`
fixture: identical bounds and an identical lint list before and after.
