/**
 * `parseMermaid`, the pure half of the mermaid importer.
 *
 * The point of the split is that this runs in vitest's node environment with no
 * browser and no editor, so the parser and the layout can be pinned down here
 * and `applyPlan` only has to be trusted with drawing.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Direction, Plan, PlanNode } from "../../../src/page/helpers/mermaid.js";
import { parseMermaid, rank, tokenize } from "../../../src/page/helpers/mermaid.js";

/** Read one `.mmd` from `test/fixtures/mermaid/`. */
function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/mermaid/${name}`, import.meta.url), "utf8");
}

/** True when the rank axis of a direction runs down the page rather than across. */
function isVertical(direction: Direction): boolean {
  return direction === "TD" || direction === "TB" || direction === "BT";
}

/**
 * Rank rows read back off the plan: nodes bucketed by their rank-axis
 * coordinate, rank 0 first. Every fixture here has one label height per rank,
 * so the coordinate is the rank. BT and RL run the first rank furthest from
 * the origin, so their buckets come back the other way round.
 */
function bands(plan: Plan): PlanNode[][] {
  const vertical = isVertical(plan.direction);
  const reversed = plan.direction === "BT" || plan.direction === "RL";
  const buckets = new Map<number, PlanNode[]>();
  for (const node of plan.nodes) {
    const key = vertical ? node.y : node.x;
    const row = buckets.get(key);
    if (row) row.push(node);
    else buckets.set(key, [node]);
  }
  const keys = [...buckets.keys()].sort((a, b) => (reversed ? b - a : a - b));
  return keys.map((key) => {
    const row = buckets.get(key) ?? [];
    return [...row].sort((a, b) => (vertical ? a.x - b.x : a.y - b.y));
  });
}

/** The ids of each band, in visual order along the slot axis. */
function bandIds(plan: Plan): string[][] {
  return bands(plan).map((row) => row.map((node) => node.id));
}

/** Every pair of nodes whose rectangles share area. */
function overlaps(plan: Plan): string[] {
  const bad: string[] = [];
  for (let i = 0; i < plan.nodes.length; i++) {
    for (let j = i + 1; j < plan.nodes.length; j++) {
      const a = plan.nodes[i];
      const b = plan.nodes[j];
      if (!a || !b) continue;
      const apart =
        a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      if (!apart) bad.push(`${a.id} overlaps ${b.id}`);
    }
  }
  return bad;
}

/** Every coordinate and size that is not a whole number. */
function fractions(plan: Plan): string[] {
  const bad: string[] = [];
  for (const node of plan.nodes) {
    for (const [key, value] of Object.entries({ x: node.x, y: node.y, w: node.w, h: node.h })) {
      if (!Number.isInteger(value)) bad.push(`${node.id}.${key} = ${String(value)}`);
    }
  }
  return bad;
}

function nodeById(plan: Plan, id: string): PlanNode {
  const found = plan.nodes.find((node) => node.id === id);
  if (!found) throw new Error(`no node ${id} in plan`);
  return found;
}

describe("simple-td", () => {
  const plan = parseMermaid(fixture("simple-td.mmd"));

  it("reads the header direction", () => {
    expect(plan.direction).toBe("TD");
  });

  it("finds three nodes and two edges", () => {
    expect(plan.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(plan.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });

  it("puts each node in its own rank, running down the page", () => {
    expect(bandIds(plan)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("starts at the default origin", () => {
    expect({ x: nodeById(plan, "a").x, y: nodeById(plan, "a").y }).toEqual({ x: 60, y: 60 });
  });

  it("separates the ranks by the default rank gap", () => {
    const a = nodeById(plan, "a");
    const b = nodeById(plan, "b");
    expect(b.y - (a.y + a.h)).toBe(120);
  });

  it("leaves nothing unsupported, nothing overlapping and nothing fractional", () => {
    expect(plan.unsupported).toEqual([]);
    expect(overlaps(plan)).toEqual([]);
    expect(fractions(plan)).toEqual([]);
  });
});

describe("node shapes", () => {
  const plan = parseMermaid(fixture("shapes.mmd"));

  it("maps each mermaid shape to a tldraw geo", () => {
    expect(plan.nodes.map((n) => [n.id, n.geo, n.rounded ?? false])).toEqual([
      ["rect", "rectangle", false],
      ["round", "rectangle", true],
      ["dia", "diamond", false],
      ["oval", "oval", false],
      ["ell", "ellipse", false],
      ["quoted", "rectangle", false],
      ["bare", "rectangle", false],
    ]);
  });

  it("keeps spaces in labels and strips the quotes around a quoted one", () => {
    expect(nodeById(plan, "oval").label).toBe("Capsule shaped label");
    expect(nodeById(plan, "quoted").label).toBe("A label, with a comma");
  });

  it("labels a bare node with its own id", () => {
    expect(nodeById(plan, "bare").label).toBe("bare");
  });

  it("gives a diamond more width than a rectangle with the same label length", () => {
    // "Branch here?" is 12 characters, "Plain rectangle" is 15, and the diamond
    // still comes out wider.
    expect(nodeById(plan, "dia").w).toBeGreaterThan(nodeById(plan, "rect").w);
  });

  it("lays LR out across the page with nothing overlapping", () => {
    expect(plan.direction).toBe("LR");
    expect(bandIds(plan)).toEqual([
      ["rect"],
      ["round"],
      ["dia"],
      ["oval"],
      ["ell"],
      ["quoted"],
      ["bare"],
    ]);
    expect(overlaps(plan)).toEqual([]);
    expect(fractions(plan)).toEqual([]);
  });
});

describe("subgraph-8-9, the roadmap e2e fixture", () => {
  const plan = parseMermaid(fixture("subgraph-8-9.mmd"));

  it("has eight nodes and nine edges", () => {
    expect(plan.nodes).toHaveLength(8);
    expect(plan.edges).toHaveLength(9);
  });

  it("points every edge at a node in the plan", () => {
    const ids = new Set(plan.nodes.map((n) => n.id));
    for (const edge of plan.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  it("records the one subgraph and only the nodes first seen inside it", () => {
    expect(plan.subgraphs).toEqual([
      { id: "render", label: "rendering", nodeIds: ["shapes", "png", "svg"] },
    ]);
    expect(nodeById(plan, "shapes").subgraph).toBe("render");
    // `page` was declared before the subgraph opened, so it stays outside.
    expect(nodeById(plan, "page").subgraph).toBeUndefined();
  });

  it("carries the pipe label on the edge that closes the loop", () => {
    expect(plan.edges.at(-1)).toEqual({ from: "look", to: "cli", label: "no" });
  });

  it("breaks the cycle rather than refusing to rank", () => {
    expect(bandIds(plan)).toEqual([
      ["agent"],
      ["cli"],
      ["browser"],
      ["page"],
      ["shapes"],
      ["png", "svg"],
      ["look"],
    ]);
  });

  it("understands the whole file and overlaps nothing", () => {
    expect(plan.unsupported).toEqual([]);
    expect(overlaps(plan)).toEqual([]);
    expect(fractions(plan)).toEqual([]);
  });
});

describe("directions", () => {
  const base = fixture("directions.mmd");
  const all: Direction[] = ["TD", "TB", "LR", "RL", "BT"];

  /** The same four-node graph with a different header each time. */
  function variant(direction: Direction): string {
    return base.replace("flowchart TD", `flowchart ${direction}`);
  }

  it.each(all)("reads %s out of the header", (direction) => {
    expect(parseMermaid(variant(direction)).direction).toBe(direction);
  });

  it.each(all)("keeps %s free of overlaps and fractions", (direction) => {
    const plan = parseMermaid(variant(direction));
    expect(overlaps(plan)).toEqual([]);
    expect(fractions(plan)).toEqual([]);
  });

  it.each(["TD", "TB"] as const)("%s runs the source rank to the top", (direction) => {
    const plan = parseMermaid(variant(direction));
    expect(nodeById(plan, "a").y).toBeLessThan(nodeById(plan, "d").y);
    expect(nodeById(plan, "a").y).toBe(60);
  });

  it("BT runs the source rank to the bottom", () => {
    const plan = parseMermaid(variant("BT"));
    expect(nodeById(plan, "a").y).toBeGreaterThan(nodeById(plan, "d").y);
    expect(nodeById(plan, "d").y).toBe(60);
  });

  it("LR runs the source rank to the left", () => {
    const plan = parseMermaid(variant("LR"));
    expect(nodeById(plan, "a").x).toBeLessThan(nodeById(plan, "d").x);
    expect(nodeById(plan, "a").x).toBe(60);
  });

  it("RL runs the source rank to the right", () => {
    const plan = parseMermaid(variant("RL"));
    expect(nodeById(plan, "a").x).toBeGreaterThan(nodeById(plan, "d").x);
    expect(nodeById(plan, "d").x).toBe(60);
  });

  it("puts b and c side by side in the middle rank whichever way it runs", () => {
    for (const direction of all) {
      expect(bandIds(parseMermaid(variant(direction)))).toEqual([["a"], ["b", "c"], ["d"]]);
    }
  });

  it("lets an option override the header", () => {
    expect(parseMermaid(base, { direction: "RL" }).direction).toBe("RL");
  });

  it("defaults to TD when the header names no direction", () => {
    expect(parseMermaid("flowchart\n  a --> b").direction).toBe("TD");
    expect(parseMermaid("graph\n  a --> b").direction).toBe("TD");
  });

  it("defaults to TD when there is no header at all", () => {
    const plan = parseMermaid("a[One] --> b[Two]");
    expect(plan.direction).toBe("TD");
    expect(plan.nodes).toHaveLength(2);
    expect(plan.unsupported).toEqual([]);
  });

  it("reports a header direction it does not know and carries on", () => {
    const plan = parseMermaid("flowchart XY\n  a --> b");
    expect(plan.direction).toBe("TD");
    expect(plan.unsupported).toEqual(["flowchart XY"]);
    expect(plan.edges).toEqual([{ from: "a", to: "b" }]);
  });
});

describe("broken input", () => {
  const plan = parseMermaid(fixture("broken.mmd"));

  it("reports the broken line and the two unsupported statements, verbatim", () => {
    expect(plan.unsupported).toEqual([
      "this line is not mermaid at all",
      "classDef highlight fill:#f9f,stroke:#333",
      'click ok "https://example.com" "a tooltip"',
    ]);
  });

  it("still parses the graph around them", () => {
    expect(plan.nodes.map((n) => n.id)).toEqual(["ok", "also", "thick", "done"]);
    expect(plan.edges).toEqual([
      { from: "ok", to: "also" },
      { from: "also", to: "thick" },
      { from: "thick", to: "done" },
    ]);
    expect(overlaps(plan)).toEqual([]);
  });

  it("never throws, whatever it is handed", () => {
    for (const source of ["", "   ", "flowchart TD", "a -->", "--> b", "subgraph\nend", "end"]) {
      expect(() => parseMermaid(source)).not.toThrow();
    }
  });
});

describe("edges", () => {
  it("reads a chain as one edge per hop", () => {
    const plan = parseMermaid("flowchart TD\n  a --> b --> c --> d");
    expect(plan.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
    ]);
    expect(plan.nodes).toHaveLength(4);
  });

  it("fans out over & on the right and in on the left", () => {
    const plan = parseMermaid("flowchart TD\n  a --> b & c\n  b & c --> d");
    expect(plan.edges).toEqual([
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ]);
  });

  it("crosses an & on both sides of one link", () => {
    const plan = parseMermaid("flowchart LR\n  a & b --> c & d");
    expect(plan.edges).toEqual([
      { from: "a", to: "c" },
      { from: "a", to: "d" },
      { from: "b", to: "c" },
      { from: "b", to: "d" },
    ]);
  });

  it("reads all three label syntaxes", () => {
    const plan = parseMermaid(
      [
        "flowchart TD",
        "  a -->|pipe form| b",
        "  b -- middle form --> c",
        "  c -. dotted form .-> d",
      ].join("\n"),
    );
    expect(plan.edges).toEqual([
      { from: "a", to: "b", label: "pipe form" },
      { from: "b", to: "c", label: "middle form" },
      { from: "c", to: "d", label: "dotted form", dashed: true },
    ]);
  });

  it("marks only the dotted links dashed", () => {
    const plan = parseMermaid(
      ["flowchart TD", "  a --> b", "  b --- c", "  c -.-> d", "  d -.- e", "  e ==> f"].join("\n"),
    );
    expect(plan.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d", dashed: true },
      { from: "d", to: "e", dashed: true },
      { from: "e", to: "f" },
    ]);
  });

  it("reads longer dashes and a dotted link with a middle label", () => {
    const plan = parseMermaid(
      ["flowchart TD", "  a ---> b", "  b -- keeps going ---- c", "  c -..-> d"].join("\n"),
    );
    expect(plan.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c", label: "keeps going" },
      { from: "c", to: "d", dashed: true },
    ]);
  });

  it("declares a node once however many times it is named", () => {
    const plan = parseMermaid("flowchart TD\n  a[First] --> b\n  a --> c\n  a[Renamed] --> d");
    expect(plan.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    expect(nodeById(plan, "a").label).toBe("Renamed");
  });
});

describe("statements", () => {
  it("drops %% comments and accepts ; as a separator", () => {
    const plan = parseMermaid(
      ["%% a whole-line comment", "flowchart TD;", "  a --> b; b --> c;", "  c --> d %% trailing"]
        .join("\n"),
    );
    expect(plan.unsupported).toEqual([]);
    expect(plan.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    expect(plan.edges).toHaveLength(3);
  });

  it("accepts `graph` as well as `flowchart`", () => {
    expect(parseMermaid("graph LR\n  a --> b").direction).toBe("LR");
  });

  it("turns <br/> into a newline and strips other tags, keeping their text", () => {
    const plan = parseMermaid('flowchart TD\n  a["Title<br/><small>25%</small>"]');
    expect(nodeById(plan, "a").label).toBe("Title\n25%");
  });

  it("handles <br> without the slash", () => {
    const plan = parseMermaid('flowchart TD\n  a["One<br>Two<br />Three"]');
    expect(nodeById(plan, "a").label).toBe("One\nTwo\nThree");
  });

  it("makes a two-line label taller than a one-line one", () => {
    const plan = parseMermaid('flowchart TD\n  a["One"]\n  b["One<br/>Two"]');
    expect(nodeById(plan, "a").h).toBe(64);
    expect(nodeById(plan, "b").h).toBe(88);
  });

  it("floors and ceilings the width", () => {
    const plan = parseMermaid(`flowchart TD\n  a[x]\n  b[${"y".repeat(200)}]`);
    expect(nodeById(plan, "a").w).toBe(160);
    expect(nodeById(plan, "b").w).toBe(320);
  });
});

describe("subgraphs", () => {
  it("takes the title out of the brackets", () => {
    const plan = parseMermaid(
      ["flowchart TD", "  subgraph io [Input and output]", "    a --> b", "  end"].join("\n"),
    );
    expect(plan.subgraphs).toEqual([{ id: "io", label: "Input and output", nodeIds: ["a", "b"] }]);
  });

  it("uses the id as the title when there is no bracket", () => {
    const plan = parseMermaid(["flowchart TD", "  subgraph io", "    a", "  end"].join("\n"));
    expect(plan.subgraphs).toEqual([{ id: "io", label: "io", nodeIds: ["a"] }]);
  });

  it("records the innermost subgraph when they nest", () => {
    const plan = parseMermaid(
      [
        "flowchart TD",
        "  subgraph outer [Outer]",
        "    a",
        "    subgraph inner [Inner]",
        "      b",
        "    end",
        "    c",
        "  end",
        "  d",
      ].join("\n"),
    );
    expect(plan.subgraphs).toEqual([
      { id: "outer", label: "Outer", nodeIds: ["a", "c"] },
      { id: "inner", label: "Inner", nodeIds: ["b"] },
    ]);
    expect(plan.nodes.map((n) => n.subgraph)).toEqual(["outer", "inner", "outer", undefined]);
  });

  it("keeps a subgraph's nodes next to each other inside their rank", () => {
    const plan = parseMermaid(
      [
        "flowchart TD",
        "  root --> loose1 & loose2",
        "  subgraph pair [Pair]",
        "    inA",
        "    inB",
        "  end",
        "  root --> inA & inB",
        "  root --> loose3",
      ].join("\n"),
    );
    const second = bandIds(plan)[1] ?? [];
    const first = second.indexOf("inA");
    const last = second.indexOf("inB");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(Math.abs(last - first)).toBe(1);
  });
});

describe("rank", () => {
  it("takes the longest path, not the shortest", () => {
    const ranks = rank(
      ["a", "b", "c", "d"],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
        { from: "a", to: "d" },
      ],
    );
    expect(ranks.get("d")).toBe(3);
  });

  it("ignores a back edge so a cycle still ranks", () => {
    const ranks = rank(
      ["a", "b", "c"],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
      ],
    );
    expect([...ranks.values()]).toEqual([0, 1, 2]);
  });

  it("ignores a self loop", () => {
    const ranks = rank(
      ["a", "b"],
      [
        { from: "a", to: "a" },
        { from: "a", to: "b" },
      ],
    );
    expect(ranks.get("a")).toBe(0);
    expect(ranks.get("b")).toBe(1);
  });

  it("puts an isolated node at rank 0", () => {
    expect(rank(["lonely"], []).get("lonely")).toBe(0);
  });
});

describe("options", () => {
  const source = fixture("simple-td.mmd");

  it("moves the whole layout to a given origin", () => {
    const plan = parseMermaid(source, { origin: { x: 0, y: 0 } });
    expect({ x: nodeById(plan, "a").x, y: nodeById(plan, "a").y }).toEqual({ x: 0, y: 0 });
  });

  it("honours the rank gap", () => {
    const plan = parseMermaid(source, { spacing: { rank: 40 } });
    const a = nodeById(plan, "a");
    expect(nodeById(plan, "b").y - (a.y + a.h)).toBe(40);
  });

  it("honours the node gap", () => {
    const plan = parseMermaid("flowchart TD\n  a --> b & c", { spacing: { node: 10 } });
    const b = nodeById(plan, "b");
    const c = nodeById(plan, "c");
    expect(c.x - (b.x + b.w)).toBe(10);
  });
});

describe("tokenize", () => {
  it("returns the graph with no geometry attached", () => {
    const tokens = tokenize(fixture("simple-td.mmd"));
    expect(tokens.direction).toBe("TD");
    expect(tokens.nodes).toEqual([
      { id: "a", label: "Start here", geo: "rectangle" },
      { id: "b", label: "Do the work", geo: "rectangle" },
      { id: "c", label: "Finish", geo: "rectangle" },
    ]);
    expect(tokens.subgraphs).toEqual([]);
  });
});

describe("determinism", () => {
  it("gives the same plan for the same source, every time", () => {
    const source = fixture("learn-map.mmd");
    expect(JSON.stringify(parseMermaid(source))).toBe(JSON.stringify(parseMermaid(source)));
  });
});

describe("learn/map.md, the real input", () => {
  const plan = parseMermaid(fixture("learn-map.mmd"));

  it("reads all 32 concepts and all 70 edges", () => {
    expect(plan.nodes).toHaveLength(32);
    expect(plan.edges).toHaveLength(70);
    expect(plan.edges.filter((e) => e.dashed).length).toBe(30);
    expect(plan.edges.filter((e) => !e.dashed).length).toBe(40);
  });

  it("turns the <br/> and <small> in a label into a second line", () => {
    expect(nodeById(plan, "n_machine_model_and_input_size").label).toBe(
      "Cost model and input size\n25%",
    );
    expect(plan.nodes.every((n) => n.label.split("\n").length === 2)).toBe(true);
    expect(plan.nodes.every((n) => !n.label.includes("<"))).toBe(true);
  });

  it("puts the nine styling lines in unsupported and nothing else", () => {
    expect(plan.unsupported).toHaveLength(9);
    expect(plan.unsupported.every((line) => /^(?:classDef|class) /.test(line))).toBe(true);
  });

  it("ranks every node, the two roots first and the summary concept last", () => {
    const rows = bandIds(plan);
    expect(rows.flat()).toHaveLength(32);
    // Ten ranks: the algorithms half is nine hops deep, the transformer half seven.
    expect(rows).toHaveLength(10);
    expect(rows[0]).toContain("n_machine_model_and_input_size");
    expect(rows[0]).toContain("n_vector_as_a_list_of_numbers");
    expect(rows.at(-1)).toEqual(["n_asymptotic_running_time_analysis"]);
  });

  it("keeps the transformer chain in order down the ranks", () => {
    const rows = bandIds(plan);
    const rankOf = (id: string) => rows.findIndex((row) => row.includes(id));
    expect(rankOf("n_self_attention")).toBeLessThan(rankOf("n_transformer_block"));
    expect(rankOf("n_transformer_block")).toBeLessThan(rankOf("n_tool_calling"));
    expect(rankOf("n_tool_calling")).toBeLessThan(rankOf("n_react_loop"));
  });

  it("points every edge at a node that exists", () => {
    const ids = new Set(plan.nodes.map((n) => n.id));
    const dangling = plan.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
    expect(dangling).toEqual([]);
  });

  it("overlaps nothing and rounds everything", () => {
    expect(overlaps(plan)).toEqual([]);
    expect(fractions(plan)).toEqual([]);
  });

  it("lays out just as cleanly the other four ways round", () => {
    for (const direction of ["TB", "LR", "RL", "BT"] as const) {
      const turned = parseMermaid(fixture("learn-map.mmd"), { direction });
      expect(turned.direction).toBe(direction);
      expect(overlaps(turned)).toEqual([]);
      expect(fractions(turned)).toEqual([]);
    }
  });
});
