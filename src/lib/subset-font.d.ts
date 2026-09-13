/**
 * Types for `subset-font`, which ships none of its own.
 *
 * It is a CommonJS module whose export is the function itself
 * (`module.exports = (...) => ...`), so the declaration uses `export =`; under
 * `module: nodenext` that is what makes `import subsetFont from "subset-font"`
 * resolve to the callable. Only the options this tool passes are declared: a
 * fuller transcription would be a second copy of somebody else's README, kept
 * up to date by nobody.
 */
declare module "subset-font" {
  /** The formats `fontverter` can convert the harfbuzz output into. */
  type FontFormat = "sfnt" | "truetype" | "woff" | "woff2";

  interface SubsetFontOptions {
    /** Output format. Defaults to the format the input was detected as. */
    targetFormat?: FontFormat;
    /** OpenType feature tags to keep beyond the ones harfbuzz keeps by default. */
    keepFeatures?: string[];
    /** Name table ids to preserve. */
    preserveNameIds?: number[];
  }

  /**
   * Cut `font` down to the glyphs `text` needs.
   *
   * Rejects when the input is not a font harfbuzz can read, or when the
   * subset comes back empty.
   */
  function subsetFont(
    font: Uint8Array,
    text: string,
    options?: SubsetFontOptions,
  ): Promise<Buffer>;

  export = subsetFont;
}
