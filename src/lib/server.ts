/**
 * The static server the page is loaded from.
 *
 * The page could in principle be opened with a `file://` URL, but browsers
 * treat that as an opaque origin: module scripts are blocked and every asset
 * fetch is a cross-origin one. Serving the bundle over HTTP from loopback
 * costs one `node:http` server and removes that whole class of problem.
 *
 * Bound to 127.0.0.1 on a random free port, because the page is for this
 * process only. Layering rule 8 says no request may leave 127.0.0.1, and
 * `browser.ts` enforces that by recording every request whose URL is not on
 * this server's origin.
 *
 * Serve mode adds three routes over one `.tldr` (`GET` and `PUT
 * /api/document`, `GET /api/health`) and a fixed default port, because a human
 * bookmarks that tab. They are mounted by `startServeServer` and by nothing
 * else: a headless verb's server has no `/api/*` at all, so a snippet, which
 * runs with the page's full power, cannot reach the filesystem through one
 * `fetch`. That is layering rule 2, enforced by the server rather than
 * promised by the page.
 */

import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { modifiedAt, readText, writeText } from "./files.js";

/**
 * Content types for everything the page bundle contains.
 *
 * Deliberately a closed list rather than a lookup in a MIME database: the
 * bundle is built by this repo's own Vite config, so the set of extensions it
 * can produce is known, and anything outside it is a sign something unexpected
 * landed in `dist/page`. Fonts are the entries that matter most, because a
 * woff2 served as `application/octet-stream` still loads but a missing font is
 * the silent failure this tool is trying to avoid (see the fonts section in
 * ARCHITECTURE.md).
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
};

/** The type served for an extension this bundle should not contain. */
export const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/** Content type for a file path, by extension. Case-insensitive. */
export function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? FALLBACK_CONTENT_TYPE;
}

/**
 * Map a request path onto a file inside `root`, or `null` to refuse it.
 *
 * The guard is a prefix check on the **resolved** path, not a scan of the URL
 * for `..`: `%2e%2e%2f` and a symlink both defeat the scan and neither defeats
 * the resolve. `/` maps to `index.html`; a path that resolves outside the root
 * is refused rather than clamped, because clamping would serve a file the
 * caller did not ask for.
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // A malformed percent escape is not a path.
    return null;
  }
  // A NUL byte truncates a path in some syscalls. Nothing legitimate has one.
  if (decoded.includes("\0")) return null;

  const withoutQuery = decoded.split("?")[0] ?? "/";
  const relative = withoutQuery === "/" || withoutQuery === "" ? "index.html" : withoutQuery;
  const rootDir = path.resolve(root);
  const resolved = path.resolve(rootDir, `.${path.posix.resolve("/", relative)}`);
  if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) return null;
  return resolved;
}

/**
 * The port `serve` asks for first.
 *
 * `DEFAULT_SERVE_PORT` in the numbers table of ARCHITECTURE.md. A fixed port
 * rather than a free one because a human bookmarks the tab: reopening
 * `127.0.0.1:7240` after a restart should land on the same thing. It is only a
 * preference, so a port already in use falls back to a free one rather than
 * failing, and the caller is told which it got.
 */
export const DEFAULT_SERVE_PORT = 7240;

/**
 * How much of a `PUT /api/document` body the server will take.
 *
 * A `.tldr` with a few images inlined as data URLs reaches a few megabytes, so
 * the cap has to be generous; what it is guarding against is a runaway or a
 * mistyped upload filling memory, not a large diagram. Over it the server
 * answers 413 and writes nothing.
 */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/**
 * What tells the page it is mirroring a file rather than backing a snippet.
 *
 * The same bundle serves both: headless verbs open `/`, `serve` opens
 * `/?mirror=1`. One bundle means the helpers, the lint pass and the bridge
 * cannot drift between what an agent draws and what a human sees.
 */
export const MIRROR_QUERY = "mirror=1";

/** The URL `serve` opens: an origin plus the mirror query. */
export function mirrorUrl(origin: string): string {
  return `${origin}/?${MIRROR_QUERY}`;
}

/**
 * The document the `/api/*` routes read and write.
 *
 * Present only in serve mode. Every headless verb starts the server without
 * it, and the routes do not exist at all on that server: a snippet runs with
 * the page's power, and layering rule 2 says the page has no filesystem access
 * outside mirror mode. An `/api/document` that were always mounted would hand
 * every snippet a write to an arbitrary file through one `fetch`.
 */
export interface ServeApiOptions {
  /** The `.tldr` the routes read and write. Absolute. */
  file: string;
  /** Cap on a PUT body. Defaults to {@link MAX_DOCUMENT_BYTES}; a test seam. */
  maxBodyBytes?: number | undefined;
}

export interface StartPageServerOptions {
  /** Directory to serve. Normally `dist/page`. */
  root: string;
  /** Loopback only. Overridable so a test can be explicit about it. */
  host?: string;
  /** 0 asks the operating system for a free port, which is the normal case. */
  port?: number;
  /** Mount the serve-mode routes over this document. Absent for every verb. */
  api?: ServeApiOptions | undefined;
  /**
   * Retry on a free port when `port` is taken, instead of failing.
   *
   * Only `serve` wants this: it asks for a fixed port as a convenience. A verb
   * that asked for a specific port and silently got another one would be
   * hiding something.
   */
  fallbackToFreePort?: boolean | undefined;
}

export interface PageServer {
  /** `http://127.0.0.1:<port>`, no trailing slash. The page's origin. */
  url: string;
  port: number;
  /**
   * The port that was asked for and found taken, or `null`.
   *
   * The caller prints it. A tab that opened on 7240 yesterday and 51234 today
   * should say why rather than leaving the bookmark to explain itself.
   */
  fellBackFrom: number | null;
  close(): Promise<void>;
}

/** Start the static server. Resolves once it is listening. */
export async function startPageServer(options: StartPageServerOptions): Promise<PageServer> {
  const root = path.resolve(options.root);
  const host = options.host ?? "127.0.0.1";
  const requested = options.port ?? 0;
  const api = options.api;

  const server = http.createServer((request, response) => {
    void handle(root, api, request, response);
  });

  let fellBackFrom: number | null = null;
  try {
    await listen(server, host, requested);
  } catch (error) {
    const inUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
    if (!inUse || !options.fallbackToFreePort || requested === 0) throw error;
    fellBackFrom = requested;
    await listen(server, host, 0);
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("tldrawkc: the page server did not report a port");
  }

  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    fellBackFrom,
    close: () =>
      new Promise<void>((resolve) => {
        // closeAllConnections, not close alone: a keep-alive socket from the
        // page would otherwise hold the process open after the command is done.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * One `listen` attempt, as a promise that rejects with the `listen` error.
 *
 * Separate from {@link startPageServer} because the port fallback needs to run
 * it twice on the same server, and a rejected `listen` leaves the server
 * unbound and reusable.
 */
function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** What `serve` hands back: the mirror URL and a way to stop. */
export interface ServeServer extends PageServer {
  /** `http://127.0.0.1:<port>/?mirror=1`, the URL a human opens. */
  url: string;
  /** The bare origin, with no path or query. */
  origin: string;
  /** The document the routes read and write. */
  file: string;
}

export interface StartServeServerOptions extends ServeApiOptions {
  /** Directory to serve. Normally `dist/page`. */
  root: string;
  host?: string;
  /** Defaults to {@link DEFAULT_SERVE_PORT}, falling back to a free one. */
  port?: number | undefined;
}

/**
 * The same static server with the three serve-mode routes mounted.
 *
 * One function rather than a flag on every call site, so "was this server
 * started in serve mode" has one answer and `/api/document` cannot appear
 * under a headless verb by accident.
 */
export async function startServeServer(
  options: StartServeServerOptions,
): Promise<ServeServer> {
  const server = await startPageServer({
    root: options.root,
    ...(options.host === undefined ? {} : { host: options.host }),
    port: options.port ?? DEFAULT_SERVE_PORT,
    fallbackToFreePort: true,
    api: { file: options.file, maxBodyBytes: options.maxBodyBytes },
  });
  return {
    ...server,
    url: mirrorUrl(server.url),
    origin: server.url,
    file: options.file,
  };
}

/**
 * Route a request: the serve-mode API first, then the static bundle.
 *
 * `/api/*` belongs to the API whenever one is mounted, so an unknown route
 * under it is a 404 from the API rather than a file lookup that might find
 * something in `dist/page/api/`. With no API mounted nothing is special and
 * every path, `/api/document` included, is a file that does not exist.
 */
async function handle(
  root: string,
  api: ServeApiOptions | undefined,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const target = request.url ?? "/";
  const pathname = target.split("?")[0] ?? "/";
  if (api !== undefined && (pathname === "/api" || pathname.startsWith("/api/"))) {
    await handleApi(api, pathname, request, response);
    return;
  }
  await serveStatic(root, request, response);
}

/** The three routes from the serve-mode table in ARCHITECTURE.md. */
async function handleApi(
  api: ServeApiOptions,
  pathname: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";

  if (pathname === "/api/health") {
    if (method !== "GET") {
      endJson(response, 405, { error: `${method} is not allowed on ${pathname}` }, { Allow: "GET" });
      return;
    }
    endJson(response, 200, { ok: true, file: api.file });
    return;
  }

  if (pathname === "/api/document") {
    if (method === "GET") {
      await getDocument(api, response);
      return;
    }
    if (method === "PUT") {
      await putDocument(api, request, response);
      return;
    }
    endJson(
      response,
      405,
      { error: `${method} is not allowed on ${pathname}` },
      { Allow: "GET, PUT" },
    );
    return;
  }

  endJson(response, 404, { error: `no route for ${pathname}` });
}

/**
 * The document as the page should hold it, plus the mtime it was read at.
 *
 * Stat first, then read. The other order can report an mtime newer than the
 * bytes it returns, and the page compares that number against the next poll to
 * decide whether it is current: it would then sit on a stale document
 * believing it was fresh. This way round the mtime can only be older than the
 * bytes, which costs one extra reload and never a missed one.
 */
async function getDocument(api: ServeApiOptions, response: http.ServerResponse): Promise<void> {
  const mtimeMs = await modifiedAt(api.file);
  if (mtimeMs === null) {
    endJson(response, 404, { error: `${api.file} does not exist` });
    return;
  }
  const tldr = await readText(api.file);
  if (tldr === null) {
    endJson(response, 404, { error: `${api.file} does not exist` });
    return;
  }
  endJson(response, 200, { file: api.file, mtimeMs, tldr });
}

/**
 * Write what the page saved, atomically, and answer with the new mtime.
 *
 * The body is checked for being a tldraw file before anything touches disk.
 * The page is the only client, but the server cannot know that: the cost of
 * being wrong is the human's diagram replaced by whatever was posted, and
 * `tldrawFileFormatVersion` is the one field every `.tldr` carries.
 *
 * The mtime comes from a stat after the write rather than from the clock,
 * because it is what the page compares its next poll against and the
 * filesystem's idea of the time is the one that matters.
 */
async function putDocument(
  api: ServeApiOptions,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const limit = api.maxBodyBytes ?? MAX_DOCUMENT_BYTES;
  const body = await readBody(request, limit);
  if (!body.ok) {
    // `Connection: close` is what ends the drain: the rest of the body is
    // discarded as it arrives and Node drops the socket once this response has
    // flushed, so an oversized upload cannot be read forever and the client
    // still gets to read the 413 it is being refused with.
    endJson(
      response,
      413,
      { error: `body is larger than ${String(limit)} bytes` },
      { Connection: "close" },
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch (error) {
    endJson(response, 400, { error: `body is not JSON: ${(error as Error).message}` });
    return;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Object.hasOwn(parsed, "tldrawFileFormatVersion")
  ) {
    endJson(response, 400, { error: "body is not a .tldr: no tldrawFileFormatVersion" });
    return;
  }

  try {
    await writeText(api.file, body.text);
  } catch (error) {
    endJson(response, 500, { error: `could not write ${api.file}: ${(error as Error).message}` });
    return;
  }
  endJson(response, 200, { ok: true, mtimeMs: await modifiedAt(api.file) });
}

type BodyResult = { ok: true; text: string } | { ok: false };

/**
 * Read a request body, refusing one over `limit`.
 *
 * `Content-Length` is checked first so an oversized upload is refused before a
 * byte of it is buffered. A chunked body declares no length, so it is counted
 * as it arrives instead. Either way what is already buffered is dropped and
 * the rest is drained rather than the socket being destroyed: a client still
 * writing its body has to be able to read the 413 coming back, and destroying
 * the request destroys the response with it.
 */
function readBody(request: http.IncomingMessage, limit: number): Promise<BodyResult> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    return Promise.resolve({ ok: false });
  }

  return new Promise<BodyResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        request.resume();
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
    });
    request.on("error", reject);
  });
}

/** One JSON response. Every `/api/*` answer, success or failure, is one. */
function endJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text)),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(text);
}

async function serveStatic(
  root: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    end(response, 405, "method not allowed", { Allow: "GET, HEAD" });
    return;
  }

  const target = resolveStaticPath(root, request.url ?? "/");
  if (target === null) {
    end(response, 404, "not found");
    return;
  }

  let size: number;
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      end(response, 404, "not found");
      return;
    }
    size = stat.size;
  } catch {
    end(response, 404, "not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentTypeFor(target),
    "Content-Length": String(size),
    // The bundle is rebuilt in place and served to a browser this process
    // just launched. A cached response would be a stale diagram.
    "Cache-Control": "no-store",
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  try {
    await pipeline(createReadStream(target), response);
  } catch {
    // The browser navigated away or the socket died. Nothing to recover.
    response.destroy();
  }
}

function end(
  response: http.ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}
