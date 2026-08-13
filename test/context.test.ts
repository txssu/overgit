import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  symlink,
  realpath,
  access,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOvergitError, type ErrorCode } from "../src/errors.ts";
import { discover, withLock, type Context } from "../src/context.ts";

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

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await sh(dir, ["git", "init", "-q", "-b", "main", "."]);
  await sh(dir, ["git", "config", "user.name", "overgit test"]);
  await sh(dir, ["git", "config", "user.email", "test@overgit.invalid"]);
  await sh(dir, ["git", "config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "seed.txt"), "seed\n");
  await sh(dir, ["git", "add", "-A"]);
  await sh(dir, ["git", "commit", "-qm", "seed"]);
}

/**
 * Build an overlay exactly the way bootstrap will: a real git dir at `<root>/.overgit/.git`
 * with `core.worktree=../..`, which is what makes `git clean -xfd` skip it and what creates
 * the discovery hazard these tests pin down.
 */
async function makeOverlay(repoRoot: string): Promise<string> {
  const gitDir = join(repoRoot, ".overgit", ".git");
  await mkdir(join(repoRoot, ".overgit"), { recursive: true });
  await sh(repoRoot, ["git", "init", "-q", "--bare", gitDir]);
  await sh(repoRoot, ["git", "--git-dir", gitDir, "config", "core.bare", "false"]);
  await sh(repoRoot, ["git", "--git-dir", gitDir, "config", "core.worktree", "../.."]);
  return gitDir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function expectCode(fn: () => Promise<unknown>, code: ErrorCode): Promise<void> {
  let caught: unknown;
  try {
    await fn();
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
  root = await realpath(await mkdtemp(join(HOST_TMP, "overgit-ctx-test-")));
  repo = join(root, "base");
  await initRepo(repo);
  await mkdir(join(repo, "src", "deep"), { recursive: true });
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("discover", () => {
  test("from the root", async () => {
    const ctx = await discover(repo);
    expect(ctx.root).toBe(repo);
    expect(ctx.cwd).toBe(repo);
    expect(ctx.baseGitDir).toBe(join(repo, ".git"));
    expect(ctx.baseWorktreeGitDir).toBe(join(repo, ".git"));
    expect(ctx.overgitDir).toBe(join(repo, ".overgit"));
    expect(ctx.overlayGitDir).toBe(join(repo, ".overgit", ".git"));
    expect(ctx.localDir).toBe(join(repo, ".overgit", "local"));
    expect(ctx.manifestPath).toBe(join(repo, ".overgit", "manifest.json"));
    expect(ctx.hasOverlay).toBe(false);
    expect(await ctx.base.toplevel()).toBe(repo);
  });

  test("walks up from a subdirectory", async () => {
    const ctx = await discover(join(repo, "src", "deep"));
    expect(ctx.root).toBe(repo);
    expect(ctx.cwd).toBe(join(repo, "src", "deep"));
    expect(ctx.baseGitDir).toBe(join(repo, ".git"));
  });

  test("resolves a symlinked cwd to the real root", async () => {
    const linked = join(root, "linked-base");
    await symlink(repo, linked);
    const ctx = await discover(join(linked, "src"));
    expect(ctx.root).toBe(repo);
    expect(ctx.cwd).toBe(join(repo, "src"));
  });

  test("refuses outside a repository", async () => {
    const bare = join(root, "not-a-repo");
    await mkdir(bare, { recursive: true });
    await expectCode(() => discover(bare), "NOT_IN_BASE_REPO");
  });

  test("refuses inside the git directory", async () => {
    await expectCode(() => discover(join(repo, ".git")), "INSIDE_GIT_DIR");
    await mkdir(join(repo, ".git", "info"), { recursive: true });
    await expectCode(() => discover(join(repo, ".git", "info")), "INSIDE_GIT_DIR");
  });

  test("refuses a bare repository", async () => {
    const bare = join(root, "bare.git");
    await mkdir(bare, { recursive: true });
    await sh(bare, ["git", "init", "-q", "--bare", "."]);
    await expectCode(() => discover(bare), "NOT_IN_BASE_REPO");
  });

  test("refuses a nonexistent cwd", async () => {
    await expectCode(() => discover(join(root, "nope", "nope")), "IO_FAILED");
  });

  test("linked worktree: baseGitDir is the common dir where info/exclude lives", async () => {
    const wt = join(root, "worktree");
    await sh(repo, ["git", "worktree", "add", "-q", "-b", "wtb", wt]);
    const ctx = await discover(wt);
    expect(ctx.root).toBe(wt);
    // info/exclude is read from the *main* repo's .git, so that is what baseGitDir must be.
    expect(ctx.baseGitDir).toBe(join(repo, ".git"));
    expect(ctx.baseWorktreeGitDir).toBe(join(repo, ".git", "worktrees", "worktree"));
    expect(ctx.overgitDir).toBe(join(wt, ".overgit"));

    // Prove the claim: a pattern written to baseGitDir/info/exclude applies in the worktree.
    await mkdir(join(ctx.baseGitDir, "info"), { recursive: true });
    await writeFile(join(ctx.baseGitDir, "info", "exclude"), "/proof.txt\n");
    await writeFile(join(wt, "proof.txt"), "x\n");
    expect((await sh(wt, ["git", "check-ignore", "-q", "--", "proof.txt"])).code).toBe(0);
    await writeFile(join(ctx.baseGitDir, "info", "exclude"), "");
  });

  test("hasOverlay and requireOverlay", async () => {
    await expectCode(() => discover(repo, { requireOverlay: true }), "NO_OVERLAY");

    // A directory without HEAD is a half-made clone, not an overlay.
    await mkdir(join(repo, ".overgit", ".git"), { recursive: true });
    expect((await discover(repo)).hasOverlay).toBe(false);
    await expectCode(() => discover(repo, { requireOverlay: true }), "NO_OVERLAY");

    await rm(join(repo, ".overgit"), { recursive: true, force: true });
    await makeOverlay(repo);
    const ctx = await discover(repo, { requireOverlay: true });
    expect(ctx.hasOverlay).toBe(true);
    await rm(join(repo, ".overgit"), { recursive: true, force: true });
  });

  test("NO_OVERLAY carries an actionable hint", async () => {
    try {
      await discover(repo, { requireOverlay: true });
      throw new Error("expected a throw");
    } catch (e) {
      expect(isOvergitError(e) && e.hint).toContain("overgit init");
    }
  });

  test("the overlay Git is wired to .overgit/.git with the root as work-tree", async () => {
    await makeOverlay(repo);
    const ctx = await discover(repo, { requireOverlay: true });
    expect(await ctx.overlay.resolveGitDir()).toBe(join(repo, ".overgit", ".git"));
    // The overlay index is genuinely separate from the base's.
    expect(await ctx.base.isTracked("seed.txt")).toBe(true);
    expect(await ctx.overlay.isTracked("seed.txt")).toBe(false);
    await rm(join(repo, ".overgit"), { recursive: true, force: true });
  });
});

/**
 * With the overlay GIT_DIR at `<root>/.overgit/.git`, plain git discovery from anywhere
 * under `.overgit/` lands on the *overlay*, which claims `<root>` as its work-tree. Nothing
 * about that is obvious from the outside, so these tests pin the exact behaviour.
 */
describe("discover inside .overgit (the layout hazard)", () => {
  let hazRepo: string;
  let overlayGitDir: string;

  beforeAll(async () => {
    hazRepo = join(root, "hazard");
    await initRepo(hazRepo);
    overlayGitDir = await makeOverlay(hazRepo);
    await mkdir(join(hazRepo, ".overgit", "local", "backups"), { recursive: true });
  });

  test("plain git really does resolve .overgit/ to the overlay", async () => {
    // If this ever stops being true the workaround below is dead code, so assert it.
    const seen = (
      await sh(join(hazRepo, ".overgit"), ["git", "rev-parse", "--absolute-git-dir"])
    ).stdout.trim();
    expect(seen).toBe(overlayGitDir);
  });

  test("discover from the root still finds the base when an overlay exists", async () => {
    const ctx = await discover(hazRepo);
    expect(ctx.root).toBe(hazRepo);
    expect(ctx.baseGitDir).toBe(join(hazRepo, ".git"));
    expect(ctx.hasOverlay).toBe(true);
    expect(await ctx.base.isTracked("seed.txt")).toBe(true);
  });

  test("discover from a subdirectory still finds the base when an overlay exists", async () => {
    await mkdir(join(hazRepo, "src", "deep"), { recursive: true });
    const ctx = await discover(join(hazRepo, "src", "deep"));
    expect(ctx.root).toBe(hazRepo);
    expect(ctx.baseGitDir).toBe(join(hazRepo, ".git"));
  });

  test("discover from <root>/.overgit resolves to the base, not the overlay", async () => {
    const ctx = await discover(join(hazRepo, ".overgit"));
    expect(ctx.root).toBe(hazRepo);
    expect(ctx.baseGitDir).toBe(join(hazRepo, ".git"));
    expect(ctx.baseWorktreeGitDir).toBe(join(hazRepo, ".git"));
    expect(ctx.overlayGitDir).toBe(overlayGitDir);
    expect(ctx.hasOverlay).toBe(true);
    // The decisive check: `base` must be the base repo, which tracks seed.txt.
    expect(await ctx.base.isTracked("seed.txt")).toBe(true);
    expect(await ctx.overlay.isTracked("seed.txt")).toBe(false);
  });

  test("discover from <root>/.overgit/local resolves to the base", async () => {
    const ctx = await discover(join(hazRepo, ".overgit", "local"));
    expect(ctx.root).toBe(hazRepo);
    expect(ctx.baseGitDir).toBe(join(hazRepo, ".git"));
    expect(await ctx.base.isTracked("seed.txt")).toBe(true);
  });

  test("discover from <root>/.overgit/local/backups resolves to the base", async () => {
    const ctx = await discover(join(hazRepo, ".overgit", "local", "backups"));
    expect(ctx.root).toBe(hazRepo);
    expect(ctx.baseGitDir).toBe(join(hazRepo, ".git"));
  });

  test("discover from inside <root>/.overgit/.git is refused", async () => {
    // Git reports `--is-inside-git-dir=false` here (core.worktree is set), so this refusal
    // is ours, not git's.
    expect(
      (
        await sh(overlayGitDir, ["git", "rev-parse", "--is-inside-git-dir"])
      ).stdout.trim(),
    ).toBe("false");

    await expectCode(() => discover(overlayGitDir), "INSIDE_GIT_DIR");
    await expectCode(() => discover(join(overlayGitDir, "objects")), "INSIDE_GIT_DIR");
  });

  test("an overlay with no base repository above it is reported honestly", async () => {
    const orphanParent = join(root, "orphan");
    const orphan = join(orphanParent, "proj");
    await mkdir(orphan, { recursive: true });
    await makeOverlay(orphan);
    // No .git in `orphan`, and `orphanParent` is not a repo either.
    let caught: unknown;
    try {
      await discover(join(orphan, ".overgit"));
    } catch (e) {
      caught = e;
    }
    expect(isOvergitError(caught) && caught.code).toBe("NOT_IN_BASE_REPO");
    expect(isOvergitError(caught) && caught.message).toContain(".overgit");
  });

  test("`git clean -xfd` in the base leaves the overlay, manifest and backups alone", async () => {
    // This is the whole reason the git dir is at .overgit/.git rather than .overgit/repo.
    await mkdir(join(hazRepo, ".git", "info"), { recursive: true });
    await writeFile(join(hazRepo, ".git", "info", "exclude"), "/.overgit/\n");
    await writeFile(join(hazRepo, ".overgit", "manifest.json"), '{"version":1}\n');
    await writeFile(join(hazRepo, ".overgit", "local", "backups", "1-x"), "rescued\n");

    const dry = await sh(hazRepo, ["git", "clean", "-xfd", "-n"]);
    expect(dry.stdout).not.toContain(".overgit");

    await sh(hazRepo, ["git", "clean", "-xfd"]);
    expect(await exists(join(hazRepo, ".overgit", "manifest.json"))).toBe(true);
    expect(await exists(join(hazRepo, ".overgit", "local", "backups", "1-x"))).toBe(true);
    expect(await exists(join(overlayGitDir, "HEAD"))).toBe(true);
    // Base invisibility is unaffected by the nested repository.
    expect((await sh(hazRepo, ["git", "status", "--porcelain"])).stdout).toBe("");
  });
});

describe("withLock", () => {
  let ctx: Context;
  let lockPath: string;

  beforeAll(async () => {
    ctx = await discover(repo);
    lockPath = join(ctx.localDir, "lock");
  });

  test("creates the lock with our pid and removes it afterwards", async () => {
    let seen = "";
    const r = await withLock(ctx, async () => {
      seen = await readFile(lockPath, "utf8");
      return 42;
    });
    expect(r).toBe(42);
    expect(seen.split("\n")[0]).toBe(String(process.pid));
    expect(await exists(lockPath)).toBe(false);
  });

  test("creates .overgit/local on demand", async () => {
    await rm(ctx.overgitDir, { recursive: true, force: true });
    await withLock(ctx, async () => {
      expect(await exists(lockPath)).toBe(true);
    });
    expect(await exists(ctx.localDir)).toBe(true);
  });

  test("releases on throw", async () => {
    await expect(
      withLock(ctx, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await exists(lockPath)).toBe(false);
  });

  test("is re-entrant within one process", async () => {
    const order: string[] = [];
    await withLock(ctx, async () => {
      order.push("outer");
      expect(await exists(lockPath)).toBe(true);
      await withLock(ctx, async () => {
        order.push("inner");
        // The inner scope must not delete the lock the outer scope still needs.
        expect(await exists(lockPath)).toBe(true);
      });
      expect(await exists(lockPath)).toBe(true);
      order.push("outer-end");
    });
    expect(order).toEqual(["outer", "inner", "outer-end"]);
    expect(await exists(lockPath)).toBe(false);
  });

  test("a re-entrant inner throw still releases exactly once", async () => {
    await expect(
      withLock(ctx, async () => {
        await withLock(ctx, async () => {
          throw new Error("inner boom");
        });
      }),
    ).rejects.toThrow("inner boom");
    expect(await exists(lockPath)).toBe(false);
  });

  test("a live foreign lock throws LOCKED", async () => {
    await mkdir(ctx.localDir, { recursive: true });
    // Our own pid is certainly alive, and the re-entrancy counter is at zero here.
    await writeFile(lockPath, `${process.pid}\n2020-01-01T00:00:00.000Z\n`);
    let caught: unknown;
    try {
      await withLock(ctx, async () => undefined);
    } catch (e) {
      caught = e;
    }
    expect(isOvergitError(caught) && caught.code).toBe("LOCKED");
    expect(isOvergitError(caught) && caught.message).toContain(String(process.pid));
    expect(isOvergitError(caught) && caught.hint).toContain(lockPath);
    // The foreign lock must be left alone.
    expect(await exists(lockPath)).toBe(true);
    await rm(lockPath, { force: true });
  });

  test("a stale lock is broken with a warning", async () => {
    // A pid that has certainly exited.
    const dead = Bun.spawn({ cmd: ["true"], stdout: "ignore", stderr: "ignore" });
    await dead.exited;
    await mkdir(ctx.localDir, { recursive: true });
    await writeFile(lockPath, `${dead.pid}\n2020-01-01T00:00:00.000Z\n`);

    const warnings: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await withLock(ctx, async () => undefined);
    } finally {
      process.stderr.write = realWrite;
    }
    expect(warnings.join("")).toContain("stale lock");
    expect(await exists(lockPath)).toBe(false);
  });

  test("an unreadable lock is broken rather than wedging the repo forever", async () => {
    await mkdir(ctx.localDir, { recursive: true });
    await writeFile(lockPath, "not a pid at all\n");
    const warnings: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await withLock(ctx, async () => "ok");
    } finally {
      process.stderr.write = realWrite;
    }
    expect(warnings.join("")).toContain("unreadable lock");
    expect(await exists(lockPath)).toBe(false);
  });

  test("a second process is refused while the first holds the lock", async () => {
    const script = join(root, "hold-lock.ts");
    await writeFile(
      script,
      [
        `import { discover, withLock } from ${JSON.stringify(join(import.meta.dir, "..", "src", "context.ts"))};`,
        `const ctx = await discover(process.argv[2]!);`,
        `await withLock(ctx, async () => {`,
        `  process.stdout.write("locked\\n");`,
        `  await new Promise((r) => setTimeout(r, 30_000));`,
        `});`,
      ].join("\n"),
    );

    const holder = Bun.spawn({
      cmd: ["bun", "run", script, repo],
      env: { ...process.env } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    try {
      const reader = holder.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("locked");
      reader.releaseLock();

      let caught: unknown;
      try {
        await withLock(ctx, async () => undefined);
      } catch (e) {
        caught = e;
      }
      expect(isOvergitError(caught) && caught.code).toBe("LOCKED");
      expect(isOvergitError(caught) && caught.message).toContain(String(holder.pid));
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
    // The killed holder left the lock behind; the next caller must break it as stale.
    expect(await exists(lockPath)).toBe(true);
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await withLock(ctx, async () => undefined);
    } finally {
      process.stderr.write = realWrite;
    }
    expect(await exists(lockPath)).toBe(false);
  }, 30_000);

  test("SIGINT releases the lock", async () => {
    const script = join(root, "hold-lock.ts");
    const holder = Bun.spawn({
      cmd: ["bun", "run", script, repo],
      env: { ...process.env } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const reader = holder.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("locked");
    reader.releaseLock();
    expect(await exists(lockPath)).toBe(true);

    holder.kill("SIGINT");
    const code = await holder.exited;
    expect(code).toBe(130);
    expect(await exists(lockPath)).toBe(false);
  }, 30_000);
});
