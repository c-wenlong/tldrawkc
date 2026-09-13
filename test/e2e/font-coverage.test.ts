/**
 * The shipped coverage table, against what a real browser actually draws.
 *
 * `test/unit/font-coverage.test.ts` proves the table matches the `cmap` of the
 * font files. This proves the `cmap` is the thing the browser obeys, which is
 * the claim `missing-glyph` rests on and the only part of it a unit test
 * cannot reach.
 *
 * The oracle is a width comparison in the DOM, and it is fiddly for a reason
 * worth writing down. `document.fonts.check()` cannot answer: it reports
 * whether a matching face is loaded, so it says every family has every
 * character. Canvas cannot answer either, because `ctx.font` takes a family
 * list but ignores everything past the first resolvable entry when it falls
 * back, so a missing glyph lands in a system font rather than the next family
 * named. In the DOM it does fall through, so `font-family: A, B` rendering a
 * character exactly as wide as `font-family: B` means A handed it to B.
 *
 * Two things follow. The witness has to have different advance widths from the
 * font under test, so the three IBM Plex faces (which share metrics) can only
 * be witnessed by Shantell Sans. And a character no bundled font has cannot be
 * ruled on at all, because then both sides fall through to the system and
 * Chrome may pick a different system font on each side. Those are counted, and
 * asserted to be exactly the set the table says nothing can draw.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

import { resolveChromium } from "../../src/lib/browser.js";
import { startPageServer, type PageServer } from "../../src/lib/server.js";
import { PAGE_DIST_DIR } from "../../src/lib/paths.js";
import { missingCharacters } from "../../src/page/helpers/lints.js";

/** The characters a teaching diagram reaches for beyond ASCII. */
const CANDIDATES = "√·×÷≤≥≠≈∞∑∏πθλαβσμ²³°←→↔⇒∈∉⊂∪∩∀∃¬∧∨∂∇∫−–—‘’“”…";

const FAMILIES = ["draw", "sans", "serif", "mono"] as const;

/** The CSS family tldraw registers for each `font` prop value. */
const CSS_FAMILY: Record<string, string> = {
  draw: "tldraw_draw",
  sans: "tldraw_sans",
  serif: "tldraw_serif",
  mono: "tldraw_mono",
};

/**
 * The slice of the DOM the in-page functions touch.
 *
 * Spelled out rather than reached for through `lib: ["dom"]`, because the node
 * side of this repo deliberately builds without the DOM and widening the
 * shared tsconfig would stop `src/lib` failing when it reaches for `document`.
 * Types are erased, so naming them here costs the browser nothing.
 */
interface BrowserElement {
  style: { cssText: string; fontFamily: string };
  textContent: string;
  getBoundingClientRect(): { width: number };
  remove(): void;
}
interface BrowserDocument {
  createElement(tag: string): BrowserElement;
  body: { appendChild(node: BrowserElement): void };
  fonts: { load(font: string, text: string): Promise<unknown>; ready: Promise<unknown> };
}
type BrowserGlobal = { document: BrowserDocument };

/** One character to measure, and the family that should catch it if it falls. */
interface Probe {
  character: string;
  witness: string | null;
}

let server: PageServer;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  server = await startPageServer({ root: PAGE_DIST_DIR });
  const resolved = await resolveChromium();
  browser = await chromium.launch({ executablePath: resolved.executablePath });
  page = await browser.newPage();
  await page.goto(server.url, { waitUntil: "load" });
  await page.evaluate(async (families: string[]) => {
    const doc = (globalThis as unknown as BrowserGlobal).document;
    for (const family of families) await doc.fonts.load(`40px "${family}"`, "abc");
    await doc.fonts.ready;
  }, Object.values(CSS_FAMILY));
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * Which of `characters` Chrome hands from `font` to a witness family, and
 * which it cannot rule on.
 */
async function askChrome(
  font: string,
  characters: string[],
): Promise<{ fellBack: string[]; unrulable: string[] }> {
  const witnesses = font === "draw" ? ["serif", "sans", "mono"] : ["draw"];
  const probes: Probe[] = characters.map((character) => {
    const witness = witnesses.find((name) => missingCharacters(name, character).length === 0);
    return { character, witness: witness === undefined ? null : (CSS_FAMILY[witness] ?? null) };
  });

  return page.evaluate(
    ({ target, probes }: { target: string; probes: Probe[] }) => {
      const doc = (globalThis as unknown as BrowserGlobal).document;
      const host = doc.createElement("div");
      host.style.cssText =
        "position:absolute;left:-99999px;top:0;font-size:100px;white-space:pre;";
      doc.body.appendChild(host);
      const widthOf = (family: string, character: string): number => {
        host.style.fontFamily = family;
        // Twenty copies, so a sub-pixel difference in one advance adds up to
        // something no rounding can hide.
        host.textContent = character.repeat(20);
        return host.getBoundingClientRect().width;
      };
      const fellBack: string[] = [];
      const unrulable: string[] = [];
      for (const probe of probes) {
        if (probe.witness === null) {
          unrulable.push(probe.character);
          continue;
        }
        const composite = widthOf(`"${target}","${probe.witness}"`, probe.character);
        const alone = widthOf(`"${probe.witness}"`, probe.character);
        if (Math.abs(composite - alone) < 0.01) fellBack.push(probe.character);
      }
      host.remove();
      return { fellBack, unrulable };
    },
    { target: CSS_FAMILY[font] ?? font, probes },
  );
}

describe("the coverage table, measured in a real browser", () => {
  for (const font of FAMILIES) {
    it(`agrees with Chrome about ${font}`, async () => {
      const characters = [...CANDIDATES];
      const missing = new Set(missingCharacters(font, CANDIDATES));
      const { fellBack, unrulable } = await askChrome(font, characters);

      // Everything the table calls missing, that Chrome can rule on, Chrome
      // hands to the witness. Everything it calls present, it does not.
      const skipped = new Set(unrulable);
      const rulable = characters.filter((character) => !skipped.has(character));
      expect(fellBack.sort()).toEqual(rulable.filter((character) => missing.has(character)).sort());
    });
  }

  it("cannot rule only on the characters no bundled font has", async () => {
    const { unrulable } = await askChrome("draw", [...CANDIDATES]);
    const nowhere = [...CANDIDATES].filter((character) =>
      FAMILIES.every((font) => missingCharacters(font, character).length > 0),
    );
    expect(unrulable).toEqual(nowhere);
  });

  it("draws a square root from the draw font, and a theta from somewhere else", async () => {
    // The two facts the rule was written around, stated where a browser can
    // contradict them.
    const { fellBack } = await askChrome("draw", ["√", "θ", "π"]);
    expect(fellBack).toEqual(["θ"]);
  });
});
