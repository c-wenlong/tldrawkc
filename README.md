# tldrawkc

Draw a diagram on a real [tldraw](https://tldraw.dev) canvas from the command
line, take a picture of it, look, and fix it. Built for coding agents, which
write code well and read images well but cannot see what they just drew unless
something renders it.

**Status: phase 0.** The package builds, tests and runs `doctor`. The drawing
verbs are specified and not written yet. `tldrawkc help` lists which phase
brings each one.

## The loop

One Node program and one browser page. Every command launches headless
Chromium, loads a `.tldr` file into a live tldraw editor, runs a JavaScript
snippet against it with a `helpers` bag in scope, saves the file, and
optionally writes a PNG or an SVG. The agent reads the PNG with its own image
tooling and sends the next snippet. A lint pass flags the two things that go
wrong with generated diagrams, overlapping shapes and arrows pointing at
nothing, and makes them a non-zero exit code so nobody declares the drawing
finished without looking. There is no daemon, no sync server, and no React in
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
git submodule update --init tldrawkc
(cd tldrawkc && npm ci && npm run build)
npm run canvas -- doctor
```

## Design

The brief this is built from lives in the self-learn repo under
[tldraw-integration/](https://github.com/c-wenlong/self-learn/tree/main/tldraw-integration):
the decisions already made, the architecture, the full CLI reference, the
helper vocabulary, and the phase roadmap. [AGENTS.md](AGENTS.md) is the
operating manual for working in this repo.

## Licence

MIT. See [LICENSE](LICENSE).
