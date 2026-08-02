/**
 * Bootstrap: making an overlay exist on a machine, and unmounting it again.
 *
 * Four jobs live here.
 *
 * **`initOverlay`** creates an overlay from nothing: a repository at `.overgit/.git`, an
 * empty manifest, one commit so `HEAD` resolves, and the `/.overgit/` line in the base's
 * `.git/info/exclude` so the base is blind to it from the first second.
 *
 * **`cloneOverlay`** is the one-command bootstrap. It clones the overlay (and optionally
 * the base) and hands over to `applyState`. The rule that governs every line of it:
 *
 * > The overlay is **never** allowed to do a bulk `git checkout` into the work-tree.
 *
 * A bulk checkout would write every path the overlay tracks straight over the base's files
 * with no backup and no ownership check. So the clone is `--no-checkout`, the index is
 * filled with `read-tree` (which does not touch the work-tree), and every byte that reaches
 * the work-tree is written by `applyState`, one path at a time, with backup-on-surprise.
 *
 * **`detach` / `attach`** are the escape hatch for the measured limitation in DESIGN.md
 * §6.5: git aborts `git pull` and `git checkout <branch>` when upstream touches a file the
 * overlay overrides. `detach` turns the work-tree back into a byte-exact pristine base
 * checkout, `attach` (`applyState` plus clearing the marker) puts the overlay back.
 *
 * **`hooksInstall` / `hooksUninstall`** are strictly opt-in. They write a managed block
 * into `post-merge`, `post-checkout` and `post-rewrite`, preserving whatever was there.
 *
 * ## Interruption safety
 *
 * Every clone happens in `.overgit/.clone-<pid>-<rand>/` and the finished git dir is
 * `rename`d into place, so `.overgit/.git` either does not exist or is a complete
 * repository — never something in between. Anything a killed run can leave behind is
 * recoverable by the next run:
 *
 * | killed during           | left behind                    | next run does            |
 * |-------------------------|--------------------------------|--------------------------|
 * | `git clone`             | `.overgit/.clone-*`            | deletes it, clones again |
 * | after `rename`          | a repo with no config/index    | re-configures, re-reads  |
 * | `read-tree` / manifest  | empty index / missing manifest | redoes both              |
 * | `applyState`            | a partly built work-tree       | `applyState` is idempotent |
 */

import { existsSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { OvergitError } from "./errors.ts";
import { Git } from "./git.ts";
import { discover, withLock, type Context } from "./context.ts";
import {
  emptyManifest,
  ownedPaths,
  readManifest,
  serializeManifest,
  writeManifest,
  type Manifest,
} from "./manifest.ts";
import {
  applyManagedBlock,
  ensureOverlayExcludes,
  readManagedBlock,
  syncExcludeBlock,
} from "./exclude.ts";
import {
  applyState,
  materialise,
  readWorktreeEntry,
  rescueWorktreeBytes,
  stageOverlayContent,
  worktreeMatches,
  type ApplyOptions,
  type ApplyReport,
} from "./ownership.ts";
import { literalPathspec, type IndexEntry } from "./git.ts";

const enc = new TextEncoder();

/** Repo-relative path of the manifest. It is tracked *by the overlay*, so it has one. */
export const MANIFEST_REPO_PATH = ".overgit/manifest.json";

/** Marker file inside `.overgit/local/` recording that the overlay is unmounted. */
export const DETACH_MARKER = "detached";

/** Prefix of the scratch directories `cloneOverlay` clones into. */
const CLONE_TMP_PREFIX = ".clone-";

/** Overlay config that makes `.overgit/.git` an ordinary, relocatable repository. */
const OVERLAY_CONFIG: ReadonlyArray<readonly [string, string]> = [
  // `core.worktree` is relative to the git dir, so `../..` from `<root>/.overgit/.git`
  // is `<root>` — the whole tree can be moved or renamed and the overlay still works.
  ["core.bare", "false"],
  ["core.worktree", "../.."],
  // The overlay's work-tree is full of the *base's* files. They are not its business.
  ["status.showUntrackedFiles", "no"],
];

const SUPPORTED_MODES = new Set(["100644", "100755", "120000"]);

/* ------------------------------------------------------------------ tiny fs helpers */

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

type EntryKind = "absent" | "file" | "symlink" | "dir" | "other";

async function entryKind(abs: string): Promise<EntryKind> {
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
    return "other";
  } catch {
    return "absent";
  }
}

function scratchName(prefix: string): string {
  return `${prefix}${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

function ioError(path: string, e: unknown): OvergitError {
  return new OvergitError("IO_FAILED", `cannot write ${path}: ${(e as Error).message}`, {
    hint: "check that the directory exists and is writable",
    paths: [path],
    cause: e,
  });
}

/** Atomic write via a sibling temp file, optionally preserving a file mode. */
async function writeFileAtomic(path: string, bytes: Uint8Array, mode?: number): Promise<void> {
  const tmp = `${path}.overgit-tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(tmp, bytes);
    if (mode !== undefined) await fs.chmod(tmp, mode);
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw ioError(path, e);
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove directories that exist only because an overlay-added file was in them.
 *
 * git cannot represent an empty directory, so a plain `git clone` of the base never has
 * one. Leaving `scripts/` behind after deleting `scripts/dev.sh` would make a detached
 * work-tree distinguishable from a pristine checkout — which is precisely the property
 * `detach` promises. `rmdir` is the whole safety mechanism: it refuses a directory that
 * still holds anything, so this can never delete something in use.
 */
async function pruneEmptyParents(root: string, repoPath: string): Promise<string[]> {
  const removed: string[] = [];
  let rel = dirname(repoPath);
  while (rel !== "" && rel !== "." && rel !== "/") {
    if (rel === ".overgit" || rel.startsWith(".overgit/")) break;
    try {
      await fs.rmdir(join(root, rel));
    } catch {
      break; // not empty, or already gone
    }
    removed.push(rel);
    rel = dirname(rel);
  }
  return removed;
}

/**
 * Put the base's pristine bytes back at `p`, the way git itself would.
 *
 * Writing the raw blob is wrong whenever the user has content filters configured: with
 * `core.autocrlf=true` the work-tree is supposed to hold CRLF while the blob holds LF, so a
 * raw write leaves the base reporting the file as modified — and `git pull` then aborts,
 * which makes the detach → pull → attach remedy unusable for exactly the people who need it.
 * `git checkout -- <path>` runs the smudge filters *and* updates the index's cached stat
 * data, so the result is byte-identical to a fresh checkout and `git status` agrees.
 * (`git checkout-index` writes the same bytes but leaves the stat cache describing the old
 * file, so `git status` reports ` M <path>` while `git diff` is empty — measured. Restoring
 * one path the base already tracks is not the bulk overlay checkout the design forbids.)
 *
 * The skip-worktree bit has to come off first: git will not write a path the index says is
 * not in the work-tree. The bit is cleared for good a few steps later anyway.
 */
async function restorePristine(ctx: Context, p: string, base: IndexEntry): Promise<void> {
  if (base.skipWorktree) await ctx.base.clearSkipWorktree([p]);
  await fs.mkdir(dirname(join(ctx.root, p)), { recursive: true });
  const r = await ctx.base.run(["checkout", "-f", "--", literalPathspec(p)], {
    allowFailure: true,
  });
  if (r.code === 0) return;
  // Fall back to a raw write rather than leaving the path missing. Anything that defeats
  // `checkout-index` (an exotic filter, a mode we do not model) still leaves the user with
  // the right bytes, and `doctor` will report the difference if a filter mattered.
  await materialise(ctx, p, base.mode, await ctx.base.catFileBlob(base.oid));
}

function indexMap(entries: IndexEntry[]): Map<string, IndexEntry> {
  const m = new Map<string, IndexEntry>();
  for (const e of entries) if (e.stage === 0) m.set(e.path, e);
  return m;
}

/* ------------------------------------------------------------------ url handling */

/**
 * Turn a *local* clone source into an absolute path.
 *
 * `git clone` resolves a relative local path against its own cwd, and `cloneOverlay` runs
 * the overlay clone from the base's root — which is not necessarily where the user typed
 * the command. Resolving here means `overgit clone --base ../up ../ov proj` means what it
 * looks like. Anything that is not an existing local path (a URL, `git@host:repo`) is
 * handed to git untouched.
 */
export function resolveCloneUrl(cwd: string, url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return trimmed;
  if (trimmed.includes("://")) return trimmed;
  const abs = resolve(cwd, trimmed);
  return existsSync(abs) ? abs : trimmed;
}

function stripFileScheme(u: string): string {
  return u.startsWith("file://") ? u.slice("file://".length) : u;
}

function normaliseUrl(u: string): string {
  let s = stripFileScheme(u.trim());
  s = s.replace(/\/+$/, "");
  s = s.replace(/\.git$/, "");
  return s;
}

/**
 * Are these two clone sources the same repository?
 *
 * Deliberately lenient about the two spellings that trip people up on a re-run: a trailing
 * `/` or `.git`, and a relative vs absolute local path. Being lenient here only ever turns
 * a spurious error into a successful no-op.
 */
export function sameRemote(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  if (normaliseUrl(a) === normaliseUrl(b)) return true;
  const ra = localRealpath(a);
  const rb = localRealpath(b);
  return ra !== null && rb !== null && ra === rb;
}

function localRealpath(u: string): string | null {
  const s = stripFileScheme(u.trim());
  if (s.includes("://")) return null;
  try {
    return realpathSync(s);
  } catch {
    return null;
  }
}

/** What `git clone <url>` would name the directory. */
export function defaultDirFromUrl(url: string): string {
  let s = stripFileScheme(url.trim()).replace(/\/+$/, "");
  const colon = s.lastIndexOf(":");
  const slash = s.lastIndexOf("/");
  s = s.slice(Math.max(colon, slash) + 1);
  s = s.replace(/\.git$/, "");
  if (s === "" || s === "." || s === "..") {
    throw new OvergitError("USAGE", `cannot work out a directory name from ${url}`, {
      hint: "pass the target directory explicitly: `overgit clone --base <base-url> <overlay-url> <dir>`",
    });
  }
  return s;
}

function assertBranchName(git: Git, name: string): Promise<void> {
  // `git check-ref-format` has no `--` end-of-options marker (measured: exit 129). It needs
  // none here — the argument always starts with `refs/heads/`, so it can never look like an
  // option however hostile `name` is.
  return git
    .run(["check-ref-format", `refs/heads/${name}`], { allowFailure: true })
    .then((r) => {
      if (r.code !== 0) {
        throw new OvergitError("USAGE", `${name} is not a valid branch name`, {
          hint: "pass a branch name git accepts, e.g. `--branch main`",
        });
      }
    });
}

/* ------------------------------------------------------------------ overlay plumbing */

/** True when `.overgit/.git` is a repository with a `HEAD` file (a finished clone/init). */
async function overlayLooksReal(ctx: Context): Promise<boolean> {
  return pathExists(join(ctx.overlayGitDir, "HEAD"));
}

/**
 * Make the overlay's own config correct. Idempotent, and safe to call on an overlay that a
 * previous run left half-configured — which is exactly what a `kill -9` between the
 * `rename` and the first `git config` produces.
 */
export async function ensureOverlayConfig(ctx: Context): Promise<string[]> {
  const changed: string[] = [];
  for (const [key, want] of OVERLAY_CONFIG) {
    const cur = await ctx.overlay.run(["config", "--local", "--get", key], {
      allowFailure: true,
    });
    if (cur.code === 0 && cur.stdout.trim() === want) continue;
    await ctx.overlay.run(["config", "--local", key, want]);
    changed.push(key);
  }
  return changed;
}

/**
 * Fill the overlay index from `HEAD` when it is empty.
 *
 * `git clone --no-checkout` leaves the index empty (measured on git 2.55: `git status` in
 * such a clone reports every tracked path as deleted). `read-tree` — **without** `-u` —
 * populates it and does not go near the work-tree.
 *
 * Only ever runs on an *empty* index, so it can never discard staged overlay content, and
 * running it again after a successful bootstrap is a no-op.
 */
async function ensureOverlayIndex(ctx: Context): Promise<boolean> {
  if (!(await ctx.overlay.headExists())) return false;
  const entries = await ctx.overlay.lsFiles();
  if (entries.length > 0) return false;
  await ctx.overlay.run(["read-tree", "HEAD"]);
  return true;
}

export type ManifestState = "present" | "written" | "missing";

/**
 * Put `.overgit/manifest.json` on disk from the overlay's own copy.
 *
 * Without this `applyState` would read an absent manifest as "the overlay owns nothing"
 * and a fresh clone would silently produce a plain base checkout. An existing file is
 * never overwritten — it may hold changes the user has not committed yet.
 */
async function materialiseManifest(ctx: Context): Promise<ManifestState> {
  if (await pathExists(ctx.manifestPath)) return "present";
  const oid =
    (await ctx.overlay.indexBlobOid(MANIFEST_REPO_PATH)) ??
    (await ctx.overlay.headBlobOid(MANIFEST_REPO_PATH));
  if (oid === null) return "missing";
  await writeFileAtomic(ctx.manifestPath, await ctx.overlay.catFileBlob(oid));
  return "written";
}

/** Delete scratch clone directories no live process owns. */
async function cleanStaleCloneTemps(ctx: Context): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(ctx.overgitDir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(CLONE_TMP_PREFIX)) continue;
    const pid = Number.parseInt(name.slice(CLONE_TMP_PREFIX.length), 10);
    if (Number.isInteger(pid) && pid !== process.pid && pidIsAlive(pid)) continue;
    await fs.rm(join(ctx.overgitDir, name), { recursive: true, force: true }).catch(() => {});
    removed.push(name);
  }
  return removed;
}

/* ------------------------------------------------------------------ initOverlay */

export interface InitOptions {
  remote?: string;
  branch?: string;
}

export interface InitResult {
  ctx: Context;
  created: boolean;
  /** Additive: the branch `HEAD` points at, and the remote that was configured. */
  branch: string | null;
  remote: string | null;
}

/**
 * Create an overlay in the base work-tree containing `cwd`.
 *
 * Order matters: the base's exclude block is written *before* anything appears under
 * `.overgit/`, so a `git status` racing this never sees overlay storage as untracked.
 */
export async function initOverlay(cwd: string, opts: InitOptions = {}): Promise<InitResult> {
  const probe = await discover(cwd);
  if (probe.hasOverlay) {
    throw new OvergitError(
      "OVERLAY_EXISTS",
      `${probe.overlayGitDir} already exists — this work-tree already has an overlay`,
      {
        hint: "run `overgit apply` to re-materialise it, or `overgit status` to see what it owns",
        paths: [probe.overlayGitDir],
      },
    );
  }

  const plain = new Git({ cwd: probe.root });
  if (opts.branch !== undefined) await assertBranchName(plain, opts.branch);

  await withLock(probe, async () => {
    // A previous run may have died before the overlay had a HEAD. That directory is
    // overgit's own scratch space and holds nothing recoverable, so it goes.
    await cleanStaleCloneTemps(probe);
    if (await pathExists(probe.overlayGitDir)) {
      await fs.rm(probe.overlayGitDir, { recursive: true, force: true });
    }

    await fs.mkdir(probe.localDir, { recursive: true });
    await syncExcludeBlock(probe, emptyManifest());

    await plain.run(["init", "--bare", "--quiet", probe.overlayGitDir]);
    if (opts.branch !== undefined) {
      await probe.overlay.run(["symbolic-ref", "HEAD", `refs/heads/${opts.branch}`]);
    }
    await ensureOverlayConfig(probe);
    await ensureOverlayExcludes(probe);

    // The manifest is the portable half of the overlay's state, so it is committed
    // immediately: `HEAD` must resolve before anything else can clone this overlay.
    const manifest = emptyManifest();
    await writeManifest(probe, manifest);
    const oid = await probe.overlay.hashObject(enc.encode(serializeManifest(manifest)), {
      write: true,
    });
    await probe.overlay.updateIndexCacheinfo("100644", oid, MANIFEST_REPO_PATH);
    await probe.overlay.commit("overgit: initialise overlay");

    if (opts.remote !== undefined && opts.remote !== "") {
      const url = resolveCloneUrl(probe.cwd, opts.remote);
      await probe.overlay.run(["remote", "add", "origin", url]);
      const branch = await probe.overlay.currentBranch();
      if (branch !== null) {
        // Configure the upstream now so `overgit push` / `overgit pull` need no `-u`.
        await probe.overlay.run(["config", "--local", `branch.${branch}.remote`, "origin"]);
        await probe.overlay.run([
          "config",
          "--local",
          `branch.${branch}.merge`,
          `refs/heads/${branch}`,
        ]);
      }
    }
  });

  const ctx = await discover(cwd, { requireOverlay: true });
  const remote = await readOrigin(ctx);
  return { ctx, created: true, branch: await ctx.overlay.currentBranch(), remote };
}

async function readOrigin(ctx: Context): Promise<string | null> {
  const r = await ctx.overlay.run(["config", "--local", "--get", "remote.origin.url"], {
    allowFailure: true,
  });
  if (r.code !== 0) return null;
  const url = r.stdout.trim();
  return url.length > 0 ? url : null;
}

/* ------------------------------------------------------------------ cloneOverlay */

export interface CloneOptions {
  overlayUrl: string;
  baseUrl?: string;
  dir?: string;
  cwd: string;
  branch?: string;
}

export interface CloneResult {
  ctx: Context;
  apply: ApplyReport;
  /** True when the overlay was already here and this run only reconciled the work-tree. */
  alreadyPresent: boolean;
  /* ---- additive, for the CLI's output ---- */
  /** Absolute work-tree root that now holds the merged tree. */
  root: string;
  /** True when this run cloned the base repository too. */
  baseCloned: boolean;
  /** True when this run cloned the overlay (false on the re-run no-op path). */
  overlayCloned: boolean;
  /** Where the overlay's `origin` points. */
  overlayUrl: string;
  overlayBranch: string | null;
  /** How many paths the overlay owns. */
  owned: number;
  /** Whether `.overgit/manifest.json` had to be restored from the overlay. */
  manifest: ManifestState;
  /** Scratch state a previous interrupted run left behind and this one cleaned up. */
  recovered: string[];
}

/**
 * The one-command bootstrap.
 *
 * ```
 * overgit clone <overlay-url>                          # inside an existing base checkout
 * overgit clone --base <base-url> <overlay-url> [dir]  # from nothing
 * ```
 *
 * Re-running either form in an already-bootstrapped directory is a clean no-op:
 * `alreadyPresent: true`, `apply.changed === false`, nothing written. A `.overgit/.git`
 * whose `origin` is a *different* repository is an error naming both URLs — silently
 * ignoring it would hide the fact that the tree does not match the overlay that was asked
 * for.
 */
export async function cloneOverlay(opts: CloneOptions): Promise<CloneResult> {
  const cwd = resolve(opts.cwd);
  const overlayUrl = resolveCloneUrl(cwd, opts.overlayUrl);
  if (overlayUrl === "") {
    throw new OvergitError("USAGE", "no overlay URL given", {
      hint: "run `overgit clone <overlay-url>`",
    });
  }
  if (opts.branch !== undefined) await assertBranchName(new Git({ cwd }), opts.branch);

  let baseCloned = false;
  let targetDir: string;
  if (opts.baseUrl !== undefined && opts.baseUrl !== "") {
    const baseUrl = resolveCloneUrl(cwd, opts.baseUrl);
    targetDir = resolve(cwd, opts.dir ?? defaultDirFromUrl(baseUrl));
    baseCloned = await ensureBaseClone(cwd, baseUrl, targetDir);
  } else {
    targetDir = resolve(cwd, opts.dir ?? ".");
  }

  const probe = await discover(targetDir);
  const recovered = await cleanStaleCloneTemps(probe);

  if (await overlayLooksReal(probe)) {
    const origin = await readOrigin(probe);
    if (!sameRemote(origin, overlayUrl)) {
      throw new OvergitError(
        "OVERLAY_EXISTS",
        `${probe.overlayGitDir} already holds an overlay cloned from ${origin ?? "(no origin configured)"}, not ${overlayUrl}`,
        {
          hint: `use that overlay (\`overgit apply\`), or remove ${probe.overlayGitDir} and clone again`,
          paths: [probe.overlayGitDir],
          details: [
            `existing origin: ${origin ?? "(none)"}`,
            `requested:       ${overlayUrl}`,
          ],
        },
      );
    }
    const done = await withLock(probe, () => finishBootstrap(probe));
    return {
      ...done,
      alreadyPresent: true,
      root: probe.root,
      baseCloned,
      overlayCloned: false,
      overlayUrl: origin ?? overlayUrl,
      recovered,
    };
  }

  // Hide `.overgit/` from the base before a single byte lands in it.
  await fs.mkdir(probe.overgitDir, { recursive: true });
  await syncExcludeBlock(probe, emptyManifest());

  const done = await withLock(probe, async () => {
    await fs.mkdir(probe.localDir, { recursive: true });

    const tmpRoot = join(probe.overgitDir, scratchName(CLONE_TMP_PREFIX));
    try {
      await fs.mkdir(tmpRoot, { recursive: true });
      const wt = join(tmpRoot, "wt");
      const args = ["clone", "--quiet", "--no-checkout"];
      if (opts.branch !== undefined) args.push("--branch", opts.branch);
      args.push("--", overlayUrl, wt);
      const r = await new Git({ cwd: probe.root }).run(args, { allowFailure: true });
      if (r.code !== 0) {
        throw new OvergitError("GIT_FAILED", `cannot clone the overlay from ${overlayUrl}`, {
          hint: "check the URL and that you can reach it (`git ls-remote <url>`)",
          details: r.stderr.split("\n").filter((l) => l.trim().length > 0),
        });
      }
      // A half-made repo with no HEAD holds nothing recoverable: `discover` does not
      // consider it an overlay, and neither do we. Removing it here rather than before the
      // clone keeps the window in which `.overgit/.git` is absent — and therefore
      // `.overgit/` is not protected from `git clean -xfd` (DESIGN.md §6.6) — down to the
      // gap between these two syscalls.
      if (await pathExists(probe.overlayGitDir)) {
        await fs.rm(probe.overlayGitDir, { recursive: true, force: true });
        recovered.push(".git");
      }
      // `rename` is atomic: `.overgit/.git` is a complete repository or does not exist.
      await fs.rename(join(wt, ".git"), probe.overlayGitDir);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }

    return finishBootstrap(probe);
  });

  return {
    ...done,
    alreadyPresent: false,
    root: probe.root,
    baseCloned,
    overlayCloned: true,
    overlayUrl: (await readOrigin(done.ctx)) ?? overlayUrl,
    recovered,
  };
}

/**
 * Everything between "there is a repository at `.overgit/.git`" and "the work-tree holds
 * the merged tree". Runs on both the fresh-clone and the already-present paths, so an
 * interrupted first run is finished by the second one instead of wedging it.
 */
async function finishBootstrap(probe: Context): Promise<{
  ctx: Context;
  apply: ApplyReport;
  manifest: ManifestState;
  owned: number;
  overlayBranch: string | null;
}> {
  await ensureOverlayConfig(probe);
  await ensureOverlayExcludes(probe);
  await ensureOverlayIndex(probe);
  const manifest = await materialiseManifest(probe);

  // Re-discover so the returned context reports `hasOverlay: true`.
  const ctx = await discover(probe.cwd, { requireOverlay: true });
  const apply = await attach(ctx);
  const m = await readManifest(ctx);
  return {
    ctx,
    apply,
    manifest,
    owned: ownedPaths(m).length,
    overlayBranch: await ctx.overlay.currentBranch(),
  };
}

/** Clone the base unless `targetDir` already *is* that clone. Returns true when it cloned. */
async function ensureBaseClone(cwd: string, baseUrl: string, targetDir: string): Promise<boolean> {
  if (await pathExists(targetDir)) {
    if ((await entryKind(targetDir)) !== "dir") {
      throw new OvergitError("IO_FAILED", `${targetDir} exists and is not a directory`, {
        hint: "pass a different target directory",
        paths: [targetDir],
      });
    }
    const probe = new Git({ cwd: targetDir });
    const top = await probe.run(["rev-parse", "--show-toplevel"], { allowFailure: true });
    if (top.code === 0) {
      const toplevel = resolve(targetDir, top.stdout.trim());
      if (await sameDirectory(toplevel, targetDir)) {
        const origin = await probe.run(["config", "--local", "--get", "remote.origin.url"], {
          allowFailure: true,
        });
        const url = origin.code === 0 ? origin.stdout.trim() : null;
        if (sameRemote(url, baseUrl)) return false; // the re-run case
        throw new OvergitError(
          "NOT_IN_BASE_REPO",
          `${targetDir} is already a git work-tree cloned from ${url ?? "(no origin configured)"}, not ${baseUrl}`,
          {
            hint: "pass a different target directory, or run `overgit clone <overlay-url>` inside the checkout you want",
            paths: [targetDir],
            details: [`existing origin: ${url ?? "(none)"}`, `requested:       ${baseUrl}`],
          },
        );
      }
    }
    const entries = await fs.readdir(targetDir).catch(() => [] as string[]);
    if (entries.length > 0) {
      throw new OvergitError("IO_FAILED", `${targetDir} already exists and is not empty`, {
        hint: "pass an empty (or non-existent) target directory",
        paths: [targetDir],
      });
    }
  }

  const r = await new Git({ cwd }).run(["clone", "--quiet", "--", baseUrl, targetDir], {
    allowFailure: true,
  });
  if (r.code !== 0) {
    throw new OvergitError("GIT_FAILED", `cannot clone the base from ${baseUrl}`, {
      hint: "check the URL and that you can reach it (`git ls-remote <url>`)",
      details: r.stderr.split("\n").filter((l) => l.trim().length > 0),
    });
  }
  return true;
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  try {
    return (await fs.realpath(a)) === (await fs.realpath(b));
  } catch {
    return resolve(a) === resolve(b);
  }
}

/* ------------------------------------------------------------------ detach / attach */

export interface DetachMarker {
  version: 1;
  detachedAt: string;
  /** Overlay `HEAD` at the moment of detaching, for `overgit status` / `doctor`. */
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
  complete?: boolean;
}

export interface DetachOptions {
  /**
   * Replace a directory or special file occupying a path the overlay owns. Without it such
   * a path is reported and left alone — deleting a directory tree is not something an
   * unmount should do behind the user's back.
   */
  force?: boolean;
}

export interface DetachAction {
  path: string;
  action:
    | "stage"
    | "restore-base"
    | "remove-add"
    | "remove-orphan"
    | "prune-dir"
    | "clear-skip"
    | "backup"
    | "noop";
  detail?: string;
}

export interface DetachReport {
  actions: DetachAction[];
  /** Root-relative paths under `.overgit/local/backups/`. */
  backups: string[];
  restored: string[];
  removed: string[];
  clearedSkip: string[];
  /** True when the overlay was already unmounted; nothing was touched. */
  alreadyDetached: boolean;
  /** Absolute path of the marker file `status` / `doctor` read. */
  marker: string;
}

export function detachMarkerPath(ctx: Context): string {
  return join(ctx.localDir, DETACH_MARKER);
}

export async function readDetachMarker(ctx: Context): Promise<DetachMarker | null> {
  let text: string;
  try {
    text = await fs.readFile(detachMarkerPath(ctx), "utf8");
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text) as Partial<DetachMarker>;
    return {
      version: 1,
      detachedAt: typeof raw.detachedAt === "string" ? raw.detachedAt : "",
      overlayHead: typeof raw.overlayHead === "string" ? raw.overlayHead : null,
      paths: Array.isArray(raw.paths) ? raw.paths.filter((p) => typeof p === "string") : [],
      restored: Array.isArray(raw.restored) ? raw.restored.filter((p) => typeof p === "string") : [],
      removed: Array.isArray(raw.removed) ? raw.removed.filter((p) => typeof p === "string") : [],
    };
  } catch {
    // A corrupt marker still means "detached" — that is the safe reading.
    return { version: 1, detachedAt: "", overlayHead: null, paths: [], restored: [], removed: [] };
  }
}

export async function isDetached(ctx: Context): Promise<boolean> {
  return pathExists(detachMarkerPath(ctx));
}

/** Remove the detached marker. Returns true when there was one. */
export async function clearDetachMarker(ctx: Context): Promise<boolean> {
  const p = detachMarkerPath(ctx);
  if (!(await pathExists(p))) return false;
  await fs.rm(p, { force: true });
  return true;
}

/**
 * Unmount the overlay: make the work-tree a byte-exact pristine base checkout.
 *
 * The order is dictated by the safety invariant — *overlay content is never only in the
 * work-tree*:
 *
 *  1. stage every `add`/`override` path's current work-tree bytes into the overlay index,
 *     so whatever is about to be overwritten is already in `.overgit/.git/objects`;
 *  2. restore the base's own bytes for every `override` and whiteout (from the base
 *     **index**, which is what `git status` compares against once skip-worktree freezes it);
 *  3. delete overlay-added files;
 *  4. clear the skip-worktree bits — content first, so `git status` never blinks;
 *  5. shrink the exclude block back to `/.overgit/`;
 *  6. write the marker.
 *
 * Step 5 keeps `/.overgit/` deliberately. Dropping it would expose the overlay's own
 * storage to the base, and a `git add -A` in the detached state would commit the whole
 * overlay repository into the base's history.
 *
 * Detaching an already-detached work-tree does nothing at all — re-running step 1 would
 * stage the *base's* bytes over the overlay's content, which is the one way this operation
 * could lose data.
 */
export async function detach(ctx: Context, opts: DetachOptions = {}): Promise<DetachReport> {
  if (!ctx.hasOverlay) {
    throw new OvergitError("NO_OVERLAY", `no overlay in ${ctx.root}`, {
      hint: "run `overgit init` to create one, or `overgit clone <url>` to fetch one",
    });
  }

  return withLock(ctx, async () => {
    const marker = detachMarkerPath(ctx);
    if (await isDetached(ctx)) {
      return {
        actions: [],
        backups: [],
        restored: [],
        removed: [],
        clearedSkip: [],
        alreadyDetached: true,
        marker,
      };
    }

    const m: Manifest = await readManifest(ctx);
    const paths = ownedPaths(m);
    const baseEntries = await ctx.base.lsFiles();
    const baseIndex = indexMap(baseEntries);
    const baseSkip = new Set(baseEntries.filter((e) => e.skipWorktree).map((e) => e.path));
    const overlayIndex = indexMap(await ctx.overlay.lsFiles());

    const actions: DetachAction[] = [];
    const backups: string[] = [];
    const restored: string[] = [];
    const removed: string[] = [];

    // ── 0. claim the detach BEFORE touching anything ──
    //
    // The marker used to be written last, which made an interrupted detach silently
    // destructive: a kill after step 2 leaves base-pristine bytes in the work-tree and no
    // marker, so the *next* `overgit detach` re-runs step 1 and stages those restored base
    // bytes over the overlay's index entry — overwriting the user's content with the very
    // bytes it was meant to protect them from. Writing it first means a half-finished detach
    // is recognised as "already detached": `detach` becomes a no-op and `attach` rebuilds
    // everything from the overlay, which is exactly the recovery we want.
    await fs.mkdir(ctx.localDir, { recursive: true });
    await writeFileAtomic(
      marker,
      enc.encode(
        JSON.stringify(
          {
            version: 1,
            detachedAt: new Date().toISOString(),
            overlayHead: await ctx.overlay.revParse("HEAD"),
            paths,
            restored: [],
            removed: [],
            complete: false,
          },
          null,
          2,
        ) + "\n",
      ),
    );

    // ── 1. content first ──
    for (const p of paths) {
      if (m.entries[p]!.kind === "delete") continue;
      const wt = await readWorktreeEntry(ctx.root, p);
      if (wt === null) {
        actions.push({ path: p, action: "noop", detail: "nothing in the work-tree to stage" });
        continue;
      }
      const before = overlayIndex.get(p);

      // Never stage bytes that are the *base's* pristine content over overlay content that
      // differs. Those bytes are the signature of an already-detached work-tree, and staging
      // them is how an interrupted detach used to destroy the user's overlay: the second run
      // would preserve the restored base file as if it were the user's work. The step-0
      // marker normally prevents a second run entirely; this makes it safe even when the
      // marker is missing (deleted by hand, or lost with `.overgit/local/`).
      const baseEntry = baseIndex.get(p);
      if (baseEntry !== undefined && before !== undefined) {
        const isBasePristine = await worktreeMatches(ctx.root, p, baseEntry.oid, baseEntry.mode);
        if (isBasePristine && before.oid !== baseEntry.oid) {
          actions.push({
            path: p,
            action: "noop",
            detail: "already holds the base's content; keeping the overlay's",
          });
          continue;
        }
      }

      const oid = await stageOverlayContent(ctx, p, wt.mode, wt.content);
      if (before === undefined || before.oid !== oid || before.mode !== wt.mode) {
        actions.push({ path: p, action: "stage", detail: oid });
      }
    }

    // ── 2/3. base-pristine bytes back, overlay-added files gone ──
    for (const p of paths) {
      const entry = m.entries[p]!;
      const abs = join(ctx.root, p);
      const kind = await entryKind(abs);

      if (entry.kind === "add") {
        if (kind === "absent") {
          actions.push({ path: p, action: "noop" });
        } else if (kind === "dir" || kind === "other") {
          actions.push({
            path: p,
            action: "noop",
            detail: `a ${kind === "dir" ? "directory" : "special file"} occupies this path`,
          });
        } else {
          await fs.rm(abs, { force: true });
          removed.push(p);
          actions.push({ path: p, action: "remove-add" });
        }
        continue;
      }

      const base = baseIndex.get(p);
      if (base === undefined) {
        // The base stopped tracking it. There is no pristine content to restore; the
        // overlay's bytes are staged, so removing the file loses nothing.
        if (entry.kind === "override" && (kind === "file" || kind === "symlink")) {
          await fs.rm(abs, { force: true });
          removed.push(p);
          actions.push({ path: p, action: "remove-orphan", detail: "the base no longer tracks it" });
        } else {
          actions.push({ path: p, action: "noop", detail: "the base no longer tracks it" });
        }
        continue;
      }
      if (!SUPPORTED_MODES.has(base.mode)) {
        actions.push({ path: p, action: "noop", detail: `unsupported base mode ${base.mode}` });
        continue;
      }
      if (await worktreeMatches(ctx.root, p, base.oid, base.mode)) {
        actions.push({ path: p, action: "noop" });
        continue;
      }

      if (kind === "dir" || kind === "other") {
        if (!opts.force) {
          actions.push({
            path: p,
            action: "noop",
            detail: `a ${kind === "dir" ? "directory" : "special file"} occupies this path; re-run with --force to replace it`,
          });
          continue;
        }
        await fs.rm(abs, { recursive: true, force: true });
      } else if (entry.kind === "delete" && kind !== "absent") {
        // A whiteout path that has come back. Its bytes were never staged into the
        // overlay (a whiteout holds no overlay content), so rescue anything surprising.
        const expected = await worktreeMatches(ctx.root, p, entry.baseBlob, base.mode);
        if (!expected) {
          const rel = await rescueWorktreeBytes(ctx, p, `overgit detach: ${p}`);
          if (rel !== null) {
            backups.push(rel);
            actions.push({ path: p, action: "backup", detail: rel });
          }
        }
      }

      await restorePristine(ctx, p, base);
      restored.push(p);
      actions.push({ path: p, action: "restore-base" });
    }

    // ── 3a. refresh the base's cached stat data ──
    //
    // `checkout-index` writes the file but leaves the index's cached stat info describing
    // the *previous* file, so `git status` reports ` M <path>` on a byte-correct work-tree
    // (`git diff` is empty — the giveaway that it is stat-dirty, not modified). That is
    // visible enough to look like a leak and, with content filters on, common enough to hit
    // every time. `--refresh` re-stats and rewrites the index; `-q` because a path that
    // genuinely differs is not an error here.
    if (restored.length > 0) {
      await ctx.base.run(["update-index", "-q", "--refresh"], { allowFailure: true });
    }

    // ── 3b. prune directories that existed only to hold overlay-added files ──
    // git cannot represent an empty directory, so a plain clone of the base never has one.
    // Leaving `scripts/` behind after deleting `scripts/dev.sh` would make a detached
    // work-tree distinguishable from a pristine checkout, which is the property `detach`
    // exists to provide. Deepest-first so nested parents collapse in one pass; `rmdir`
    // refuses a non-empty directory, so this can never remove something still in use.
    const pruned: string[] = [];
    for (const p of [...removed].sort((a, b) => b.length - a.length)) {
      pruned.push(...(await pruneEmptyParents(ctx.root, p)));
    }
    for (const d of pruned) actions.push({ path: d, action: "prune-dir" });

    // ── 4. release the index bits ──
    const clearedSkip = paths.filter(
      (p) => m.entries[p]!.kind !== "add" && baseIndex.has(p) && baseSkip.has(p),
    );
    await ctx.base.clearSkipWorktree(clearedSkip);
    for (const p of clearedSkip) actions.push({ path: p, action: "clear-skip" });

    // ── 5. the exclude block shrinks to `/.overgit/` and nothing else ──
    await syncExcludeBlock(ctx, emptyManifest());

    // ── 6. finalise the marker written in step 0 ──
    const record: DetachMarker = {
      version: 1,
      detachedAt: new Date().toISOString(),
      overlayHead: await ctx.overlay.revParse("HEAD"),
      paths,
      restored,
      removed,
      complete: true,
    };
    await fs.mkdir(ctx.localDir, { recursive: true });
    await writeFileAtomic(marker, enc.encode(JSON.stringify(record, null, 2) + "\n"));

    return {
      actions,
      backups,
      restored,
      removed,
      clearedSkip,
      alreadyDetached: false,
      marker,
    };
  });
}

/**
 * Mount the overlay: `applyState` plus clearing the detached marker.
 *
 * This is what both `overgit apply` and `overgit attach` should call — a successful
 * `applyState` *is* a remount, so leaving the marker behind would make `overgit status`
 * lie. A dry run never clears it.
 */
export async function attach(ctx: Context, opts?: ApplyOptions): Promise<ApplyReport> {
  const report = await applyState(ctx, opts);
  if (opts?.dryRun !== true) await clearDetachMarker(ctx);
  return report;
}

/* ------------------------------------------------------------------ hooks */

export const HOOK_NAMES = ["post-merge", "post-checkout", "post-rewrite"] as const;
export type HookName = (typeof HOOK_NAMES)[number];

export interface HookChange {
  hook: HookName;
  path: string;
  action: "created" | "updated" | "unchanged" | "removed" | "absent";
  /** Something the user needs to know, e.g. the file is not executable. */
  warning?: string;
}

/** Absolute hooks directory, honouring `core.hooksPath` and linked worktrees. */
export async function hooksDir(ctx: Context): Promise<string> {
  const r = await ctx.base.run(["rev-parse", "--git-path", "hooks"]);
  return resolve(ctx.root, r.stdout.trim());
}

function hookRecordPath(ctx: Context): string {
  return join(ctx.localDir, "hooks.json");
}

async function readHookRecord(ctx: Context): Promise<Set<HookName>> {
  try {
    const raw = JSON.parse(await fs.readFile(hookRecordPath(ctx), "utf8")) as {
      created?: unknown;
    };
    const created = Array.isArray(raw.created) ? raw.created : [];
    return new Set(created.filter((h): h is HookName => (HOOK_NAMES as readonly string[]).includes(h as string)));
  } catch {
    return new Set();
  }
}

async function writeHookRecord(ctx: Context, created: Set<HookName>): Promise<void> {
  await fs.mkdir(ctx.localDir, { recursive: true });
  await writeFileAtomic(
    hookRecordPath(ctx),
    enc.encode(JSON.stringify({ created: [...created].sort() }, null, 2) + "\n"),
  );
}

/** POSIX-shell single-quoting: the only reliable way to embed an arbitrary path. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The absolute invocation to bake into the hook as a fallback.
 *
 * `command -v overgit` fails whenever overgit was installed as a shell alias, a function, or
 * run via `bun run` — and a hook that silently does nothing while reporting success is worse
 * than no hook. `process.execPath` is the bun binary that is running us and `bin/overgit` sits
 * next to `src/`, so together they are a self-contained command that works from any cwd.
 */
function hookFallbackCommand(): { exe: string; script: string } {
  return {
    exe: shQuote(process.execPath),
    script: shQuote(join(import.meta.dir, "..", "bin", "overgit")),
  };
}

const SHEBANG = "#!/bin/sh";
const CREATED_BY_OVERGIT = "# created by overgit (`overgit hooks install`)";

/**
 * The managed block's body.
 *
 * Constraints this satisfies, in order of how badly they bite:
 *
 *  - it must never change the exit status of the user's git command, so the last statement
 *    is unconditionally successful and every failure path only writes to stderr;
 *  - it must survive `set -e` in the surrounding hook, so nothing runs bare;
 *  - it must survive being run from an odd cwd (`git pull` in a subdirectory), so the root
 *    comes from `git rev-parse --show-toplevel` with `$PWD` as the fallback;
 *  - it must do nothing at all when overgit is not installed, or when this work-tree has no
 *    overlay (`git clone` runs `post-checkout` before there could possibly be one);
 *  - it must never `exit`, because a user's own code may follow the block.
 */
function hookBlockLines(hook: HookName, fb: { exe: string; script: string }): string[] {
  return [
    `# overgit re-applies the overlay after ${hook}. It never changes the exit status of`,
    "# your git command; problems are reported on stderr only.",
    // A hook runs with git's environment, not your interactive shell's, and overgit is often
    // installed as an alias or run via `bun run` — in which case `command -v overgit` finds
    // nothing and the whole safety net silently does nothing while reporting success. So
    // fall back to the absolute invocation captured when the hook was installed.
    // A shell *function*, not a variable: quotes inside an expanded variable are literal,
    // so `overgit_run="'/path/bun' '/path/overgit'"` then `$overgit_run apply` tries to exec
    // a command whose name literally contains apostrophes. Measured the hard way.
    "overgit_hook_ok=0",
    "if command -v overgit >/dev/null 2>&1; then",
    "\tovergit_hook_run() { overgit \"$@\"; }",
    "\tovergit_hook_ok=1",
    `elif [ -x ${fb.exe} ] && [ -f ${fb.script} ]; then`,
    `\tovergit_hook_run() { ${fb.exe} ${fb.script} "$@"; }`,
    "\tovergit_hook_ok=1",
    "fi",
    'if [ "$overgit_hook_ok" = 1 ]; then',
    "\tovergit_top=$(git rev-parse --show-toplevel 2>/dev/null) || overgit_top=",
    '\t[ -n "$overgit_top" ] || overgit_top=$PWD',
    // `.overgit/.git` is the overlay GIT_DIR (DESIGN.md §6.6) and may legitimately be a
    // gitfile, so this tests for existence, not for a `HEAD` inside a directory.
    '\tif [ -e "$overgit_top/.overgit/.git" ]; then',
    '\t\tif ! (cd "$overgit_top" && overgit_hook_run apply >/dev/null); then',
    `\t\t\techo "overgit: 'overgit apply' failed after ${hook}; run 'overgit doctor' (your git command was not affected)" >&2`,
    "\t\tfi",
    "\tfi",
    "fi",
    "unset overgit_top overgit_hook_ok 2>/dev/null || :",
    "unset -f overgit_hook_run 2>/dev/null || :",
    ": # overgit block ends here — this keeps its exit status 0",
  ];
}

/**
 * Install the managed block into `post-merge`, `post-checkout` and `post-rewrite`.
 *
 * Existing hook content is preserved byte for byte (the block editor from `exclude.ts` does
 * the work), the file keeps its mode and its shebang, and a file overgit created is
 * recorded so `hooksUninstall` knows it may delete it again.
 *
 * Returns the paths that changed. `hooksInstallReport` has the detail.
 */
export async function hooksInstall(ctx: Context): Promise<string[]> {
  const report = await hooksInstallReport(ctx);
  return report.filter((h) => h.action !== "unchanged").map((h) => h.path);
}

export async function hooksInstallReport(ctx: Context): Promise<HookChange[]> {
  const dir = await hooksDir(ctx);
  await fs.mkdir(dir, { recursive: true });
  const created = await readHookRecord(ctx);
  const out: HookChange[] = [];
  const fallbackCmd = hookFallbackCommand();
  const onPath = Bun.which("overgit") !== null;

  for (const hook of HOOK_NAMES) {
    const path = join(dir, hook);
    const existed = await pathExists(path);
    let before = new Uint8Array(0);
    let mode = 0o755;
    let warning: string | undefined;

    if (existed) {
      before = new Uint8Array(await fs.readFile(path));
      const st = await fs.lstat(path);
      mode = st.mode & 0o7777;

      // Appending POSIX shell to a hook written in another language turns it into a syntax
      // error, and a hook that fails makes the user's `git checkout` exit non-zero — the
      // exact opposite of this block's promise. Refuse rather than break their tooling.
      const shebang = new TextDecoder().decode(before.slice(0, 200)).split("\n", 1)[0] ?? "";
      if (shebang.startsWith("#!") && !/\b(sh|bash|dash|ksh|zsh)\b/.test(shebang)) {
        out.push({
          hook,
          path,
          action: "unchanged",
          warning:
            `${path} is not a POSIX-shell hook (${shebang.trim()}), so overgit will not ` +
            `append to it — doing so would make your git command fail. Add this line to it ` +
            `by hand instead: overgit apply >/dev/null 2>&1 || true`,
        });
        continue;
      }
      if ((mode & 0o111) === 0) {
        // Making it executable would silently re-enable a hook the user disabled on
        // purpose, so the mode is left exactly as it was and the user is told.
        warning = `${path} is not executable, so git will not run it (chmod +x it to enable the overgit block)`;
      }
    } else {
      before = enc.encode(`${SHEBANG}\n${CREATED_BY_OVERGIT}\n`);
    }

    // A hook that reports success and then does nothing is the worst outcome here, so say
    // plainly when the PATH lookup will miss and the baked-in absolute path is load-bearing.
    if (!onPath && warning === undefined && out.length === 0) {
      warning =
        "`overgit` is not on PATH, so the hook falls back to the absolute path of this " +
        "install — it will stop working if you move or delete it. Putting `overgit` on " +
        "PATH (see the README's Install section) is more robust.";
    }

    const result = applyManagedBlock(before, hookBlockLines(hook, fallbackCmd));
    if (!result.changed && existed) {
      out.push({ hook, path, action: "unchanged", ...(warning ? { warning } : {}) });
      continue;
    }
    await writeFileAtomic(path, result.bytes, mode);
    if (!existed) created.add(hook);
    out.push({
      hook,
      path,
      action: existed ? "updated" : "created",
      ...(warning ? { warning } : {}),
    });
  }

  await writeHookRecord(ctx, created);
  for (const h of out) {
    if (h.warning) process.stderr.write(`overgit: warning: ${h.warning}\n`);
  }
  return out;
}

/**
 * Remove the managed block, and nothing else.
 *
 * The file itself is deleted only when overgit created it *and* nothing but the shebang and
 * overgit's own header comment is left — anything the user added survives, in place.
 */
export async function hooksUninstall(ctx: Context): Promise<string[]> {
  const report = await hooksUninstallReport(ctx);
  return report.filter((h) => h.action !== "absent" && h.action !== "unchanged").map((h) => h.path);
}

export async function hooksUninstallReport(ctx: Context): Promise<HookChange[]> {
  const dir = await hooksDir(ctx);
  const created = await readHookRecord(ctx);
  const out: HookChange[] = [];

  for (const hook of HOOK_NAMES) {
    const path = join(dir, hook);
    if (!(await pathExists(path))) {
      created.delete(hook);
      out.push({ hook, path, action: "absent" });
      continue;
    }
    const before = new Uint8Array(await fs.readFile(path));
    if (readManagedBlock(before) === null) {
      out.push({ hook, path, action: "unchanged" });
      continue;
    }
    const st = await fs.lstat(path);
    const result = applyManagedBlock(before, null);

    if (created.has(hook) && isOnlyOurScaffolding(result.bytes)) {
      await fs.rm(path, { force: true });
      created.delete(hook);
      out.push({ hook, path, action: "removed" });
      continue;
    }
    await writeFileAtomic(path, result.bytes, st.mode & 0o7777);
    created.delete(hook);
    out.push({ hook, path, action: "updated" });
  }

  await writeHookRecord(ctx, created);
  return out;
}

/** True when nothing is left but blank lines, a shebang, and overgit's own header. */
function isOnlyOurScaffolding(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "") continue;
    if (line === SHEBANG) continue;
    if (line === CREATED_BY_OVERGIT) continue;
    return false;
  }
  return true;
}

/** Which hooks currently carry the managed block. For `overgit doctor` / `status`. */
export async function hooksInstalled(ctx: Context): Promise<HookName[]> {
  const dir = await hooksDir(ctx);
  const out: HookName[] = [];
  for (const hook of HOOK_NAMES) {
    const path = join(dir, hook);
    if (!(await pathExists(path))) continue;
    const bytes = new Uint8Array(await fs.readFile(path).catch(() => Buffer.alloc(0)));
    if (readManagedBlock(bytes) !== null) out.push(hook);
  }
  return out;
}
