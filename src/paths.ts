/**
 * Path normalisation and the security boundary.
 *
 * Everything a user types on the command line goes through `toRepoPath` before any module
 * is allowed to act on it. The invariants it enforces:
 *
 *  - the result is a repo-relative POSIX path with no leading `./`, no trailing `/`, no
 *    `.`/`..` segments and never absolute;
 *  - the target is inside the work-tree *after resolving symlinked ancestors*, so
 *    `link-to-elsewhere/passwd` cannot be used to escape;
 *  - the leaf is **not** dereferenced — a symlink is legitimate overlay content;
 *  - `.git` and `.overgit` (and anything under them) are refused outright.
 */

import { realpathSync } from "node:fs";
import * as nodePath from "node:path";
import { OvergitError } from "./errors.ts";

const SEP = nodePath.sep;

/** Segments overgit refuses to own, matched case-insensitively. */
const RESERVED_ROOT_SEGMENTS = new Set([".git", ".overgit"]);

function toPosix(p: string): string {
  return SEP === "/" ? p : p.split(SEP).join("/");
}

/** True when `childAbs` is strictly below `parentAbs`. Equal paths are **not** inside. */
export function isPathInside(parentAbs: string, childAbs: string): boolean {
  const parent = nodePath.resolve(parentAbs);
  const child = nodePath.resolve(childAbs);
  if (parent === child) return false;
  const rel = nodePath.relative(parent, child);
  if (rel === "") return false;
  if (nodePath.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${SEP}`);
}

/** True for `.git`, `.git/**`, `.overgit`, `.overgit/**` (case-insensitive leading segment). */
export function isReservedPath(repoPath: string): boolean {
  const first = repoPath.split("/")[0] ?? "";
  return RESERVED_ROOT_SEGMENTS.has(first.toLowerCase());
}

/**
 * Throws when `repoPath` is not a shape overgit may own.
 *
 * Beyond the obvious (`.git`, `.overgit`, escaping the work-tree) this also rejects:
 *  - a `.git` segment *anywhere* in the path (a nested repo or submodule's internals), and
 *  - a NUL byte, which is not merely invalid but actively dangerous: `git.ts` feeds paths
 *    to `update-index --stdin -z` and `add --pathspec-file-nul`, where NUL is the record
 *    separator. Without this check `setSkipWorktree(["a.txt\0b.txt"])` silently flags *two*
 *    files, one of which the caller never named. Verified before the fix.
 *
 * Other C0 control bytes (tab, newline, CR, …) are deliberately **allowed**: real repos
 * contain such names, every git call in this codebase is NUL-delimited, and they are
 * covered by tests. NUL is the one byte that cannot appear in a POSIX filename at all, so
 * seeing one always means something synthesised it.
 */
export function assertSafeRepoPath(repoPath: string): void {
  if (repoPath === "") {
    throw new OvergitError("PATH_FORBIDDEN", "empty path", {
      hint: "name a file inside the repository",
    });
  }
  if (repoPath.includes("\0")) {
    throw new OvergitError(
      "PATH_FORBIDDEN",
      `${JSON.stringify(repoPath)}: path contains a NUL byte`,
      {
        paths: [repoPath],
        hint: "a NUL cannot occur in a filename; this path did not come from the filesystem",
      },
    );
  }
  if (repoPath.startsWith("/")) {
    throw new OvergitError(
      "PATH_OUTSIDE_WORKTREE",
      `${repoPath}: absolute paths are not repository paths`,
      { paths: [repoPath] },
    );
  }
  if (repoPath.endsWith("/")) {
    throw new OvergitError("PATH_FORBIDDEN", `${repoPath}: trailing slash`, { paths: [repoPath] });
  }
  if (isReservedPath(repoPath)) {
    throw new OvergitError("PATH_FORBIDDEN", `${repoPath}: overgit's own state is off limits`, {
      paths: [repoPath],
      hint: "overgit never manages .git or .overgit",
    });
  }
  const segments = repoPath.split("/");
  for (const seg of segments) {
    if (seg === "") {
      throw new OvergitError("PATH_FORBIDDEN", `${repoPath}: empty path segment`, {
        paths: [repoPath],
      });
    }
    if (seg === ".") {
      throw new OvergitError("PATH_FORBIDDEN", `${repoPath}: '.' path segment`, {
        paths: [repoPath],
      });
    }
    if (seg === "..") {
      throw new OvergitError(
        "PATH_OUTSIDE_WORKTREE",
        `${repoPath}: '..' escapes the work-tree`,
        { paths: [repoPath] },
      );
    }
    if (seg.toLowerCase() === ".git") {
      throw new OvergitError(
        "PATH_FORBIDDEN",
        `${repoPath}: paths under a git directory are off limits`,
        { paths: [repoPath], hint: "overgit never manages repository internals" },
      );
    }
  }
}

/**
 * Resolve `input` the way the kernel does: one segment at a time, following symlinks on
 * every component *except the leaf*, and interpreting `..` against the already-resolved
 * path rather than collapsing it lexically.
 *
 * `path.resolve` collapses `..` textually, which diverges from the filesystem whenever a
 * symlink is involved. With `sub/backlink -> <root>`, `sub/backlink/../../etc/passwd`
 * collapses to `<root>/etc/passwd` — a real file inside the repo that the user never
 * named — where the kernel walks two levels *above* `<root>`. Silently acting on the wrong
 * in-root file is the bug; the escape itself was still caught by the containment check.
 *
 * The leaf is never dereferenced: a symlink is legitimate overlay content, and git tracks
 * the link itself rather than its target.
 */
function resolveLikeKernel(startDir: string, input: string): string {
  // Dropping "" and "." here means a trailing slash cannot promote the leaf into an
  // intermediate component, so `foo/` and `foo` resolve identically.
  const segments = input.split("/").filter((s) => s !== "" && s !== ".");
  let cur = nodePath.isAbsolute(input) ? nodePath.parse(nodePath.resolve(input)).root : startDir;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === "..") {
      // `cur` is already fully resolved at this point, so its parent is the real parent.
      cur = nodePath.dirname(safeRealpath(cur));
      continue;
    }
    cur = nodePath.join(cur, seg);
    if (i < segments.length - 1) cur = safeRealpath(cur);
  }
  return cur;
}

/**
 * Normalise a user-supplied path (relative to `cwd`) into a repo-relative POSIX path.
 *
 * Throws `PATH_OUTSIDE_WORKTREE` when the target is not under `root` and `PATH_FORBIDDEN`
 * for `.git` / `.overgit` and other unusable shapes.
 *
 * Trailing slashes are normalised away, so `foo/` returns `"foo"`. That is why
 * `assertSafeRepoPath`'s trailing-slash rejection is unreachable *from here* — the two have
 * different jobs. `toRepoPath` accepts what a user may reasonably type (tab-completing a
 * directory yields `foo/`); `assertSafeRepoPath` validates an already-canonical repo path,
 * such as a manifest key, where a trailing slash is genuinely malformed.
 *
 * The leaf is not `stat`ed: this deliberately succeeds for paths that do not exist yet, and
 * for directories. Deciding whether a directory is acceptable belongs to the caller
 * (`NOT_A_FILE` is theirs to raise), because `overgit add somedir` and `overgit add newfile`
 * are both legitimate.
 */
export function toRepoPath(root: string, cwd: string, input: string): string {
  if (input === "") {
    throw new OvergitError("PATH_FORBIDDEN", "empty path", {
      hint: "name a file inside the repository",
    });
  }
  if (input.includes("\0")) {
    throw new OvergitError("PATH_FORBIDDEN", `${JSON.stringify(input)}: path contains a NUL byte`, {
      paths: [input],
    });
  }

  const rootReal = safeRealpath(root);
  const abs = nodePath.isAbsolute(input)
    ? nodePath.resolve(input)
    : nodePath.resolve(cwd, input);

  const targetReal = resolveLikeKernel(safeRealpath(cwd), input);

  if (targetReal === rootReal || abs === rootReal) {
    throw new OvergitError(
      "PATH_FORBIDDEN",
      `${input}: that is the repository root, not a file in it`,
      { paths: [input] },
    );
  }
  if (!isPathInside(rootReal, targetReal)) {
    throw new OvergitError(
      "PATH_OUTSIDE_WORKTREE",
      `${input}: outside the work-tree (${rootReal})`,
      { paths: [input], hint: "overgit only manages files inside the base repository" },
    );
  }

  const rel = toPosix(nodePath.relative(rootReal, targetReal));
  assertSafeRepoPath(rel);
  return rel;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return nodePath.resolve(p);
  }
}

/**
 * Characters that are special in a gitignore pattern and must be backslash-escaped.
 * `#` and `!` only matter at the start of a line and our patterns always start with `/`,
 * but escaping them unconditionally is harmless and keeps the rule simple.
 * A space must be escaped or git strips it when it is trailing (measured).
 */
const GITIGNORE_SPECIAL = new Set(["\\", "*", "?", "[", "]", "#", "!", " "]);

/**
 * True when `gitignoreEscape` cannot express this path exactly.
 *
 * A gitignore line cannot contain a literal newline, and git strips a trailing CR from
 * every pattern line (CRLF tolerance) even when backslash-escaped. Both are therefore
 * emitted as `?`, which matches any single byte — so the pattern also matches *sibling*
 * files whose names differ only at that position.
 *
 * That is not cosmetic. An `add` path's pattern goes into the base's `.git/info/exclude`,
 * which makes every matching file ignored — and a base-side `git clean -xfd` deletes
 * ignored files. An over-broad pattern therefore lets overgit cause the deletion of a file
 * it was never pointed at. Callers that are about to write an exclude line must refuse
 * first: `assertExcludable` in `ownership.ts` is the one that does, on the `add` path.
 */
export function gitignorePatternIsApproximate(repoPath: string): boolean {
  return repoPath.includes("\n") || repoPath.endsWith("\r");
}

/** Escape a repo-relative path into an anchored gitignore pattern (leading `/`). */
export function gitignoreEscape(repoPath: string): string {
  let out = "/";
  for (let i = 0; i < repoPath.length; i++) {
    const ch = repoPath[i]!;
    if (ch === "\n" || (ch === "\r" && i === repoPath.length - 1)) {
      out += "?";
      continue;
    }
    if (GITIGNORE_SPECIAL.has(ch) || ch.charCodeAt(0) < 0x20) {
      out += `\\${ch}`;
      continue;
    }
    out += ch;
  }
  return out;
}
