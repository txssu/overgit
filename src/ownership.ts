/**
 * Ownership: the three overlay powers and the reconciler that materialises them.
 *
 * `takeOwnership` / `whiteout` / `restoreToBase` move a path between "the base's" and
 * "the overlay's". `applyState` is the idempotent reconciler that turns the manifest into
 * work-tree bytes, skip-worktree bits and exclude lines — it is what `overgit apply`,
 * `overgit clone` and `overgit doctor --fix` all ultimately run.
 *
 * Two rules govern every mutation in this file.
 *
 * **Content first.** Overlay content is written into `.overgit/.git/objects` *before*
 * anything else changes, so a crash — or a later `git clean -xfd` in the base — can never
 * lose it. Concretely the mutation order is always:
 *
 *     1. rescue surprising work-tree bytes into `.overgit/local/backups/`
 *     2. write overlay blobs + overlay index entries
 *     3. write the manifest (one atomic write for the whole batch)
 *     4. regenerate the exclude block
 *     5. set skip-worktree bits in the base
 *     6. touch the work-tree
 *
 * The manifest is therefore always written *before* the skip-worktree bits, so an
 * interrupted run leaves "manifest entry, no bit" — which `overgit doctor` reports as
 * `missing-skip-worktree` and can finish — and never the reverse, which would be an
 * invisible ownership claim. `restoreToBase` unwinds in the mirror order for the same
 * reason.
 *
 * **Validate everything, then mutate.** Every public function resolves and checks all of
 * its paths before writing a single byte, so `overgit add a b c d e` with a bad `d` leaves
 * the repo exactly as it found it.
 */

import { OvergitError, ioError, pathError } from "./errors.ts";
import type { Context } from "./context.ts";
import { BACKUP_REL } from "./context.ts";
import type { IndexEntry } from "./git.ts";
import { GitError, SUPPORTED_MODES, contentIsOid, indexMap, literalPathspec } from "./git.ts";
import type { WorktreeState } from "./files.ts";
import { pruneEmptyParents } from "./files.ts";
import {
  toRepoPath,
  isReservedPath,
  gitignoreEscape,
  gitignorePatternIsApproximate,
} from "./paths.ts";
import type { Kind, Manifest } from "./manifest.ts";
import {
  MANIFEST_REPO_PATH,
  cloneManifest,
  comparePaths,
  entryOf,
  ownedPaths,
  persistManifest,
  readManifest,
} from "./manifest.ts";
import { ensureOverlayExcludes, syncExcludeBlock } from "./exclude.ts";

import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

/* ------------------------------------------------------------------ public types */

/**
 * `from` may be the path's previous overlay kind — a whiteout being re-taken was never
 * "base" or "untracked" — and `to` may be `"none"`, because `restoreToBase` and un-adding
 * remove ownership rather than moving it.
 */
export type OwnershipTarget = Kind | "none";

export interface OwnershipChange {
  path: string;
  from: "base" | "untracked" | "absent" | Kind;
  to: OwnershipTarget;
  /** Root-relative path of a rescued copy of the previous work-tree bytes, if any. */
  backup?: string;
}

export interface OwnershipResult {
  changes: OwnershipChange[];
  skipped: { path: string; reason: string }[];
  /** Additive: root-relative paths of every file written under `.overgit/local/backups/`. */
  backups: string[];
}

export interface OwnershipOptions {
  force?: boolean;
  /**
   * Additive: treat inputs as already-normalised repo-relative POSIX paths instead of
   * resolving them against `ctx.cwd`. `sync.ts` and `doctor.ts` hold repo paths already.
   */
  repoRelative?: boolean;
}

export interface RestoreOptions extends OwnershipOptions {
  /** `add` entries only: leave the file on disk (untracked) instead of deleting it. */
  keepFile?: boolean;
}

export interface ApplyAction {
  path: string;
  action:
    | "write-override"
    | "write-add"
    | "remove-whiteout"
    | "set-skip"
    | "clear-skip"
    | "exclude"
    | "backup"
    | "noop";
  detail?: string;
}

export interface ApplyReport {
  actions: ApplyAction[];
  changed: boolean;
  /** Root-relative paths under `.overgit/local/backups/`. */
  backups: string[];
}

export interface ApplyOptions {
  dryRun?: boolean;
  /**
   * Replace a work-tree entry even when it is a directory or a non-regular file
   * (fifo/socket/device) where a file is expected. Without it those paths are reported as
   * `noop` with a detail, because removing a directory tree is not something a reconciler
   * should do behind the user's back.
   */
  force?: boolean;
}

/* ------------------------------------------------------------------ work-tree primitives */

/**
 * Reads a work-tree entry without ever following a symlink.
 *
 * Unlike `doctor.ts`'s reader, a failed read is an error here rather than a partial answer:
 * ownership is about to write, and acting on a half-read entry is how content gets lost.
 */
async function readWorktree(abs: string): Promise<WorktreeState> {
  let st: import("node:fs").Stats;
  try {
    st = await fs.lstat(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") {
      return { kind: "absent", mode: null, content: null };
    }
    throw ioError(abs, e);
  }
  if (st.isSymbolicLink()) {
    // The target is *content*, not a path to follow. It may point outside the work-tree;
    // that is legitimate and we still store it verbatim.
    const target = await fs.readlink(abs, { encoding: "buffer" }).catch((e) => {
      throw ioError(abs, e);
    });
    return { kind: "symlink", mode: "120000", content: new Uint8Array(target) };
  }
  if (st.isDirectory()) return { kind: "dir", mode: null, content: null };
  if (!st.isFile()) return { kind: "other", mode: null, content: null };
  const buf = await fs.readFile(abs).catch((e) => {
    throw ioError(abs, e);
  });
  return {
    kind: "file",
    mode: (st.mode & 0o111) !== 0 ? "100755" : "100644",
    content: new Uint8Array(buf),
  };
}

/** A scratch directory inside `.overgit/local/` so temp files are never visible to the base. */
async function tmpDirFor(ctx: Context): Promise<string> {
  const dir = join(ctx.localDir, "tmp");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function tmpName(dir: string): string {
  return join(dir, `w-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
}

/**
 * Materialise one entry at `abs`, atomically. Regular files and symlinks are built at a
 * temp path and renamed over the target, so a reader never sees a half-written file and an
 * existing symlink is replaced rather than written *through*.
 */
async function writeWorktreeEntry(
  ctx: Context,
  abs: string,
  mode: string,
  content: Uint8Array,
): Promise<void> {
  await fs.mkdir(dirname(abs), { recursive: true });
  const scratch = await tmpDirFor(ctx);

  const build = async (tmp: string): Promise<void> => {
    if (mode === "120000") {
      await fs.symlink(Buffer.from(content), tmp);
      return;
    }
    await fs.writeFile(tmp, content, { mode: 0o666 });
    const st = await fs.stat(tmp);
    const perm = st.mode & 0o7777;
    // Follow git: start from the umask-filtered default, then add x wherever r is set.
    const want = mode === "100755" ? perm | ((perm & 0o444) >> 2) : perm & ~0o111;
    if (want !== perm) await fs.chmod(tmp, want);
  };

  let tmp = tmpName(scratch);
  try {
    await build(tmp);
    await fs.rename(tmp, abs);
    return;
  } catch (e) {
    await fs.rm(tmp, { force: true, recursive: true }).catch(() => {});
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") {
      // `rename` also fails with EISDIR/ENOTEMPTY when a directory occupies the target;
      // callers only get here after clearing it, so anything else is a real error.
      throw ioError(abs, e);
    }
  }
  // `.overgit/local` turned out to be on another filesystem — fall back to a sibling temp.
  tmp = `${abs}.overgit-tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await build(tmp);
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true, recursive: true }).catch(() => {});
    throw ioError(abs, e);
  }
}

/** Remove a work-tree entry (file, symlink, or — only when asked — a directory tree). */
async function removeWorktreeEntry(abs: string, allowDir: boolean): Promise<void> {
  try {
    await fs.rm(abs, { force: true, recursive: allowDir });
  } catch (e) {
    throw ioError(abs, e);
  }
}

/* ------------------------------------------------------------------ backups */

/**
 * Rescue bytes to `.overgit/local/backups/<counter>-<slug>` and append a line to
 * `index.log` describing where they came from. Returns the *root-relative* path, which is
 * what the CLI prints and what `ApplyReport.backups` / `OwnershipResult.backups` contain.
 */
async function backupBytes(
  ctx: Context,
  repoPath: string,
  state: WorktreeState,
  reason: string,
): Promise<string> {
  const dir = join(ctx.localDir, "backups");
  await fs.mkdir(dir, { recursive: true });

  let maxN = 0;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const m = /^(\d{4,})-/.exec(name);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  const n = maxN + 1;
  const slug =
    repoPath
      .replace(/[/\\]/g, "-")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 80) || "file";
  const name = `${String(n).padStart(4, "0")}-${slug}`;
  const abs = join(dir, name);

  if (state.kind === "dir") {
    // A directory occupying a file's path: copy the whole tree, or `--force` would delete
    // real files and leave a zero-byte "backup" behind. Symlinks inside are copied as
    // symlinks, never followed.
    await fs.cp(join(ctx.root, repoPath), abs, {
      recursive: true,
      verbatimSymlinks: true,
      force: true,
    });
  } else if (state.content) {
    // A symlink is stored as its target text — a dangling symlink in the backup directory
    // would be useless, and the target *is* the content git would have hashed.
    await fs.writeFile(abs, state.content);
  } else {
    await fs.writeFile(abs, new Uint8Array(0));
  }

  const record =
    JSON.stringify({
      n,
      at: new Date().toISOString(),
      path: repoPath,
      file: name,
      reason,
      mode: state.mode,
      kind: state.kind,
    }) + "\n";
  await fs.appendFile(join(dir, "index.log"), record).catch(() => {});

  return `${BACKUP_REL}/${name}`;
}

/* ------------------------------------------------------------------ snapshots */

interface Snapshot {
  manifest: Manifest;
  /** Base index, stage 0 only. */
  baseIndex: Map<string, IndexEntry>;
  /** Paths carrying skip-worktree in the base. */
  baseSkip: Set<string>;
  /** Overlay index, stage 0 only. */
  overlayIndex: Map<string, IndexEntry>;
  /** Overlay HEAD tree, empty when the overlay has no commits yet. */
  overlayHead: Map<string, IndexEntry>;
  /** Paths the base tracks as gitlinks (mode 160000) — i.e. submodules. */
  gitlinks: string[];
}

/**
 * Refuse a path that *is* a submodule, or lives inside one.
 *
 * A file under `vendor/lib` belongs to the submodule's own repository, not to the base, so
 * the overlay has no business owning it: the base's index has a single gitlink for the whole
 * subtree, there is no blob to fork from, and `.git/info/exclude` in the base does not govern
 * files inside a nested repo. Taking one silently "worked" before this check and produced an
 * overlay entry that no `apply` on another machine could reproduce.
 */
/**
 * Refuse to operate while the base has sparse checkout enabled.
 *
 * This is the one configuration that silently defeats the whole mechanism. With
 * `core.sparseCheckout=true`, git *clears* the skip-worktree bit on any such file that is
 * present in the work-tree — so the moment the user runs `git status`, every override
 * becomes a visible modification and the next `git add -A` sweeps it into the base's
 * history. Measured; it is why overgit never enables sparse checkout
 * itself, but a user may already have it on for their own reasons.
 *
 * There is no way to provide invisibility in that mode, so the honest response is to refuse
 * rather than warn — a warning scrolls away and the leak is silent and permanent.
 */
export async function assertNoSparseCheckout(ctx: Context): Promise<void> {
  const r = await ctx.base.run(["config", "--bool", "--get", "core.sparseCheckout"], {
    allowFailure: true,
  });
  if (r.code !== 0 || r.stdout.trim() !== "true") return;
  throw new OvergitError(
    "UNSUPPORTED",
    "the base repo has core.sparseCheckout enabled, which overgit cannot work with",
    {
      hint: "run `git config --unset core.sparseCheckout` in the base (or `git sparse-checkout disable`), then re-run this command",
      details: [
        "With sparse checkout on, git clears the skip-worktree bit on any overridden file",
        "that exists in the work-tree. Every override would become a visible modification in",
        "the base and the next `git add -A` would commit it. overgit refuses rather than",
        "leak your overlay into the shared repository.",
      ],
    },
  );
}

/** The submodule `p` lives in (or is), or `null`. */
function submoduleContaining(s: Snapshot, p: string): string | null {
  for (const link of s.gitlinks) {
    if (p === link || p.startsWith(link + "/")) return link;
  }
  return null;
}

function assertNotSubmodule(s: Snapshot, p: string): void {
  for (const link of s.gitlinks) {
    if (p === link) {
      throw pathError(
        "UNSUPPORTED",
        p,
        `${p} is a submodule, which overgit cannot own`,
        `submodules are tracked by the base as a single commit pointer; manage it with \`git -C ${p}\` instead`,
      );
    }
    if (p.startsWith(link + "/")) {
      throw pathError(
        "UNSUPPORTED",
        p,
        `${p} is inside the submodule ${link}, which overgit cannot own`,
        `that file belongs to the submodule's own repository — run overgit inside ${link} if you want to overlay it`,
      );
    }
  }
}

async function snapshot(ctx: Context, m?: Manifest): Promise<Snapshot> {
  const manifest = m ?? (await readManifest(ctx));
  const [baseEntries, overlayEntries, hasHead] = await Promise.all([
    ctx.base.lsFiles(),
    ctx.overlay.lsFiles(),
    ctx.overlay.headExists(),
  ]);
  const overlayHead = hasHead ? indexMap(await ctx.overlay.lsTree("HEAD")) : new Map();
  const baseSkip = new Set<string>();
  for (const e of baseEntries) if (e.skipWorktree) baseSkip.add(e.path);
  return {
    manifest,
    baseIndex: indexMap(baseEntries),
    baseSkip,
    overlayIndex: indexMap(overlayEntries),
    overlayHead,
    gitlinks: baseEntries.filter((e) => e.mode === "160000").map((e) => e.path),
  };
}

/** The overlay content for `p`: the index entry if there is one, else overlay HEAD. */
function overlayContentOf(s: Snapshot, p: string): IndexEntry | undefined {
  return s.overlayIndex.get(p) ?? s.overlayHead.get(p);
}

/** True when the overlay has staged or unstaged changes for `p`. */
async function overlayDirtyFor(ctx: Context, s: Snapshot, p: string): Promise<boolean> {
  const idx = s.overlayIndex.get(p);
  const head = s.overlayHead.get(p);
  if ((idx === undefined) !== (head === undefined)) return true;
  if (idx && head && (idx.oid !== head.oid || idx.mode !== head.mode)) return true;
  if (!idx) return false;
  const wt = await readWorktree(join(ctx.root, p));
  if (wt.kind === "absent") return true;
  if (wt.mode !== idx.mode) return true;
  return !contentIsOid(wt.content, idx.oid);
}

/**
 * Every public entry point starts here.
 *
 * Without it, a missing overlay surfaces as a raw `GitError` — "fatal: not a git
 * repository: '<root>/.overgit/.git'" — which tells the user nothing about what to do.
 * `ctx.hasOverlay` is not enough on its own: it is decided at `discover` time, and the
 * overlay can be removed in between (a `git clean -xffd` in the base still reaches it).
 */
async function assertOverlayPresent(ctx: Context): Promise<void> {
  if (await Bun.file(join(ctx.overlayGitDir, "HEAD")).exists()) return;
  throw new OvergitError("NO_OVERLAY", `there is no overlay repository at ${ctx.overlayGitDir}`, {
    hint: "run `overgit init` to create one, or `overgit clone <url>` to fetch an existing one",
    paths: [ctx.overlayGitDir],
  });
}

/**
 * Last line of defence: a `GitError` escaping to the CLI would print a git command line
 * instead of something actionable. Anything unexpected becomes `GIT_FAILED`, which the CLI
 * renders in the standard `error:` / `hint:` shape.
 */
function asOvergitError(e: unknown, what: string): unknown {
  if (e instanceof OvergitError) return e;
  if (e instanceof GitError) {
    return new OvergitError("GIT_FAILED", `${what}: ${e.message}`, {
      hint: "run `overgit doctor` to check the overlay's state",
      details: e.stderr.split("\n").filter((l) => l.trim().length > 0).slice(0, 3),
      cause: e,
    });
  }
  return e;
}

/**
 * Write `.overgit/manifest.json` from the overlay's own copy when the work-tree has none.
 * Returns a detail string when it did something, `null` otherwise.
 */
async function restoreManifestFile(ctx: Context, dryRun: boolean): Promise<string | null> {
  if (await Bun.file(ctx.manifestPath).exists()) return null;

  const fromIndex = await ctx.overlay.indexBlobOid(MANIFEST_REPO_PATH);
  const oid = fromIndex ?? (await ctx.overlay.headBlobOid(MANIFEST_REPO_PATH));
  if (oid === null) return null; // no overlay manifest either: nothing is owned yet

  const detail = `restored the manifest from the overlay ${fromIndex ? "index" : "HEAD"}`;
  if (dryRun) return `${detail} (dry run)`;
  const bytes = await ctx.overlay.catFileBlob(oid);
  await fs.mkdir(dirname(ctx.manifestPath), { recursive: true });
  await writeWorktreeEntry(ctx, ctx.manifestPath, "100644", bytes);
  return detail;
}

/* ------------------------------------------------------------------ path resolution */

function resolveInputs(ctx: Context, paths: string[], opts?: OwnershipOptions): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const p = opts?.repoRelative ? raw : toRepoPath(ctx.root, ctx.cwd, raw);
    if (isReservedPath(p)) {
      throw pathError(
        "PATH_FORBIDDEN",
        p,
        `${p} is inside a directory overgit manages and can never be owned by the overlay`,
        "pick a path outside `.git/` and `.overgit/`",
      );
    }
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * A path that the base must be *blind* to has to be expressible as an exact gitignore
 * pattern. Measured on git 2.55: a pattern line cannot contain a newline, and a trailing CR
 * is stripped from every pattern line, so a name ending in CR cannot be matched literally
 * either. `paths.ts` falls back to `?` for those, which matches — but also matches other
 * names, and hiding one of the *base's* files would be a worse bug than refusing an exotic
 * filename. So `add` refuses them. Overrides and whiteouts are unaffected: they use
 * skip-worktree, not the exclude file, and work with any byte sequence.
 */
function assertExcludable(p: string): void {
  if (!gitignorePatternIsApproximate(p)) return;
  const approx = gitignoreEscape(p);
  throw new OvergitError(
    "PATH_FORBIDDEN",
    `${JSON.stringify(p)} cannot be represented exactly in .git/info/exclude, so overgit will not add it`,
    {
      paths: [p],
      details: [
        `the closest pattern git can express is ${JSON.stringify(approx)}, which uses \`?\` as a wildcard`,
        "that pattern would also match a sibling differing only at that byte, hiding a file you never named —",
        "and a later `git clean -xfd` in the base would delete it as ignored",
      ],
      hint: "rename the file so it has no newline and does not end with a carriage return; if the base tracks it already, `overgit add` can still override it (overrides use skip-worktree, not exclude patterns)",
    },
  );
}

/** Recursively list the files under a directory, skipping reserved directories. */
async function expandDirectory(ctx: Context, repoDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(join(ctx.root, rel), { withFileTypes: true }).catch((e) => {
      throw ioError(join(ctx.root, rel), e);
    });
    for (const d of entries) {
      const child = rel === "" ? d.name : `${rel}/${d.name}`;
      if (isReservedPath(child)) continue;
      if (d.isDirectory()) await walk(child);
      else out.push(child); // symlinks and regular files both count as content
    }
  };
  await walk(repoDir);
  return out.sort(comparePaths);
}

/* ------------------------------------------------------------------ takeOwnership */

interface TakePlan {
  path: string;
  kind: "add" | "override";
  from: OwnershipChange["from"];
  mode: string;
  content: Uint8Array;
  baseBlob: string | null;
}

/**
 * Take ownership of paths: base-tracked paths become `override`, untracked existing paths
 * become `add`.
 *
 * Inputs are resolved relative to `ctx.cwd` unless `repoRelative` is set. A directory
 * expands to the files beneath it; files it turns up that the overlay already owns are
 * reported in `skipped` rather than raising, because `overgit add src/` must stay usable
 * after the first file is owned.
 *
 * An explicitly named path the overlay already owns raises `ALREADY_OWNED`. With `force`
 * the current work-tree bytes are re-staged instead — that is the documented escape hatch
 * for "the file changed underneath me, record it again". Re-taking a whiteout whose file
 * exists again is always allowed and converts it back to `override`: a whiteout holds no
 * overlay content, so nothing can be lost.
 */
export async function takeOwnership(
  ctx: Context,
  paths: string[],
  opts?: OwnershipOptions,
): Promise<OwnershipResult> {
  await assertOverlayPresent(ctx);
  await assertNoSparseCheckout(ctx);
  const inputs = resolveInputs(ctx, paths, opts);
  const s = await snapshot(ctx);

  const skipped: { path: string; reason: string }[] = [];
  const plans: TakePlan[] = [];
  const seen = new Set<string>();

  // ── validate everything first; nothing below this loop writes ──
  for (const input of inputs) {
    // Before deciding whether this is a directory to expand: a submodule *is* a directory on
    // disk, so without this the explicit error below would never fire and `overgit add
    // vendor/lib` would degrade into "skipped 2 paths", which reads like a shrug.
    assertNotSubmodule(s, input);
    const wt = await readWorktree(join(ctx.root, input));
    const targets: { path: string; explicit: boolean }[] =
      wt.kind === "dir"
        ? (await expandDirectory(ctx, input)).map((p) => ({ path: p, explicit: false }))
        : [{ path: input, explicit: true }];

    if (wt.kind === "dir" && targets.length === 0) {
      skipped.push({ path: input, reason: "directory contains no files" });
      continue;
    }

    for (const t of targets) {
      if (seen.has(t.path)) continue;
      seen.add(t.path);
      const p = t.path;
      // An explicit `overgit add vendor/lib/x` is an error; a path swept up by expanding a
      // directory is merely skipped, so `overgit add .` in a repo with submodules does the
      // obvious thing instead of failing outright.
      if (t.explicit) {
        assertNotSubmodule(s, p);
      } else {
        const link = submoduleContaining(s, p);
        if (link !== null) {
          skipped.push({ path: p, reason: `inside the submodule ${link}` });
          continue;
        }
      }
      const state = t.explicit ? wt : await readWorktree(join(ctx.root, p));
      const existing = entryOf(s.manifest, p);
      const trackedByBase = s.baseIndex.has(p);

      if (state.kind === "absent") {
        if (trackedByBase) {
          throw pathError(
            "PATH_NOT_FOUND",
            p,
            `${p} is tracked by the base but missing from the work-tree, so there is nothing to take`,
            `run \`overgit rm ${p}\` to record it as deleted by the overlay, or \`git checkout -- ${p}\` to bring it back first`,
          );
        }
        throw pathError(
          "PATH_NOT_FOUND",
          p,
          `${p} does not exist`,
          "create the file first, then run `overgit add` again",
        );
      }
      if (state.kind === "dir" || state.kind === "other") {
        throw pathError(
          "NOT_A_FILE",
          p,
          `${p} is not a regular file or symlink`,
          "overgit tracks files and symlinks; pass a file path",
        );
      }

      if (existing) {
        if (existing.kind === "delete") {
          // The file is back: the whiteout becomes an override of the same base blob.
          plans.push({
            path: p,
            kind: "override",
            from: "delete",
            mode: state.mode!,
            content: state.content!,
            baseBlob: trackedByBase ? existing.baseBlob : null,
          });
          continue;
        }
        if (!opts?.force) {
          if (!t.explicit) {
            skipped.push({ path: p, reason: `already owned (${existing.kind})` });
            continue;
          }
          throw pathError(
            "ALREADY_OWNED",
            p,
            `${p} is already owned by the overlay (${existing.kind})`,
            `run \`overgit commit -m …\` to record your changes, \`overgit restore ${p}\` to give it back, or re-run with --force to re-stage the current bytes`,
          );
        }
        plans.push({
          path: p,
          kind: existing.kind,
          from: existing.kind,
          mode: state.mode!,
          content: state.content!,
          baseBlob: existing.kind === "override" ? existing.baseBlob : null,
        });
        continue;
      }

      if (trackedByBase) {
        // `baseBlob` is the merge base for `overgit sync`, which compares against the
        // base's HEAD — so prefer HEAD, and fall back to the index for a path that is
        // staged but not yet committed in the base.
        const headBlob = await ctx.base.headBlobOid(p);
        const baseBlob = headBlob ?? s.baseIndex.get(p)!.oid;
        plans.push({
          path: p,
          kind: "override",
          from: "base",
          mode: state.mode!,
          content: state.content!,
          baseBlob,
        });
      } else {
        assertExcludable(p);
        plans.push({
          path: p,
          kind: "add",
          from: "untracked",
          mode: state.mode!,
          content: state.content!,
          baseBlob: null,
        });
      }
    }
  }

  // A manifest with two keys differing only by case cannot be read back (`parseManifest`
  // rejects it) and cannot exist on a case-insensitive filesystem anyway. Catching it here
  // turns "overgit wedged itself" into one clear message naming both paths.
  const byLower = new Map<string, string>();
  for (const p of ownedPaths(s.manifest)) byLower.set(p.toLowerCase(), p);
  for (const plan of plans) {
    const clash = byLower.get(plan.path.toLowerCase());
    if (clash !== undefined && clash !== plan.path) {
      throw pathError(
        "ALREADY_OWNED",
        plan.path,
        `the overlay already owns ${clash}, which differs from ${plan.path} only by letter case`,
        `on a case-insensitive filesystem these are the same file; run \`overgit restore ${clash}\` first if you meant to replace it`,
      );
    }
    byLower.set(plan.path.toLowerCase(), plan.path);
  }

  if (plans.length === 0) return { changes: [], skipped, backups: [] };

  // ── mutate, content first ──
  let manifest = cloneManifest(s.manifest);
  for (const plan of plans) {
    const oid = await ctx.overlay.hashObject(plan.content, { write: true });
    await ctx.overlay.updateIndexCacheinfo(plan.mode, oid, plan.path);
    manifest.entries[plan.path] =
      plan.kind === "add"
        ? { kind: "add" }
        : plan.baseBlob !== null
          ? { kind: "override", baseBlob: plan.baseBlob }
          : { kind: "add" }; // base stopped tracking it mid-flight; an add is the honest record
  }
  await persistManifest(ctx, manifest);
  await ensureOverlayExcludes(ctx);
  await syncExcludeBlock(ctx, manifest);

  const toSkip = plans
    .filter((p) => manifest.entries[p.path]!.kind !== "add" && s.baseIndex.has(p.path))
    .map((p) => p.path)
    .filter((p) => !s.baseSkip.has(p));
  await ctx.base.setSkipWorktree(toSkip);

  return {
    changes: plans.map((p) => ({ path: p.path, from: p.from, to: manifest.entries[p.path]!.kind })),
    skipped,
    backups: [],
  };
}

/* ------------------------------------------------------------------ whiteout */

interface WhiteoutPlan {
  path: string;
  from: OwnershipChange["from"];
  /** `delete` for a base-tracked path; `none` when we are simply un-adding. */
  to: OwnershipTarget;
  baseBlob: string | null;
  /** Drop the path from the overlay index (previously `add`/`override`). */
  dropFromOverlay: boolean;
  state: WorktreeState;
  /** OIDs whose presence in the work-tree is expected, so needs no rescue. */
  expected: (string | null | undefined)[];
}

/**
 * Remove a path: whiteout a base-tracked file, or un-add an overlay-added one.
 *
 * * base-tracked, not owned → `delete` (skip-worktree + file removed).
 * * `override` → converts to `delete`. The overlay stops tracking the path, so its content
 *   is only reachable through overlay history; the operation is refused with
 *   `DIRTY_OVERLAY` when the overlay has uncommitted changes for that path (nothing else
 *   would preserve index-only content), and allowed otherwise.
 * * `add` → un-add: dropped from the overlay index, the manifest and the exclude block,
 *   and deleted from disk. Same `DIRTY_OVERLAY` rule.
 * * `delete` → already a whiteout; reported in `skipped`, so `overgit rm` is idempotent.
 *
 * In every destructive case the work-tree bytes are rescued to `.overgit/local/backups/`
 * unless they are byte-identical to content already stored in the overlay or the base.
 */
/**
 * Turn directory inputs into the file paths `rm` should actually act on.
 *
 * `takeOwnership` has always expanded a directory, so refusing one here was an asymmetry
 * users hit immediately — and the obvious workaround, a shell glob like `docs/*.md`, quietly
 * misses nested files and dotfiles, which is worse than an error.
 *
 * The expansion deliberately comes from the **base index and the manifest**, not from the
 * work-tree. A directory being whited out is one whose files are about to stop existing on
 * disk, and some of them may be gone already (a half-finished run, or a whiteout the user is
 * repeating); walking the work-tree would silently skip exactly those. What the base tracks
 * plus what the overlay owns is the complete, order-independent answer.
 */
async function expandWhiteoutInputs(
  ctx: Context,
  s: Snapshot,
  inputs: string[],
  skipped: { path: string; reason: string }[],
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    // Only treat it as a directory when it is not itself an owned or tracked path: a file and
    // a directory cannot share a name, so this is unambiguous.
    const isPath = s.baseIndex.has(input) || entryOf(s.manifest, input) !== undefined;
    const onDisk = await readWorktree(join(ctx.root, input));
    if (isPath || (onDisk.kind !== "dir" && onDisk.kind !== "absent")) {
      if (!seen.has(input)) {
        seen.add(input);
        out.push(input);
      }
      continue;
    }

    const prefix = `${input}/`;
    const members = new Set<string>();
    for (const p of s.baseIndex.keys()) if (p.startsWith(prefix)) members.add(p);
    for (const p of ownedPaths(s.manifest)) if (p.startsWith(prefix)) members.add(p);

    if (members.size === 0) {
      if (onDisk.kind === "dir") {
        // A directory git knows nothing about: there is no whiteout to record, and deleting
        // untracked files is not overgit's business.
        skipped.push({ path: input, reason: "nothing tracked by the base or owned by the overlay" });
        continue;
      }
      throw pathError(
        "PATH_NOT_FOUND",
        input,
        `${input} does not exist`,
        "check the path, or run `overgit list` to see what the overlay owns",
      );
    }

    for (const p of [...members].sort(comparePaths)) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export async function whiteout(
  ctx: Context,
  paths: string[],
  opts?: OwnershipOptions,
): Promise<OwnershipResult> {
  await assertOverlayPresent(ctx);
  await assertNoSparseCheckout(ctx);
  const inputs = resolveInputs(ctx, paths, opts);
  const s = await snapshot(ctx);

  const skipped: { path: string; reason: string }[] = [];
  const plans: WhiteoutPlan[] = [];

  const expanded = await expandWhiteoutInputs(ctx, s, inputs, skipped);

  for (const p of expanded) {
    assertNotSubmodule(s, p);
    const existing = entryOf(s.manifest, p);
    const baseEntry = s.baseIndex.get(p);
    const state = await readWorktree(join(ctx.root, p));

    if (existing?.kind === "delete") {
      skipped.push({ path: p, reason: "already a whiteout" });
      continue;
    }

    if (existing && (await overlayDirtyFor(ctx, s, p)) && !opts?.force) {
      throw pathError(
        "DIRTY_OVERLAY",
        p,
        `the overlay has uncommitted changes for ${p}`,
        `run \`overgit commit -m …\` first so the content stays in overlay history, or re-run with --force (the current bytes are saved to ${BACKUP_REL}/ either way)`,
      );
    }

    if (existing?.kind === "add") {
      plans.push({
        path: p,
        from: "add",
        to: "none",
        baseBlob: null,
        dropFromOverlay: true,
        state,
        expected: [s.overlayIndex.get(p)?.oid, s.overlayHead.get(p)?.oid],
      });
      continue;
    }

    if (!baseEntry) {
      // An override whose upstream vanished: there is nothing to whiteout, because the
      // base no longer has the path at all. `sync` is where that decision belongs.
      if (existing?.kind === "override") {
        throw pathError(
          "NOT_TRACKED_BY_BASE",
          p,
          `the base no longer tracks ${p}, so it cannot be whited out — a whiteout only hides a file the base still has`,
          `run \`overgit sync\` to decide what to do with it, or \`overgit restore --force ${p}\` to drop it from the overlay and delete the file`,
        );
      }
      if (state.kind === "absent") {
        throw pathError("PATH_NOT_FOUND", p, `${p} does not exist`, "check the path and try again");
      }
      throw pathError(
        "NOT_TRACKED_BY_BASE",
        p,
        `${p} is not tracked by the base and not owned by the overlay, so there is nothing for overgit to remove`,
        `delete it with \`rm ${JSON.stringify(p)}\`, or run \`overgit add ${p}\` first if you meant to take it over`,
      );
    }

    const baseBlob = existing?.kind === "override" ? existing.baseBlob : ((await ctx.base.headBlobOid(p)) ?? baseEntry.oid);
    plans.push({
      path: p,
      from: existing ? existing.kind : "base",
      to: "delete",
      baseBlob,
      dropFromOverlay: existing?.kind === "override",
      state,
      expected: [s.overlayIndex.get(p)?.oid, s.overlayHead.get(p)?.oid, baseEntry.oid, baseBlob],
    });
  }

  if (plans.length === 0) return { changes: [], skipped, backups: [] };

  // ── mutate: rescue bytes, then drop overlay tracking, then manifest, then the base ──
  const backups: string[] = [];
  const changes: OwnershipChange[] = [];

  for (const plan of plans) {
    let backup: string | undefined;
    if (plan.state.kind !== "absent") {
      const recoverable = plan.expected.some((oid) => contentIsOid(plan.state.content, oid ?? null));
      if (!recoverable || opts?.force) {
        backup = await backupBytes(ctx, plan.path, plan.state, `overgit rm ${plan.path}`);
        backups.push(backup);
      }
    }
    changes.push({ path: plan.path, from: plan.from, to: plan.to, ...(backup ? { backup } : {}) });
  }

  // Only paths the overlay index actually holds: `git rm --cached` is fatal on a pathspec
  // that matches nothing, and an orphaned manifest entry (doctor's `orphan-manifest-entry`)
  // must not turn `overgit rm` into a crash.
  const drops = plans
    .filter((p) => p.dropFromOverlay && s.overlayIndex.has(p.path))
    .map((p) => p.path);
  if (drops.length > 0) await ctx.overlay.rmCached(drops);

  let manifest = cloneManifest(s.manifest);
  for (const plan of plans) {
    if (plan.to === "delete") manifest.entries[plan.path] = { kind: "delete", baseBlob: plan.baseBlob! };
    else delete manifest.entries[plan.path];
  }
  await persistManifest(ctx, manifest);
  await syncExcludeBlock(ctx, manifest);

  const toSkip = plans
    .filter((p) => p.to === "delete" && s.baseIndex.has(p.path) && !s.baseSkip.has(p.path))
    .map((p) => p.path);
  await ctx.base.setSkipWorktree(toSkip);

  // The file goes last: until the bit is set, removing it would be visible to the base.
  for (const plan of plans) {
    if (plan.state.kind !== "absent") {
      await removeWorktreeEntry(join(ctx.root, plan.path), false);
      await pruneEmptyParents(ctx.root, plan.path);
    }
  }

  return { changes, skipped, backups };
}

/* ------------------------------------------------------------------ restoreToBase */

interface RestorePlan {
  path: string;
  from: Kind;
  /** Base content to put back, or `null` when the base no longer tracks the path. */
  restore: { oid: string; mode: string } | null;
  state: WorktreeState;
  expected: (string | null | undefined)[];
  hadSkip: boolean;
}

/**
 * Give paths back to the base.
 *
 * `override` / `delete` clear the skip-worktree bit and restore the base's content
 * byte-for-byte. The bytes come from the base *index* rather than HEAD, because
 * skip-worktree freezes the index entry and that is what `git status` compares against —
 * restoring HEAD would leave a repo with staged base changes reporting a spurious diff.
 *
 * `add` drops the path from the overlay index, the manifest and the exclude block;
 * `keepFile` decides whether the file survives on disk as an ordinary untracked file
 * (`keepFile` has no meaning for the other two kinds, where the base's content always
 * comes back).
 *
 * Refuses with `DIRTY_OVERLAY` when the overlay has uncommitted changes for a path, and
 * with `NOT_TRACKED_BY_BASE` when the base no longer tracks an overridden path (there is
 * no content to restore — `overgit sync` is where that decision belongs). `force`
 * overrides both, always rescuing the work-tree bytes first.
 */
/** Expand directory inputs into the owned paths beneath them. */
async function expandOwnedInputs(s: Snapshot, inputs: string[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    if (entryOf(s.manifest, input) !== undefined) {
      if (!seen.has(input)) {
        seen.add(input);
        out.push(input);
      }
      continue;
    }
    const prefix = `${input}/`;
    const members = ownedPaths(s.manifest).filter((p) => p.startsWith(prefix));
    if (members.length === 0) {
      if (!seen.has(input)) {
        seen.add(input);
        out.push(input); // not owned: let the per-path error below name it properly
      }
      continue;
    }
    for (const p of members.sort(comparePaths)) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export async function restoreToBase(
  ctx: Context,
  paths: string[],
  opts?: RestoreOptions,
): Promise<OwnershipResult> {
  await assertOverlayPresent(ctx);
  await assertNoSparseCheckout(ctx);
  const inputs = resolveInputs(ctx, paths, opts);
  const s = await snapshot(ctx);

  const skipped: { path: string; reason: string }[] = [];
  const plans: RestorePlan[] = [];

  // Same directory expansion as `add` and `rm`, for the same reason: an asymmetry between
  // the three is a papercut users hit immediately. A restored directory is expanded from the
  // manifest — the work-tree cannot be the source, since whited-out paths are absent from it
  // and those are exactly the ones a `restore <dir>` most needs to bring back.
  const expanded = await expandOwnedInputs(s, inputs);

  for (const p of expanded) {
    const existing = entryOf(s.manifest, p);
    if (!existing) {
      throw pathError(
        "NOT_OWNED",
        p,
        `${p} is not owned by the overlay`,
        "run `overgit list` to see what the overlay owns",
      );
    }

    if (existing.kind !== "delete" && (await overlayDirtyFor(ctx, s, p)) && !opts?.force) {
      throw pathError(
        "DIRTY_OVERLAY",
        p,
        `the overlay has uncommitted changes for ${p}`,
        `run \`overgit commit -m …\` to keep them, or re-run with \`overgit restore --force ${p}\` to discard them (the current bytes are saved to ${BACKUP_REL}/)`,
      );
    }

    const baseEntry = s.baseIndex.get(p);
    const state = await readWorktree(join(ctx.root, p));

    if (existing.kind === "add") {
      plans.push({
        path: p,
        from: "add",
        restore: null,
        state,
        expected: [s.overlayIndex.get(p)?.oid, s.overlayHead.get(p)?.oid],
        hadSkip: s.baseSkip.has(p),
      });
      continue;
    }

    if (!baseEntry) {
      if (!opts?.force) {
        throw pathError(
          "NOT_TRACKED_BY_BASE",
          p,
          `the base no longer tracks ${p}, so there is no base content to restore`,
          `run \`overgit sync\` to decide what to do with it, or \`overgit restore --force ${p}\` to drop it from the overlay and delete the file`,
        );
      }
      plans.push({
        path: p,
        from: existing.kind,
        restore: null,
        state,
        expected: [s.overlayIndex.get(p)?.oid, s.overlayHead.get(p)?.oid, existing.baseBlob],
        hadSkip: s.baseSkip.has(p),
      });
      continue;
    }

    if (!SUPPORTED_MODES.has(baseEntry.mode)) {
      throw pathError(
        "UNSUPPORTED",
        p,
        `the base tracks ${p} with mode ${baseEntry.mode}, which overgit cannot materialise`,
        "submodules and other non-file entries are not supported",
      );
    }

    plans.push({
      path: p,
      from: existing.kind,
      restore: { oid: baseEntry.oid, mode: baseEntry.mode },
      state,
      expected: [s.overlayIndex.get(p)?.oid, s.overlayHead.get(p)?.oid, baseEntry.oid, existing.baseBlob],
      hadSkip: s.baseSkip.has(p),
    });
  }

  if (plans.length === 0) return { changes: [], skipped, backups: [] };

  // ── mutate: rescue, restore the work-tree, clear bits, then release the claim ──
  const backups: string[] = [];
  const changes: OwnershipChange[] = [];

  for (const plan of plans) {
    let backup: string | undefined;
    const willDisturb = plan.restore !== null || !opts?.keepFile;
    if (plan.state.kind !== "absent" && willDisturb) {
      const recoverable = plan.expected.some((oid) => contentIsOid(plan.state.content, oid ?? null));
      if (!recoverable || opts?.force) {
        backup = await backupBytes(ctx, plan.path, plan.state, `overgit restore ${plan.path}`);
        backups.push(backup);
      }
    }

    if (plan.restore) {
      const bytes = await ctx.base.catFileBlob(plan.restore.oid);
      if (plan.state.kind === "dir") await removeWorktreeEntry(join(ctx.root, plan.path), true);
      await writeWorktreeEntry(ctx, join(ctx.root, plan.path), plan.restore.mode, bytes);
    } else if (!opts?.keepFile && plan.state.kind !== "absent" && plan.state.kind !== "dir") {
      // Un-adding an overlay file: the directory that held it may have existed only for it.
      await removeWorktreeEntry(join(ctx.root, plan.path), false);
      await pruneEmptyParents(ctx.root, plan.path);
    }

    changes.push({ path: plan.path, from: plan.from, to: "none", ...(backup ? { backup } : {}) });
  }

  // Content is back in place before the bit is cleared, so `git status` never blinks.
  const toClear = plans.filter((p) => p.hadSkip).map((p) => p.path);
  await ctx.base.clearSkipWorktree(toClear.filter((p) => s.baseIndex.has(p)));

  const drops = plans.filter((p) => p.from !== "delete").map((p) => p.path);
  const trackedByOverlay = drops.filter((p) => s.overlayIndex.has(p));
  if (trackedByOverlay.length > 0) await ctx.overlay.rmCached(trackedByOverlay);

  let manifest = cloneManifest(s.manifest);
  for (const plan of plans) delete manifest.entries[plan.path];
  await persistManifest(ctx, manifest);
  await syncExcludeBlock(ctx, manifest);

  return { changes, skipped, backups };
}

/* ------------------------------------------------------------------ applyState */

/**
 * The idempotent reconciler: make the work-tree, the base's index bits and the base's
 * exclude block agree with the manifest.
 *
 * This is the only thing that materialises overlay content, and it does so one path at a
 * time so it can rescue bytes it did not expect. It is deliberately **set-only** for
 * skip-worktree: a bit on a path the overlay does not own is left alone, because a user
 * may have set it themselves. `overgit doctor` reports those as `stray-skip-worktree`.
 *
 * Running it twice in a row must report `changed: false` and no non-`noop` action — that
 * property is what "fresh clone + one command reproduces the tree" rests on.
 */
export async function applyState(ctx: Context, opts?: ApplyOptions): Promise<ApplyReport> {
  await assertOverlayPresent(ctx);
  await assertNoSparseCheckout(ctx);
  try {
    return await applyStateInner(ctx, opts);
  } catch (e) {
    throw asOvergitError(e, "applying the overlay failed");
  }
}

async function applyStateInner(ctx: Context, opts?: ApplyOptions): Promise<ApplyReport> {
  const dryRun = opts?.dryRun === true;
  const actions: ApplyAction[] = [];
  const backups: string[] = [];

  const note = (path: string, action: ApplyAction["action"], detail?: string): void => {
    actions.push(detail === undefined ? { path, action } : { path, action, detail });
  };

  // A freshly cloned overlay has the manifest in its object store but not yet in the
  // work-tree (`cloneOverlay` uses `read-tree`, which deliberately never touches files).
  // Materialising it here is what makes "clone, then one `overgit apply`" enough — and it
  // only ever fires when the file is *absent*, so a hand-edited manifest stays the source
  // of truth and the second run has nothing to do.
  const restored = await restoreManifestFile(ctx, dryRun);
  if (restored) note(MANIFEST_REPO_PATH, "write-add", restored);

  const s = await snapshot(ctx);

  const rescue = async (
    p: string,
    state: WorktreeState,
    expected: (string | null | undefined)[],
    reason: string,
  ): Promise<void> => {
    if (state.kind === "absent") return;
    if (expected.some((oid) => contentIsOid(state.content, oid ?? null))) return;
    if (dryRun) {
      note(p, "backup", "would rescue unexpected work-tree bytes (dry run)");
      return;
    }
    const rel = await backupBytes(ctx, p, state, reason);
    backups.push(rel);
    note(p, "backup", rel);
  };

  for (const p of ownedPaths(s.manifest)) {
    const entry = s.manifest.entries[p]!;
    const abs = join(ctx.root, p);
    const state = await readWorktree(abs);

    if (entry.kind === "delete") {
      if (state.kind === "absent") {
        note(p, "noop");
        continue;
      }
      if (state.kind === "dir") {
        note(p, "noop", "a directory occupies the whiteout path; remove it by hand");
        continue;
      }
      await rescue(p, state, [entry.baseBlob, s.baseIndex.get(p)?.oid], `apply: whiteout ${p}`);
      if (!dryRun) {
        await removeWorktreeEntry(abs, false);
        await pruneEmptyParents(ctx.root, p);
      }
      note(p, "remove-whiteout");
      continue;
    }

    const want = overlayContentOf(s, p);
    if (!want) {
      note(p, "noop", "the overlay has no content for this path (run `overgit doctor`)");
      continue;
    }
    if (!SUPPORTED_MODES.has(want.mode)) {
      note(p, "noop", `unsupported overlay mode ${want.mode}`);
      continue;
    }

    if (state.mode === want.mode && contentIsOid(state.content, want.oid)) {
      note(p, "noop");
      continue;
    }

    if ((state.kind === "dir" || state.kind === "other") && !opts?.force) {
      note(
        p,
        "noop",
        `a ${state.kind === "dir" ? "directory" : "special file"} occupies this path; re-run with --force to replace it`,
      );
      continue;
    }

    const baseBlob = entry.kind === "override" ? entry.baseBlob : null;
    await rescue(p, state, [want.oid, baseBlob, s.baseIndex.get(p)?.oid], `apply: ${entry.kind} ${p}`);

    if (!dryRun) {
      if (state.kind === "dir") await removeWorktreeEntry(abs, true);
      const bytes = await ctx.overlay.catFileBlob(want.oid);
      await writeWorktreeEntry(ctx, abs, want.mode, bytes);
    }
    note(
      p,
      entry.kind === "override" ? "write-override" : "write-add",
      state.kind === "absent" ? "missing from the work-tree" : "work-tree content differed",
    );
  }

  // Skip-worktree: set only, and on **every** owned path the base currently tracks —
  // including an `add` whose path the base has started tracking since (§6.5 add-collision).
  // Its exclude line went inert the moment the base indexed the path, so without this the
  // overlay's bytes sit there as a visible modification and the next `git add -A` in the
  // base commits the user's private content upstream. `sync` still surfaces the collision as
  // a decision; this only stops the leak while it is pending.
  const wantSkip = ownedPaths(s.manifest).filter(
    (p) => s.baseIndex.has(p) && !s.baseSkip.has(p),
  );
  if (wantSkip.length > 0) {
    if (!dryRun) await ctx.base.setSkipWorktree(wantSkip);
    for (const p of wantSkip) note(p, "set-skip");
  }

  // The exclude block is what keeps `add` paths invisible; regenerate it last so it
  // reflects the manifest we just materialised.
  if (dryRun) {
    const { desiredExcludeLines } = await import("./exclude.ts");
    const { currentExcludeBlock } = await import("./exclude.ts");
    const current = await currentExcludeBlock(ctx);
    const want = desiredExcludeLines(s.manifest, new Set(s.baseIndex.keys()));
    if (current === null || current.length !== want.length || current.some((l, i) => l !== want[i])) {
      note(".git/info/exclude", "exclude", "managed block is out of date (dry run)");
    }
  } else {
    await ensureOverlayExcludes(ctx);
    const { changed } = await syncExcludeBlock(ctx, s.manifest, new Set(s.baseIndex.keys()));
    if (changed) note(".git/info/exclude", "exclude", "regenerated the managed block");
  }

  return { actions, changed: actions.some((a) => a.action !== "noop"), backups };
}

/* ------------------------------------------------------------------ shared helpers */

/**
 * Exported for `doctor.ts` and `sync.ts`: the same "is this path's work-tree entry what we
 * expect" question those modules ask, answered exactly the way `applyState` answers it.
 */
export async function worktreeMatches(
  root: string,
  repoPath: string,
  oid: string,
  mode: string,
): Promise<boolean> {
  const st = await readWorktree(join(root, repoPath));
  return st.mode === mode && contentIsOid(st.content, oid);
}

/** Exported for `doctor.ts`: rescue work-tree bytes with the same layout `applyState` uses. */
export async function rescueWorktreeBytes(
  ctx: Context,
  repoPath: string,
  reason: string,
): Promise<string | null> {
  const state = await readWorktree(join(ctx.root, repoPath));
  if (state.kind === "absent") return null;
  return backupBytes(ctx, repoPath, state, reason);
}

/** Exported for `sync.ts`: read a work-tree file's bytes and git mode without following symlinks. */
export async function readWorktreeEntry(
  root: string,
  repoPath: string,
): Promise<{ mode: string; content: Uint8Array } | null> {
  const st = await readWorktree(join(root, repoPath));
  if (st.kind !== "file" && st.kind !== "symlink") return null;
  return { mode: st.mode!, content: st.content! };
}

/** Exported for `sync.ts`: stage exact bytes into the overlay index at `repoPath`. */
export async function stageOverlayContent(
  ctx: Context,
  repoPath: string,
  mode: string,
  content: Uint8Array,
): Promise<string> {
  const oid = await ctx.overlay.hashObject(content, { write: true });
  await ctx.overlay.updateIndexCacheinfo(mode, oid, repoPath);
  return oid;
}

/** Exported for `sync.ts` / `doctor.ts`: materialise bytes into the work-tree atomically. */
export async function materialise(
  ctx: Context,
  repoPath: string,
  mode: string,
  content: Uint8Array,
): Promise<void> {
  await writeWorktreeEntry(ctx, join(ctx.root, repoPath), mode, content);
}

/** Exported for `doctor.ts`: literal pathspec helper re-exported so callers need one import. */
export { literalPathspec };
