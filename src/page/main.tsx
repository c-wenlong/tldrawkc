/**
 * The page, in both of its modes.
 *
 * One `index.html` and one entry, because the two modes share the fonts, the
 * helpers and the bridge, and a second bundle would be a second thing to keep
 * in step. The query string picks: `?mirror=1` mounts the human view from
 * `mirror.tsx`, and anything else mounts the headless canvas, one `<Tldraw>`
 * with the UI hidden, because in that case nobody is looking at this page and
 * Node drives it through the bridge.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Tldraw, type Editor } from "tldraw";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";

import { installBridge } from "./bridge.js";
import { Mirror } from "./mirror.js";
import "tldraw/tldraw.css";

/**
 * Fonts and icons, imported rather than fetched.
 *
 * tldraw 5 ships no font files in the `tldraw` package itself; it asks for
 * them by key (`tldraw_draw`, `tldraw_mono` and so on) and falls back to
 * requesting that bare key as a URL when nothing supplies one, which 404s and
 * silently degrades every export to a system font. `@tldraw/assets` holds the
 * actual woff2 files, and its `imports.vite` entry point imports each one
 * with `?url`, so Vite emits them into `dist/page/assets/` and hands back the
 * built URL. With `base: './'` in the Vite config those URLs are relative,
 * which is what keeps rendering offline (layering rule 8).
 */
const assetUrls = getAssetUrlsByImport();

function mount(editor: Editor): void {
  installBridge(editor);
}

/** `?mirror=1`, the one query this page reads. */
const isMirror = new URLSearchParams(window.location.search).get("mirror") === "1";

const root = document.getElementById("root");
if (!root) throw new Error("tldrawkc page: #root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    {isMirror ? (
      <Mirror assetUrls={assetUrls} />
    ) : (
      <Tldraw hideUi assetUrls={assetUrls} onMount={mount} />
    )}
  </StrictMode>,
);
