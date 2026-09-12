/**
 * What a diagram is about, carried inside the `.tldr` itself.
 *
 * A catalog has to answer "which diagram covers this topic" without opening a
 * browser and without guessing from the filename. tldraw gives every record a
 * `meta` bag, so the answer lives on the **document record** (`document:document`,
 * the singleton in every store) under one key, {@link META_KEY}:
 *
 * ```json
 * { "gridSize": 10, "name": "", "meta": { "tldrawkc": {
 *     "kc": 1, "title": "...", "topic": "...", "concepts": [], "source": "...", "created": "..."
 * } }, "id": "document:document", "typeName": "document" }
 * ```
 *
 * The document record rather than a page record, because a diagram is one
 * document (the skill's rule) while pages come and go, get renamed and get
 * reordered: metadata that hangs off page one would quietly change meaning the
 * first time someone adds a second page. It is reachable from both sides,
 * which is the other half of the choice: `editor.getDocumentSettings()` and
 * `updateDocumentSettings()` in the page, and a plain JSON record in the file,
 * so `list` and `meta set` never launch Chromium.
 *
 * `kc` is the schema version of the object, not a copy of the key. An indexer
 * reads it first and can refuse a shape it was not written against.
 *
 * The same rules exist a second time in `src/page/helpers/meta.ts`, because
 * layering rule 1 forbids this file from importing anything under `src/page/`.
 * `test/unit/meta.test.ts` runs both over one table of cases, so the two cannot
 * drift apart without a red test.
 */

import { UsageError } from "./errors.js";
import { readText, writeText } from "./files.js";
import { resolveTldrPath } from "./paths.js";

/** The key the metadata object sits under in the document record's `meta` bag. */
export const META_KEY = "tldrawkc";

/** The schema version this build writes. Read as `meta.kc`. */
export const META_VERSION = 1;

/**
 * What a topic or concept slug may look like.
 *
 * The vocabulary itself lives in the consuming repo (self-learn's
 * `content/topics.yaml`) and this tool cannot see it, so the check here is the
 * shape of a slug and not its membership: lower case, digits, single dashes.
 * That catches the mistake worth catching, which is a human title
 * ("Vector spaces") written where a slug belongs.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The document-level metadata, as every `--json` output reports it. */
export interface DiagramMeta {
  /** Schema version of this object. {@link META_VERSION} for anything this build wrote. */
  kc: number;
  /** A human title for the diagram. Free text, `""` when nobody set one. */
  title: string;
  /** One vocabulary slug. `""` when nobody set one, which is what `missing-topic` reports. */
  topic: string;
  /** Concept slugs under that topic, in the order they were given, deduplicated. */
  concepts: string[];
  /** What prompted the diagram: a session id, a note path, free text. */
  source: string;
  /** When the metadata was first written, ISO 8601. Never changed after that. */
  created: string;
}

/** A partial update. Absent fields are left as they were. */
export interface MetaPatch {
  title?: string | undefined;
  topic?: string | undefined;
  concepts?: readonly string[] | undefined;
  source?: string | undefined;
  /** Only used when there is nothing to preserve. Tests pass it; the CLI does not. */
  created?: string | undefined;
}

/** True when the patch would change nothing, so a command can say "no flags given". */
export function isEmptyPatch(patch: MetaPatch): boolean {
  return (
    patch.title === undefined &&
    patch.topic === undefined &&
    patch.concepts === undefined &&
    patch.source === undefined &&
    patch.created === undefined
  );
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Trim, drop blanks, keep the author's order, drop repeats. */
function asSlugList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const slug = asString(entry);
    if (slug !== "" && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * Read the metadata out of a document record's `meta` bag.
 *
 * Tolerant on purpose: a bag written by a future version, or by hand, should
 * come back with whatever fields it does have rather than throwing. `null`
 * means the key is absent or is not an object, which is the "no metadata"
 * case every caller has to handle anyway.
 */
export function readDocumentMeta(bag: unknown): DiagramMeta | null {
  if (typeof bag !== "object" || bag === null) return null;
  const held: unknown = (bag as Record<string, unknown>)[META_KEY];
  if (typeof held !== "object" || held === null || Array.isArray(held)) return null;
  const record = held as Record<string, unknown>;
  const version = record["kc"];
  return {
    kc: typeof version === "number" && Number.isFinite(version) ? version : META_VERSION,
    title: asString(record["title"]),
    topic: asString(record["topic"]),
    concepts: asSlugList(record["concepts"]),
    source: asString(record["source"]),
    created: asString(record["created"]),
  };
}

/**
 * Refuse a patch that cannot be right, before anything is written.
 *
 * Only the slugs are checked. `title` and `source` are free text by design:
 * `source` is "a session id, a note path, whatever prompted this", and a rule
 * about its shape would be this tool inventing one.
 */
export function validatePatch(patch: MetaPatch): void {
  if (patch.topic !== undefined) {
    const topic = patch.topic.trim();
    if (topic !== "" && !SLUG_PATTERN.test(topic)) {
      throw new UsageError(
        `--topic "${patch.topic}" is not a slug. Use lower case, digits and single dashes, ` +
          "and take the value from the shared vocabulary (content/topics.yaml in self-learn).",
      );
    }
  }
  for (const concept of patch.concepts ?? []) {
    const slug = concept.trim();
    if (slug !== "" && !SLUG_PATTERN.test(slug)) {
      throw new UsageError(
        `--concept "${concept}" is not a slug. Use lower case, digits and single dashes.`,
      );
    }
  }
}

/**
 * Fold a patch into whatever metadata is already there.
 *
 * `created` is written once and then preserved, which is what makes `meta set`
 * idempotent: running it twice with the same flags produces the same bytes.
 * Everything else is last write wins, and a field the patch does not mention
 * keeps its value.
 */
export function mergeDocumentMeta(
  current: DiagramMeta | null,
  patch: MetaPatch,
  nowIso: string,
): DiagramMeta {
  validatePatch(patch);
  const base: DiagramMeta = current ?? {
    kc: META_VERSION,
    title: "",
    topic: "",
    concepts: [],
    source: "",
    created: "",
  };
  const created = base.created !== "" ? base.created : (patch.created?.trim() ?? nowIso);
  return {
    kc: META_VERSION,
    title: patch.title === undefined ? base.title : patch.title.trim(),
    topic: patch.topic === undefined ? base.topic : patch.topic.trim(),
    concepts: patch.concepts === undefined ? base.concepts : asSlugList(patch.concepts),
    source: patch.source === undefined ? base.source : patch.source.trim(),
    created,
  };
}

// ---------------------------------------------------------------------------
// the file side
// ---------------------------------------------------------------------------

/** The `.tldr` envelope, as much of it as this module needs to know. */
interface TldrFile {
  records?: unknown;
  [key: string]: unknown;
}

/** The one record the metadata lives on. */
const DOCUMENT_TYPE = "document";

function parseFile(json: string, where: string): TldrFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new UsageError(`${where} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${where} is not a .tldr file: the top level is not an object.`);
  }
  const file = parsed as TldrFile;
  if (!Array.isArray(file.records)) {
    throw new UsageError(`${where} is not a .tldr file: it has no records array.`);
  }
  return file;
}

function documentRecordOf(file: TldrFile): Record<string, unknown> | null {
  for (const record of file.records as unknown[]) {
    if (typeof record !== "object" || record === null) continue;
    if ((record as Record<string, unknown>)["typeName"] === DOCUMENT_TYPE) {
      return record as Record<string, unknown>;
    }
  }
  return null;
}

/** What a reader can learn from a `.tldr` without opening a browser. */
export interface TldrFacts {
  meta: DiagramMeta | null;
  /**
   * Shape records in the file, across every page.
   *
   * Not the same number `inspect` prints, which counts the current page only.
   * This is an inventory figure: "is there anything in here".
   */
  shapes: number;
}

/** Read the metadata and the shape count straight out of the file's JSON. */
export function readTldrFacts(json: string, where = "the document"): TldrFacts {
  const file = parseFile(json, where);
  const document = documentRecordOf(file);
  let shapes = 0;
  for (const record of file.records as unknown[]) {
    if (typeof record !== "object" || record === null) continue;
    if ((record as Record<string, unknown>)["typeName"] === "shape") shapes += 1;
  }
  return { meta: document === null ? null : readDocumentMeta(document["meta"]), shapes };
}

/** The metadata in a `.tldr`'s JSON text, or `null` when it has none. */
export function readMeta(json: string, where = "the document"): DiagramMeta | null {
  return readTldrFacts(json, where).meta;
}

/**
 * Write a patch into a `.tldr`'s JSON text and hand back the new text.
 *
 * The file is parsed and re-serialised rather than edited as a string. A
 * `.tldr` is compact JSON with no whitespace, so the round trip is
 * byte-for-byte the same document apart from the bag that changed, and a
 * string edit on arbitrary nested JSON is the kind of clever that corrupts a
 * drawing.
 */
export function applyMeta(
  json: string,
  patch: MetaPatch,
  nowIso: string = new Date().toISOString(),
  where = "the document",
): { json: string; meta: DiagramMeta } {
  const file = parseFile(json, where);
  const document = documentRecordOf(file);
  if (document === null) {
    throw new UsageError(
      `${where} has no document record, so there is nowhere to put the metadata. ` +
        "Re-save it with tldrawkc, or create it with `tldrawkc new`.",
    );
  }
  const bag: Record<string, unknown> =
    typeof document["meta"] === "object" && document["meta"] !== null
      ? { ...(document["meta"] as Record<string, unknown>) }
      : {};
  const meta = mergeDocumentMeta(readDocumentMeta(bag), patch, nowIso);
  bag[META_KEY] = meta;
  document["meta"] = bag;
  return { json: JSON.stringify(file), meta };
}

export interface SetMetaOptions {
  /** The `.tldr` to stamp. */
  file: string;
  patch: MetaPatch;
  cwd?: string | undefined;
  /** Injected by the tests so a written `created` is predictable. */
  now?: Date | undefined;
}

export interface SetMetaResult {
  file: string;
  meta: DiagramMeta;
  /** False when the file already said exactly this, so nothing was rewritten. */
  changed: boolean;
  ms: number;
}

/**
 * `meta set`: stamp an existing document without opening a browser.
 *
 * Backfill is the job. Every diagram drawn before this command existed has no
 * topic, and re-rendering each one through Chromium to add six strings would
 * be a browser launch per file for a change tldraw never needs to see. Idempotent:
 * a second identical call leaves the file untouched and reports `changed: false`.
 */
export async function setMeta(options: SetMetaOptions): Promise<SetMetaResult> {
  const started = Date.now();
  const file = resolveTldrPath(options.file, options.cwd);
  if (isEmptyPatch(options.patch)) {
    throw new UsageError(
      "meta set needs at least one of --topic, --title, --concept or --source.",
    );
  }
  validatePatch(options.patch);
  const existing = await readText(file);
  if (existing === null) throw new UsageError(`${file} does not exist.`);

  const now = (options.now ?? new Date()).toISOString();
  const { json, meta } = applyMeta(existing, options.patch, now, file);
  const changed = json !== existing;
  if (changed) await writeText(file, json);
  return { file, meta, changed, ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// the SVG side
// ---------------------------------------------------------------------------

/** The attribute the exported SVG carries its topic in. */
export const SVG_TOPIC_ATTRIBUTE = "data-kc-topic";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Copy the title and topic onto an exported SVG.
 *
 * The `.tldr` is the source of truth (DECISIONS.md D8) and the SVG is derived,
 * but the SVG is the file that gets embedded in a note and mailed around, so it
 * should be able to say what it is about on its own. `<title>` is the standard
 * accessible name for an SVG and is what a screen reader announces;
 * `data-kc-topic` on the root is the machine-readable half.
 *
 * A document with no metadata, or with neither a title nor a topic, comes back
 * untouched: an empty `<title>` is worse than none, because it overrides the
 * filename a reader would otherwise fall back to.
 */
export function stampSvg(svg: string, meta: DiagramMeta | null): string {
  if (meta === null) return svg;
  if (meta.title === "" && meta.topic === "") return svg;

  const open = /<svg\b[^>]*>/i.exec(svg);
  if (!open) return svg;
  const tag = open[0];
  const end = open.index + tag.length;

  let head = tag;
  if (meta.topic !== "" && !new RegExp(`\\b${SVG_TOPIC_ATTRIBUTE}=`, "i").test(tag)) {
    // Before the closing bracket, and before a self-closing slash if there is
    // one, so an empty `<svg/>` stays well formed.
    head = tag.replace(
      /\s*\/?>$/,
      (close) => ` ${SVG_TOPIC_ATTRIBUTE}="${escapeXml(meta.topic)}"${close.trimStart()}`,
    );
  }

  const title =
    meta.title === "" || /<title[\s>]/i.test(svg)
      ? ""
      : `<title>${escapeXml(meta.title)}</title>`;

  return `${head}${title}${svg.slice(end)}`;
}
