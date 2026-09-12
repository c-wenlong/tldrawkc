---
name: tldrawkc-diagram
description: Draw a teaching diagram on a real tldraw canvas with the tldrawkc CLI, look at the screenshot, fix it, and export the SVG. Use when the user asks to draw a diagram, says "diagram this", "teaching diagram", "use tldrawkc", or "lift this mermaid onto the canvas", and in the learning plugin's Teach phase whenever an idea is spatial, structural, or has moving parts.
---

# tldrawkc diagram

One diagram is one `.tldr` document. A snippet of JavaScript draws it, the
tool screenshots it, and you look at the PNG and send the next snippet. The
CLI does every mechanical step; the layout and the looking are yours.

Two invocations, same tool. Inside the tldrawkc repo, `node dist/cli/index.js
<command>` (or `tldrawkc <command>` when `bin/` is on PATH). From a host repo
like self-learn, where it is a submodule, `npm run --silent canvas -- <command>`:
`--silent` drops npm's banner and exit codes pass through either way. Every
command below is written in the bare `tldrawkc` form.

## Before anything

`tldrawkc doctor`, once per session: node, the page bundle, Chromium, the
fonts, write access. **If it fails or the tool is not installed, say so in one
line and draw the diagram as hand-written SVG instead.** The `learning` plugin
is global and runs in repos that have never heard of this submodule, so a
missing tool is a fallback, not an error. Do not build the submodule to get
past it.

`tldrawkc api` prints every helper with its signature and a line to copy. Read
that instead of guessing at helper names.

## The loop

1. **Read before writing.** `tldrawkc inspect <file>` if the file exists: one
   line per shape with its position, size and label, then the bindings, then
   the lints. `--json` gives the same thing as data. Never clear a canvas you
   did not create.
2. **Name the subject, then draw.** Create the document with its topic on it:
   `tldrawkc new <file> --topic <slug> --title "<a human title>" --concept <slug>`.
   Then run the snippet:
   `tldrawkc run <file> --code <snippet.js> --shot <out.png>`.
   `--code -` reads the snippet from stdin, so a heredoc leaves no file
   behind. `--create` starts from an empty document when the file is missing,
   which is the shortcut worth avoiding here: it writes no topic, and the run
   will warn `missing-topic`. Use `helpers.box` and `helpers.connect`; never
   build a raw arrow shape for a real connection.
3. **Look.** Open the PNG with the Read tool. Judge it as a stranger would:
   clipped or overlapping text, arrows crossing boxes, a label sitting on a
   line, a reading order that is not obvious.
4. **Fix with a second snippet**, not by starting over. `run` is idempotent
   on ids, so re-running a box or a connect updates it. Nudge positions, move
   an anchor, change `mid` on an arrow that routes badly, widen a box whose
   label wrapped. Re-shot.
5. **Stop when the lints are empty and the picture reads.** Three passes with
   no improvement means return what you have and say plainly what is still
   wrong. Then `tldrawkc export <file> --svg <out.svg>`, which runs nothing
   and saves nothing, so the export cannot damage the document.

Never report a diagram finished without having looked at the last screenshot.

### Exit codes

| Code | What happened | What to do |
| --- | --- | --- |
| 2 | The snippet threw. The page rolled back, the document is untouched. | Fix the snippet and run again. Subtract 2 from the reported line number: the wrapper adds a header. |
| 3 | Saved, and lints remain. The work is real, so the file is written. | Read every lint and fix it. `--allow-lints` turns it into 0, for a stub or legend you meant to leave and never as a shortcut. |

Each lint names its rule, the shape ids and what is wrong. A line beginning
`warn` is a warning: printed, and never the reason for a non-zero exit. The
rule set grows, so read what it printed rather than a list you remember.

## A worked example

```bash
tldrawkc run /tmp/loop.tldr --create --shot /tmp/loop.png --code - <<'JS'
helpers.box('agent', 'agent cli', { x: 60, y: 60, w: 170, h: 64 })
helpers.box('page', 'headless page', { after: 'agent', gap: 120, w: 190, h: 64 })
helpers.box('png', 'screenshot png', { below: 'page', gap: 90, w: 190, h: 64 })
helpers.box('tab', 'browser tab', { after: 'page', gap: 140, w: 170, h: 64 })

helpers.connect('agent', 'page', { label: 'exec' })
helpers.connect('page', 'png', { label: 'toImage' })
helpers.connect('png', 'agent', { label: 'read', start: 'left', end: 'bottom' })
helpers.connect('page', 'tab', { label: 'mirror', dash: 'dashed' })

return helpers.getLints()
JS
```

It prints `8 shapes, 0 lints`, the saved path and the shot path, and exits 0.
Read `/tmp/loop.png`: four boxes in an L, every arrow touching a box edge,
every label clear of every outline. The gaps are 120 and 140 because a
labelled arrow needs room; below about 60 units the label covers the line and
lands on both boxes.

## Say what the diagram is about

Every diagram names one topic from the shared vocabulary. Without it the
catalog cannot file the diagram, and it is in the repo and out of the index.

**The vocabulary lives in self-learn at `content/topics.yaml`**, one entry per
topic with a permanent `slug`. Read it and pick an existing slug; do not invent
one. Concepts are the ids of `learn/concepts/<domain>/<file>.md`, listed under
that topic's `maps.concepts`. Outside self-learn there may be no vocabulary, in
which case skip the flags and accept the warning.

| Field | What it is |
| --- | --- |
| `--topic <slug>` | one vocabulary slug. The required join for every asset |
| `--title "<text>"` | a human title for the diagram |
| `--concept <slug>` | a concept id under that topic. Repeat the flag for several |
| `--source "<text>"` | what prompted this: a session id, the note's path |

Three ways to set it, all landing in the same place inside the `.tldr`:

```bash
tldrawkc new x.tldr --topic vector-and-linear-algebra-basics \
  --title "A vector as a list of numbers" --concept vector-as-a-list-of-numbers
tldrawkc meta set x.tldr --topic vector-and-linear-algebra-basics   # an existing file
```

```js
helpers.meta({ concepts: ['dot-product'] })   // inside a snippet, merges
```

`meta set` opens no browser and is idempotent, so it is the one to reach for
when backfilling a diagram someone drew earlier. `inspect --json` reads it back
under `meta`, and `export --svg` copies the title and topic into the SVG.

## Finding the diagrams that already exist

```bash
tldrawkc list --json          # learn/assets under the working directory
```

One row per `.tldr`: the path, the metadata, the shape count, whether the
`.svg` beside it exists, and the mtime. Read this instead of globbing the
directory, and before drawing something that may already be there.

## Where files go in self-learn

| File | Path | Committed |
| --- | --- | --- |
| Canvas source | `learn/assets/<concept-id>.tldr` | yes |
| Final export | `learn/assets/<concept-id>.svg`, embedded in the session log as `![[<concept-id>.svg]]` | yes |
| Iteration screenshots | the scratchpad or `/tmp` | never |
| Snippets | the scratchpad | no |

The `.tldr` beside the `.svg` is what makes the diagram editable later: the
next session can `inspect` it and extend it rather than redraw it.

## What makes a teaching diagram work

- One idea per diagram. If it needs a legend, it is doing too much.
- Show the mechanism, not a summary of it. A box labelled "attention" teaches
  nothing; three vectors and the products between them does.
- Label directly on the elements.
- Before and after, or step by step, beats a static tangle for a process.
- The words on a card are that card's label, not a separate text shape.
- Keep boxes at 160 by 60 or larger at the default font.

## Snippet conventions

- Ids are lower-case slugs that name the thing: `helpers.box('query', ...)`,
  not `helpers.box('b1', ...)`.
- Place with `after` and `below`; use absolute `x`, `y` only for the first
  shape in a cluster.
- `kind: 'elbow'` for anything architectural or ERD-like, `'arc'` where a
  curve reads better.
- End with `return helpers.getLints()` so the run's output says what is left.
- One concern per snippet. A pass that does twenty things and throws half way
  is rolled back whole.

## Starting from mermaid

Most diagrams that already exist are mermaid. Lift one with:

```bash
tldrawkc from-mermaid learn/assets/x.tldr --source x.mmd --shot /tmp/x.png
```

then look, then fix with `run`. Without `--append` the target must not
already exist, so a canvas someone has since fixed by hand is never
overwritten. Lines the parser cannot read are reported as `unsupported`, not
dropped. `learn/map.md` stays mermaid: it is a derived cache the pipeline
rebuilds, not a teaching diagram.

## For a human watching

`serve`, which would open the canvas in a browser tab and reload as the agent
writes it, is phase 4 and not built yet. Until it lands a human looks at the
exported SVG, or opens the `.tldr` in a tldraw app of their own.

Verified against tldrawkc 0.1.0, phase 3.
