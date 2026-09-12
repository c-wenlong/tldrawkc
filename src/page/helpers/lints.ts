/**
 * The lint pass, as pure functions over plain records.
 *
 * Nothing in this file imports `tldraw` or touches an `Editor`. A rule takes
 * arrays of shape-like and binding-like objects and returns findings, which is
 * what lets the unit suite run every rule in node with no browser
 * (ARCHITECTURE.md, "Testing"). The adapter that reads the live editor lives in
 * `helpers/index.ts`.
 *
 * Phase 1 ships one rule, `friendless-arrow`. The other five in HELPERS.md
 * arrive in phase 2 and land here beside it.
 */

/** A single finding. The bridge's `lints()` returns an array of these. */
export interface Lint {
  /** The rule that fired, e.g. `friendless-arrow`. */
  rule: string;
  /** Every shape the reader should look at. */
  shapeIds: string[];
  /** One sentence, addressed to whoever has to fix the diagram. */
  message: string;
}

/** The slice of a shape record the rules read. */
export interface LintShape {
  id: string;
  type: string;
  meta?: Record<string, unknown>;
}

/** The slice of a binding record the rules read. */
export interface LintBinding {
  type: string;
  fromId: string;
  toId: string;
  props?: { terminal?: string };
}

/** The rule names phase 1 knows about. Widened in phase 2. */
export const LINT_RULES = ["friendless-arrow"] as const;

/**
 * Is this rule muted on this shape?
 *
 * The opt-out is `meta.lintIgnore`, an array of rule names, which is what
 * `helpers.stub` sets on a decorative line (HELPERS.md). A bare `true` is
 * accepted as "mute everything" because it is the mistake an agent makes
 * first, and silently ignoring it would be worse than honouring it.
 */
export function isLintIgnored(shape: LintShape, rule: string): boolean {
  const ignore = shape.meta?.["lintIgnore"];
  if (ignore === true) return true;
  if (!Array.isArray(ignore)) return false;
  return ignore.includes(rule);
}

/**
 * `friendless-arrow`: an arrow with a loose end.
 *
 * An arrow is bound to a shape by an `arrow` binding whose `fromId` is the
 * arrow and whose `props.terminal` says which end. Two bindings, one `start`
 * and one `end`, is a fully attached arrow; anything less is a line pointing
 * at empty space, which is one of the two failure modes this tool exists to
 * catch (DECISIONS.md D10).
 */
export function friendlessArrows(
  shapes: readonly LintShape[],
  bindings: readonly LintBinding[],
): Lint[] {
  const terminalsByArrow = new Map<string, Set<string>>();
  for (const binding of bindings) {
    if (binding.type !== "arrow") continue;
    const terminal = binding.props?.terminal;
    if (terminal !== "start" && terminal !== "end") continue;
    let terminals = terminalsByArrow.get(binding.fromId);
    if (!terminals) {
      terminals = new Set<string>();
      terminalsByArrow.set(binding.fromId, terminals);
    }
    terminals.add(terminal);
  }

  const lints: Lint[] = [];
  for (const shape of shapes) {
    if (shape.type !== "arrow") continue;
    if (isLintIgnored(shape, "friendless-arrow")) continue;
    const terminals = terminalsByArrow.get(shape.id) ?? new Set<string>();
    const loose = (["start", "end"] as const).filter((t) => !terminals.has(t));
    if (loose.length === 0) continue;
    lints.push({
      rule: "friendless-arrow",
      shapeIds: [shape.id],
      message: `arrow ${shape.id} has no binding at its ${loose.join(" or ")}`,
    });
  }
  return lints;
}

/**
 * Run every rule and concatenate the findings.
 *
 * Order is rule by rule, and within a rule it follows the order the shapes
 * were given, so a caller that iterates the current page gets findings in
 * drawing order rather than a random one.
 */
export function runLints(
  shapes: readonly LintShape[],
  bindings: readonly LintBinding[],
): Lint[] {
  return [...friendlessArrows(shapes, bindings)];
}
