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
  ARROW_CROSSING_TOLERANCE,
  arrowCrossesShape,
  distanceToPolygon,
  emptyLabels,
  friendlessArrows,
  insetRect,
  intersectionArea,
  isContainer,
  isLintIgnored,
  LINT_RULES,
  OFF_PAGE_LIMIT,
  offPage,
  overlappingShapes,
  overlappingText,
  isConvexPolygon,
  pointInPolygon,
  runLints,
  segmentCrossesConvex,
  segmentCrossesRect,
  segmentReachesInside,
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

// ---------------------------------------------------------------------------
// arrow-crosses-shape
// ---------------------------------------------------------------------------

/** A geo shape with page bounds, for the crossing rule to run into. */
const obstacle = (
  id: string,
  bounds: { x: number; y: number; w: number; h: number },
  meta?: Record<string, unknown>,
): LintShape => ({ id, type: "geo", bounds, ...(meta ? { meta } : {}) });

/** The four corners of a rect, the outline tldraw reports for a rectangle. */
const corners = (b: { x: number; y: number; w: number; h: number }) => [
  { x: b.x, y: b.y },
  { x: b.x + b.w, y: b.y },
  { x: b.x + b.w, y: b.y + b.h },
  { x: b.x, y: b.y + b.h },
];

/** A diamond: the four edge midpoints of its page box, as tldraw draws it. */
const diamond = (id: string, b: { x: number; y: number; w: number; h: number }): LintShape => ({
  id,
  type: "geo",
  geo: "diamond",
  bounds: b,
  outline: [
    { x: b.x + b.w / 2, y: b.y },
    { x: b.x + b.w, y: b.y + b.h / 2 },
    { x: b.x + b.w / 2, y: b.y + b.h },
    { x: b.x, y: b.y + b.h / 2 },
  ],
});

/** An arrow carrying a rendered path, in page coordinates. */
const routed = (
  id: string,
  points: { x: number; y: number }[],
  extra: Partial<LintShape> = {},
): LintShape => ({ id, type: "arrow", points, ...extra });

/** `a` on the left, `b` on the right, and an arrow bound between them. */
const LEFT = obstacle("shape:a", { x: 0, y: 0, w: 100, h: 60 });
const RIGHT = obstacle("shape:b", { x: 400, y: 0, w: 100, h: 60 });
const BOUND = [bind("shape:x", "shape:a", "start"), bind("shape:x", "shape:b", "end")];

describe("arrow-crosses-shape", () => {
  it("passes an arrow that runs between its two shapes and touches nothing else", () => {
    const shapes = [
      LEFT,
      RIGHT,
      obstacle("shape:aside", { x: 180, y: 200, w: 100, h: 60 }),
      routed("shape:x", [
        { x: 100, y: 30 },
        { x: 400, y: 30 },
      ]),
    ];
    expect(arrowCrossesShape(shapes, BOUND)).toEqual([]);
  });

  it("flags an elbow route whose leg cuts through a third box", () => {
    const shapes = [
      LEFT,
      RIGHT,
      obstacle("shape:mid", { x: 150, y: 170, w: 100, h: 60 }),
      routed("shape:x", [
        { x: 50, y: 60 },
        { x: 50, y: 200 },
        { x: 450, y: 200 },
      ]),
    ];
    const lints = arrowCrossesShape(shapes, BOUND);
    expect(lints).toHaveLength(1);
    expect(lints[0]?.rule).toBe("arrow-crosses-shape");
    expect(lints[0]?.shapeIds).toEqual(["shape:x", "shape:mid"]);
    expect(lints[0]?.message).toBe(
      "arrow shape:x passes through shape:mid, which is neither shape it connects",
    );
  });

  it("flags an arc, which arrives already sampled into a polyline", () => {
    // A bend to the right of a straight run up the page, the shape a mermaid
    // back edge takes, with a box parked under its apex.
    const arc = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
      x: 200 + Math.sin(t * Math.PI) * 160,
      y: 400 - t * 400,
    }));
    const shapes = [
      LEFT,
      RIGHT,
      obstacle("shape:apex", { x: 320, y: 170, w: 90, h: 60 }),
      routed("shape:x", arc),
    ];
    const lints = arrowCrossesShape(shapes, BOUND);
    expect(lints.map((lint) => lint.shapeIds[1])).toEqual(["shape:apex"]);
  });

  it("stays quiet when the arrow only grazes a corner, and fires once it is properly inside", () => {
    // The arrow runs along y = 30. A box whose top edge is at y = 28 is two
    // units deep, which is ink rather than a crossing; at y = 24 it is six,
    // which is past the tolerance.
    const grazed = [
      LEFT,
      RIGHT,
      obstacle("shape:near", { x: 180, y: 30 - (ARROW_CROSSING_TOLERANCE - 2), w: 100, h: 60 }),
      routed("shape:x", [
        { x: 100, y: 30 },
        { x: 400, y: 30 },
      ]),
    ];
    expect(arrowCrossesShape(grazed, BOUND)).toEqual([]);

    const crossed = [
      LEFT,
      RIGHT,
      obstacle("shape:near", { x: 180, y: 30 - (ARROW_CROSSING_TOLERANCE + 2), w: 100, h: 60 }),
      routed("shape:x", [
        { x: 100, y: 30 },
        { x: 400, y: 30 },
      ]),
    ];
    expect(arrowCrossesShape(crossed, BOUND)).toHaveLength(1);
  });

  it("exempts a container, because crossing into a group is the point of a group", () => {
    const shapes = [
      LEFT,
      RIGHT,
      obstacle("shape:group", { x: 140, y: -40, w: 200, h: 140 }, { container: true }),
      routed("shape:x", [
        { x: 100, y: 30 },
        { x: 400, y: 30 },
      ]),
    ];
    expect(arrowCrossesShape(shapes, BOUND)).toEqual([]);
  });

  it("exempts the two shapes the arrow is bound to, and the parent it lives in", () => {
    // The path runs the whole width of both endpoints and of the frame the
    // arrow hangs off, and none of the three is a finding.
    const shapes = [
      LEFT,
      RIGHT,
      obstacle("shape:frame", { x: -100, y: -100, w: 800, h: 400 }),
      routed(
        "shape:x",
        [
          { x: 10, y: 30 },
          { x: 490, y: 30 },
        ],
        { parentId: "shape:frame" },
      ),
    ];
    expect(arrowCrossesShape(shapes, BOUND)).toEqual([]);
  });

  it("honours lintIgnore on the arrow and on the shape it crosses", () => {
    const mid = { x: 180, y: 0, w: 100, h: 60 };
    const path = [
      { x: 100, y: 30 },
      { x: 400, y: 30 },
    ];
    const mutedArrow = [
      LEFT,
      RIGHT,
      obstacle("shape:mid", mid),
      routed("shape:x", path, { meta: { lintIgnore: ["arrow-crosses-shape"] } }),
    ];
    expect(arrowCrossesShape(mutedArrow, BOUND)).toEqual([]);

    const mutedShape = [
      LEFT,
      RIGHT,
      obstacle("shape:mid", mid, { lintIgnore: ["arrow-crosses-shape"] }),
      routed("shape:x", path),
    ];
    expect(arrowCrossesShape(mutedShape, BOUND)).toEqual([]);

    const mutedElsewhere = [
      LEFT,
      RIGHT,
      obstacle("shape:mid", mid, { lintIgnore: ["overlapping-shapes"] }),
      routed("shape:x", path),
    ];
    expect(arrowCrossesShape(mutedElsewhere, BOUND)).toHaveLength(1);
  });

  it("skips an arrow with no path, and a shape kind with no outline", () => {
    const noPath = [LEFT, RIGHT, obstacle("shape:mid", { x: 180, y: 0, w: 100, h: 60 })];
    expect(arrowCrossesShape([...noPath, { id: "shape:x", type: "arrow" }], BOUND)).toEqual([]);

    const label: LintShape = {
      id: "shape:label",
      type: "text",
      bounds: { x: 180, y: 0, w: 100, h: 60 },
    };
    const shapes = [
      LEFT,
      RIGHT,
      label,
      routed("shape:x", [
        { x: 100, y: 30 },
        { x: 400, y: 30 },
      ]),
    ];
    expect(arrowCrossesShape(shapes, BOUND)).toEqual([]);
  });

  it("lets an arrow through the empty corner of a diamond's page box", () => {
    // The diamond spans x 180..280, y 0..60, so its page box's top-left corner
    // is empty. A line clipping that corner crosses the box and misses the
    // shape, which is the whole reason the rule reads the outline.
    const shapes = [
      LEFT,
      RIGHT,
      diamond("shape:choice", { x: 180, y: 0, w: 100, h: 60 }),
      routed("shape:x", [
        { x: 100, y: 2 },
        { x: 400, y: 2 },
      ]),
    ];
    expect(arrowCrossesShape(shapes, BOUND)).toEqual([]);
  });

  it("still flags an arrow through the middle of the same diamond", () => {
    const shapes = [
      LEFT,
      RIGHT,
      diamond("shape:choice", { x: 180, y: 0, w: 100, h: 60 }),
      routed("shape:x", [
        { x: 100, y: 30 },
        { x: 400, y: 30 },
      ]),
    ];
    expect(arrowCrossesShape(shapes, BOUND).map((lint) => lint.shapeIds[1])).toEqual([
      "shape:choice",
    ]);
  });

  it("agrees with the page box when the outline is the page box", () => {
    const bounds = { x: 180, y: 0, w: 100, h: 60 };
    const path = [
      { x: 100, y: 2 },
      { x: 400, y: 2 },
    ];
    // The same line that misses the diamond crosses a rectangle of the same
    // size, two units in, which is inside the tolerance, so neither fires.
    const shallow: LintShape[] = [
      LEFT,
      RIGHT,
      { id: "shape:box", type: "geo", bounds, outline: corners(bounds) },
      routed("shape:x", path),
    ];
    expect(arrowCrossesShape(shallow, BOUND)).toEqual([]);

    const deep: LintShape[] = [
      LEFT,
      RIGHT,
      { id: "shape:box", type: "geo", bounds, outline: corners(bounds) },
      routed("shape:x", [
        { x: 100, y: 30 },
        { x: 400, y: 30 },
      ]),
    ];
    expect(arrowCrossesShape(deep, BOUND)).toHaveLength(1);
  });

  it("lets an arrow through the notch of a concave shape", () => {
    const star: LintShape = {
      id: "shape:star",
      type: "geo",
      geo: "star",
      bounds: { x: 180, y: 0, w: 100, h: 100 },
      outline: [
        { x: 230, y: 0 },
        { x: 240, y: 40 },
        { x: 280, y: 50 },
        { x: 240, y: 60 },
        { x: 230, y: 100 },
        { x: 220, y: 60 },
        { x: 180, y: 50 },
        { x: 220, y: 40 },
      ],
    };
    const through = [
      { x: 100, y: 10 },
      { x: 400, y: 10 },
    ];
    expect(arrowCrossesShape([LEFT, RIGHT, star, routed("shape:x", through)], BOUND)).toEqual([]);

    const middle = [
      { x: 100, y: 50 },
      { x: 400, y: 50 },
    ];
    expect(
      arrowCrossesShape([LEFT, RIGHT, star, routed("shape:x", middle)], BOUND),
    ).toHaveLength(1);
  });

  it("flags a note, which is an outline a line can hide behind", () => {
    const note: LintShape = {
      id: "shape:aside",
      type: "note",
      bounds: { x: 180, y: 0, w: 100, h: 60 },
    };
    const shapes = [
      LEFT,
      RIGHT,
      note,
      routed("shape:x", [
        { x: 100, y: 30 },
        { x: 400, y: 30 },
      ]),
    ];
    expect(arrowCrossesShape(shapes, BOUND).map((lint) => lint.shapeIds[1])).toEqual([
      "shape:aside",
    ]);
  });
});

describe("segmentCrossesRect", () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };

  it("is true for a segment straight through, and for one wholly inside", () => {
    expect(segmentCrossesRect({ x: -50, y: 50 }, { x: 150, y: 50 }, rect)).toBe(true);
    expect(segmentCrossesRect({ x: 20, y: 20 }, { x: 80, y: 80 }, rect)).toBe(true);
  });

  it("is false for a segment that misses, stops short, or only runs along an edge", () => {
    expect(segmentCrossesRect({ x: -50, y: 150 }, { x: 150, y: 150 }, rect)).toBe(false);
    expect(segmentCrossesRect({ x: -50, y: 50 }, { x: -10, y: 50 }, rect)).toBe(false);
    expect(segmentCrossesRect({ x: -50, y: 0 }, { x: 150, y: 0 }, rect)).toBe(false);
    expect(segmentCrossesRect({ x: -50, y: -50 }, { x: 0, y: 0 }, rect)).toBe(false);
  });
});

describe("isConvexPolygon", () => {
  it("says yes to a rectangle, a diamond and an outline with a collinear point", () => {
    expect(
      isConvexPolygon([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ]),
    ).toBe(true);
    expect(
      isConvexPolygon([
        { x: 5, y: 0 },
        { x: 10, y: 5 },
        { x: 5, y: 10 },
        { x: 0, y: 5 },
      ]),
    ).toBe(true);
    expect(
      isConvexPolygon([
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ]),
    ).toBe(true);
  });

  it("says no to an arrowhead notch and to anything with no area", () => {
    expect(
      isConvexPolygon([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
        { x: 10, y: 30 },
      ]),
    ).toBe(false);
    expect(isConvexPolygon([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe(false);
    expect(
      isConvexPolygon([
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe(false);
  });
});

describe("segmentCrossesConvex", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it("matches segmentCrossesRect on an axis-aligned box at the same inset", () => {
    const rect = { x: 0, y: 0, w: 100, h: 100 };
    const cases: [{ x: number; y: number }, { x: number; y: number }][] = [
      [{ x: -50, y: 50 }, { x: 150, y: 50 }],
      [{ x: -50, y: 2 }, { x: 150, y: 2 }],
      [{ x: -50, y: 150 }, { x: 150, y: 150 }],
      [{ x: 20, y: 20 }, { x: 80, y: 80 }],
      [{ x: -50, y: 4 }, { x: 150, y: 4 }],
    ];
    for (const [a, b] of cases) {
      expect(
        segmentCrossesConvex(a, b, square, 4),
        `${JSON.stringify(a)} to ${JSON.stringify(b)}`,
      ).toBe(segmentCrossesRect(a, b, insetRect(rect, 4) ?? rect));
    }
  });

  it("reads the winding order from the shape rather than assuming one", () => {
    const clockwise = [...square].reverse();
    expect(segmentCrossesConvex({ x: -50, y: 50 }, { x: 150, y: 50 }, clockwise, 4)).toBe(true);
    expect(segmentCrossesConvex({ x: -50, y: 150 }, { x: 150, y: 150 }, clockwise, 4)).toBe(false);
  });

  it("is false for a polygon with no area to speak of", () => {
    expect(segmentCrossesConvex({ x: 0, y: 0 }, { x: 10, y: 0 }, square.slice(0, 2), 4)).toBe(
      false,
    );
    expect(segmentCrossesConvex({ x: 50, y: 50 }, { x: 60, y: 50 }, square, 60)).toBe(false);
  });
});

describe("pointInPolygon and distanceToPolygon", () => {
  // A four-pointed star: the notches between the arms are empty space that a
  // convex reading would fill in.
  const star = [
    { x: 50, y: 0 },
    { x: 60, y: 40 },
    { x: 100, y: 50 },
    { x: 60, y: 60 },
    { x: 50, y: 100 },
    { x: 40, y: 60 },
    { x: 0, y: 50 },
    { x: 40, y: 40 },
  ];

  it("puts the centre inside and a notch outside", () => {
    expect(pointInPolygon({ x: 50, y: 50 }, star)).toBe(true);
    expect(pointInPolygon({ x: 12, y: 12 }, star)).toBe(false);
  });

  it("measures the distance to the nearest edge, inside or out", () => {
    expect(distanceToPolygon({ x: 50, y: 50 }, star)).toBeGreaterThan(4);
    expect(distanceToPolygon({ x: 50, y: 1 }, star)).toBeLessThan(2);
  });
});

describe("segmentReachesInside", () => {
  const star = [
    { x: 50, y: 0 },
    { x: 60, y: 40 },
    { x: 100, y: 50 },
    { x: 60, y: 60 },
    { x: 50, y: 100 },
    { x: 40, y: 60 },
    { x: 0, y: 50 },
    { x: 40, y: 40 },
  ];

  it("stays quiet for a line through a notch, and for one through a thin arm", () => {
    // Through the notch between two arms, which a convex reading of the shape
    // would have filled in.
    expect(segmentReachesInside({ x: -20, y: 10 }, { x: 40, y: 10 }, star, 4)).toBe(false);
    // Across the top arm, which is only about five units wide at that height,
    // so the line clips it without ever being four units inside anything.
    expect(segmentReachesInside({ x: -20, y: 10 }, { x: 120, y: 10 }, star, 4)).toBe(false);
  });

  it("fires for a line through the middle of the same star", () => {
    expect(segmentReachesInside({ x: -20, y: 50 }, { x: 120, y: 50 }, star, 4)).toBe(true);
  });

  it("is false for a polygon with no area to speak of", () => {
    expect(segmentReachesInside({ x: 0, y: 0 }, { x: 10, y: 0 }, star.slice(0, 2), 4)).toBe(false);
  });
});

describe("insetRect", () => {
  it("shrinks on every side", () => {
    expect(insetRect({ x: 10, y: 10, w: 100, h: 80 }, 4)).toEqual({
      x: 14,
      y: 14,
      w: 92,
      h: 72,
    });
  });

  it("gives back nothing when there is no interior left", () => {
    expect(insetRect({ x: 0, y: 0, w: 8, h: 80 }, 4)).toBeNull();
    expect(insetRect({ x: 0, y: 0, w: 4, h: 80 }, 4)).toBeNull();
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

  it("measures against the shape's own width, not its rotated page box", () => {
    // A wide, short box turned a quarter turn still has the label room it
    // always had; its page box is only as wide as its height. Judging by the
    // page box would flag a label that fits perfectly.
    const shapes = [
      geo("shape:a", { x: 0, y: 0, w: 60, h: 200 }, { labelWidth: 180, shapeWidth: 200 }),
    ];
    expect(unreadableLabels(shapes)).toEqual([]);
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
