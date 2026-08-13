/**
 * Terminal output: colour policy, column layout, and the one frozen error shape.
 *
 * Rules this module exists to enforce, so no command has to remember them:
 *
 *  - **Never emit ANSI into a pipe.** Colour is decided per-stream from that stream's own
 *    `isTTY`, so `overgit status | cat` is clean even when stderr is still a terminal.
 *    `NO_COLOR` (any value) and `--no-color` turn it off; `--color=always` forces it on.
 *  - **Never emit raw control characters.** A filename may legally contain a newline or an
 *    escape sequence. Every path that reaches a human goes through `displayPath`, which
 *    C-quotes exactly the way `git` does. Machine output (`--porcelain`) is raw and
 *    NUL-terminated instead.
 *  - **One error shape**, everywhere:
 *
 *        error: <one line that names the offending path>
 *          hint: <what to run / what to do>
 */

import { isOvergitError, type OvergitError } from "./errors.ts";
import { GitError } from "./git.ts";

/* ------------------------------------------------------------------ colour */

export type ColorMode = "auto" | "always" | "never";

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
} as const;

export type Style = keyof typeof CODES;

function wrap(text: string, styles: Style[]): string {
  if (styles.length === 0 || text.length === 0) return text;
  return `\x1b[${styles.map((s) => CODES[s]).join(";")}m${text}\x1b[0m`;
}

/* ------------------------------------------------------- display width & quoting */

/** Zero-width: combining marks, variation selectors, zero-width space/joiners. */
function isCombining(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20f0) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

/** East-Asian Wide / Fullwidth, plus the emoji planes. Close enough for column padding. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Printable width of a string, ignoring ANSI escapes. Used only for padding. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) continue;
    if (isCombining(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

export function padEnd(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

const NEEDS_QUOTING = /[\x00-\x1f\x7f"\\]/;
const C_ESCAPES: Record<string, string> = {
  "\x07": "\\a",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\v": "\\v",
  '"': '\\"',
  "\\": "\\\\",
};

/**
 * Render a path for a human, C-quoting it when it contains a control character, a quote or
 * a backslash — the same rule `git` applies with `core.quotepath=false`.
 *
 * This is not decoration. Without it a file called `evil\n[2J.txt` would let a repository
 * clear the reader's terminal, and any file with a newline would silently corrupt a listing.
 */
export function displayPath(p: string): string {
  if (!NEEDS_QUOTING.test(p)) return p;
  let out = '"';
  for (const ch of p) {
    const esc = C_ESCAPES[ch];
    if (esc !== undefined) {
      out += esc;
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) {
      out += `\\${cp.toString(8).padStart(3, "0")}`;
      continue;
    }
    out += ch;
  }
  return out + '"';
}

/* ------------------------------------------------------------------ the Ui object */

export interface UiInit {
  color?: ColorMode;
  quiet?: boolean;
  /** Overridable for tests; defaults to the real streams. */
  stdoutIsTty?: boolean;
  stderrIsTty?: boolean;
  /** Overridable for tests; defaults to `process.env.NO_COLOR`. */
  noColor?: boolean;
}

function decideColor(mode: ColorMode, isTty: boolean, noColor: boolean): boolean {
  if (mode === "never") return false;
  if (mode === "always") return true;
  return isTty && !noColor;
}

/**
 * `overgit log | head -3` closes stdout under us. Bun surfaces that as an *asynchronous*
 * stream error, so a try/catch around `write()` never sees it — the process dies with a
 * stack trace instead. Swallowing EPIPE on both streams is the standard Unix behaviour:
 * the reader went away, there is nothing left to say, and it is not an error.
 */
let pipeGuardInstalled = false;
let pipeBroken = false;

function installPipeGuard(): void {
  if (pipeGuardInstalled) return;
  pipeGuardInstalled = true;
  for (const stream of [process.stdout, process.stderr]) {
    stream.on?.("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPIPE" || e.code === "ERR_STREAM_DESTROYED") pipeBroken = true;
    });
  }
}

export class Ui {
  readonly quiet: boolean;
  readonly colorOut: boolean;
  readonly colorErr: boolean;
  /** Set once stdout is gone (`overgit log | head`); further writes are dropped. */
  private brokenPipe = false;

  constructor(init: UiInit = {}) {
    installPipeGuard();
    const mode = init.color ?? "auto";
    const noColor = init.noColor ?? process.env.NO_COLOR !== undefined;
    this.quiet = init.quiet ?? false;
    this.colorOut = decideColor(mode, init.stdoutIsTty ?? Boolean(process.stdout.isTTY), noColor);
    this.colorErr = decideColor(mode, init.stderrIsTty ?? Boolean(process.stderr.isTTY), noColor);
  }

  /** Style for stdout. A no-op when stdout is not a colour destination. */
  s(text: string, ...styles: Style[]): string {
    return this.colorOut ? wrap(text, styles) : text;
  }

  /** Style for stderr. */
  es(text: string, ...styles: Style[]): string {
    return this.colorErr ? wrap(text, styles) : text;
  }

  private write(stream: NodeJS.WriteStream, text: string): void {
    if (this.brokenPipe || pipeBroken) return;
    try {
      stream.write(text);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") this.brokenPipe = true;
      else throw e;
    }
  }

  /** Requested data. Never suppressed by `--quiet`. */
  print(line = ""): void {
    this.write(process.stdout, line + "\n");
  }

  /** Exact bytes, no newline appended. For `--porcelain`. */
  raw(text: string): void {
    this.write(process.stdout, text);
  }

  /** Progress / summary chatter. Suppressed by `--quiet`. */
  say(line = ""): void {
    if (this.quiet) return;
    this.print(line);
  }

  /** Several lines of chatter at once. */
  sayAll(lines: string[]): void {
    for (const l of lines) this.say(l);
  }

  warn(message: string): void {
    this.write(process.stderr, `${this.es("warning:", "yellow", "bold")} ${message}\n`);
  }

  /** A raw line on stderr (already fully formatted). */
  errLine(line = ""): void {
    this.write(process.stderr, line + "\n");
  }

  /** The frozen error shape. Returns nothing; the caller owns the exit code. */
  reportError(e: unknown): void {
    for (const line of renderError(e, this.colorErr)) this.errLine(line);
  }
}

/* ------------------------------------------------------------------ error rendering */

/**
 * The measured §6.5 failure: git refuses to check out over a file whose work-tree bytes
 * differ from its index entry, which is exactly what an override looks like. When we see
 * that text anywhere in git's stderr the only useful advice is detach → git → attach.
 */
const CHECKOUT_ABORT_RE =
  /local changes to the following files would be overwritten|Please commit your changes or stash them before you|Your local changes to the following files would be overwritten/i;

const DETACH_HINT = "run `overgit detach`, re-run the git command, then `overgit attach`";

function gitStderrLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

/**
 * Render any thrown value into the frozen shape. Exported so tests can assert it without a
 * terminal, and so `--porcelain` renderers can reuse the same text.
 */
export function renderError(e: unknown, color = false): string[] {
  const tag = (t: string, ...styles: Style[]): string => (color ? wrap(t, styles) : t);
  const out: string[] = [];

  const emit = (message: string, hint?: string, details: string[] = []): void => {
    out.push(`${tag("error:", "red", "bold")} ${message}`);
    for (const d of details) out.push(`  ${tag(d, "dim")}`);
    if (hint) out.push(`  ${tag("hint:", "cyan")} ${hint}`);
  };

  if (isOvergitError(e)) {
    const err: OvergitError = e;
    emit(err.message, err.hint, err.details);
    return out;
  }

  if (e instanceof GitError) {
    const detail = gitStderrLines(e.stderr);
    const blocked = CHECKOUT_ABORT_RE.test(e.stderr);
    emit(
      e.message,
      blocked
        ? `an overlay file is in git's way — ${DETACH_HINT}`
        : "re-run with `OVERGIT_DEBUG=1` to see the full git invocation",
      detail.slice(0, 12),
    );
    return out;
  }

  const message = e instanceof Error ? e.message : String(e);
  emit(
    `internal error: ${message}`,
    "this is a bug in overgit; re-run with `OVERGIT_DEBUG=1` for a stack trace",
  );
  if (process.env.OVERGIT_DEBUG === "1" && e instanceof Error && e.stack) {
    for (const line of e.stack.split("\n")) out.push(`  ${line}`);
  }
  return out;
}

/* ------------------------------------------------------------------ layout */

/**
 * Left-align every column to the widest cell. The last column is never padded, so a table
 * piped through `cut` has no trailing whitespace.
 */
export function columns(rows: string[][], indent = "  ", gap = "  "): string[] {
  if (rows.length === 0) return [];
  const width: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      if (i === row.length - 1) return;
      width[i] = Math.max(width[i] ?? 0, displayWidth(cell));
    });
  }
  return rows.map((row) => {
    const cells = row.map((cell, i) => (i === row.length - 1 ? cell : padEnd(cell, width[i] ?? 0)));
    return (indent + cells.join(gap)).trimEnd();
  });
}

/** `1 file` / `3 files` — used everywhere, so it lives here. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
