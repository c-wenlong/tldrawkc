/**
 * The lint rules, on hand-built records.
 *
 * These run in node with no browser, which is the whole reason `lints.ts`
 * takes plain objects rather than an `Editor` (ARCHITECTURE.md, "Testing").
 * The records here are the shape of the real ones, trimmed to the fields the
 * rules read.
 */

import { describe, expect, it } from "vitest";

import {
  emptyLabels,
  friendlessArrows,
  intersectionArea,
  isContainer,
  isLintIgnored,
  LINT_RULES,
  OFF_PAGE_LIMIT,
  offPage,
  overlappingShapes,
  overlappingText,
  runLints,
  unreadableLabels,
  type LintBinding,
  type LintShape,
} from "../../../src/page/helpers/lints.js";

const box = (id: string): LintShape => ({ id, type: "geo" });
const arrow = (id: string, meta?: Record<string, unknown>): LintShape => ({
  id,
  type: "arrow",
  ...(meta ? { meta } : {}),
});
const bind = (arrowId: string, toId: string, terminal: "start" | "end"): LintBinding => ({
  type: "arrow",
  fromId: arrowId,
  toId,
  props: { terminal },
});

describe("friendless-arrow", () => {
  it("passes an arrow bound at both ends", () => {
    const shapes = [box("shape:a"), box("shape:b"), arrow("shape:x")];
    const bindings = [bind("shape:x", "shape:a", "start"), bind("shape:x", "shape:b", "end")];
    expect(friendlessArrows(shapes, bindings)).toEqual([]);
  });

  it("flags an arrow bound only at its start", () => {
    const shapes = [box("shape:a"), arrow("shape:x")];
    const lints = friendlessArrows(shapes, [bind("shape:x", "shape:a", "start")]);
    expect(lints).toHaveLength(1);
    expect(lints[0]?.rule).toBe("friendless-arrow");
    expect(lints[0]?.shapeIds).toEqual(["shape:x"]);
    expect(lints[0]?.message).toBe("arrow shape:x has no binding at its end");
  });

  it("flags an arrow bound only at its end", () => {
    const lints = friendlessArrows([arrow("shape:x")], [bind("shape:x", "shape:b", "end")]);
    expect(lints[0]?.message).toBe("arrow shape:x has no binding at its start");
  });

  it("flags an arrow with no bindings at all, naming both ends", () => {
    const lints = friendlessArrows([arrow("shape:x")], []);
    expect(lints).toHaveLength(1);
    expect(lints[0]?.message).toBe("arrow shape:x has no binding at its start or end");
  });

  it("stays quiet when the shape opts out of this rule", () => {
    const shapes = [arrow("shape:x", { lintIgnore: ["friendless-arrow"] })];
    expect(friendlessArrows(shapes, [])).toEqual([]);
  });

  it("still fires when the opt-out names a different rule", () => {
    const shapes = [arrow("shape:x", { lintIgnore: ["overlapping-text"] })];
    expect(friendlessArrows(shapes, [])).toHaveLength(1);
  });

  it("ignores bindings that belong to another arrow", () => {
    const shapes = [arrow("shape:x"), arrow("shape:y")];
    const bindings = [bind("shape:y", "shape:a", "start"), bind("shape:y", "shape:b", "end")];
    const lints = friendlessArrows(shapes, bindings);
    expect(lints.map((l) => l.shapeIds[0])).toEqual(["shape:x"]);
  });

  it("ignores non-arrow shapes and non-arrow bindings", () => {
    const shapes = [box("shape:a"), box("shape:b")];
    const bindings: LintBinding[] = [
      { type: "layout", fromId: "shape:a", toId: "shape:b", props: { terminal: "start" } },
    ];
    expect(friendlessArrows(shapes, bindings)).toEqual([]);
  });

  it("reports in the order the shapes were given", () => {
    const shapes = [arrow("shape:1"), arrow("shape:2"), arrow("shape:3")];
    expect(friendlessArrows(shapes, []).map((l) => l.shapeIds[0])).toEqual([
      "shape:1",
      "shape:2",
      "shape:3",
    ]);
  });
});

describe("isLintIgnored", () => {
  it("honours a bare true as mute everything", () => {
    expect(isLintIgnored({ id: "shape:x", type: "arrow", meta: { lintIgnore: true } }, "any")).toBe(
      true,
    );
  });

  it("treats a missing or malformed meta as not ignored", () => {
    expect(isLintIgnored({ id: "shape:x", type: "arrow" }, "friendless-arrow")).toBe(false);
    expect(
      isLintIgnored({ id: "shape:x", type: "arrow", meta: { lintIgnore: "yes" } }, "friendless-arrow"),
    ).toBe(false);
  });
});

describe("runLints", () => {
  it("returns the union of every rule", () => {
    expect(runLints([arrow("shape:x")], [])).toEqual(friendlessArrows([arrow("shape:x")], []));
  });

  it("is empty for a clean page", () => {
    expect(runLints([box("shape:a")], [])).toEqual([]);
  });
});

/** A geo shape with page bounds, and a label box filling it with a margin. */
const geo = (
  id: string,
  bounds: { x: number; y: number; w: number; h: number },
  extra: Partial<LintShape> = {},
): LintShape => ({
  id,
  type: "geo",
  geo: "rectangle",
  fill: "none",
  text: "label",
  bounds,
  labelBounds: { x: bounds.x + 10, y: bounds.y + 10, w: bounds.w - 20, h: bounds.h - 20 },
  ...extra,
});

describe("intersectionArea", () => {
  it("is zero for boxes that miss each other", () => {
    expect(
      intersectionArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 }),
    ).toBe(0);
  });

  it("is zero for boxes that only touch edges", () => {
    expect(
      intersectionArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }),
    ).toBe(0);
  });

  it("is the shared rectangle for boxes that cross", () => {
    expect(
      intersectionArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }),
    ).toBe(25);
  });
});

describe("isContainer", () => {
  it("is true only for meta.container === true", () => {
    expect(isContainer({ id: "a", type: "geo", meta: { container: true } })).toBe(true);
    expect(isContainer({ id: "a", type: "geo", meta: { container: "yes" } })).toBe(false);
    expect(isContainer({ id: "a", type: "geo" })).toBe(false);
  });
});

describe("overlapping-text", () => {
  it("passes labels that sit apart", () => {
    const shapes = [
      geo("shape:a", { x: 0, y: 0, w: 100, h: 60 }),
      geo("shape:b", { x: 200, y: 0, w: 100, h: 60 }),
    ];
    expect(overlappingText(shapes)).toEqual([]);
  });

  it("flags labels that cross", () => {
    const shapes = [
      geo("shape:a", { x: 0, y: 0, w: 100, h: 60 }),
      geo("shape:b", { x: 40, y: 10, w: 100, h: 60 }),
    ];
    const lints = overlappingText(shapes);
    expect(lints).toHaveLength(1);
    expect(lints[0]?.rule).toBe("overlapping-text");
    expect(lints[0]?.shapeIds).toEqual(["shape:a", "shape:b"]);
  });

  it("ignores a shape with no text, even when its label box overlaps", () => {
    const shapes = [
      geo("shape:a", { x: 0, y: 0, w: 100, h: 60 }),
      geo("shape:b", { x: 40, y: 10, w: 100, h: 60 }, { text: "" }),
    ];
    expect(overlappingText(shapes)).toEqual([]);
  });

  it("respects lintIgnore on either side", () => {
    const shapes = [
      geo("shape:a", { x: 0, y: 0, w: 100, h: 60 }, { meta: { lintIgnore: ["overlapping-text"] } }),
      geo("shape:b", { x: 40, y: 10, w: 100, h: 60 }),
    ];
    expect(overlappingText(shapes)).toEqual([]);
  });
});

describe("overlapping-shapes", () => {
  it("passes shapes that merely graze each other", () => {
    // 100 x 100 boxes sharing a 5 x 100 strip: 5 percent of the smaller one.
    const shapes = [
      geo("shape:a", { x: 0, y: 0, w: 100, h: 100 }),
      geo("shape:b", { x: 95, y: 0, w: 100, h: 100 }),
    ];
    expect(overlappingShapes(shapes)).toEqual([]);
  });

  it("flags shapes that cover more than a tenth of the smaller one", () => {
    const shapes = [
      geo("shape:a", { x: 0, y: 0, w: 100, h: 100 }),
      geo("shape:b", { x: 50, y: 0, w: 100, h: 100 }),
    ];
    const lints = overlappingShapes(shapes);
    expect(lints).toHaveLength(1);
    expect(lints[0]?.shapeIds).toEqual(["shape:a", "shape:b"]);
    expect(lints[0]?.message).toContain("50 percent");
  });

  it("skips a container on either side of the pair", () => {
    const shapes = [
      geo("shape:box", { x: 0, y: 0, w: 100, h: 100 }),
      geo("shape:group", { x: -40, y: -40, w: 180, h: 180 }, { meta: { container: true } }),
    ];
    expect(overlappingShapes(shapes)).toEqual([]);
  });

  it("skips arrows, which cross boxes by design", () => {
    const shapes: LintShape[] = [
      geo("shape:box", { x: 0, y: 0, w: 100, h: 100 }),
      { id: "shape:x", type: "arrow", bounds: { x: 10, y: 10, w: 80, h: 80 } },
    ];
    expect(overlappingShapes(shapes)).toEqual([]);
  });

  it("respects lintIgnore", () => {
    const shapes = [
      geo("shape:a", { x: 0, y: 0, w: 100, h: 100 }, {
        meta: { lintIgnore: ["overlapping-shapes"] },
      }),
      geo("shape:b", { x: 50, y: 0, w: 100, h: 100 }),
    ];
    expect(overlappingShapes(shapes)).toEqual([]);
  });
});

describe("off-page", () => {
  it("passes a shape inside the limit", () => {
    const shapes = [geo("shape:a", { x: OFF_PAGE_LIMIT - 200, y: 0, w: 100, h: 60 })];
    expect(offPage(shapes)).toEqual([]);
  });

  it("flags a shape whose far edge crosses the limit", () => {
    const shapes = [geo("shape:a", { x: OFF_PAGE_LIMIT - 10, y: 0, w: 100, h: 60 })];
    expect(offPage(shapes)).toHaveLength(1);
  });

  it("flags a shape far into the negatives", () => {
    const shapes = [geo("shape:a", { x: -OFF_PAGE_LIMIT - 1, y: 0, w: 100, h: 60 })];
    const lints = offPage(shapes);
    expect(lints).toHaveLength(1);
    expect(lints[0]?.rule).toBe("off-page");
  });

  it("respects lintIgnore", () => {
    const shapes = [
      geo("shape:a", { x: 50000, y: 0, w: 100, h: 60 }, { meta: { lintIgnore: ["off-page"] } }),
    ];
    expect(offPage(shapes)).toEqual([]);
  });
});

describe("empty-label", () => {
  it("flags an empty unfilled geo shape", () => {
    const shapes = [geo("shape:a", { x: 0, y: 0, w: 100, h: 60 }, { text: "" })];
    const lints = emptyLabels(shapes);
    expect(lints).toHaveLength(1);
    expect(lints[0]?.rule).toBe("empty-label");
  });

  it("passes an empty geo shape that is filled", () => {
    const shapes = [
      geo("shape:a", { x: 0, y: 0, w: 100, h: 60 }, { text: "", fill: "solid" }),
    ];
    expect(emptyLabels(shapes)).toEqual([]);
  });

  it("passes a labelled geo shape", () => {
    expect(emptyLabels([geo("shape:a", { x: 0, y: 0, w: 100, h: 60 })])).toEqual([]);
  });

  it("exempts a container", () => {
    const shapes = [
      geo("shape:g", { x: 0, y: 0, w: 100, h: 60 }, { text: "", meta: { container: true } }),
    ];
    expect(emptyLabels(shapes)).toEqual([]);
  });

  it("respects lintIgnore", () => {
    const shapes = [
      geo("shape:a", { x: 0, y: 0, w: 100, h: 60 }, {
        text: "",
        meta: { lintIgnore: ["empty-label"] },
      }),
    ];
    expect(emptyLabels(shapes)).toEqual([]);
  });
});

describe("unreadable-label", () => {
  it("passes a label that fits", () => {
    const shapes = [geo("shape:a", { x: 0, y: 0, w: 200, h: 60 }, { labelWidth: 140 })];
    expect(unreadableLabels(shapes)).toEqual([]);
  });

  it("flags a label wider than its shape", () => {
    const shapes = [geo("shape:a", { x: 0, y: 0, w: 90, h: 60 }, { labelWidth: 370 })];
    const lints = unreadableLabels(shapes);
    expect(lints).toHaveLength(1);
    expect(lints[0]?.message).toContain("370");
    expect(lints[0]?.message).toContain("90");
  });

  it("exempts a shape that grows to fit its text", () => {
    const shapes = [
      geo("shape:a", { x: 0, y: 0, w: 90, h: 60 }, { labelWidth: 370, growsToFit: true }),
    ];
    expect(unreadableLabels(shapes)).toEqual([]);
  });

  it("says nothing when nobody measured the label", () => {
    const shapes = [geo("shape:a", { x: 0, y: 0, w: 90, h: 60 })];
    expect(unreadableLabels(shapes)).toEqual([]);
  });

  it("respects lintIgnore", () => {
    const shapes = [
      geo("shape:a", { x: 0, y: 0, w: 90, h: 60 }, {
        labelWidth: 370,
        meta: { lintIgnore: ["unreadable-label"] },
      }),
    ];
    expect(unreadableLabels(shapes)).toEqual([]);
  });
});

describe("runLints over every rule", () => {
  it("finds nothing on a clean page", () => {
    const shapes: LintShape[] = [
      geo("shape:a", { x: 0, y: 0, w: 160, h: 64 }, { labelWidth: 100 }),
      geo("shape:b", { x: 400, y: 0, w: 160, h: 64 }, { labelWidth: 100 }),
      { id: "shape:x", type: "arrow", bounds: { x: 160, y: 20, w: 240, h: 4 } },
    ];
    const bindings = [
      bind("shape:x", "shape:a", "start"),
      bind("shape:x", "shape:b", "end"),
    ];
    expect(runLints(shapes, bindings)).toEqual([]);
  });

  it("reports each rule in LINT_RULES order", () => {
    const shapes: LintShape[] = [
      arrow("shape:loose"),
      geo("shape:a", { x: 0, y: 0, w: 100, h: 100 }, { labelWidth: 400 }),
      geo("shape:b", { x: 50, y: 0, w: 100, h: 100 }),
      geo("shape:blank", { x: 900, y: 0, w: 100, h: 60 }, { text: "" }),
      geo("shape:far", { x: 99999, y: 0, w: 100, h: 60 }),
    ];
    const seen = runLints(shapes, []).map((lint) => lint.rule);
    const order = seen.map((rule) => LINT_RULES.indexOf(rule as (typeof LINT_RULES)[number]));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(seen)).toEqual(
      new Set([
        "friendless-arrow",
        "overlapping-text",
        "overlapping-shapes",
        "off-page",
        "empty-label",
        "unreadable-label",
      ]),
    );
  });
});
