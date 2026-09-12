import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isAlreadyExists,
  modifiedAt,
  newestMtime,
  readText,
  writeAtomic,
  writePng,
  writeText,
} from "../../src/lib/files.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-files-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A 1x1 transparent PNG, the smallest real one. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("writeAtomic", () => {
  it("writes the file", async () => {
    const target = path.join(dir, "a.tldr");
    await writeAtomic(target, "hello");
    expect(await fs.readFile(target, "utf8")).toBe("hello");
  });

  it("creates missing parent directories", async () => {
    const target = path.join(dir, "deep", "deeper", "a.tldr");
    await writeAtomic(target, "hello");
    expect(await fs.readFile(target, "utf8")).toBe("hello");
  });

  it("leaves no temp file behind", async () => {
    await writeAtomic(path.join(dir, "a.tldr"), "hello");
    expect(await fs.readdir(dir)).toEqual(["a.tldr"]);
  });

  it("replaces an existing file rather than appending to it", async () => {
    const target = path.join(dir, "a.tldr");
    await writeAtomic(target, "first draft, longer");
    await writeAtomic(target, "second");
    expect(await fs.readFile(target, "utf8")).toBe("second");
  });

  it("leaves the target untouched and cleans up when the write fails", async () => {
    const target = path.join(dir, "a.tldr");
    await writeText(target, "original");
    // A directory in the target's place is the simplest way to make the
    // rename fail after the temp file has been written.
    const blocked = path.join(dir, "blocked.tldr");
    await fs.mkdir(blocked);
    await expect(writeAtomic(blocked, "nope")).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("original");
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("writePng", () => {
  it("decodes base64 into real PNG bytes", async () => {
    const target = path.join(dir, "shot.png");
    await writePng(target, PNG_BASE64);
    const bytes = await fs.readFile(target);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("tolerates a data: URL prefix", async () => {
    const plain = path.join(dir, "plain.png");
    const prefixed = path.join(dir, "prefixed.png");
    await writePng(plain, PNG_BASE64);
    await writePng(prefixed, `data:image/png;base64,${PNG_BASE64}`);
    expect(await fs.readFile(prefixed)).toEqual(await fs.readFile(plain));
  });
});

describe("readText", () => {
  it("round-trips text", async () => {
    const target = path.join(dir, "a.svg");
    await writeText(target, "<svg/>");
    expect(await readText(target)).toBe("<svg/>");
  });

  it("returns null for a missing file rather than throwing", async () => {
    expect(await readText(path.join(dir, "missing.tldr"))).toBeNull();
  });
});

describe("modifiedAt and newestMtime", () => {
  it("returns null for a missing path", async () => {
    expect(await modifiedAt(path.join(dir, "missing"))).toBeNull();
    expect(await newestMtime(path.join(dir, "missing"))).toBeNull();
  });

  it("reports the newest mtime in a nested tree", async () => {
    const older = path.join(dir, "older.txt");
    const newer = path.join(dir, "nested", "newer.txt");
    await writeText(older, "a");
    await fs.utimes(older, new Date(1_000_000), new Date(1_000_000));
    await writeText(newer, "b");
    await fs.utimes(newer, new Date(2_000_000), new Date(2_000_000));
    expect(await newestMtime(dir)).toBe(await modifiedAt(newer));
  });
});

describe("an exclusive write", () => {
  it("refuses to replace a file that appeared after the caller checked", async () => {
    const target = path.join(dir, "fresh.tldr");
    // The shape of the race `new` has: the existence check passes, a browser
    // launch happens, and by publication time someone else got there.
    await writeText(target, "theirs");

    let raised: unknown;
    await writeText(target, "ours", { exclusive: true }).catch((error: unknown) => {
      raised = error;
    });

    expect(isAlreadyExists(raised)).toBe(true);
    expect(await readText(target)).toBe("theirs");
  });

  it("writes normally when nothing is there, and leaves no temp file behind", async () => {
    const target = path.join(dir, "fresh.tldr");
    expect(await writeText(target, "ours", { exclusive: true })).toBe(target);
    expect(await readText(target)).toBe("ours");
    expect(await fs.readdir(dir)).toEqual(["fresh.tldr"]);
  });
});
