/**
 * Cutting the inlined fonts in an SVG export down to the glyphs it draws.
 *
 * `editor.getSvgString` inlines every font family the drawing uses as an
 * `@font-face` block whose `src` is a `data:font/woff2;base64,` URL, so the
 * file renders with no network (layering rule 7, and D8: the committed
 * artefact beside a note has to be self-contained). The whole of Shantell Sans
 * is about 150 kB and the whole of Inter about 65 kB, and a teaching diagram
 * uses forty characters of them. That is most of a committed SVG spent on
 * glyphs nobody will see.
 *
 * So this is a post-process on the Node side, over the string the page handed
 * back: read every character the document actually draws, hand each face to
 * harfbuzz with that set, and splice the smaller payload back in. The fonts
 * stay inline, because an SVG rendered as an image fetches nothing.
 *
 * Three rules hold the design together.
 *
 * - **Over-collect rather than under-collect.** A missing glyph is invisible
 *   until someone looks at the picture, and the cost of an extra glyph is
 *   half a kilobyte. So the scanner walks every text node in the document,
 *   `<foreignObject>` labels included, decodes entities, and adds a fixed
 *   safety set of digits and punctuation on top.
 * - **Never fail an export over this.** A face that harfbuzz refuses is kept
 *   whole and named in a warning. The picture is what was asked for.
 * - **Pure parts stay pure.** `collectSvgCharacters`, `findFontFaces` and
 *   `spliceFontFaces` take a string and return data, so they are unit tested
 *   without a font, a browser or a wasm module.
 */

import subsetFont from "subset-font";

/**
 * Characters every subset keeps, whether or not the document draws them.
 *
 * Digits and basic punctuation, because they are what a later hand edit of the
 * SVG is most likely to type, and because they are the cheapest possible
 * insurance against the scanner below missing a text node. The non-breaking
 * space is in here rather than left to the scanner: tldraw's label HTML is
 * full of them and an entity-decoding bug would be silent otherwise.
 */
export const SAFETY_CHARACTERS = " \u00a00123456789.,:;!?'\"()[]{}-/&%+=<>*#@";

/** The `data:` media types this tool will rewrite. tldraw emits the first. */
const WOFF2_MEDIA_TYPES = new Set(["font/woff2", "application/font-woff2"]);

/** One `@font-face` block in the SVG whose `src` is an inline woff2. */
export interface InlinedFontFace {
  /** The `font-family` the block declares, unquoted. */
  family: string;
  /** Offset of the `@` that opens the block. */
  start: number;
  /** Offset just past the `}` that closes it. */
  end: number;
  /** Offset of the first base64 character of the `src` payload. */
  payloadStart: number;
  /** Offset just past the last base64 character. */
  payloadEnd: number;
  /** The base64 payload, whitespace removed. */
  payload: string;
}

/** What happened to one face. */
export interface FontFaceOutcome {
  family: string;
  /**
   * `subset` when the payload was replaced, `dropped` when the family was
   * inlined but never referenced, `kept` when the full font stayed.
   */
  action: "subset" | "dropped" | "kept";
  /** Decoded font bytes before. */
  before: number;
  /** Decoded font bytes after, and 0 for a dropped face. */
  after: number;
}

export interface SubsetFontsOptions {
  /** False for `--no-subset-fonts`: hand the SVG straight back. */
  enabled: boolean;
}

export interface SubsetFontsResult {
  /** The SVG to write. The input unchanged when nothing could be done. */
  svg: string;
  /** True when at least one face was subset or dropped. */
  subset: boolean;
  /** One line per face that kept its full font, and why. Never a throw. */
  warnings: string[];
  /** Every inlined face the SVG had, in document order. */
  faces: FontFaceOutcome[];
}

/**
 * Subset every inlined woff2 in `svg` to the characters `svg` draws.
 *
 * Never throws: a face harfbuzz cannot read is kept whole and reported in
 * `warnings`, and a failure that reaches the top is reported the same way with
 * the original string handed back. An export is a picture, and a picture that
 * is 200 kB larger than it needed to be still beats no picture at all.
 */
export async function subsetSvgFonts(
  svg: string,
  options: SubsetFontsOptions,
): Promise<SubsetFontsResult> {
  if (!options.enabled) return { svg, subset: false, warnings: [], faces: [] };

  let faces: InlinedFontFace[];
  try {
    faces = findFontFaces(svg);
  } catch (error) {
    return { svg, subset: false, warnings: [`the SVG's fonts could not be read (${firstLine(error)})`], faces: [] };
  }
  if (faces.length === 0) return { svg, subset: false, warnings: [], faces: [] };

  const used = usedFamilies(svg, faces);
  const text = collectSvgCharacters(svg);

  const warnings: string[] = [];
  const outcomes: FontFaceOutcome[] = [];
  const replacements = new Map<number, string | null>();

  for (const face of faces) {
    // Length of the decoded payload without decoding it: four base64
    // characters carry three bytes, less whatever the padding stands in for.
    const before = decodedLength(face.payload);

    // The cheapest win first: a family nothing references is pure weight.
    if (!used.has(face.family)) {
      replacements.set(face.start, null);
      outcomes.push({ family: face.family, action: "dropped", before, after: 0 });
      continue;
    }

    try {
      const original = Buffer.from(face.payload, "base64");
      const reduced = await subsetFont(original, text, { targetFormat: "woff2" });
      // A subset that is not smaller is a subset that bought nothing, and
      // swapping it in would risk a regression for no gain.
      if (reduced.length === 0 || reduced.length >= original.length) {
        outcomes.push({ family: face.family, action: "kept", before, after: before });
        continue;
      }
      replacements.set(face.start, reduced.toString("base64"));
      outcomes.push({ family: face.family, action: "subset", before, after: reduced.length });
    } catch (error) {
      warnings.push(`${face.family}: kept the full font (${firstLine(error)})`);
      outcomes.push({ family: face.family, action: "kept", before, after: before });
    }
  }

  const changed = outcomes.some((outcome) => outcome.action !== "kept");
  if (!changed) return { svg, subset: false, warnings, faces: outcomes };

  return {
    svg: spliceFontFaces(svg, faces, replacements),
    subset: true,
    warnings,
    faces: outcomes,
  };
}

/**
 * Every `@font-face` block in `svg` whose `src` is an inline woff2.
 *
 * A block with any other `src` (a real URL, a woff, a format this tool has no
 * business rewriting) is not returned at all, so it passes through untouched
 * rather than being reported as a failure.
 */
export function findFontFaces(svg: string): InlinedFontFace[] {
  const faces: InlinedFontFace[] = [];
  const opener = /@font-face\s*\{/gi;
  for (let match = opener.exec(svg); match !== null; match = opener.exec(svg)) {
    const bodyStart = match.index + match[0].length;
    // A `@font-face` body is a flat list of declarations, so the first `}` is
    // the end of it. Nothing nests here.
    const bodyEnd = svg.indexOf("}", bodyStart);
    if (bodyEnd === -1) break;
    opener.lastIndex = bodyEnd + 1;

    const body = svg.slice(bodyStart, bodyEnd);
    const family = familyOf(body);
    if (family === null) continue;

    const payload = payloadIn(svg, bodyStart, bodyEnd);
    if (payload === null) continue;

    faces.push({
      family,
      start: match.index,
      end: bodyEnd + 1,
      payloadStart: payload.start,
      payloadEnd: payload.end,
      payload: payload.base64,
    });
  }
  return faces;
}

/**
 * Rewrite the payloads named in `replacements`, keyed by a face's `start`.
 *
 * A `null` replacement removes the whole block. Faces not named in the map are
 * left byte for byte as they were, which is what a fallback depends on.
 */
export function spliceFontFaces(
  svg: string,
  faces: readonly InlinedFontFace[],
  replacements: ReadonlyMap<number, string | null>,
): string {
  const ordered = [...faces].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  let dropped = false;

  for (const face of ordered) {
    if (!replacements.has(face.start)) continue;
    const replacement = replacements.get(face.start) ?? null;
    parts.push(svg.slice(cursor, face.start));
    if (replacement === null) {
      dropped = true;
    } else {
      parts.push(svg.slice(face.start, face.payloadStart));
      parts.push(replacement);
      parts.push(svg.slice(face.payloadEnd, face.end));
    }
    cursor = face.end;
  }
  parts.push(svg.slice(cursor));

  const out = parts.join("");
  // Dropping the only face in a `<style>` leaves an element that says nothing.
  return dropped ? out.replace(/<style(\s[^>]*)?>\s*<\/style>/gi, "") : out;
}

/**
 * Every character the document draws, plus {@link SAFETY_CHARACTERS}.
 *
 * The scanner walks tags rather than stripping them with a regex, because an
 * attribute value may legally contain `>` and a naive strip would then treat
 * markup as text (harmless) or text as markup (a missing glyph). `<style>` is
 * read with its `@font-face` blocks removed, so a base64 payload never
 * contributes its own alphabet; `<script>` is skipped, since nothing in it is
 * drawn. The result is sorted by code point so it is stable to assert on.
 */
export function collectSvgCharacters(svg: string): string {
  const chars = new Set<string>();
  for (const ch of SAFETY_CHARACTERS) chars.add(ch);

  const addText = (raw: string): void => {
    for (const ch of decodeEntities(raw)) {
      const code = ch.codePointAt(0) ?? 0;
      if (code >= 0x20) chars.add(ch);
    }
  };

  let i = 0;
  while (i < svg.length) {
    const lt = svg.indexOf("<", i);
    if (lt === -1) {
      addText(svg.slice(i));
      break;
    }
    addText(svg.slice(i, lt));

    if (svg.startsWith("<!--", lt)) {
      const close = svg.indexOf("-->", lt);
      i = close === -1 ? svg.length : close + 3;
      continue;
    }
    if (svg.startsWith("<![CDATA[", lt)) {
      const close = svg.indexOf("]]>", lt);
      addText(svg.slice(lt + 9, close === -1 ? svg.length : close));
      i = close === -1 ? svg.length : close + 3;
      continue;
    }

    const afterTag = endOfTag(svg, lt);
    const name = tagNameAt(svg, lt);
    if (name === "script" || name === "style") {
      const close = closingTagIndex(svg, afterTag, name);
      if (name === "style") {
        // The declarations, minus the base64 blobs. CSS is not entity encoded
        // in practice, and adding it raw only ever over-collects.
        const css = svg.slice(afterTag, close.contentEnd);
        for (const ch of stripFontFaceBlocks(css)) chars.add(ch);
      }
      i = close.next;
      continue;
    }
    i = afterTag;
  }

  chars.delete("\n");
  chars.delete("\r");
  chars.delete("\t");
  return [...chars].sort((a, b) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0)).join("");
}

// ---------------------------------------------------------------------------
// The small pieces
// ---------------------------------------------------------------------------

/** The families referenced anywhere outside the `@font-face` blocks. */
function usedFamilies(svg: string, faces: readonly InlinedFontFace[]): Set<string> {
  const parts: string[] = [];
  let cursor = 0;
  for (const face of [...faces].sort((a, b) => a.start - b.start)) {
    parts.push(svg.slice(cursor, face.start));
    cursor = face.end;
  }
  parts.push(svg.slice(cursor));
  const body = parts.join("");

  // A substring match, deliberately. `tldraw_draw` appearing inside a longer
  // family name would keep a font that is not used, which costs bytes; the
  // other mistake costs a diagram its letters.
  const used = new Set<string>();
  for (const face of faces) {
    if (face.family !== "" && body.includes(face.family)) used.add(face.family);
  }
  return used;
}

/** `font-family: "tldraw_draw";` to `tldraw_draw`, or `null` when absent. */
function familyOf(body: string): string | null {
  const match = /font-family\s*:\s*(?:"([^"]*)"|'([^']*)'|([^;\n}]+))/i.exec(body);
  if (!match) return null;
  const raw = match[1] ?? match[2] ?? match[3] ?? "";
  return raw.trim();
}

/** Locate the base64 run of a `src: url("data:font/woff2;base64,...")`. */
function payloadIn(
  svg: string,
  bodyStart: number,
  bodyEnd: number,
): { start: number; end: number; base64: string } | null {
  const body = svg.slice(bodyStart, bodyEnd);
  const url = /url\(\s*["']?data:([^;,)"']*);base64,/i.exec(body);
  if (!url || url.index === undefined) return null;
  if (!WOFF2_MEDIA_TYPES.has((url[1] ?? "").trim().toLowerCase())) return null;

  // Walked rather than matched: a greedy character class over a 200 kB blob is
  // an invitation to backtracking, and the run ends at the first character
  // base64 cannot contain.
  const start = bodyStart + url.index + url[0].length;
  let end = start;
  while (end < bodyEnd && isBase64Char(svg.charCodeAt(end))) end += 1;
  if (end === start) return null;
  return { start, end, base64: svg.slice(start, end) };
}

function isBase64Char(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2b || // +
    code === 0x2f || // /
    code === 0x3d // =
  );
}

/** Decoded byte length of a base64 string, without decoding it. */
function decodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** Offset just past the `>` that closes the tag opening at `lt`, quotes respected. */
function endOfTag(svg: string, lt: number): number {
  let quote = "";
  for (let i = lt + 1; i < svg.length; i += 1) {
    const ch = svg[i];
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i + 1;
    }
  }
  return svg.length;
}

/** The lowercased element name of the tag opening at `lt`, or `""`. */
function tagNameAt(svg: string, lt: number): string {
  const match = /^<\s*([A-Za-z_][\w.:-]*)/.exec(svg.slice(lt, lt + 64));
  return (match?.[1] ?? "").toLowerCase();
}

/** Where an element's content ends and where to resume, given its name. */
function closingTagIndex(
  svg: string,
  contentStart: number,
  name: string,
): { contentEnd: number; next: number } {
  const close = new RegExp(`</\\s*${name}\\s*>`, "i");
  const match = close.exec(svg.slice(contentStart));
  if (!match) return { contentEnd: svg.length, next: svg.length };
  return {
    contentEnd: contentStart + match.index,
    next: contentStart + match.index + match[0].length,
  };
}

/** CSS with every `@font-face { ... }` removed. */
function stripFontFaceBlocks(css: string): string {
  return css.replace(/@font-face\s*\{[^}]*\}/gi, " ");
}

/** The five XML entities plus the one tldraw's label HTML leans on. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: "\u00a0",
  quot: '"',
};

/**
 * Turn entities back into characters.
 *
 * An entity this does not know is left exactly as written, so its letters end
 * up in the set anyway. That is the over-collect rule: the wrong answer here
 * should cost bytes, never a glyph.
 */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}
