/**
 * The arrow id scheme.
 *
 * The id is derived from the pair it joins, which is what makes a second run
 * of the same snippet update one arrow instead of stacking two. That rule only
 * holds if the derivation is unambiguous, which is what these cases check.
 */

import { describe, expect, it } from "vitest";

import { connectionKey } from "../../../src/page/helpers/keys.js";

describe("connectionKey", () => {
  it("reads as the pair it joins", () => {
    expect(connectionKey("agent", "page")).toBe("arrow:agent->page");
  });

  it("is stable, so re-running a snippet updates one arrow", () => {
    expect(connectionKey("agent", "page")).toBe(connectionKey("agent", "page"));
  });

  it("is directional", () => {
    expect(connectionKey("agent", "page")).not.toBe(connectionKey("page", "agent"));
  });

  it("accepts a full shape id and strips the prefix", () => {
    expect(connectionKey("shape:agent", "shape:page")).toBe("arrow:agent->page");
  });

  it("refuses a key that contains the separator, rather than colliding", () => {
    // `a->b` to `c` and `a` to `b->c` would both derive `arrow:a->b->c`, and
    // the second call would rebind the first call's arrow.
    expect(() => connectionKey("a->b", "c")).toThrow(/separator/);
    expect(() => connectionKey("a", "b->c")).toThrow(/separator/);
  });

  it("cannot be confused by keys that contain dashes", () => {
    // `a-b` to `c` and `a` to `b-c` would collide under a dash separator.
    expect(connectionKey("a-b", "c")).not.toBe(connectionKey("a", "b-c"));
  });
});
