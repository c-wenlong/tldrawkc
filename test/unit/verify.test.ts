/**
 * The `verify` rules, without a browser.
 *
 * Everything a rule decides is decided from one measurement object, so the
 * rules are tested against a measurement rather than against Chromium. What
 * the browser produces that object out of is end-to-end territory
 * (`test/e2e/cli-verify.test.ts`), and it is the half that cannot be faked;
 * this is the half that has to be exactly right about what it claims.
 */

import { describe, expect, it } from "vitest";

import {
  buildHarness,
  checksFor,
  DEFAULT_VERIFY_WIDTH,
  MAX_VERIFY_HEIGHT,
  type SvgObservation,
  type VerifyCheck,
} from "../../src/lib/verify.js";

const PAGE = "http://127.0.0.1:51234/";

/** A render with nothing wrong with it: the shape every case starts from. */
function clean(): SvgObservation {
  return {
    declared: { width: "1367", height: "1167", viewBox: "-71 28 1367 1167" },
    intrinsic: { width: 1367, height: 1167 },
    viewBox: { width: 1367, height: 1167 },
    rendered: { width: 1500, height: 1281 },
    faces: [
      { family: "tldraw_draw", status: "loaded" },
      { family: "tldraw_sans", status: "loaded" },
    ],
    runs: [
      run({ text: "the mechanism" }),
      run({ text: "slot 1" }),
    ],
  };
}

function run(patch: Partial<SvgObservation["runs"][number]>): SvgObservation["runs"][number] {
  return {
    text: "label",
    families: ["tldraw_draw"],
    hidden: false,
    w: 90,
    h: 24,
    outside: false,
    ...patch,
  };
}

/** One rule out of a run, by name. */
function ruled(checks: VerifyCheck[], rule: string): VerifyCheck {
  const found = checks.find((check) => check.rule === rule);
  if (found === undefined) throw new Error(`no check named ${rule}: ${checks.map((c) => c.rule).join(", ")}`);
  return found;
}

describe("checksFor", () => {
  it("passes a clean render, and names all four rules", () => {
    const checks = checksFor(clean(), [PAGE], PAGE);
    expect(checks.map((check) => check.rule)).toEqual([
      "self-contained",
      "fonts-applied",
      "text-visible",
      "declared-size",
    ]);
    expect(checks.every((check) => check.ok)).toBe(true);
  });

  it("counts the page itself as no request, with or without the trailing slash", () => {
    const checks = checksFor(clean(), ["http://127.0.0.1:51234", PAGE], PAGE);
    expect(ruled(checks, "self-contained").ok).toBe(true);
  });
});

describe("self-contained", () => {
  it("fails on anything the file reached for, and names it", () => {
    const checks = checksFor(
      clean(),
      [PAGE, "https://fonts.example/shantell.woff2"],
      PAGE,
    );
    const check = ruled(checks, "self-contained");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("1 request");
    expect(check.detail).toContain("https://fonts.example/shantell.woff2");
  });

  it("counts a same-origin fetch too, since an <img> embed would not make it", () => {
    // The failure this exists for is a font that was linked instead of
    // inlined. Whether the link happens to resolve on the machine doing the
    // check says nothing about the machine reading the diagram.
    const checks = checksFor(clean(), [PAGE, `${PAGE}fonts/shantell.woff2`], PAGE);
    expect(ruled(checks, "self-contained").ok).toBe(false);
  });

  it("summarises a long list rather than printing all of it", () => {
    const requests = [PAGE, ...Array.from({ length: 6 }, (_, i) => `${PAGE}a${String(i)}.woff2`)];
    const check = ruled(checksFor(clean(), requests, PAGE), "self-contained");
    expect(check.detail).toContain("6 requests");
    expect(check.detail).toContain("+3 more");
  });
});

describe("fonts-applied", () => {
  it("fails when the text asks for a family no face provides", () => {
    // What a stripped `@font-face` block looks like from here: the labels are
    // still in the file and still say `tldraw_draw`, and nothing draws them.
    const observation = clean();
    observation.faces = [];
    const check = ruled(checksFor(observation, [PAGE], PAGE), "fonts-applied");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("tldraw_draw");
    expect(check.detail).toContain("2 text runs");
  });

  it("fails when a declared face failed to load", () => {
    const observation = clean();
    observation.faces = [
      { family: "tldraw_draw", status: "error" },
      { family: "tldraw_sans", status: "loaded" },
    ];
    observation.runs = [run({ families: ["tldraw_sans"] })];
    const check = ruled(checksFor(observation, [PAGE], PAGE), "fonts-applied");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("tldraw_draw failed to load");
  });

  it("ignores a run whose whole stack is generic", () => {
    // It names no face, so there is no face that could have failed to load.
    const observation = clean();
    observation.faces = [];
    observation.runs = [run({ families: [] })];
    expect(ruled(checksFor(observation, [PAGE], PAGE), "fonts-applied").ok).toBe(true);
  });

  it("ignores a hidden run", () => {
    const observation = clean();
    observation.faces = [];
    observation.runs = [run({ hidden: true })];
    expect(ruled(checksFor(observation, [PAGE], PAGE), "fonts-applied").ok).toBe(true);
  });

  it("accepts a fallback further down the stack", () => {
    const observation = clean();
    observation.faces = [{ family: "tldraw_sans", status: "loaded" }];
    observation.runs = [run({ families: ["tldraw_draw", "tldraw_sans"] })];
    expect(ruled(checksFor(observation, [PAGE], PAGE), "fonts-applied").ok).toBe(true);
  });

  it("says which faces loaded when it passes", () => {
    const check = ruled(checksFor(clean(), [PAGE], PAGE), "fonts-applied");
    expect(check.detail).toContain("tldraw_draw");
    expect(check.detail).toContain("2 faces loaded");
  });
});

describe("text-visible", () => {
  it("fails on a run with no box", () => {
    const observation = clean();
    observation.runs = [run({ text: "slot 1", w: 0, h: 0 })];
    const check = ruled(checksFor(observation, [PAGE], PAGE), "text-visible");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('"slot 1"');
  });

  it("fails on a run outside the frame", () => {
    const observation = clean();
    observation.runs = [run({ text: "off the edge", outside: true })];
    const check = ruled(checksFor(observation, [PAGE], PAGE), "text-visible");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("outside the frame");
  });

  it("says nothing about legibility, only about layout", () => {
    // The claim in the detail line is the claim the rule can support. A label
    // covered by a shape drawn over it has a box inside the frame and passes,
    // which is why the command returns a PNG rather than a verdict.
    const check = ruled(checksFor(clean(), [PAGE], PAGE), "text-visible");
    expect(check.detail).toContain("box inside the frame");
    expect(check.detail).not.toContain("legible");
  });
});

describe("declared-size", () => {
  it("fails when the root declares no size", () => {
    const observation = clean();
    observation.declared = { width: null, height: null, viewBox: "0 0 100 50" };
    const check = ruled(checksFor(observation, [PAGE], PAGE), "declared-size");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("300x150");
  });

  it("fails when the viewBox disagrees with the declared size", () => {
    const observation = clean();
    observation.viewBox = { width: 1367, height: 500 };
    const check = ruled(checksFor(observation, [PAGE], PAGE), "declared-size");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("viewBox");
  });

  it("fails when the browser laid it out at another shape", () => {
    const observation = clean();
    observation.rendered = { width: 1500, height: 400 };
    const check = ruled(checksFor(observation, [PAGE], PAGE), "declared-size");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("another shape");
  });

  it("passes with no viewBox at all, and says so", () => {
    const observation = clean();
    observation.declared = { width: "1367", height: "1167", viewBox: null };
    observation.viewBox = { width: null, height: null };
    const check = ruled(checksFor(observation, [PAGE], PAGE), "declared-size");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("no viewBox");
  });

  it("reports the scale the raster was taken at", () => {
    expect(ruled(checksFor(clean(), [PAGE], PAGE), "declared-size").detail).toContain("1.10x");
  });
});

describe("buildHarness", () => {
  it("escapes every < so the SVG cannot end the script block", () => {
    const html = buildHarness('<svg><text>a &lt; b</text></svg>');
    const payload = /id="kc-svg">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(payload).not.toContain("<");
    expect((JSON.parse(payload) as { svg: string }).svg).toBe(
      '<svg><text>a &lt; b</text></svg>',
    );
  });

  it("survives a closing script tag inside the file", () => {
    const html = buildHarness("<svg><desc></script></desc></svg>");
    // One script element, not two: the payload would otherwise be cut in half
    // and the rest of the SVG would be parsed as markup.
    expect(html.match(/<\/script>/g)?.length).toBe(1);
  });

  it("asks for no favicon over the network", () => {
    // A request for a missing icon would be a request, and `self-contained`
    // counts every one of them.
    expect(buildHarness("<svg/>")).toContain('<link rel="icon" href="data:,">');
  });
});

describe("the numbers", () => {
  it("keeps the default width under what the Read tool downscales to", () => {
    // 1568 px on the longest edge is where an image is resized before it is
    // looked at, so a wider raster is bytes with no legibility behind them.
    expect(DEFAULT_VERIFY_WIDTH).toBeLessThan(1568);
    expect(MAX_VERIFY_HEIGHT).toBeGreaterThan(DEFAULT_VERIFY_WIDTH);
  });
});
