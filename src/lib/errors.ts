/**
 * Failures that carry their own exit code.
 *
 * The CLI has to turn a failure into one of the five codes in CLI.md, and the
 * only alternative to a typed error is matching on message text, which breaks
 * the first time a message is reworded. So every failure `src/lib/` raises is
 * one of these, and `src/cli/index.ts` reads `exitCode` off it.
 *
 * Layering rule 3 still holds: these carry a message, they do not print it.
 */

/** Exit codes, from the table in CLI.md. */
export const EXIT_CODES = {
  ok: 0,
  usage: 1,
  snippet: 2,
  lints: 3,
  export: 4,
} as const;

/** Anything this tool raises on purpose. Everything else is a bug. */
export abstract class TldrawkcError extends Error {
  abstract readonly exitCode: number;
}

/**
 * Bad arguments, a missing file, a flag that contradicts another. Exit 1.
 *
 * Nothing has been written and nothing has been launched.
 */
export class UsageError extends TldrawkcError {
  readonly exitCode = EXIT_CODES.usage;
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * The machine could not do the job: no Chromium, the page never answered, the
 * snippet ran past its timeout. Exit 1, same as a usage error, because from
 * the caller's side both mean "fix the setup, nothing happened".
 */
export class EnvironmentError extends TldrawkcError {
  readonly exitCode = EXIT_CODES.usage;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EnvironmentError";
  }
}

/**
 * The snippet threw. Exit 2, and the document is untouched: the page rolls
 * back to the history mark it took before running, and Node never reaches the
 * save step.
 */
export class SnippetError extends TldrawkcError {
  readonly exitCode = EXIT_CODES.snippet;
  /** The stack the page reported, which points into the snippet's own lines. */
  readonly snippetStack: string | undefined;
  constructor(message: string, snippetStack?: string) {
    super(message);
    this.name = "SnippetError";
    this.snippetStack = snippetStack;
  }
}

/**
 * The export failed after the document was saved. Exit 4.
 *
 * Its own code because the consequences differ: the `.tldr` is safe and the
 * work is not lost, only the picture is missing, so the right response is to
 * run `shot` again rather than to redraw.
 */
export class ExportError extends TldrawkcError {
  readonly exitCode = EXIT_CODES.export;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExportError";
  }
}

/** True for a failure this tool raised deliberately, with an exit code on it. */
export function isTldrawkcError(error: unknown): error is TldrawkcError {
  return error instanceof TldrawkcError;
}
