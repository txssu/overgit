/**
 * Upstream sync: reconciling base movement into overlay-owned paths.
 *
 * This is the part that has to survive reality. The base repo keeps moving — someone
 * pulls, someone rebases — and every overlay-owned path has to be re-decided against the
 * new upstream state. The manifest records, per path, the base blob the overlay forked
 * from (`baseBlob`). That blob is the **merge base** of a true three-way merge:
 *
 *     base   = the recorded fork-point blob        (manifest `baseBlob`)
 *     ours   = the overlay's current bytes         (work-tree, which is what the user sees)
 *     theirs = the base's current bytes            (`HEAD:<path>`)
 *
 * Five rules govern everything below. Each of them exists because breaking it loses data
 * or lies to the user.
 *
 * 1. **`baseBlob` advances only when a path is fully resolved.** A clean merge resolves a
 *    path; a conflict does not. A conflicted path keeps its old fork point so the next
 *    `overgit sync` re-merges from the same base instead of silently forgetting what the
 *    overlay diverged from.
 * 2. **A conflict blocks that path and nothing else.** Every other path in the same run is
 *    still synced, and the work-tree stays valid for `status` / `doctor` / `apply`.
 *    Overrides keep their skip-worktree bit while conflicted, so a work-tree full of
 *    conflict markers is *still* invisible to the base.
 * 3. **Deletions and collisions are decisions, never guesses.** Upstream deleting an
 *    overridden file, or upstream adding a path the overlay `add`s, have no correct
 *    automatic answer. They are recorded and handed back to the user.
 * 4. **Nothing is written before the previous bytes are recoverable.** Every path this
 *    module rewrites is first hashed into the *overlay* object store (so `--abort` can
 *    restore it byte-for-byte even after a reboot) and, when those bytes were not already
 *    reachable from the overlay index, copied into `.overgit/local/backups/`.
 * 5. **Binary content is never merged with text machinery, and never faked as a conflict.**
 *    `git merge-file` refuses binary input outright, and writing conflict markers into a PNG
 *    would corrupt it. So binary and symlink divergence is a **decision**
 *    (`binary-conflict`), not a `conflict`: with no markers to edit there is no trustworthy
 *    "I resolved it" signal, and a marker-based flow would let `sync --continue` stage the
 *    untouched overlay bytes and advance the fork point — silently discarding upstream's
 *    revision while recording it as merged.
 *
 * A sync in progress lives in `.overgit/local/sync-state.json`, written atomically after
 * every path, so a kill -9 or a reboot leaves a state that `--continue` or `--abort` can
 * finish. Starting a second sync on top of one refuses with `SYNC_IN_PROGRESS`.
 */

import { OvergitError, pathError } from "./errors.ts";
import type { Context } from "./context.ts";
import { withLock } from "./context.ts";
import type { IndexEntry } from "./git.ts";
import { literalPathspec, mergeBlobs, splitNul } from "./git.ts";
import type { Kind, Manifest } from "./manifest.ts";
import {
  cloneManifest,
  ownedPaths,
  parseManifest,
  readManifest,
  serializeManifest,
  writeManifest,
} from "./manifest.ts";
import { syncExcludeBlock } from "./exclude.ts";
import {
  materialise,
  readWorktreeEntry,
  rescueWorktreeBytes,
  stageOverlayContent,
} from "./ownership.ts";

import * as fs from "node:fs/promises";
import { join } from "node:path";

/* ------------------------------------------------------------------ public types */

export type Situation =
  /** nothing to do for this path */
  | "up-to-date"
  /** override, upstream moved, the three-way merge is clean */
  | "clean-merge"
  /** override, upstream moved, the three-way merge conflicts (or cannot be attempted) */
  | "conflict"
  /** override or delete: the base no longer tracks the path → DECISION */
  | "upstream-deleted"
  /** add: the base now tracks the path → DECISION */
  | "add-collision"
  /**
   * override: binary content, or a symlink, diverged three ways → DECISION.
   *
   * Deliberately NOT `conflict`. There are no conflict markers to write into a binary file
   * or a symlink target, so the work-tree keeps the overlay's bytes unchanged — which means
   * a marker-based resolution flow would let `sync --continue` stage those bytes and advance
   * the fork point, silently discarding upstream's revision and recording it as merged.
   * DESIGN.md §6.7 names that exact sequence as a data-loss bug.
   */
  | "binary-conflict"
  /** delete: base content moved; the whiteout is re-applied and `baseBlob` advances */
  | "whiteout-upstream-changed"
  /** overlay content missing from the work-tree; sync refuses to guess */
  | "local-missing";

export interface PlanItem {
  path: string;
  kind: Kind;
  situation: Situation;
  /** the fork point recorded in the manifest (`null` for `add`) */
  fromBlob: string | null;
  /** the base's current blob for the path (`null` when the base no longer tracks it) */
  toBlob: string | null;

  /* ---- additive vs DESIGN.md §5 (all optional, so the frozen shape still type-checks) ---- */

  /** True when the content cannot be text-merged (binary, or a symlink whose target moved). */
  binary?: boolean;
  /** Conflict hunk count from `git merge-file` (saturates at 127). */
  conflicts?: number;
  /** One-line human explanation. The CLI can print this verbatim. */
  detail?: string;
}

export interface SyncPlan {
  items: PlanItem[];
  needsDecision: PlanItem[];
  clean: PlanItem[];
  conflicts: PlanItem[];
  /** Additive: `local-missing` paths — sync refuses them and does not touch them. */
  blocked: PlanItem[];
}

export interface SyncOptions {
  dryRun?: boolean;
  /** Repo-relative POSIX paths. Every one must be owned by the overlay. */
  only?: string[];
  style?: "merge" | "diff3" | "zdiff3";
}

export interface SyncReport {
  /** Overrides resolved by a clean three-way merge. */
  merged: string[];
  /** Paths left conflicted; the work-tree holds markers (or, for binary, the old bytes). */
  conflicted: string[];
  /** Decisions the user must make. */
  pendingDecision: PlanItem[];
  /** Paths that were already in sync. */
  unchanged: string[];

  /* ---- additive ---- */

  /** Whiteouts whose upstream moved: the file was re-removed and `baseBlob` advanced. */
  whiteoutsRepaired: string[];
  /** Paths sync would not touch, with the reason (`local-missing`, and `only` misses). */
  skipped: { path: string; reason: string }[];
  /** Root-relative paths written under `.overgit/local/backups/`. */
  backups: string[];
  /** True when `.overgit/local/sync-state.json` still exists after this call. */
  syncInProgress: boolean;
  dryRun: boolean;
  /**
   * `--continue` found no sync in progress. Not an error: `overgit resolve` completes the
   * sync itself once the last conflict is marked, so the documented
   * "resolve … then sync --continue" sequence reaches this state normally.
   */
  alreadyFinished?: boolean;
}

export type Decision = "keep" | "drop" | "adopt" | "take-upstream" | "keep-whiteout";

/** Pre-sync state of one path, everything `abortSync` needs to put it back. */
export interface TouchedPath {
  /**
   * The work-tree entry as it was before sync touched it. `oid` names a blob written into
   * the **overlay** object store, so the bytes survive a reboot and a `git gc` in the base.
   */
  worktree:
    | { kind: "absent" }
    | { kind: "present"; mode: string; oid: string };
  /** The overlay index entry for the path before sync, or `null` when it had none. */
  overlayIndex: { mode: string; oid: string } | null;
  /** Whether the base carried the skip-worktree bit for this path before sync. */
  baseSkip: boolean;
  /** Root-relative path of a rescued copy, when one was written. */
  backup?: string;
}

export interface SyncState {
  startedAt: string;
  /** path → the blobs the conflicted merge was computed from */
  conflicts: Record<string, { toBlob: string; fromBlob: string }>;
  decisions: PlanItem[];
  merged: string[];

  /* ---- additive ---- */

  version: number;
  style: "merge" | "diff3" | "zdiff3";
  /** Serialised manifest as it was before the sync started. `abortSync` restores it. */
  manifestBefore: string;
  touched: Record<string, TouchedPath>;
  whiteoutsRepaired: string[];
  backups: string[];
}

/* ------------------------------------------------------------------ constants */

const SYNC_STATE_VERSION = 1;
const MANIFEST_REPO_PATH = ".overgit/manifest.json";
const BACKUP_REL = ".overgit/local/backups";
const enc = new TextEncoder();

function syncStatePath(ctx: Context): string {
  return join(ctx.localDir, "sync-state.json");
}

/** Where the upstream copy of an unmergeable (binary/symlink) conflict is written. */
function conflictScratchDir(ctx: Context): string {
  return join(ctx.localDir, "sync");
}

function shortOid(o: string | null | undefined): string {
  return o ? o.slice(0, 8) : "(none)";
}

function slugify(p: string): string {
  return (
    p
      .replace(/[/\\]/g, "-")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 80) || "file"
  );
}

/* ------------------------------------------------------------------ sync state i/o */

/** Atomic: sibling temp file, fsync-free rename. Never leaves a half-written state. */
async function writeSyncState(ctx: Context, state: SyncState): Promise<void> {
  const path = syncStatePath(ctx);
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.mkdir(ctx.localDir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new OvergitError("IO_FAILED", `cannot write ${path}: ${(e as Error).message}`, {
      hint: "check that .overgit/local/ exists and is writable",
      paths: [path],
      cause: e,
    });
  }
}

/**
 * The in-progress sync, or `null` when there is none.
 *
 * A state file that exists but cannot be understood is **not** treated as "no sync": that
 * would let a fresh sync run on top of half-applied work. It raises instead, naming the
 * file so the user can delete it.
 */
export async function readSyncState(ctx: Context): Promise<SyncState | null> {
  const path = syncStatePath(ctx);
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new OvergitError("IO_FAILED", `cannot read ${path}: ${(e as Error).message}`, {
      hint: "check the file's permissions",
      paths: [path],
      cause: e,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new OvergitError("IO_FAILED", `${path} is not valid JSON, so the interrupted sync cannot be resumed`, {
      hint: `inspect it, then delete it with \`rm ${path}\` to start over (overlay content is still in .overgit/repo and ${BACKUP_REL}/)`,
      paths: [path],
      cause: e,
    });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new OvergitError("IO_FAILED", `${path} does not contain a sync state object`, {
      hint: `delete it with \`rm ${path}\` to start over`,
      paths: [path],
    });
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.version !== "number" || o.version !== SYNC_STATE_VERSION) {
    throw new OvergitError(
      "IO_FAILED",
      `${path} was written by a different version of overgit (state version ${String(o.version)})`,
      { hint: `finish or delete it with the version that wrote it, or \`rm ${path}\``, paths: [path] },
    );
  }
  return {
    startedAt: typeof o.startedAt === "string" ? o.startedAt : new Date(0).toISOString(),
    conflicts: (o.conflicts as SyncState["conflicts"]) ?? {},
    decisions: (o.decisions as PlanItem[]) ?? [],
    merged: (o.merged as string[]) ?? [],
    version: SYNC_STATE_VERSION,
    style: (o.style as SyncState["style"]) ?? "merge",
    manifestBefore: typeof o.manifestBefore === "string" ? o.manifestBefore : "",
    touched: (o.touched as Record<string, TouchedPath>) ?? {},
    whiteoutsRepaired: (o.whiteoutsRepaired as string[]) ?? [],
    backups: (o.backups as string[]) ?? [],
  };
}

async function clearSyncState(ctx: Context): Promise<void> {
  await fs.rm(syncStatePath(ctx), { force: true });
  await fs.rm(conflictScratchDir(ctx), { recursive: true, force: true });
}

function syncInProgressError(state: SyncState): OvergitError {
  const conflicts = Object.keys(state.conflicts).sort();
  const decisions = state.decisions.map((d) => d.path).sort();
  const details: string[] = [];
  for (const p of conflicts) details.push(`conflict: ${p}`);
  for (const p of decisions) details.push(`decision: ${p}`);
  return new OvergitError(
    "SYNC_IN_PROGRESS",
    `a sync started at ${state.startedAt} is still in progress`,
    {
      hint: "resolve the paths below then run `overgit sync --continue`, or run `overgit sync --abort` to put everything back",
      details,
      paths: [...conflicts, ...decisions],
    },
  );
}

/* ------------------------------------------------------------------ manifest helper */

/**
 * Write the manifest and stage it into the overlay index, exactly as `ownership.ts` does.
 * Kept local because `ownership.persistManifest` is private; the two must stay in step.
 */
async function persistManifest(ctx: Context, m: Manifest): Promise<void> {
  await writeManifest(ctx, m);
  const oid = await ctx.overlay.hashObject(enc.encode(serializeManifest(m)), { write: true });
  await ctx.overlay.updateIndexCacheinfo("100644", oid, MANIFEST_REPO_PATH);
}

/* ------------------------------------------------------------------ repo probes */

interface TreeEntry {
  oid: string;
  mode: string;
}

function indexMap(entries: IndexEntry[]): Map<string, IndexEntry> {
  const m = new Map<string, IndexEntry>();
  for (const e of entries) if (e.stage === 0) m.set(e.path, e);
  return m;
}

/** `HEAD:<path>` in the base, with its mode. `null` when absent or not a blob. */
async function baseHeadEntry(ctx: Context, p: string): Promise<TreeEntry | null> {
  const r = await ctx.base.run(["ls-tree", "-z", "--full-tree", "HEAD", "--", literalPathspec(p)], {
    allowFailure: true,
  });
  if (r.code !== 0) return null;
  for (const rec of splitNul(r.stdout)) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    if (rec.slice(tab + 1) !== p) continue;
    const head = rec.slice(0, tab).split(" ");
    if (head.length < 3 || head[1] !== "blob") return null;
    return { oid: head[2]!, mode: head[0]! };
  }
  return null;
}

/* ------------------------------------------------------------------ analysis */

interface Prepared {
  item: PlanItem;
  /** Bytes + mode to write into the work-tree when this item is applied. */
  write?: { mode: string; content: Uint8Array };
  /** The base's current bytes, kept for `take-upstream` and for binary conflict scratch. */
  upstream?: { mode: string; content: Uint8Array };
  /** Overlay index entry as it stands right now (pre-sync). */
  overlayIndex: { mode: string; oid: string } | null;
  baseSkip: boolean;
}

interface Analysis {
  manifest: Manifest;
  prepared: Prepared[];
}

/**
 * Classify every owned path against the base's current HEAD, doing the three-way merge
 * in memory so `--dry-run` can honestly say "this will conflict" without touching a byte.
 * `git merge-file` runs on temp files under `.overgit/local/tmp` and never sees the
 * work-tree.
 */
async function analyse(ctx: Context, style: SyncOptions["style"]): Promise<Analysis> {
  const manifest = await readManifest(ctx);
  const paths = ownedPaths(manifest);
  if (paths.length === 0) return { manifest, prepared: [] };

  const [baseEntries, overlayEntries, baseHasHead, overlayHasHead] = await Promise.all([
    ctx.base.lsFiles(),
    ctx.overlay.lsFiles(),
    ctx.base.headExists(),
    ctx.overlay.headExists(),
  ]);
  const baseIndex = indexMap(baseEntries);
  const baseSkip = new Set<string>();
  for (const e of baseEntries) if (e.skipWorktree) baseSkip.add(e.path);
  const overlayIndex = indexMap(overlayEntries);
  const overlayHead = overlayHasHead ? indexMap(await ctx.overlay.lsTree("HEAD")) : new Map();

  const tmpDir = join(ctx.localDir, "tmp");
  const prepared: Prepared[] = [];

  for (const p of paths) {
    const entry = manifest.entries[p]!;
    const oi = overlayIndex.get(p) ?? overlayHead.get(p);
    const common = {
      overlayIndex: oi ? { mode: oi.mode, oid: oi.oid } : null,
      baseSkip: baseSkip.has(p),
    };
    const upstreamEntry = baseHasHead ? await baseHeadEntry(ctx, p) : null;

    /* ---- add ---- */
    if (entry.kind === "add") {
      if (upstreamEntry === null && !baseIndex.has(p)) {
        prepared.push({ item: item(p, "add", "up-to-date", null, null), ...common });
        continue;
      }
      const toBlob = upstreamEntry?.oid ?? baseIndex.get(p)!.oid;
      prepared.push({
        item: item(p, "add", "add-collision", null, toBlob, {
          detail: `the base now tracks ${p} (blob ${shortOid(toBlob)}); the overlay also adds it`,
        }),
        ...common,
      });
      continue;
    }

    /* ---- the base has no commits: never guess "upstream deleted it" ---- */
    if (!baseHasHead) {
      prepared.push({
        item: item(p, entry.kind, "up-to-date", entry.baseBlob, null, {
          detail: "the base repository has no commits yet",
        }),
        ...common,
      });
      continue;
    }

    /* ---- upstream deleted the path ---- */
    if (upstreamEntry === null) {
      prepared.push({
        item: item(p, entry.kind, "upstream-deleted", entry.baseBlob, null, {
          detail:
            entry.kind === "override"
              ? `the base no longer tracks ${p}, but the overlay overrides it`
              : `the base no longer tracks ${p}, so the whiteout has nothing to hide`,
        }),
        ...common,
      });
      continue;
    }

    /* ---- unchanged ---- */
    if (upstreamEntry.oid === entry.baseBlob) {
      prepared.push({ item: item(p, entry.kind, "up-to-date", entry.baseBlob, upstreamEntry.oid), ...common });
      continue;
    }

    /* ---- whiteout whose upstream moved ---- */
    if (entry.kind === "delete") {
      prepared.push({
        item: item(p, "delete", "whiteout-upstream-changed", entry.baseBlob, upstreamEntry.oid, {
          detail: `the base changed ${p} (${shortOid(entry.baseBlob)} → ${shortOid(upstreamEntry.oid)}); the whiteout still hides it`,
        }),
        ...common,
      });
      continue;
    }

    /* ---- override whose upstream moved: the real three-way merge ---- */
    const ours = await readWorktreeEntry(ctx.root, p);
    if (ours === null) {
      prepared.push({
        item: item(p, "override", "local-missing", entry.baseBlob, upstreamEntry.oid, {
          detail: `${p} is missing from the work-tree, so there is nothing to merge upstream into`,
        }),
        ...common,
      });
      continue;
    }

    if (!(await ctx.base.blobExists(entry.baseBlob))) {
      prepared.push({
        item: item(p, "override", "conflict", entry.baseBlob, upstreamEntry.oid, {
          binary: false,
          conflicts: 1,
          detail: `the recorded fork point ${shortOid(entry.baseBlob)} is missing from the base object store, so no three-way merge is possible`,
        }),
        upstream: { mode: upstreamEntry.mode, content: await ctx.base.catFileBlob(upstreamEntry.oid) },
        ...common,
      });
      continue;
    }

    const baseBytes = await ctx.base.catFileBlob(entry.baseBlob);
    const theirsBytes = await ctx.base.catFileBlob(upstreamEntry.oid);

    // A symlink's "content" is its target. Merging two targets line-by-line would produce
    // a nonsense path, so any symlink involvement is an explicit, manual conflict.
    const symlinkInvolved =
      ours.mode === "120000" || upstreamEntry.mode === "120000";
    if (symlinkInvolved) {
      prepared.push({
        item: item(p, "override", "binary-conflict", entry.baseBlob, upstreamEntry.oid, {
          binary: true,
          conflicts: 1,
          detail: `${p} is a symlink on at least one side; overgit will not merge link targets`,
        }),
        upstream: { mode: upstreamEntry.mode, content: theirsBytes },
        ...common,
      });
      continue;
    }

    const merge = await mergeBlobs({
      base: baseBytes,
      ours: ours.content,
      theirs: theirsBytes,
      labels: {
        ours: `${p} (overlay)`,
        base: `${p} (base ${shortOid(entry.baseBlob)})`,
        theirs: `${p} (upstream ${shortOid(upstreamEntry.oid)})`,
      },
      tmpDir,
      ...(style ? { style } : {}),
    });

    // File mode: **the overlay's wins, always.** The manifest records a fork-point *blob*
    // and a blob carries no mode, so "did the overlay change the mode, or did upstream?"
    // is genuinely unanswerable — the base's index entry is not the fork mode either, it
    // is whatever the last checkout left there. Guessing would silently flip the exec bit
    // on a file the overlay explicitly owns, in one direction or the other. So overgit
    // keeps the overlay's mode and *says* when upstream's differs.
    const mergedMode = ours.mode;
    const modeChanged = upstreamEntry.mode !== ours.mode;
    const modeNote = modeChanged
      ? `; upstream has mode ${upstreamEntry.mode}, the overlay keeps ${ours.mode} (chmod it yourself if you want upstream's)`
      : "";

    if (merge.clean && !merge.binary) {
      prepared.push({
        item: item(p, "override", "clean-merge", entry.baseBlob, upstreamEntry.oid, {
          conflicts: 0,
          detail: `merged ${shortOid(entry.baseBlob)} → ${shortOid(upstreamEntry.oid)} cleanly${modeNote}`,
        }),
        write: { mode: mergedMode, content: merge.content },
        upstream: { mode: upstreamEntry.mode, content: theirsBytes },
        ...common,
      });
      continue;
    }

    if (merge.binary) {
      // Trivially-resolvable binary cases were already handled inside `mergeBlobs`
      // (identical sides, one side unchanged). Reaching here means real divergence.
      if (merge.clean) {
        prepared.push({
          item: item(p, "override", "clean-merge", entry.baseBlob, upstreamEntry.oid, {
            binary: true,
            conflicts: 0,
            detail: `binary content, but only one side changed; took it verbatim${modeNote}`,
          }),
          write: { mode: mergedMode, content: merge.content },
          upstream: { mode: upstreamEntry.mode, content: theirsBytes },
          ...common,
        });
        continue;
      }
      prepared.push({
        item: item(p, "override", "binary-conflict", entry.baseBlob, upstreamEntry.oid, {
          binary: true,
          conflicts: 1,
          detail: `${p} is binary and both sides changed it; git cannot merge binary content`,
        }),
        upstream: { mode: upstreamEntry.mode, content: theirsBytes },
        ...common,
      });
      continue;
    }

    prepared.push({
      item: item(p, "override", "conflict", entry.baseBlob, upstreamEntry.oid, {
        binary: false,
        conflicts: merge.conflicts,
        detail: `${merge.conflicts} conflict${merge.conflicts === 1 ? "" : "s"} merging ${shortOid(entry.baseBlob)} → ${shortOid(upstreamEntry.oid)}`,
      }),
      write: { mode: mergedMode, content: merge.content },
      upstream: { mode: upstreamEntry.mode, content: theirsBytes },
      ...common,
    });
  }

  return { manifest, prepared };
}

function item(
  path: string,
  kind: Kind,
  situation: Situation,
  fromBlob: string | null,
  toBlob: string | null,
  extra?: { binary?: boolean; conflicts?: number; detail?: string },
): PlanItem {
  return { path, kind, situation, fromBlob, toBlob, ...(extra ?? {}) };
}

/* ------------------------------------------------------------------ planSync */

const DECISION_SITUATIONS = new Set<Situation>([
  "upstream-deleted",
  "add-collision",
  "binary-conflict",
]);

/** What `overgit sync` would do, computed without touching a single byte on disk. */
export async function planSync(ctx: Context): Promise<SyncPlan> {
  const { prepared } = await analyse(ctx, undefined);
  return toPlan(prepared.map((p) => p.item));
}

function toPlan(items: PlanItem[]): SyncPlan {
  return {
    items,
    needsDecision: items.filter((i) => DECISION_SITUATIONS.has(i.situation)),
    clean: items.filter((i) => i.situation === "clean-merge" || i.situation === "whiteout-upstream-changed"),
    conflicts: items.filter((i) => i.situation === "conflict"),
    blocked: items.filter((i) => i.situation === "local-missing"),
  };
}

/* ------------------------------------------------------------------ preservation */

/**
 * Record everything `abortSync` needs to undo a path, **before** anything is written.
 *
 * The work-tree bytes go into the overlay object store (`hash-object -w`), which is the
 * only place guaranteed to survive both a base-side `git gc` and a reboot. When those
 * bytes are not already reachable from the overlay index they are additionally copied to
 * `.overgit/local/backups/` so a human can find them without knowing git plumbing.
 */
async function preserve(
  ctx: Context,
  state: SyncState,
  prep: Prepared,
  reason: string,
  /**
   * Write a backup file even when the bytes are already reachable from the overlay index.
   * Set for decisions that *give a path up*: `drop` and `take-upstream` also drop the
   * overlay's index entry, so "it is still in the index" stops being true a moment later,
   * and a user who changes their mind needs something they can find without plumbing.
   */
  alwaysBackup = false,
): Promise<void> {
  const p = prep.item.path;
  if (state.touched[p]) return;

  const wt = await readWorktreeEntry(ctx.root, p);
  let worktree: TouchedPath["worktree"];
  let backup: string | undefined;

  if (wt === null) {
    worktree = { kind: "absent" };
  } else {
    const oid = await ctx.overlay.hashObject(wt.content, { write: true });
    worktree = { kind: "present", mode: wt.mode, oid };
    if (alwaysBackup || prep.overlayIndex === null || prep.overlayIndex.oid !== oid) {
      backup = (await rescueWorktreeBytes(ctx, p, reason)) ?? undefined;
      if (backup) state.backups.push(backup);
    }
  }

  state.touched[p] = {
    worktree,
    overlayIndex: prep.overlayIndex,
    baseSkip: prep.baseSkip,
    ...(backup ? { backup } : {}),
  };
}

/* ------------------------------------------------------------------ runSync */

export async function runSync(ctx: Context, opts?: SyncOptions): Promise<SyncReport> {
  const style = opts?.style ?? "merge";
  const dryRun = opts?.dryRun === true;

  if (dryRun) {
    // A dry run must not take the lock or care about an in-progress sync: reporting is
    // exactly what you want to do *while* one is stuck.
    const { prepared } = await analyse(ctx, style);
    const selected = select(prepared, opts?.only);
    const report = emptyReport(true);
    for (const prep of selected.chosen) classifyForReport(prep.item, report);
    report.skipped.push(...selected.skipped);
    report.syncInProgress = (await readSyncState(ctx)) !== null;
    return report;
  }

  return withLock(ctx, async () => {
    const existing = await readSyncState(ctx);
    if (existing) throw syncInProgressError(existing);

    const { manifest, prepared } = await analyse(ctx, style);
    const selected = select(prepared, opts?.only);
    const report = emptyReport(false);
    report.skipped.push(...selected.skipped);

    const manifestBefore = serializeManifest(manifest);
    const state: SyncState = {
      startedAt: new Date().toISOString(),
      conflicts: {},
      decisions: [],
      merged: [],
      version: SYNC_STATE_VERSION,
      style,
      manifestBefore,
      touched: {},
      whiteoutsRepaired: [],
      backups: [],
    };

    const work = selected.chosen.filter((p) => p.item.situation !== "up-to-date");
    if (work.length === 0) {
      for (const prep of selected.chosen) classifyForReport(prep.item, report);
      return report;
    }

    // The state file goes down *before* the first mutation, so a kill at any point from
    // here on leaves something `--abort` can act on.
    await writeSyncState(ctx, state);

    const next = cloneManifest(manifest);

    for (const prep of work) {
      const it = prep.item;
      switch (it.situation) {
        case "local-missing":
          report.skipped.push({
            path: it.path,
            reason: it.detail ?? "overlay content is missing from the work-tree",
          });
          break;

        case "binary-conflict":
          // Binary and symlink divergence cannot be shown in the file itself, so write
          // upstream's version beside it. Without this the user has no way to look at what
          // they are choosing between before answering the decision.
          if (prep.upstream !== undefined) {
            await writeConflictScratch(ctx, it.path, prep.upstream.content);
          }
          state.decisions.push(it);
          report.pendingDecision.push(it);
          await writeSyncState(ctx, state);
          break;

        case "upstream-deleted":
        case "add-collision":
          state.decisions.push(it);
          report.pendingDecision.push(it);
          await writeSyncState(ctx, state);
          break;

        case "whiteout-upstream-changed": {
          await preserve(ctx, state, prep, `sync: whiteout ${it.path}`);
          await writeSyncState(ctx, state);
          // Re-remove the resurrected file. The skip-worktree bit survives a pull
          // (measured on git 2.55), but re-assert it before touching the work-tree so a
          // half-repaired state can never look like a base-side deletion.
          if (!prep.baseSkip) await ctx.base.setSkipWorktree([it.path]);
          await fs.rm(join(ctx.root, it.path), { force: true }).catch(() => {});
          next.entries[it.path] = { kind: "delete", baseBlob: it.toBlob! };
          await writeManifest(ctx, next);
          state.whiteoutsRepaired.push(it.path);
          report.whiteoutsRepaired.push(it.path);
          await writeSyncState(ctx, state);
          break;
        }

        case "clean-merge": {
          await preserve(ctx, state, prep, `sync: merge ${it.path}`);
          await writeSyncState(ctx, state);
          const w = prep.write!;
          await materialise(ctx, it.path, w.mode, w.content);
          await stageOverlayContent(ctx, it.path, w.mode, w.content);
          next.entries[it.path] = { kind: "override", baseBlob: it.toBlob! };
          await writeManifest(ctx, next);
          state.merged.push(it.path);
          report.merged.push(it.path);
          await writeSyncState(ctx, state);
          break;
        }

        case "conflict": {
          await preserve(ctx, state, prep, `sync: conflict ${it.path}`);
          await writeSyncState(ctx, state);
          if (prep.write && !it.binary) {
            // Text conflict: the work-tree gets real conflict markers. The overlay index
            // deliberately keeps the *pre-sync* content — committing markers should take a
            // deliberate act, and `--abort` has to be able to put it back.
            await materialise(ctx, it.path, prep.write.mode, prep.write.content);
          } else if (prep.upstream) {
            // Binary / symlink: writing markers would corrupt the file, so the work-tree
            // is left exactly as it was and the upstream version is put beside it.
            await writeConflictScratch(ctx, it.path, prep.upstream.content);
          }
          state.conflicts[it.path] = { fromBlob: it.fromBlob!, toBlob: it.toBlob! };
          report.conflicted.push(it.path);
          await writeSyncState(ctx, state);
          break;
        }

        case "up-to-date":
          break;
      }
    }

    for (const prep of selected.chosen) {
      if (prep.item.situation === "up-to-date") report.unchanged.push(prep.item.path);
    }

    await finalise(ctx, next, state, report);
    return report;
  });
}

/**
 * Stage the manifest, regenerate the exclude block, and decide whether the sync is over.
 * Called at the end of every mutating entry point so the "is a sync still running?"
 * answer is computed in exactly one place.
 */
async function finalise(
  ctx: Context,
  manifest: Manifest,
  state: SyncState,
  report: SyncReport,
): Promise<void> {
  await persistManifest(ctx, manifest);
  await syncExcludeBlock(ctx, manifest);

  report.backups.push(...state.backups);
  const pending =
    Object.keys(state.conflicts).length > 0 || state.decisions.length > 0;
  if (pending) {
    await writeSyncState(ctx, state);
    report.syncInProgress = true;
  } else {
    await clearSyncState(ctx);
    report.syncInProgress = false;
  }
}

async function writeConflictScratch(ctx: Context, p: string, content: Uint8Array): Promise<string> {
  const dir = conflictScratchDir(ctx);
  await fs.mkdir(dir, { recursive: true });
  const abs = join(dir, `${slugify(p)}.upstream`);
  await fs.writeFile(abs, content);
  return abs;
}

/** Root-relative path of the upstream copy written for an unmergeable conflict. */
export function upstreamCopyPath(p: string): string {
  return `.overgit/local/sync/${slugify(p)}.upstream`;
}

/**
 * Rescue bytes that are *not* in the work-tree into `.overgit/local/backups/`.
 *
 * `ownership.rescueWorktreeBytes` covers the work-tree; this covers the other case sync
 * runs into — giving up a path whose overlay content the work-tree does not currently
 * hold (an `add-collision`, where git already overwrote the file with upstream's bytes).
 *
 * Deliberately the same directory, `NNNN-slug` naming and `index.log` line format as
 * `ownership.ts`'s private `backupBytes`, so the two interoperate and a user sees one
 * numbered sequence. It is duplicated rather than shared only because that helper is not
 * exported — see the note in the final report.
 */
async function rescueBlob(
  ctx: Context,
  repoPath: string,
  content: Uint8Array,
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
  const name = `${String(n).padStart(4, "0")}-${slugify(repoPath)}`;
  await fs.writeFile(join(dir, name), content);
  await fs
    .appendFile(
      join(dir, "index.log"),
      JSON.stringify({
        n,
        at: new Date().toISOString(),
        path: repoPath,
        file: name,
        reason,
        mode: null,
        kind: "overlay-content",
      }) + "\n",
    )
    .catch(() => {});
  return `${BACKUP_REL}/${name}`;
}

/**
 * Before a decision gives a path up, make sure the *overlay's* bytes end up somewhere a
 * human can find — the work-tree rescue is not enough when the work-tree no longer holds
 * them, and `rmCached` is about to drop the index entry that was keeping them reachable.
 */
async function rescueOverlayContent(
  ctx: Context,
  state: SyncState,
  p: string,
  reason: string,
): Promise<void> {
  const stored = await overlayContent(ctx, p);
  if (!stored) return;
  const t = state.touched[p];
  if (t && t.worktree.kind === "present") {
    const oid = await ctx.overlay.hashObject(stored.content);
    if (oid === t.worktree.oid) return; // identical bytes were already rescued
  }
  state.backups.push(await rescueBlob(ctx, p, stored.content, reason));
}

function emptyReport(dryRun: boolean): SyncReport {
  return {
    merged: [],
    conflicted: [],
    pendingDecision: [],
    unchanged: [],
    whiteoutsRepaired: [],
    skipped: [],
    backups: [],
    syncInProgress: false,
    dryRun,
  };
}

function classifyForReport(it: PlanItem, report: SyncReport): void {
  switch (it.situation) {
    case "up-to-date":
      report.unchanged.push(it.path);
      break;
    case "clean-merge":
      report.merged.push(it.path);
      break;
    case "whiteout-upstream-changed":
      report.whiteoutsRepaired.push(it.path);
      break;
    case "conflict":
      report.conflicted.push(it.path);
      break;
    case "upstream-deleted":
    case "add-collision":
    case "binary-conflict":
      report.pendingDecision.push(it);
      break;
    case "local-missing":
      report.skipped.push({
        path: it.path,
        reason: it.detail ?? "overlay content is missing from the work-tree",
      });
      break;
  }
}

function select(
  prepared: Prepared[],
  only: string[] | undefined,
): { chosen: Prepared[]; skipped: { path: string; reason: string }[] } {
  if (!only || only.length === 0) return { chosen: prepared, skipped: [] };
  const wanted = new Set(only);
  const known = new Set(prepared.map((p) => p.item.path));
  for (const p of wanted) {
    if (!known.has(p)) {
      throw pathError(
        "NOT_OWNED",
        p,
        `${p} is not owned by the overlay, so there is nothing to sync for it`,
        "run `overgit list` to see what the overlay owns",
      );
    }
  }
  return {
    chosen: prepared.filter((p) => wanted.has(p.item.path)),
    skipped: prepared
      .filter((p) => !wanted.has(p.item.path) && p.item.situation !== "up-to-date")
      .map((p) => ({ path: p.item.path, reason: "not selected by --only" })),
  };
}

/* ------------------------------------------------------------------ resolution */

/** Lines git itself treats as conflict markers. */
const MARKER = /^(<{7}|={7}|>{7})(\s|$)/;

function hasConflictMarkers(content: Uint8Array): boolean {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(content);
  for (const line of text.split("\n")) {
    if (MARKER.test(line)) return true;
  }
  return false;
}

export interface MarkResolvedOptions {
  /** Accept the file even when it still contains conflict-marker lines. */
  force?: boolean;
}

/**
 * Record conflicted paths as resolved: the current work-tree bytes become the overlay's
 * content and `baseBlob` advances to the upstream blob the merge was computed against.
 *
 * Refuses a file that still contains conflict markers — that is almost always a
 * half-finished edit, and staging it would put `<<<<<<<` into overlay history.
 */
export async function markResolved(
  ctx: Context,
  paths: string[],
  opts?: MarkResolvedOptions,
): Promise<SyncReport> {
  return withLock(ctx, async () => {
    const state = await readSyncState(ctx);
    if (!state) {
      throw new OvergitError("NO_SYNC_IN_PROGRESS", "there is no sync in progress", {
        hint: "run `overgit sync` first",
      });
    }
    const report = emptyReport(false);
    const manifest = await readManifest(ctx);
    const next = cloneManifest(manifest);

    for (const p of paths) {
      const rec = state.conflicts[p];
      if (!rec) {
        throw pathError(
          "NOT_OWNED",
          p,
          `${p} is not one of the conflicted paths in this sync`,
          `conflicted paths: ${Object.keys(state.conflicts).sort().join(", ") || "(none)"}`,
        );
      }
      await resolveOne(ctx, next, state, p, rec, opts?.force === true);
      report.merged.push(p);
    }

    await finalise(ctx, next, state, report);
    collectPending(state, report);
    return report;
  });
}

async function resolveOne(
  ctx: Context,
  manifest: Manifest,
  state: SyncState,
  p: string,
  rec: { toBlob: string; fromBlob: string },
  force: boolean,
): Promise<void> {
  const wt = await readWorktreeEntry(ctx.root, p);
  if (wt === null) {
    throw pathError(
      "PATH_NOT_FOUND",
      p,
      `${p} is missing from the work-tree, so there is nothing to record as resolved`,
      `restore it and try again, or run \`overgit sync --abort\` to put everything back`,
    );
  }
  if (!force && wt.mode !== "120000" && hasConflictMarkers(wt.content)) {
    throw pathError(
      "CONFLICTS_PENDING",
      p,
      `${p} still contains conflict markers`,
      `edit ${p} to remove the <<<<<<< / ======= / >>>>>>> lines, then run \`overgit sync --continue\` again (or pass --force if those lines are genuinely part of the file)`,
    );
  }
  await stageOverlayContent(ctx, p, wt.mode, wt.content);
  manifest.entries[p] = { kind: "override", baseBlob: rec.toBlob };
  await writeManifest(ctx, manifest);
  delete state.conflicts[p];
  if (!state.merged.includes(p)) state.merged.push(p);
  await writeSyncState(ctx, state);
}

/** Finish an interrupted sync: resolve every conflicted path from its work-tree bytes. */
export async function continueSync(ctx: Context): Promise<SyncReport> {
  const state = await readSyncState(ctx);
  if (!state) {
    // Not an error. `overgit resolve` finishes the sync automatically once the last
    // conflict is marked, and the conflict message tells the user to run `resolve` *and*
    // `sync --continue` — so the documented sequence lands here routinely. Failing would
    // mean the tool's own instructions produce an error, which is worse than the tiny
    // amount of typo-detection we give up. `--abort` still refuses, because aborting
    // nothing is a genuine sign of confusion.
    return {
      merged: [],
      conflicted: [],
      pendingDecision: [],
      unchanged: [],
      whiteoutsRepaired: [],
      skipped: [],
      backups: [],
      syncInProgress: false,
      dryRun: false,
      alreadyFinished: true,
    };
  }
  const conflicted = Object.keys(state.conflicts).sort();
  if (conflicted.length === 0) {
    // Only decisions left. Say so rather than silently reporting success.
    if (state.decisions.length > 0) {
      throw new OvergitError(
        "DECISION_REQUIRED",
        `${state.decisions.length} path${state.decisions.length === 1 ? "" : "s"} still need a decision before this sync can finish`,
        {
          hint: "run `overgit resolve --keep|--drop|--adopt|--take-upstream <path>` for each, then `overgit sync --continue`",
          details: state.decisions.map((d) => `${d.situation}: ${d.path}`),
          paths: state.decisions.map((d) => d.path),
        },
      );
    }
    // Nothing pending at all — the state file is stale. Clear it and report cleanly.
    return withLock(ctx, async () => {
      const report = emptyReport(false);
      report.merged.push(...state.merged);
      report.whiteoutsRepaired.push(...state.whiteoutsRepaired);
      report.backups.push(...state.backups);
      await clearSyncState(ctx);
      return report;
    });
  }
  return markResolved(ctx, conflicted);
}

function collectPending(state: SyncState, report: SyncReport): void {
  for (const p of Object.keys(state.conflicts).sort()) {
    if (!report.conflicted.includes(p)) report.conflicted.push(p);
  }
  for (const d of state.decisions) {
    if (!report.pendingDecision.some((x) => x.path === d.path)) report.pendingDecision.push(d);
  }
}

/* ------------------------------------------------------------------ abortSync */

/**
 * Put everything back exactly as it was before the sync started.
 *
 * Work-tree bytes come from the overlay object store, the manifest from the serialised
 * copy in the sync state, and the skip-worktree bits from the per-path record. Nothing is
 * read from memory, so this works after a reboot, and `baseBlob` ends up untouched for
 * every path — including the ones that had already merged cleanly.
 */
export async function abortSync(ctx: Context): Promise<void> {
  await withLock(ctx, async () => {
    const state = await readSyncState(ctx);
    if (!state) {
      throw new OvergitError("NO_SYNC_IN_PROGRESS", "there is no sync in progress to abort", {
        hint: "run `overgit sync` to start one",
      });
    }

    const overlayIndex = indexMap(await ctx.overlay.lsFiles());
    const baseEntries = await ctx.base.lsFiles();
    const baseIndex = indexMap(baseEntries);
    const baseSkipNow = new Set<string>();
    for (const e of baseEntries) if (e.skipWorktree) baseSkipNow.add(e.path);

    const paths = Object.keys(state.touched).sort();

    // Content first: the work-tree is restored before any index bit moves, so the base
    // never sees a modified tracked file even for an instant.
    for (const p of paths) {
      const t = state.touched[p]!;
      if (t.worktree.kind === "present") {
        const bytes = await ctx.overlay.catFileBlob(t.worktree.oid);
        await materialise(ctx, p, t.worktree.mode, bytes);
      } else {
        await fs.rm(join(ctx.root, p), { force: true }).catch(() => {});
      }
    }

    for (const p of paths) {
      const t = state.touched[p]!;
      if (t.overlayIndex) {
        await ctx.overlay.updateIndexCacheinfo(t.overlayIndex.mode, t.overlayIndex.oid, p);
      } else if (overlayIndex.has(p)) {
        await ctx.overlay.rmCached([p]);
      }
    }

    const manifest =
      state.manifestBefore.length > 0
        ? parseManifest(state.manifestBefore, ctx.manifestPath)
        : await readManifest(ctx);
    await persistManifest(ctx, manifest);
    await syncExcludeBlock(ctx, manifest);

    const toSet: string[] = [];
    const toClear: string[] = [];
    for (const p of paths) {
      const t = state.touched[p]!;
      if (!baseIndex.has(p)) continue;
      if (t.baseSkip && !baseSkipNow.has(p)) toSet.push(p);
      if (!t.baseSkip && baseSkipNow.has(p)) toClear.push(p);
    }
    await ctx.base.setSkipWorktree(toSet);
    await ctx.base.clearSkipWorktree(toClear);

    await clearSyncState(ctx);
  });
}

/* ------------------------------------------------------------------ decide */

/**
 * Answer one of the questions sync refuses to answer on its own.
 *
 * | situation                  | valid decisions                                  |
 * |----------------------------|--------------------------------------------------|
 * | `upstream-deleted` override| `keep` · `drop` · `take-upstream` (= `drop`)      |
 * | `upstream-deleted` delete  | `drop` · `take-upstream` (= `drop`)               |
 * | `add-collision`            | `adopt` · `drop` · `take-upstream` (= `drop`)     |
 * | `whiteout-upstream-changed`| `keep-whiteout`                                   |
 * | `conflict`                 | `keep` (ours wins) · `take-upstream` (theirs wins)|
 *
 * Works with or without a sync in progress: without one, the plan is recomputed and the
 * path must currently be in a state that needs deciding.
 */
export async function decide(ctx: Context, path: string, d: Decision): Promise<SyncReport> {
  return withLock(ctx, async () => {
    const state = await readSyncState(ctx);
    const report = emptyReport(false);

    if (state) {
      const conflict = state.conflicts[path];
      if (conflict) {
        const manifest = cloneManifest(await readManifest(ctx));
        await decideConflict(ctx, manifest, state, path, conflict, d, report);
        await finalise(ctx, manifest, state, report);
        collectPending(state, report);
        return report;
      }
      const idx = state.decisions.findIndex((x) => x.path === path);
      if (idx < 0) {
        throw pathError(
          "NOT_OWNED",
          path,
          `${path} is not one of the paths waiting for a decision in this sync`,
          `waiting on: ${[...state.decisions.map((x) => x.path), ...Object.keys(state.conflicts)].sort().join(", ") || "(none)"}`,
        );
      }
      const it = state.decisions[idx]!;
      const manifest = cloneManifest(await readManifest(ctx));
      const prep = await preparedFor(ctx, path, state.style);
      if (prep) await preserve(ctx, state, prep, `resolve --${d} ${path}`, givesUpContent(d));
      await applyDecision(ctx, manifest, state, it, d, report);
      state.decisions.splice(idx, 1);
      await finalise(ctx, manifest, state, report);
      collectPending(state, report);
      return report;
    }

    // No sync in progress: recompute and act if the path genuinely needs a decision.
    const { manifest, prepared } = await analyse(ctx, "merge");
    const prep = prepared.find((x) => x.item.path === path);
    if (!prep) {
      throw pathError(
        "NOT_OWNED",
        path,
        `${path} is not owned by the overlay`,
        "run `overgit list` to see what the overlay owns",
      );
    }
    if (!DECISION_SITUATIONS.has(prep.item.situation) && prep.item.situation !== "whiteout-upstream-changed") {
      throw pathError(
        "NOT_OWNED",
        path,
        `${path} does not need a decision (it is ${prep.item.situation})`,
        "run `overgit sync` to see what does",
      );
    }
    const scratch: SyncState = {
      startedAt: new Date().toISOString(),
      conflicts: {},
      decisions: [],
      merged: [],
      version: SYNC_STATE_VERSION,
      style: "merge",
      manifestBefore: serializeManifest(manifest),
      touched: {},
      whiteoutsRepaired: [],
      backups: [],
    };
    const next = cloneManifest(manifest);
    await preserve(ctx, scratch, prep, `resolve --${d} ${path}`, givesUpContent(d));
    await applyDecision(ctx, next, scratch, prep.item, d, report);
    await persistManifest(ctx, next);
    await syncExcludeBlock(ctx, next);
    report.backups.push(...scratch.backups);
    if (Object.keys(scratch.conflicts).length > 0) {
      // `adopt` can conflict; that needs a resumable sync, so promote the scratch state.
      await writeSyncState(ctx, scratch);
      report.syncInProgress = true;
      collectPending(scratch, report);
    }
    return report;
  });
}

/** Rebuild the `Prepared` record for one path (used to preserve pre-decision bytes). */
async function preparedFor(
  ctx: Context,
  path: string,
  style: SyncOptions["style"],
): Promise<Prepared | null> {
  const { prepared } = await analyse(ctx, style);
  return prepared.find((x) => x.item.path === path) ?? null;
}

/** Decisions that hand the path back to the base, discarding the overlay's claim on it. */
function givesUpContent(d: Decision): boolean {
  return d === "drop" || d === "take-upstream";
}

function badDecision(path: string, situation: Situation, d: Decision, valid: Decision[]): OvergitError {
  return pathError(
    "USAGE",
    path,
    `\`${d}\` is not a valid decision for ${path} (${situation})`,
    `valid here: ${valid.map((v) => `--${v}`).join(" ")}`,
  );
}

async function applyDecision(
  ctx: Context,
  manifest: Manifest,
  state: SyncState,
  it: PlanItem,
  d: Decision,
  report: SyncReport,
): Promise<void> {
  const p = it.path;

  if (it.situation === "whiteout-upstream-changed") {
    if (d !== "keep-whiteout") throw badDecision(p, it.situation, d, ["keep-whiteout"]);
    await ctx.base.setSkipWorktree(await trackedSubset(ctx, [p]));
    await fs.rm(join(ctx.root, p), { force: true }).catch(() => {});
    manifest.entries[p] = { kind: "delete", baseBlob: it.toBlob! };
    report.whiteoutsRepaired.push(p);
    return;
  }

  if (it.situation === "upstream-deleted") {
    if (it.kind === "delete") {
      if (d !== "drop" && d !== "take-upstream") {
        throw badDecision(p, it.situation, d, ["drop", "take-upstream"]);
      }
      // Upstream performed the deletion itself; the whiteout is redundant.
      await clearSkipIfSet(ctx, p);
      delete manifest.entries[p];
      report.merged.push(p);
      return;
    }
    switch (d) {
      case "keep": {
        // The overlay's content survives as an overlay-*added* file: the base no longer
        // tracks the path, so skip-worktree is meaningless and an exclude line is what
        // keeps it invisible.
        await clearSkipIfSet(ctx, p);
        manifest.entries[p] = { kind: "add" };
        await ensureOverlayHasContent(ctx, p);
        report.merged.push(p);
        return;
      }
      case "drop":
      case "take-upstream": {
        // Upstream's answer is "this file does not exist".
        await rescueOverlayContent(ctx, state, p, `resolve --${d} ${p}`);
        await clearSkipIfSet(ctx, p);
        await dropFromOverlay(ctx, p);
        delete manifest.entries[p];
        await fs.rm(join(ctx.root, p), { force: true }).catch(() => {});
        report.merged.push(p);
        return;
      }
      default:
        throw badDecision(p, it.situation, d, ["keep", "drop", "take-upstream"]);
    }
  }

  if (it.situation === "add-collision") {
    const toBlob = it.toBlob!;
    switch (d) {
      case "adopt": {
        const ours = await overlayContent(ctx, p);
        if (!ours) {
          throw pathError(
            "NOT_OWNED",
            p,
            `the overlay has no stored content for ${p}, so there is nothing to adopt`,
            "run `overgit doctor` to see why, or `overgit resolve --drop " + p + "` to give the path to the base",
          );
        }
        const theirs = await ctx.base.catFileBlob(toBlob);
        const theirsMode = (await ctx.base.fileMode(p)) ?? ours.mode;

        // `baseBlob` is *established* here rather than advanced: the path had no fork
        // point at all as an `add`. It must become an override immediately, because the
        // base tracks the path now and an exclude line cannot hide a tracked file — an
        // unresolved collision left as an `add` would leak straight into `git status`.
        manifest.entries[p] = { kind: "override", baseBlob: toBlob };
        await ctx.base.setSkipWorktree(await trackedSubset(ctx, [p]));

        const symlink = ours.mode === "120000" || theirsMode === "120000";
        const merge = symlink
          ? null
          : await mergeBlobs({
              base: new Uint8Array(0),
              ours: ours.content,
              theirs,
              labels: {
                ours: `${p} (overlay)`,
                base: `${p} (base: absent)`,
                theirs: `${p} (upstream ${shortOid(toBlob)})`,
              },
              tmpDir: join(ctx.localDir, "tmp"),
              style: state.style,
            });

        if (merge && merge.clean && !merge.binary) {
          await materialise(ctx, p, ours.mode, merge.content);
          await stageOverlayContent(ctx, p, ours.mode, merge.content);
          report.merged.push(p);
          return;
        }
        if (merge && !merge.binary) {
          await materialise(ctx, p, ours.mode, merge.content);
          state.conflicts[p] = { fromBlob: toBlob, toBlob };
          report.conflicted.push(p);
          return;
        }
        // Binary or symlink: leave the overlay's bytes in the work-tree untouched and put
        // the upstream version beside them.
        await materialise(ctx, p, ours.mode, ours.content);
        await writeConflictScratch(ctx, p, theirs);
        state.conflicts[p] = { fromBlob: toBlob, toBlob };
        report.conflicted.push(p);
        return;
      }
      case "drop":
      case "take-upstream": {
        // The base wins the path outright: its bytes go back into the work-tree and the
        // overlay stops tracking it. No skip-worktree bit, no exclude line. The work-tree
        // currently holds *upstream's* bytes (git overwrote the ignored file during the
        // pull), so the overlay's own copy has to be rescued explicitly.
        await rescueOverlayContent(ctx, state, p, `resolve --${d} ${p}`);
        await dropFromOverlay(ctx, p);
        delete manifest.entries[p];
        await clearSkipIfSet(ctx, p);
        const mode = (await ctx.base.fileMode(p)) ?? "100644";
        await materialise(ctx, p, mode, await ctx.base.catFileBlob(toBlob));
        report.merged.push(p);
        return;
      }
      default:
        throw badDecision(p, it.situation, d, ["adopt", "drop", "take-upstream"]);
    }
  }

  if (it.situation === "binary-conflict") {
    // Binary content and symlink targets have no conflict markers, so there is nothing to
    // hand-edit and no marker-based "I resolved it" signal to trust. Only the two wholesale
    // answers are honest, and each of them must record that upstream *was* considered — that
    // is what advancing `baseBlob` to `toBlob` means. Without it the same decision would be
    // re-asked on every sync for ever.
    if (d !== "keep" && d !== "take-upstream") {
      throw badDecision(p, it.situation, d, ["keep", "take-upstream"]);
    }
    const toBlob = it.toBlob!;
    if (d === "keep") {
      const wt = await readWorktreeEntry(ctx.root, p);
      if (wt !== null) await stageOverlayContent(ctx, p, wt.mode, wt.content);
      manifest.entries[p] = { kind: "override", baseBlob: toBlob };
      report.merged.push(p);
      return;
    }
    // take-upstream: the overlay's bytes are about to go, so rescue them first.
    await rescueOverlayContent(ctx, state, p, `resolve --take-upstream ${p}`);
    const mode = (await ctx.base.fileMode(p)) ?? "100644";
    const bytes = await ctx.base.catFileBlob(toBlob);
    await materialise(ctx, p, mode, bytes);
    await stageOverlayContent(ctx, p, mode, bytes);
    manifest.entries[p] = { kind: "override", baseBlob: toBlob };
    report.merged.push(p);
    return;
  }

  throw badDecision(p, it.situation, d, []);
}

async function decideConflict(
  ctx: Context,
  manifest: Manifest,
  state: SyncState,
  p: string,
  rec: { toBlob: string; fromBlob: string },
  d: Decision,
  report: SyncReport,
): Promise<void> {
  switch (d) {
    case "keep": {
      // Ours wins. The pre-sync overlay content is what "ours" meant, and for a text
      // conflict the work-tree currently holds markers — so restore from the overlay.
      const t = state.touched[p];
      if (t && t.worktree.kind === "present") {
        const bytes = await ctx.overlay.catFileBlob(t.worktree.oid);
        await materialise(ctx, p, t.worktree.mode, bytes);
        await stageOverlayContent(ctx, p, t.worktree.mode, bytes);
      } else {
        const ours = await readWorktreeEntry(ctx.root, p);
        if (!ours) {
          throw pathError("PATH_NOT_FOUND", p, `${p} is missing from the work-tree`, "restore it and try again");
        }
        await stageOverlayContent(ctx, p, ours.mode, ours.content);
      }
      manifest.entries[p] = { kind: "override", baseBlob: rec.toBlob };
      break;
    }
    case "take-upstream": {
      const mode = (await ctx.base.fileMode(p)) ?? "100644";
      const bytes = await ctx.base.catFileBlob(rec.toBlob);
      await materialise(ctx, p, mode, bytes);
      await stageOverlayContent(ctx, p, mode, bytes);
      manifest.entries[p] = { kind: "override", baseBlob: rec.toBlob };
      break;
    }
    default:
      throw badDecision(p, "conflict", d, ["keep", "take-upstream"]);
  }
  await writeManifest(ctx, manifest);
  delete state.conflicts[p];
  if (!state.merged.includes(p)) state.merged.push(p);
  report.merged.push(p);
  await writeSyncState(ctx, state);
}

/* ------------------------------------------------------------------ small helpers */

/** The overlay's stored content for a path: index entry first, then overlay HEAD. */
async function overlayContent(
  ctx: Context,
  p: string,
): Promise<{ mode: string; content: Uint8Array } | null> {
  const idx = (await ctx.overlay.lsFiles([literalPathspec(p)])).find(
    (e) => e.path === p && e.stage === 0,
  );
  if (idx) return { mode: idx.mode, content: await ctx.overlay.catFileBlob(idx.oid) };
  if (!(await ctx.overlay.headExists())) return null;
  const head = (await ctx.overlay.lsTree("HEAD")).find((e) => e.path === p);
  if (!head) return null;
  return { mode: head.mode, content: await ctx.overlay.catFileBlob(head.oid) };
}

/**
 * Make sure the overlay index holds the path's content, so an entry that just became an
 * `add` is not left with its bytes only in the work-tree.
 */
async function ensureOverlayHasContent(ctx: Context, p: string): Promise<void> {
  if (await overlayContent(ctx, p)) return;
  const wt = await readWorktreeEntry(ctx.root, p);
  if (wt) await stageOverlayContent(ctx, p, wt.mode, wt.content);
}

async function dropFromOverlay(ctx: Context, p: string): Promise<void> {
  const tracked = (await ctx.overlay.lsFiles([literalPathspec(p)])).some((e) => e.path === p);
  if (tracked) await ctx.overlay.rmCached([p]);
}

/** `git update-index` refuses paths it does not track, so filter before asking. */
async function trackedSubset(ctx: Context, paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) if (await ctx.base.isTracked(p)) out.push(p);
  return out;
}

async function clearSkipIfSet(ctx: Context, p: string): Promise<void> {
  const entries = await ctx.base.lsFiles([literalPathspec(p)]);
  if (entries.some((e) => e.path === p && e.skipWorktree)) {
    await ctx.base.clearSkipWorktree([p]);
  }
}
