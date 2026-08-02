import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isOvergitError, type ErrorCode } from "../src/errors.ts";
import {
  assertSafeRepoPath,
  gitignoreEscape,
  gitignorePatternIsApproximate,
  isPathInside,
  isReservedPath,
  toRepoPath,
} from "../src/paths.ts";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

/** Captured at module load — the shared harness repoints TMPDIR at a sandbox it deletes. */
const HOST_TMP = realpathSync(tmpdir());

async function sh(cwd: string, cmd: string[]): Promise<{ stdout: string; code: number }> {
  const p = Bun.spawn({
    cmd,
    cwd,
    env: { ...process.env } as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { stdout, code };
}

function expectCode(fn: () => unknown, code: ErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  if (!isOvergitError(caught)) {
    throw new Error(`expected OvergitError(${code}), got ${String(caught)}`);
  }
  expect(caught.code).toBe(code);
}

let root: string;
let repo: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(HOST_TMP, "overgit-paths-test-")));
  repo = join(root, "repo");
  await mkdir(join(repo, "src", "deep"), { recursive: true });
  await mkdir(join(repo, "dir with space"), { recursive: true });
  await writeFile(join(repo, "src", "deep", "f.txt"), "x\n");
  await writeFile(join(repo, "top.txt"), "x\n");
  await writeFile(join(repo, "dir with space", "f.txt"), "x\n");

  // Outside the repo, plus symlinks that try to sneak in and out.
  await mkdir(join(root, "outside"), { recursive: true });
  await writeFile(join(root, "outside", "secret.txt"), "s\n");
  await symlink(join(root, "outside"), join(repo, "escape-dir"));
  await symlink(join(root, "outside", "secret.txt"), join(repo, "escape-file"));
  await symlink(join(repo, "top.txt"), join(repo, "inside-link"));
  await symlink(join(repo, "src"), join(root, "into-repo"));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("isPathInside", () => {
  test("basics", () => {
    expect(isPathInside("/a", "/a/b")).toBe(true);
    expect(isPathInside("/a", "/a/b/c")).toBe(true);
    expect(isPathInside("/a", "/a")).toBe(false);
    expect(isPathInside("/a", "/ab")).toBe(false);
    expect(isPathInside("/a/b", "/a")).toBe(false);
    expect(isPathInside("/a", "/b")).toBe(false);
    expect(isPathInside("/a/", "/a/b/")).toBe(true);
  });
});

describe("isReservedPath", () => {
  test("leading segment only, case-insensitive", () => {
    expect(isReservedPath(".git")).toBe(true);
    expect(isReservedPath(".git/config")).toBe(true);
    expect(isReservedPath(".GIT/config")).toBe(true);
    expect(isReservedPath(".overgit")).toBe(true);
    expect(isReservedPath(".Overgit/manifest.json")).toBe(true);
    expect(isReservedPath(".gitignore")).toBe(false);
    expect(isReservedPath(".github/workflows/ci.yml")).toBe(false);
    expect(isReservedPath("src/.git")).toBe(false);
    expect(isReservedPath("normal.txt")).toBe(false);
  });
});

describe("assertSafeRepoPath", () => {
  test("accepts ordinary and awkward paths", () => {
    for (const p of [
      "a.txt",
      "src/deep/f.txt",
      "dir with space/f.txt",
      'weird "na[m]e#!.txt',
      "nl\nname.txt",
      ".gitignore",
      ".github/workflows/ci.yml",
      "..hidden.txt",
      "a..b/c.txt",
    ]) {
      expect(() => assertSafeRepoPath(p)).not.toThrow();
    }
  });

  test("rejects the reserved trees", () => {
    expectCode(() => assertSafeRepoPath(".git"), "PATH_FORBIDDEN");
    expectCode(() => assertSafeRepoPath(".git/config"), "PATH_FORBIDDEN");
    expectCode(() => assertSafeRepoPath(".GIT/hooks/pre-commit"), "PATH_FORBIDDEN");
    expectCode(() => assertSafeRepoPath(".overgit"), "PATH_FORBIDDEN");
    expectCode(() => assertSafeRepoPath(".overgit/manifest.json"), "PATH_FORBIDDEN");
    // A nested repository's internals are equally off limits.
    expectCode(() => assertSafeRepoPath("vendor/lib/.git/config"), "PATH_FORBIDDEN");
  });

  test("rejects malformed shapes", () => {
    expectCode(() => assertSafeRepoPath(""), "PATH_FORBIDDEN");
    expectCode(() => assertSafeRepoPath("a//b"), "PATH_FORBIDDEN");
    expectCode(() => assertSafeRepoPath("./a"), "PATH_FORBIDDEN");
    expectCode(() => assertSafeRepoPath("a/"), "PATH_FORBIDDEN");
    expectCode(() => assertSafeRepoPath("."), "PATH_FORBIDDEN");
    expectCode(() => assertSafeRepoPath("/etc/passwd"), "PATH_OUTSIDE_WORKTREE");
    expectCode(() => assertSafeRepoPath("../x"), "PATH_OUTSIDE_WORKTREE");
    expectCode(() => assertSafeRepoPath("a/../../x"), "PATH_OUTSIDE_WORKTREE");
  });

  test("errors name the offending path", () => {
    try {
      assertSafeRepoPath(".git/config");
    } catch (e) {
      expect(isOvergitError(e) && e.message).toContain(".git/config");
      expect(isOvergitError(e) && e.paths).toEqual([".git/config"]);
    }
  });
});

describe("toRepoPath", () => {
  test("relative input from the root", () => {
    expect(toRepoPath(repo, repo, "top.txt")).toBe("top.txt");
    expect(toRepoPath(repo, repo, "./top.txt")).toBe("top.txt");
    expect(toRepoPath(repo, repo, "src/deep/f.txt")).toBe("src/deep/f.txt");
    expect(toRepoPath(repo, repo, "src/../top.txt")).toBe("top.txt");
    expect(toRepoPath(repo, repo, "dir with space/f.txt")).toBe("dir with space/f.txt");
  });

  test("relative input from a subdirectory", () => {
    const cwd = join(repo, "src", "deep");
    expect(toRepoPath(repo, cwd, "f.txt")).toBe("src/deep/f.txt");
    expect(toRepoPath(repo, cwd, "../../top.txt")).toBe("top.txt");
    expect(toRepoPath(repo, cwd, "./new-file.txt")).toBe("src/deep/new-file.txt");
  });

  test("absolute input inside the root", () => {
    expect(toRepoPath(repo, repo, join(repo, "top.txt"))).toBe("top.txt");
    expect(toRepoPath(repo, join(root, "outside"), join(repo, "src/deep/f.txt"))).toBe(
      "src/deep/f.txt",
    );
  });

  test("trailing slashes and redundant separators normalise away", () => {
    expect(toRepoPath(repo, repo, "src/deep/")).toBe("src/deep");
    expect(toRepoPath(repo, repo, "src//deep//f.txt")).toBe("src/deep/f.txt");
  });

  test("paths that do not exist yet are fine", () => {
    expect(toRepoPath(repo, repo, "brand/new/nested/file.txt")).toBe("brand/new/nested/file.txt");
  });

  test("weird names round-trip", () => {
    for (const name of ['weird "na[m]e#!.txt', "nl\nname.txt", "star*.txt", "back\\slash.txt"]) {
      expect(toRepoPath(repo, repo, name)).toBe(name);
      expect(toRepoPath(repo, repo, join(repo, name))).toBe(name);
    }
  });

  test("rejects the empty string, `.` and the root itself", () => {
    expectCode(() => toRepoPath(repo, repo, ""), "PATH_FORBIDDEN");
    expectCode(() => toRepoPath(repo, repo, "."), "PATH_FORBIDDEN");
    expectCode(() => toRepoPath(repo, repo, "./"), "PATH_FORBIDDEN");
    expectCode(() => toRepoPath(repo, repo, repo), "PATH_FORBIDDEN");
  });

  test("rejects `..` escapes and absolute paths outside the root", () => {
    expectCode(() => toRepoPath(repo, repo, "../outside/secret.txt"), "PATH_OUTSIDE_WORKTREE");
    expectCode(() => toRepoPath(repo, repo, "src/../../outside"), "PATH_OUTSIDE_WORKTREE");
    expectCode(() => toRepoPath(repo, repo, "/etc/passwd"), "PATH_OUTSIDE_WORKTREE");
    expectCode(
      () => toRepoPath(repo, repo, join(root, "outside", "secret.txt")),
      "PATH_OUTSIDE_WORKTREE",
    );
  });

  test("rejects the reserved trees however they are spelled", () => {
    expectCode(() => toRepoPath(repo, repo, ".git"), "PATH_FORBIDDEN");
    expectCode(() => toRepoPath(repo, repo, ".git/config"), "PATH_FORBIDDEN");
    expectCode(() => toRepoPath(repo, repo, "src/../.git/config"), "PATH_FORBIDDEN");
    expectCode(() => toRepoPath(repo, repo, join(repo, ".git", "config")), "PATH_FORBIDDEN");
    expectCode(() => toRepoPath(repo, repo, ".overgit/manifest.json"), "PATH_FORBIDDEN");
    expectCode(
      () => toRepoPath(repo, join(repo, "src"), "../.overgit/repo/HEAD"),
      "PATH_FORBIDDEN",
    );
  });

  test("a symlinked ancestor cannot be used to escape", () => {
    // escape-dir -> <root>/outside
    expectCode(() => toRepoPath(repo, repo, "escape-dir/secret.txt"), "PATH_OUTSIDE_WORKTREE");
    expectCode(
      () => toRepoPath(repo, join(repo, "escape-dir"), "secret.txt"),
      "PATH_OUTSIDE_WORKTREE",
    );
  });

  test("a symlinked leaf is content, not a redirect", () => {
    // escape-file -> <root>/outside/secret.txt, but the *link* lives in the repo.
    expect(toRepoPath(repo, repo, "escape-file")).toBe("escape-file");
    expect(toRepoPath(repo, repo, "inside-link")).toBe("inside-link");
  });

  test("a symlink pointing into the repo resolves to the real repo path", () => {
    // <root>/into-repo -> <repo>/src
    expect(toRepoPath(repo, root, "into-repo/deep/f.txt")).toBe("src/deep/f.txt");
  });

  test("a symlinked root is handled", async () => {
    const linkedRoot = join(root, "linked-repo");
    await symlink(repo, linkedRoot);
    expect(toRepoPath(repo, linkedRoot, "top.txt")).toBe("top.txt");
    expect(toRepoPath(repo, repo, join(linkedRoot, "top.txt"))).toBe("top.txt");
  });
});

describe("gitignoreEscape", () => {
  const NAMES = [
    "normal.txt",
    'weird "na[m]e#!.txt',
    "sp ace.txt",
    "trailing space .txt",
    "trailing-space-end ",
    " leading-space.txt",
    "#hash.txt",
    "!bang.txt",
    "star*.txt",
    "question?.txt",
    "back\\slash.txt",
    "brack[et].txt",
    "close]brack.txt",
    "a**b.txt",
    "tab\there.txt",
    "dollar$.txt",
    "quote'.txt",
    "semi;colon.txt",
    "unié中.txt",
    "dots...txt",
    "ends.with.dot.",
    "ctrl\x01char.txt",
    "endbackslash\\",
    "dir with space/nested#!.txt",
    "dir with space/star*.txt",
    "deep/[a]/!x/#y/z.txt",
    "nl\nname.txt",
    "dir\nwith\nnl/inner.txt",
    "endcr\r",
  ];

  test("shape", () => {
    expect(gitignoreEscape("a.txt")).toBe("/a.txt");
    expect(gitignoreEscape("src/a.txt")).toBe("/src/a.txt");
    expect(gitignoreEscape("star*.txt")).toBe("/star\\*.txt");
    expect(gitignoreEscape("a b.txt")).toBe("/a\\ b.txt");
    expect(gitignoreEscape("#a.txt")).toBe("/\\#a.txt");
    expect(gitignoreEscape("nl\nname.txt")).toBe("/nl?name.txt");
  });

  test("approximation flag", () => {
    expect(gitignorePatternIsApproximate("a.txt")).toBe(false);
    expect(gitignorePatternIsApproximate("star*.txt")).toBe(false);
    expect(gitignorePatternIsApproximate("nl\nname.txt")).toBe(true);
    expect(gitignorePatternIsApproximate("endcr\r")).toBe(true);
    expect(gitignorePatternIsApproximate("mid\rcr.txt")).toBe(false);
  });

  /**
   * The only verification that counts: write the patterns into a real repo's
   * `.git/info/exclude` and confirm git reports nothing untracked.
   */
  test("real git ignores every generated pattern", async () => {
    const ig = join(root, "ignore-repo");
    await mkdir(ig, { recursive: true });
    await sh(ig, ["git", "init", "-q", "-b", "main", "."]);

    for (const name of NAMES) {
      const d = dirname(name);
      if (d !== ".") await mkdir(join(ig, d), { recursive: true });
      await writeFile(join(ig, name), "x\n");
    }

    // Sanity: without the exclude file git must see all of them.
    const before = await sh(ig, [
      "git",
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all",
    ]);
    expect(before.stdout.length).toBeGreaterThan(0);

    await mkdir(join(ig, ".git", "info"), { recursive: true });
    await writeFile(
      join(ig, ".git", "info", "exclude"),
      NAMES.map((n) => gitignoreEscape(n)).join("\n") + "\n",
    );

    const after = await sh(ig, ["git", "status", "--porcelain", "-z", "--untracked-files=all"]);
    const leftover = after.stdout.split("\0").filter((s) => s.length > 0);
    expect(leftover).toEqual([]);

    // And each pattern matches its own file specifically.
    for (const name of NAMES) {
      const r = await sh(ig, ["git", "check-ignore", "-q", "--", name]);
      expect([name, r.code]).toEqual([name, 0]);
    }
  });

  test("an exact pattern does not over-match a sibling", async () => {
    const ig = join(root, "exact-repo");
    await mkdir(ig, { recursive: true });
    await sh(ig, ["git", "init", "-q", "-b", "main", "."]);
    await writeFile(join(ig, "star*.txt"), "x\n");
    await writeFile(join(ig, "starX.txt"), "x\n");
    await mkdir(join(ig, ".git", "info"), { recursive: true });
    await writeFile(join(ig, ".git", "info", "exclude"), gitignoreEscape("star*.txt") + "\n");

    expect((await sh(ig, ["git", "check-ignore", "-q", "--", "star*.txt"])).code).toBe(0);
    expect((await sh(ig, ["git", "check-ignore", "-q", "--", "starX.txt"])).code).toBe(1);
  });

  test("the anchor keeps a same-named file in a subdirectory visible", async () => {
    const ig = join(root, "anchor-repo");
    await mkdir(join(ig, "sub"), { recursive: true });
    await sh(ig, ["git", "init", "-q", "-b", "main", "."]);
    await writeFile(join(ig, "a.txt"), "x\n");
    await writeFile(join(ig, "sub", "a.txt"), "x\n");
    await mkdir(join(ig, ".git", "info"), { recursive: true });
    await writeFile(join(ig, ".git", "info", "exclude"), gitignoreEscape("a.txt") + "\n");

    expect((await sh(ig, ["git", "check-ignore", "-q", "--", "a.txt"])).code).toBe(0);
    expect((await sh(ig, ["git", "check-ignore", "-q", "--", "sub/a.txt"])).code).toBe(1);
  });
});
