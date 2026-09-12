/**
 * The mermaid flowchart importer, pure half.
 *
 * `parseMermaid(source, opts)` turns a mermaid `flowchart` or `graph` into a
 * `Plan`: every node with a geo name and a page rectangle, every edge with its
 * label and dash, every subgraph with its members, and every line the parser
 * did not understand. It touches no editor, no DOM and no filesystem, which is
 * what lets the whole importer be tested in vitest's node environment.
 *
 * `applyPlan(plan)` is the other half. It lives beside this one, needs the
 * editor, and turns a `Plan` into shapes, bound arrows and containers.
 *
 * The parser never throws on bad input. A statement it cannot read is pushed
 * onto `unsupported` as the trimmed source line and parsing carries on, so one
 * `classDef` at the bottom of a file does not cost the diagram above it.
 */

/** Mermaid's five flowchart directions. `TD` and `TB` mean the same thing. */
export type Direction = "TD" | "TB" | "LR" | "RL" | "BT";

/**
 * The tldraw geo names this importer emits. tldraw has no rounded-rectangle
 * geo, so mermaid's `id(text)` comes back as `rectangle` carrying
 * `rounded: true`; `applyPlan` is free to honour that hint or ignore it.
 */
export type GeoName = "rectangle" | "oval" | "ellipse" | "diamond";

/** One box in the plan, already sized and placed in page coordinates. */
export interface PlanNode {
  /** The mermaid id, used verbatim as the tldraw shape id. */
  id: string;
  /** Display text. `<br/>` became a newline and HTML tags were stripped. */
  label: string;
  geo: GeoName;
  /** Set only for mermaid's `id(text)`, which has no geo of its own. */
  rounded?: boolean;
  /** Top-left corner. Always an integer. */
  x: number;
  y: number;
  /** Size. Always an integer. */
  w: number;
  h: number;
  /** The innermost subgraph this node was first declared inside, if any. */
  subgraph?: string;
}

/** One arrow in the plan. Both ends name a node in `Plan.nodes`. */
export interface PlanEdge {
  from: string;
  to: string;
  /** Present only when the link carried one of the three label forms. */
  label?: string;
  /** Present and true only for mermaid's dotted links, `-.-` and `-.->`. */
  dashed?: boolean;
}

/** One `subgraph ... end` block, flattened to its direct members. */
export interface PlanSubgraph {
  id: string;
  label: string;
  /** Node ids in first-seen order. A nested subgraph's nodes are not listed. */
  nodeIds: string[];
}

/** What `parseMermaid` returns and `applyPlan` consumes. */
export interface Plan {
  direction: Direction;
  nodes: PlanNode[];
  edges: PlanEdge[];
  subgraphs: PlanSubgraph[];
  /** Trimmed source lines the parser could not read, in file order. */
  unsupported: string[];
}

/** Gap between ranks and between nodes inside a rank, in page units. */
export interface Spacing {
  rank?: number;
  node?: number;
}

/** Top-left corner of the whole layout. */
export interface Origin {
  x: number;
  y: number;
}

/** Options for {@link parseMermaid}. */
export interface ParseMermaidOptions {
  /** Overrides the direction in the header. */
  direction?: Direction;
  /** Top-left of the layout. Defaults to `{ x: 60, y: 60 }`. */
  origin?: Origin;
  /** Rank and node gaps. Default 120 and 60. */
  spacing?: Spacing;
}

/** A node as the tokeniser knows it: everything but the geometry. */
export interface TokenNode {
  id: string;
  label: string;
  geo: GeoName;
  rounded?: boolean;
  subgraph?: string;
}

/** What {@link tokenize} returns: the whole file read, nothing laid out. */
export interface Tokenized {
  direction: Direction;
  nodes: TokenNode[];
  edges: PlanEdge[];
  subgraphs: PlanSubgraph[];
  unsupported: string[];
}

const DEFAULT_ORIGIN: Origin = { x: 60, y: 60 };
const DEFAULT_RANK_GAP = 120;
const DEFAULT_NODE_GAP = 60;

const MIN_WIDTH = 160;
const MAX_WIDTH = 320;
const PX_PER_CHAR = 9;
const WIDTH_PADDING = 32;
const BASE_HEIGHT = 64;
const EXTRA_LINE_HEIGHT = 24;
/** A diamond wastes its corners, so the same text needs a wider box. */
const DIAMOND_WIDTH_FACTOR = 1.4;

const DIRECTIONS: readonly Direction[] = ["TD", "TB", "LR", "RL", "BT"];

/** Directions whose rank axis is vertical. The other two run along x. */
const VERTICAL: ReadonlySet<Direction> = new Set<Direction>(["TD", "TB", "BT"]);

/** Directions that run the first rank furthest from the origin. */
const REVERSED: ReadonlySet<Direction> = new Set<Direction>(["BT", "RL"]);

/**
 * Statements this parser knowingly declines. Listing them means the whole line
 * is reported once and cleanly, instead of falling out of node parsing with a
 * confusing shape.
 */
const DECLINED = /^(?:classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\s/i;

const HEADER = /^(?:flowchart|graph)(?:\s+(\S+))?$/i;
const SUBGRAPH = /^subgraph\b\s*(.*)$/i;
const SUBGRAPH_TITLE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*(\[[\s\S]*\]|\([\s\S]*\))$/;
const NODE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*/;
const PIPE_LABEL = /^\s*\|([^|]*)\|/;

const ENTITIES: Readonly<Record<string, string>> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * The link forms this parser reads, tried in order. The three with a capture
 * group are mermaid's "text in the middle" syntax; the plain ones may still be
 * followed by `|label|`.
 */
const LINKS: ReadonlyArray<{ re: RegExp; dashed: boolean; labelled: boolean }> = [
  { re: /^-\.\s+(.+?)\s+\.-+>?/, dashed: true, labelled: true },
  { re: /^--\s+(.+?)\s+--+>?/, dashed: false, labelled: true },
  { re: /^==\s+(.+?)\s+==+>?/, dashed: false, labelled: true },
  { re: /^-\.+-+>?/, dashed: true, labelled: false },
  { re: /^={2,}>?/, dashed: false, labelled: false },
  { re: /^-{2,}>?/, dashed: false, labelled: false },
];

/** A link operator, read off the source. */
interface Link {
  label?: string;
  dashed: boolean;
}

/** One node reference inside a statement, before it meets the node table. */
interface NodeSpec {
  id: string;
  label: string;
  geo: GeoName;
  rounded?: boolean;
  /** True when the reference carried brackets, so it may restyle a known node. */
  explicit: boolean;
}

/** One statement, plus the line it came from so a failure can name it. */
interface Statement {
  text: string;
  lineIndex: number;
  line: string;
}

/** Drop a `%%` comment, but not a `%%` that sits inside a quoted label. */
function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === "%" && line[i + 1] === "%") return line.slice(0, i);
  }
  return line;
}

/** Split on a separator that is outside quotes and outside every bracket. */
function splitTop(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === separator) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** Statements, in file order. One line can hold several, separated by `;`. */
function statementsOf(source: string): Statement[] {
  const out: Statement[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const body = stripComment(lines[i] ?? "");
    const line = body.trim().replace(/;+$/, "").trim();
    if (!line) continue;
    for (const piece of splitTop(body, ";")) {
      const text = piece.trim();
      if (text) out.push({ text, lineIndex: i, line });
    }
  }
  return out;
}

/**
 * Label text as it should read on the canvas: outer quotes gone, `<br/>` and
 * `<br>` turned into newlines, every other simple HTML tag stripped while its
 * text survives, and a handful of entities decoded.
 */
export function cleanLabel(raw: string): string {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
  }
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/?[A-Za-z][^>]*>/g, "");
  text = text.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (match) => ENTITIES[match] ?? match);
  return text
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** Match a link operator at the head of `rest`, or return null. */
function matchLink(rest: string): { link: Link; length: number } | null {
  for (const form of LINKS) {
    const m = form.re.exec(rest);
    if (!m) continue;
    const link: Link = { dashed: form.dashed };
    let length = m[0].length;
    if (form.labelled) {
      const label = m[1]?.trim();
      if (label) link.label = cleanLabel(label);
    } else {
      const pipe = PIPE_LABEL.exec(rest.slice(length));
      if (pipe) {
        length += pipe[0].length;
        const label = pipe[1]?.trim();
        if (label) link.label = cleanLabel(label);
      }
    }
    return { link, length };
  }
  return null;
}

/** Cut a statement into node segments and the links between them. */
function splitChain(stmt: string): { segments: string[]; links: Link[] } {
  const segments: string[] = [];
  const links: Link[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  let i = 0;
  while (i < stmt.length) {
    const ch = stmt[i];
    if (inQuote) {
      if (ch === '"') inQuote = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && (ch === "-" || ch === "=")) {
      const hit = matchLink(stmt.slice(i));
      if (hit) {
        segments.push(stmt.slice(start, i));
        links.push(hit.link);
        i += hit.length;
        start = i;
        continue;
      }
    }
    i++;
  }
  segments.push(stmt.slice(start));
  return { segments, links };
}

/** Read one node reference: `id`, `id[text]`, `id(text)`, `id{text}`, and so on. */
function parseNodeSpec(text: string): NodeSpec | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const m = NODE_ID.exec(trimmed);
  if (!m) return null;
  const id = m[0];
  const rest = trimmed.slice(id.length).trim();
  if (!rest) return { id, label: id, geo: "rectangle", explicit: false };

  const inner = (open: string, close: string): string | null =>
    rest.length >= open.length + close.length && rest.startsWith(open) && rest.endsWith(close)
      ? rest.slice(open.length, rest.length - close.length)
      : null;

  const oval = inner("([", "])");
  if (oval !== null) return { id, label: cleanLabel(oval), geo: "oval", explicit: true };
  const ellipse = inner("((", "))");
  if (ellipse !== null) return { id, label: cleanLabel(ellipse), geo: "ellipse", explicit: true };

  // Everything else that opens with two brackets is a mermaid shape this
  // importer does not carry: subroutine, cylinder, hexagon, parallelogram.
  if (/^[[({]{2}/.test(rest) || /^\[[/\\]/.test(rest) || rest.startsWith(">")) return null;

  const rectangle = inner("[", "]");
  if (rectangle !== null) {
    return { id, label: cleanLabel(rectangle), geo: "rectangle", explicit: true };
  }
  const rounded = inner("(", ")");
  if (rounded !== null) {
    return { id, label: cleanLabel(rounded), geo: "rectangle", rounded: true, explicit: true };
  }
  const diamond = inner("{", "}");
  if (diamond !== null) return { id, label: cleanLabel(diamond), geo: "diamond", explicit: true };
  return null;
}

/** Read one segment, which may name several nodes joined by `&`. */
function parseSegment(segment: string): NodeSpec[] | null {
  const specs: NodeSpec[] = [];
  for (const part of splitTop(segment, "&")) {
    const spec = parseNodeSpec(part);
    if (!spec) return null;
    specs.push(spec);
  }
  return specs.length > 0 ? specs : null;
}

/**
 * Read a whole flowchart into nodes, edges, subgraphs and a list of lines that
 * were not understood. No geometry: {@link parseMermaid} adds that.
 */
export function tokenize(source: string): Tokenized {
  const unsupported: string[] = [];
  const reported = new Set<number>();
  const nodes = new Map<string, TokenNode>();
  const order: string[] = [];
  const edges: PlanEdge[] = [];
  const subgraphs = new Map<string, PlanSubgraph>();
  const subgraphOrder: string[] = [];
  const open: string[] = [];
  let direction: Direction = "TD";
  let first = true;

  const decline = (stmt: Statement): void => {
    if (reported.has(stmt.lineIndex)) return;
    reported.add(stmt.lineIndex);
    unsupported.push(stmt.line);
  };

  const declare = (spec: NodeSpec): void => {
    const existing = nodes.get(spec.id);
    if (existing) {
      if (spec.explicit) {
        existing.label = spec.label;
        existing.geo = spec.geo;
        if (spec.rounded) existing.rounded = true;
        else delete existing.rounded;
      }
      return;
    }
    const node: TokenNode = { id: spec.id, label: spec.label, geo: spec.geo };
    if (spec.rounded) node.rounded = true;
    const parent = open[open.length - 1];
    if (parent !== undefined) {
      node.subgraph = parent;
      subgraphs.get(parent)?.nodeIds.push(spec.id);
    }
    nodes.set(spec.id, node);
    order.push(spec.id);
  };

  for (const stmt of statementsOf(source)) {
    const wasFirst = first;
    first = false;

    const header = HEADER.exec(stmt.text);
    if (header) {
      // Only the opening statement may be a header. A second one is a mistake.
      if (wasFirst) {
        const named = header[1]?.toUpperCase();
        if (named === undefined) continue;
        const found = DIRECTIONS.find((d) => d === named);
        if (found) direction = found;
        else decline(stmt);
        continue;
      }
      decline(stmt);
      continue;
    }

    if (/^end$/i.test(stmt.text)) {
      if (open.length > 0) open.pop();
      else decline(stmt);
      continue;
    }

    const sub = SUBGRAPH.exec(stmt.text);
    if (sub) {
      const rest = (sub[1] ?? "").trim();
      let id: string;
      let label: string;
      if (!rest) {
        id = `subgraph${String(subgraphOrder.length + 1)}`;
        label = id;
      } else {
        const titled = SUBGRAPH_TITLE.exec(rest);
        if (titled?.[1] !== undefined && titled[2] !== undefined) {
          id = titled[1];
          label = cleanLabel(titled[2].slice(1, -1));
        } else {
          id = rest;
          label = cleanLabel(rest);
        }
      }
      if (!subgraphs.has(id)) {
        subgraphs.set(id, { id, label, nodeIds: [] });
        subgraphOrder.push(id);
      }
      open.push(id);
      continue;
    }

    if (DECLINED.test(stmt.text)) {
      decline(stmt);
      continue;
    }

    const { segments, links } = splitChain(stmt.text);
    if (segments.length !== links.length + 1) {
      decline(stmt);
      continue;
    }
    const parsed: NodeSpec[][] = [];
    let bad = false;
    for (const segment of segments) {
      const specs = parseSegment(segment);
      if (!specs) {
        bad = true;
        break;
      }
      parsed.push(specs);
    }
    if (bad) {
      decline(stmt);
      continue;
    }

    for (const specs of parsed) for (const spec of specs) declare(spec);
    for (let i = 0; i < links.length; i++) {
      const from = parsed[i];
      const to = parsed[i + 1];
      const link = links[i];
      if (!from || !to || !link) continue;
      for (const f of from) {
        for (const t of to) {
          const edge: PlanEdge = { from: f.id, to: t.id };
          if (link.label !== undefined) edge.label = link.label;
          if (link.dashed) edge.dashed = true;
          edges.push(edge);
        }
      }
    }
  }

  return {
    direction,
    nodes: order.map((id) => nodes.get(id)).filter((n): n is TokenNode => n !== undefined),
    edges,
    subgraphs: subgraphOrder
      .map((id) => subgraphs.get(id))
      .filter((s): s is PlanSubgraph => s !== undefined),
    unsupported,
  };
}

/** `from` and `to` as one map key, so a back-edge set needs no nesting. */
function edgeKey(from: string, to: string): string {
  return `${from} ${to}`;
}

/**
 * Rank every node by its longest path from a source, ignoring the back edges a
 * depth-first search finds. Sources and anything unreachable land at rank 0.
 *
 * Cycles are broken rather than rejected: `learn/map.md` is acyclic today, but
 * a hand-written flowchart with a retry loop should still lay out.
 */
export function rank(nodeIds: string[], edges: PlanEdge[]): Map<string, number> {
  const known = new Set(nodeIds);
  const out = new Map<string, string[]>();
  for (const id of nodeIds) out.set(id, []);
  const seenEdge = new Set<string>();
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue;
    const key = edgeKey(edge.from, edge.to);
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    out.get(edge.from)?.push(edge.to);
  }

  // Depth-first search, iteratively, marking every edge that points at a node
  // still on the stack. Those are the back edges; dropping them leaves a DAG.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const state = new Map<string, number>(nodeIds.map((id) => [id, WHITE]));
  const back = new Set<string>();
  for (const root of nodeIds) {
    if (state.get(root) !== WHITE) continue;
    state.set(root, GRAY);
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const children = out.get(top.id) ?? [];
      if (top.next < children.length) {
        const child = children[top.next];
        top.next++;
        if (child === undefined) continue;
        const colour = state.get(child) ?? WHITE;
        if (colour === GRAY) back.add(edgeKey(top.id, child));
        else if (colour === WHITE) {
          state.set(child, GRAY);
          stack.push({ id: child, next: 0 });
        }
      } else {
        state.set(top.id, BLACK);
        stack.pop();
      }
    }
  }

  const forward = new Map<string, string[]>();
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (const id of nodeIds) forward.set(id, []);
  for (const [from, children] of out) {
    for (const to of children) {
      if (back.has(edgeKey(from, to))) continue;
      forward.get(from)?.push(to);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }
  }

  const ranks = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const queue = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (id === undefined) continue;
    const here = ranks.get(id) ?? 0;
    for (const child of forward.get(id) ?? []) {
      ranks.set(child, Math.max(ranks.get(child) ?? 0, here + 1));
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) queue.push(child);
    }
  }
  return ranks;
}

/** Box size from the label: the longest line sets the width, the count the height. */
function sizeOf(node: TokenNode): { w: number; h: number } {
  const lines = node.label.length > 0 ? node.label.split("\n") : [""];
  let longest = 0;
  for (const line of lines) longest = Math.max(longest, line.length);
  let w = longest * PX_PER_CHAR + WIDTH_PADDING;
  if (node.geo === "diamond") w *= DIAMOND_WIDTH_FACTOR;
  return {
    w: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w))),
    h: BASE_HEIGHT + EXTRA_LINE_HEIGHT * (lines.length - 1),
  };
}

/** Neighbour lists, deduplicated, for the barycentre sweeps. */
function neighboursOf(edges: PlanEdge[]): {
  preds: Map<string, string[]>;
  succs: Map<string, string[]>;
} {
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = edgeKey(edge.from, edge.to);
    if (seen.has(key) || edge.from === edge.to) continue;
    seen.add(key);
    const p = preds.get(edge.to);
    if (p) p.push(edge.from);
    else preds.set(edge.to, [edge.from]);
    const s = succs.get(edge.from);
    if (s) s.push(edge.to);
    else succs.set(edge.from, [edge.to]);
  }
  return { preds, succs };
}

/**
 * Order one rank by the average position of its neighbours in an adjacent one,
 * keeping subgraph members together: the subgraph is the primary sort key, so
 * a barycentre can move a group but never split it.
 */
function sortRank(
  row: string[],
  neighbourRow: string[],
  neighbours: Map<string, string[]>,
  subgraphOf: Map<string, string>,
): void {
  const at = new Map<string, number>();
  neighbourRow.forEach((id, index) => at.set(id, index));

  const groupAt = new Map<string, number>();
  for (const id of row) {
    const group = subgraphOf.get(id) ?? "";
    if (!groupAt.has(group)) groupAt.set(group, groupAt.size);
  }

  const bary = new Map<string, number>();
  row.forEach((id, index) => {
    let total = 0;
    let count = 0;
    for (const other of neighbours.get(id) ?? []) {
      const position = at.get(other);
      if (position !== undefined) {
        total += position;
        count++;
      }
    }
    bary.set(id, count > 0 ? total / count : index);
  });

  const index = new Map<string, number>();
  row.forEach((id, i) => index.set(id, i));
  row.sort((a, b) => {
    const ga = groupAt.get(subgraphOf.get(a) ?? "") ?? 0;
    const gb = groupAt.get(subgraphOf.get(b) ?? "") ?? 0;
    if (ga !== gb) return ga - gb;
    const ba = bary.get(a) ?? 0;
    const bb = bary.get(b) ?? 0;
    if (ba !== bb) return ba - bb;
    return (index.get(a) ?? 0) - (index.get(b) ?? 0);
  });
}

/** Rank rows in first-seen order, grouped by subgraph, then two barycentre sweeps. */
function orderRanks(nodes: TokenNode[], edges: PlanEdge[], ranks: Map<string, number>): string[][] {
  let maxRank = 0;
  for (const node of nodes) maxRank = Math.max(maxRank, ranks.get(node.id) ?? 0);
  const rows: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  const subgraphOf = new Map<string, string>();
  for (const node of nodes) {
    subgraphOf.set(node.id, node.subgraph ?? "");
    rows[ranks.get(node.id) ?? 0]?.push(node.id);
  }

  const { preds, succs } = neighboursOf(edges);
  const empty: string[] = [];
  // One sweep down, one back up. More passes stop paying for graphs this size.
  for (let r = 0; r <= maxRank; r++) {
    sortRank(rows[r] ?? empty, rows[r - 1] ?? empty, preds, subgraphOf);
  }
  for (let r = maxRank; r >= 0; r--) {
    sortRank(rows[r] ?? empty, rows[r + 1] ?? empty, succs, subgraphOf);
  }
  return rows;
}

/**
 * Parse a mermaid `flowchart` or `graph` into a {@link Plan}: nodes sized from
 * their labels and placed on a layered grid, edges with their labels and dashes,
 * subgraph membership, and every line the parser could not read.
 *
 * The same source always gives the same plan. The layout is deliberately plain;
 * the agent is expected to look at the result and nudge.
 *
 * @example
 * const plan = parseMermaid("flowchart LR\n  a[Start] --> b[Stop]")
 */
export function parseMermaid(source: string, opts: ParseMermaidOptions = {}): Plan {
  const tokens = tokenize(source);
  const direction = opts.direction ?? tokens.direction;
  const origin = opts.origin ?? DEFAULT_ORIGIN;
  const rankGap = opts.spacing?.rank ?? DEFAULT_RANK_GAP;
  const nodeGap = opts.spacing?.node ?? DEFAULT_NODE_GAP;
  const vertical = VERTICAL.has(direction);

  const ranks = rank(
    tokens.nodes.map((n) => n.id),
    tokens.edges,
  );
  const rows = orderRanks(tokens.nodes, tokens.edges, ranks);
  const sizes = new Map<string, { w: number; h: number }>();
  for (const node of tokens.nodes) sizes.set(node.id, sizeOf(node));

  const size = (id: string): { w: number; h: number } =>
    sizes.get(id) ?? { w: MIN_WIDTH, h: BASE_HEIGHT };
  const alongRank = (id: string): number => (vertical ? size(id).h : size(id).w);
  const alongSlot = (id: string): number => (vertical ? size(id).w : size(id).h);

  // Each rank gets a band as deep as its tallest node, so two ranks can never
  // touch however uneven the labels are.
  const bandDepth = rows.map((row) => row.reduce((deep, id) => Math.max(deep, alongRank(id)), 0));
  const slotSpan = rows.map((row) =>
    row.length === 0
      ? 0
      : row.reduce((total, id) => total + alongSlot(id), 0) + nodeGap * (row.length - 1),
  );
  const widest = slotSpan.reduce((most, span) => Math.max(most, span), 0);

  const visual = rows.map((_, index) => index);
  if (REVERSED.has(direction)) visual.reverse();
  const bandStart = new Map<number, number>();
  let cursor = 0;
  for (const r of visual) {
    bandStart.set(r, cursor);
    const depth = bandDepth[r] ?? 0;
    if (depth > 0) cursor += depth + rankGap;
  }

  const placed = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const start = bandStart.get(r) ?? 0;
    const depth = bandDepth[r] ?? 0;
    let slot = Math.round((widest - (slotSpan[r] ?? 0)) / 2);
    for (const id of row) {
      const { w, h } = size(id);
      const centred = Math.round((depth - alongRank(id)) / 2);
      const x = vertical ? origin.x + slot : origin.x + start + centred;
      const y = vertical ? origin.y + start + centred : origin.y + slot;
      placed.set(id, { x, y, w, h });
      slot += alongSlot(id) + nodeGap;
    }
  }

  const nodes: PlanNode[] = tokens.nodes.map((node) => {
    const box = placed.get(node.id) ?? { x: origin.x, y: origin.y, w: MIN_WIDTH, h: BASE_HEIGHT };
    const out: PlanNode = {
      id: node.id,
      label: node.label,
      geo: node.geo,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
    };
    if (node.rounded) out.rounded = true;
    if (node.subgraph !== undefined) out.subgraph = node.subgraph;
    return out;
  });

  return {
    direction,
    nodes,
    edges: tokens.edges,
    subgraphs: tokens.subgraphs,
    unsupported: tokens.unsupported,
  };
}
