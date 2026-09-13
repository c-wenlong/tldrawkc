/**
 * Mirror mode: the page a human opens in a normal browser tab while an agent
 * draws.
 *
 * The same bundle as the headless canvas, selected by `?mirror=1` on the URL
 * (`main.tsx` branches on the query). The difference is the whole tldraw UI
 * instead of `hideUi`, and the two fetches to `/api/document` that layering
 * rule 2 names as its only exception: a `GET` every {@link MIRROR_POLL_MS}
 * that reloads the document when the file's mtime moved, and a `PUT` on
 * Cmd+S that writes the human's edits back. The bridge is installed here too,
 * so an `inspect`-style check against a served tab still works, but the
 * mirror never calls `save()`: the only writes leave through the PUT.
 *
 * Two writers on one file, last write wins, and a banner when a foreign write
 * landed on top of unsaved local edits. That is the whole collaboration
 * story (DECISIONS.md D3).
 */

import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import {
  Tldraw,
  loadSnapshot,
  parseTldrawJsonFile,
  serializeTldrawJson,
  type Editor,
  type RecordsDiff,
  type TLRecord,
} from "tldraw";

import { installBridge } from "./bridge.js";

/** How often the page asks the server whether the file changed, in ms. */
export const MIRROR_POLL_MS = 1000;

/** Where both fetches go. The server side of this is `lib/server.ts`. */
const DOCUMENT_URL = "/api/document";

/** `GET /api/document`. `tldr` is the file's contents, not a parsed object. */
interface DocumentResponse {
  file: string;
  mtimeMs: number;
  tldr: string;
}

/** `PUT /api/document`, after the server has written the file atomically. */
interface PutResponse {
  ok: true;
  mtimeMs: number;
}

/**
 * What the mirror tab exposes to an automated check, as
 * `window.__tldrawkcMirror`.
 *
 * It exists so the Node side's e2e can assert that a foreign write reached
 * the canvas without taking and comparing screenshots: write the file from
 * another process, then poll `shapeCount()` and `mtimeMs` until they move.
 * Every property is a live read, and the object is frozen, so a check can
 * read it but cannot drive the page with it. Nothing in the page reads it
 * back; it is an observation window, not an API.
 *
 * ```js
 * const { mtimeMs, dirty, lastSaveAt } = window.__tldrawkcMirror
 * window.__tldrawkcMirror.shapeCount() // shapes on the current page
 * ```
 */
export interface MirrorHandle {
  /** The mtime of the file as the page last saw it, or `null` before the first load. */
  readonly mtimeMs: number | null;
  /** True when the store has user edits that no save or reload has cleared. */
  readonly dirty: boolean;
  /** Shapes on the current page, right now. */
  shapeCount(): number;
  /** `HH:MM:SS` of the last successful PUT, or `null` if the tab has never saved. */
  readonly lastSaveAt: string | null;
}

/** What the overlay says about the connection, in priority order of interest. */
type Status =
  | { kind: "loading" }
  | { kind: "watching" }
  | { kind: "saving" }
  | { kind: "unreachable" }
  | { kind: "error"; message: string };

/**
 * The values the polling loop owns.
 *
 * They live in a ref rather than in React state because the loop reads them
 * from callbacks that a re-render must not restart, and because
 * `window.__tldrawkcMirror` has to see the current value rather than the one
 * captured by the last render.
 */
interface Runtime {
  mtimeMs: number | null;
  dirty: boolean;
  lastSaveAt: string | null;
  saving: boolean;
}

/**
 * The record types that are the drawing.
 *
 * Scope is not enough to tell an edit from the UI waking up. `user` is a
 * **document-scoped** record in tldraw 5, and the full UI creates one
 * (`user:...`, a name and a cursor colour) the moment it mounts, so a
 * listener filtered only to `{ source: 'user', scope: 'document' }` sees one
 * change on every fresh mirror tab and calls a canvas nobody has touched
 * dirty. `comment` is document-scoped for the same reason and is not a
 * drawing either.
 */
const DRAWING_TYPES = new Set(["shape", "binding", "page", "asset", "document"]);

/** True when a change touched the drawing rather than the UI's own bookkeeping. */
function isDrawingEdit(changes: RecordsDiff<TLRecord>): boolean {
  for (const record of Object.values(changes.added)) {
    if (DRAWING_TYPES.has(record.typeName)) return true;
  }
  for (const [, after] of Object.values(changes.updated)) {
    if (DRAWING_TYPES.has(after.typeName)) return true;
  }
  for (const record of Object.values(changes.removed)) {
    if (DRAWING_TYPES.has(record.typeName)) return true;
  }
  return false;
}

function clockTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The file's own name, for the overlay. The server sends an absolute path. */
function basename(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] ?? file;
}

async function fetchDocument(): Promise<DocumentResponse> {
  const response = await fetch(DOCUMENT_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`GET ${DOCUMENT_URL} answered ${String(response.status)}`);
  }
  return (await response.json()) as DocumentResponse;
}

async function putDocument(tldr: string): Promise<PutResponse> {
  const response = await fetch(DOCUMENT_URL, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: tldr,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(
      `PUT ${DOCUMENT_URL} answered ${String(response.status)}${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await response.json()) as PutResponse;
}

/**
 * Put a `.tldr` file's contents on a live canvas without disturbing the human.
 *
 * Only the `document` key: a snapshot with a `session` key would carry the
 * agent's camera, selection and current page over the ones the person
 * watching chose, which is the thing this whole mode exists to avoid.
 *
 * The load runs inside `mergeRemoteChanges` so every record it writes is
 * tagged `source: 'remote'`. Without that the reload would arrive at the
 * dirty-flag listener as `source: 'user'` one frame later (store listeners
 * are flushed by a reactor on the next frame, not synchronously), and every
 * foreign write would look like a local edit to the code that decides whether
 * to show the banner.
 */
function applyDocument(editor: Editor, tldr: string): void {
  const parsed = parseTldrawJsonFile({ json: tldr, schema: editor.store.schema });
  if (!parsed.ok) {
    throw new Error(`tldrawkc: not a loadable .tldr file (${parsed.error.type})`);
  }
  const document = parsed.value.getStoreSnapshot("document");
  editor.store.mergeRemoteChanges(() => {
    loadSnapshot(editor.store, { document });
  });
}

/**
 * What the overlay says, and whether it says it in red.
 *
 * A failed save outranks everything the poll has to report, and it is sticky:
 * the poll runs every second, so a save error written into the same line as
 * the connection state would be gone before anyone read it. Only the next
 * successful save clears it.
 */
function overlayDetail(
  status: Status,
  saveError: string | null,
  dirty: boolean,
): { text: string; bad: boolean } {
  if (saveError !== null) return { text: `not saved: ${saveError}`, bad: true };
  switch (status.kind) {
    case "error":
      return { text: status.message, bad: true };
    case "unreachable":
      return { text: "server unreachable", bad: true };
    case "saving":
      return { text: "saving...", bad: false };
    case "loading":
      return { text: "loading...", bad: false };
    case "watching":
      return {
        text: dirty ? "unsaved edits, Cmd+S to save" : "watching for changes",
        bad: false,
      };
  }
}

function Overlay(props: {
  file: string;
  status: Status;
  saveError: string | null;
  lastSaveAt: string | null;
  dirty: boolean;
}): React.JSX.Element {
  const { file, status, saveError, lastSaveAt, dirty } = props;
  const { text: detail, bad } = overlayDetail(status, saveError, dirty);
  return (
    <div
      data-testid="mirror-overlay"
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 1000,
        pointerEvents: "none",
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(255,255,255,0.92)",
        border: "1px solid rgba(0,0,0,0.12)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.12)",
        font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#111",
        maxWidth: 320,
        textAlign: "right",
      }}
    >
      <div style={{ fontWeight: 600 }}>{file || "no file yet"}</div>
      <div data-testid="mirror-saved">
        {lastSaveAt === null ? "not saved from this tab" : `Saved ${lastSaveAt}`}
      </div>
      <div data-testid="mirror-status" style={{ color: bad ? "#b00020" : "#555" }}>
        {detail}
      </div>
    </div>
  );
}

function Banner(props: { onDismiss: () => void }): React.JSX.Element {
  return (
    <div
      data-testid="mirror-banner"
      style={{
        position: "absolute",
        top: 8,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1001,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 12px",
        borderRadius: 8,
        background: "#fff4d6",
        border: "1px solid #e0b44a",
        boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
        font: "13px/1.4 ui-sans-serif, system-ui, sans-serif",
        color: "#4a3200",
      }}
    >
      <span>Reloaded from disk over unsaved edits</span>
      <button
        type="button"
        data-testid="mirror-banner-dismiss"
        onClick={props.onDismiss}
        style={{
          font: "inherit",
          cursor: "pointer",
          padding: "2px 8px",
          borderRadius: 6,
          border: "1px solid #c79a2f",
          background: "#fffaf0",
          color: "inherit",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * The mirror. One `<Tldraw>` with the full UI, a poll, a save, and an
 * overlay that says which of those happened last.
 */
export function Mirror(props: {
  assetUrls: ComponentProps<typeof Tldraw>["assetUrls"];
}): React.JSX.Element {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [file, setFile] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [lastSaveAt, setLastSaveAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [banner, setBanner] = useState(false);

  const runtime = useRef<Runtime>({
    mtimeMs: null,
    dirty: false,
    lastSaveAt: null,
    saving: false,
  });

  const onMount = useCallback((mounted: Editor) => {
    // The bridge is installed in mirror mode too, so `inspect`-style checks
    // work against a served tab. It is never asked to `save()` here: the file
    // is the server's to write.
    installBridge(mounted);
    setEditor(mounted);
  }, []);

  // The dirty flag. Filtered to the human's own edits to the drawing, which is
  // what makes a reload over them worth a banner: `source: 'remote'` is how
  // `applyDocument` tags its own writes, session-scoped records (camera,
  // selection) are not edits to the file, and `isDrawingEdit` drops the
  // document-scoped records the UI keeps for itself.
  useEffect(() => {
    if (!editor) return;
    return editor.store.listen(
      (entry) => {
        if (!isDrawingEdit(entry.changes)) return;
        runtime.current.dirty = true;
        setDirty(true);
      },
      { source: "user", scope: "document" },
    );
  }, [editor]);

  // The poll. One chained timeout rather than an interval, so a slow request
  // cannot stack up behind itself, and nothing is asked while a save is in
  // flight: our own PUT moves the mtime, and reading it back mid-write would
  // reload the page over the edit that is being saved.
  useEffect(() => {
    if (!editor) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (): void => {
      if (stopped) return;
      timer = setTimeout(() => void tick(), MIRROR_POLL_MS);
    };

    const tick = async (): Promise<void> => {
      if (stopped) return;
      if (runtime.current.saving) {
        schedule();
        return;
      }
      try {
        const document = await fetchDocument();
        if (stopped) return;
        setFile(document.file);
        const first = runtime.current.mtimeMs === null;
        if (first || document.mtimeMs !== runtime.current.mtimeMs) {
          applyDocument(editor, document.tldr);
          runtime.current.mtimeMs = document.mtimeMs;
          if (!first && runtime.current.dirty) setBanner(true);
          runtime.current.dirty = false;
          setDirty(false);
          // First load only. After that the camera is the human's.
          if (first) editor.zoomToFit();
        }
        setStatus({ kind: "watching" });
      } catch (cause) {
        if (stopped) return;
        setStatus(
          cause instanceof TypeError
            ? { kind: "unreachable" }
            : { kind: "error", message: cause instanceof Error ? cause.message : String(cause) },
        );
      }
      schedule();
    };

    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [editor]);

  // Cmd+S / Ctrl+S. Captured on `window` so it runs before anything tldraw
  // binds, and `preventDefault` so the browser does not offer to save the
  // page as a file.
  useEffect(() => {
    if (!editor) return;
    const save = async (): Promise<void> => {
      if (runtime.current.saving) return;
      runtime.current.saving = true;
      setStatus({ kind: "saving" });
      try {
        const tldr = await serializeTldrawJson(editor);
        const result = await putDocument(tldr);
        // Remember the mtime the server reports, so the next poll does not
        // read our own write back as a foreign change and reload over it.
        runtime.current.mtimeMs = result.mtimeMs;
        runtime.current.dirty = false;
        setDirty(false);
        setSaveError(null);
        const at = clockTime(new Date());
        runtime.current.lastSaveAt = at;
        setLastSaveAt(at);
        setStatus({ kind: "watching" });
      } catch (cause) {
        // The dirty flag stays set: the edits are still only in this tab. The
        // message is sticky, because the poll would overwrite the status line
        // a second later and the person needs to know the file was not
        // written.
        setSaveError(
          cause instanceof TypeError
            ? "server unreachable"
            : cause instanceof Error
              ? cause.message
              : String(cause),
        );
        setStatus({ kind: "watching" });
      } finally {
        runtime.current.saving = false;
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "s" && event.key !== "S") return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      void save();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [editor]);

  // The observation window. Live getters, frozen, and torn down with the
  // component so a check can tell a mounted mirror from a dead one.
  useEffect(() => {
    if (!editor) return;
    const handle: MirrorHandle = Object.freeze(
      Object.defineProperties({} as MirrorHandle, {
        mtimeMs: { enumerable: true, get: () => runtime.current.mtimeMs },
        dirty: { enumerable: true, get: () => runtime.current.dirty },
        lastSaveAt: { enumerable: true, get: () => runtime.current.lastSaveAt },
        shapeCount: {
          enumerable: true,
          value: () => editor.getCurrentPageShapes().length,
        },
      }),
    );
    window.__tldrawkcMirror = handle;
    return () => {
      delete window.__tldrawkcMirror;
    };
  }, [editor]);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Tldraw assetUrls={props.assetUrls} onMount={onMount} />
      <Overlay
        file={file ? basename(file) : ""}
        status={status}
        saveError={saveError}
        lastSaveAt={lastSaveAt}
        dirty={dirty}
      />
      {banner ? (
        <Banner
          onDismiss={() => {
            setBanner(false);
          }}
        />
      ) : null}
    </div>
  );
}
