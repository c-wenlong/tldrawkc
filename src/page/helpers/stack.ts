/**
 * Turning a snippet's thrown stack into lines that match the file the caller
 * wrote.
 *
 * Pure, and with no `tldraw` import, for the same reason as `lints.ts`: the
 * unit suite runs it in node. `bridge.ts` is the only caller.
 *
 * Two problems, one file. The first is that `new AsyncFunction(...)` compiles
 * the snippet into an anonymous script, so every frame reads `<anonymous>` and
 * there is no way to tell the snippet's frame apart from the ones playwright's
 * own injected script contributes, which also say `<anonymous>`. Tagging the
 * source with `//# sourceURL=snippet.js` names the script, so the frames that
 * belong to the snippet say so and nothing else in the stack can be mistaken
 * for one.
 *
 * The second is that the constructor prepends a header, so the tagged frames
 * are two lines higher than the source they came from. That offset was
 * measured rather than guessed and it is constant: a throw on line 1 of a
 * snippet reports as `snippet.js:3`. Subtracting it here is the whole point of
 * the file, because a caller counting lines by hand is a caller who stops
 * trusting the number.
 */

/** The name the compiled snippet's script carries in a stack trace. */
export const SNIPPET_SOURCE_URL = "snippet.js";

/**
 * How many lines the `AsyncFunction` constructor prepends before the
 * snippet's own first line.
 *
 * Measured, not assumed: `throw new Error(...)` as the only line of a snippet
 * reports at line 3, and the same throw on line 3 reports at line 5.
 */
export const SNIPPET_LINE_OFFSET = 2;

/** Longest source line quoted in the pointer before it is cut short. */
const MAX_POINTER_TEXT = 120;

/** A `snippet.js:LINE:COLUMN` reference, wherever it appears in a stack. */
function frameMatcher(): RegExp {
  return new RegExp(`${SNIPPET_SOURCE_URL.replace(".", "\\.")}:(\\d+):(\\d+)`, "g");
}

/**
 * Tag a snippet so its frames are identifiable.
 *
 * Appended rather than prepended, so it cannot shift the line numbers it
 * exists to make readable. A trailing `//# sourceURL` is the form V8 honours.
 */
export function taggedSnippetSource(source: string): string {
  return `${source}\n//# sourceURL=${SNIPPET_SOURCE_URL}`;
}

/**
 * Rewrite every snippet frame in a stack or message to the source's own line
 * numbers.
 *
 * Only frames the snippet owns are touched, which is what naming the script
 * bought: a `<anonymous>` frame from playwright's injected script, or a frame
 * in the page bundle, is left exactly as it was. A frame that lands inside the
 * generated header (line 1 or 2, which no source line can produce) is left
 * alone too, because a number under 1 would be a worse lie than the raw one.
 */
export function adjustSnippetFrames(text: string): string {
  return text.replace(frameMatcher(), (whole, rawLine: string, rawColumn: string) => {
    const line = Number(rawLine) - SNIPPET_LINE_OFFSET;
    return line >= 1 ? `${SNIPPET_SOURCE_URL}:${String(line)}:${rawColumn}` : whole;
  });
}

/** Where in the source the first snippet frame of an already-adjusted stack points. */
export function firstSnippetFrame(adjusted: string): { line: number; column: number } | null {
  const match = new RegExp(`${SNIPPET_SOURCE_URL.replace(".", "\\.")}:(\\d+):(\\d+)`).exec(
    adjusted,
  );
  if (!match) return null;
  const line = Number(match[1]);
  const column = Number(match[2]);
  if (!Number.isFinite(line) || !Number.isFinite(column)) return null;
  return { line, column };
}

/**
 * The line an agent should look at, quoted.
 *
 * `snippet.js:3:7  x.boom()` rather than a bare number, because the snippet
 * usually never touched disk (`--eval`, or a flowchart embedded by
 * `from-mermaid`) and there may be no file to open and count down.
 */
export function snippetPointer(
  source: string,
  at: { line: number; column: number },
): string {
  const where = `${SNIPPET_SOURCE_URL}:${String(at.line)}:${String(at.column)}`;
  const text = (source.split("\n")[at.line - 1] ?? "").trim();
  if (text === "") return where;
  const quoted =
    text.length > MAX_POINTER_TEXT ? `${text.slice(0, MAX_POINTER_TEXT - 3)}...` : text;
  return `${where}  ${quoted}`;
}

/**
 * Everything the page can usefully say about a snippet that threw, as one
 * string.
 *
 * It has to be one string because playwright carries an error's `message`
 * across the bridge and not much else, so anything that does not travel inside
 * the message is lost. The order is: the error's own words first, since the
 * CLI prints that line after `the snippet threw:`; then the pointer, so the
 * offending line is the first thing under it; then the frames, renumbered.
 */
export function snippetFailureReport(
  message: string,
  stack: string | undefined,
  source: string,
): string {
  const head = adjustSnippetFrames(message);
  const frames = stack === undefined ? "" : adjustSnippetFrames(stack);
  const at = firstSnippetFrame(frames) ?? firstSnippetFrame(head);

  const parts: string[] = [head];
  if (at) parts.push(snippetPointer(source, at));

  // The stack's own first line repeats the message, so drop it when it does.
  // Against `head` and not `message`: both strings have been through the same
  // rewrite, and comparing the adjusted line to the raw one misses whenever the
  // message itself carried a frame, which leaves the headline printed twice.
  const lines = frames === "" ? [] : frames.split("\n");
  const first = lines[0] ?? "";
  const body = (first.includes(head) ? lines.slice(1) : lines).join("\n").trimEnd();
  if (body !== "") parts.push(body);

  return parts.join("\n");
}
