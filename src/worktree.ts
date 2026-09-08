/**
 * `overgit worktree`: a linked work-tree of the base that carries the overlay with it.
 *
 * `git worktree add` alone gives a second checkout of the base with no `.overgit/` in it.
 * `worktreeAdd` does that and then makes the new tree's `.overgit` a linked worktree of the
 * overlay repository, so both halves share history with their main counterparts: one base
 * repository, one overlay repository, two (or more) work-trees.
 *
 * Two facts about git shape everything here (both measured on git 2.55):
 *
 *  - a linked worktree's `core.worktree` must be its own, which needs
 *    `extensions.worktreeConfig` (see `bootstrap.ts`), and a relative value is resolved
 *    against `worktrees/<name>/`, so it is stored absolute;
 *  - the base's `info/exclude` is one file for all of its work-trees, so the managed block
 *    is the union of every work-tree's manifest (see `exclude.ts`).
 */

import { basename, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { OvergitError } from "./errors.ts";
import { Git, GitError } from "./git.ts";
import {
  discover,
  listBaseWorktrees,
  resolveOverlayGitDir,
  withLock,
  type Context,
} from "./context.ts";
import { pathExists } from "./files.ts";
import { ownedPaths, readManifest } from "./manifest.ts";
import { syncExcludeBlock } from "./exclude.ts";
import {
  enableOverlayWorktreeConfig,
  finishBootstrap,
  isDetached,
  type ManifestState,
} from "./bootstrap.ts";
import type { ApplyReport } from "./ownership.ts";

/* ------------------------------------------------------------------ add */

export interface WorktreeAddOptions {
  /** Where the new work-tree goes, relative to `ctx.cwd`. */
  path: string;
  /** `-b`: create this base branch at `commitish` (or HEAD) and check it out. */
  branch?: string;
  /** What the base checks out; git's default is HEAD. */
  commitish?: string;
  /**
   * The overlay branch for the new tree. Defaults to the base branch's name. Created from
   * the overlay's HEAD when it does not exist yet; git refuses one that is already checked
   * out in another overlay worktree, as it would for any repository.
   */
  overlayBranch?: string;
}

export interface WorktreeAddResult {
  /** realpath of the new work-tree. */
  root: string;
  baseBranch: string | null;
  overlayBranch: string | null;
  apply: ApplyReport;
  manifest: ManifestState;
  owned: number;
}

/**
 * Create a base work-tree at `opts.path` and give it this overlay.
 *
 * The base half is exactly `git worktree add`; the overlay half is `git worktree add
 * --no-checkout` of the overlay repository into `<path>/.overgit`, pointed at `<path>`, and
 * then the same bootstrap `overgit clone` finishes with. `--no-checkout` matters: a checkout
 * would put the overlay's files under `<path>/.overgit/` instead of `<path>/`.
 *
 * If the overlay half fails the base work-tree stays — git made it and it is a perfectly
 * good checkout — and the error says how to retry.
 */
export async function worktreeAdd(ctx: Context, opts: WorktreeAddOptions): Promise<WorktreeAddResult> {
  if (await isDetached(ctx)) {
    throw new OvergitError("UNSUPPORTED", "the overlay is detached, so there is nothing to carry into a new work-tree", {
      hint: "run `overgit attach` first",
    });
  }
  if (!(await ctx.overlay.headExists())) {
    throw new OvergitError("UNSUPPORTED", "the overlay has no commits, so a worktree cannot branch from it", {
      hint: 'run `overgit commit -m "initial overlay"` first',
    });
  }
  const target = resolve(ctx.cwd, opts.path);

  const created = await withLock(ctx, async () => {
    const add = ["worktree", "add"];
    if (opts.branch !== undefined) add.push("-b", opts.branch);
    add.push("--", target);
    if (opts.commitish !== undefined) add.push(opts.commitish);
    await ctx.base.run(add);

    const root = await realpath(target);
    const baseBranch = await new Git({ cwd: root }).currentBranch();
    const overlayBranch = opts.overlayBranch ?? opts.branch ?? baseBranch ?? basename(root);

    try {
      await enableOverlayWorktreeConfig(ctx);
      const exists = await ctx.overlay.revParse(`refs/heads/${overlayBranch}`);
      const link = ["worktree", "add", "--no-checkout"];
      if (exists === null) link.push("-b", overlayBranch);
      link.push("--", `${root}/.overgit`, exists === null ? "HEAD" : overlayBranch);
      await ctx.overlay.run(link);
    } catch (cause) {
      const detail = cause instanceof GitError ? cause.message : String(cause);
      throw new OvergitError("GIT_FAILED", `the base work-tree ${root} was created, but linking the overlay into it failed: ${detail}`, {
        hint: `run \`git worktree remove --force ${quoteShell(root)}\` and retry, or pick another overlay branch with --overlay-branch`,
        cause,
      });
    }
    return { root, baseBranch, overlayBranch };
  });

  // The new tree is its own repository pair from here on: its own lock, its own context.
  const probe = await discover(created.root);
  const fin = await withLock(probe, () => finishBootstrap(probe));
  return {
    root: created.root,
    baseBranch: created.baseBranch,
    overlayBranch: await fin.ctx.overlay.currentBranch(),
    apply: fin.apply,
    manifest: fin.manifest,
    owned: fin.owned,
  };
}

function quoteShell(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/* ------------------------------------------------------------------ list */

export interface WorktreeRow {
  root: string;
  main: boolean;
  current: boolean;
  /** Short base branch name, or `null` for a detached HEAD. */
  baseBranch: string | null;
  /** `null` when the work-tree has no overlay. */
  overlay: { branch: string | null; detached: boolean; linked: boolean; owned: number } | null;
}

/** Every work-tree of the base, with what overgit knows about each. */
export async function worktreeList(ctx: Context): Promise<WorktreeRow[]> {
  const rows: WorktreeRow[] = [];
  for (const wt of await listBaseWorktrees(ctx)) {
    const overlayGitDir = `${wt.root}/.overgit/.git`;
    const real = await resolveOverlayGitDir(overlayGitDir);
    let overlay: WorktreeRow["overlay"] = null;
    if (real !== null) {
      const git = new Git({ cwd: wt.root, gitDir: overlayGitDir, workTree: wt.root, untrackedFiles: "no" });
      let owned = 0;
      try {
        const sub = await discover(wt.root);
        owned = ownedPaths(await readManifest(sub)).length;
      } catch {
        // An unreadable sibling is its own `doctor`'s business; the list still shows it.
      }
      overlay = {
        branch: await git.currentBranch(),
        detached: await pathExists(`${wt.root}/.overgit/local/detached`),
        linked: real !== overlayGitDir,
        owned,
      };
    }
    rows.push({
      root: wt.root,
      main: wt.main,
      current: wt.current,
      baseBranch: wt.branch === null ? null : wt.branch.replace(/^refs\/heads\//, ""),
      overlay,
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ remove */

export interface WorktreeRemoveOptions {
  path: string;
  /** Remove even when the overlay there has uncommitted changes. */
  force?: boolean;
}

export interface WorktreeRemoveResult {
  root: string;
  /** The overlay branch the removed tree was on; it still exists in the overlay repo. */
  overlayBranch: string | null;
}

/**
 * Remove a linked base work-tree and the overlay worktree inside it.
 *
 * `git worktree remove` deletes the directory wholesale, `.overgit/` included, which is
 * why the overlay's uncommitted changes are checked first: git would not know to. The
 * overlay repository's `worktrees/<name>` bookkeeping is pruned afterwards, and the shared
 * exclude block is regenerated without the removed tree's paths.
 */
export async function worktreeRemove(ctx: Context, opts: WorktreeRemoveOptions): Promise<WorktreeRemoveResult> {
  let target: string;
  try {
    target = await realpath(resolve(ctx.cwd, opts.path));
  } catch {
    throw new OvergitError("PATH_NOT_FOUND", `${opts.path}: no such directory`, {
      hint: "run `overgit worktree list` to see the base's work-trees",
    });
  }
  const wt = (await listBaseWorktrees(ctx)).find((w) => w.root === target);
  if (wt === undefined) {
    throw new OvergitError("PATH_NOT_FOUND", `${target} is not a work-tree of this base repository`, {
      hint: "run `overgit worktree list` to see them",
    });
  }
  if (wt.main) {
    throw new OvergitError("UNSUPPORTED", `${target} is the main work-tree; git cannot remove that`, {
      hint: "a linked work-tree is removable, the main one is the repository",
    });
  }
  if (wt.current) {
    throw new OvergitError("UNSUPPORTED", `${target} is the work-tree you are in`, {
      hint: "run this from another work-tree of the base, for example the main one",
    });
  }

  const overlayGitDir = `${target}/.overgit/.git`;
  let overlayBranch: string | null = null;
  if ((await resolveOverlayGitDir(overlayGitDir)) !== null) {
    const git = new Git({ cwd: target, gitDir: overlayGitDir, workTree: target, untrackedFiles: "no" });
    overlayBranch = await git.currentBranch();
    if (!opts.force) {
      const dirty = await git.statusPorcelain();
      if (dirty.length > 0) {
        throw new OvergitError("DIRTY_OVERLAY", `the overlay in ${target} has ${dirty.length} uncommitted change(s), which \`git worktree remove\` would delete`, {
          hint: `commit them (\`overgit -C ${quoteShell(target)} commit\`), or pass --force to discard them`,
          paths: dirty.map((e) => e.path),
        });
      }
    }
  }

  await withLock(ctx, async () => {
    const rm = ["worktree", "remove"];
    if (opts.force) rm.push("--force");
    rm.push("--", target);
    await ctx.base.run(rm);
    await ctx.overlay.run(["worktree", "prune"]);
    await syncExcludeBlock(ctx, await readManifest(ctx));
  });
  return { root: target, overlayBranch };
}
