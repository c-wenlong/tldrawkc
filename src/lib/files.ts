/**
 * Every file write the tool makes.
 *
 * Layering rule 5: writes are atomic. They go to a sibling temp file and are
 * renamed over the target, so an interrupted run can never leave a truncated
 * `.tldr` behind. A half-written diagram is worse than no diagram: the
 * document is the only state this tool keeps.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { tempSiblingPath } from "./paths.js";

/**
 * Write bytes to `target` atomically.
 *
 * The temp file is a sibling rather than one in the system temp directory,
 * because `rename` is only atomic within a single filesystem. On failure the
 * temp file is removed; the target is left exactly as it was.
 */
export async function writeAtomic(
  target: string,
  data: string | Uint8Array,
): Promise<string> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = tempSiblingPath(target);
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  return target;
}

/** Write UTF-8 text atomically. `.tldr` and `.svg` both come through here. */
export async function writeText(target: string, text: string): Promise<string> {
  return writeAtomic(target, text);
}

/**
 * Write a PNG from the base64 string the page bridge hands back.
 *
 * A `data:` prefix is tolerated because that is what a browser `FileReader`
 * produces, and stripping it here means the bridge does not have to care.
 */
export async function writePng(target: string, base64: string): Promise<string> {
  const comma = base64.indexOf(",");
  const payload = base64.startsWith("data:") && comma !== -1
    ? base64.slice(comma + 1)
    : base64;
  return writeAtomic(target, Buffer.from(payload, "base64"));
}

/** Read UTF-8 text. Returns `null` when the file does not exist. */
export async function readText(source: string): Promise<string | null> {
  try {
    return await fs.readFile(source, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Modification time in milliseconds, or `null` when the path does not exist. */
export async function modifiedAt(target: string): Promise<number | null> {
  try {
    const stat = await fs.stat(target);
    return stat.mtimeMs;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * The newest mtime under a directory tree, or `null` for a missing tree.
 *
 * `doctor` uses it to decide whether `dist/page` is older than `src/page`.
 */
export async function newestMtime(dir: string): Promise<number | null> {
  let newest: number | null = null;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const value = entry.isDirectory() ? await newestMtime(full) : await modifiedAt(full);
    if (value !== null && (newest === null || value > newest)) newest = value;
  }
  return newest;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
