/**
 * What characters each bundled font can actually draw.
 *
 * The `missing-glyph` lint needs one fact the page cannot work out for itself:
 * whether a font has a glyph for a character. A browser will not say. Chrome's
 * `document.fonts.check()` answers "is a face matching this family loaded",
 * not "can it draw this", so it returns true for every character of every
 * family, and canvas measurement cannot tell a fallback apart from a hit
 * because `ctx.font` ignores the rest of the family list when it falls back.
 *
 * So the answer is read out of the font binary, which is where the browser
 * reads it from too: the `cmap` table of each woff2 in
 * `node_modules/@tldraw/assets/fonts/`. That is the same file Vite copies into
 * `dist/page/assets`, so the table this produces describes the fonts the page
 * really loads.
 *
 * Stdlib only, on purpose. woff2 is a table directory plus one brotli stream
 * of the table data, and `node:zlib` has brotli, so reading `cmap` out of it
 * costs about a hundred lines and no third runtime dependency (AGENTS.md,
 * "Conventions"). The glyf transform woff2 also applies is irrelevant here:
 * `cmap` is never transformed, so its bytes come out of the stream as they
 * went in.
 *
 * The output is consumed by the generated data module at
 * `src/page/helpers/font-coverage.ts`. Nothing here runs at lint time.
 */

import { brotliDecompressSync } from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";

import { writeText } from "./files.js";
import { PACKAGE_ROOT } from "./paths.js";

/**
 * The four families tldraw draws labels in, and the faces of each.
 *
 * Keyed by the value of a shape's `font` prop, which is what the lint rule and
 * `helpers.box({ font: 'sans' })` both speak. All four faces of a family are
 * read and required to agree: a bold label must not be able to lose a glyph
 * the regular one has, and today none of them do.
 */
export const FONT_FILES: Readonly<Record<string, readonly string[]>> = {
  draw: [
    "Shantell_Sans-Informal_Regular.woff2",
    "Shantell_Sans-Informal_Regular_Italic.woff2",
    "Shantell_Sans-Informal_Bold.woff2",
    "Shantell_Sans-Informal_Bold_Italic.woff2",
  ],
  sans: [
    "IBMPlexSans-Medium.woff2",
    "IBMPlexSans-MediumItalic.woff2",
    "IBMPlexSans-Bold.woff2",
    "IBMPlexSans-BoldItalic.woff2",
  ],
  serif: [
    "IBMPlexSerif-Medium.woff2",
    "IBMPlexSerif-MediumItalic.woff2",
    "IBMPlexSerif-Bold.woff2",
    "IBMPlexSerif-BoldItalic.woff2",
  ],
  mono: [
    "IBMPlexMono-Medium.woff2",
    "IBMPlexMono-MediumItalic.woff2",
    "IBMPlexMono-Bold.woff2",
    "IBMPlexMono-BoldItalic.woff2",
  ],
};

/** Where the woff2 files live, relative to the package root. */
export const FONT_DIRECTORY = path.join("node_modules", "@tldraw", "assets", "fonts");

/**
 * The 63 table tags woff2 encodes as a five-bit index instead of four bytes.
 *
 * From the WOFF2 specification's known table tags list, in its order. Only
 * three entries actually change what this parser does (`glyf`, `loca` and
 * `hmtx` are the tables that can be transformed, and a transformed table
 * carries a second length), but an index has to be resolved to a tag before
 * that question can be asked, so the whole list is here.
 */
const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post",
  "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea",
  "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar",
  "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop",
  "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
] as const;

/** A half-open run of code points the font covers, `[first, last]` inclusive. */
export type CoverageRange = readonly [number, number];

/** Raised when a font file is not the woff2 this parser was written against. */
export class FontParseError extends Error {
  override readonly name = "FontParseError";
}

/**
 * Every code point the woff2 in `bytes` has a glyph for.
 *
 * "Has a glyph" means the font's own `cmap` maps the code point to a non-zero
 * glyph id, which is exactly the test the browser applies before it gives up
 * and falls back to a system font.
 */
export function coveredCodePoints(bytes: Buffer): Set<number> {
  const cmap = readWoff2Table(bytes, "cmap");
  if (cmap === null) throw new FontParseError("the font has no cmap table");
  return readCmap(cmap);
}

/**
 * Pull one table out of a woff2 file, or `null` when it holds no such table.
 *
 * Only safe for a table woff2 never transforms, which is everything but
 * `glyf`, `loca` and `hmtx`. A transformed table would come back in its
 * transformed encoding, and this refuses rather than handing that back.
 */
export function readWoff2Table(bytes: Buffer, wanted: string): Buffer | null {
  if (bytes.length < 48 || bytes.toString("latin1", 0, 4) !== "wOF2") {
    throw new FontParseError("not a woff2 file");
  }
  const numTables = bytes.readUInt16BE(12);
  const totalCompressedSize = bytes.readUInt32BE(20);

  let cursor = 48;
  const entries: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i += 1) {
    if (cursor >= bytes.length) throw new FontParseError("the table directory is truncated");
    const flags = bytes.readUInt8(cursor);
    cursor += 1;
    const index = flags & 0x3f;
    let tag: string;
    if (index === 0x3f) {
      tag = bytes.toString("latin1", cursor, cursor + 4);
      cursor += 4;
    } else {
      const known = KNOWN_TAGS[index];
      if (known === undefined) throw new FontParseError(`unknown table index ${index}`);
      tag = known;
    }
    const origLength = readUIntBase128(bytes, cursor);
    cursor = origLength.next;

    // glyf and loca invert the convention: version 0 is the transform and
    // version 3 is the null transform. Everywhere else a non-zero version is
    // the transform.
    const version = (flags >> 6) & 0x03;
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    let length = origLength.value;
    if (transformed) {
      const transformLength = readUIntBase128(bytes, cursor);
      cursor = transformLength.next;
      length = transformLength.value;
      if (tag === wanted) {
        throw new FontParseError(`${tag} is transformed, which this reader does not undo`);
      }
    }
    entries.push({ tag, length });
  }

  const compressed = bytes.subarray(cursor, cursor + totalCompressedSize);
  const tables = brotliDecompressSync(compressed);

  let offset = 0;
  for (const entry of entries) {
    if (entry.tag === wanted) return tables.subarray(offset, offset + entry.length);
    // Contiguous, with no padding. The four-byte alignment an sfnt has is put
    // back when the font is reconstructed, not stored in the stream.
    offset += entry.length;
  }
  return null;
}

/**
 * Read a `cmap` table into the set of code points it maps to a real glyph.
 *
 * Formats 4 and 12 only, which is every subtable the four bundled fonts carry.
 * The best available subtable wins: a format 12 Unicode one over a format 4
 * BMP one, because the first covers everything the second does and more.
 */
export function readCmap(cmap: Buffer): Set<number> {
  const count = cmap.readUInt16BE(2);
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < count; i += 1) {
    const record = 4 + i * 8;
    const platform = cmap.readUInt16BE(record);
    const encoding = cmap.readUInt16BE(record + 2);
    const offset = cmap.readUInt32BE(record + 4);
    const score =
      platform === 3 && encoding === 10
        ? 4
        : platform === 0 && encoding >= 4
          ? 3
          : platform === 3 && encoding === 1
            ? 2
            : platform === 0
              ? 1
              : 0;
    if (score > bestScore) {
      bestScore = score;
      best = offset;
    }
  }
  if (best < 0) throw new FontParseError("the cmap table has no subtable");

  const format = cmap.readUInt16BE(best);
  const covered = new Set<number>();
  if (format === 4) {
    const segCountX2 = cmap.readUInt16BE(best + 6);
    const endAt = best + 14;
    const startAt = endAt + segCountX2 + 2;
    const deltaAt = startAt + segCountX2;
    const rangeAt = deltaAt + segCountX2;
    for (let seg = 0; seg < segCountX2 / 2; seg += 1) {
      const end = cmap.readUInt16BE(endAt + seg * 2);
      const start = cmap.readUInt16BE(startAt + seg * 2);
      // The mandatory final segment, which maps nothing.
      if (start === 0xffff) continue;
      const delta = cmap.readInt16BE(deltaAt + seg * 2);
      const rangeOffset = cmap.readUInt16BE(rangeAt + seg * 2);
      for (let code = start; code <= end; code += 1) {
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (code + delta) & 0xffff;
        } else {
          const at = rangeAt + seg * 2 + rangeOffset + (code - start) * 2;
          if (at + 1 >= cmap.length) continue;
          glyph = cmap.readUInt16BE(at);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        // Glyph 0 is `.notdef`, which is the font saying it has nothing.
        if (glyph !== 0) covered.add(code);
      }
    }
  } else if (format === 12) {
    const groups = cmap.readUInt32BE(best + 12);
    for (let group = 0; group < groups; group += 1) {
      const record = best + 16 + group * 12;
      const start = cmap.readUInt32BE(record);
      const end = cmap.readUInt32BE(record + 4);
      const firstGlyph = cmap.readUInt32BE(record + 8);
      if (firstGlyph === 0 && start === end) continue;
      for (let code = start; code <= end; code += 1) covered.add(code);
    }
  } else {
    throw new FontParseError(`cmap subtable format ${format} is not handled`);
  }
  return covered;
}

/**
 * The coverage of every family in {@link FONT_FILES}, as sorted ranges.
 *
 * Ranges rather than a list of code points because the four fonts cover about
 * 900 characters each in roughly a hundred runs, so the shipped table is a few
 * hundred pairs instead of a few thousand numbers, and a run is what a reader
 * of the generated file can actually scan.
 *
 * Every face of a family has to agree. They do today, and a release where one
 * weight quietly lost a glyph is exactly the thing worth failing on rather
 * than averaging away.
 */
export async function readFontCoverage(
  fontsDirectory: string,
): Promise<Record<string, CoverageRange[]>> {
  const coverage: Record<string, CoverageRange[]> = {};
  for (const [font, files] of Object.entries(FONT_FILES)) {
    let shared: Set<number> | null = null;
    for (const file of files) {
      const bytes = await fs.readFile(path.join(fontsDirectory, file));
      const covered = coveredCodePoints(bytes);
      if (shared === null) {
        shared = covered;
        continue;
      }
      if (shared.size !== covered.size || [...shared].some((code) => !covered.has(code))) {
        throw new FontParseError(
          `${file} covers a different set of characters from the other ${font} faces`,
        );
      }
    }
    coverage[font] = toRanges(shared ?? new Set());
  }
  return coverage;
}

/** Sorted code points, collapsed into inclusive runs. */
export function toRanges(codes: ReadonlySet<number>): CoverageRange[] {
  const sorted = [...codes].sort((a, b) => a - b);
  const ranges: CoverageRange[] = [];
  let first: number | null = null;
  let previous = -2;
  for (const code of sorted) {
    if (first === null) first = code;
    else if (code !== previous + 1) {
      ranges.push([first, previous]);
      first = code;
    }
    previous = code;
  }
  if (first !== null) ranges.push([first, previous]);
  return ranges;
}

/** A `UIntBase128`: seven bits a byte, high bit continues. */
function readUIntBase128(bytes: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = bytes.readUInt8(at + i);
    // No leading zeroes, and the result has to fit in 32 bits.
    if (i === 0 && byte === 0x80) throw new FontParseError("a length has a leading zero");
    if (value > 0x01ffffff) throw new FontParseError("a length overflows 32 bits");
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
  }
  throw new FontParseError("a length runs past five bytes");
}

/**
 * Where the generated data module lands. Checked into git, because the lint
 * runs in a browser that has no font files to read.
 */
export const FONT_COVERAGE_MODULE = path.join(
  PACKAGE_ROOT,
  "src",
  "page",
  "helpers",
  "font-coverage.ts",
);

/**
 * The text of the generated module, given a coverage table.
 *
 * Split out from writing it so the unit suite can regenerate and compare
 * without touching the working tree: a table that has drifted from the fonts
 * on disk fails there rather than surviving until somebody looks at a picture.
 */
export function renderFontCoverageModule(
  coverage: Readonly<Record<string, readonly CoverageRange[]>>,
): string {
  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * Which characters each of tldraw's four label fonts can draw.");
  lines.push(" *");
  lines.push(" * GENERATED FILE. Do not edit by hand: run `npm run generate:fonts`,");
  lines.push(" * which reads the `cmap` of every woff2 in `@tldraw/assets` and rewrites");
  lines.push(" * this. `test/unit/font-coverage.test.ts` regenerates and diffs, so a");
  lines.push(" * tldraw upgrade that changes a font cannot leave the table stale.");
  lines.push(" *");
  lines.push(" * A range is inclusive at both ends. The `missing-glyph` lint is the one");
  lines.push(" * reader; `src/lib/font-coverage.ts` is the writer and says why the answer");
  lines.push(" * has to come from the font binary rather than from the browser.");
  lines.push(" */");
  lines.push("");
  lines.push("/** An inclusive run of code points a font covers. */");
  lines.push("export type CoverageRange = readonly [number, number];");
  lines.push("");
  lines.push("/** Keyed by a shape's `font` prop. Ranges are sorted and do not touch. */");
  lines.push(
    "export const FONT_COVERAGE: Readonly<Record<string, readonly CoverageRange[]>> = {",
  );
  for (const [font, ranges] of Object.entries(coverage)) {
    lines.push(`  ${font}: [`);
    for (const chunk of chunked(ranges, 6)) {
      lines.push(`    ${chunk.map(([a, b]) => `[${a}, ${b}]`).join(", ")},`);
    }
    lines.push("  ],");
  }
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

/** Read the fonts and rewrite the generated module. Returns what it wrote. */
export async function buildFontCoverage(): Promise<{ path: string; fonts: number }> {
  const coverage = await readFontCoverage(path.join(PACKAGE_ROOT, FONT_DIRECTORY));
  await writeText(FONT_COVERAGE_MODULE, renderFontCoverageModule(coverage));
  return { path: FONT_COVERAGE_MODULE, fonts: Object.keys(coverage).length };
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)]);
  return out;
}
