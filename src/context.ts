/**
 * Repository discovery and the advisory lock.
 *
 * `discover` answers the only question every command starts with: *where are the two
 * repositories?* It walks up for the base work-tree, refuses to run inside a git
 * directory or a bare repo, and resolves the base's git dir the way git itself does
 * (including a `.git` *file* for linked worktrees and submodules).
 *
 * Since the overlay GIT_DIR lives at `<root>/.overgit/.git`, plain git
 * discovery started anywhere under `<root>/.overgit/` resolves to the **overlay**, whose
 * `core.worktree=../..` makes it claim `<root>` as its work-tree. Everything below would
 * then silently treat the overlay as the base. `discover` detects that and re-resolves.
 */

import { openSync, closeSync, writeSync, unlinkSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Git, GitError } from "./git.ts";
import { pathExists } from "./files.ts";
import { isPathInside } from "./paths.ts";
import { OvergitError } from "./errors.ts";

export interface Context {
  /** realpath of the base work-tree root */
  root: string;
  /** realpath of the invocation cwd */
  cwd: string;
  /**
   * Absolute, resolved base git dir. This is the git **common** dir: for an ordinary repo
   * it is `<root>/.git`; inside a linked worktree it is the *main* repo's `.git`, which is
   * where `info/exclude` actually lives (measured on git 2.55).
   */
  baseGitDir: string;
  /**
   * Where this worktree's `index` lives: `.git/worktrees/<name>` inside a linked worktree,
   * equal to `baseGitDir` for an ordinary repo.
   */
  baseWorktreeGitDir: string;
  overgitDir: string;
  /**
   * `<root>/.overgit/.git`. It is a *real* git dir, not a gitfile: `git clean` only skips a
   * directory that looks like a repository, and its test (`is_nonbare_repository_dir`) looks
   * for `<dir>/.git`.
   * That is what keeps `git clean -xfd` from deleting the manifest and the backups.
   */
  overlayGitDir: string;
  /**
   * Where that git dir *actually* is. The same path, except when `.overgit/.git` is a
   * gitfile, in which case it is the directory the pointer names.
   *
   * Anything that opens a file inside the git dir (`info/exclude`, `config`) must use this
   * one — git resolves the pointer itself, `node:fs` does not. `overlayGitDir` stays the
   * path to hand to `git --git-dir`, to name in a message, and to create or remove.
   * Equal to `overlayGitDir` when there is no overlay at all.
   */
  overlayGitDirReal: string;
  localDir: string;
  manifestPath: string;
  base: Git;
  overlay: Git;
  hasOverlay: boolean;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Where `.overgit/.git` really is, or `null` when there is no overlay there.
 *
 * A directory only counts once it has a HEAD — a half-made clone does not. A *gitfile* at
 * `.overgit/.git` counts too: measured on git 2.55, `git clean -xfd` spares the directory
 * and `git -C .overgit log` works, so it is healthy by the only test that matters. Insisting
 * on a real directory made every overgit command report "no overlay" on a perfectly good
 * setup, and made `doctor` unable to distinguish it from the *dangling* gitfile — which is
 * the shape that silently loses everything.
 *
 * The resolved path is what callers need to open a file *inside* the git dir: git follows
 * the pointer on its own, `node:fs` does not.
 */
export async function resolveOverlayGitDir(overlayGitDir: string): Promise<string | null> {
  if ((await isDir(overlayGitDir)) && (await isFile(join(overlayGitDir, "HEAD")))) {
    return overlayGitDir;
  }
  if (!(await isFile(overlayGitDir))) return null;
  const text = await Bun.file(overlayGitDir)
    .text()
    .catch(() => "");
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (m === null) return null;
  const target = m[1]!;
  const abs = isAbsolute(target) ? target : resolve(dirname(overlayGitDir), target);
  return (await isDir(abs)) && (await isFile(join(abs, "HEAD"))) ? abs : null;
}

/**
 * Is there an overlay at `overlayGitDir`?
 *
 * One predicate, because three copies of it had grown: `cloneOverlay` deleted a live gitfile
 * overlay and `add`/`apply`/`attach` reported "no overlay repository" on one, both because
 * their own copy tested `.overgit/.git/HEAD` and a gitfile has no such path.
 */
export async function overlayLooksReal(overlayGitDir: string): Promise<boolean> {
  return (await resolveOverlayGitDir(overlayGitDir)) !== null;
}

/** The overlay's git dir is, by construction, `<something>/.overgit/.git`. */
function looksLikeOverlayGitDir(gitDir: string): boolean {
  return basename(gitDir) === ".git" && basename(dirname(gitDir)) === ".overgit";
}

interface Located {
  toplevel: string;
  gitDir: string;
  commonDir: string;
}

/**
 * Ask git where it thinks it is, from `dir`. Returns `null` when `dir` is not in a repo.
 * All three paths are resolved against `dir`, because `--git-common-dir` is reported
 * *relative to the cwd* in an ordinary repo (measured: `../../.git` from a subdirectory).
 */
async function locate(dir: string): Promise<Located | null> {
  const g = new Git({ cwd: dir });
  const r = await g.run(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], {
    allowFailure: true,
  });
  if (r.code !== 0) return null;
  const lines = r.stdout.split("\n").filter((l) => l.length > 0);
  const [toplevel, gitDir, commonDir] = lines;
  if (!toplevel || !gitDir || !commonDir) return null;
  return {
    toplevel: resolve(dir, toplevel),
    gitDir: resolve(dir, gitDir),
    commonDir: resolve(dir, commonDir),
  };
}

export async function discover(
  cwd: string,
  opts?: { requireOverlay?: boolean },
): Promise<Context> {
  let cwdReal: string;
  try {
    cwdReal = await realpath(cwd);
  } catch (cause) {
    throw new OvergitError("IO_FAILED", `cannot resolve current directory: ${cwd}`, { cause });
  }

  const probe = new Git({ cwd: cwdReal });

  // Step 1: is this a repo at all, and is it a shape we can work in?
  // `--show-toplevel` is *fatal* inside a git dir and in a bare repo, so ask first.
  const shape = await probe.run(["rev-parse", "--is-inside-git-dir", "--is-bare-repository"], {
    allowFailure: true,
  });
  if (shape.code !== 0) {
    throw new OvergitError("NOT_IN_BASE_REPO", `not inside a git repository: ${cwdReal}`, {
      hint: "cd into a git work-tree, or run `git init` first",
      cause: new GitError(["rev-parse"], shape.code, shape.stderr, cwdReal),
    });
  }
  const [insideGitDir, isBare] = shape.stdout.trim().split("\n");
  // Bare first: a bare repo also reports `--is-inside-git-dir=true`, and "this is bare" is
  // the more useful message.
  if (isBare === "true") {
    throw new OvergitError("NOT_IN_BASE_REPO", `${cwdReal} is a bare repository`, {
      hint: "overgit needs a work-tree; run it inside a checked-out clone",
    });
  }
  if (insideGitDir === "true") {
    throw new OvergitError("INSIDE_GIT_DIR", `refusing to run inside a git directory: ${cwdReal}`, {
      hint: "cd back into the work-tree",
    });
  }

  // Step 2: locate everything.
  let located = await locate(cwdReal);
  if (!located) {
    throw new OvergitError("NOT_IN_BASE_REPO", `cannot locate the work-tree from ${cwdReal}`, {
      hint: "cd into a git work-tree",
    });
  }

  // Step 3: if git landed on the *overlay*, step outside `.overgit/` and look again. The
  // loop is bounded purely as a guard; git never descends into `.overgit` when searching
  // upwards, so one pass is always enough in practice.
  for (let i = 0; i < 8 && looksLikeOverlayGitDir(located.commonDir); i++) {
    const overgitDirFound = dirname(located.commonDir);
    const parent = dirname(overgitDirFound);
    const next = await locate(parent);
    if (!next) {
      throw new OvergitError(
        "NOT_IN_BASE_REPO",
        `${cwdReal} is inside the overgit overlay at ${overgitDirFound}, but ${parent} is not a git repository`,
        {
          hint: "an overlay only works on top of a base repo; clone the base first, then run `overgit clone`",
        },
      );
    }
    located = next;
  }
  if (looksLikeOverlayGitDir(located.commonDir)) {
    throw new OvergitError(
      "NOT_IN_BASE_REPO",
      `${cwdReal}: every candidate repository above it is an overgit overlay`,
      { hint: "cd into the base repository's work-tree" },
    );
  }

  let root: string;
  try {
    root = await realpath(located.toplevel);
  } catch {
    root = located.toplevel;
  }

  const baseWorktreeGitDir = located.gitDir;
  const baseGitDir = located.commonDir;

  const overgitDir = join(root, ".overgit");
  const overlayGitDir = join(overgitDir, ".git");
  const localDir = join(overgitDir, "local");
  const manifestPath = join(overgitDir, "manifest.json");

  // Git does **not** report `--is-inside-git-dir=true` inside the overlay's git dir: because
  // the overlay sets `core.worktree`, git considers that directory part of a work-tree
  // (measured). Step 1 therefore cannot catch this, so check it here.
  if (cwdReal === overlayGitDir || isPathInside(overlayGitDir, cwdReal)) {
    throw new OvergitError(
      "INSIDE_GIT_DIR",
      `refusing to run inside the overlay's git directory: ${cwdReal}`,
      { hint: `cd back into the work-tree (${root})` },
    );
  }

  const overlayReal = await resolveOverlayGitDir(overlayGitDir);
  const hasOverlay = overlayReal !== null;
  if (opts?.requireOverlay && !hasOverlay) {
    throw new OvergitError("NO_OVERLAY", `no overlay in ${root}`, {
      hint: "run `overgit init` to create one, or `overgit clone <url>` to fetch one",
    });
  }

  const base = new Git({ cwd: root, untrackedFiles: "normal" });
  // The overlay's work-tree is full of the base's files. Untracked reporting is forced off
  // on the command line so the answer does not depend on the overlay repo's config.
  const overlay = new Git({
    cwd: root,
    gitDir: overlayGitDir,
    workTree: root,
    untrackedFiles: "no",
  });

  return {
    root,
    cwd: cwdReal,
    baseGitDir,
    baseWorktreeGitDir,
    overgitDir,
    overlayGitDir,
    overlayGitDirReal: overlayReal ?? overlayGitDir,
    localDir,
    manifestPath,
    base,
    overlay,
    hasOverlay,
  };
}

/* ----------------------------------------- machine-local state files */

/**
 * Everything under `.overgit/local/` is machine-local: never tracked by the overlay, and
 * rebuildable from the manifest. The three files below are the ones other modules test for,
 * so their names live here rather than being spelled out at each call site.
 */

/** The advisory lock, held for the duration of any command that writes. */
export function lockPath(ctx: Context): string {
  return join(ctx.localDir, "lock");
}

/** Present while a sync is unfinished; holds everything `overgit sync --abort` needs. */
export function syncStatePath(ctx: Context): string {
  return join(ctx.localDir, "sync-state.json");
}

/** Present while `overgit detach` has the overlay unmounted. */
export function detachMarkerPath(ctx: Context): string {
  return join(ctx.localDir, "detached");
}

/** Root-relative directory holding rescued work-tree bytes. Reported to the user as-is. */
export const BACKUP_REL = ".overgit/local/backups";

/**
 * What `overgit detach` records when it unmounts the overlay.
 *
 * The file's *existence* is what makes the work-tree detached; these fields are the
 * description of that state, and `overgit status` reports them. Nothing reads them to decide
 * anything, so a marker written by an older overgit — or a corrupt one — still detaches.
 */
export interface DetachMarker {
  version: 1;
  detachedAt: string;
  /** Overlay `HEAD` at the moment of detaching. */
  overlayHead: string | null;
  /** Paths the overlay owned when it was unmounted. */
  paths: string[];
  restored: string[];
  removed: string[];
  /**
   * False while a detach is still running. The marker is written *before* any mutation so an
   * interrupted detach is recognised as detached — otherwise the next `detach` would stage
   * the base bytes it had already restored over the overlay's own content.
   */
  complete: boolean;
}

/** `null` only when there is no marker at all: an unreadable one still means detached. */
export async function readDetachMarker(ctx: Context): Promise<DetachMarker | null> {
  let text: string;
  try {
    text = await readFile(detachMarkerPath(ctx), "utf8");
  } catch {
    return null;
  }
  const blank: DetachMarker = {
    version: 1,
    detachedAt: "",
    overlayHead: null,
    paths: [],
    restored: [],
    removed: [],
    // Only an explicit `false` claims the detach was interrupted. A marker too damaged to
    // parse says nothing about that, and `attach` rebuilds from the overlay either way.
    complete: true,
  };
  try {
    const raw = JSON.parse(text) as Partial<DetachMarker>;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
    return {
      ...blank,
      detachedAt: typeof raw.detachedAt === "string" ? raw.detachedAt : "",
      overlayHead: typeof raw.overlayHead === "string" ? raw.overlayHead : null,
      paths: strings(raw.paths),
      restored: strings(raw.restored),
      removed: strings(raw.removed),
      complete: raw.complete !== false,
    };
  } catch {
    return blank;
  }
}

/* ------------------------------------------- is the base mid-operation? */

export interface BaseOperation {
  /** Prose naming it, e.g. `a merge`. */
  what: string;
  /** How to get out of it, phrased to drop into a hint. */
  remedy: string;
}

/**
 * Marker file in the base's per-worktree git dir → what it means, and how to end it.
 *
 * Order matters: `sequencer/` lives for the whole of a multi-commit cherry-pick or revert,
 * including while one of them is stopped at a conflict, so the specific markers above it
 * match first and give the specific advice.
 */
const BASE_OPERATIONS: ReadonlyArray<readonly [string, BaseOperation]> = [
  ["MERGE_HEAD", { what: "a merge", remedy: undo("merge") }],
  ["rebase-merge", { what: "a rebase", remedy: undo("rebase") }],
  ["rebase-apply", { what: "a rebase or `git am`", remedy: undo("rebase") }],
  ["CHERRY_PICK_HEAD", { what: "a cherry-pick", remedy: undo("cherry-pick") }],
  ["REVERT_HEAD", { what: "a revert", remedy: undo("revert") }],
  [
    "BISECT_LOG",
    { what: "a bisect", remedy: "carry on (`git bisect good`/`bad`) or end it (`git bisect reset`)" },
  ],
  // Reached only when the sequence is between commits rather than stopped at a conflict —
  // otherwise one of the markers above matches first. `--continue` belongs to whichever
  // command started it; `git cherry-pick --abort` ends a revert sequence too (git 2.55).
  [
    "sequencer",
    {
      what: "a cherry-pick or revert sequence",
      remedy:
        "finish it (`git cherry-pick --continue`, or `git revert --continue` if it is a revert)" +
        " or abandon it (`git cherry-pick --abort`)",
    },
  ],
];

function undo(cmd: string): string {
  return `finish it (\`git ${cmd} --continue\`) or abandon it (\`git ${cmd} --abort\`)`;
}

/** `null` when the base is idle. One list, because two of them had already drifted apart. */
export async function baseOperationInProgress(ctx: Context): Promise<BaseOperation | null> {
  for (const [marker, op] of BASE_OPERATIONS) {
    if (await pathExists(join(ctx.baseWorktreeGitDir, marker))) return op;
  }
  return null;
}

/* ----------------------------------------------------- advisory lock */

/**
 * Re-entrant per lock file: nested `withLock` calls in one process share the acquisition
 * instead of deadlocking, so composed commands (`sync` calling `applyState`) are safe.
 */
const held = new Map<string, number>();
/** Lock files this process created and has not released — used by the signal handlers. */
const ownedLockFiles = new Set<string>();
let signalHandlersInstalled = false;

function releaseAllSync(): void {
  for (const p of ownedLockFiles) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
  ownedLockFiles.clear();
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.on("exit", releaseAllSync);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      releaseAllSync();
      // Re-raising is not portable here; exit with the conventional 128+signo instead.
      const n = sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1;
      process.exit(128 + n);
    });
  }
}

/** True when a process with this pid exists — including one owned by somebody else. */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to somebody else — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** First line of the lock file is the pid; anything else means the file is corrupt. */
export function readLockPid(lockPath: string): number | null {
  try {
    const text = readFileSync(lockPath, "utf8");
    const first = text.split("\n", 1)[0]!.trim();
    const pid = Number.parseInt(first, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function tryCreateLock(lockPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new OvergitError("IO_FAILED", `cannot create lock file ${lockPath}`, { cause: e });
  }
  try {
    writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Runs `fn` while holding `<root>/.overgit/local/lock`.
 *
 * The lock is created with `O_EXCL` and holds the pid. A lock whose pid is gone (or whose
 * contents are unreadable — otherwise a corrupt file wedges the repo forever) is broken
 * with a warning on stderr. It is always released in `finally`, and also on
 * SIGINT/SIGTERM/SIGHUP and normal process exit.
 */
export async function withLock<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
  const path = lockPath(ctx);

  const depth = held.get(path) ?? 0;
  if (depth > 0) {
    held.set(path, depth + 1);
    try {
      return await fn();
    } finally {
      held.set(path, (held.get(path) ?? 1) - 1);
    }
  }

  // Claim synchronously, before the first await, so a nested call that starts while we are
  // still acquiring takes the re-entrant path instead of colliding with our own lock file.
  held.set(path, 1);
  try {
    await acquire(ctx, path);
  } catch (e) {
    held.set(path, 0);
    throw e;
  }

  ownedLockFiles.add(path);
  try {
    return await fn();
  } finally {
    held.set(path, 0);
    ownedLockFiles.delete(path);
    try {
      unlinkSync(path);
    } catch {
      /* somebody already broke it */
    }
  }
}

async function acquire(ctx: Context, path: string): Promise<void> {
  await mkdir(ctx.localDir, { recursive: true });
  installSignalHandlers();

  if (!tryCreateLock(path)) {
    const pid = readLockPid(path);
    if (pid !== null && pidIsAlive(pid)) {
      throw new OvergitError(
        "LOCKED",
        `another overgit process (pid ${pid}) is working in ${ctx.root}`,
        {
          hint: `wait for it to finish, or remove ${path} if you are sure it is dead`,
          paths: [path],
        },
      );
    }
    process.stderr.write(
      pid === null
        ? `overgit: warning: removing unreadable lock file ${path}\n`
        : `overgit: warning: removing stale lock file ${path} (pid ${pid} is gone)\n`,
    );
    try {
      unlinkSync(path);
    } catch {
      /* raced with the owner releasing it */
    }
    if (!tryCreateLock(path)) {
      throw new OvergitError("LOCKED", `cannot acquire the overgit lock in ${ctx.root}`, {
        hint: `remove ${path} if you are sure no other overgit is running`,
        paths: [path],
      });
    }
  }
}
