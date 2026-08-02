/**
 * Running git with the terminal attached.
 *
 * `src/git.ts` captures stdout/stderr and forces `GIT_TERMINAL_PROMPT=0`, which is exactly
 * right for plumbing and exactly wrong for `overgit push`: a credential prompt would fail
 * instead of asking, and `overgit log` would lose its pager and its colours. So the
 * user-facing passthrough commands get their own spawn: inherited stdio, no forced pager,
 * no prompt suppression — but the same environment scrubbing, because overgit can be
 * invoked from a git hook where `GIT_DIR` and `GIT_INDEX_FILE` are exported and would
 * silently retarget the command at the base repo.
 */

/** Kept in step with the list in `src/git.ts`; that one is private to the module. */
const SCRUBBED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_INDEX_VERSION",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_LITERAL_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_QUARANTINE_PATH",
];

export interface PassthroughOptions {
  gitDir: string;
  workTree: string;
  /** Where to run — the user's cwd, so relative pathspecs mean what they look like. */
  cwd: string;
  args: string[];
  /** Extra `-c key=value` settings applied before the subcommand. */
  config?: string[];
}

/**
 * Run `git` against the overlay with the terminal attached. Resolves to git's exit code;
 * a signal death becomes `128 + signo`, the shell convention.
 */
export async function gitPassthrough(opts: PassthroughOptions): Promise<number> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of SCRUBBED_ENV) delete env[k];

  const argv = [
    "git",
    "--git-dir",
    opts.gitDir,
    "--work-tree",
    opts.workTree,
    "-c",
    "core.quotepath=false",
    ...(opts.config ?? []).flatMap((c) => ["-c", c]),
    ...opts.args,
  ];

  const proc = Bun.spawn({
    cmd: argv,
    cwd: opts.cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (proc.signalCode) return 128 + signalNumber(proc.signalCode);
  return code;
}

const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGPIPE: 13,
  SIGTERM: 15,
};

function signalNumber(sig: string): number {
  return SIGNALS[sig] ?? 1;
}
