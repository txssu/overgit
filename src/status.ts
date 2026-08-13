/**
 * The merged view.
 *
 * `overgit status` is not a `git status` proxy. The base's entry list has every path the
 * overlay owns removed from it — an overridden file is not "modified", it is *overgit's*,
 * and saying otherwise would train the user to ignore the output. What remains is genuinely
 * the base's own work, listed next to the overlay's.
 */

import type { Context } from "./context.ts";
import { detachMarkerPath, syncStatePath } from "./context.ts";
import { pathExists } from "./files.ts";
import type { StatusEntry } from "./git.ts";
import { blobOidLike } from "./git.ts";
import type { Entry, Manifest } from "./manifest.ts";
import { ownedPaths, readManifest } from "./manifest.ts";
import { currentExcludeBlock, desiredExcludeLines } from "./exclude.ts";

import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

export interface OverlayFileStatus {
  path: string;
  kind: Entry["kind"];
  /** Differs between overlay HEAD and overlay index. */
  staged: boolean;
  /** Differs between overlay index and the work-tree. For `delete`: the file is back. */
  worktreeDirty: boolean;
  /** Expected in the work-tree but absent. Always false for `delete`. */
  missing: boolean;
  /** The base's current `HEAD:<path>` versus the recorded `baseBlob`. */
  upstream: "same" | "changed" | "deleted" | "added" | "unknown";
}

export interface MergedStatus {
  base: { branch: string | null; head: string | null; entries: StatusEntry[] };
  overlay: {
    branch: string | null;
    head: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
  };
  files: OverlayFileStatus[];
  /**
   * The base's own tracking branch versus its HEAD. `touchesOwned` lists overlay-owned paths
   * changed by commits the base has fetched but not merged — the paths that will make a
   * `git pull` abort. Without this, `status` is blind between fetch and pull.
   */
  baseUpstream: { name: string | null; ahead: number; behind: number; touchesOwned: string[] };
  /**
   * Overlay-owned paths the base can currently *see* — i.e. invisibility is broken for them.
   *
   * `base.entries` deliberately subtracts everything the overlay owns, which is what makes
   * `status` a merged view rather than a `git status` proxy. But that subtraction also hides
   * the one thing the user most needs to know: when a leak exists, it is *at an owned path*,
   * so the honest merged view reported "base changes none" while `git add -A` would have
   * committed the user's private content. Report them separately and loudly.
   */
  visibleToBase: string[];
  /** Paths where `upstream !== "same"`. */
  syncPending: string[];
  syncInProgress: boolean;
  /**
   * `doctor`'s problem count, computed by `doctor` itself.
   *
   * This used to be a cheap re-implementation of a subset of doctor's checks, which meant
   * `overgit status` could print "doctor no problems" while `overgit doctor` exited 4 on the
   * very same repo — the headline command contradicting the checker it points at. If it is
   * worth showing here, it is worth being the same number.
   */
  problems: number;

  /* Additive: the states a base `git` command can leave behind, which status must report. */

  /** True when `.overgit/local/detached` exists, i.e. the overlay is unmounted. */
  detached: boolean;
  /**
   * Overridden paths whose upstream moved. A base `git pull` or `git checkout` that touches
   * one of these **aborts** ("Your local changes … would be overwritten by merge", measured
   * on git 2.55) — so the user needs
   * `overgit detach` first. Named so the CLI can print them.
   */
  pullBlocked: string[];
}

interface WtProbe {
  present: boolean;
  mode: string | null;
  oidLike: ((likeOid: string) => string) | null;
}

/** lstat + read, never following a symlink (a symlink's target *is* its content). */
async function probe(abs: string): Promise<WtProbe> {
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      const target = new Uint8Array(await readlink(abs, { encoding: "buffer" }));
      return { present: true, mode: "120000", oidLike: (o) => blobOidLike(target, o) };
    }
    if (!st.isFile()) return { present: true, mode: null, oidLike: null };
    const bytes = new Uint8Array(await readFile(abs));
    return {
      present: true,
      mode: (st.mode & 0o111) !== 0 ? "100755" : "100644",
      oidLike: (o) => blobOidLike(bytes, o),
    };
  } catch {
    return { present: false, mode: null, oidLike: null };
  }
}

/**
 * What the *base's* own tracking branch knows that its HEAD does not.
 *
 * Everything else in `status` compares against the base's HEAD, which means that between a
 * `git fetch` and a `git pull` — exactly the moment the user most needs warning — overgit
 * would report "base changes none / doctor no problems / already up to date" while
 * `origin/main` sat in the base's refs holding a change to an overridden file. That is not
 * silence, it is a wrong answer, and plain `git status` was more informative than the tool
 * claiming to be the merged view. So look at `@{upstream}` too, and name the owned paths it
 * touches — those are the ones that will make `git pull` abort.
 */
export async function baseUpstreamState(
  ctx: Context,
  owned: string[],
): Promise<MergedStatus["baseUpstream"]> {
  const none = { name: null, ahead: 0, behind: 0, touchesOwned: [] as string[] };
  const nameR = await ctx.base.run(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { allowFailure: true },
  );
  if (nameR.code !== 0) return none; // no tracking branch configured — nothing to say
  const name = nameR.stdout.trim();
  if (name === "") return none;

  const ab = await ctx.base.run(["rev-list", "--left-right", "--count", `HEAD...${name}`], {
    allowFailure: true,
  });
  if (ab.code !== 0) return { ...none, name };
  const [aheadStr, behindStr] = ab.stdout.trim().split(/\s+/);
  const ahead = Number(aheadStr ?? 0);
  const behind = Number(behindStr ?? 0);
  if (!Number.isFinite(behind) || behind <= 0) return { name, ahead, behind: Math.max(0, behind), touchesOwned: [] };

  // Which owned paths does the un-pulled range actually change? `diff --name-only` between
  // HEAD and the tracking ref, intersected with what we own — cheap and exact.
  const ownedSet = new Set(owned);
  const diff = await ctx.base.run(["diff", "--name-only", "-z", `HEAD...${name}`], {
    allowFailure: true,
  });
  const touchesOwned =
    diff.code === 0
      ? diff.stdout.split("\0").filter((p) => p !== "" && ownedSet.has(p)).sort()
      : [];
  return { name, ahead, behind, touchesOwned };
}

/** `<remote>/<branch>` for the overlay's upstream, or `null`. */
async function overlayUpstream(ctx: Context): Promise<string | null> {
  const r = await ctx.overlay.run(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { allowFailure: true },
  );
  if (r.code !== 0) return null;
  const name = r.stdout.trim();
  return name.length > 0 ? name : null;
}

async function aheadBehind(ctx: Context): Promise<{ ahead: number; behind: number }> {
  const r = await ctx.overlay.run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], {
    allowFailure: true,
  });
  if (r.code !== 0) return { ahead: 0, behind: 0 };
  const [a, b] = r.stdout.trim().split(/\s+/);
  return { ahead: Number(a) || 0, behind: Number(b) || 0 };
}

/**
 * The base's own status, with everything overgit owns removed.
 *
 * Renames are filtered on *either* side: a rename whose source the overlay owns is a
 * consequence of overgit's bookkeeping, not the user's work.
 */
function filterBaseEntries(entries: StatusEntry[], owned: Set<string>): StatusEntry[] {
  return entries.filter((e) => {
    if (owned.has(e.path)) return false;
    if (e.origPath !== undefined && owned.has(e.origPath)) return false;
    // `.overgit/` is excluded in the base, but a stale exclude block or an `--ignored`
    // run could still surface it; it is never the base's business.
    return e.path !== ".overgit" && !e.path.startsWith(".overgit/");
  });
}

export async function computeStatus(ctx: Context): Promise<MergedStatus> {
  const manifest: Manifest = await readManifest(ctx);
  const paths = ownedPaths(manifest);
  const owned = new Set(paths);

  const [baseBranch, baseHead, baseEntries, baseIndexEntries, overlayBranch, overlayHead] =
    await Promise.all([
      ctx.base.currentBranch(),
      ctx.base.revParse("HEAD"),
      ctx.base.statusPorcelain(undefined, { untracked: "normal" }),
      ctx.base.lsFiles(),
      ctx.overlay.currentBranch(),
      ctx.overlay.revParse("HEAD"),
    ]);

  const baseIndex = new Map<string, { oid: string; mode: string }>();
  const baseSkip = new Set<string>();
  for (const e of baseIndexEntries) {
    if (e.stage !== 0) continue;
    baseIndex.set(e.path, { oid: e.oid, mode: e.mode });
    if (e.skipWorktree) baseSkip.add(e.path);
  }

  const overlayIndex = new Map<string, { oid: string; mode: string }>();
  for (const e of await ctx.overlay.lsFiles()) {
    if (e.stage === 0) overlayIndex.set(e.path, { oid: e.oid, mode: e.mode });
  }
  const overlayTree = new Map<string, { oid: string; mode: string }>();
  if (overlayHead !== null) {
    for (const e of await ctx.overlay.lsTree("HEAD")) overlayTree.set(e.path, { oid: e.oid, mode: e.mode });
  }

  const [upstreamName, ab, baseUpstream] = await Promise.all([
    overlayUpstream(ctx),
    aheadBehind(ctx),
    baseUpstreamState(ctx, paths),
  ]);

  // One `ls-tree` for the whole HEAD, not one per owned path. The per-path version spawned
  // a git process inside the loop and made `overgit status` take ~8 seconds on a 10k-entry
  // manifest — for the command people run most often, and the one that has to work while a
  // sync is running in another terminal.
  const baseHeadBlobs = new Map<string, string>();
  if (baseHead !== null) {
    for (const e of await ctx.base.lsTree("HEAD")) {
      if (e.stage === 0) baseHeadBlobs.set(e.path, e.oid);
    }
  }

  const files: OverlayFileStatus[] = [];
  let problems = 0;

  for (const p of paths) {
    const entry = manifest.entries[p]!;
    const idx = overlayIndex.get(p);
    const tree = overlayTree.get(p);
    const wt = await probe(join(ctx.root, p));

    // ── upstream: the base's HEAD versus the blob we forked from ──
    let upstream: OverlayFileStatus["upstream"];
    if (entry.kind === "add") {
      // The collision case: the base has started tracking a path the overlay added.
      upstream = baseIndex.has(p) || baseHeadBlobs.has(p) ? "added" : "same";
    } else {
      const headBlob = baseHeadBlobs.get(p) ?? null;
      if (headBlob === null) upstream = baseHead === null ? "unknown" : "deleted";
      else if (headBlob === entry.baseBlob) upstream = "same";
      else upstream = "changed";
    }

    let staged: boolean;
    let worktreeDirty: boolean;
    let missing: boolean;

    if (entry.kind === "delete") {
      // The overlay tracks nothing at a whiteout path, so "staged" means a staged removal.
      staged = tree !== undefined && idx === undefined;
      worktreeDirty = wt.present; // the file came back — drift, `overgit apply` fixes it
      missing = false;
      if (wt.present) problems++;
      if (baseIndex.has(p) && !baseSkip.has(p)) problems++;
    } else {
      staged = (idx?.oid ?? null) !== (tree?.oid ?? null) || (idx?.mode ?? null) !== (tree?.mode ?? null);
      const want = idx ?? tree;
      missing = !wt.present;
      if (!want) {
        worktreeDirty = false;
        problems++; // orphan manifest entry: nothing in the overlay to materialise
      } else if (!wt.present) {
        worktreeDirty = true;
        problems++;
      } else if (wt.oidLike === null) {
        worktreeDirty = true;
        problems++;
      } else {
        worktreeDirty = wt.mode !== want.mode || wt.oidLike(want.oid) !== want.oid;
        if (idx === undefined) problems++; // tracked in HEAD but dropped from the index
      }
      if (entry.kind === "override" && baseIndex.has(p) && !baseSkip.has(p)) problems++;
      if (entry.kind === "add" && upstream === "added") problems++;
    }

    files.push({ path: p, kind: entry.kind, staged, worktreeDirty, missing, upstream });
  }

  // Exclude block drift is cheap to check and is the other half of invisibility.
  const currentBlock = await currentExcludeBlock(ctx);
  const wantBlock = desiredExcludeLines(manifest);
  if (
    currentBlock === null ||
    currentBlock.length !== wantBlock.length ||
    currentBlock.some((l, i) => l !== wantBlock[i])
  ) {
    problems++;
  }

  const syncInProgress = await pathExists(syncStatePath(ctx));

  // Ask doctor rather than approximating it, so `status` can never claim "no problems" while
  // `doctor` exits 4 on the same repo. Imported lazily: `doctor.ts` imports this module for
  // its own reporting, and a static cycle would be gratuitous.
  try {
    const { diagnose } = await import("./doctor.ts");
    problems = (await diagnose(ctx)).length;
  } catch {
    // If doctor itself cannot run, fall back to the checks counted above rather than
    // claiming a clean bill of health.
    problems = Math.max(problems, 1);
  }
  const detached = await pathExists(detachMarkerPath(ctx));

  return {
    base: { branch: baseBranch, head: baseHead, entries: filterBaseEntries(baseEntries, owned) },
    overlay: {
      branch: overlayBranch,
      head: overlayHead,
      upstream: upstreamName,
      ahead: ab.ahead,
      behind: ab.behind,
    },
    files,
    baseUpstream,
    visibleToBase: baseEntries
      .filter((e) => owned.has(e.path) || (e.origPath !== undefined && owned.has(e.origPath)))
      .map((e) => e.path)
      .sort(),
    syncPending: files.filter((f) => f.upstream !== "same").map((f) => f.path),
    syncInProgress,
    problems,
    detached,
    pullBlocked: files
      .filter((f) => f.kind === "override" && (f.upstream === "changed" || f.upstream === "deleted"))
      .map((f) => f.path),
  };
}
