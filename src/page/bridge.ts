/**
 * `window.__tldrawkc`, the surface Node calls through `page.evaluate`.
 *
 * Every function takes and returns JSON-safe values, so the same surface can
 * back a future MCP entry without a translation layer (DECISIONS.md D6).
 *
 * Layering rule 2: nothing here touches the filesystem or the network. The
 * page receives strings and returns strings; Node does the IO.
 *
 * The table in ARCHITECTURE.md, "The bridge", is the contract. Phase 1 covers
 * `ping`, `load`, `setPage`, `exec`, `save`, `shot`, `lints` and `zoomToFit`;
 * `svg` and `inspect` are phase 2 verbs that cost almost nothing once the rest
 * exists, so they are here too.
 */

import * as tldrawModule from "tldraw";
import {
  loadSnapshot,
  parseTldrawJsonFile,
  serializeTldrawJson,
  type Editor,
  type TLShapeId,
  type TLStoreSnapshot,
} from "tldraw";

import { clampPixelRatio, unionRects, type Rect } from "./helpers/geometry.js";
import { toShapeId } from "./helpers/ids.js";
import { describeEditor, lintPage, type InspectResult } from "./helpers/read.js";
import type { Lint } from "./helpers/lints.js";
import { createHelpers, type Helpers } from "./helpers/index.js";

export type { InspectShape, InspectBinding, InspectResult } from "./helpers/read.js";

/** Export padding, in page units, when the caller does not say. */
export const DEFAULT_PADDING = 32;
/** PNG resolution multiplier when the caller does not say. */
export const DEFAULT_PIXEL_RATIO = 2;
/** Ceiling on the longest edge of a PNG. Over it, the pixel ratio is reduced. */
export const MAX_SHOT_EDGE = 4096;
/** Edge of the placeholder PNG returned when there is nothing to photograph. */
const BLANK_SHOT_EDGE = 64;

/** What `ping` answers once the editor has mounted. */
export interface PingResult {
  ok: true;
  /** The tldrawkc version the bundle was built from. */
  version: string;
}

/** What `load` reports about the document it just put on the canvas. */
export interface LoadResult {
  /** Page names, in document order. */
  pages: string[];
  /** Shapes on the current page, which after a load is the first one. */
  shapeCount: number;
}

/** What `exec` reports after a snippet ran to completion. */
export interface ExecResult {
  /** The snippet's return value, round-tripped through JSON. `undefined` becomes `null`. */
  result: unknown;
  lints: Lint[];
  shapeCount: number;
}

/** Options for `shot`. */
export interface ShotOptions {
  /** Shape keys or ids to frame. Default: every shape on the current page. */
  ids?: string[];
  /** Padding around the shapes, default {@link DEFAULT_PADDING}. */
  padding?: number;
  /** Resolution multiplier, default {@link DEFAULT_PIXEL_RATIO}, reduced to respect {@link MAX_SHOT_EDGE}. */
  pixelRatio?: number;
  /** Paint the page background, default true. False gives a transparent PNG. */
  background?: boolean;
}

/** What `shot` returns. `bounds` is in page coordinates, not image pixels. */
export interface ShotResult {
  pngBase64: string;
  width: number;
  height: number;
  bounds: Rect;
}

/** Options for `svg`. */
export interface SvgOptions {
  ids?: string[];
  padding?: number;
  background?: boolean;
}

/** What `svg` returns. */
export interface SvgResult {
  svg: string;
  width: number;
  height: number;
}

export interface Bridge {
  /**
   * Answers only after the editor has mounted, which is what makes it a
   * readiness signal rather than a liveness one. `doctor` and
   * `lib/browser.ts` poll for it.
   */
  ping(): PingResult;
  /** Put a `.tldr` file's contents on the canvas, or `null` for a fresh document. */
  load(tldrJson: string | null): LoadResult;
  /** Switch to a named page, or `null` for the first one. Unknown names throw. */
  setPage(name: string | null): { page: string };
  /** Run a snippet with `editor`, `helpers` and `tldraw` in scope. */
  exec(source: string): Promise<ExecResult>;
  /** Serialise the document as `.tldr` JSON. */
  save(): Promise<string>;
  /** Export a PNG of the current page, base64 encoded. */
  shot(opts?: ShotOptions): Promise<ShotResult>;
  /** Export an SVG of the current page. */
  svg(opts?: SvgOptions): Promise<SvgResult>;
  /** Everything on the current page, for the agent to read before editing. */
  inspect(): InspectResult;
  /** Run the lint pass without mutating anything. */
  lints(): Lint[];
  /** Fit the camera to every shape and report the bounds it framed. */
  zoomToFit(): Rect | null;
}

/**
 * The `AsyncFunction` constructor, which is not a global the way `Function`
 * is. Compiling the snippet with it is what gives the body top-level `await`
 * and a `return` value (HELPERS.md).
 */
type SnippetFactory = new (
  ...args: string[]
) => (editor: Editor, helpers: Helpers, tldraw: typeof tldrawModule) => Promise<unknown>;

const AsyncFunction = (
  Object.getPrototypeOf(async function asyncProbe() {
    await Promise.resolve();
  }) as { constructor: SnippetFactory }
).constructor;

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  return JSON.parse(text) as unknown;
}

/**
 * Fold an error's stack into its message.
 *
 * Playwright carries an error's `message` across the bridge but not much else,
 * so the line number the snippet failed on has to travel inside the message or
 * it is lost. The stack's own first line repeats the message, so drop it.
 */
function withStack(error: Error): string {
  const stack = error.stack;
  if (!stack) return error.message;
  const lines = stack.split("\n");
  const head = lines[0] ?? "";
  const body = head.includes(error.message) ? lines.slice(1) : lines;
  const trimmed = body.join("\n").trimEnd();
  return trimmed.length > 0 ? `${error.message}\n${trimmed}` : error.message;
}

function shapeRects(editor: Editor, ids: readonly TLShapeId[]): Rect[] {
  const rects: Rect[] = [];
  for (const id of ids) {
    const bounds = editor.getShapePageBounds(id);
    if (bounds) rects.push({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
  }
  return rects;
}

function resolveIds(editor: Editor, ids: string[] | undefined): TLShapeId[] {
  if (ids === undefined) return editor.getCurrentPageShapes().map((shape) => shape.id);
  return ids.map((id) => toShapeId(id));
}

function bytesToBase64(bytes: Uint8Array): string {
  // btoa wants a binary string, and spreading a megabyte of bytes into
  // String.fromCharCode blows the argument limit, so go a chunk at a time.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * A PNG's pixel size, read from the file itself.
 *
 * `toImage` reports the framed region in page units, and multiplying that by
 * the pixel ratio does not reliably land on the canvas the rasteriser made:
 * measured on the mermaid fixture, 1288.5024 page units at ratio 2 came back
 * as a 2576-pixel PNG, not the 2577 the arithmetic predicts. The header is the
 * only number that matches the file an agent goes on to read, so take it from
 * there. Width and height are big-endian 32-bit integers at bytes 16 and 20,
 * which the format fixes, so this needs no decoder.
 */
function pngPixelSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * A small PNG for an empty page.
 *
 * `toImage` on an empty shape list rejects, and a command failing because the
 * canvas is blank is a worse answer than a picture of a blank canvas: the
 * agent asked what is there, and "nothing" is the honest reply.
 */
function blankShot(background: boolean): ShotResult {
  const canvas = document.createElement("canvas");
  canvas.width = BLANK_SHOT_EDGE;
  canvas.height = BLANK_SHOT_EDGE;
  const context = canvas.getContext("2d");
  if (context && background) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, BLANK_SHOT_EDGE, BLANK_SHOT_EDGE);
  }
  const dataUrl = canvas.toDataURL("image/png");
  return {
    pngBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    width: BLANK_SHOT_EDGE,
    height: BLANK_SHOT_EDGE,
    bounds: { x: 0, y: 0, w: 0, h: 0 },
  };
}

/**
 * Install the bridge. Called from the `<Tldraw onMount>` callback, so by the
 * time `window.__tldrawkc` exists there is a live `Editor` behind it.
 */
export function installBridge(editor: Editor): Bridge {
  const handle = createHelpers(editor);
  const helpers: Helpers = handle.helpers;
  const beginExec = (): void => {
    handle.beginExec();
  };

  // A snapshot of the document as it mounts: one page, no shapes, this
  // schema. `load(null)` replays it, which is the only reset that provably
  // leaves the store identical to a fresh mount. Rebuilding an empty document
  // by hand, or deleting shapes and surplus pages, gets close and drifts.
  const pristine: TLStoreSnapshot = editor.store.getStoreSnapshot("document");

  const pageNames = (): string[] => editor.getPages().map((page) => page.name);
  const shapeCount = (): number => editor.getCurrentPageShapes().length;

  const lints = (): Lint[] => lintPage(editor);

  const framed = (ids: TLShapeId[]): Rect | null => unionRects(shapeRects(editor, ids));

  const bridge: Bridge = {
    ping: () => ({ ok: true, version: __TLDRAWKC_VERSION__ }),

    load: (tldrJson) => {
      if (tldrJson === null) {
        loadSnapshot(editor.store, { document: pristine });
      } else {
        const parsed = parseTldrawJsonFile({ json: tldrJson, schema: editor.store.schema });
        if (!parsed.ok) {
          throw new Error(`tldrawkc: not a loadable .tldr file (${parsed.error.type})`);
        }
        loadSnapshot(editor.store, { document: parsed.value.getStoreSnapshot("document") });
      }
      return { pages: pageNames(), shapeCount: shapeCount() };
    },

    setPage: (name) => {
      const pages = editor.getPages();
      const first = pages[0];
      if (!first) throw new Error("tldrawkc: the document has no pages");
      if (name === null) {
        editor.setCurrentPage(first);
        return { page: first.name };
      }
      const page = pages.find((candidate) => candidate.name === name);
      if (!page) {
        throw new Error(
          `tldrawkc: no page named "${name}". Pages: ${pageNames().join(", ")}`,
        );
      }
      editor.setCurrentPage(page);
      return { page: page.name };
    },

    exec: async (source) => {
      const mark = editor.markHistoryStoppingPoint("exec");
      // Before anything runs, so `helpers.clear()` can tell a document this
      // snippet drew from one it was handed.
      beginExec();
      try {
        const run = new AsyncFunction("editor", "helpers", "tldraw", source);
        const result = await run(editor, helpers, tldrawModule);
        return { result: jsonSafe(result), lints: lints(), shapeCount: shapeCount() };
      } catch (cause) {
        // Undo everything the snippet did before rethrowing, so a failed run
        // leaves the document exactly as the caller handed it over and the
        // `.tldr` on disk is never written from a half-applied change.
        editor.bailToMark(mark);
        const error = cause instanceof Error ? cause : new Error(String(cause));
        const wrapped = new Error(withStack(error));
        wrapped.name = "SnippetError";
        throw wrapped;
      }
    },

    save: () => serializeTldrawJson(editor),

    shot: async (opts = {}) => {
      const ids = resolveIds(editor, opts.ids);
      const background = opts.background ?? true;
      if (ids.length === 0) return blankShot(background);

      const bounds = framed(ids);
      const padding = opts.padding ?? DEFAULT_PADDING;
      const longestEdge = bounds
        ? Math.max(bounds.w, bounds.h) + padding * 2
        : BLANK_SHOT_EDGE;
      const pixelRatio = clampPixelRatio(
        opts.pixelRatio ?? DEFAULT_PIXEL_RATIO,
        longestEdge,
        MAX_SHOT_EDGE,
      );

      const image = await editor.toImage(ids, {
        format: "png",
        padding,
        pixelRatio,
        background,
      });
      const bytes = new Uint8Array(await image.blob.arrayBuffer());
      // CLI.md promises pixels under `width` and `height`. `image.width` and
      // `image.height` are page units, so read the PNG's own header instead.
      const size = pngPixelSize(bytes);
      return {
        pngBase64: bytesToBase64(bytes),
        width: size.width,
        height: size.height,
        bounds: bounds ?? { x: 0, y: 0, w: 0, h: 0 },
      };
    },

    svg: async (opts = {}) => {
      const ids = resolveIds(editor, opts.ids);
      if (ids.length === 0) {
        throw new Error("tldrawkc: nothing to export, the page has no shapes");
      }
      const result = await editor.getSvgString(ids, {
        padding: opts.padding ?? DEFAULT_PADDING,
        background: opts.background ?? true,
      });
      if (!result) throw new Error("tldrawkc: the SVG export produced nothing");
      return { svg: result.svg, width: result.width, height: result.height };
    },

    inspect: () => describeEditor(editor),

    lints,

    zoomToFit: () => {
      editor.zoomToFit();
      const bounds = editor.getCurrentPageBounds();
      return bounds ? { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h } : null;
    },
  };

  window.__tldrawkc = bridge;
  return bridge;
}
