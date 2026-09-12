/**
 * The helper reference, as a parser.
 *
 * `tldrawkc api` is generated from the page's own JSDoc, so the convention the
 * page side has to keep to is only as real as this file: every form that is
 * meant to be picked up is pinned here, and so is every near miss that must be
 * ignored. A block that documents the file rather than the next function is the
 * one that matters, because picking it up fills the printed reference with
 * prose that describes nothing.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import {
  extractHelperDocs,
  selectHelperDocs,
  type HelperDoc,
} from "../../src/lib/api.js";
import { API_SOURCE_FILES } from "../../src/lib/paths.js";

/** All four function forms, the method form, and three blocks to ignore. */
const FIXTURE = `
/**
 * A file-level block. It documents the module, and there is a blank line
 * between it and the first declaration, so it is not a helper.
 */

import type { Editor } from "tldraw";

/**
 * Create a box and return its id.
 *
 * The second paragraph is the "why" and never reaches the printed reference.
 *
 * @param key the stable id
 * @param label the visible text
 * @example
 * helpers.box('agent', 'agent cli', { x: 60, y: 60 })
 */
export function box(key: string, label: string, opts: BoxOptions = {}): string {
  return key + label;
}

/**
 * Wait for the page to settle.
 *
 * @example
 * await helpers.settle()
 */
export async function settle(ms: number): Promise<void> {}

/**
 * A helper declared inside the factory, not at the top level.
 *
 * @example
 * helpers.note('why', 'because')
 */
  function note(key: string, str: string): string {
    return key;
  }

/**
 * An indented async declaration.
 *
 * @example
 * await helpers.mermaid(source)
 */
  async function mermaid(source: string, opts?: MermaidOptions): Promise<Imported> {
    return apply(source);
  }

/**
 * An interface member, which is how the bag is declared.
 *
 * @example
 * helpers.text('title', 'the render loop')
 */
  text(key: ShapeKey, str: string, opts?: TextOptions): TLShapeId;

/**
 * A constant, which is not a function and must be ignored.
 *
 * @example
 * DEFAULT_GAP
 */
export const DEFAULT_GAP = 120;

/**
 * Separated from the function below by a blank line, so it belongs to the
 * section and not to the function. Must be ignored.
 *
 * @example
 * orphan()
 */

export function orphan(): void {}

/**
 * Not a declaration at all: a control keyword that happens to open a paren.
 */
  if (ready) {
    go();
  }
`;

function byName(docs: HelperDoc[]): Map<string, HelperDoc> {
  return new Map(docs.map((doc) => [doc.name, doc]));
}

describe("extractHelperDocs", () => {
  const docs = extractHelperDocs([{ path: "fixture.ts", text: FIXTURE }]);
  const found = byName(docs);

  it("picks up all four function forms and the method form, and nothing else", () => {
    expect(docs.map((doc) => doc.name)).toEqual(["box", "settle", "note", "mermaid", "text"]);
  });

  it("keeps the parameters as written, including defaults with braces", () => {
    // `opts: BoxOptions = {}` is why the parameter list is scanned by depth
    // rather than cut at the first brace.
    expect(found.get("box")?.signature).toBe(
      "box(key: string, label: string, opts: BoxOptions = {}): string",
    );
    expect(found.get("text")?.signature).toBe(
      "text(key: ShapeKey, str: string, opts?: TextOptions): TLShapeId",
    );
    expect(found.get("mermaid")?.signature).toBe(
      "mermaid(source: string, opts?: MermaidOptions): Promise<Imported>",
    );
  });

  it("keeps an object return type whole and drops the multi-line trailing comma", () => {
    // `helpers.attribute` is the real case: cutting at the first `{` reported
    // its signature as `attribute(...):` with the return type missing, and the
    // dangling comma a wrapped parameter list ends on is a syntax error on the
    // one line the reference prints.
    const source = `
/**
 * Write a label off one side of a box.
 *
 * @example helpers.attribute('user', 'email', 'right')
 */
  function attribute(
    owner: ShapeKey,
    label: string,
    side: Side,
    opts: AttributeOptions = {},
  ): { textId: TLShapeId; lineId: TLShapeId } {
    return place(owner, label, side, opts);
  }

/**
 * The same shape as an interface member, which ends on a semicolon.
 *
 * @example helpers.split('a')
 */
  split(key: ShapeKey): { left: TLShapeId; right: TLShapeId };
`;
    const parsed = byName(extractHelperDocs([{ path: "fixture.ts", text: source }]));
    expect(parsed.get("attribute")?.signature).toBe(
      "attribute(owner: ShapeKey, label: string, side: Side, opts: AttributeOptions = {}):" +
        " { textId: TLShapeId; lineId: TLShapeId }",
    );
    expect(parsed.get("split")?.signature).toBe(
      "split(key: ShapeKey): { left: TLShapeId; right: TLShapeId }",
    );
  });

  it("takes the first paragraph as the summary and drops the rest", () => {
    const box = found.get("box");
    expect(box?.summary).toBe("Create a box and return its id.");
    expect(box?.summary).not.toContain("why");
  });

  it("collects @example and @param lines", () => {
    const box = found.get("box");
    expect(box?.examples).toEqual(["helpers.box('agent', 'agent cli', { x: 60, y: 60 })"]);
    expect(box?.params).toEqual(["key the stable id", "label the visible text"]);
  });

  it("records where each one came from and which form it was", () => {
    expect(found.get("box")?.path).toBe("fixture.ts");
    expect(found.get("box")?.kind).toBe("function");
    expect(found.get("text")?.kind).toBe("method");
  });

  it("ignores a block a blank line away from its declaration", () => {
    expect(found.has("orphan")).toBe(false);
  });

  it("ignores a block above something that is not a function", () => {
    expect(found.has("DEFAULT_GAP")).toBe(false);
    expect(found.has("if")).toBe(false);
  });
});

describe("selectHelperDocs", () => {
  const doc = (over: Partial<HelperDoc>): HelperDoc => ({
    name: "box",
    kind: "function",
    path: "fixture.ts",
    signature: "box(): void",
    summary: "",
    examples: ["helpers.box('a', 'b')"],
    params: [],
    ...over,
  });

  it("drops an entry with no example, because the point is a line to copy", () => {
    expect(selectHelperDocs([doc({ name: "quiet", examples: [] })])).toEqual([]);
  });

  it("prefers the implementation when a name is documented twice", () => {
    const chosen = selectHelperDocs([
      doc({ name: "box", kind: "method", signature: "box(): TLShapeId" }),
      doc({ name: "box", kind: "function", signature: "box(key: string): TLShapeId" }),
    ]);
    expect(chosen).toHaveLength(1);
    expect(chosen[0]?.signature).toBe("box(key: string): TLShapeId");
  });

  it("sorts by name, so the printed reference has a stable order", () => {
    const sorted = selectHelperDocs([
      doc({ name: "text" }),
      doc({ name: "box" }),
      doc({ name: "connect" }),
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(["box", "connect", "text"]);
  });
});

describe("the real helpers bag", () => {
  it("documents box and connect with an example each", async () => {
    const sources = await Promise.all(
      API_SOURCE_FILES.map(async (file) => ({
        path: file,
        text: await fs.readFile(file, "utf8"),
      })),
    );
    const docs = byName(selectHelperDocs(extractHelperDocs(sources)));

    // The two every snippet uses. If the page renames or reshapes them, this
    // is where the printed reference notices.
    for (const name of ["box", "connect"]) {
      const doc = docs.get(name);
      expect(doc, `${name} is missing from the generated reference`).toBeDefined();
      expect(doc?.examples.length ?? 0).toBeGreaterThan(0);
      expect(doc?.summary).not.toBe("");
    }
  });
});
