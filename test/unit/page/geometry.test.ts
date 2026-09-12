/**
 * The placement and anchor arithmetic the helpers are built on.
 *
 * Pure by design so these cases can be checked without a browser: which sides
 * of two boxes face each other, where `after` and `below` land a shape, and
 * when a screenshot's pixel ratio has to come down.
 */

import { describe, expect, it } from "vitest";

import {
  anchorForSide,
  autoAnchors,
  clampPixelRatio,
  facingSides,
  isSide,
  placeAfter,
  placeBelow,
  resolveAnchor,
  unionRects,
  type Rect,
} from "../../../src/page/helpers/geometry.js";

const rect = (x: number, y: number, w = 180, h = 64): Rect => ({ x, y, w, h });

describe("anchors", () => {
  it("puts a side anchor at that side's midpoint", () => {
    expect(anchorForSide("top")).toEqual({ x: 0.5, y: 0 });
    expect(anchorForSide("right")).toEqual({ x: 1, y: 0.5 });
    expect(anchorForSide("bottom")).toEqual({ x: 0.5, y: 1 });
    expect(anchorForSide("left")).toEqual({ x: 0, y: 0.5 });
  });

  it("accepts a side name, a point, or nothing", () => {
    expect(resolveAnchor("left")).toEqual({ x: 0, y: 0.5 });
    expect(resolveAnchor({ x: 0.25, y: 0.75 })).toEqual({ x: 0.25, y: 0.75 });
    expect(resolveAnchor(undefined)).toBeUndefined();
  });

  it("clamps a point outside 0..1 rather than rejecting it", () => {
    expect(resolveAnchor({ x: 1.4, y: -0.2 })).toEqual({ x: 1, y: 0 });
    expect(resolveAnchor({ x: NaN, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it("knows a side name from anything else", () => {
    expect(isSide("top")).toBe(true);
    expect(isSide("middle")).toBe(false);
    expect(isSide({ x: 0, y: 0 })).toBe(false);
  });
});

describe("facingSides", () => {
  it("connects right to left for a box on the right", () => {
    expect(facingSides(rect(0, 0), rect(300, 0))).toEqual({ start: "right", end: "left" });
  });

  it("connects left to right for a box on the left", () => {
    expect(facingSides(rect(300, 0), rect(0, 0))).toEqual({ start: "left", end: "right" });
  });

  it("connects bottom to top for a box below", () => {
    expect(facingSides(rect(0, 0), rect(0, 200))).toEqual({ start: "bottom", end: "top" });
  });

  it("connects top to bottom for a box above", () => {
    expect(facingSides(rect(0, 200), rect(0, 0))).toEqual({ start: "top", end: "bottom" });
  });

  it("measures the gap, not the centre offset", () => {
    // Stacked vertically with a sideways nudge: the centres are further apart
    // horizontally (240) than vertically (164), but the boxes only clear each
    // other on the vertical axis, so the connection is bottom to top.
    expect(facingSides(rect(0, 0), rect(240, 164))).toEqual({ start: "bottom", end: "top" });
  });

  it("breaks a tie towards the horizontal", () => {
    const square = (x: number, y: number): Rect => ({ x, y, w: 100, h: 100 });
    expect(facingSides(square(0, 0), square(200, 200))).toEqual({ start: "right", end: "left" });
  });
});

describe("placement", () => {
  it("puts `after` to the right, sharing the top edge", () => {
    expect(placeAfter(rect(60, 60), 80)).toEqual({ x: 320, y: 60 });
  });

  it("puts `below` underneath, sharing the left edge", () => {
    expect(placeBelow(rect(60, 60), 90)).toEqual({ x: 60, y: 214 });
  });
});

describe("unionRects", () => {
  it("covers every box", () => {
    expect(unionRects([rect(0, 0, 100, 100), rect(200, 50, 100, 100)])).toEqual({
      x: 0,
      y: 0,
      w: 300,
      h: 150,
    });
  });

  it("is null for nothing", () => {
    expect(unionRects([])).toBeNull();
  });
});

describe("clampPixelRatio", () => {
  it("leaves a small canvas alone", () => {
    expect(clampPixelRatio(2, 800, 4096)).toBe(2);
  });

  it("reduces the ratio rather than cropping a wide canvas", () => {
    expect(clampPixelRatio(2, 4000, 4096)).toBeCloseTo(1.024, 3);
  });

  it("never drops below a quarter", () => {
    expect(clampPixelRatio(2, 1_000_000, 4096)).toBe(0.25);
  });

  it("ignores a degenerate edge", () => {
    expect(clampPixelRatio(2, 0, 4096)).toBe(2);
  });
});


describe("autoAnchors", () => {
  it("runs a straight line between two boxes of the same height", () => {
    expect(autoAnchors(rect(0, 0), rect(300, 0))).toEqual({
      start: { x: 1, y: 0.5 },
      end: { x: 0, y: 0.5 },
    });
  });

  it("keeps the line straight when one box grew a second line of label", () => {
    // 64 tall against 92 tall, tops aligned: the overlap band is the shorter
    // box, so the line runs down its middle and enters the taller box high.
    const { start, end } = autoAnchors(rect(0, 0, 170, 64), rect(300, 0, 190, 92));
    expect(start.y).toBeCloseTo(0.5);
    expect(0 + 64 * start.y).toBeCloseTo(0 + 92 * end.y);
  });

  it("does the same on the vertical axis", () => {
    const { start, end } = autoAnchors(rect(0, 0, 190, 64), rect(40, 200, 110, 64));
    expect(start.y).toBe(1);
    expect(end.y).toBe(0);
    expect(0 + 190 * start.x).toBeCloseTo(40 + 110 * end.x);
  });

  it("falls back to the side midpoint when the boxes share no band", () => {
    expect(autoAnchors(rect(0, 0, 100, 64), rect(300, 400, 100, 64))).toEqual({
      start: { x: 0.5, y: 1 },
      end: { x: 0.5, y: 0 },
    });
  });
});
