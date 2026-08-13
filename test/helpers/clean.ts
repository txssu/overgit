/**
 * The invisibility oracle.
 *
 * overgit's central claim is that the base repo cannot tell the overlay exists. This file
 * is the test that keeps that claim honest, so it is deliberately paranoid:
 *
 *   1. `git status --porcelain` is empty,
 *   2. `git diff` is empty,
 *   3. `git diff --cached` is empty,
 *   4. a **real** `git add -A` captures nothing. Not `--dry-run` (which is a different
 *      code path and has been wrong before) — an actual add, redirected at a scratch
 *      index (`GIT_INDEX_FILE`) and a scratch object dir (`GIT_OBJECT_DIRECTORY` +
 *      `GIT_ALTERNATE_OBJECT_DIRECTORIES`) so the repo under test is not mutated at all,
 *      not even by a loose blob,
 *   5. `git stash list` is untouched,
 *   6. no merge/rebase/cherry-pick is left in progress.
 *
 * On failure it prints exactly what leaked, plus the skip-worktree list and the managed
 * exclude block, because that is what you need to debug it.
 */

import { mkdtemp, mkdir, rm, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import { runCommand, type CmdResult } from "./exec.ts";
import { HOST_TMPDIR } from "./env.ts";
import { envForPath } from "./registry.ts";
import { compareTrees, snapshotTree } from "./tree.ts";

export interface AssertBaseCleanOptions {
  /**
   * Expected `git stash list` output lines. Default `[]` (no stashes). Pass `"any"` when
   * the test deliberately stashed something.
   */
  stash?: string[] | "any";
  /** Skip the "no operation in progress" check (a test may be mid-merge on purpose). */
  allowInProgress?: boolean;
  /** Extra context prefixed to the failure message. */
  label?: string;
}

async function git(
  repoDir: string,
  args: string[],
  env: Record<string, string>,
): Promise<CmdResult> {
  return runCommand(
    ["git", "-C", repoDir, "-c", "core.quotepath=false", ...args],
    { cwd: repoDir, env },
  );
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Split NUL-delimited git output into non-empty records. */
function splitZ(s: string): string[] {
  return s.split("\0").filter((x) => x.length > 0);
}

/**
 * git's refusal to touch skip-worktree ("sparse") index entries.
 *
 * This is expected, correct behaviour — the base *should* refuse.
 * It is a non-zero exit that captures nothing, so it must never read as a leak.
 */
function isSparsityRefusal(output: string): boolean {
  return /sparse-check|sparsity rules|sparse checkout|outside of your sparse/i.test(
    output,
  );
}

/**
 * Asserts the base repo is pristine from git's point of view.
 *
 * @param repoDir work-tree root of the *base* repo (the one with `.git/`).
 */
export async function assertBaseClean(
  repoDir: string,
  opts: AssertBaseCleanOptions = {},
): Promise<void> {
  const env = envForPath(repoDir);
  const problems: string[] = [];

  const topRes = await git(repoDir, ["rev-parse", "--show-toplevel"], env);
  if (topRes.code !== 0) {
    throw new Error(
      `assertBaseClean: ${repoDir} is not a git work-tree\n  git said: ${topRes.stderr.trim()}`,
    );
  }
  const gitDir = (
    await git(repoDir, ["rev-parse", "--absolute-git-dir"], env)
  ).stdout.trim();

  // 1. status. `-c status.showUntrackedFiles=normal -uall` on purpose: a repo config of
  //    `status.showUntrackedFiles=no` (which belongs on the *overlay*, and which is easy
  //    to set on the base by mistake) would otherwise hide
  //    every overlay-added file from this check.
  const status = await git(
    repoDir,
    ["-c", "status.showUntrackedFiles=normal", "status", "--porcelain", "-uall", "-z"],
    env,
  );
  if (status.code !== 0) {
    problems.push(`git status failed (exit ${status.code}): ${status.stderr.trim()}`);
  } else if (status.stdout.length > 0) {
    problems.push(
      `git status --porcelain is not empty:\n${splitZ(status.stdout)
        .map((l) => `      ${l}`)
        .join("\n")}`,
    );
  }

  // 2. unstaged diff. `-z` so a filename containing a newline still renders correctly.
  const diff = await git(repoDir, ["diff", "--name-status", "-z"], env);
  if (diff.stdout.length > 0) {
    problems.push(`git diff is not empty:\n${renderNameStatusZ(diff.stdout)}`);
  }

  // 3. staged diff
  const cached = await git(
    repoDir,
    ["diff", "--cached", "--name-status", "-z"],
    env,
  );
  if (cached.stdout.length > 0) {
    problems.push(
      `git diff --cached is not empty:\n${renderNameStatusZ(cached.stdout)}`,
    );
  }

  // 4. the real thing: a genuine `git add -A`, against a scratch index + scratch object
  //    store so the repo under test is not mutated at all, not even by a loose blob.
  //
  //    The verdict is *what got captured*, never the exit code. Measured on git 2.55:
  //      - `core.sparseCheckout=true` (the trap): exit 0, and `M C.txt`
  //        IS captured — a real leak behind a successful exit;
  //      - `git add -A -- <overlay-owned path>`: exit 1 ("sparsity rules"), captures
  //        nothing — the documented refusal, and not a leak at all.
  //    So a non-zero exit is only reported when it is *not* that known refusal.
  const scratch = await mkdtemp(join(await scratchParent(env), "overgit-cleancheck-"));
  try {
    const headExists =
      (await git(repoDir, ["rev-parse", "--verify", "-q", "HEAD"], env)).code === 0;

    // `git add -A` with no pathspec: exactly what a user types, and exactly the measured
    // row. `--sparse` is the stronger probe — it explicitly opts into
    // touching skip-worktree entries, so capturing nothing under it proves more.
    const probes: Array<{ label: string; args: string[] }> = [
      { label: "git add -A", args: ["add", "-A"] },
      { label: "git add -A --sparse", args: ["add", "-A", "--sparse"] },
    ];

    for (const [i, probe] of probes.entries()) {
      // Each probe needs a pristine copy of the index; the previous add mutated it.
      const scratchIndex = join(scratch, `index.${i}`);
      const scratchObjects = join(scratch, `objects.${i}`);
      await mkdir(join(scratchObjects, "info"), { recursive: true });
      await mkdir(join(scratchObjects, "pack"), { recursive: true });
      const realIndex = join(gitDir, "index");
      if (await exists(realIndex)) await copyFile(realIndex, scratchIndex);

      const addEnv: Record<string, string> = {
        ...env,
        GIT_INDEX_FILE: scratchIndex,
        GIT_OBJECT_DIRECTORY: scratchObjects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDir, "objects"),
      };

      const add = await git(repoDir, probe.args, addEnv);
      if (add.code !== 0 && !isSparsityRefusal(add.stderr + add.stdout)) {
        problems.push(
          `scratch \`${probe.label}\` failed unexpectedly (exit ${add.code}): ${add.stderr.trim()}`,
        );
      }

      const captured = headExists
        ? await git(
            repoDir,
            ["diff-index", "--cached", "--name-status", "-z", "HEAD"],
            addEnv,
          )
        : // Unborn HEAD: anything at all in the scratch index is a capture.
          await git(repoDir, ["ls-files", "--cached", "-z"], addEnv);

      if (captured.stdout.length > 0) {
        problems.push(
          `a real \`${probe.label}\` would capture overlay-owned content:\n${
            headExists
              ? renderNameStatusZ(captured.stdout)
              : splitZ(captured.stdout)
                  .map((l) => `      ${l}`)
                  .join("\n")
          }`,
        );
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  // 5. stash
  const stash = await git(repoDir, ["stash", "list"], env);
  const stashLines = stash.stdout.split("\n").filter((l) => l.length > 0);
  if (opts.stash !== "any") {
    const want = opts.stash ?? [];
    if (stashLines.length !== want.length) {
      problems.push(
        `git stash list has ${stashLines.length} entr${
          stashLines.length === 1 ? "y" : "ies"
        }, expected ${want.length}:\n${indent(stash.stdout)}`,
      );
    }
  }

  // 6. no interrupted operation
  if (!opts.allowInProgress) {
    for (const marker of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
    ]) {
      if (await exists(join(gitDir, marker))) {
        problems.push(`base repo has an operation in progress: .git/${marker} exists`);
      }
    }
  }

  if (problems.length === 0) return;

  const context = await gatherContext(repoDir, env);
  const head = opts.label ? `assertBaseClean(${opts.label})` : "assertBaseClean";
  throw new Error(
    [
      `${head}: the base repo can see overlay state (${problems.length} problem${
        problems.length === 1 ? "" : "s"
      })`,
      `  repo: ${repoDir}`,
      ...problems.map((p) => `  * ${p}`),
      "",
      context,
    ].join("\n"),
  );
}

/**
 * Render `--name-status -z` output (`M\0path\0`, or `R100\0old\0new\0` for renames).
 * A status token is a letter optionally followed by a similarity score.
 */
function renderNameStatusZ(out: string): string {
  const fields = splitZ(out);
  const lines: string[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i++]!;
    const isRename = /^[RC]\d*$/.test(status);
    const a = fields[i++] ?? "";
    if (isRename) {
      const b = fields[i++] ?? "";
      lines.push(`      ${status}\t${a} -> ${b}`);
    } else {
      lines.push(`      ${status}\t${a}`);
    }
  }
  return lines.join("\n");
}

/* ------------------------------------------------- the `git clean -xfd` survival oracle */

export interface CleanSafeOptions {
  /** Flags passed to `git clean`. Default `["-xfd"]`. */
  flags?: string[];
  /** Extra context prefixed to the failure message. */
  label?: string;
}

export interface CleanSafeResult {
  /** Work-tree paths `git clean` reported removing (relative, POSIX). */
  removed: string[];
  /** The overlay GIT_DIR that was detected, as an absolute path in the throwaway copy. */
  overlayGitDir: string;
  /** Which on-disk layout the overlay uses. */
  layout: "overgit/.git" | "overgit/repo";
  /** Absolute path of the throwaway copy — already deleted when this returns. */
  copyDir: string;
}

/** Candidate overlay GIT_DIRs, newest layout first. Both are tolerated during migration. */
const OVERLAY_GITDIR_CANDIDATES: Array<{
  rel: string[];
  layout: CleanSafeResult["layout"];
}> = [
  { rel: [".overgit", ".git"], layout: "overgit/.git" },
  { rel: [".overgit", "repo"], layout: "overgit/repo" },
];

/**
 * Asserts the overlay survives a **real** `git clean -xfd` in the base.
 *
 * Measured on git 2.55: `git clean -xfd` deletes ignored *directories* wholesale, and
 * `/.overgit/` is ignored. Every other row of the drift matrix is recoverable
 * precisely because the overlay repo still holds the bytes — so if `git clean` can delete
 * `.overgit/`, that recovery story collapses and unpushed work is gone for good.
 *
 * Measured on git 2.55: `git clean` skips `<dir>` only when `<dir>/.git` **resolves to a
 * real repository**. A raw gitdir at `.overgit/repo` with no `.overgit/.git`, a dangling
 * gitfile, a garbage `.git` file and an empty `.git` directory are all deleted.
 *
 * Runs against a throwaway `cp -PRp` copy, so the repo under test is never modified. It
 * asserts three things: `.overgit/` still exists, its bytes are **identical** (including
 * the overlay's own git internals and `local/`), and the overlay repo is still usable
 * (`rev-parse` + `count-objects` both succeed against it).
 *
 * @param repoDir work-tree root of the *base* repo.
 */
export async function assertCleanSafe(
  repoDir: string,
  opts: CleanSafeOptions = {},
): Promise<CleanSafeResult> {
  const env = envForPath(repoDir);
  const flags = opts.flags ?? ["-xfd"];
  const head = opts.label ? `assertCleanSafe(${opts.label})` : "assertCleanSafe";

  if (!(await exists(join(repoDir, ".overgit")))) {
    throw new Error(
      `${head}: ${repoDir} has no .overgit/ directory — there is no overlay to protect.`,
    );
  }

  const scratch = await mkdtemp(join(await scratchParent(env), "overgit-cleansafe-"));
  const copy = join(scratch, "work");
  try {
    // `-P` keeps symlinks as symlinks, `-p` keeps modes and timestamps (so git's index
    // stat-cache still matches and `clean` sees exactly what it would in the original).
    const cp = await runCommand(["cp", "-PRp", repoDir, copy], { cwd: scratch, env });
    if (cp.code !== 0) {
      throw new Error(
        `${head}: could not copy ${repoDir} for the clean probe\n  ${cp.stderr.trim()}`,
      );
    }

    const overlayBefore = await snapshotAll(join(copy, ".overgit"));

    const clean = await runCommand(
      ["git", "-C", copy, "-c", "core.quotepath=false", "clean", ...flags],
      { cwd: copy, env },
    );
    if (clean.code !== 0) {
      throw new Error(
        `${head}: \`git clean ${flags.join(" ")}\` failed (exit ${clean.code})\n  ${clean.stderr.trim()}`,
      );
    }
    const removed = clean.stdout
      .split("\n")
      .filter((l) => l.startsWith("Removing "))
      .map((l) => l.slice("Removing ".length).replace(/\/$/, ""));

    const problems: string[] = [];

    if (!(await exists(join(copy, ".overgit")))) {
      problems.push(
        `\`git clean ${flags.join(" ")}\` DELETED the whole .overgit/ directory — ` +
          `the overlay repo, the manifest and every backup are gone.`,
      );
    } else {
      const overlayAfter = await snapshotAll(join(copy, ".overgit"));
      const diff = compareTrees(overlayBefore, overlayAfter, {
        a: "before clean",
        b: "after clean",
      });
      if (!diff.equal) {
        problems.push(`\`git clean\` changed .overgit/:\n${indentText(diff.text)}`);
      }
    }

    // Usability: the overlay must still be a working repository afterwards.
    let overlayGitDir = "";
    let layout: CleanSafeResult["layout"] = "overgit/.git";
    if (problems.length === 0) {
      let found = false;
      for (const cand of OVERLAY_GITDIR_CANDIDATES) {
        const abs = join(copy, ...cand.rel);
        if (!(await exists(abs))) continue;
        const rp = await runCommand(
          ["git", `--git-dir=${abs}`, "rev-parse", "--git-dir"],
          { cwd: copy, env },
        );
        const co = await runCommand(
          ["git", `--git-dir=${abs}`, "count-objects", "-v"],
          { cwd: copy, env },
        );
        if (rp.code === 0 && co.code === 0) {
          overlayGitDir = abs;
          layout = cand.layout;
          found = true;
          break;
        }
        problems.push(
          `.overgit/${cand.rel.slice(1).join("/")} exists but is not a usable repository ` +
            `after clean: ${(rp.stderr || co.stderr).trim()}`,
        );
        found = true;
        break;
      }
      if (!found) {
        problems.push(
          "no overlay GIT_DIR found after clean (looked for .overgit/.git and .overgit/repo)",
        );
      }
    }

    if (problems.length > 0) {
      throw new Error(
        [
          `${head}: the overlay does not survive \`git clean ${flags.join(" ")}\` (${problems.length} problem${
            problems.length === 1 ? "" : "s"
          })`,
          `  repo: ${repoDir}`,
          ...problems.map((p) => `  * ${p}`),
          "",
          `  git clean removed: ${removed.length ? removed.join(", ") : "(nothing)"}`,
          "",
          "  `git clean` skips a directory only when `<dir>/.git` resolves",
          "  to a real repository. Put the overlay GIT_DIR at `.overgit/.git` (a real repo,",
          "  or a gitfile whose target exists). A raw `.overgit/repo` with no `.overgit/.git`,",
          "  a dangling gitfile, or an empty `.git` directory are all deleted wholesale.",
        ].join("\n"),
      );
    }

    return { removed, overlayGitDir, layout, copyDir: copy };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Snapshot everything, with no exclusions — overlay git internals included. */
function snapshotAll(dir: string) {
  return snapshotTree(dir, { exclude: [], excludeNames: [] });
}

function indentText(s: string): string {
  return s
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");
}

function indent(s: string): string {
  return s
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");
}

/**
 * Where the scratch index/object store goes.
 *
 * Prefers the owning sandbox's own tmp dir (alive for as long as the repo under test is),
 * and falls back to the host tmp dir captured at module load. Never `os.tmpdir()` at call
 * time and never cached: `process.env.TMPDIR` may have been pointed at a sandbox that is
 * since deleted, which would make every later call fail with ENOENT.
 */
async function scratchParent(env: Record<string, string>): Promise<string> {
  const dir = env.TMPDIR ?? HOST_TMPDIR;
  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch {
    await mkdir(HOST_TMPDIR, { recursive: true });
    return HOST_TMPDIR;
  }
}

/** State dump appended to every failure: it is always the next thing you want to see. */
async function gatherContext(
  repoDir: string,
  env: Record<string, string>,
): Promise<string> {
  const lines: string[] = ["  --- base repo state ---"];

  // `S` = skip-worktree; a lowercase tag = assume-unchanged. Both are worth seeing.
  const lsFiles = await git(repoDir, ["ls-files", "-v"], env);
  const skipped = lsFiles.stdout
    .split("\n")
    .filter((l) => /^[Ssa-z] /.test(l))
    .map((l) => `      ${l}`);
  lines.push(
    skipped.length
      ? `    skip-worktree / assume-unchanged entries:\n${skipped.join("\n")}`
      : "    skip-worktree entries: (none)",
  );

  const gitDir = (
    await git(repoDir, ["rev-parse", "--absolute-git-dir"], env)
  ).stdout.trim();
  const excludePath = join(gitDir, "info", "exclude");
  if (await exists(excludePath)) {
    const text = await Bun.file(excludePath).text();
    const body = text
      .split("\n")
      .filter((l) => l.trim().length > 0 && !l.startsWith("#"))
      .map((l) => `      ${l}`);
    lines.push(
      body.length
        ? `    .git/info/exclude (non-comment lines):\n${body.join("\n")}`
        : "    .git/info/exclude: (no active lines)",
    );
  } else {
    lines.push("    .git/info/exclude: (absent)");
  }

  const untrackedAll = await git(
    repoDir,
    ["status", "--porcelain", "--ignored", "-z"],
    env,
  );
  const rows = splitZ(untrackedAll.stdout);
  lines.push(
    rows.length
      ? `    git status --porcelain --ignored:\n${rows.map((l) => `      ${l}`).join("\n")}`
      : "    git status --porcelain --ignored: (empty)",
  );

  return lines.join("\n");
}
