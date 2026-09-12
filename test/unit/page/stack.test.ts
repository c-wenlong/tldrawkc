/**
 * Renumbering a snippet's stack, on stacks captured from a real run.
 *
 * The frames here are copied from what Chrome and playwright actually
 * produced, not invented, because the whole rule is "only touch the frames the
 * snippet owns" and an invented stack would never contain the playwright
 * frames that make that rule worth having.
 */

import { describe, expect, it } from "vitest";

import {
  adjustSnippetFrames,
  firstSnippetFrame,
  SNIPPET_LINE_OFFSET,
  SNIPPET_SOURCE_URL,
  snippetFailureReport,
  snippetPointer,
  taggedSnippetSource,
} from "../../../src/page/helpers/stack.js";

/** A stack from a throw on line 3 of a snippet, as the page reported it. */
const REAL_STACK = [
  "SnippetError: Cannot read properties of null (reading 'boom')",
  "    at eval (snippet.js:5:3)",
  "    at Object.exec (http://127.0.0.1:56701/assets/index-B45EPZmf.js:468:1867)",
  "    at eval (eval at evaluate (:311:30), <anonymous>:1:28)",
  "    at UtilityScript.evaluate (<anonymous>:313:16)",
  "    at UtilityScript.<anonymous> (<anonymous>:1:44)",
].join("\n");

const SOURCE = ["helpers.box('a', 'first', { x: 60, y: 60 })", "const x = null", "x.boom()"].join(
  "\n",
);

describe("taggedSnippetSource", () => {
  it("names the script without moving a single line of it", () => {
    const tagged = taggedSnippetSource(SOURCE);
    expect(tagged.split("\n").slice(0, 3)).toEqual(SOURCE.split("\n"));
    expect(tagged.endsWith(`//# sourceURL=${SNIPPET_SOURCE_URL}`)).toBe(true);
  });
});

describe("adjustSnippetFrames", () => {
  it("subtracts the header from a snippet frame and leaves the column alone", () => {
    expect(adjustSnippetFrames("    at eval (snippet.js:5:3)")).toBe(
      "    at eval (snippet.js:3:3)",
    );
  });

  it("leaves playwright's own anonymous frames exactly as they were", () => {
    const adjusted = adjustSnippetFrames(REAL_STACK).split("\n");
    expect(adjusted[1]).toBe("    at eval (snippet.js:3:3)");
    expect(adjusted[3]).toBe("    at eval (eval at evaluate (:311:30), <anonymous>:1:28)");
    expect(adjusted[4]).toBe("    at UtilityScript.evaluate (<anonymous>:313:16)");
    expect(adjusted[5]).toBe("    at UtilityScript.<anonymous> (<anonymous>:1:44)");
  });

  it("leaves the bundle's own line numbers alone", () => {
    const frame = "    at Object.exec (http://127.0.0.1:1/assets/index.js:468:1867)";
    expect(adjustSnippetFrames(frame)).toBe(frame);
  });

  it("rewrites every snippet frame, not only the first", () => {
    const both = adjustSnippetFrames("at snippet.js:9:1 then at snippet.js:4:6");
    expect(both).toBe("at snippet.js:7:1 then at snippet.js:2:6");
  });

  it("puts a throw on the snippet's first line at line 1", () => {
    expect(adjustSnippetFrames(`snippet.js:${String(1 + SNIPPET_LINE_OFFSET)}:7`)).toBe(
      "snippet.js:1:7",
    );
  });

  it("leaves a frame inside the generated header alone rather than inventing line zero", () => {
    expect(adjustSnippetFrames("at snippet.js:1:1")).toBe("at snippet.js:1:1");
    expect(adjustSnippetFrames("at snippet.js:2:1")).toBe("at snippet.js:2:1");
  });
});

describe("firstSnippetFrame", () => {
  it("finds the first snippet frame in an adjusted stack", () => {
    expect(firstSnippetFrame(adjustSnippetFrames(REAL_STACK))).toEqual({ line: 3, column: 3 });
  });

  it("answers null when nothing in the stack belongs to the snippet", () => {
    expect(firstSnippetFrame("    at UtilityScript.evaluate (<anonymous>:313:16)")).toBeNull();
  });
});

describe("snippetPointer", () => {
  it("quotes the offending line, trimmed", () => {
    expect(snippetPointer("  const a = 1\n  x.boom()", { line: 2, column: 3 })).toBe(
      "snippet.js:2:3  x.boom()",
    );
  });

  it("gives the position alone when there is no line to quote", () => {
    expect(snippetPointer("only one line", { line: 9, column: 1 })).toBe("snippet.js:9:1");
    expect(snippetPointer("a\n   \nb", { line: 2, column: 1 })).toBe("snippet.js:2:1");
  });

  it("cuts a very long line short", () => {
    const long = `const x = '${"y".repeat(400)}'`;
    const pointer = snippetPointer(long, { line: 1, column: 1 });
    expect(pointer.endsWith("...")).toBe(true);
    expect(pointer.length).toBeLessThan(160);
  });
});

describe("snippetFailureReport", () => {
  it("puts the message, then the pointer, then the renumbered frames", () => {
    const report = snippetFailureReport(
      "Cannot read properties of null (reading 'boom')",
      REAL_STACK,
      SOURCE,
    ).split("\n");

    expect(report[0]).toBe("Cannot read properties of null (reading 'boom')");
    expect(report[1]).toBe("snippet.js:3:3  x.boom()");
    expect(report[2]).toBe("    at eval (snippet.js:3:3)");
    // The stack's own first line repeats the message, so it is not printed twice.
    expect(report.filter((line) => line.startsWith("SnippetError:"))).toEqual([]);
  });

  it("still reports when there is no stack at all", () => {
    expect(snippetFailureReport("boom", undefined, SOURCE)).toBe("boom");
  });

  it("drops the repeated headline even when the message itself carried a frame", () => {
    const message = "boom at snippet.js:5:1";
    const report = snippetFailureReport(
      message,
      [`Error: ${message}`, "    at eval (snippet.js:5:1)"].join("\n"),
      SOURCE,
    ).split("\n");

    expect(report[0]).toBe("boom at snippet.js:3:1");
    expect(report[1]).toBe("snippet.js:3:1  x.boom()");
    expect(report[2]).toBe("    at eval (snippet.js:3:1)");
    expect(report).toHaveLength(3);
  });

  it("falls back to a frame carried in the message when the stack has none", () => {
    const report = snippetFailureReport("boom at snippet.js:4:1", "", SOURCE).split("\n");
    expect(report[0]).toBe("boom at snippet.js:2:1");
    expect(report[1]).toBe("snippet.js:2:1  const x = null");
  });
});
