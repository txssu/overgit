/**
 * Filesystem probes the engines share.
 *
 * Everything here is `lstat`-based: a symlink is overlay content in its own right, so a
 * probe that followed one would answer a question nobody asked. Nothing in this module
 * knows what a manifest or an overlay is — `ownership.ts` and `doctor.ts` read work-tree
 * entries with their own error policies on top of these types.
 */

import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";

import { OvergitError } from "./errors.ts";

export type FileKind = "absent" | "file" | "symlink" | "dir" | "other";

export interface WorktreeState {
  kind: FileKind;
  /** Git mode implied by the work-tree entry, or `null` when there is no file. */
  mode: "100644" | "100755" | "120000" | null;
  /** File bytes, or the symlink target's bytes. `null` for absent/dir/other. */
  content: Uint8Array | null;
}

/**
 * Write a file by renaming a sibling temp file over it, so a reader never sees a partial
 * one and a killed run leaves either the old bytes or the new ones.
 *
 * For overgit's own metadata only. Work-tree content goes through `materialise` in
 * `ownership.ts`, which also has to build symlinks and apply git's exec-bit rules.
 */
export async function writeFileAtomic(
  path: string,
  content: Uint8Array | string,
  opts: { hint?: string; mode?: number } = {},
): Promise<void> {
  const tmp = `${path}.overgit-tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(tmp, content);
    if (opts.mode !== undefined) await fs.chmod(tmp, opts.mode);
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new OvergitError("IO_FAILED", `cannot write ${path}: ${(e as Error).message}`, {
      hint: opts.hint ?? "check that the directory exists and is writable",
      paths: [path],
      cause: e,
    });
  }
}

/** True when anything at all is at `p`, including a dangling symlink. */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function entryKind(abs: string): Promise<FileKind> {
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

/**
 * Remove the directories a path leaves behind, innermost first, and report which went.
 *
 * git cannot represent an empty directory, so after whiting out everything under `docs/`
 * the merged view should have no `docs/` at all — an empty husk would make the tree differ
 * from what a fresh `overgit clone` produces, and break the round-trip. `rmdir` refuses a
 * non-empty directory, so this can never touch anything still in use, including untracked
 * files the user put there. `.overgit/` is never descended into: it is overlay storage,
 * not work-tree content.
 */
export async function pruneEmptyParents(root: string, repoPath: string): Promise<string[]> {
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
