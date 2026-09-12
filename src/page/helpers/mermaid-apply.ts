/**
 * The mermaid importer's other half: turning a `Plan` into shapes.
 *
 * This lives beside `mermaid.ts` rather than inside it on purpose. The parser
 * has to stay importable in vitest's node environment, and it can only do that
 * while nothing in its module graph reaches for `tldraw`. `applyPlan` needs the
 * shape helpers, which do, so it gets its own file. HELPERS.md says both halves
 * share `mermaid.ts`; that is the one correction phase 2 makes to it.
 *
 * The interesting work is not creating the shapes, it is the pass afterwards.
 * `parseMermaid` sizes a box by counting characters, and tldraw then grows the
 * real shape when the label wraps, so the plan's tidy grid arrives with rows
 * sitting on each other. `respace` reads the bounds tldraw actually produced
 * and lays the ranks out again against those, which is what gets the fixture to
 * zero lints.
 */

import type { Editor, TLShapeId } from "tldraw";

import { makeBox } from "./shapes.js";
import { makeConnection } from "./connect.js";
import { boxShapes, DEFAULT_CONTAINER_MARGIN } from "./layout.js";
import { lintPage } from "./read.js";
import type { Lint } from "./lints.js";
import type { Rect, Side } from "./geometry.js";
import { rank, type Direction, type Plan, type PlanNode } from "./mermaid.js";

/** Directions whose ranks stack down the page. The other two run across it. */
const VERTICAL: ReadonlySet<Direction> = new Set<Direction>(["TD", "TB", "BT"]);

/** Gap between ranks after the re-space pass, in page units. */
export const DEFAULT_APPLY_RANK_GAP = 120;
/** Gap between neighbours inside a rank after the re-space pass. */
export const DEFAULT_APPLY_NODE_GAP = 60;
/** How many times the re-space pass will widen the gaps chasing an overlap. */
const MAX_RESPACE_ROUNDS = 4;
/** How much each extra round widens the gaps. */
const RESPACE_GROWTH = 1.35;

/** Options for {@link applyPlan}. */
export interface ApplyPlanOptions {
  /** Gap between ranks, default 120. */
  rankGap?: number;
  /** Gap inside a rank, default 60. */
  nodeGap?: number;
  /** Top-left of the finished layout. Defaults to the plan's own corner. */
  origin?: { x: number; y: number };
  /** Margin between a subgraph container and its members, default 40. */
  margin?: number;
  /** Leave the plan's own coordinates alone. Debugging only; expect overlaps. */
  respace?: boolean;
}

/** What {@link applyPlan} returns, and what `helpers.mermaid` hands back. */
export interface ApplyPlanResult {
  /** Mermaid node id to tldraw shape id. */
  nodes: Record<string, TLShapeId>;
  /** Every arrow created, in plan edge order. */
  edges: TLShapeId[];
  /**
   * The container shape drawn behind each subgraph, in plan order.
   *
   * HELPERS.md's return table predates this field; the parser asked for the
   * ids back so a caller can restyle or move a container without guessing.
   * A container's key is derived from its subgraph, `shape:container:<id>`,
   * so the pairing is recoverable from `plan.subgraphs` when it is wanted.
   */
  containers: TLShapeId[];
  /** Source lines the parser could not read, passed through unchanged. */
  unsupported: string[];
  /** The lint pass after the layout settled. Empty is the target. */
  lints: Lint[];
}

/**
 * The tldraw geo to draw a planned node as.
 *
 * tldraw 5 has no rounded rectangle and no corner-radius prop: the geo enum is
 * a fixed list (`rectangle`, `ellipse`, `oval`, `diamond`, `cloud`, ...) and
 * `TLGeoShapeProps` has nothing to round a corner with. So mermaid's `id(text)`
 * becomes `oval`, the capsule, which is the nearest silhouette tldraw owns and
 * the only one that reads as "not a plain box" at a glance. The cost is that
 * `id(text)` and `id([text])` come out identical, which is honest: tldraw has
 * one rounded shape and mermaid has two.
 */
export function geoForNode(node: PlanNode): PlanNode["geo"] | "oval" {
  return node.rounded === true ? "oval" : node.geo;
}

/** Clearance between the outside of the layout and a back edge's apex. */
const BACK_EDGE_CLEARANCE = 70;

/**
 * How to draw an edge that points backwards up the ranks.
 *
 * Left to its auto anchors a back edge leaves one shape's top, aims at the
 * other's bottom, and draws a straight line up the middle of the diagram
 * through every rank in between. What a flowchart wants instead is a loop out
 * to one side, so this anchors both ends on the same outside face and bends an
 * arc whose apex clears the widest shape on that side.
 *
 * `bend` is the distance from the chord's midpoint to the arc's apex, and a
 * positive one offsets along the direction of travel turned a quarter turn
 * anticlockwise (measured, not assumed: an arrow running straight up with a
 * bend of +300 came back 300 units wider on its right). So the sign is a dot
 * product against the side we picked, rather than a guess.
 */
function backEdgeRouting(
  editor: Editor,
  nodes: Record<string, TLShapeId>,
  plan: Plan,
  fromId: string,
  toId: string,
): { kind: "arc"; start: Side; end: Side; bend: number } | Record<string, never> {
  const vertical = VERTICAL.has(plan.direction);
  const from = boundsOf(editor, nodes[fromId] ?? ("" as TLShapeId));
  const to = boundsOf(editor, nodes[toId] ?? ("" as TLShapeId));
  if (!from || !to) return {};

  const boxes = Object.values(nodes)
    .map((id) => boundsOf(editor, id))
    .filter((box): box is Rect => box !== null);
  if (boxes.length === 0) return {};

  // Outside is measured against the whole layout, not the pair, so every loop
  // in one diagram goes round the same way and they nest instead of crossing.
  const low = Math.min(...boxes.map((box) => (vertical ? box.x : box.y)));
  const high = Math.max(...boxes.map((box) => (vertical ? box.x + box.w : box.y + box.h)));
  const pairCentre =
    ((vertical ? from.x + from.w / 2 : from.y + from.h / 2) +
      (vertical ? to.x + to.w / 2 : to.y + to.h / 2)) /
    2;
  const outward = pairCentre >= (low + high) / 2;

  const side: Side = vertical ? (outward ? "right" : "left") : outward ? "bottom" : "top";
  const anchor = anchorFor(side);
  const start = { x: from.x + from.w * anchor.x, y: from.y + from.h * anchor.y };
  const end = { x: to.x + to.w * anchor.x, y: to.y + to.h * anchor.y };

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  // The direction a positive bend pushes the apex.
  const perp = { x: -dy / length, y: dx / length };
  const want =
    side === "right"
      ? { x: 1, y: 0 }
      : side === "left"
        ? { x: -1, y: 0 }
        : side === "bottom"
          ? { x: 0, y: 1 }
          : { x: 0, y: -1 };

  const lane = outward ? high + BACK_EDGE_CLEARANCE : low - BACK_EDGE_CLEARANCE;
  const chordMid = vertical ? (start.x + end.x) / 2 : (start.y + end.y) / 2;
  const magnitude = Math.max(BACK_EDGE_CLEARANCE, Math.abs(lane - chordMid));
  const sign = perp.x * want.x + perp.y * want.y >= 0 ? 1 : -1;

  return { kind: "arc", start: side, end: side, bend: sign * magnitude };
}

function anchorFor(side: Side): { x: number; y: number } {
  if (side === "right") return { x: 1, y: 0.5 };
  if (side === "left") return { x: 0, y: 0.5 };
  if (side === "bottom") return { x: 0.5, y: 1 };
  return { x: 0.5, y: 0 };
}

function boundsOf(editor: Editor, id: TLShapeId): Rect | null {
  const box = editor.getShapePageBounds(id);
  return box ? { x: box.x, y: box.y, w: box.w, h: box.h } : null;
}

/**
 * Lay the ranks out again against the bounds tldraw actually produced.
 *
 * Rank membership comes from the parser's own {@link rank}, so this agrees with
 * the plan rather than guessing from coordinates. The order of the ranks on the
 * page, and the order of nodes inside one, are read off the plan, which is what
 * carries the parser's direction handling and its barycentre sweeps through
 * without repeating either.
 *
 * Bands are as deep as their deepest member and slots as wide as their widest,
 * so after this pass no two nodes can touch: any overlap left is between a
 * label and an arrow, not between boxes.
 */
function respaceRanks(
  editor: Editor,
  plan: Plan,
  ids: Map<string, TLShapeId>,
  rankGap: number,
  nodeGap: number,
  origin: { x: number; y: number },
): void {
  const vertical = VERTICAL.has(plan.direction);
  const ranks = rank(
    plan.nodes.map((node) => node.id),
    plan.edges,
  );

  const planOf = new Map<string, PlanNode>(plan.nodes.map((node) => [node.id, node]));
  const rows = new Map<number, string[]>();
  for (const node of plan.nodes) {
    const r = ranks.get(node.id) ?? 0;
    const row = rows.get(r);
    if (row) row.push(node.id);
    else rows.set(r, [node.id]);
  }

  const alongRank = (node: PlanNode): number => (vertical ? node.y : node.x);
  const alongSlot = (node: PlanNode): number => (vertical ? node.x : node.y);

  // The plan already decided which rank sits where, reversal and all. Sorting
  // the ranks by where the plan put them carries that decision over.
  const order = [...rows.keys()].sort((a, b) => {
    const depth = (r: number): number =>
      Math.min(...(rows.get(r) ?? []).map((id) => alongRank(planOf.get(id) ?? plan.nodes[0]!)));
    return depth(a) - depth(b);
  });
  for (const row of rows.values()) {
    row.sort(
      (a, b) =>
        alongSlot(planOf.get(a) ?? plan.nodes[0]!) - alongSlot(planOf.get(b) ?? plan.nodes[0]!),
    );
  }

  const real = new Map<string, Rect>();
  for (const node of plan.nodes) {
    const id = ids.get(node.id);
    const box = id ? boundsOf(editor, id) : null;
    real.set(node.id, box ?? { x: node.x, y: node.y, w: node.w, h: node.h });
  }
  const size = (id: string): Rect => real.get(id) ?? { x: 0, y: 0, w: 0, h: 0 };

  const bandDepth = new Map<number, number>();
  const slotSpan = new Map<number, number>();
  for (const [r, row] of rows) {
    let deep = 0;
    let span = 0;
    for (const id of row) {
      const box = size(id);
      deep = Math.max(deep, vertical ? box.h : box.w);
      span += vertical ? box.w : box.h;
    }
    bandDepth.set(r, deep);
    slotSpan.set(r, span + nodeGap * Math.max(0, row.length - 1));
  }
  const widest = Math.max(0, ...slotSpan.values());

  let cursor = 0;
  for (const r of order) {
    const row = rows.get(r) ?? [];
    const depth = bandDepth.get(r) ?? 0;
    let slot = (widest - (slotSpan.get(r) ?? 0)) / 2;
    for (const nodeId of row) {
      const box = size(nodeId);
      const centred = (depth - (vertical ? box.h : box.w)) / 2;
      const x = vertical ? origin.x + slot : origin.x + cursor + centred;
      const y = vertical ? origin.y + cursor + centred : origin.y + slot;
      const shapeId = ids.get(nodeId);
      const shape = shapeId ? editor.getShape(shapeId) : undefined;
      if (shape) {
        editor.updateShape({
          id: shape.id,
          type: shape.type,
          x: shape.x + (Math.round(x) - box.x),
          y: shape.y + (Math.round(y) - box.y),
        });
      }
      slot += (vertical ? box.w : box.h) + nodeGap;
    }
    if (depth > 0) cursor += depth + rankGap;
  }
}

/**
 * Turn a parsed {@link Plan} into boxes, bound arrows and subgraph containers.
 *
 * Boxes first, because tldraw only knows how tall a label makes a box once the
 * box exists; then the re-space pass against the real bounds; then the arrows,
 * so every anchor is chosen against final positions; then the containers, which
 * are drawn around whatever the layout settled on and sent to the back.
 *
 * If a shape-on-shape overlap survives the first pass the gaps are widened and
 * the pass runs again, up to a few rounds. In practice the first pass is
 * enough; the loop is there so a pathological label cannot leave the caller
 * with a picture nobody looked at.
 */
export function applyPlan(
  editor: Editor,
  plan: Plan,
  opts: ApplyPlanOptions = {},
): ApplyPlanResult {
  const nodes: Record<string, TLShapeId> = {};
  for (const node of plan.nodes) {
    nodes[node.id] = makeBox(editor, node.id, node.label, {
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      geo: geoForNode(node),
      verticalAlign: "middle",
    });
  }

  const ids = new Map<string, TLShapeId>(Object.entries(nodes));
  const origin = opts.origin ?? {
    x: Math.min(...plan.nodes.map((node) => node.x), 0),
    y: Math.min(...plan.nodes.map((node) => node.y), 0),
  };

  if (opts.respace !== false && plan.nodes.length > 0) {
    let rankGap = opts.rankGap ?? DEFAULT_APPLY_RANK_GAP;
    let nodeGap = opts.nodeGap ?? DEFAULT_APPLY_NODE_GAP;
    for (let round = 0; round < MAX_RESPACE_ROUNDS; round++) {
      respaceRanks(editor, plan, ids, rankGap, nodeGap, origin);
      const overlaps = lintPage(editor).filter(
        (lint) => lint.rule === "overlapping-shapes" || lint.rule === "overlapping-text",
      );
      if (overlaps.length === 0) break;
      rankGap = Math.round(rankGap * RESPACE_GROWTH);
      nodeGap = Math.round(nodeGap * RESPACE_GROWTH);
    }
  }

  // Arrows last of the two, so every anchor is picked against the positions
  // the layout settled on rather than the plan's first guess.
  const ranks = rank(
    plan.nodes.map((node) => node.id),
    plan.edges,
  );
  const seenPair = new Map<string, number>();
  const edges: TLShapeId[] = [];
  for (const edge of plan.edges) {
    if (!(edge.from in nodes) || !(edge.to in nodes)) continue;
    const pair = `${edge.from}->${edge.to}`;
    const nth = seenPair.get(pair) ?? 0;
    seenPair.set(pair, nth + 1);
    const back = (ranks.get(edge.to) ?? 0) <= (ranks.get(edge.from) ?? 0);
    edges.push(
      makeConnection(editor, edge.from, edge.to, {
        ...(nth > 0 ? { id: `arrow:${pair}#${nth + 1}` } : {}),
        ...(edge.label !== undefined ? { label: edge.label } : {}),
        ...(edge.dashed === true ? { dash: "dashed" as const } : {}),
        // A back edge loops out to one side instead of cutting up the middle.
        // See backEdgeRouting.
        ...(back
          ? backEdgeRouting(editor, nodes, plan, edge.from, edge.to)
          : { kind: "elbow" as const }),
        // Fan repeat arrows between the same pair into their own lanes rather
        // than drawing them exactly on top of each other.
        ...(nth > 0 ? { mid: Math.min(0.9, 0.5 + 0.15 * nth) } : {}),
      }),
    );
  }

  const containers: TLShapeId[] = [];
  for (const subgraph of plan.subgraphs) {
    const members = subgraph.nodeIds.filter((id) => id in nodes);
    if (members.length === 0) continue;
    containers.push(
      boxShapes(editor, members, {
        label: subgraph.label,
        margin: opts.margin ?? DEFAULT_CONTAINER_MARGIN,
        shapeId: `container:${subgraph.id}`,
      }),
    );
  }

  return {
    nodes,
    edges,
    containers,
    unsupported: [...plan.unsupported],
    lints: lintPage(editor),
  };
}
