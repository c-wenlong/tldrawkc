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
  friendlessArrows,
  isLintIgnored,
  runLints,
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
