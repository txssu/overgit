/**
 * Error taxonomy for overgit.
 *
 * Every failure the user can hit should be an `OvergitError` with a code, a message that
 * names the offending path, and a hint that names the command to run. The CLI renders:
 *
 *     error: <message>
 *       hint: <hint>
 *
 * Anything that escapes as a bare `Error` is a bug; the CLI reports those as internal
 * errors with a stack trace under `OVERGIT_DEBUG=1`.
 */

export type ErrorCode =
  /* discovery */
  | "NOT_IN_BASE_REPO"
  | "NO_OVERLAY"
  | "OVERLAY_EXISTS"
  | "INSIDE_GIT_DIR"
  /* paths */
  | "PATH_OUTSIDE_WORKTREE"
  | "PATH_FORBIDDEN"
  | "PATH_NOT_FOUND"
  | "NOT_A_FILE"
  /* ownership */
  | "ALREADY_OWNED"
  | "NOT_OWNED"
  | "NOT_TRACKED_BY_BASE"
  | "TRACKED_BY_BASE"
  | "DIRTY_OVERLAY"
  | "DIRTY_WORKTREE"
  /* sync */
  | "SYNC_IN_PROGRESS"
  | "NO_SYNC_IN_PROGRESS"
  | "CONFLICTS_PENDING"
  | "DECISION_REQUIRED"
  /* infrastructure */
  | "GIT_FAILED"
  | "GIT_TOO_OLD"
  | "MANIFEST_INVALID"
  | "MANIFEST_VERSION"
  | "LOCKED"
  | "IO_FAILED"
  /* cli */
  | "USAGE"
  | "UNSUPPORTED"
  | "DOCTOR_PROBLEMS"
  | "INTERNAL";

/** Frozen exit-code map. `overgit help` prints it. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  PENDING: 3, // conflicts or decisions block the operation
  PROBLEMS: 4, // doctor found problems / --dry-run found drift
} as const;

export interface OvergitErrorOptions {
  /** Actionable next step. Should name a concrete command. */
  hint?: string;
  /** Extra lines printed under the message (one per line, indented). */
  details?: string[];
  /** Paths this error is about; used by --porcelain renderers. */
  paths?: string[];
  /** Process exit code. Defaults are derived from the code. */
  exitCode?: number;
  cause?: unknown;
}

function defaultExitCode(code: ErrorCode): number {
  switch (code) {
    case "USAGE":
      return EXIT.USAGE;
    case "CONFLICTS_PENDING":
    case "DECISION_REQUIRED":
    case "SYNC_IN_PROGRESS":
      return EXIT.PENDING;
    case "DOCTOR_PROBLEMS":
      return EXIT.PROBLEMS;
    default:
      return EXIT.ERROR;
  }
}

export class OvergitError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details: string[];
  readonly paths: string[];
  readonly exitCode: number;

  constructor(code: ErrorCode, message: string, opts: OvergitErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "OvergitError";
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details ?? [];
    this.paths = opts.paths ?? [];
    this.exitCode = opts.exitCode ?? defaultExitCode(code);
  }
}

export function isOvergitError(e: unknown): e is OvergitError {
  return e instanceof OvergitError;
}

/** Convenience for the extremely common "one bad path" case. */
export function pathError(
  code: ErrorCode,
  path: string,
  message: string,
  hint?: string,
): OvergitError {
  return new OvergitError(code, message, { hint, paths: [path] });
}

/** A failed syscall on a path the caller was entitled to read or write. */
export function ioError(path: string, e: unknown): OvergitError {
  return new OvergitError("IO_FAILED", `cannot access ${path}: ${(e as Error).message}`, {
    hint: "check the path's permissions",
    paths: [path],
    cause: e,
  });
}
