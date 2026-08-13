/**
 * doctor: find and fix disagreements between the manifest, the overlay repo, and the base
 * repo plus work-tree. Ordinary git in the base moves the third one behind overgit's back.
 *
 * The hardest judgement here is drift (git wrote something) versus work (the user edited
 * their file and has not committed). Both look identical in the abstract, so the answer
 * comes from what the bytes are: absent, or hashing to a blob the base records for that
 * path, means drift and is safe to overwrite. Anything else is work, never reported and
 * never repaired. The exception is a pure mode difference, fixed because a chmod cannot
 * lose content and a silently dropped exec bit is a real footgun.
 *
 * Every fix re-checks the live state before acting, so a second run has nothing to do, and
 * nothing is deleted unless it is recoverable from the overlay or the base, or has been
 * rescued into `.overgit/local/backups/` first.
 */

import { join, relative as pathRelative, resolve as pathResolve, sep } from "node:path";
import * as fs from "node:fs/promises";

import type { Context } from "./context.ts";
import {
  detachMarkerPath,
  lockPath,
  pidIsAlive,
  readLockPid,
  syncStatePath,
} from "./context.ts";
import { isOvergitError } from "./errors.ts";
import type { IndexEntry } from "./git.ts";
import { contentIsOid, indexMap, literalPathspec, splitNul } from "./git.ts";
import type { WorktreeState } from "./files.ts";
import { pathExists } from "./files.ts";
import type { Entry, Manifest } from "./manifest.ts";
import {
  emptyManifest,
  parseManifest,
  ownedPaths,
  persistManifest,
  readManifest,
} from "./manifest.ts";
import {
  BEGIN_MARKER,
  OVERLAY_EXCLUDE_LINES,
  currentExcludeBlock,
  desiredExcludeLines,
  ensureOverlayExcludes,
  readManagedBlock,
  syncExcludeBlock,
} from "./exclude.ts";
import { materialise, rescueWorktreeBytes, restoreToBase, stageOverlayContent } from "./ownership.ts";
import { isReservedPath } from "./paths.ts";

/* ------------------------------------------------------------------ public types */

/**
 * Every problem id, with the one line `overgit help doctor` prints for it. The ids are a
 * stable contract: `--porcelain` emits them and the tests key off them. Keeping the text
 * here is what stops "documented" and "exists" from drifting apart.
 */
export const PROBLEM_DESCRIPTIONS = {
  "no-overlay": "there is no overlay in this repository",
  "no-overlay-head": "the overlay has no commits, so its content cannot be pushed",
  "clean-unprotected": "`.overgit/` is not a repository, so `git clean -xfd` would delete it",
  "overlay-config-broken": "the overlay repo's core.worktree, core.bare or exclude is wrong",
  "manifest-missing": "the manifest file is gone (usually still in the overlay's history)",
  "manifest-unreadable": "the manifest is present but does not parse",
  "manifest-not-tracked": "the manifest is not staged, so a push publishes an unusable overlay",
  "orphan-manifest-entry": "the manifest claims a path the overlay has no content for",
  "orphan-overlay-file": "the overlay tracks a path the manifest does not record",
  "overlay-index-missing-entry": "in overlay HEAD but not its index; the next commit drops it",
  "whiteout-tracked-by-overlay": "a whited-out path still has content in the overlay",
  "missing-skip-worktree": "an override or whiteout the base can see, so it is not hidden",
  "stray-skip-worktree": "the base's bit is set on a path the overlay does not own",
  "assume-unchanged-set": "the base also carries assume-unchanged, which hides real changes",
  "base-index-diverged": "a staged base change frozen by skip-worktree; `git diff --cached` sticks",
  "base-blob-missing": "the recorded fork-point blob is not in the base's object store",
  "missing-exclude-line": "the managed exclude block is absent or short a line",
  "stale-exclude-line": "the managed block lists a path the overlay no longer owns",
  "duplicate-exclude-block": "more than one managed block; only the first is authoritative",
  "gitignore-pollution": "overgit's local state is in a .gitignore the base tracks",
  "worktree-content-drift": "an owned path is missing, or holds the base's bytes",
  "worktree-mode-drift": "the overlay's exact content, but the wrong file mode",
  "worktree-type-changed": "file became a symlink (or the reverse) with different content",
  "whiteout-resurrected": "a whited-out file is back in the work-tree",
  "path-blocked": "a directory or special file occupies a path the overlay owns",
  "case-collision": "the work-tree has the same name in a different case",
  "add-now-tracked-by-base": "the base started tracking a path the overlay added",
  "upstream-gone": "the base no longer tracks a path the overlay overrides or whites out",
  "pull-blocked-by-override": "a base `git pull` will abort on paths the overlay overrides",
  "base-sparse-checkout": "core.sparseCheckout defeats every override; reported alone",
  "base-operation-in-progress": "the base is mid-merge or mid-rebase",
  "base-detached-head": "the base is on a detached HEAD, so upstream comparisons are off",
  "base-unmerged-path": "an owned path has unresolved conflict stages in the base's index",
  "overlay-detached": "`overgit detach` has the overlay unmounted",
  "stale-detach-marker": "the detach marker survived, but the overlay is mounted",
  "sync-in-progress": "a sync is unfinished; a state, not by itself a problem",
  "interrupted-lock": "a lock file from a dead or running overgit process",
} as const;

export type ProblemId = keyof typeof PROBLEM_DESCRIPTIONS;

export const PROBLEM_IDS = Object.keys(PROBLEM_DESCRIPTIONS) as ProblemId[];

export interface Problem {
  /** Stable kebab id — tests and `--porcelain` output key off this. */
  id: ProblemId;
  severity: "error" | "warning";
  /** Repo-relative path, or a well-known file like `.git/info/exclude`. */
  path?: string;
  /** States the observed fact. */
  message: string;
  /** Actionable: names the path and the command to run. */
  hint: string;
  fixable: boolean;
}

export interface RepairResult {
  fixed: Problem[];
  remaining: Problem[];
  /** Root-relative paths written under `.overgit/local/backups/`. */
  backups: string[];
}

/* ------------------------------------------------------------------ small helpers */

function mk(
  id: ProblemId,
  severity: Problem["severity"],
  message: string,
  hint: string,
  opts?: { path?: string; fixable?: boolean },
): Problem {
  const p: Problem = {
    id,
    severity,
    message,
    hint,
    fixable: opts?.fixable ?? false,
  };
  if (opts?.path !== undefined) p.path = opts.path;
  return p;
}

type WtState = WorktreeState;

const ABSENT: WtState = { kind: "absent", mode: null, content: null };

/** lstat + read, never following a symlink (a symlink's target *is* its content). */
async function readWorktree(abs: string): Promise<WtState> {
  let st: import("node:fs").Stats;
  try {
    st = await fs.lstat(abs);
  } catch {
    return ABSENT;
  }
  if (st.isSymbolicLink()) {
    const target = await fs.readlink(abs, { encoding: "buffer" }).catch(() => null);
    if (target === null) return { kind: "symlink", mode: "120000", content: null };
    return { kind: "symlink", mode: "120000", content: new Uint8Array(target) };
  }
  if (st.isDirectory()) return { kind: "dir", mode: null, content: null };
  if (!st.isFile()) return { kind: "other", mode: null, content: null };
  const buf = await fs.readFile(abs).catch(() => null);
  if (buf === null) return { kind: "file", mode: null, content: null };
  return {
    kind: "file",
    mode: (st.mode & 0o111) !== 0 ? "100755" : "100644",
    content: new Uint8Array(buf),
  };
}

function quote(p: string): string {
  return /^[A-Za-z0-9._\-/]+$/.test(p) ? p : JSON.stringify(p);
}

/** Root-relative POSIX path of something inside the overlay's git dir, for display. */
function overlayRel(ctx: Context, ...parts: string[]): string {
  const rel = pathRelative(ctx.root, ctx.overlayGitDir).split(sep).join("/");
  return parts.length > 0 ? `${rel}/${parts.join("/")}` : rel;
}

/* ---------------------------------------------------------- `git clean` protection */

/** A directory git would accept as a repository: it has a `HEAD`. */
async function looksLikeGitDir(p: string): Promise<boolean> {
  try {
    if (!(await fs.stat(p)).isDirectory()) return false;
  } catch {
    return false;
  }
  return pathExists(join(p, "HEAD"));
}

/**
 * Resolve `<root>/.overgit/.git`, following a gitfile.
 *
 * Returns the real git dir, or `null` when the guard is absent, garbage, or a gitfile
 * whose target does not exist.
 */
async function resolveOverlayGuard(ctx: Context): Promise<string | null> {
  const guard = join(ctx.overgitDir, ".git");
  let st: import("node:fs").Stats;
  try {
    st = await fs.lstat(guard);
  } catch {
    return null;
  }
  if (st.isDirectory()) return (await looksLikeGitDir(guard)) ? guard : null;
  if (!st.isFile()) return null;
  const text = await fs.readFile(guard, "utf8").catch(() => "");
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const target = pathResolve(ctx.overgitDir, m[1]!);
  return (await looksLikeGitDir(target)) ? target : null;
}

/**
 * Measured on git 2.55: `git clean -xfd` removes ignored *directories* wholesale, and
 * `/.overgit/` is ignored. It skips `<dir>` **iff `<dir>/.git` resolves to a real
 * repository**. If that stops being true, one `git clean -xfd` in the base takes the
 * overlay repository, the manifest and every backup with it — the single drift row that is
 * not recoverable afterwards.
 */
async function checkCleanProtection(ctx: Context): Promise<Problem | null> {
  if ((await resolveOverlayGuard(ctx)) !== null) return null;

  const guard = join(ctx.overgitDir, ".git");
  const st = await fs.lstat(guard).catch(() => null);
  let what: string;
  if (st === null) what = `${guard} does not exist`;
  else if (st.isDirectory()) what = `${guard} is a directory with no HEAD, so git does not count it as a repository`;
  else if (st.isFile()) {
    const text = await fs.readFile(guard, "utf8").catch(() => "");
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    what =
      m === null
        ? `${guard} is a file but not a gitfile`
        : `${guard} is a gitfile pointing at ${pathResolve(ctx.overgitDir, m[1]!)}, which is not a repository`;
  } else what = `${guard} is neither a directory nor a gitfile`;

  return mk(
    "clean-unprotected",
    "error",
    `${what} — so \`git clean -xfd\` in the base would delete the whole of ${ctx.overgitDir}: the overlay repository, the manifest and every backup`,
    `restore a real repository (or a gitfile pointing at one) at ${guard} before running any \`git clean\` in ${ctx.root}; if the overlay lives elsewhere, move it back with \`mv <its-git-dir> ${guard}\``,
    { path: ".overgit/.git" },
  );
}

/* ------------------------------------------------------------------ index reading */

/**
 * `ls-files -v` with the tag byte kept.
 *
 * `Git.lsFiles` collapses `S` (skip-worktree) and `s` (skip-worktree *and*
 * assume-unchanged) into one boolean, which is right for everyone else and wrong here:
 * doctor is the one place that has to notice the lowercase form.
 */
interface TaggedEntry extends IndexEntry {
  /** Raw `ls-files -v` tag: `H` `S` `s` `h` `M` … */
  tag: string;
  assumeUnchanged: boolean;
}

const ASSUME_UNCHANGED_TAGS = new Set(["h", "s", "m", "r", "c", "k", "?"]);

async function lsFilesTagged(git: Context["base"]): Promise<TaggedEntry[]> {
  const { stdout } = await git.run(["ls-files", "-z", "-s", "-v", "--full-name"]);
  const out: TaggedEntry[] = [];
  for (const rec of splitNul(stdout)) {
    if (rec.length < 4) continue;
    const tag = rec[0]!;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const head = rec.slice(2, tab).split(" ");
    if (head.length < 3) continue;
    const stage = Number(head[2]);
    out.push({
      path: rec.slice(tab + 1),
      mode: head[0]!,
      oid: head[1]!,
      stage: Number.isFinite(stage) ? stage : 0,
      skipWorktree: tag === "S" || tag === "s",
      assumeUnchanged: ASSUME_UNCHANGED_TAGS.has(tag),
      tag,
    });
  }
  return out;
}

/** `HEAD:<path>` blob oids for `paths`, in one `ls-tree` per ~400 paths. */
async function baseHeadBlobs(
  ctx: Context,
  paths: string[],
): Promise<Map<string, { oid: string; mode: string }>> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (paths.length === 0) return out;
  if ((await ctx.base.revParse("HEAD")) === null) return out;

  for (let i = 0; i < paths.length; i += 400) {
    const chunk = paths.slice(i, i + 400);
    const r = await ctx.base.run(
      ["ls-tree", "-z", "--full-tree", "HEAD", "--", ...chunk.map(literalPathspec)],
      { allowFailure: true },
    );
    if (r.code !== 0) continue;
    for (const rec of splitNul(r.stdout)) {
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      const head = rec.slice(0, tab).split(" ");
      if (head.length < 3 || head[1] !== "blob") continue;
      out.set(rec.slice(tab + 1), { oid: head[2]!, mode: head[0]! });
    }
  }
  return out;
}

/** Which of `oids` are missing from the base's object store. One `cat-file` call. */
async function missingBaseBlobs(ctx: Context, oids: string[]): Promise<Set<string>> {
  const missing = new Set<string>();
  const unique = [...new Set(oids)];
  if (unique.length === 0) return missing;
  const r = await ctx.base.run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    input: unique.map((o) => `${o}\n`).join(""),
    allowFailure: true,
  });
  if (r.code !== 0) return missing;
  for (const line of r.stdout.split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split(" ");
    // "<oid> missing" for an absent object, "<oid> blob <size>" otherwise.
    if (parts[1] === "missing" || (parts.length > 1 && parts[1] !== "blob")) {
      missing.add(parts[0]!);
    }
  }
  return missing;
}

/* ------------------------------------------------------------------ directory cache */

/**
 * Exact directory listings, cached per directory.
 *
 * Existence has to be answered by *name*, not by `lstat`: on a case-insensitive
 * filesystem `lstat("Foo.txt")` happily succeeds when the file on disk is `foo.txt`, and
 * that mismatch is precisely the `case-collision` this has to catch.
 */
class DirCache {
  private readonly cache = new Map<string, Set<string> | null>();

  constructor(private readonly root: string) {}

  private async entriesOf(repoDir: string): Promise<Set<string> | null> {
    const cached = this.cache.get(repoDir);
    if (cached !== undefined) return cached;
    const abs = repoDir === "" ? this.root : join(this.root, repoDir);
    let names: Set<string> | null;
    try {
      names = new Set(await fs.readdir(abs));
    } catch {
      names = null;
    }
    this.cache.set(repoDir, names);
    return names;
  }

  /** `"exact"`, a differently-cased sibling's name, or `null` when nothing is there. */
  async lookup(repoPath: string): Promise<"exact" | { otherCase: string } | null> {
    const slash = repoPath.lastIndexOf("/");
    const dir = slash < 0 ? "" : repoPath.slice(0, slash);
    const base = slash < 0 ? repoPath : repoPath.slice(slash + 1);
    const names = await this.entriesOf(dir);
    if (names === null) return null;
    if (names.has(base)) return "exact";
    const lower = base.toLowerCase();
    for (const n of names) {
      if (n.toLowerCase() === lower) return { otherCase: dir === "" ? n : `${dir}/${n}` };
    }
    return null;
  }
}

/* ------------------------------------------------------------------ environment probes */

const BASE_OPERATION_MARKERS = [
  ["MERGE_HEAD", "a merge"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase or `git am`"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["BISECT_LOG", "a bisect"],
  ["sequencer", "a sequencer operation"],
] as const;

async function baseOperationInProgress(ctx: Context): Promise<string | null> {
  for (const [marker, what] of BASE_OPERATION_MARKERS) {
    if (await pathExists(join(ctx.baseWorktreeGitDir, marker))) return what;
  }
  return null;
}


/* ------------------------------------------------------------------ overlay config */

interface ConfigProblem {
  key: string;
  problem: Problem;
  /** Value to write, or `null` for "handled specially" (the exclude file). */
  want: string | null;
}

async function overlayConfigValue(ctx: Context, key: string): Promise<string | null> {
  const r = await ctx.overlay.run(["config", "--local", "--get", key], { allowFailure: true });
  if (r.code !== 0) return null;
  return r.stdout.replace(/\n$/, "");
}

/**
 * The overlay repo's own settings. These are what make `git --git-dir=.overgit/.git …`
 * (the `overgit git` escape hatch) work at all, and an absolute `core.worktree` is a live
 * grenade: it survives until somebody renames the project directory, then every overlay
 * command fails with "this operation must be run in a work tree" (measured on git 2.55).
 */
async function checkOverlayConfig(ctx: Context): Promise<ConfigProblem[]> {
  const out: ConfigProblem[] = [];
  const cfgPath = overlayRel(ctx, "config");

  const worktree = await overlayConfigValue(ctx, "core.worktree");
  const resolved = worktree === null ? null : pathResolve(ctx.overlayGitDir, worktree);
  if (worktree === null || resolved !== ctx.root) {
    out.push({
      key: "core.worktree",
      want: "../..",
      problem: mk(
        "overlay-config-broken",
        "error",
        worktree === null
          ? "the overlay repo has no core.worktree, so plain git cannot find the work-tree"
          : `the overlay repo's core.worktree is ${quote(worktree)}, which resolves to ${resolved} instead of ${ctx.root}`,
        "run `overgit doctor --fix` to reset it to `../..` (relative, so the project directory can be renamed)",
        { path: cfgPath, fixable: true },
      ),
    });
  } else if (worktree.startsWith("/")) {
    out.push({
      key: "core.worktree",
      want: "../..",
      problem: mk(
        "overlay-config-broken",
        "warning",
        `the overlay repo's core.worktree is the absolute path ${worktree}; it will stop working the moment ${ctx.root} is renamed or moved`,
        "run `overgit doctor --fix` to rewrite it as the relative `../..`",
        { path: cfgPath, fixable: true },
      ),
    });
  }

  const bare = await overlayConfigValue(ctx, "core.bare");
  if (bare !== "false") {
    out.push({
      key: "core.bare",
      want: "false",
      problem: mk(
        "overlay-config-broken",
        "error",
        `the overlay repo has core.bare=${bare ?? "(unset)"}; it must be false or git refuses to use the work-tree`,
        `run \`overgit doctor --fix\` to set \`core.bare=false\` in ${cfgPath}`,
        { path: cfgPath, fixable: true },
      ),
    });
  }

  const untracked = await overlayConfigValue(ctx, "status.showUntrackedFiles");
  if (untracked !== "no") {
    out.push({
      key: "status.showUntrackedFiles",
      want: "no",
      problem: mk(
        "overlay-config-broken",
        "warning",
        `the overlay repo has status.showUntrackedFiles=${untracked ?? "(unset)"}; plain \`overgit git status\` would list every file the base owns as untracked`,
        `run \`overgit doctor --fix\` to set \`status.showUntrackedFiles=no\` in ${cfgPath}`,
        { path: cfgPath, fixable: true },
      ),
    });
  }

  const excludePath = join(ctx.overlayGitDir, "info", "exclude");
  const bytes = await fs.readFile(excludePath).catch(() => null);
  const block = bytes === null ? null : readManagedBlock(new Uint8Array(bytes));
  const wantLines = OVERLAY_EXCLUDE_LINES;
  if (block === null || wantLines.some((l) => !block.includes(l))) {
    out.push({
      key: "info/exclude",
      want: null,
      problem: mk(
        "overlay-config-broken",
        "error",
        block === null
          ? "the overlay repo's info/exclude has no overgit managed block, so the overlay would try to track its own storage"
          : `the overlay repo's info/exclude is missing ${wantLines.filter((l) => !block.includes(l)).map(quote).join(", ")}`,
        `run \`overgit doctor --fix\` to rewrite ${overlayRel(ctx, "info", "exclude")}`,
        { path: overlayRel(ctx, "info", "exclude"), fixable: true },
      ),
    });
  }

  return out;
}

/* ------------------------------------------------------------------ gitignore pollution */

interface IgnoreHit {
  file: string;
  line: number;
  pattern: string;
}

function normaliseIgnorePattern(raw: string): string | null {
  let s = raw.replace(/\r$/, "");
  if (s.trim() === "" || s.startsWith("#")) return null;
  s = s.trim();
  if (s.startsWith("!")) s = s.slice(1);
  s = s.replace(/^\/+/, "").replace(/\/+$/, "");
  return s.length > 0 ? s : null;
}

/**
 * Machine-local state never enters the base's history: `.git/info/exclude` only, never
 * `.gitignore`. That is a hard constraint, not a preference. A tracked
 * `.gitignore` naming `.overgit/` — or an overlay-added path — does exactly that: every
 * other clone of the base inherits this machine's private arrangement.
 */
async function checkGitignorePollution(
  ctx: Context,
  baseIndex: Map<string, TaggedEntry>,
  adds: string[],
): Promise<IgnoreHit[]> {
  const hits: IgnoreHit[] = [];
  const addSet = new Set(adds);

  for (const [path, entry] of baseIndex) {
    if (path !== ".gitignore" && !path.endsWith("/.gitignore")) continue;
    const dir = path === ".gitignore" ? "" : path.slice(0, path.length - "/.gitignore".length);

    let text: string;
    const wt = await readWorktree(join(ctx.root, path));
    if (wt.kind === "file" && wt.content !== null) {
      text = new TextDecoder().decode(wt.content);
    } else {
      const blob = await ctx.base.catFileBlob(entry.oid).catch(() => null);
      if (blob === null) continue;
      text = new TextDecoder().decode(blob);
    }

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const pattern = normaliseIgnorePattern(lines[i]!);
      if (pattern === null) continue;
      const asRepoPath = dir === "" ? pattern : `${dir}/${pattern}`;
      const pollutes =
        pattern === ".overgit" ||
        pattern.startsWith(".overgit/") ||
        asRepoPath === ".overgit" ||
        asRepoPath.startsWith(".overgit/") ||
        addSet.has(asRepoPath) ||
        addSet.has(pattern);
      if (pollutes) hits.push({ file: path, line: i + 1, pattern: lines[i]!.trim() });
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ diagnose */

/** Everything `diagnose` and `repair` both need, gathered once. */
interface Survey {
  manifest: Manifest;
  baseIndex: Map<string, TaggedEntry>;
  /** Every stage-0 skip-worktree path in the base. */
  baseSkip: Set<string>;
  /** Paths with conflict stages (>0) in the base index — a merge is unresolved there. */
  baseUnmerged: Set<string>;
  baseHead: Map<string, { oid: string; mode: string }>;
  overlayIndex: Map<string, IndexEntry>;
  overlayHead: Map<string, IndexEntry>;
  overlayHasHead: boolean;
  dirs: DirCache;
  /** Non-null when the base is mid-merge/rebase/…; the string names the operation. */
  baseOp: string | null;
  syncInProgress: boolean;
  detached: boolean;
}

/** The overlay's content for `p`: the index entry if there is one, else overlay HEAD. */
function overlayContentOf(s: Survey, p: string): IndexEntry | undefined {
  return s.overlayIndex.get(p) ?? s.overlayHead.get(p);
}

/** Paths the overlay tracks that are its own bookkeeping rather than user content. */
function isOverlayInternal(p: string): boolean {
  return isReservedPath(p);
}

async function survey(ctx: Context, manifest: Manifest): Promise<Survey> {
  const [baseEntries, overlayEntries, overlayHasHead, baseOp, syncInProgress, detached] =
    await Promise.all([
      lsFilesTagged(ctx.base),
      ctx.overlay.lsFiles(),
      ctx.overlay.headExists(),
      baseOperationInProgress(ctx),
      pathExists(syncStatePath(ctx)),
      pathExists(detachMarkerPath(ctx)),
    ]);

  const overlayHead = overlayHasHead ? indexMap(await ctx.overlay.lsTree("HEAD")) : new Map();
  const baseSkip = new Set<string>();
  const baseUnmerged = new Set<string>();
  for (const e of baseEntries) {
    if (e.stage === 0 && e.skipWorktree) baseSkip.add(e.path);
    if (e.stage > 0) baseUnmerged.add(e.path);
  }

  const wanted = new Set<string>(ownedPaths(manifest));
  for (const e of overlayEntries) if (!isOverlayInternal(e.path)) wanted.add(e.path);
  const baseHead = await baseHeadBlobs(ctx, [...wanted]);

  return {
    manifest,
    baseIndex: indexMap(baseEntries),
    baseSkip,
    baseUnmerged,
    baseHead,
    overlayIndex: indexMap(overlayEntries),
    overlayHead,
    overlayHasHead,
    dirs: new DirCache(ctx.root),
    baseOp,
    syncInProgress,
    detached,
  };
}

/**
 * Find everything wrong with this repository.
 *
 * Never mutates anything. Safe to call while another overgit holds the lock, and safe on a
 * repository that is mid-merge or mid-sync — those states are *reported*, and the fixes
 * they make unsafe are marked unfixable rather than silently attempted.
 */
export async function diagnose(ctx: Context): Promise<Problem[]> {
  const problems: Problem[] = [];

  // The `.overgit/` directory's only defence against `git clean -xfd` is the repository
  // at `.overgit/.git`, so that is the very first thing to check — it is the one failure
  // whose consequence is unrecoverable.
  const protection = await checkCleanProtection(ctx);

  // `Context.hasOverlay` insists on a real directory. A *gitfile* at `.overgit/.git` whose
  // target exists is an equally valid overlay (measured on git 2.55), so ask again.
  const hasOverlay = ctx.hasOverlay || (await resolveOverlayGuard(ctx)) !== null;
  if (!hasOverlay) {
    if (protection !== null && (await pathExists(ctx.overgitDir))) problems.push(protection);
    problems.push(
      mk(
        "no-overlay",
        "error",
        `there is no overlay in ${ctx.root}`,
        "run `overgit init` to create one, or `overgit clone <url>` to fetch one",
      ),
    );
    return problems;
  }
  if (protection !== null) problems.push(protection);

  // A *missing* manifest is not an empty overlay. `readManifest` returns an empty manifest
  // for a nonexistent file — a reasonable default for a fresh `init`, and a dangerous one
  // here: doctor would conclude the overlay owns nothing, then report every one of its own
  // paths as `stray-skip-worktree` and hint `git update-index --no-skip-worktree` on them.
  // Following that hint un-hides the overrides and the next `git add -A` commits the user's
  // private content into the shared base repo — the tool's own advice causing the exact
  // failure it exists to prevent. Check the file, not the parsed result.
  //
  // It is recoverable: the manifest is *tracked by the overlay*, so `HEAD:.overgit/…` almost
  // always still has it, which is why this is fixable rather than fatal.
  if (!(await pathExists(ctx.manifestPath))) {
    const inHead = (await ctx.overlay.revParse("HEAD:.overgit/manifest.json")) !== null;
    problems.push(
      mk(
        "manifest-missing",
        "error",
        `${ctx.manifestPath} does not exist, so overgit cannot tell what the overlay owns`,
        inHead
          ? "run `overgit doctor --fix` to restore it from the overlay's own history (`HEAD:.overgit/manifest.json`)"
          : "the overlay has no committed copy either — run `overgit doctor --fix` to rebuild what can be recovered from the overlay index, then check `overgit list`",
        { fixable: true },
      ),
    );
    return problems;
  }

  // Sparse checkout is reported before anything else and short-circuits the rest, because
  // every other finding below becomes a misleading symptom of it. With
  // `core.sparseCheckout=true` git *clears* the skip-worktree bit on any overridden file
  // present in the work-tree, so a full diagnose would list one `missing-skip-worktree` per
  // override and call each of them fixable — and `--fix` would set the bits, git would clear
  // them again, and the user would loop for ever without ever learning the cause.
  const sparse = await ctx.base.run(["config", "--bool", "--get", "core.sparseCheckout"], {
    allowFailure: true,
  });
  if (sparse.code === 0 && sparse.stdout.trim() === "true") {
    problems.push(
      mk(
        "base-sparse-checkout",
        "error",
        "the base repo has core.sparseCheckout enabled, which silently defeats every override",
        "run `git config --unset core.sparseCheckout` in the base (or `git sparse-checkout disable`), then `overgit doctor --fix`",
      ),
    );
    return problems;
  }

  // state that does not depend on the manifest
  for (const c of await checkOverlayConfig(ctx)) problems.push(c.problem);

  if (await pathExists(lockPath(ctx))) {
    const pid = readLockPid(lockPath(ctx));
    if (pid !== null && pidIsAlive(pid) && pid !== process.pid) {
      problems.push(
        mk(
          "interrupted-lock",
          "warning",
          `another overgit process (pid ${pid}) holds ${lockPath(ctx)}`,
          `wait for it to finish; if you are sure it is dead, remove ${lockPath(ctx)}`,
          { path: ".overgit/local/lock" },
        ),
      );
    } else if (pid !== process.pid) {
      problems.push(
        mk(
          "interrupted-lock",
          "warning",
          pid === null
            ? `${lockPath(ctx)} exists but holds no readable pid — an overgit process died here`
            : `${lockPath(ctx)} is held by pid ${pid}, which is gone — an overgit process died here`,
          `run \`overgit doctor --fix\` to remove ${lockPath(ctx)}, or delete it by hand`,
          { path: ".overgit/local/lock", fixable: true },
        ),
      );
    }
  }

  const baseOp = await baseOperationInProgress(ctx);
  if (baseOp !== null) {
    problems.push(
      mk(
        "base-operation-in-progress",
        "warning",
        `the base repo is in the middle of ${baseOp}`,
        `finish it in ${ctx.root} (\`git merge --continue\`/\`--abort\`, \`git rebase --continue\`/\`--abort\`) and then re-run \`overgit doctor --fix\`; until then overgit will not touch the base's index or the work-tree`,
      ),
    );
  }

  const syncInProgress = await pathExists(syncStatePath(ctx));
  if (syncInProgress) {
    let readable = true;
    try {
      JSON.parse(await fs.readFile(syncStatePath(ctx), "utf8"));
    } catch {
      readable = false;
    }
    problems.push(
      mk(
        "sync-in-progress",
        readable ? "warning" : "error",
        readable
          ? `a sync is in progress (${syncStatePath(ctx)} exists)`
          : `${syncStatePath(ctx)} exists but is not readable JSON — a sync was interrupted`,
        "run `overgit sync --continue` to finish it, or `overgit sync --abort` to roll it back",
        { path: ".overgit/local/sync-state.json" },
      ),
    );
  }

  // the manifest
  let manifest: Manifest;
  try {
    manifest = await readManifest(ctx);
  } catch (e) {
    const detail = isOvergitError(e) ? e.message : `${(e as Error).message}`;
    problems.push(
      mk(
        "manifest-unreadable",
        "error",
        detail,
        `run \`overgit doctor --fix\` to rebuild ${ctx.manifestPath} from the overlay's index (the broken file is saved under .overgit/local/backups/ first; whiteouts cannot be recovered this way and must be re-created with \`overgit rm\`)`,
        { path: ".overgit/manifest.json", fixable: true },
      ),
    );
    return problems;
  }

  const s = await survey(ctx, manifest);
  const paths = ownedPaths(manifest);

  if (!s.overlayHasHead) {
    problems.push(
      mk(
        "no-overlay-head",
        "warning",
        "the overlay repo has no commits, so its content exists only in the overlay index and cannot be pushed",
        'run `overgit commit -m "initial overlay"` to record it',
        { path: overlayRel(ctx) },
      ),
    );
  }

  // detached: the overlay is deliberately unmounted
  const mounted =
    paths.some((p) => manifest.entries[p]!.kind !== "add" && s.baseSkip.has(p)) ||
    (await currentExcludeBlock(ctx)) !== null;
  if (s.detached && !mounted) {
    // Everything the other checks would flag (missing bits, absent add files, no exclude
    // block) is exactly what `overgit detach` is supposed to have produced. Reporting it
    // would be noise, and `--fix` would silently re-mount the overlay under the user.
    problems.push(
      mk(
        "overlay-detached",
        "warning",
        `the overlay is detached (${detachMarkerPath(ctx)} exists): the work-tree holds the base's pristine content`,
        "run `overgit attach` to mount the overlay again; overgit will not repair work-tree drift while detached",
        { path: ".overgit/local/detached" },
      ),
    );
    for (const hit of await checkGitignorePollution(ctx, s.baseIndex, [])) {
      problems.push(gitignoreProblem(hit));
    }
    return problems;
  }
  if (s.detached && mounted) {
    problems.push(
      mk(
        "stale-detach-marker",
        "error",
        `${detachMarkerPath(ctx)} says the overlay is detached, but it is mounted (skip-worktree bits and/or the managed exclude block are in place)`,
        `run \`overgit doctor --fix\` to remove the stale marker ${detachMarkerPath(ctx)}`,
        { path: ".overgit/local/detached", fixable: true },
      ),
    );
  }

  // base-wide checks
  if (paths.some((p) => manifest.entries[p]!.kind !== "add")) {
    if ((await ctx.base.currentBranch()) === null && (await ctx.base.revParse("HEAD")) !== null) {
      problems.push(
        mk(
          "base-detached-head",
          "warning",
          "the base repo is on a detached HEAD, so every `upstream` comparison is against that commit rather than a branch",
          `check out a branch in ${ctx.root} (\`git switch -\`) before running \`overgit sync\``,
        ),
      );
    }
  }

  const owned = new Set(paths);
  for (const p of [...s.baseSkip].sort()) {
    if (owned.has(p)) continue;
    problems.push(
      mk(
        "stray-skip-worktree",
        "warning",
        `${quote(p)} has the base's skip-worktree bit set but the overlay does not own it, so the base is blind to changes there`,
        `if you set it yourself, ignore this; otherwise run \`git -C ${ctx.root} update-index --no-skip-worktree -- ${quote(p)}\``,
        { path: p },
      ),
    );
  }

  const adds = paths.filter((p) => manifest.entries[p]!.kind === "add");
  for (const hit of await checkGitignorePollution(ctx, s.baseIndex, adds)) {
    problems.push(gitignoreProblem(hit));
  }

  const contentGate = s.baseOp !== null ? `the base repo is in the middle of ${s.baseOp}` : s.syncInProgress ? "a sync is in progress" : null;
  const gateHint = s.baseOp !== null
    ? `finish or abort ${s.baseOp} in ${ctx.root} first, then run \`overgit doctor --fix\``
    : "run `overgit sync --continue` or `overgit sync --abort` first, then run `overgit doctor --fix`";

  const staleBaseBlobs = await missingBaseBlobs(
    ctx,
    paths
      .map((p) => manifest.entries[p]!)
      .filter((e): e is Extract<Entry, { baseBlob: string }> => e.kind !== "add")
      .map((e) => e.baseBlob),
  );

  for (const p of paths) {
    const entry = manifest.entries[p]!;
    const baseEntry = s.baseIndex.get(p);
    const headEntry = s.baseHead.get(p);
    const want = overlayContentOf(s, p);
    const lookup = await s.dirs.lookup(p);
    const state = lookup === "exact" ? await readWorktree(join(ctx.root, p)) : ABSENT;

    /* base-side flags */

    if (entry.kind !== "add") {
      if (baseEntry === undefined) {
        problems.push(
          mk(
            "upstream-gone",
            state.kind === "absent" && entry.kind === "delete" ? "warning" : "error",
            entry.kind === "override"
              ? `the base no longer tracks ${quote(p)}, so the overlay's version now shows up as an untracked file in \`git status\``
              : `the base no longer tracks ${quote(p)}, so the whiteout of it is meaningless`,
            `run \`overgit sync\` and then \`overgit resolve --keep ${quote(p)}\` to turn it into an overlay-added file, or \`overgit resolve --drop ${quote(p)}\` to stop owning it`,
            { path: p },
          ),
        );
      } else {
        if (!s.baseSkip.has(p)) {
          problems.push(
            mk(
              "missing-skip-worktree",
              "error",
              `${quote(p)} is ${entry.kind === "override" ? "overridden" : "whited out"} by the overlay but the base's skip-worktree bit is not set, so \`git status\` reports it as ${entry.kind === "override" ? "modified" : "deleted"}`,
              contentGate === null
                ? `run \`overgit doctor --fix\` (it runs \`git -C ${ctx.root} update-index --skip-worktree -- ${quote(p)}\`)`
                : `${gateHint} — ${contentGate}`,
              { path: p, fixable: contentGate === null },
            ),
          );
        }
        if (baseEntry.assumeUnchanged) {
          problems.push(
            mk(
              "assume-unchanged-set",
              "warning",
              `${quote(p)} also carries the base's assume-unchanged bit (\`git ls-files -v\` tags it \`s\`), which hides real changes and confuses tools that only look for \`S\``,
              contentGate === null
                ? `run \`overgit doctor --fix\` (it runs \`git -C ${ctx.root} update-index --no-assume-unchanged -- ${quote(p)}\`)`
                : `${gateHint} — ${contentGate}`,
              { path: p, fixable: contentGate === null },
            ),
          );
        }
        if (headEntry !== undefined && headEntry.oid !== baseEntry.oid) {
          problems.push(
            mk(
              "base-index-diverged",
              "warning",
              `the base has a staged change for ${quote(p)} (index ${baseEntry.oid.slice(0, 10)} ≠ HEAD ${headEntry.oid.slice(0, 10)}), and skip-worktree freezes it there, so \`git diff --cached\` will never clear`,
              `run \`git -C ${ctx.root} update-index --no-skip-worktree -- ${quote(p)} && git -C ${ctx.root} restore --staged -- ${quote(p)}\`, then \`overgit doctor --fix\``,
              { path: p },
            ),
          );
        }
      }

      if (staleBaseBlobs.has(entry.baseBlob)) {
        problems.push(
          mk(
            "base-blob-missing",
            "error",
            `the manifest records baseBlob ${entry.baseBlob.slice(0, 12)} for ${quote(p)}, but that object is not in the base's object store (the base was re-cloned, gc'd, or this overlay belongs to a different base)`,
            `fetch the missing history (\`git -C ${ctx.root} fetch --all\`), or run \`overgit sync\` to re-establish the fork point for ${quote(p)}; overgit will not silently pick a new merge base for you`,
            { path: p },
          ),
        );
      }
    } else if (baseEntry !== undefined || headEntry !== undefined) {
      problems.push(
        mk(
          "add-now-tracked-by-base",
          "error",
          `the overlay added ${quote(p)}, but the base now tracks it too, so the base's copy and the overlay's copy collide (the work-tree currently holds the base's bytes; the overlay's are safe in the overlay repo)`,
          `run \`overgit sync\` and then \`overgit resolve --adopt ${quote(p)}\` to keep the overlay's version as an override, or \`overgit resolve --take-upstream ${quote(p)}\` to drop it`,
          { path: p },
        ),
      );
    }

    if (s.baseUnmerged.has(p)) {
      problems.push(
        mk(
          "base-unmerged-path",
          "error",
          `${quote(p)} has unresolved conflict stages in the base's index, so the base is mid-merge on a path the overlay owns`,
          `resolve it in the base first (\`git -C ${ctx.root} checkout --ours -- ${quote(p)}\` or \`--theirs\`, then \`git add\`), or abort the merge; overgit cannot set skip-worktree on an unmerged path`,
          { path: p },
        ),
      );
    }

    /* overlay-side bookkeeping */

    if (entry.kind === "delete") {
      if (s.overlayIndex.has(p) || s.overlayHead.has(p)) {
        problems.push(
          mk(
            "whiteout-tracked-by-overlay",
            "warning",
            `the manifest says ${quote(p)} is whited out, but the overlay still tracks content at that path`,
            `run \`overgit add ${quote(p)}\` to turn it back into an override, or \`overgit git rm --cached -- ${quote(p)}\` to drop it from the overlay`,
            { path: p },
          ),
        );
      }
    } else {
      if (want === undefined) {
        problems.push(
          mk(
            "orphan-manifest-entry",
            "error",
            `the manifest says the overlay owns ${quote(p)} (${entry.kind}) but the overlay has no content for it`,
            state.kind === "file" || state.kind === "symlink"
              ? `run \`overgit doctor --fix\` to stage the current work-tree bytes of ${quote(p)} into the overlay, or \`overgit restore ${quote(p)}\` to give the path back to the base`
              : `run \`overgit doctor --fix\` to drop the entry and give ${quote(p)} back to the base`,
            { path: p, fixable: contentGate === null },
          ),
        );
      } else if (!s.overlayIndex.has(p) && s.overlayHead.has(p)) {
        problems.push(
          mk(
            "overlay-index-missing-entry",
            "error",
            `${quote(p)} is in the overlay's HEAD but not in its index, so the next \`overgit commit\` would delete it from overlay history`,
            `run \`overgit doctor --fix\` to restore the index entry for ${quote(p)} from the overlay's HEAD`,
            { path: p, fixable: true },
          ),
        );
      }
    }

    /* the work-tree */

    if (lookup !== null && lookup !== "exact") {
      problems.push(
        mk(
          "case-collision",
          "error",
          `the overlay owns ${quote(p)} but the work-tree has ${quote(lookup.otherCase)} — the same name in a different case`,
          `rename it (\`mv ${quote(lookup.otherCase)} ${quote(p)}\`) and re-run \`overgit doctor --fix\`, or run \`overgit restore ${quote(p)}\` to stop owning that path; overgit will not rename files for you`,
          { path: p },
        ),
      );
      continue;
    }

    if (entry.kind === "delete") {
      if (state.kind === "dir") {
        problems.push(
          mk(
            "path-blocked",
            "error",
            `${quote(p)} is whited out by the overlay but a directory now occupies that path`,
            `remove it by hand (\`rm -r ${quote(p)}\`) and re-run \`overgit doctor --fix\`; overgit never deletes a directory tree for you`,
            { path: p },
          ),
        );
      } else if (state.kind !== "absent") {
        const recoverable =
          contentIsOid(state.content, entry.baseBlob) ||
          contentIsOid(state.content, baseEntry?.oid) ||
          contentIsOid(state.content, headEntry?.oid);
        problems.push(
          mk(
            "whiteout-resurrected",
            "error",
            `${quote(p)} is whited out by the overlay but the work-tree has it back as a ${state.kind === "symlink" ? "symlink" : "file"}${recoverable ? " holding the base's content (git put it there — a `git pull` that changed the file resurrects it)" : " holding content that is in neither the base nor the overlay"}`,
            contentGate === null
              ? recoverable
                ? `run \`overgit doctor --fix\` to remove ${quote(p)} again (the content is in the base's object store), or \`overgit add ${quote(p)}\` to keep it as an override`
                : `run \`overgit doctor --fix\` to remove ${quote(p)} again — the current bytes are saved under .overgit/local/backups/ first — or \`overgit add ${quote(p)}\` to keep them`
              : `${gateHint} — ${contentGate}`,
            { path: p, fixable: contentGate === null },
          ),
        );
      }
      continue;
    }

    if (want === undefined) continue; // already reported as orphan-manifest-entry

    if (state.kind === "dir" || state.kind === "other") {
      problems.push(
        mk(
          "path-blocked",
          "error",
          `the overlay owns ${quote(p)} but a ${state.kind === "dir" ? "directory" : "special file"} occupies that path in the work-tree`,
          `remove it by hand (\`rm -r${state.kind === "dir" ? "" : "f"} ${quote(p)}\`) and re-run \`overgit doctor --fix\`; overgit never deletes a directory tree for you`,
          { path: p },
        ),
      );
      continue;
    }

    // A collision with the base is a decision, not drift: reporting content drift too
    // would only invite `--fix` to write bytes the base would immediately call modified.
    const collides = entry.kind === "add" && (baseEntry !== undefined || headEntry !== undefined);
    if (collides) continue;

    if (state.kind === "absent") {
      problems.push(
        mk(
          "worktree-content-drift",
          "error",
          `${quote(p)} is owned by the overlay but is missing from the work-tree (\`git clean -xfd\` and \`git stash -a\` both remove overlay-added files)`,
          contentGate === null
            ? `run \`overgit doctor --fix\` (or \`overgit apply\`) to restore ${quote(p)} from the overlay`
            : `${gateHint} — ${contentGate}`,
          { path: p, fixable: contentGate === null },
        ),
      );
      continue;
    }

    const matchesOverlay = contentIsOid(state.content, want.oid);
    if (matchesOverlay && state.mode === want.mode) continue; // in sync

    if (matchesOverlay) {
      // Same bytes, different mode. Nothing can be lost by a chmod, and a silently
      // dropped exec bit is a real footgun, so this one is repaired.
      problems.push(
        mk(
          "worktree-mode-drift",
          "warning",
          `${quote(p)} has the overlay's exact content but mode ${state.mode} instead of the recorded ${want.mode}`,
          contentGate === null
            ? `run \`overgit doctor --fix\` to restore mode ${want.mode} on ${quote(p)}, or \`overgit commit -m …\` to record ${state.mode} as the new mode`
            : `${gateHint} — ${contentGate}`,
          { path: p, fixable: contentGate === null },
        ),
      );
      continue;
    }

    const isBaseContent =
      contentIsOid(state.content, baseEntry?.oid) || contentIsOid(state.content, headEntry?.oid);
    if (isBaseContent) {
      problems.push(
        mk(
          "worktree-content-drift",
          "error",
          `${quote(p)} holds the base's content, not the overlay's — git wrote the base's version over it (a checkout or merge with the skip-worktree bit cleared)`,
          contentGate === null
            ? `run \`overgit doctor --fix\` (or \`overgit apply\`) to put the overlay's version of ${quote(p)} back; the base's bytes stay in its object store`
            : `${gateHint} — ${contentGate}`,
          { path: p, fixable: contentGate === null },
        ),
      );
      continue;
    }

    if (state.mode !== want.mode) {
      // File ↔ symlink, or a mode we cannot explain. Content differs too, so this is
      // reported but never repaired: the bytes on disk are the user's.
      problems.push(
        mk(
          "worktree-type-changed",
          "warning",
          `${quote(p)} is a ${state.kind === "symlink" ? "symlink" : "file"} with mode ${state.mode} in the work-tree, but the overlay records mode ${want.mode} with different content`,
          `run \`overgit commit -m …\` to record the change, or \`overgit apply --force\` to restore the overlay's version of ${quote(p)} (the current bytes are saved under .overgit/local/backups/ first)`,
          { path: p },
        ),
      );
    }
    // Otherwise: an ordinary uncommitted edit. Not a problem — that is the user working.
  }

  // overlay files with no manifest entry
  const overlayTracked = new Set<string>();
  for (const p of s.overlayIndex.keys()) if (!isOverlayInternal(p)) overlayTracked.add(p);
  for (const p of s.overlayHead.keys()) if (!isOverlayInternal(p)) overlayTracked.add(p);
  for (const p of [...overlayTracked].sort()) {
    if (owned.has(p)) continue;
    problems.push(
      mk(
        "orphan-overlay-file",
        "error",
        `the overlay tracks ${quote(p)} but the manifest has no entry for it, so nothing hides it from the base and a fresh \`overgit clone\` would not apply it`,
        `run \`overgit doctor --fix\` to record ${quote(p)} in the manifest (as an override if the base tracks it, otherwise as an add), or \`overgit git rm --cached -- ${quote(p)}\` to drop it from the overlay`,
        { path: p, fixable: true },
      ),
    );
  }

  if (paths.length > 0 && !s.overlayIndex.has(".overgit/manifest.json")) {
    problems.push(
      mk(
        "manifest-not-tracked",
        "error",
        "the overlay index has no entry for .overgit/manifest.json, so pushing the overlay would publish an overlay nobody can apply",
        "run `overgit doctor --fix` to stage .overgit/manifest.json into the overlay index",
        { path: ".overgit/manifest.json", fixable: true },
      ),
    );
  }

  // the base's exclude block
  problems.push(...(await checkExcludeBlock(ctx, manifest)));

  // pulls that git will refuse
  problems.push(...(await checkPullBlocked(ctx, manifest, s)));

  return problems;
}

function gitignoreProblem(hit: IgnoreHit): Problem {
  return mk(
    "gitignore-pollution",
    "warning",
    `${quote(hit.file)} line ${hit.line} is ${quote(hit.pattern)} — that is overgit's local state in a file the base tracks, so every other clone of the base inherits it`,
    `remove line ${hit.line} from ${quote(hit.file)} and commit that in the base; overgit keeps its own exclusions in .git/info/exclude and will never write a .gitignore`,
    { path: hit.file },
  );
}

async function checkExcludeBlock(ctx: Context, manifest: Manifest): Promise<Problem[]> {
  const out: Problem[] = [];
  const excludePath = join(ctx.baseGitDir, "info", "exclude");
  const want = desiredExcludeLines(manifest);

  const raw = await fs.readFile(excludePath, "utf8").catch(() => "");
  const blockCount = raw.split("\n").filter((l) => l.replace(/\r$/, "") === BEGIN_MARKER).length;
  if (blockCount > 1) {
    out.push(
      mk(
        "duplicate-exclude-block",
        "error",
        `${excludePath} contains ${blockCount} overgit managed blocks; only the first one is authoritative and the rest are stale`,
        "run `overgit doctor --fix` to collapse them into one regenerated block (everything outside the markers is preserved byte for byte)",
        { path: ".git/info/exclude", fixable: true },
      ),
    );
  }

  const current = await currentExcludeBlock(ctx);
  if (current === null) {
    if (want.length > 0) {
      out.push(
        mk(
          "missing-exclude-line",
          "error",
          `${excludePath} has no overgit managed block, so the base can see ${want.length === 1 ? "`.overgit/`" : `\`.overgit/\` and ${want.length - 1} overlay-added file(s)`}`,
          "run `overgit doctor --fix` to write the managed block back into .git/info/exclude",
          { path: ".git/info/exclude", fixable: true },
        ),
      );
    }
    return out;
  }

  const have = new Set(current);
  for (const line of want) {
    if (!have.has(line)) {
      out.push(
        mk(
          "missing-exclude-line",
          "error",
          `the managed block in ${excludePath} is missing ${quote(line)}, so the base reports that path as untracked`,
          `run \`overgit doctor --fix\` to regenerate the managed block with ${quote(line)}`,
          { path: ".git/info/exclude", fixable: true },
        ),
      );
    }
  }
  const wanted = new Set(want);
  for (const line of current) {
    if (!wanted.has(line)) {
      out.push(
        mk(
          "stale-exclude-line",
          "warning",
          `the managed block in ${excludePath} still lists ${quote(line)}, which the overlay no longer owns — the base is being kept blind to a file for no reason`,
          `run \`overgit doctor --fix\` to drop ${quote(line)} from the managed block`,
          { path: ".git/info/exclude", fixable: true },
        ),
      );
    }
  }
  return out;
}

/**
 * A base `git pull`/`git checkout` that touches an overridden path is *aborted* by git
 * ("Your local changes … would be overwritten", measured on git 2.55). That is inherent to
 * skip-worktree, so the honest thing is to name the paths before the user hits it.
 */
async function checkPullBlocked(ctx: Context, manifest: Manifest, s: Survey): Promise<Problem[]> {
  const overrides = ownedPaths(manifest).filter((p) => manifest.entries[p]!.kind === "override");
  if (overrides.length === 0) return [];

  const upstream = await ctx.base.run(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { allowFailure: true },
  );
  if (upstream.code !== 0) return [];
  const ref = upstream.stdout.trim();
  if (ref.length === 0) return [];

  const blocked: string[] = [];
  for (const p of overrides) {
    const theirs = await ctx.base.treeBlobOid(ref, p);
    const ours = s.baseHead.get(p)?.oid ?? null;
    if (theirs !== ours) blocked.push(p);
  }
  if (blocked.length === 0) return [];

  return [
    mk(
      "pull-blocked-by-override",
      "warning",
      `\`git pull\` in the base would be refused: ${ref} changes ${blocked.length} path(s) the overlay overrides (${blocked.slice(0, 5).map(quote).join(", ")}${blocked.length > 5 ? ", …" : ""})`,
      "run `overgit detach`, then your `git pull`, then `overgit attach` — followed by `overgit sync` to merge the new upstream content into the overlay",
      { path: blocked[0]! },
    ),
  ];
}

/* ------------------------------------------------------------------ repair */

/** Ids `repair` knows how to fix. Everything else is reported and left alone. */
const FIXABLE_IDS: ReadonlySet<ProblemId> = new Set<ProblemId>([
  "interrupted-lock",
  "stale-detach-marker",
  "overlay-config-broken",
  "manifest-unreadable",
  "manifest-missing",
  "orphan-manifest-entry",
  "orphan-overlay-file",
  "overlay-index-missing-entry",
  "manifest-not-tracked",
  "missing-skip-worktree",
  "assume-unchanged-set",
  "missing-exclude-line",
  "stale-exclude-line",
  "duplicate-exclude-block",
  "whiteout-resurrected",
  "worktree-content-drift",
  "worktree-mode-drift",
]);

function keyOf(p: Problem): string {
  return `${p.id}\0${p.path ?? ""}`;
}

/**
 * Fix what can be fixed.
 *
 * Idempotent in two senses: each individual fix re-reads the live state and does nothing
 * when the state is already right, and `repair` iterates until `diagnose` stops producing
 * new fixable problems — so a single `overgit doctor --fix` converges, and a second one
 * has nothing to do. Repairs that would touch the base's index or the work-tree are
 * skipped entirely while the base is mid-merge/mid-rebase or a sync is in progress; those
 * problems come back marked unfixable with a hint that names the blocking operation.
 */
export async function repair(ctx: Context, problems: Problem[]): Promise<RepairResult> {
  const fixed: Problem[] = [];
  const backups: string[] = [];
  const fixedKeys = new Set<string>();

  let round = problems;
  for (let i = 0; i < 4; i++) {
    const result = await repairRound(ctx, round);
    backups.push(...result.backups);
    let progressed = false;
    for (const p of result.fixed) {
      if (fixedKeys.has(keyOf(p))) continue;
      fixedKeys.add(keyOf(p));
      fixed.push(p);
      progressed = true;
    }
    if (!progressed) break;

    // A fix can uncover the next one (rebuilding the manifest reveals missing bits, and
    // so on). Re-diagnose and keep going until nothing fixable is left.
    const next = (await diagnose(ctx)).filter((p) => p.fixable && FIXABLE_IDS.has(p.id));
    if (next.length === 0) {
      round = [];
      break;
    }
    round = next;
  }

  const remaining = (await diagnose(ctx)).filter((p) => !fixedKeys.has(keyOf(p)));
  return { fixed, remaining, backups };
}

interface RoundResult {
  fixed: Problem[];
  backups: string[];
}

async function repairRound(ctx: Context, problems: Problem[]): Promise<RoundResult> {
  const fixed: Problem[] = [];
  const backups: string[] = [];
  const todo = problems.filter((p) => p.fixable && FIXABLE_IDS.has(p.id));
  if (todo.length === 0) return { fixed, backups };

  const byId = new Map<ProblemId, Problem[]>();
  for (const p of todo) {
    const list = byId.get(p.id);
    if (list) list.push(p);
    else byId.set(p.id, [p]);
  }
  const take = (id: ProblemId): Problem[] => byId.get(id) ?? [];

  // 1. local bookkeeping, independent of everything else
  for (const p of take("interrupted-lock")) {
    if (await fixInterruptedLock(ctx)) fixed.push(p);
  }
  for (const p of take("stale-detach-marker")) {
    await fs.rm(detachMarkerPath(ctx), { force: true });
    fixed.push(p);
  }

  // 2. the overlay repo itself, before anything reads through it
  if (byId.has("overlay-config-broken")) {
    for (const c of await checkOverlayConfig(ctx)) {
      if (c.key === "info/exclude") await ensureOverlayExcludes(ctx);
      else await ctx.overlay.run(["config", "--local", c.key, c.want!], { allowFailure: true });
    }
    // Re-check rather than trusting the write: a read-only config file must not be
    // reported as fixed. A problem counts as fixed when its exact message is gone.
    const still = new Set((await checkOverlayConfig(ctx)).map((c) => c.problem.message));
    for (const p of take("overlay-config-broken")) {
      if (!still.has(p.message)) fixed.push(p);
    }
  }

  // 3. the manifest
  for (const p of [...take("manifest-unreadable"), ...take("manifest-missing")]) {
    const r = await rebuildManifest(ctx);
    if (r.backup !== null) backups.push(r.backup);
    fixed.push(p);
  }

  let manifest: Manifest;
  try {
    manifest = await readManifest(ctx);
  } catch {
    // Still unreadable (and not in this round's list) — nothing else can be done safely.
    return { fixed, backups };
  }

  const s = await survey(ctx, manifest);
  const gated = s.baseOp !== null || s.syncInProgress;
  let manifestChanged = false;

  for (const p of take("orphan-manifest-entry")) {
    if (p.path === undefined || gated) continue;
    const entry = manifest.entries[p.path];
    if (!entry || entry.kind === "delete") continue;
    if (overlayContentOf(s, p.path) !== undefined) continue; // already resolved
    const state = await readWorktree(join(ctx.root, p.path));
    if ((state.kind === "file" || state.kind === "symlink") && state.content !== null) {
      await stageOverlayContent(ctx, p.path, state.mode!, state.content);
      s.overlayIndex.set(p.path, {
        path: p.path,
        oid: await ctx.overlay.hashObject(state.content),
        mode: state.mode!,
        stage: 0,
        skipWorktree: false,
      });
      fixed.push(p);
    } else {
      // Nothing anywhere: hand the path back to the base, restoring its content so the
      // base does not suddenly report a deletion.
      const r = await restoreToBase(ctx, [p.path], { repoRelative: true, force: true });
      backups.push(...r.backups);
      delete manifest.entries[p.path];
      manifestChanged = true;
      fixed.push(p);
    }
  }

  for (const p of take("orphan-overlay-file")) {
    if (p.path === undefined) continue;
    if (manifest.entries[p.path] !== undefined) continue;
    const baseBlob = s.baseHead.get(p.path)?.oid ?? s.baseIndex.get(p.path)?.oid ?? null;
    manifest.entries[p.path] = baseBlob === null ? { kind: "add" } : { kind: "override", baseBlob };
    manifestChanged = true;
    fixed.push(p);
  }

  for (const p of take("overlay-index-missing-entry")) {
    if (p.path === undefined) continue;
    const head = s.overlayHead.get(p.path);
    if (head === undefined || s.overlayIndex.has(p.path)) continue;
    await ctx.overlay.updateIndexCacheinfo(head.mode, head.oid, p.path);
    s.overlayIndex.set(p.path, { ...head });
    fixed.push(p);
  }

  if (manifestChanged) await persistManifest(ctx, manifest);

  for (const p of take("manifest-not-tracked")) {
    if (!manifestChanged) await persistManifest(ctx, manifest);
    fixed.push(p);
  }

  // 4. derived state: exclude block, then index bits, then bytes
  const wantExclude =
    byId.has("missing-exclude-line") ||
    byId.has("stale-exclude-line") ||
    byId.has("duplicate-exclude-block") ||
    manifestChanged;
  if (wantExclude) {
    await syncExcludeBlock(ctx, manifest);
    for (const id of ["missing-exclude-line", "stale-exclude-line", "duplicate-exclude-block"] as const) {
      for (const p of take(id)) fixed.push(p);
    }
  }

  if (!gated) {
    const toSet = take("missing-skip-worktree")
      .map((p) => p.path)
      .filter((p): p is string => p !== undefined)
      .filter((p) => manifest.entries[p] !== undefined && manifest.entries[p]!.kind !== "add")
      .filter((p) => s.baseIndex.has(p) && !s.baseSkip.has(p));
    if (toSet.length > 0) await ctx.base.setSkipWorktree(toSet);
    const nowSkipped = new Set(await ctx.base.skipWorktreePaths());
    for (const p of take("missing-skip-worktree")) {
      if (p.path !== undefined && nowSkipped.has(p.path)) fixed.push(p);
    }

    const toClear = take("assume-unchanged-set")
      .map((p) => p.path)
      .filter((p): p is string => p !== undefined)
      .filter((p) => s.baseIndex.get(p)?.assumeUnchanged === true);
    if (toClear.length > 0) {
      await ctx.base.run(["update-index", "-z", "--no-assume-unchanged", "--stdin"], {
        input: toClear.map((p) => `${p}\0`).join(""),
      });
      for (const p of take("assume-unchanged-set")) if (toClear.includes(p.path!)) fixed.push(p);
    }
  }

  // 5. the work-tree
  if (!gated) {
    for (const p of take("whiteout-resurrected")) {
      if (p.path === undefined) continue;
      const entry = manifest.entries[p.path];
      if (!entry || entry.kind !== "delete") continue;
      const state = await readWorktree(join(ctx.root, p.path));
      if (state.kind === "absent") {
        fixed.push(p);
        continue;
      }
      if (state.kind === "dir" || state.kind === "other") continue;
      const recoverable =
        contentIsOid(state.content, entry.baseBlob) ||
        contentIsOid(state.content, s.baseIndex.get(p.path)?.oid) ||
        contentIsOid(state.content, s.baseHead.get(p.path)?.oid);
      if (!recoverable) {
        const rel = await rescueWorktreeBytes(ctx, p.path, `doctor: whiteout ${p.path}`);
        if (rel !== null) backups.push(rel);
      }
      await fs.rm(join(ctx.root, p.path), { force: true });
      fixed.push(p);
    }

    for (const id of ["worktree-content-drift", "worktree-mode-drift"] as const) {
      for (const p of take(id)) {
        if (p.path === undefined) continue;
        const entry = manifest.entries[p.path];
        if (!entry || entry.kind === "delete") continue;
        const want = overlayContentOf(s, p.path);
        if (want === undefined) continue;
        const state = await readWorktree(join(ctx.root, p.path));
        if (state.mode === want.mode && contentIsOid(state.content, want.oid)) {
          fixed.push(p); // already right
          continue;
        }
        if (state.kind === "dir" || state.kind === "other") continue;
        // Only ever overwrite what is recoverable: absent, the base's bytes, or the same
        // bytes with a different mode. Anything else is the user's work and never gets
        // here (`diagnose` does not mark it fixable).
        const safe =
          state.kind === "absent" ||
          contentIsOid(state.content, want.oid) ||
          contentIsOid(state.content, s.baseIndex.get(p.path)?.oid) ||
          contentIsOid(state.content, s.baseHead.get(p.path)?.oid);
        if (!safe) {
          const rel = await rescueWorktreeBytes(ctx, p.path, `doctor: restore ${p.path}`);
          if (rel !== null) backups.push(rel);
        }
        const bytes = await ctx.overlay.catFileBlob(want.oid);
        await materialise(ctx, p.path, want.mode, bytes);
        fixed.push(p);
      }
    }
  }

  return { fixed, backups };
}

/** Removes a lock left by a dead process. Never removes a live one, or our own. */
async function fixInterruptedLock(ctx: Context): Promise<boolean> {
  const path = lockPath(ctx);
  if (!(await pathExists(path))) return true;
  const pid = readLockPid(lockPath(ctx));
  // `withLock` may be held by this very process (the CLI wraps `repair` in it), in which
  // case removing the file would hand the repo to a racing overgit.
  if (pid === process.pid) return false;
  if (pid !== null && pidIsAlive(pid)) return false;
  await fs.rm(path, { force: true });
  return true;
}

/**
 * Rebuild an unreadable manifest from the overlay's own index and HEAD.
 *
 * Everything the overlay tracks becomes an `override` (when the base tracks the path too)
 * or an `add`. Whiteouts have no overlay content by definition and therefore cannot be
 * recovered — the broken file is kept under `.overgit/local/backups/` so the user can read
 * the old `delete` entries back out of it.
 */
async function rebuildManifest(ctx: Context): Promise<{ backup: string | null }> {
  let backup: string | null = null;
  const raw = await fs.readFile(ctx.manifestPath).catch(() => null);
  if (raw !== null && raw.length > 0) {
    backup = await rescueWorktreeBytes(ctx, ".overgit/manifest.json", "doctor: unreadable manifest");
  }

  // The manifest is *tracked by the overlay*, so the overlay's own history is almost always
  // holding a correct copy — including the `delete` entries, which cannot be reconstructed
  // from the index at all (a whiteout has no overlay file to infer from). Rebuilding from
  // the index first silently and permanently discarded every whiteout. Read the blob we are
  // standing on before inferring anything.
  const committed = await ctx.overlay
    .run(["cat-file", "blob", "HEAD:.overgit/manifest.json"], { allowFailure: true })
    .catch(() => null);
  if (committed !== null && committed.code === 0) {
    try {
      const m = parseManifest(committed.stdout, `HEAD:.overgit/manifest.json`);
      await persistManifest(ctx, m);
      return { backup };
    } catch {
      // Committed copy is itself unparseable — fall through and reconstruct what we can.
    }
  }

  const overlayIndex = indexMap(await ctx.overlay.lsFiles());
  const overlayHead = (await ctx.overlay.headExists())
    ? indexMap(await ctx.overlay.lsTree("HEAD"))
    : new Map<string, IndexEntry>();

  const paths = new Set<string>();
  for (const p of overlayIndex.keys()) if (!isOverlayInternal(p)) paths.add(p);
  for (const p of overlayHead.keys()) if (!isOverlayInternal(p)) paths.add(p);

  const baseHead = await baseHeadBlobs(ctx, [...paths]);
  const baseIndex = indexMap(await ctx.base.lsFiles());

  const m = emptyManifest();
  for (const p of [...paths].sort()) {
    const baseBlob = baseHead.get(p)?.oid ?? baseIndex.get(p)?.oid ?? null;
    m.entries[p] = baseBlob === null ? { kind: "add" } : { kind: "override", baseBlob };
  }
  await persistManifest(ctx, m);
  return { backup };
}

