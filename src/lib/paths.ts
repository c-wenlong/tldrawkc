/**
 * Every path the tool computes.
 *
 * Layering rule 4: nothing outside this module builds a path. Output
 * locations, temp files and the state of `dist/` all resolve here, so there
 * is exactly one place to look when something lands in the wrong directory.
 */

import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * The root of the tldrawkc package.
 *
 * This module sits at `src/lib/paths.ts` in the source tree and at
 * `dist/lib/paths.js` once built, so the root is two directories up in both
 * cases. `test/unit/paths.test.ts` asserts that, so a future move of either
 * file fails a test rather than silently resolving to the wrong place.
 */
export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Where `npm run build` puts everything. */
export const DIST_DIR = path.join(PACKAGE_ROOT, "dist");

/** The built browser bundle the headless page is served from. */
export const PAGE_DIST_DIR = path.join(DIST_DIR, "page");

/** The page's entry document. `doctor` checks this one file. */
export const PAGE_INDEX_HTML = path.join(PAGE_DIST_DIR, "index.html");

/** The page sources the built bundle is compared against for staleness. */
export const PAGE_SRC_DIR = path.join(PACKAGE_ROOT, "src", "page");

/** The compiled CLI entry point, the thing `bin/tldrawkc` executes. */
export const CLI_ENTRY = path.join(DIST_DIR, "cli", "index.js");

/**
 * Resolve a user-supplied `.tldr` path against a working directory.
 *
 * Relative paths resolve from the caller's cwd, per CLI.md. The extension is
 * not enforced: refusing an unusual name would be a new rule the spec does
 * not have.
 */
export function resolveTldrPath(input: string, cwd: string = process.cwd()): string {
  return path.resolve(cwd, input);
}

/**
 * Where a screenshot goes when the caller did not ask for a location.
 *
 * PNGs are for an agent to look at, not for committing, so they land in the
 * system temp directory rather than next to the source file. The name carries
 * the document's basename and a timestamp so two runs never collide and a
 * stray file says which diagram it came from.
 */
export function tempShotPath(
  tldrPath: string,
  now: Date = new Date(),
  tmpDir: string = os.tmpdir(),
): string {
  const base = path.basename(tldrPath, path.extname(tldrPath)) || "canvas";
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(tmpDir, `tldrawkc-${base}-${stamp}.png`);
}

/**
 * The sibling temp file an atomic write goes through.
 *
 * Same directory as the target, because `rename` is only atomic within one
 * filesystem. See `files.ts`.
 *
 * The name carries a random component, not just the pid and the clock. Two
 * writes to the same target from one process inside the same millisecond
 * would otherwise pick the same temp file, overwrite each other's bytes and
 * race to rename it: one call fails with ENOENT and the other publishes the
 * wrong contents. `serve` writing while a `run` finishes is exactly that
 * shape, so the collision is not hypothetical.
 */
export function tempSiblingPath(target: string, suffix: string = ""): string {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const unique = `${process.pid.toString(36)}-${randomUUID()}${suffix}`;
  return path.join(dir, `.${base}.${unique}.tmp`);
}

/**
 * Where an `--shot`, `--svg` or `-o` argument lands.
 *
 * The same resolution as a `.tldr` path, under its own name because the two
 * have different rules about existing: a source file has to be there already
 * and an output file must not be assumed to be.
 */
export function resolveOutputPath(input: string, cwd: string = process.cwd()): string {
  return path.resolve(cwd, input);
}

/**
 * The throwaway file `doctor`'s write-access check creates.
 *
 * In the working directory rather than the system temp directory, because the
 * question the check answers is "can this tool save a diagram where the caller
 * is standing", and `/tmp` being writable says nothing about that.
 */
export function doctorProbePath(cwd: string = process.cwd()): string {
  return path.join(cwd, `.tldrawkc-write-check-${randomUUID()}`);
}
