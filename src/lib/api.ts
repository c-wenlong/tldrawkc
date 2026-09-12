/**
 * The helper reference, pulled out of the page's own JSDoc.
 *
 * `tldrawkc api` has to print what a snippet can call, and the only way that
 * stays true is to generate it from the source the snippet calls into. So this
 * module reads `src/page/helpers/` as **text** at build time and writes
 * `dist/api.json`; the `api` command then prints that file.
 *
 * Reading the page's sources is fine, importing them is not (layering rule 1:
 * nothing in `src/lib` or `src/cli` pulls in `tldraw`, `react` or `src/page/`).
 * A parser over text keeps the node build free of the page's dependency tree
 * and keeps this module unit testable without a browser.
 *
 * The convention the page side has to keep to is small:
 *
 *   1. A `/** ... *\/` block sits **directly** above the declaration, with no
 *      blank line between them.
 *   2. The declaration is a named function (`function name(`, optionally
 *      `export` and/or `async`, at any indentation) or an interface method
 *      signature (`name(...): Type;`).
 *   3. The block carries an `@example`. Without one the entry is not printed,
 *      because a reference line an agent cannot copy is not a reference.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { writeText } from "./files.js";
import { API_JSON, API_SOURCE_FILES, PACKAGE_ROOT } from "./paths.js";
import { UsageError } from "./errors.js";

/** One documented helper, as `dist/api.json` stores it and `api` prints it. */
export interface HelperDoc {
  /** The name a snippet calls, e.g. `box`. */
  name: string;
  /** `function` for a declaration, `method` for an interface member. */
  kind: "function" | "method";
  /** The file it came from, relative to the package root. */
  path: string;
  /** The declaration as written, whitespace collapsed, body and `;` removed. */
  signature: string;
  /** The first paragraph of the block, as one line. */
  summary: string;
  /** One entry per `@example` tag, its lines joined with newlines. */
  examples: string[];
  /** One entry per `@param` tag, the tag itself stripped. */
  params: string[];
}

/** A source file as the extractor sees it: a label and its text. */
export interface SourceFile {
  /** Used verbatim as `HelperDoc.path`, so pass something readable. */
  path: string;
  text: string;
}

/**
 * Words that open a parenthesis but are not a method. Without this list
 * `if (ready) {` directly under a block comment would be read as a helper
 * called `if`.
 */
const NOT_A_NAME = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "new",
  "constructor",
  "do",
  "else",
  "typeof",
  "await",
  "yield",
]);

/** `export function name(`, with `export` and `async` both optional. */
const FUNCTION_DECLARATION = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;

/** `name(` on its own, which inside an interface is a method signature. */
const METHOD_SIGNATURE = /^\s*([A-Za-z_$][\w$]*)\s*\(/;

/**
 * Read every JSDoc block that documents a function or a method.
 *
 * Pure: it takes text and returns data, so the whole convention above is
 * checkable in a unit test with no filesystem and no browser.
 */
export function extractHelperDocs(files: readonly SourceFile[]): HelperDoc[] {
  const docs: HelperDoc[] = [];
  for (const file of files) docs.push(...docsInFile(file));
  return docs;
}

function docsInFile(file: SourceFile): HelperDoc[] {
  const docs: HelperDoc[] = [];
  const text = file.text;
  let cursor = 0;

  while (cursor < text.length) {
    const open = text.indexOf("/**", cursor);
    if (open === -1) break;
    const close = text.indexOf("*/", open + 3);
    if (close === -1) break;
    cursor = close + 2;

    const block = text.slice(open + 3, close);
    // Everything after the closing `*/` on that same line, then the rest.
    const rest = text.slice(close + 2);
    const declaration = declarationAfter(rest);
    if (!declaration) continue;

    const parsed = parseDeclaration(declaration);
    if (!parsed) continue;

    const tags = parseBlock(block);
    docs.push({
      name: parsed.name,
      kind: parsed.kind,
      path: file.path,
      signature: parsed.signature,
      summary: tags.summary,
      examples: tags.examples,
      params: tags.params,
    });
  }
  return docs;
}

/**
 * The declaration text directly under a block, or `null`.
 *
 * "Directly" is the whole rule: a blank line between the comment and the code
 * means the comment belongs to the file or to a section, not to the next
 * function, and picking it up anyway is how a generated reference fills with
 * prose that documents nothing.
 */
function declarationAfter(rest: string): string | null {
  // The remainder of the line the block closed on has to be empty.
  const firstBreak = rest.indexOf("\n");
  if (firstBreak === -1) return null;
  if (rest.slice(0, firstBreak).trim() !== "") return null;

  const after = rest.slice(firstBreak + 1);
  const nextBreak = after.indexOf("\n");
  const firstLine = nextBreak === -1 ? after : after.slice(0, nextBreak);
  if (firstLine.trim() === "") return null;

  // Enough text for a signature that wraps over several lines, and no more.
  return after.slice(0, 4000);
}

interface ParsedDeclaration {
  name: string;
  kind: "function" | "method";
  signature: string;
}

/**
 * Read a declaration down to the start of its body.
 *
 * The parameter list is scanned by depth rather than by looking for the next
 * `{`, because a default value (`opts: BoxOptions = {}`) puts a brace inside
 * the parentheses and a naive cut would lose half the signature.
 */
function parseDeclaration(source: string): ParsedDeclaration | null {
  const asFunction = FUNCTION_DECLARATION.exec(source);
  const asMethod = asFunction ? null : METHOD_SIGNATURE.exec(source);
  const match = asFunction ?? asMethod;
  if (!match) return null;

  const name = match[1];
  if (name === undefined || NOT_A_NAME.has(name)) return null;

  const openParen = source.indexOf("(", match.index + match[0].length - 1);
  if (openParen === -1) return null;
  const closeParen = matchingParen(source, openParen);
  if (closeParen === -1) return null;

  // Everything between the closing parenthesis and the body or the semicolon
  // is the return type, if the declaration has one.
  const tail = source.slice(closeParen + 1);
  const end = returnTypeEnd(tail);
  const returnType = (end === -1 ? tail : tail.slice(0, end)).trim();
  if (returnType !== "" && !returnType.startsWith(":")) return null;

  // A method signature has no body, so `;` is what terminates it. Requiring
  // that for the method form is what keeps `if (x) {` out of the reference.
  const terminator = end === -1 ? "" : (tail[end] ?? "");
  const kind: "function" | "method" = asFunction ? "function" : "method";
  if (kind === "method" && terminator !== ";" && terminator !== "{") return null;

  const parameters = source.slice(openParen, closeParen + 1);
  const signature = collapse(`${name}${parameters}${returnType}`);
  return { name, kind, signature };
}

/**
 * Characters a `{` can legally follow inside a type, as opposed to opening a
 * body. `attribute` returns `{ textId: TLShapeId; lineId: TLShapeId }`, so the
 * brace right after the `:` belongs to the type; the one after the closing `}`
 * is the function body.
 */
const TYPE_CONTINUES = new Set([":", "|", "&", "<", ",", "(", "["]);

/**
 * Where a declaration's return type stops: the index of the `;` that ends a
 * method signature or the `{` that opens a body, or -1 for neither.
 *
 * Cutting at the first `{` instead would truncate an object return type to a
 * bare colon, which is what `helpers.attribute` printed before this existed.
 */
function returnTypeEnd(tail: string): number {
  let depth = 0;
  let previous = "";
  let beforePrevious = "";
  for (let i = 0; i < tail.length; i += 1) {
    const character = tail[i] ?? "";
    if (/\s/.test(character)) continue;
    if (character === "}") {
      if (depth > 0) depth -= 1;
    } else if (character === "{") {
      // A lone `>` closes a generic (`Promise<Imported>`) and the brace after
      // it is the body; only the `>` of an arrow keeps the type going.
      const afterArrow = previous === ">" && beforePrevious === "=";
      if (depth === 0 && !afterArrow && !TYPE_CONTINUES.has(previous)) return i;
      depth += 1;
    } else if (character === ";" && depth === 0) {
      return i;
    }
    beforePrevious = previous;
    previous = character;
  }
  return -1;
}

/** The index of the `)` that closes the `(` at `from`, or -1. */
function matchingParen(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const character = source[i];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Newlines and runs of spaces become single spaces, so a signature is one line.
 *
 * The trailing comma goes too: it is how a multi-line parameter list is written
 * and it is a syntax error on one line, and the point of the reference is a
 * line an agent can copy.
 */
function collapse(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/,\s*\)/g, ")")
    .replace(/\s+\)/g, ")")
    .trim();
}

interface BlockTags {
  summary: string;
  examples: string[];
  params: string[];
}

/**
 * Strip the comment furniture and split the block into its parts.
 *
 * The summary is the first paragraph, which is the sentence an agent reads
 * when it is scanning; everything after the first blank line is the "why",
 * which belongs in the source and not in a printed reference.
 */
function parseBlock(block: string): BlockTags {
  const lines = block.split("\n").map(stripCommentFurniture);

  const summaryLines: string[] = [];
  const examples: string[][] = [];
  const params: string[] = [];
  let mode: "summary" | "body" | "example" = "summary";

  for (const line of lines) {
    const trimmed = line.trim();

    const tag = /^@(\w+)[ \t]*(.*)$/.exec(trimmed);
    if (tag) {
      const name = tag[1] ?? "";
      const rest = tag[2] ?? "";
      if (name === "example") {
        mode = "example";
        examples.push(rest === "" ? [] : [rest]);
      } else {
        mode = "body";
        if (name === "param" && rest !== "") params.push(rest);
      }
      continue;
    }

    if (mode === "summary") {
      // The first blank line ends the summary. What follows it is the "why",
      // which belongs in the source rather than in a printed reference.
      if (trimmed === "") {
        if (summaryLines.length > 0) mode = "body";
        continue;
      }
      summaryLines.push(trimmed);
      continue;
    }

    if (mode === "example") {
      const current = examples[examples.length - 1];
      if (!current) continue;
      // Leading blank lines are furniture; later ones are the author's spacing.
      if (trimmed === "" && current.length === 0) continue;
      current.push(line);
    }
  }

  return {
    summary: summaryLines.join(" ").trim(),
    examples: examples
      .map((lines_) => lines_.join("\n").trim())
      .filter((example) => example !== ""),
    params,
  };
}

/** Drop the leading whitespace and the `*` a JSDoc line starts with. */
function stripCommentFurniture(line: string): string {
  return line.replace(/^[ \t]*\*[ ]?/, "").trimEnd();
}

// ---------------------------------------------------------------------------
// The build step and the reader
// ---------------------------------------------------------------------------

/**
 * Read the page sources the reference is generated from.
 *
 * `API_SOURCE_FILES` is the list, and it lives in `paths.ts` like every other
 * location this tool computes (layering rule 4).
 */
export async function readApiSources(files: readonly string[] = API_SOURCE_FILES): Promise<SourceFile[]> {
  const sources: SourceFile[] = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    sources.push({ path: path.relative(PACKAGE_ROOT, file), text });
  }
  return sources;
}

/**
 * Keep the entries that are actually a reference, one per name.
 *
 * An `@example` is required, because the point of the printed reference is a
 * line an agent can copy. When a name is documented twice (the `Helpers`
 * interface member and the function inside the factory, say) the function
 * wins: it is the implementation, so it cannot drift from what runs.
 */
export function selectHelperDocs(docs: readonly HelperDoc[]): HelperDoc[] {
  const byName = new Map<string, HelperDoc>();
  for (const doc of docs) {
    if (doc.examples.length === 0) continue;
    const existing = byName.get(doc.name);
    if (!existing || (existing.kind === "method" && doc.kind === "function")) {
      byName.set(doc.name, doc);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface BuildApiResult {
  /** Where the JSON went. */
  path: string;
  /** How many helpers it documents. */
  count: number;
  /** Their names, in the order they are stored. */
  names: string[];
}

/**
 * Generate `dist/api.json`. Wired into `npm run build` as `build:api`.
 *
 * It runs between the node build and the page build, and it fails loudly on an
 * empty result: a reference with nothing in it means the convention above was
 * broken somewhere in `src/page/helpers/`, and shipping an empty `api` command
 * would hide that.
 */
export async function buildApiReference(options: { sources?: readonly string[]; target?: string } = {}): Promise<BuildApiResult> {
  const sources = await readApiSources(options.sources ?? API_SOURCE_FILES);
  const docs = selectHelperDocs(extractHelperDocs(sources));
  if (docs.length === 0) {
    throw new UsageError(
      "no documented helpers found. Every helper needs a /** */ block with an @example " +
        "directly above its declaration in src/page/helpers/index.ts.",
    );
  }
  const target = options.target ?? API_JSON;
  await writeText(target, `${JSON.stringify(docs, null, 2)}\n`);
  return { path: target, count: docs.length, names: docs.map((doc) => doc.name) };
}

/**
 * Read the generated reference back, for the `api` command.
 *
 * A missing file is a usage error rather than a crash, because the fix is one
 * command and the caller should be told which one.
 */
export async function readApiReference(target: string = API_JSON): Promise<HelperDoc[]> {
  let text: string;
  try {
    text = await fs.readFile(target, "utf8");
  } catch {
    throw new UsageError(`${target} is missing. Run \`npm run build\` to generate it.`);
  }
  try {
    return JSON.parse(text) as HelperDoc[];
  } catch (error) {
    throw new UsageError(`${target} is not readable JSON: ${(error as Error).message}`);
  }
}
