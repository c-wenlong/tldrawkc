/**
 * The document metadata rules, page side.
 *
 * This is the same contract as `src/lib/meta.ts`: one object under
 * {@link META_KEY} in the document record's `meta` bag, holding
 * `{ kc, title, topic, concepts, source, created }`. That file explains the
 * shape and why it hangs off the document record; read it first.
 *
 * It exists twice because layering rule 1 forbids `src/lib/` from importing
 * anything under `src/page/`, and the page has to be able to amend the bag
 * while a snippet is running. Rather than let two half-agreeing copies drift,
 * `test/unit/meta.test.ts` imports both and runs them over one table of cases,
 * so a change to either that the other does not make is a red test.
 *
 * Nothing here touches an `Editor`, which is what keeps it unit testable in
 * node next to the lint rules.
 */

/**
 * JSON, as tldraw's own `JsonObject` means it.
 *
 * Declared here rather than imported from `tldraw` so this module stays free
 * of that import and keeps running in the node unit suite next to the lint
 * rules. It is structurally the same type, which is what lets the result go
 * straight into `editor.updateDocumentSettings`.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A record's `meta` bag. */
export type JsonBag = { [key: string]: JsonValue };

/** The key the metadata object sits under in the document record's `meta` bag. */
export const META_KEY = "tldrawkc";

/** The schema version this build writes. Read as `meta.kc`. */
export const META_VERSION = 1;

/** What a topic or concept slug may look like. See `src/lib/meta.ts`. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The document-level metadata, as `inspect` and `helpers.meta` report it. */
export interface DiagramMeta {
  kc: number;
  title: string;
  topic: string;
  concepts: string[];
  source: string;
  created: string;
}

/** A partial update. Absent fields are left as they were. */
export interface MetaPatch {
  title?: string | undefined;
  topic?: string | undefined;
  concepts?: readonly string[] | undefined;
  source?: string | undefined;
  created?: string | undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asSlugList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const slug = asString(entry);
    if (slug !== "" && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/** Read the metadata out of a document record's `meta` bag. `null` when it has none. */
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

/** Refuse a patch whose slugs are not slugs, before anything is written. */
export function validatePatch(patch: MetaPatch): void {
  if (patch.topic !== undefined) {
    const topic = patch.topic.trim();
    if (topic !== "" && !SLUG_PATTERN.test(topic)) {
      throw new Error(
        `tldrawkc: topic "${patch.topic}" is not a slug. Use lower case, digits and ` +
          "single dashes, from the shared vocabulary.",
      );
    }
  }
  for (const concept of patch.concepts ?? []) {
    const slug = concept.trim();
    if (slug !== "" && !SLUG_PATTERN.test(slug)) {
      throw new Error(`tldrawkc: concept "${concept}" is not a slug.`);
    }
  }
}

/**
 * Refuse to rewrite metadata a newer tldrawkc wrote. See `src/lib/meta.ts`:
 * this build emits the six fields it knows, so folding a patch into a newer
 * object would drop what that version added and stamp the result as this one.
 */
function refuseNewerSchema(current: DiagramMeta | null): void {
  if (current !== null && current.kc > META_VERSION) {
    throw new Error(
      `tldrawkc: this document's metadata is version ${String(current.kc)} and this ` +
        `page writes version ${String(META_VERSION)}. Update tldrawkc rather than ` +
        "letting a snippet drop what the newer version added.",
    );
  }
}

/**
 * Fold a patch into whatever metadata is already there.
 *
 * `created` is written once and then preserved, so amending a diagram never
 * moves the date it was first described.
 */
export function mergeDocumentMeta(
  current: DiagramMeta | null,
  patch: MetaPatch,
  nowIso: string,
): DiagramMeta {
  validatePatch(patch);
  refuseNewerSchema(current);
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

/**
 * The new `meta` bag for a document record, given the old one and a patch.
 *
 * Everything else in the bag is copied through: the bag belongs to the
 * document, not to this tool, and something else may be keeping notes in it.
 */
export function patchedBag(
  bag: unknown,
  patch: MetaPatch,
  nowIso: string,
): { bag: JsonBag; meta: DiagramMeta } {
  const next: JsonBag = typeof bag === "object" && bag !== null ? { ...(bag as JsonBag) } : {};
  const meta = mergeDocumentMeta(readDocumentMeta(next), patch, nowIso);
  next[META_KEY] = { ...meta };
  return { bag: next, meta };
}
