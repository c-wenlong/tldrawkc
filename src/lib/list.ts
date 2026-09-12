/**
 * `list`: every diagram in a directory, as data.
 *
 * The catalog indexer that reads this used to glob `learn/assets/*.tldr` and
 * infer the subject from the filename stem. Globbing is the thing the plan
 * forbids ("agents read catalogs through `--json` CLIs"), and a stem is not a
 * topic. One command that walks the directory once, parses each file once and
 * reports the pairing, the metadata, the size and the mtime replaces both.
 *
 * No browser. Everything here is `fs` plus `JSON.parse`, which is what makes
 * it cheap enough to run on every index and safe to run on a machine with no
 * Chromium. That is also why it lives beside `canvas.ts` rather than in it:
 * every verb in that file goes through `withCanvas`, and this one must not.
 *
 * A file that will not parse is reported, never thrown past. One corrupt
 * `.tldr` in a directory of thirty is a line in `errors`, not an exit code:
 * the caller asked what is in the directory, and "these twenty-nine, and this
 * one is broken" is the honest answer.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { readText } from "./files.js";
import { readTldrFacts, type DiagramMeta } from "./meta.js";
import { DEFAULT_LIST_DIR, relativeToDir, resolveListDir, siblingPath } from "./paths.js";
import { UsageError } from "./errors.js";

/** A file that may or may not be beside the document. */
export interface SiblingFile {
  path: string;
  exists: boolean;
}

/** One `.tldr` and everything a catalog wants to know about it. */
export interface DiagramEntry {
  /** Absolute path of the `.tldr`, as every other command reports paths. */
  path: string;
  /** The path relative to the directory that was listed, for display and for a key. */
  relative: string;
  /** The filename stem, which is the concept id in the self-learn layout. */
  name: string;
  /** The document metadata, or `null` when nobody has stamped it. */
  meta: DiagramMeta | null;
  /** Shape records in the file, across every page. */
  shapes: number;
  /** The exported SVG that should sit beside it (DECISIONS.md D8). */
  svg: SiblingFile;
  /** A PNG beside it. Never committed, so `exists` is usually false. */
  png: SiblingFile;
  /** Last modified, ISO 8601. */
  modified: string;
}

/** A file that could not be read or parsed. */
export interface DiagramError {
  path: string;
  relative: string;
  message: string;
}

export interface ListOptions {
  /** The directory to walk. Defaults to `learn/assets` under `cwd`. */
  dir?: string | undefined;
  cwd?: string | undefined;
}

export interface ListResult {
  /** The absolute directory that was walked. */
  dir: string;
  diagrams: DiagramEntry[];
  errors: DiagramError[];
  ms: number;
}

/** Directories that are never a place a diagram lives. */
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist"]);

/**
 * Every `.tldr` under `dir`, depth first, sorted by the caller afterwards.
 *
 * Recursive, because nothing stops a repo from filing diagrams by domain, and
 * a `list` that silently ignored a subdirectory would be worse than one that
 * takes an extra millisecond. Dot directories and build output are skipped:
 * a `.tldr` in `node_modules` is not this repo's diagram.
 */
async function tldrFilesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await tldrFilesUnder(full)));
    } else if (entry.isFile() && entry.name.endsWith(".tldr") && !entry.name.startsWith(".")) {
      files.push(full);
    }
  }
  return files;
}

async function sibling(file: string, extension: string): Promise<SiblingFile> {
  const target = siblingPath(file, extension);
  try {
    const stat = await fs.stat(target);
    return { path: target, exists: stat.isFile() };
  } catch {
    return { path: target, exists: false };
  }
}

/**
 * Walk a directory of diagrams.
 *
 * A missing directory is a usage error, because the caller named it (or took
 * the default and is standing somewhere without one) and an empty list would
 * read as "no diagrams" rather than "no such place".
 */
export async function list(options: ListOptions = {}): Promise<ListResult> {
  const started = Date.now();
  const dir = resolveListDir(options.dir, options.cwd);

  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new UsageError(
      `${dir} does not exist. Name a directory, or run this from a repo with a ${DEFAULT_LIST_DIR}.`,
    );
  }
  if (!stat.isDirectory()) throw new UsageError(`${dir} is not a directory.`);

  const diagrams: DiagramEntry[] = [];
  const errors: DiagramError[] = [];

  for (const file of await tldrFilesUnder(dir)) {
    const relative = relativeToDir(dir, file);
    try {
      const json = await readText(file);
      if (json === null) {
        // It was there a moment ago. Report it rather than pretending.
        errors.push({ path: file, relative, message: "disappeared while listing" });
        continue;
      }
      const facts = readTldrFacts(json, file);
      diagrams.push({
        path: file,
        relative,
        name: path.basename(file, ".tldr"),
        meta: facts.meta,
        shapes: facts.shapes,
        svg: await sibling(file, ".svg"),
        png: await sibling(file, ".png"),
        modified: new Date((await fs.stat(file)).mtimeMs).toISOString(),
      });
    } catch (error) {
      errors.push({
        path: file,
        relative,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Sorted by path so two runs over the same directory produce the same
  // bytes, which is what lets a caller diff one index against the next.
  diagrams.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  errors.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { dir, diagrams, errors, ms: Date.now() - started };
}
