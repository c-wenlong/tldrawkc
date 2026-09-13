# Design docs

The brief this tool was built from. [README.md](../README.md) says what
tldrawkc is for and [AGENTS.md](../AGENTS.md) is the operating manual for
working in the repo; these six files are the contract both of those are built
against.

## Read in this order

| Document | What it settles | Read when |
| --- | --- | --- |
| [DECISIONS.md](DECISIONS.md) | The forty-three calls already made and why. Browser owns drawing, stateless commands, no sync, its own repo, MCP deferred, the calls phase 1 forced (derived arrow ids, precise bindings, typed errors, one browser opener), the ones phase 2 forced (arc back edges, `#n` repeat lanes, a respacing pass after `growY`, foreignObject labels, a scoped `api` reader, no export aimed at its own document), the ones phase 3 forced (a rewritten snippet stack, which supersedes D33, the 4-unit tolerance on `arrow-crosses-shape`, metadata on the `.tldr` itself rather than a sidecar, a decorative line muting the two arrow lints, subsetting every inlined font), and the ones phase 4 forced (mirror mode behind a query parameter, `mergeRemoteChanges` for a foreign load, the favicon, the PUT cap, and a glyph rule that warns). | First. Do not reopen these without new facts. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Package layout, the Node to page bridge, one command end to end, file formats, serve mode, layering rules. | Before writing any code. |
| [CLI.md](CLI.md) | Every command, flag, JSON output and exit code. | While working on `src/cli` and `src/lib`. |
| [HELPERS.md](HELPERS.md) | The `helpers` bag a snippet can call, the nine lint rules, and an example. | While working on `src/page/helpers`. |
| [ROADMAP.md](ROADMAP.md) | Seven phases (0 to 6) with checklists; 0 to 4 are done, 5 and 6 are optional. Plus the known gaps. | To pick up the next item. Tick items in the PR that completes them. |
| [PRIOR-ART.md](PRIOR-ART.md) | What the tldraw docs actually support, existing tools, and what was ruled out. Sources for every claim. | When something in the design seems arbitrary. |

## The one-paragraph version

One Node program and one browser page. The page is a Vite build of tldraw
with a `helpers` bag (bound arrows, boxes, layout, a mermaid importer, a lint
pass) and a small bridge Node can call. Every command launches headless
Chromium, loads a `.tldr` file, runs a JavaScript snippet against the live
editor, saves the file, and optionally writes a PNG or SVG. The agent reads
the PNG with its Read tool and sends the next snippet. A `serve` command opens
the same file in a normal browser tab for a human, reloading on change and
saving Cmd+S back. No daemon, no sync server, no React in the host repo's
dependency tree.

## Where this came from

These documents were written on 2026-09-13 inside
[self-learn](https://github.com/c-wenlong/self-learn), the repo that wanted
the tool, before any code existed. They lived there, at `tldraw-integration/`,
through phases 0 to 4 (D12), and moved here once the tool was finished and had
readers who are not self-learn.

The tool was then built from them in four phases over that same day: the
package and `doctor`, the draw and shot loop, read, export and mermaid import,
the agent skill and the host integration, and the human view.

Two things to know when reading them. Where a claim about tldraw's API turned
out wrong, the correction is written into the doc beside it and dated rather
than quietly replacing the original, so the reasoning is still legible. And
paths naming self-learn are as they were written: the submodule was at
`tldrawkc/` then and is at `tools/tldrawkc/` now, and that repo's web app moved
from `src/` to `apps/web/src/`.
