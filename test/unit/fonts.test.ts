/**
 * The font subsetter's pure halves, plus the promise it makes when it fails.
 *
 * Three things are worth a test here and they are all string surgery: which
 * characters the document is judged to draw, where the `@font-face` blocks
 * are, and that a face the subsetter cannot read keeps its full payload rather
 * than costing the export. The real woff2 round trip is an end-to-end concern,
 * because the only proof that matters there is a rendered picture.
 */

import { describe, expect, it } from "vitest";

import {
  collectSvgCharacters,
  decodeEntities,
  findFontFaces,
  spliceFontFaces,
  subsetSvgFonts,
  SAFETY_CHARACTERS,
} from "../../src/lib/fonts.js";

/** An `@font-face` block shaped like the one `getSvgString` writes. */
function face(family: string, base64: string): string {
  return `@font-face {\n  font-family: "${family}";\n  font-weight: normal;\n  src: url("data:font/woff2;base64,${base64}") format(woff2);\n}`;
}

/** A whole export: two inlined faces and one label that uses one of them. */
function svgWith(faces: string[], body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg"><defs><style>${faces.join("\n")}</style></defs>${body}</svg>`;
}

/** Everything in `chars` that is not part of the fixed safety set. */
function beyondSafety(chars: string): string {
  const safe = new Set([...SAFETY_CHARACTERS]);
  return [...chars].filter((ch) => !safe.has(ch)).join("");
}

describe("collectSvgCharacters", () => {
  it("reads the text of a foreignObject label", () => {
    const svg = svgWith(
      [],
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><p>dot</p></div></foreignObject>',
    );
    expect(beyondSafety(collectSvgCharacters(svg))).toBe("dot");
  });

  it("turns entities back into the characters they stand for", () => {
    // `&#8730;` is the square root sign, and it is a glyph the diagram draws
    // even though the file never contains it literally.
    const svg = svgWith([], "<text>&#8730;&#215;&amp;&#xb7;</text>");
    const chars = collectSvgCharacters(svg);
    for (const ch of ["√", "×", "&", "·"]) {
      expect(chars, `missing ${ch}`).toContain(ch);
    }
  });

  it("keeps an entity it does not know, letters and all", () => {
    // The rule is over-collect: an unknown entity contributes its own letters
    // rather than disappearing, so a glyph is never lost to a parsing gap.
    const svg = svgWith([], "<text>&oelig;</text>");
    expect(collectSvgCharacters(svg)).toContain("o");
    expect(collectSvgCharacters(svg)).toContain("g");
  });

  it("is not fooled by a > inside an attribute value", () => {
    // A naive `<[^>]*>` strip ends the tag at the first `>` and then treats
    // `y">Z` as text, which quietly adds a glyph nothing draws. Worse, the
    // same mistake in the other direction loses one.
    const svg = svgWith([], '<g data-note="a > b"><text>Z</text></g>');
    expect(beyondSafety(collectSvgCharacters(svg))).toBe("Z");
  });

  it("never takes characters from a base64 payload", () => {
    // The payload alphabet is most of ASCII. Letting it in would defeat the
    // whole exercise, quietly, by producing a subset the size of the original.
    const svg = svgWith([face("tldraw_draw", "QUJDWFlaqrs+/w==")], "<text>hi</text>");
    expect(beyondSafety(collectSvgCharacters(svg))).toBe("hi");
  });

  it("skips a script element and reads a comment as nothing", () => {
    const svg = svgWith(
      [],
      "<script>var q = 'JKLM';</script><!-- WXYZ --><text>ab</text>",
    );
    expect(beyondSafety(collectSvgCharacters(svg))).toBe("ab");
  });

  it("reads CDATA as text", () => {
    const svg = svgWith([], "<text><![CDATA[qq]]></text>");
    expect(beyondSafety(collectSvgCharacters(svg))).toBe("q");
  });

  it("always carries the safety set, even for an empty document", () => {
    const chars = collectSvgCharacters("<svg></svg>");
    for (const ch of SAFETY_CHARACTERS) expect(chars).toContain(ch);
  });

  it("drops the whitespace a font has no glyph for", () => {
    const chars = collectSvgCharacters(svgWith([], "<text>a\n\tb</text>"));
    expect(chars).not.toContain("\n");
    expect(chars).not.toContain("\t");
    expect(chars).toContain(" ");
  });
});

describe("decodeEntities", () => {
  it("handles decimal, hex and the named five", () => {
    expect(decodeEntities("&#65;&#x42;&amp;&lt;&gt;&quot;&apos;")).toBe('AB&<>"\'');
  });

  it("leaves a malformed numeric entity alone", () => {
    expect(decodeEntities("&#999999999999;")).toBe("&#999999999999;");
  });

  it("decodes nbsp to the character, not to a plain space", () => {
    expect(decodeEntities("a&nbsp;b")).toBe("a\u00a0b");
  });
});

describe("findFontFaces", () => {
  it("finds each inlined face with the offsets of its payload", () => {
    const svg = svgWith(
      [face("tldraw_draw", "AAAA"), face("tldraw_sans", "BBBB")],
      "<text>x</text>",
    );
    const faces = findFontFaces(svg);
    expect(faces.map((f) => f.family)).toEqual(["tldraw_draw", "tldraw_sans"]);
    for (const found of faces) {
      expect(svg.slice(found.payloadStart, found.payloadEnd)).toBe(found.payload);
      expect(svg.slice(found.start, found.end)).toMatch(/^@font-face \{[\s\S]*\}$/);
    }
  });

  it("ignores a face whose src is not an inline woff2", () => {
    const remote = '@font-face {\n  font-family: "remote";\n  src: url("https://example.invalid/f.woff2");\n}';
    const inlineWoff = '@font-face {\n  font-family: "old";\n  src: url("data:font/woff;base64,AAAA");\n}';
    const faces = findFontFaces(svgWith([remote, inlineWoff, face("kept", "CCCC")], ""));
    expect(faces.map((f) => f.family)).toEqual(["kept"]);
  });

  it("reads an unquoted family name", () => {
    const bare = "@font-face { font-family: tldraw_draw; src: url(data:font/woff2;base64,DDDD); }";
    expect(findFontFaces(bare).map((f) => f.family)).toEqual(["tldraw_draw"]);
  });
});

describe("spliceFontFaces", () => {
  it("swaps a payload and leaves everything around it byte for byte", () => {
    const svg = svgWith([face("a", "AAAA"), face("b", "BBBB")], "<text>x</text>");
    const faces = findFontFaces(svg);
    const first = faces[0];
    if (!first) throw new Error("the fixture has no faces");
    const out = spliceFontFaces(svg, faces, new Map([[first.start, "ZZ"]]));
    expect(out).toBe(svg.replace("base64,AAAA", "base64,ZZ"));
  });

  it("removes a face entirely for a null replacement", () => {
    const svg = svgWith([face("a", "AAAA"), face("b", "BBBB")], "<text>x</text>");
    const faces = findFontFaces(svg);
    const first = faces[0];
    if (!first) throw new Error("the fixture has no faces");
    const out = spliceFontFaces(svg, faces, new Map([[first.start, null]]));
    expect(out).not.toContain("AAAA");
    expect(out).toContain("BBBB");
  });

  it("takes the empty style element with the last face that was in it", () => {
    const svg = svgWith([face("a", "AAAA")], "<text>x</text>");
    const faces = findFontFaces(svg);
    const only = faces[0];
    if (!only) throw new Error("the fixture has no faces");
    const out = spliceFontFaces(svg, faces, new Map([[only.start, null]]));
    expect(out).not.toContain("<style>");
    expect(out).toContain("<text>x</text>");
  });
});

describe("subsetSvgFonts", () => {
  it("hands the SVG back untouched when subsetting is off", async () => {
    const svg = svgWith([face("tldraw_draw", "AAAA")], "<text>x</text>");
    const result = await subsetSvgFonts(svg, { enabled: false });
    expect(result.svg).toBe(svg);
    expect(result.subset).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("keeps the full font and warns when harfbuzz cannot read it", async () => {
    // "AAAA" is four bytes of nothing, not a font. The promise is that this
    // costs a warning and never the export.
    const svg = svgWith([face("tldraw_draw", "AAAA")], '<text font-family="tldraw_draw">x</text>');
    const result = await subsetSvgFonts(svg, { enabled: true });
    expect(result.svg).toBe(svg);
    expect(result.subset).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("tldraw_draw");
    expect(result.faces).toEqual([
      { family: "tldraw_draw", action: "kept", before: 3, after: 3 },
    ]);
  });

  it("drops a family nothing references without asking harfbuzz", async () => {
    // The cheapest win: a face that is inlined and never used is pure weight,
    // and removing it needs no subsetter at all. This one is not a real font,
    // so a run that reached harfbuzz would have warned.
    const svg = svgWith(
      [face("tldraw_draw", "AAAA")],
      '<text font-family="something_else, sans-serif">x</text>',
    );
    const result = await subsetSvgFonts(svg, { enabled: true });
    expect(result.subset).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.faces.map((f) => f.action)).toEqual(["dropped"]);
    expect(result.svg).not.toContain("tldraw_draw");
  });

  it("does nothing to an SVG with no inlined fonts", async () => {
    const svg = svgWith([], "<text>x</text>");
    const result = await subsetSvgFonts(svg, { enabled: true });
    expect(result.svg).toBe(svg);
    expect(result.subset).toBe(false);
    expect(result.faces).toEqual([]);
  });
});
