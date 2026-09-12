/**
 * The headless canvas.
 *
 * One `<Tldraw>` with the UI hidden, because in the normal case nobody is
 * looking at this page: Node drives it through the bridge and reads a PNG
 * back. The headed human view (`serve`) is a separate mount, `mirror.tsx`,
 * and arrives in phase 4.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Tldraw, type Editor } from "tldraw";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";

import { installBridge } from "./bridge.js";
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

const root = document.getElementById("root");
if (!root) throw new Error("tldrawkc page: #root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <Tldraw hideUi assetUrls={assetUrls} onMount={mount} />
  </StrictMode>,
);
