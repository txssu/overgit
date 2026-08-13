/**
 * Low-level process runner used by every other helper.
 *
 * Rules:
 *  - never inherits the parent's cwd (cwd is always explicit),
 *  - never inherits the parent's environment (the caller supplies the whole env),
 *  - always has a timeout: a hung child fails loudly instead of wedging `bun test`,
 *  - stdin is /dev/null unless the caller passes `input`, so a child that reads stdin
 *    sees EOF instead of blocking forever.
 */

/**
 * Result of running a command. The first three fields are the `CmdResult` shape every test
 * relies on; the rest are extras that make failures debuggable.
 */
export interface CmdResult {
  stdout: string;
  stderr: string;
  code: number;
  /** Full argv that was executed (argv[0] included). */
  argv: string[];
  /** Working directory the command ran in. */
  cwd: string;
  durationMs: number;
  /** True when the command was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
  /** Signal name when the child died from a signal, else null. */
  signal: string | null;
}

export interface RunOptions {
  /** Absolute path. Required by `runCommand` (there is no implicit cwd). */
  cwd?: string;
  /** Complete environment for the child. Keys with `undefined` values are dropped. */
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed. */
  input?: string | Uint8Array;
  /** Milliseconds before SIGTERM (then SIGKILL 2s later). */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = Number(
  process.env.OVERGIT_TEST_TIMEOUT_MS ?? 30_000,
);

/** Grace period between SIGTERM and SIGKILL when a command times out. */
const KILL_GRACE_MS = 2_000;

function cleanEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export async function runCommand(
  argv: string[],
  opts: RunOptions = {},
): Promise<CmdResult> {
  const cmd = argv.slice();
  if (cmd.length === 0) throw new Error("runCommand: empty argv");
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const stdin =
    opts.input === undefined
      ? ("ignore" as const)
      : typeof opts.input === "string"
        ? new TextEncoder().encode(opts.input)
        : opts.input;

  const started = performance.now();
  const proc = Bun.spawn({
    cmd,
    cwd,
    env: cleanEnv(opts.env),
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill(15);
    } catch {
      /* already gone */
    }
    killTimer = setTimeout(() => {
      try {
        proc.kill(9);
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  try {
    const [o, e, x] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    stdout = o;
    stderr = e;
    exitCode = typeof x === "number" ? x : null;
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }

  const signal = proc.signalCode ?? null;
  const code = exitCode ?? (signal ? 128 : 1);

  const result: CmdResult = {
    stdout,
    stderr,
    code,
    argv: cmd,
    cwd,
    durationMs: Math.round(performance.now() - started),
    timedOut,
    signal,
  };

  if (timedOut) {
    throw new Error(
      [
        `command timed out after ${timeoutMs}ms and was killed`,
        `  cmd: ${formatArgv(cmd)}`,
        `  cwd: ${cwd}`,
        indentBlock("stdout", stdout),
        indentBlock("stderr", stderr),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result;
}

/** Shell-ish rendering of an argv for error messages. Quoting is for humans only. */
export function formatArgv(argv: string[]): string {
  return argv
    .map((a) => (/^[A-Za-z0-9_./:=+@-]+$/.test(a) ? a : JSON.stringify(a)))
    .join(" ");
}

export function indentBlock(label: string, text: string): string {
  if (text.length === 0) return "";
  const body = text
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
  return `  ${label}:\n${body}`;
}

/** Multi-line dump of a CmdResult, used by every "this should have worked" message. */
export function describeResult(r: CmdResult): string {
  const lines = [
    `  cmd:  ${formatArgv(r.argv)}`,
    `  cwd:  ${r.cwd}`,
    `  exit: ${r.code}${r.signal ? ` (signal ${r.signal})` : ""}${r.timedOut ? " [TIMED OUT]" : ""}`,
  ];
  const out = indentBlock("stdout", r.stdout);
  const err = indentBlock("stderr", r.stderr);
  if (out) lines.push(out);
  if (err) lines.push(err);
  if (!out && !err) lines.push("  (no output)");
  return lines.join("\n");
}
