/**
 * The guard rails each verb applies before it launches anything.
 *
 * Everything here is reachable without a browser, which is the point: a
 * missing file, a missing snippet or a name that is already taken should cost
 * nothing and say so, not a Chromium start-up and then a failure. Each case
 * asserts the exit code as well as the message, because the code is the part
 * an agent branches on.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { newDocument, run, shot } from "../../src/lib/canvas.js";
import { EXIT_CODES, UsageError } from "../../src/lib/errors.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-canvas-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** The full option set, so each test only has to say what it is changing. */
function runOptions(overrides: Partial<Parameters<typeof run>[0]> = {}) {
  return {
    file: path.join(dir, "diagram.tldr"),
    create: false,
    save: true,
    allowLints: false,
    padding: 32,
    pixelRatio: 2,
    timeoutMs: 30_000,
    cwd: dir,
    ...overrides,
  };
}

describe("run", () => {
  it("refuses a missing file without --create", async () => {
    const error = await run(runOptions({ evalSource: "1" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).exitCode).toBe(EXIT_CODES.usage);
    expect((error as UsageError).message).toContain("--create");
  });

  it("refuses a run with no snippet", async () => {
    const error = await run(runOptions({ create: true })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain("--eval");
  });

  it("refuses --code together with --eval", async () => {
    const error = await run(
      runOptions({ create: true, code: "x.js", evalSource: "1" }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain("mutually exclusive");
  });

  it("refuses a --code path that does not exist", async () => {
    const error = await run(
      runOptions({ create: true, code: "missing-snippet.js" }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain("missing-snippet.js");
  });
});

describe("shot", () => {
  it("refuses a missing file", async () => {
    const error = await shot({
      file: path.join(dir, "nope.tldr"),
      padding: 32,
      pixelRatio: 2,
      cwd: dir,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain("does not exist");
  });
});

describe("new", () => {
  it("refuses to overwrite", async () => {
    const file = path.join(dir, "taken.tldr");
    await fs.writeFile(file, "{}");
    const error = await newDocument({ file, cwd: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain("already exists");
    // The point of refusing: the bytes that were there are still there.
    expect(await fs.readFile(file, "utf8")).toBe("{}");
  });

  it("refuses a --from that does not exist", async () => {
    const error = await newDocument({
      file: path.join(dir, "fresh.tldr"),
      from: path.join(dir, "absent.tldr"),
      cwd: dir,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain("--from");
  });
});
