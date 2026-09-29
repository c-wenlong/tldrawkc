/**
 * Each helper's options in `api.json`, as a reader of TypeScript.
 *
 * Two halves. The fixtures pin what the reader understands: `extends`, `Omit`
 * and `Pick`, a name followed through an import, a default read out of
 * `opts.x ?? fallback` in a function the options are handed to, and the cases
 * that must come back with no default at all. The second half runs it over the
 * real helpers and pins the result, so a helper that loses its options, or an
 * options type that loses a field, is a red test here before it is a guess in
 * an agent's snippet.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { attachHelperOptions, readOptionSources } from "../../src/lib/api-options.js";
import {
  extractHelperDocs,
  readApiSources,
  selectHelperDocs,
  type HelperDoc,
  type HelperOptions,
  type SourceFile,
} from "../../src/lib/api.js";
import { PACKAGE_ROOT } from "../../src/lib/paths.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INDEX = `
import { makeBox as drawBox, makeLine, type BoxOptions } from "./shapes.js";
import type { LineOptions } from "./line.js";

export interface MermaidOptions extends BoxOptions {
  /** Gap between ranks. */
  rankGap?: number;
}

export function createHelpers(editor: Editor) {
  /**
   * Draw a box.
   *
   * @example helpers.box('a', 'b')
   */
  function box(key: string, label: string, opts?: BoxOptions): string {
    return drawBox(editor, key, label, opts);
  }

  /**
   * Draw a line.
   *
   * @example helpers.line('a')
   */
  function line(key: string, opts: LineOptions = {}): string {
    return makeLine(editor, key, opts as LineOptions);
  }

  /**
   * Draw a plan.
   *
   * @example helpers.plan('a')
   */
  function plan(source: string, opts: MermaidOptions = {}): string {
    const apply: MermaidOptions = { ...opts, rankGap: opts.rankGap ?? 99 };
    return layOut(apply);
  }

  /**
   * An inline options type.
   *
   * @example helpers.clear({ force: true })
   */
  function clear(opts: { force?: boolean } = {}): number {
    return opts.force === true ? 1 : 0;
  }

  /**
   * No options at all.
   *
   * @example helpers.page('p')
   */
  function page(name: string): string {
    return name;
  }

  function layOut(settings: MermaidOptions): string {
    return String(settings.rankGap ?? 120) + String(settings.h ?? 7);
  }

  return { box, line, plan, clear, page };
}
`;

const SHAPES = `
import { GAP } from "./constants.js";

export const SIZE = { w: 180, h: 64 } as const;
let MUTABLE = 5;

/** Placing against another shape. */
export interface Placement {
  /** Sit to the right of this shape. */
  after?: string;
  /** Sit under this shape. */
  below?: string;
}

/**
 * Options for {@link makeBox}.
 */
export interface BoxOptions extends Omit<Placement, "below">, Pick<Extra, "tag"> {
  /**
   * Width, default 180.
   *
   * A second paragraph that {@link makeBox} keeps.
   * @deprecated tags are not part of the doc
   */
  w?: number;
  /** Height. */
  h?: number;
  /** Outline colour. */
  color?: "black" | "red";
  /** Label colour, defaults to \`color\`. */
  labelColor?: "black" | "red";
  after?: string;
  /** Gap for \`after\`. */
  gap?: number;
  /** Where the box lands. */
  x: number;
  /** A local fallback. */
  y?: number;
  /** A let, which can change. */
  z?: number;
  /** Only defaulted once the code has checked whether it was given. */
  left?: number;
  /** Defaulted on the other side of a test about something else. */
  top?: number;
  /** Seen twice with two values. */
  size?: "s" | "m";
  /** Ignore list. */
  ignore?: readonly string[];
}

interface Extra {
  /** A tag. */
  tag?: string;
  /** Not picked. */
  other?: string;
}

export function makeBox(editor: Editor, key: string, label: string, settings: BoxOptions = { x: 0 }): string {
  const y = 3;
  return JSON.stringify({
    w: settings.w ?? SIZE.w,
    h: settings.h ?? SIZE["h"],
    color: settings.color ?? "black",
    labelColor: settings.labelColor ?? settings.color ?? "black",
    gap: place(settings) ?? 0,
    y: settings.y ?? y,
    z: settings.z ?? MUTABLE,
    size: settings.size ?? "s",
    other: sizeAgain(settings),
    ignore: [...(settings.ignore ?? [...IGNORED, "extra"])],
    corner: settings.left !== undefined || settings.top !== undefined ? { left: settings.left ?? 0 } : null,
    top: key === "" ? 0 : (settings.top ?? 5),
    muted: settings.ignore === true ? [] : [...(settings.ignore ?? [...IGNORED, "extra"])],
  });
}

const IGNORED = ["a", "b"] as const;

function place(where: BoxOptions): number {
  return (where.gap ?? GAP) as number;
}

function sizeAgain(opts: BoxOptions): string {
  return opts.size ?? "m";
}

export function makeLine(editor: Editor, key: string, opts: LineOptions): string {
  return String(opts.bend ?? -0.5);
}
`;

const CONSTANTS = `
const RAW_GAP = 120;
export { RAW_GAP as GAP };
`;

const LINE = `
/** Options for a line. */
export type LineOptions = {
  /** Curvature. */
  bend?: number;
};
`;

function fixtureSources(): SourceFile[] {
  return [
    { path: "helpers/index.ts", text: INDEX },
    { path: "helpers/shapes.ts", text: SHAPES },
    { path: "helpers/constants.ts", text: CONSTANTS },
    { path: "helpers/line.ts", text: LINE },
  ];
}

function fixtureDocs(): Map<string, HelperDoc> {
  const sources = fixtureSources();
  const docs = selectHelperDocs(extractHelperDocs(sources.slice(0, 1)));
  return new Map(attachHelperOptions(docs, sources).map((doc) => [doc.name, doc]));
}

function fieldsOf(options: HelperOptions | undefined): Map<string, HelperOptions["fields"][number]> {
  return new Map((options?.fields ?? []).map((field) => [field.name, field]));
}

describe("attachHelperOptions over fixtures", () => {
  const docs = fixtureDocs();
  const box = fieldsOf(docs.get("box")?.options);

  it("names the parameter and its type as written", () => {
    expect(docs.get("box")?.options?.param).toBe("opts");
    expect(docs.get("box")?.options?.type).toBe("BoxOptions");
    expect(docs.get("clear")?.options?.type).toBe("{ force?: boolean }");
  });

  it("leaves a helper with no options exactly as it was", () => {
    const page = docs.get("page");
    expect(page).toBeDefined();
    expect(page && "options" in page).toBe(false);
  });

  it("applies extends, Omit and Pick, and puts own fields where they belong", () => {
    // `after` came from Placement and is redeclared, so it stays first;
    // `below` was omitted; only `tag` was picked from Extra.
    expect([...box.keys()]).toEqual([
      "after",
      "tag",
      "w",
      "h",
      "color",
      "labelColor",
      "gap",
      "x",
      "y",
      "z",
      "left",
      "top",
      "size",
      "ignore",
    ]);
  });

  it("reads a type alias to an object literal and an inline literal", () => {
    expect(docs.get("line")?.options?.fields.map((field) => field.name)).toEqual(["bend"]);
    expect(docs.get("clear")?.options?.fields.map((field) => field.name)).toEqual(["force"]);
  });

  it("keeps the type as written and whether the field is optional", () => {
    expect(box.get("color")).toMatchObject({ type: '"black" | "red"', optional: true });
    expect(box.get("x")).toMatchObject({ type: "number", optional: false });
  });

  it("keeps every paragraph of the doc, drops tags, and writes a link as code", () => {
    expect(box.get("w")?.doc).toBe("Width, default 180. A second paragraph that `makeBox` keeps.");
    // Redeclared without a doc of its own, so the inherited one stands.
    expect(box.get("after")?.doc).toBe("Sit to the right of this shape.");
    expect(box.get("tag")?.doc).toBe("A tag.");
  });

  it("reads defaults from ?? in every function the options reach, under any name", () => {
    expect(box.get("w")?.default).toBe(180); // a const's property
    expect(box.get("h")?.default).toBe(64); // the same, by element access
    expect(box.get("color")?.default).toBe("black"); // a literal
    expect(box.get("gap")?.default).toBe(120); // followed into `place`, then a re-export
    // A spread of a const array, seen twice: once plain, and once on the side
    // of `settings.ignore === true` that leaving it out certainly reaches.
    expect(box.get("ignore")?.default).toEqual(["a", "b", "extra"]);
    expect(docs.get("line")?.options?.fields[0]?.default).toBe(-0.5); // through `as`
  });

  it("follows a local built by spreading the options", () => {
    // `plan` hands `{ ...opts }` to its sibling `layOut`, which applies
    // `h ?? 7`. `rankGap` is seen as 99 in `plan` and 120 in `layOut`, which
    // disagree, so it gets none.
    const plan = fieldsOf(docs.get("plan")?.options);
    expect(plan.get("h")?.default).toBe(7);
    expect(plan.get("rankGap")).not.toHaveProperty("default");
  });

  it("records no default where the fallback is not a constant, or two disagree", () => {
    // `settings.labelColor ?? settings.color ?? 'black'` falls back to a field.
    expect(box.get("labelColor")).not.toHaveProperty("default");
    // A local variable, and a `let`.
    expect(box.get("y")).not.toHaveProperty("default");
    expect(box.get("z")).not.toHaveProperty("default");
    // `s` in makeBox, `m` in sizeAgain.
    expect(box.get("size")).not.toHaveProperty("default");
    // Only reached once the code knows `left` or `top` was given.
    expect(box.get("left")).not.toHaveProperty("default");
    // Guarded too, but by a test that is not about `top`.
    expect(box.get("top")?.default).toBe(5);
    // `opts.force === true` is a comparison, not a default.
    expect(fieldsOf(docs.get("clear")?.options).get("force")).not.toHaveProperty("default");
  });

  it("refuses an options type it cannot find", () => {
    const sources = [{ path: "helpers/index.ts", text: INDEX }];
    const docs = selectHelperDocs(extractHelperDocs(sources));
    expect(() => attachHelperOptions(docs, sources)).toThrow(/BoxOptions.*not declared/);
  });

  it("refuses an extends clause it does not understand", () => {
    const sources = fixtureSources().map((source) =>
      source.path === "helpers/shapes.ts"
        ? { ...source, text: source.text.replace('Omit<Placement, "below">', "Partial<Placement>") }
        : source,
    );
    const docs = selectHelperDocs(extractHelperDocs(sources.slice(0, 1)));
    expect(() => attachHelperOptions(docs, sources)).toThrow(/Partial<Placement>/);
  });
});

// ---------------------------------------------------------------------------
// The real helpers
// ---------------------------------------------------------------------------

/**
 * Every helper that takes an options object, its type, and its fields in
 * order. The first eleven are the ones the studio's drawing manual prints;
 * the rest are here so that no helper's options can go missing unnoticed.
 * Adding an option means adding it here too, on purpose.
 */
const EXPECTED: Record<string, { type: string; fields: string[] }> = {
  box: {
    type: "BoxOptions",
    fields: [
      "x", "y", "w", "h", "geo", "color", "labelColor", "fill", "dash", "font", "size",
      "align", "verticalAlign", "after", "below", "gap", "parent", "meta",
    ],
  },
  text: {
    type: "TextOptions",
    fields: [
      "x", "y", "w", "color", "font", "size", "after", "gap", "parent", "meta",
      "centerOn", "above", "textAlign", "below",
    ],
  },
  note: {
    type: "NoteOptions",
    fields: [
      "x", "y", "color", "labelColor", "font", "size", "align", "verticalAlign", "after", "gap",
      "parent", "meta", "centerOn", "above", "below",
    ],
  },
  connect: {
    type: "ConnectOptions",
    fields: [
      "id", "label", "kind", "start", "end", "bend", "mid", "head", "labelPosition", "color",
      "labelColor", "size", "dash", "font", "precise", "meta",
    ],
  },
  line: {
    type: "DrawLineOptions",
    fields: ["color", "size", "dash", "head", "kind", "bend", "label", "labelColor", "parent", "lintIgnore", "meta"],
  },
  stub: {
    type: "DrawLineOptions",
    fields: ["color", "size", "dash", "head", "kind", "bend", "label", "labelColor", "parent", "lintIgnore", "meta"],
  },
  boxShapes: {
    type: "BoxShapesOptions",
    fields: ["label", "margin", "color", "dash", "size", "shapeId", "minW", "minH", "matchSize", "meta"],
  },
  alignContainers: { type: "AlignContainersOptions", fields: ["axis"] },
  row: { type: "LineOptions", fields: ["gap", "align", "x", "y"] },
  column: { type: "LineOptions", fields: ["gap", "align", "x", "y"] },
  grid: { type: "GridOptions", fields: ["gapX", "gapY", "x", "y"] },
  attribute: { type: "AttributeOptions", fields: ["at", "gap", "size", "color", "font", "id"] },
  clear: { type: "ClearOptions", fields: ["force"] },
  fitCamera: { type: "FitCameraOptions", fields: ["padding"] },
  mermaid: {
    type: "MermaidOptions",
    fields: ["direction", "origin", "spacing", "rankGap", "nodeGap", "margin", "respace"],
  },
};

/** Defaults the code applies, pinned where getting one wrong would mislead a snippet. */
const DEFAULTS: Record<string, Record<string, unknown>> = {
  box: { w: 180, h: 64, geo: "rectangle", color: "black", fill: "none", dash: "draw", size: "m", gap: 120 },
  text: { size: "m", textAlign: "start", gap: 120 },
  note: { color: "yellow", labelColor: "black", size: "m" },
  connect: { kind: "elbow", head: "end", size: "s", mid: 0.5, labelPosition: 0.5, precise: true },
  line: { kind: "arc", head: "none", size: "s", lintIgnore: ["friendless-arrow", "arrow-crosses-shape"] },
  stub: { kind: "arc", head: "none" },
  boxShapes: { margin: 40, color: "grey", dash: "draw", size: "s", label: "" },
  alignContainers: { axis: "both" },
  row: { gap: 40, align: "start" },
  column: { gap: 40, align: "start" },
  grid: { gapX: 40, gapY: 40 },
  attribute: { at: 0.5, gap: 60 },
  mermaid: { rankGap: 120, nodeGap: 60, margin: 40, respace: true },
};

/** Fields whose default depends on something else, so a constant would be a lie. */
const NO_DEFAULT: Record<string, string[]> = {
  // `x ?? 0` runs only when one of the two was given; with neither a new
  // shape throws, so 0 is not what leaving them out means.
  box: ["x", "y", "labelColor", "after", "below"],
  text: ["x", "y", "w"],
  note: ["x", "y"],
  connect: ["id", "start", "end", "labelColor"],
  boxShapes: ["shapeId", "matchSize"],
  row: ["x", "y"],
  grid: ["x", "y"],
};

async function realDocs(): Promise<Map<string, HelperDoc>> {
  const sources = await readApiSources();
  const docs = selectHelperDocs(extractHelperDocs(sources));
  const withOptions = attachHelperOptions(docs, await readOptionSources(sources, PACKAGE_ROOT));
  return new Map(withOptions.map((doc) => [doc.name, doc]));
}

describe("the real helpers' options", () => {
  let docs = new Map<string, HelperDoc>();
  beforeAll(async () => {
    docs = await realDocs();
  });

  it("gives every helper with an opts parameter its options, and no other helper", () => {
    const withOpts = [...docs.values()].filter((doc) => /\bopts\??:/.test(doc.signature)).map((doc) => doc.name);
    expect(withOpts.sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const doc of docs.values()) {
      expect("options" in doc, `${doc.name}`).toBe(doc.name in EXPECTED);
    }
  });

  for (const [name, expected] of Object.entries(EXPECTED)) {
    it(`lists every field of ${name}'s ${expected.type}`, () => {
      const options = docs.get(name)?.options;
      expect(options, `${name} lost its options entry`).toBeDefined();
      expect(options?.type).toBe(expected.type);
      expect(options?.fields.map((field) => field.name)).toEqual(expected.fields);
      for (const field of options?.fields ?? []) {
        expect(field.type, `${name}.${field.name} has no type`).not.toBe("");
        expect(field.doc, `${name}.${field.name} has no doc comment`).not.toBe("");
      }
    });
  }

  it("reads the defaults the code applies", () => {
    for (const [name, expected] of Object.entries(DEFAULTS)) {
      const fields = fieldsOf(docs.get(name)?.options);
      for (const [field, value] of Object.entries(expected)) {
        expect(fields.get(field)?.default, `${name}.${field}`).toEqual(value);
      }
    }
    for (const [name, list] of Object.entries(NO_DEFAULT)) {
      const fields = fieldsOf(docs.get(name)?.options);
      for (const field of list) {
        expect(fields.get(field), `${name}.${field}`).toBeDefined();
        expect(fields.get(field), `${name}.${field}`).not.toHaveProperty("default");
      }
    }
  });

  it("never has a doc comment naming a different default from the code", () => {
    // The drift this whole field exists to stop. A note's colour was
    // documented as `black`, inherited from `box`, while the code made it
    // `yellow`; a reader of the reference would have been told both.
    const pattern = /\bdefaults? (?:to |is )?(?:`([^`]+)`|(-?\d+(?:\.\d+)?))/iu;
    const disagreements: string[] = [];
    for (const doc of docs.values()) {
      const names = new Set(doc.options?.fields.map((field) => field.name));
      for (const field of doc.options?.fields ?? []) {
        const match = pattern.exec(field.doc);
        if (!match || field.default === undefined) continue;
        const named = match[1] ?? match[2] ?? "";
        // Another field's name, or a constant's, is prose about where the
        // default comes from rather than a value to compare.
        if (names.has(named) || /^[A-Z][A-Z0-9_]*$/u.test(named)) continue;
        if (typeof field.default === "object") continue;
        if (String(field.default) !== named) {
          disagreements.push(`${doc.name}.${field.name}: doc says ${named}, code says ${String(field.default)}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});
