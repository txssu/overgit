/**
 * Byte-level work-tree snapshots.
 *
 * A snapshot is a sorted `Map<relativePosixPath, marker>`. Markers are strings so a
 * failing test can print something a human can read:
 *
 *   file 100644 <sha256>     regular file, not executable
 *   file 100755 <sha256>     regular file, executable
 *   symlink -> <target>      symlink, NOT followed
 *   dir (empty)              directory with no entries (git cannot represent these;
 *                            an empty dir left behind after a whiteout is a real bug)
 *   other <kind>             fifo/socket/device
 *
 * Excluded: `.git` at any depth — which covers the overlay GIT_DIR at `.overgit/.git`,
 * whether it is a directory or a gitfile — plus `.overgit/local` and the
 * legacy `.overgit/repo`. `.overgit/manifest.json` *is* part of the snapshot: it is
 * overlay-tracked portable state, and tests need to see it move.
 */

import { readdir, lstat, readlink, readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export type TreeSnapshot = Map<string, string>;

export interface SnapshotOptions {
  /**
   * Additional root-relative POSIX paths to exclude (a path excludes itself and,
   * if it is a directory, everything under it).
   */
  exclude?: string[];
  /** Exclude directory basenames at any depth. Defaults to `[".git"]`. */
  excludeNames?: string[];
  /** Record empty directories. Default true. */
  includeEmptyDirs?: boolean;
}

/**
 * Root-relative paths every snapshot drops: overlay internals that are machine-local or
 * repository plumbing. `.overgit/.git` needs no entry here — the `.git` basename rule
 * below already covers it.
 */
export const DEFAULT_EXCLUDES = [".overgit/local", ".overgit/repo"];
/** Basenames dropped at any depth: git metadata for base, overlay *and* nested repos. */
export const DEFAULT_EXCLUDE_NAMES = [".git"];

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

export async function sha256File(abs: string): Promise<string> {
  const bytes = await readFile(abs);
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function sha256(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/**
 * Recursive snapshot of `dir`. `dir` is realpath'd first, which matters on macOS where
 * `/tmp` is a symlink to `/private/tmp` and naive `relative()` comparisons blow up.
 */
export async function snapshotTree(
  dir: string,
  opts: SnapshotOptions = {},
): Promise<TreeSnapshot> {
  const root = await realpath(dir);
  const excluded = new Set([...DEFAULT_EXCLUDES, ...(opts.exclude ?? [])]);
  const excludedNames = new Set(opts.excludeNames ?? DEFAULT_EXCLUDE_NAMES);
  const includeEmptyDirs = opts.includeEmptyDirs !== false;

  const entries: Array<[string, string]> = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    const items = await readdir(absDir, { withFileTypes: true });

    for (const item of items) {
      const rel = relDir === "" ? item.name : `${relDir}/${item.name}`;
      if (excludedNames.has(item.name)) continue;
      if (excluded.has(rel)) continue;

      const abs = join(absDir, item.name);
      const st = await lstat(abs);

      if (st.isSymbolicLink()) {
        entries.push([rel, `symlink -> ${toPosix(await readlink(abs))}`]);
      } else if (st.isDirectory()) {
        await walk(abs, rel);
      } else if (st.isFile()) {
        const mode = st.mode & 0o111 ? "100755" : "100644";
        entries.push([rel, `file ${mode} ${await sha256File(abs)}`]);
      } else {
        entries.push([rel, `other ${kindOf(st)}`]);
      }
    }

    // Only *genuinely* empty directories are recorded. A directory holding nothing but
    // excluded content (a nested `.git`, say) is not "empty" and must not look like it.
    if (items.length === 0 && relDir !== "" && includeEmptyDirs) {
      entries.push([relDir, "dir (empty)"]);
    }
  }

  await walk(root, "");
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new Map(entries);
}

function kindOf(st: {
  isFIFO(): boolean;
  isSocket(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
}): string {
  if (st.isFIFO()) return "fifo";
  if (st.isSocket()) return "socket";
  if (st.isBlockDevice()) return "block-device";
  if (st.isCharacterDevice()) return "char-device";
  return "unknown";
}

/** Shorten `file 100644 <64 hex>` to `file 100644 <12 hex>…` for readable diffs. */
function short(marker: string): string {
  return marker.replace(/\b([0-9a-f]{12})[0-9a-f]{52}\b/, "$1…");
}

export interface TreeDiff {
  onlyInA: string[];
  onlyInB: string[];
  differs: string[];
  /** True when the two snapshots are identical. */
  equal: boolean;
  /** Human-readable rendering; empty string when equal. */
  text: string;
}

/**
 * Structured comparison of two snapshots. `diffTrees(a, b).text` is what you put in an
 * assertion message; `diffTrees(a, b).equal` is what you assert on.
 */
export function compareTrees(
  a: TreeSnapshot,
  b: TreeSnapshot,
  labels: { a?: string; b?: string } = {},
): TreeDiff {
  const la = labels.a ?? "A";
  const lb = labels.b ?? "B";

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const differs: string[] = [];

  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const k of keys) {
    const va = a.get(k);
    const vb = b.get(k);
    if (va !== undefined && vb === undefined) onlyInA.push(k);
    else if (va === undefined && vb !== undefined) onlyInB.push(k);
    else if (va !== vb) differs.push(k);
  }

  const equal =
    onlyInA.length === 0 && onlyInB.length === 0 && differs.length === 0;

  const lines: string[] = [];
  if (onlyInA.length) {
    lines.push(`only in ${la} (${onlyInA.length}):`);
    for (const k of onlyInA) lines.push(`  - ${k}   [${short(a.get(k)!)}]`);
  }
  if (onlyInB.length) {
    lines.push(`only in ${lb} (${onlyInB.length}):`);
    for (const k of onlyInB) lines.push(`  + ${k}   [${short(b.get(k)!)}]`);
  }
  if (differs.length) {
    lines.push(`differs (${differs.length}):`);
    for (const k of differs) {
      lines.push(`  ~ ${k}`);
      lines.push(`      ${la}: ${short(a.get(k)!)}`);
      lines.push(`      ${lb}: ${short(b.get(k)!)}`);
    }
  }

  return { onlyInA, onlyInB, differs, equal, text: equal ? "" : lines.join("\n") };
}

/** Human-readable diff, or `""` when the trees are identical. */
export function diffTrees(
  a: TreeSnapshot,
  b: TreeSnapshot,
  labels: { a?: string; b?: string } = {},
): string {
  return compareTrees(a, b, labels).text;
}

/** Throws with an actionable diff when the two snapshots differ. */
export function assertTreesEqual(
  a: TreeSnapshot,
  b: TreeSnapshot,
  message = "work-tree snapshots differ",
  labels: { a?: string; b?: string } = {},
): void {
  const d = compareTrees(a, b, labels);
  if (!d.equal) throw new Error(`${message}\n${d.text}`);
}

/** Throws with a diff when the two snapshots are (unexpectedly) identical. */
export function assertTreesDiffer(
  a: TreeSnapshot,
  b: TreeSnapshot,
  message = "expected work-tree snapshots to differ, but they are identical",
): void {
  if (compareTrees(a, b).equal) throw new Error(message);
}

/** Pretty-print a snapshot (sorted `path\tmarker` lines). Handy in failure messages. */
export function formatTree(t: TreeSnapshot): string {
  return [...t.entries()].map(([k, v]) => `${k}\t${short(v)}`).join("\n");
}
