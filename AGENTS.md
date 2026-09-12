# tldrawkc, the agent guide

A command line tool that draws diagrams on a real tldraw canvas, screenshots
them, and lets the agent that asked look and iterate. One Node program and one
browser page: the page owns every drawing decision, and Node only launches it,
moves files and prints.

This file is the operating manual. [README.md](README.md) says what the tool
is for; the design docs it is built from live in the self-learn repo (see
"Where the design lives" below).

**Status: phase 1.** `new`, `run`, `shot` and `doctor` work. `inspect`,
`export`, `from-mermaid` and `serve` are specified and not written yet;
`tldrawkc help` lists which phase brings each one.

## What lives where

| Path | What it is |
| --- | --- |
| `bin/tldrawkc` | shell shim, `exec node ../dist/cli/index.js "$@"`. Needs a build to have run |
| `src/cli/index.ts` | the only module that prints. Dispatches on the first positional, owns every exit code |
| `src/cli/args.ts` | `parseCommand(argv, env)`, pure: no printing, no exiting, no throwing. Returns a parsed command or an error string |
| `src/lib/paths.ts` | every path the tool computes. Nothing else builds one |
| `src/lib/files.ts` | every file write, all atomic (temp sibling, then rename) |
| `src/lib/browser.ts` | resolving Chromium, opening the page, the typed wrapper over every bridge call, and `withCanvas` |
| `src/lib/server.ts` | the static server for `dist/page`, on 127.0.0.1 and a random free port |
| `src/lib/canvas.ts` | one function per verb: `run`, `shot`, `newDocument`. Takes data, returns data |
| `src/lib/errors.ts` | the failures the tool raises on purpose, each carrying its exit code |
| `src/lib/doctor.ts` | the environment checks, as data |
| `src/lib/index.ts` | the public API, what `exports["."]` points at |
| `src/page/` | the Vite app: `<Tldraw>`, the bridge, and (from phase 1) the helpers bag, mermaid importer and lint pass |
| `test/unit/` | node only, no browser, runs on every push |
| `test/e2e/` | real Chromium. CI installs one first |
| `dist/` | build output, gitignored: `dist/cli/`, `dist/lib/`, `dist/page/` |

## Build and test

```bash
npm ci
npm run build          # tsc for src/cli and src/lib, vite for src/page
npm run lint
npm run typecheck
npm test               # unit
npm run test:e2e       # needs a Chromium and a build; see below
node dist/cli/index.js doctor
```

`npm run build` has to have run before anything works: `bin/tldrawkc` executes
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
design docs and implemented in `src/lib/browser.ts`:

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

`playwright` is a devDependency pinned to the **exact same version** as
`playwright-core`. It has no install script of its own (checked against
1.63.0: the published `package.json` has no `scripts` block at all), so it
downloads nothing at `npm install` time. What it buys is that `npx playwright
install chromium` resolves the local copy and fetches the browser revision
`playwright-core` expects, instead of whatever the registry serves that day.
Bump the two together or not at all.

## Verbs

Every verb is one function in `src/lib/canvas.ts` that takes an options object
and returns a result object. None of them print, none of them exit, and none
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

## Layering rules

The full list is in the design docs. The ones that bite:

1. **`src/lib/` and `src/cli/` never import `tldraw`, `react` or `src/page/`.**
   Those live only in the page bundle. `test/unit/layering.test.ts` greps for
   them and fails. This is what keeps React out of the dependency tree of any
   repo that installs the tool.
2. **`src/page/` never touches the filesystem or the network.** It takes
   strings and returns strings through the bridge. Serve mode's two fetches to
   `/api/document` are the one exception, and they arrive in phase 4.
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

## Where the design lives

The brief this repo is built from is in the self-learn repo at
[tldraw-integration/](https://github.com/c-wenlong/self-learn/tree/main/tldraw-integration):
`DECISIONS.md` for the calls already made, `ARCHITECTURE.md` for the package
layout and the bridge, `CLI.md` for every command, flag, JSON shape and exit
code, `HELPERS.md` for the snippet vocabulary, and `ROADMAP.md` for the phase
checklists. Those files are the contract. Tick a roadmap item in the PR that
completes it, and record a decision there when you make one, not here.

Keeping them there while the tool is young is deliberate (D12): self-learn is
where the tool is consumed and where the phases are tracked. Moving them into
this repo is a phase 3 or later concern.

## Relation to self-learn

`tldrawkc` is a git submodule of
[self-learn](https://github.com/c-wenlong/self-learn) at `tldrawkc/`, the same
arrangement `manimkc/` has. That means:

- **Commits here belong to this repo.** Commit and push here first, then bump
  the submodule pointer in self-learn. Never leave a pointer at an unpushed
  commit.
- self-learn drives the tool through `npm run canvas -- <command>`, which is
  `node tldrawkc/dist/cli/index.js`. A fresh clone needs
  `git submodule update --init tldrawkc` and then `npm ci && npm run build` in
  here before that works.
- `tldrawkc/**` is in self-learn's ESLint ignore block. Lint this repo with
  this repo's own config.
- Committed artefacts (the `.tldr` source and the exported `.svg`) live in
  self-learn under `learn/assets/`, not here. PNGs are for looking at and are
  never committed anywhere.

## Conventions

- Branch from `main`, never commit to it. One concern per PR. Run
  `npm run lint && npm run typecheck && npm test && npm run build` before
  opening one.
- Justify a new runtime dependency in the PR body. There is exactly one today
  (`playwright-core`) and that is the point.
- Add a unit test for anything in `src/lib` or `src/cli`. The page is checked
  end to end, by looking at what it drew.
- `test/e2e/node-side.test.ts` drives the library against the stand-in bridge
  in `test/e2e/fixtures/stand-in-page/`, which answers the bridge contract
  without tldraw. Use it for anything Node decides, and keep it a stand-in: the
  moment it starts emulating tldraw it stops telling you anything.
- No em dashes in prose. Commas, colons, or two sentences.
