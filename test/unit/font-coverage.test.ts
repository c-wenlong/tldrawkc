/**
 * The generated font coverage table, checked against the fonts themselves.
 *
 * The point of this file is that the table cannot drift. It is data about
 * binaries in `node_modules`, so a tldraw upgrade that ships a different
 * Shantell Sans would otherwise leave `missing-glyph` confidently wrong, and
 * nobody would find out until a diagram came back with the wrong letters in
 * it. Here the fonts are read again and the module is rendered again, and the
 * two have to match byte for byte.
 *
 * It also pins the headline measurements, taken 2026-09-13 against
 * `@tldraw/assets` 5.4.2 and confirmed in a real Chrome.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import {
  coversCodePoint,
  missingCharacters,
} from "../../src/page/helpers/lints.js";
import { FONT_COVERAGE } from "../../src/page/helpers/font-coverage.js";
import {
  FONT_COVERAGE_MODULE,
  FONT_DIRECTORY,
  FONT_FILES,
  coveredCodePoints,
  readFontCoverage,
  renderFontCoverageModule,
  toRanges,
} from "../../src/lib/font-coverage.js";
import { PACKAGE_ROOT } from "../../src/lib/paths.js";

const fontsDirectory = path.join(PACKAGE_ROOT, FONT_DIRECTORY);

/** The candidate set the four lists in AGENTS.md were measured over. */
const CANDIDATES = "√·×÷≤≥≠≈∞∑∏πθλαβσμ²³°←→↔⇒∈∉⊂∪∩∀∃¬∧∨∂∇∫−–—‘’“”…";

describe("the generated coverage module", () => {
  it("still matches the fonts on disk", async () => {
    const regenerated = renderFontCoverageModule(await readFontCoverage(fontsDirectory));
    const shipped = await fs.readFile(FONT_COVERAGE_MODULE, "utf8");
    expect(regenerated).toBe(shipped);
  });

  it("covers every family a label can be set in", () => {
    expect(Object.keys(FONT_COVERAGE).sort()).toEqual(["draw", "mono", "sans", "serif"]);
  });

  it("keeps its ranges sorted and non-touching", () => {
    for (const ranges of Object.values(FONT_COVERAGE)) {
      for (let i = 0; i < ranges.length; i += 1) {
        const range = ranges[i];
        expect(range?.[0]).toBeLessThanOrEqual(range?.[1] ?? -1);
        const previous = ranges[i - 1];
        if (previous) expect(range?.[0]).toBeGreaterThan(previous[1] + 1);
      }
    }
  });
});

describe("the woff2 reader", () => {
  it("agrees across every face of a family", async () => {
    // The rendered module already asserts this, but a failure there points at
    // the whole file. This says which face moved.
    for (const files of Object.values(FONT_FILES)) {
      const sets = [];
      for (const file of files) {
        sets.push(coveredCodePoints(await fs.readFile(path.join(fontsDirectory, file))));
      }
      const first = sets[0];
      expect(first).toBeDefined();
      for (const set of sets) expect(set.size).toBe(first?.size);
    }
  });

  it("refuses a file that is not a woff2", async () => {
    const { readWoff2Table } = await import("../../src/lib/font-coverage.js");
    expect(() => readWoff2Table(Buffer.from("not a font at all, nowhere near"), "cmap")).toThrow(
      /not a woff2/,
    );
  });
});

describe("toRanges", () => {
  it("collapses a run and keeps a gap", () => {
    expect(toRanges(new Set([1, 2, 3, 7, 9, 10]))).toEqual([
      [1, 3],
      [7, 7],
      [9, 10],
    ]);
  });

  it("is empty for nothing", () => {
    expect(toRanges(new Set())).toEqual([]);
  });
});

describe("coversCodePoint", () => {
  it("finds a code point at either end of a range and inside it", () => {
    const ranges = [
      [10, 20],
      [30, 30],
    ] as const;
    expect(coversCodePoint(ranges, 10)).toBe(true);
    expect(coversCodePoint(ranges, 15)).toBe(true);
    expect(coversCodePoint(ranges, 20)).toBe(true);
    expect(coversCodePoint(ranges, 30)).toBe(true);
  });

  it("misses the gaps and the ends", () => {
    const ranges = [
      [10, 20],
      [30, 30],
    ] as const;
    expect(coversCodePoint(ranges, 9)).toBe(false);
    expect(coversCodePoint(ranges, 25)).toBe(false);
    expect(coversCodePoint(ranges, 31)).toBe(false);
    expect(coversCodePoint([], 10)).toBe(false);
  });
});

describe("the measured coverage, as facts", () => {
  it("gives every font the whole printable ASCII range", () => {
    let ascii = "";
    for (let code = 0x20; code <= 0x7e; code += 1) ascii += String.fromCodePoint(code);
    for (const font of Object.keys(FONT_COVERAGE)) {
      expect(missingCharacters(font, ascii)).toEqual([]);
    }
  });

  it("records what each font lacks from the maths and arrows set", () => {
    // Measured 2026-09-13 from the woff2 files, and confirmed by rendering
    // each character in a real Chrome. See the gotcha in AGENTS.md.
    expect(missingCharacters("draw", CANDIDATES).join("")).toBe("θλαβσμ⇒∈∉⊂∪∩∀∃∧∨∇");
    expect(missingCharacters("sans", CANDIDATES).join("")).toBe("⇒∈∉⊂∪∩∀∃∧∨∇");
    expect(missingCharacters("serif", CANDIDATES).join("")).toBe("⇒∈∉⊂∪∩∀∃∧∨∇");
    expect(missingCharacters("mono", CANDIDATES).join("")).toBe("θλαβσμ⇒∈∉⊂∪∩∀∃∧∨∇");
  });

  it("has a square root in every font, which is why √ is not a finding", () => {
    // The rule was written because Shantell Sans draws U+221A as something a
    // reader takes for a `v`. That is the glyph's shape, not a missing glyph:
    // the font has it, so no lint can or should fire on it.
    for (const font of Object.keys(FONT_COVERAGE)) {
      expect(missingCharacters(font, "√")).toEqual([]);
    }
  });
});
