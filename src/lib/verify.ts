/**
 * Rendering a finished SVG back to a picture the agent can look at.
 *
 * The loop already looks at a PNG, but it is a PNG of the canvas: the thing
 * that gets committed is the SVG export, and nothing in the tool had ever
 * opened one. A committed export is 200 to 300 kB on a single line, which the
 * Read tool refuses on token count, so "check the file you shipped" was not a
 * step that existed. This is that step: load the SVG, render it in Chromium,
 * hand back a PNG small enough to read, and say what the render showed.
 *
 * It is beside `canvas.ts` rather than in it, for the reason `list`, `meta set`
 * and `serve` are: a verb belongs in `canvas.ts` when it needs a live editor.
 * An export has no editor, no bridge and no helpers. What it needs is a
 * browser, which is why this goes through `withRasterPage` and not
 * `withCanvas`.
 *
 * Two rules shape what the checks are allowed to claim.
 *
 * - **Report, never crash.** Each finding is a named rule with a detail line,
 *   and a file that renders wrong still produces the PNG that shows it. Only a
 *   file that cannot be read or cannot be parsed is an error.
 * - **Check what can be established, and nothing more.** The file is parsed as
 *   XML the way an `<img>` embed parses it, laid out by a real browser, and
 *   then measured. Nothing here reads the raster back: there is no OCR in this
 *   tool, so `text-visible` is a layout claim (every text run has a box, inside
 *   the frame) and never a claim about pixels. The PNG is what answers that,
 *   and answering it is the agent's job.
 */

import { removeDir, readText, writeAtomic, writeText } from "./files.js";
import {
  resolveOutputPath,
  resolveTldrPath,
  tempVerifyDir,
  tempVerifyPngPath,
  tempVerifySvgPath,
  verifyHarnessPath,
} from "./paths.js";
import { EnvironmentError, UsageError } from "./errors.js";
import { withRasterPage } from "./browser.js";
import { exportCanvas, refuseSelfOverwrite } from "./canvas.js";

/**
 * The raster's width in pixels unless `--width` says otherwise.
 *
 * Chosen against the reader, not the drawing. The Read tool scales an image
 * down to fit roughly 1568 px on its longest edge before it looks at it, so a
 * wider PNG costs bytes and buys no legibility. 1500 sits just under that and
 * leaves a committed diagram's smallest labels readable: the two self-learn
 * exports are 1367 and 1537 units wide, so this is about life size for them.
 */
export const DEFAULT_VERIFY_WIDTH = 1500;

/**
 * The tallest raster this will produce, whatever `--width` asks for.
 *
 * A tall diagram rendered at full width is a PNG whose long edge is the
 * height, and the same downscale then shrinks the width to nothing. Capping
 * the height keeps the widest readable version of a tall picture instead of
 * the largest unreadable one.
 */
export const MAX_VERIFY_HEIGHT = 2000;

/** One rule's answer. `ok: false` is what makes the command exit 3. */
export interface VerifyCheck {
  /** The rule's name, the way a lint carries one. */
  rule: string;
  ok: boolean;
  /** What was measured, in one line, whether it passed or failed. */
  detail: string;
}

export interface VerifyOptions {
  /** The `.svg` to render, or a `.tldr` to export first. */
  file: string;
  /** `-o`. Without it the PNG lands in the system temp directory. */
  output?: string | undefined;
  /** `--width`. Defaults to {@link DEFAULT_VERIFY_WIDTH}. */
  width?: number | undefined;
  cwd?: string | undefined;
  chromium?: string | undefined;
  headed?: boolean | undefined;
  /** Export padding, used only by the `.tldr` form. */
  padding?: number | undefined;
  /** PNG ratio, passed through by the `.tldr` form. Nothing here reads it. */
  pixelRatio?: number | undefined;
  /** A test point, the way every verb in `canvas.ts` has one. */
  pageRoot?: string | undefined;
}

export interface VerifyResult {
  /** The file that was named, resolved. A `.svg` or a `.tldr`. */
  file: string;
  /**
   * The SVG that was rendered, or `null` when it was a throwaway.
   *
   * The same path as `file` for the ordinary form. `null` for the `.tldr`
   * form, because the export it renders lives in the temp directory that is
   * removed on the way out, and reporting a path that no longer exists would
   * be worse than reporting none.
   */
  svg: string | null;
  /** The PNG to look at. Always absolute: it is usually in `/tmp`. */
  png: string;
  /** The PNG's own pixels, read from its IHDR chunk. */
  width: number;
  height: number;
  checks: VerifyCheck[];
  ms: number;
  /** 0, or 3 when a check failed. */
  exitCode: number;
}

// ---------------------------------------------------------------------------
// What the page measures
// ---------------------------------------------------------------------------

/** One `@font-face` the document registered, and what became of it. */
interface ObservedFace {
  family: string;
  /** `unloaded`, `loading`, `loaded` or `error`, from the CSS Font Loading API. */
  status: string;
}

/** One run of text in the rendered document. */
interface ObservedRun {
  /** The first 80 characters, for naming the offender in a detail line. */
  text: string;
  /** The non-generic families its computed `font-family` names, in order. */
  families: string[];
  /** Deliberately not drawn: `display:none`, `visibility:hidden`, `opacity:0`. */
  hidden: boolean;
  w: number;
  h: number;
  /** Any part of its box falls outside the root `<svg>`'s box. */
  outside: boolean;
}

/** Everything the page hands back after it has laid the file out. */
export interface SvgObservation {
  /** The `width`, `height` and `viewBox` attributes, verbatim or `null`. */
  declared: { width: string | null; height: string | null; viewBox: string | null };
  /** The declared size as numbers, falling back to the viewBox. */
  intrinsic: { width: number | null; height: number | null };
  /** The viewBox's own width and height, or `null` when there is none. */
  viewBox: { width: number | null; height: number | null };
  /** The root `<svg>`'s laid-out box, in CSS pixels. */
  rendered: { width: number; height: number };
  faces: ObservedFace[];
  runs: ObservedRun[];
}

type PageAnswer = { ok: true; observation: SvgObservation } | { ok: false; reason: string };

/** Where the SVG is rendered and what the screenshot frames. */
const HOST_SELECTOR = "#kc-root";

/**
 * Put the SVG in the page, size it, and measure everything worth measuring.
 *
 * Parsed with `DOMParser` as `image/svg+xml` rather than pasted into the HTML,
 * because that is how a reader's browser parses an SVG it loads as an image:
 * the HTML parser forgives a malformed tag and an `<img>` renders nothing at
 * all, so a file that only survives the lenient parser is a file that is
 * already broken for its actual audience.
 *
 * A string for the reason every other evaluated expression here is one: the
 * node side is compiled without the DOM lib, so `document` is not a name this
 * file can see.
 */
const MEASURE_EXPRESSION = `(async () => {
  const holder = document.getElementById("kc-svg");
  const host = document.querySelector(${JSON.stringify(HOST_SELECTOR)});
  if (!holder || !host) return { ok: false, reason: "the harness page is missing its slots" };

  const source = JSON.parse(holder.textContent || "{}").svg;
  if (typeof source !== "string" || source.trim() === "") {
    return { ok: false, reason: "the file holds no SVG" };
  }

  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const failure = parsed.getElementsByTagName("parsererror")[0];
  if (failure) {
    const text = (failure.textContent || "").replace(/\\s+/g, " ").trim();
    return { ok: false, reason: text.slice(0, 240) || "the SVG is not well-formed XML" };
  }
  const root = parsed.documentElement;
  if (!root || root.localName.toLowerCase() !== "svg") {
    const name = root ? root.localName : "nothing";
    return { ok: false, reason: "the root element is <" + name + ">, not <svg>" };
  }

  const declared = {
    width: root.getAttribute("width"),
    height: root.getAttribute("height"),
    viewBox: root.getAttribute("viewBox"),
  };
  host.appendChild(document.importNode(root, true));
  const svg = host.firstElementChild;

  const positive = (value) => {
    const parsedValue = Number.parseFloat(value === null ? "" : value);
    return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : null;
  };
  const box = (declared.viewBox || "").trim().split(/[\\s,]+/).map(Number);
  const boxWidth = box.length === 4 && Number.isFinite(box[2]) && box[2] > 0 ? box[2] : null;
  const boxHeight = box.length === 4 && Number.isFinite(box[3]) && box[3] > 0 ? box[3] : null;
  const intrinsicWidth = positive(declared.width) || boxWidth;
  const intrinsicHeight = positive(declared.height) || boxHeight;

  // The height is set from the declared ratio rather than left to "auto", so a
  // file with no viewBox to take an aspect ratio from still gets laid out at
  // the size it says it is instead of collapsing to the 150 px default.
  const apply = (width) => {
    svg.style.width = width + "px";
    svg.style.height = intrinsicWidth && intrinsicHeight
      ? Math.max(1, Math.round(width * (intrinsicHeight / intrinsicWidth))) + "px"
      : "auto";
    return svg.getBoundingClientRect();
  };
  let rect = apply(__WIDTH__);
  if (rect.height > __MAX_HEIGHT__) {
    rect = apply(Math.max(1, Math.round(__WIDTH__ * (__MAX_HEIGHT__ / rect.height))));
  }

  await document.fonts.ready;

  const faces = [];
  document.fonts.forEach((face) => {
    faces.push({ family: face.family.replace(/^["']|["']$/g, ""), status: face.status });
  });

  const GENERIC = ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
    "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong",
    "inherit", "initial", "unset", "revert"];
  const SKIP = ["style", "script", "title", "desc", "metadata"];
  const runs = [];
  const walker = document.createTreeWalker(svg, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue || "").replace(/\\s+/g, " ").trim();
    if (text === "") continue;
    const element = node.parentElement;
    if (!element || SKIP.indexOf(element.localName.toLowerCase()) !== -1) continue;

    const style = getComputedStyle(element);
    const range = document.createRange();
    range.selectNodeContents(node);
    // A range over SVG text content measures as nothing in some cases, so the
    // element's own box stands in: over-measuring costs a false pass on one
    // run, under-measuring costs a false failure on every one of them.
    let measured = range.getBoundingClientRect();
    if (measured.width < 0.5 || measured.height < 0.5) measured = element.getBoundingClientRect();

    const families = style.fontFamily
      .split(",")
      .map((family) => family.trim().replace(/^["']|["']$/g, ""))
      .filter((family) => family !== "" && GENERIC.indexOf(family.toLowerCase()) === -1);

    runs.push({
      text: text.slice(0, 80),
      families: families,
      hidden: style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0,
      w: Math.round(measured.width * 10) / 10,
      h: Math.round(measured.height * 10) / 10,
      outside: measured.width > 0.5 && measured.height > 0.5 && (
        measured.left < rect.left - 1 || measured.top < rect.top - 1 ||
        measured.right > rect.right + 1 || measured.bottom > rect.bottom + 1
      ),
    });
  }

  return {
    ok: true,
    observation: {
      declared: declared,
      intrinsic: { width: intrinsicWidth, height: intrinsicHeight },
      viewBox: { width: boxWidth, height: boxHeight },
      rendered: { width: Math.round(rect.width), height: Math.round(rect.height) },
      faces: faces,
      runs: runs,
    },
  };
})()`;

// ---------------------------------------------------------------------------
// The harness page
// ---------------------------------------------------------------------------

/**
 * The one page a verify run serves.
 *
 * The SVG travels inside a JSON script block rather than pasted into the
 * markup, so the browser never parses it as HTML before the check that parses
 * it as XML: every `<` is escaped, which is also what stops a `</script>` in
 * the file ending the block early. The favicon is a `data:` URL because a
 * request for a missing one would be a request, and the whole point of
 * `self-contained` is that there are none.
 */
export function buildHarness(svg: string): string {
  const payload = JSON.stringify({ svg }).replace(/</g, "\\u003c");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<link rel="icon" href="data:,">',
    "<title>tldrawkc verify</title>",
    "<style>html,body{margin:0;padding:0;background:#fff}",
    "#kc-root{display:inline-block;line-height:0}</style>",
    "</head><body>",
    '<div id="kc-root"></div>',
    `<script type="application/json" id="kc-svg">${payload}</script>`,
    "</body></html>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** A short list of names for a detail line, with the rest counted. */
function naming(values: readonly string[], limit = 3): string {
  const shown = values.slice(0, limit).join(", ");
  const rest = values.length - limit;
  return rest > 0 ? `${shown} (+${String(rest)} more)` : shown;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Did the page fetch anything at all beyond the page itself?
 *
 * The harness is one document with the SVG inside it, so any other request is
 * the file reaching for something it does not carry: a font at a URL, an image
 * that was linked instead of inlined, a stylesheet. In an `<img>` embed none of
 * those would even be attempted, which is worse than a failure, because the
 * picture silently loses whatever it was.
 */
function selfContained(requests: readonly string[], pageUrl: string): VerifyCheck {
  const wanted = new Set([pageUrl, `${pageUrl}/`, pageUrl.replace(/\/$/, "")]);
  const extra = requests.filter((url) => !wanted.has(url));
  if (extra.length === 0) {
    return {
      rule: "self-contained",
      ok: true,
      detail: "nothing was fetched: the file carries everything it draws",
    };
  }
  return {
    rule: "self-contained",
    ok: false,
    detail: `${plural(extra.length, "request")} left the file: ${naming(extra)}`,
  };
}

/**
 * Is every family the rendered text asks for actually backed by a loaded face?
 *
 * This is the check that catches an `@font-face` block stripped out, a `src`
 * pointing somewhere that did not answer, and a family renamed by a bad edit.
 * All three look identical in the file's text and identical in a careless
 * render: the labels are still there, in a system font nobody chose.
 *
 * A run whose whole `font-family` list is generic is not a finding: it names no
 * face, so there is nothing that could have failed to load. `document.fonts`
 * is the oracle rather than `check()`, which answers "is a matching family
 * loaded" for a family that does not exist at all.
 */
function fontsApplied(observation: SvgObservation): VerifyCheck {
  const loaded = new Set(
    observation.faces.filter((face) => face.status === "loaded").map((face) => face.family),
  );
  const errored = observation.faces.filter((face) => face.status === "error");
  const drawn = observation.runs.filter((run) => !run.hidden);

  const unbacked = new Map<string, number>();
  for (const run of drawn) {
    if (run.families.length === 0) continue;
    if (run.families.some((family) => loaded.has(family))) continue;
    const named = run.families[0] ?? "";
    unbacked.set(named, (unbacked.get(named) ?? 0) + 1);
  }

  const problems: string[] = [];
  for (const face of errored) problems.push(`${face.family} failed to load`);
  for (const [family, count] of unbacked) {
    problems.push(`${plural(count, "text run")} ask for ${family}, which no loaded @font-face provides`);
  }
  if (problems.length > 0) {
    return { rule: "fonts-applied", ok: false, detail: problems.join("; ") };
  }

  const backed = drawn.filter((run) => run.families.length > 0).length;
  if (loaded.size === 0) {
    return {
      rule: "fonts-applied",
      ok: true,
      detail: "no embedded face, and no text asks for one",
    };
  }
  return {
    rule: "fonts-applied",
    ok: true,
    detail: `${plural(loaded.size, "face")} loaded (${naming([...loaded])}), backing ${plural(backed, "text run")}`,
  };
}

/**
 * Does every piece of text have a box, inside the frame?
 *
 * A layout claim and not a pixel one. Nothing here reads the raster back, so
 * this cannot say a label is legible or that it is not covered by a shape drawn
 * over it; what it can say is that the text exists in the layout, has a
 * non-empty box, and is not hanging off the edge of the exported frame. The PNG
 * is what answers the rest, which is the whole reason the command returns one.
 */
function textVisible(observation: SvgObservation): VerifyCheck {
  const drawn = observation.runs.filter((run) => !run.hidden);
  const empty = drawn.filter((run) => run.w < 0.5 || run.h < 0.5);
  const clipped = drawn.filter((run) => run.outside);

  const problems: string[] = [];
  if (empty.length > 0) {
    problems.push(
      `${plural(empty.length, "text run")} laid out with no box: ${naming(empty.map(quoted))}`,
    );
  }
  if (clipped.length > 0) {
    problems.push(
      `${plural(clipped.length, "text run")} fall outside the frame: ${naming(clipped.map(quoted))}`,
    );
  }
  if (problems.length > 0) return { rule: "text-visible", ok: false, detail: problems.join("; ") };
  return {
    rule: "text-visible",
    ok: true,
    detail: `${plural(drawn.length, "text run")}, every one with a box inside the frame`,
  };
}

function quoted(run: ObservedRun): string {
  return JSON.stringify(run.text);
}

/**
 * Does the file declare the size it renders at?
 *
 * An SVG with no `width` and `height` has no intrinsic size, and an `<img>`
 * that embeds it falls back to 300 by 150 and squashes the drawing into it. A
 * `viewBox` whose aspect ratio disagrees with the declared size is the same
 * failure one step later: the picture renders letterboxed or cropped depending
 * on the reader, and the export is the only place that can be fixed.
 */
function declaredSize(observation: SvgObservation): VerifyCheck {
  const { declared, viewBox, intrinsic, rendered } = observation;
  const missing: string[] = [];
  if (declared.width === null) missing.push("width");
  if (declared.height === null) missing.push("height");
  if (missing.length > 0) {
    return {
      rule: "declared-size",
      ok: false,
      detail: `the root <svg> declares no ${missing.join(" or ")}, so an <img> embed sizes it at 300x150`,
    };
  }

  const declaredRatio = ratio(intrinsic.width, intrinsic.height);
  const boxRatio = ratio(viewBox.width, viewBox.height);
  const renderedRatio = ratio(rendered.width, rendered.height);
  const size = `declared ${String(declared.width)}x${String(declared.height)}`;
  const shown = `rendered ${String(rendered.width)}x${String(rendered.height)}`;

  if (declaredRatio === null) {
    return {
      rule: "declared-size",
      ok: false,
      detail: `the root <svg> declares ${String(declared.width)}x${String(declared.height)}, which is not a size`,
    };
  }
  if (boxRatio !== null && !within(declaredRatio, boxRatio, 0.01)) {
    return {
      rule: "declared-size",
      ok: false,
      detail:
        `${size} but the viewBox is ${String(viewBox.width)}x${String(viewBox.height)}: ` +
        "a reader letterboxes or crops the difference",
    };
  }
  if (renderedRatio !== null && !within(declaredRatio, renderedRatio, 0.02)) {
    return {
      rule: "declared-size",
      ok: false,
      detail: `${size} but ${shown}: the browser laid it out at another shape`,
    };
  }
  const box = boxRatio === null ? "no viewBox" : `viewBox ${String(viewBox.width)}x${String(viewBox.height)}`;
  const scale = intrinsic.width ? rendered.width / intrinsic.width : 1;
  return {
    rule: "declared-size",
    ok: true,
    detail: `${size}, ${box}, ${shown} at ${scale.toFixed(2)}x`,
  };
}

function ratio(width: number | null, height: number | null): number | null {
  if (width === null || height === null || height === 0) return null;
  return width / height;
}

function within(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance * Math.max(a, b);
}

/**
 * Every rule, over one render.
 *
 * Pure, so the rules are unit tested against a measurement rather than against
 * a browser. The order is the order they print in, and it is deliberate: a file
 * that fetches something explains most of the rest.
 */
export function checksFor(
  observation: SvgObservation,
  requests: readonly string[],
  pageUrl: string,
): VerifyCheck[] {
  return [
    selfContained(requests, pageUrl),
    fontsApplied(observation),
    textVisible(observation),
    declaredSize(observation),
  ];
}

// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------

/**
 * Render a finished SVG and report what the render showed.
 *
 * A `.tldr` is sugar: it is exported to a temp SVG first and that is what gets
 * verified, so an agent can check a document without leaving a file behind. The
 * temp directory holds both the harness page and that export, and it is removed
 * in a `finally`.
 */
export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const started = Date.now();
  const named = resolveTldrPath(options.file, options.cwd);
  const width = options.width ?? DEFAULT_VERIFY_WIDTH;
  if (!Number.isFinite(width) || width < 1) {
    throw new UsageError(`--width expects a number of pixels of at least 1, got "${String(width)}".`);
  }

  // Before the browser, and before the `.tldr` form exports anything: `-o` is
  // a PNG path and nothing else stops it naming the file being verified, so
  // `verify diagram.tldr -o diagram.tldr` would replace the only editable copy
  // of the drawing with a picture of it. The same guard every exporting verb
  // runs, for the same reason.
  const output = options.output === undefined
    ? tempVerifyPngPath(named)
    : resolveOutputPath(options.output, options.cwd);
  refuseSelfOverwrite(named, [output]);

  const dir = tempVerifyDir();
  try {
    const fromDocument = named.toLowerCase().endsWith(".tldr");
    const file = fromDocument ? tempVerifySvgPath(dir) : named;
    if (fromDocument) {
      await exportCanvas({
        file: named,
        svg: file,
        padding: options.padding ?? 32,
        pixelRatio: options.pixelRatio ?? 2,
        cwd: options.cwd,
        chromium: options.chromium,
        headed: options.headed,
        pageRoot: options.pageRoot,
      });
    }

    const svg = await readText(file);
    if (svg === null) throw new UsageError(`${file} does not exist.`);
    if (svg.trim() === "") throw new UsageError(`${file} is empty.`);
    if (!svg.includes("<svg")) throw new UsageError(`${file} has no <svg> element in it.`);

    await writeText(verifyHarnessPath(dir), buildHarness(svg));

    return await withRasterPage(
      { root: dir, chromium: options.chromium, headed: options.headed },
      async (page) => {
        const answer = await page.evaluate<PageAnswer>(
          // Both placeholders appear more than once, and only one of the
          // `__WIDTH__`s is on the path a short diagram takes: a `replace`
          // here left the rescale branch holding an undefined name, which
          // only a diagram tall enough to need it ever reached.
          MEASURE_EXPRESSION.replaceAll("__WIDTH__", String(Math.round(width))).replaceAll(
            "__MAX_HEIGHT__",
            String(MAX_VERIFY_HEIGHT),
          ),
        );
        if (!answer.ok) throw new UsageError(`${file} could not be rendered: ${answer.reason}`);

        let bytes: Buffer;
        try {
          bytes = Buffer.from(await page.screenshot(HOST_SELECTOR), "base64");
        } catch (error) {
          throw new EnvironmentError(`the render could not be screenshotted: ${firstLine(error)}`, {
            cause: error,
          });
        }
        await writeAtomic(output, bytes);

        const checks = checksFor(answer.observation, page.requests(), page.url);
        return {
          file: named,
          svg: fromDocument ? null : file,
          png: output,
          ...pngSize(bytes),
          checks,
          ms: Date.now() - started,
          exitCode: checks.some((check) => !check.ok) ? 3 : 0,
        };
      },
    );
  } finally {
    await removeDir(dir);
  }
}

/**
 * A PNG's real pixel size, from its IHDR chunk.
 *
 * The same reason the bridge reads one: the file is the only thing a caller can
 * check the reported numbers against, and a CSS pixel is not reliably a device
 * pixel. The header is fixed by the format at byte 16, so this needs no decoder.
 */
function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24) return { width: 0, height: 0 };
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}
