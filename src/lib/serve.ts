/**
 * `serve`: the one command that stays running.
 *
 * Every other verb is a browser launch, a job and an exit. This one starts the
 * page server with the three `/api/*` routes mounted over a single `.tldr`,
 * opens the machine's own browser at the mirror URL, and hands back a handle.
 * It does not launch Chromium itself: the point of serve mode is a normal tab
 * a human can keep open, so the browser is whatever they already use and
 * `withCanvas` has nothing to do here.
 *
 * Layering rule 3 still holds: nothing in this file prints. It returns the URL
 * and the port; `src/cli/index.ts` decides what a human or `--json` sees, and
 * it is the CLI that waits for SIGINT and calls `close`.
 */

import { spawn } from "node:child_process";

import { EnvironmentError, UsageError } from "./errors.js";
import { modifiedAt } from "./files.js";
import { PAGE_DIST_DIR, resolveTldrPath } from "./paths.js";
import { startServeServer } from "./server.js";

export interface ServeOptions {
  /** The `.tldr` to mirror. It has to exist already. */
  file: string;
  /** The `--port` flag. Defaults to `DEFAULT_SERVE_PORT`. */
  port?: number | undefined;
  /** Open the machine's default browser. `--no-open` passes false. */
  open: boolean;
  /** Working directory relative paths resolve against. */
  cwd?: string | undefined;
  /** Where the page is served from. Defaults to `dist/page`; a test seam. */
  pageRoot?: string | undefined;
  /**
   * Called once the server is listening, before the browser is opened.
   *
   * The CLI prints the URL from here, so the line is on stdout before a
   * browser window steals the terminal's attention, and so a caller driving
   * this as a library can react at the same moment.
   */
  onReady?: ((handle: ServeHandle) => void) | undefined;
}

export interface ServeHandle {
  /** `http://127.0.0.1:<port>/?mirror=1`. */
  url: string;
  port: number;
  /** The resolved absolute path of the document being mirrored. */
  file: string;
  /** The port that was asked for and found taken, or `null`. */
  fellBackFrom: number | null;
  /** Stop the server. The caller does this on SIGINT. */
  close(): Promise<void>;
}

/**
 * Start mirroring a document.
 *
 * A missing file is a usage error rather than an empty canvas, and `new` is
 * named in the message: `serve` on a path that does not exist is almost always
 * a typo, and creating the file would hand back a blank document under a name
 * the caller thought already had a diagram in it.
 */
export async function serve(options: ServeOptions): Promise<ServeHandle> {
  const file = resolveTldrPath(options.file, options.cwd);
  if ((await modifiedAt(file)) === null) {
    throw new UsageError(`${file} does not exist. Run "tldrawkc new ${options.file}" first.`);
  }

  const root = options.pageRoot ?? PAGE_DIST_DIR;
  let server;
  try {
    server = await startServeServer({
      root,
      file,
      ...(options.port === undefined ? {} : { port: options.port }),
    });
  } catch (error) {
    throw new EnvironmentError(`could not serve ${root}: ${(error as Error).message}`, {
      cause: error,
    });
  }

  const handle: ServeHandle = {
    url: server.url,
    port: server.port,
    file,
    fellBackFrom: server.fellBackFrom,
    close: () => server.close(),
  };

  options.onReady?.(handle);
  if (options.open) openInBrowser(handle.url);
  return handle;
}

/** The command that hands a URL to the machine's default browser. */
export interface OpenCommand {
  command: string;
  args: string[];
}

/**
 * How to open a URL, per platform.
 *
 * Three one-line shell-outs rather than a dependency. `open` and `xdg-open`
 * take the URL; on Windows `start` is a `cmd` builtin and its first quoted
 * argument is the window title, which is why the empty string is there and
 * removing it would open a window named after the URL instead of the URL.
 */
export function openCommandFor(url: string, platform: NodeJS.Platform): OpenCommand {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Open the default browser, and shrug if it does not work.
 *
 * Detached and with its stdio ignored, so the browser does not hold this
 * process's pipes open or die with it, and every failure is swallowed: a
 * headless box with no `xdg-open` should still serve the page, because the URL
 * has already been printed and opening it by hand is one click.
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const { command, args } = openCommandFor(url, platform);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Nothing to report: the URL is on stdout either way.
  }
}
