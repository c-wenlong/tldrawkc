/**
 * Layering rule 1, as a test.
 *
 * "`src/lib/` and `src/cli/` never import `tldraw`, `react` or `src/page/`.
 * Those live only in the page bundle. A grep for `from "tldraw"` outside
 * `src/page/` is a failing test." (ARCHITECTURE.md)
 *
 * The point is that the tool can be dropped into any repo without dragging
 * React into its dependency tree, and that `dist/lib` stays importable from
 * a plain Node process.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import { PACKAGE_ROOT } from "../../src/lib/paths.js";

/** Packages the node side must never reach for. */
const FORBIDDEN = ["tldraw", "react", "react-dom", "@tldraw/editor", "@tldraw/assets"];

/** `from "x"`, `from 'x'`, `import("x")` and `require("x")`, plus subpaths. */
function importsOf(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) found.push(specifier);
    }
  }
  return found;
}

async function tsFilesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await tsFilesUnder(full)));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(full);
  }
  return files;
}

function isForbidden(specifier: string): boolean {
  if (specifier.includes("src/page") || specifier.includes("/page/")) return true;
  return FORBIDDEN.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
}

describe("layering rule 1", () => {
  it("keeps tldraw, react and the page out of src/lib and src/cli", async () => {
    const roots = [path.join(PACKAGE_ROOT, "src", "lib"), path.join(PACKAGE_ROOT, "src", "cli")];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of await tsFilesUnder(root)) {
        const source = await fs.readFile(file, "utf8");
        for (const specifier of importsOf(source)) {
          if (isForbidden(specifier)) {
            offenders.push(`${path.relative(PACKAGE_ROOT, file)} imports "${specifier}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("would catch an offender", () => {
    // Guards the matcher itself: a rule that never fires is not a rule.
    expect(isForbidden("tldraw")).toBe(true);
    expect(isForbidden("react")).toBe(true);
    expect(isForbidden("@tldraw/editor")).toBe(true);
    expect(isForbidden("../page/bridge.js")).toBe(true);
    expect(isForbidden("playwright-core")).toBe(false);
    expect(isForbidden("./paths.js")).toBe(false);
  });
});

describe("dependencies", () => {
  it("keeps tldraw and react out of the runtime dependencies", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "playwright-core",
      "subset-font",
    ]);
  });
});
