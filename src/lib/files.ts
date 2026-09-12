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

/** Options for {@link writeAtomic}. */
export interface WriteOptions {
  /**
   * Refuse to replace an existing `target`, raising `EEXIST`.
   *
   * `rename` replaces whatever is there, so a command that checked for the
   * file before doing a second of work has only checked, not claimed. `link`
   * is the exclusive equivalent: it fails when the target exists, and it is
   * still one atomic publication of a fully written file.
   */
  exclusive?: boolean | undefined;
}

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
  options: WriteOptions = {},
): Promise<string> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = tempSiblingPath(target);
  try {
    await fs.writeFile(temp, data);
    if (options.exclusive) await publishExclusive(temp, target);
    else await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  return target;
}

/**
 * Publish `temp` as `target` only if nothing is there, then drop `temp`.
 *
 * Hard links are the exclusive publication primitive POSIX offers. A
 * filesystem that has none (an exFAT stick, say) answers `EPERM` or
 * `ENOTSUP`, and there the best available answer is the ordinary rename after
 * one more look: the race window comes back, but refusing to create a file on
 * a USB drive would be a worse trade.
 */
async function publishExclusive(temp: string, target: string): Promise<void> {
  try {
    await fs.link(temp, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") {
      throw error;
    }
    if (await modifiedAt(target) !== null) {
      const exists: NodeJS.ErrnoException = new Error(`EEXIST: ${target} already exists`);
      exists.code = "EEXIST";
      throw exists;
    }
    await fs.rename(temp, target);
    return;
  }
  await fs.rm(temp, { force: true });
}

/** Write UTF-8 text atomically. `.tldr` and `.svg` both come through here. */
export async function writeText(
  target: string,
  text: string,
  options: WriteOptions = {},
): Promise<string> {
  return writeAtomic(target, text, options);
}

/** Did this error come from an exclusive write losing the race? */
export function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
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
