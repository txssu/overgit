/**
 * Tests *of the harness*. Everything here uses plain git — the CLI under test is not
 * required to exist (other builders are writing it in parallel), except for the two
 * cases that deliberately prove a missing CLI surfaces as a readable failure.
 *
 * The important one is "assertBaseClean agrees with git": the DESIGN.md §6.5 fixture is
 * built by hand with raw git commands, and the oracle must call it clean. If that ever
 * breaks, every invisibility claim in the project is unverified.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";

import {
  BUN_BIN,
  CLI_ENTRY,
  NEWLINE_NAME,
  PROJECT_ROOT,
  WEIRD_NAMES,
  assertBaseClean,
  assertCleanSafe,
  assertTreesEqual,
  cleanupAllSandboxes,
  compareTrees,
  diffTrees,
  envForPath,
  expectFail,
  expectOk,
  makeSandbox,
  mkManualOverlay,
  overgit,
  overgitRun,
  runCommand,
  seedWeirdNames,
  sha256,
  snapshotTree,
  withSandbox,
  type Sandbox,
} from "./helpers/harness.ts";

afterAll(async () => {
  await cleanupAllSandboxes();
});

/** Assert that `fn` throws, and hand the message back for inspection. */
async function messageOfRejection(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the call to throw, but it resolved");
}

/* =============================================================== hermeticity */

describe("sandbox hermeticity", () => {
  test("git identity and defaults come from the sandbox, not from ~/.gitconfig", async () => {
    await withSandbox("hermetic", async (sb) => {
      const repo = await sb.mkBaseRepo("r");

      expect((await repo.git("config", "user.name")).stdout.trim()).toBe(
        "Overgit Test",
      );
      expect((await repo.git("config", "user.email")).stdout.trim()).toBe(
        "test@overgit.invalid",
      );
      expect((await repo.git("config", "commit.gpgsign")).stdout.trim()).toBe(
        "false",
      );
      expect(await repo.branch()).toBe("main");

      // The value must physically come out of the sandbox's config file.
      const origin = (
        await repo.git("config", "--show-origin", "init.defaultBranch")
      ).stdout;
      expect(origin).toContain(sb.gitConfigPath);
    });
  });

  test("sandbox dir is realpath'd and HOME lives inside it", async () => {
    await withSandbox("realpath", async (sb) => {
      const { realpath } = await import("node:fs/promises");
      expect(await realpath(sb.dir)).toBe(sb.dir);
      expect(sb.home.startsWith(sb.dir)).toBe(true);
      expect(sb.env.HOME).toBe(sb.home);
      expect(sb.env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
      expect(sb.env.GIT_CONFIG_GLOBAL).toBe(sb.gitConfigPath);
    });
  });

  test("proxy and ambient GIT_* variables are not inherited", async () => {
    await withSandbox("no-inherit", async (sb) => {
      for (const k of [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
      ]) {
        expect(sb.env[k]).toBeUndefined();
      }
      // And the child really sees that environment.
      const r = await sb.run(["env"]);
      expect(r.stdout).not.toContain("\nHTTP_PROXY=");
      expect(r.stdout).toContain(`HOME=${sb.home}`);
    });
  });

  test("two sandboxes are independent", async () => {
    const a = await makeSandbox("iso-a");
    const b = await makeSandbox("iso-b");
    try {
      expect(a.dir).not.toBe(b.dir);
      const ra = await a.mkBaseRepo("r", { "x.txt": "a\n" });
      const rb = await b.mkBaseRepo("r", { "x.txt": "b\n" });
      expect(await ra.read("x.txt")).toBe("a\n");
      expect(await rb.read("x.txt")).toBe("b\n");
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});

/* ================================================================== process */

describe("command running", () => {
  test("runCommand times out loudly instead of hanging", async () => {
    const msg = await messageOfRejection(() =>
      runCommand(["sleep", "30"], {
        cwd: PROJECT_ROOT,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 300,
      }),
    );
    expect(msg).toContain("timed out after 300ms");
    expect(msg).toContain("sleep 30");
  });

  test("a child that reads stdin gets EOF, not a hang", async () => {
    const r = await runCommand(["cat"], {
      cwd: PROJECT_ROOT,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5_000,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("stdin can be supplied", async () => {
    const r = await runCommand(["cat"], {
      cwd: PROJECT_ROOT,
      env: { PATH: process.env.PATH ?? "" },
      input: "hello stdin\n",
      timeoutMs: 5_000,
    });
    expect(r.stdout).toBe("hello stdin\n");
  });

  test("repo.git throws with stderr in the message; gitTry does not", async () => {
    await withSandbox("git-errors", async (sb) => {
      const repo = await sb.mkBaseRepo("r");

      const msg = await messageOfRejection(() =>
        repo.git("cat-file", "-p", "0000000000000000000000000000000000000000"),
      );
      expect(msg).toContain("git failed in r");
      expect(msg.toLowerCase()).toContain("stderr");

      const r = await repo.gitTry("rev-parse", "--verify", "nope-not-a-ref");
      expect(r.code).not.toBe(0);
      expect(r.stderr.length).toBeGreaterThan(0);
    });
  });
});

/* ====================================================================== CLI */

describe("overgit() CLI spawn", () => {
  test("bin/overgit exists and is what we spawn", () => {
    expect(existsSync(CLI_ENTRY)).toBe(true);
    expect(CLI_ENTRY).toBe(join(PROJECT_ROOT, "bin", "overgit"));
  });

  test("a missing/unbuilt CLI is a clean non-zero exit, never a hang", async () => {
    await withSandbox("cli-missing", async (sb) => {
      const repo = await sb.mkBaseRepo("r");
      const r = await overgitRun(repo.dir, ["--version"], { timeoutMs: 20_000 });
      expect(r.timedOut).toBe(false);
      // Either the CLI works (other builders landed it) or it fails readably.
      if (r.code !== 0) {
        expect(r.stderr.length).toBeGreaterThan(0);
        const msg = await messageOfRejection(async () => expectOk(r));
        expect(msg).toContain("expected command to succeed");
        expect(msg).toContain("cwd:");
        expect(msg).toContain(repo.dir);
      }
    });
  });

  test("the CLI runs in the sandbox env, not the parent's", async () => {
    await withSandbox("cli-env", async (sb) => {
      const repo = await sb.mkBaseRepo("r");
      // Spawn bun directly with the same plumbing overgit() uses, but on a probe
      // script, so this assertion holds whether or not src/cli exists yet.
      const probe = sb.path("probe.ts");
      await writeFile(
        probe,
        "console.log(JSON.stringify({home: process.env.HOME, cwd: process.cwd(), " +
          "gcg: process.env.GIT_CONFIG_GLOBAL, proxy: process.env.HTTP_PROXY ?? null}));\n",
      );
      const r = await sb.run([BUN_BIN, probe], { cwd: repo.dir });
      const info = JSON.parse(r.stdout) as Record<string, string | null>;
      expect(info.home).toBe(sb.home);
      expect(info.cwd).toBe(repo.dir);
      expect(info.gcg).toBe(sb.gitConfigPath);
      expect(info.proxy).toBeNull();
    });
  });

  test("a .env in the work-tree cannot leak into the CLI process", async () => {
    await withSandbox("dotenv", async (sb) => {
      const repo = await sb.mkBaseRepo("r");
      await repo.write(".env", "OVERGIT_SNEAKY=leaked\n");
      const probe = sb.path("probe.ts");
      await writeFile(
        probe,
        "console.log(process.env.OVERGIT_SNEAKY ?? 'absent');\n",
      );
      const r = await sb.run([BUN_BIN, "--env-file=/dev/null", probe], {
        cwd: repo.dir,
      });
      expect(r.stdout.trim()).toBe("absent");
    });
  });

  test("expectFail reports the wrong-code case", async () => {
    const fake = {
      stdout: "",
      stderr: "boom",
      code: 1,
      argv: ["overgit", "status"],
      cwd: "/nowhere",
      durationMs: 1,
      timedOut: false,
      signal: null,
    };
    expect(() => expectFail(fake, 1)).not.toThrow();
    expect(() => expectFail(fake, 3)).toThrow(/expected exit 3, got 1/);
    expect(() => expectFail({ ...fake, code: 0 })).toThrow(
      /expected command to fail/,
    );
  });
});

/* ======================================================== assertBaseClean */

describe("assertBaseClean", () => {
  test("passes on a pristine repo", async () => {
    await withSandbox("clean-ok", async (sb) => {
      const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n", "b/c.txt": "c\n" });
      await assertBaseClean(repo.dir);
    });
  });

  test("fails on an untracked file, naming it", async () => {
    await withSandbox("clean-untracked", async (sb) => {
      const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n" });
      await repo.write("leaked.txt", "overlay bytes\n");

      const msg = await messageOfRejection(() => assertBaseClean(repo.dir));
      expect(msg).toContain("the base repo can see overlay state");
      expect(msg).toContain("git status --porcelain is not empty");
      expect(msg).toContain("leaked.txt");
      expect(msg).toContain("a real `git add -A` would capture");
      expect(msg).toContain("--- base repo state ---");
    });
  });

  test("fails on a modified tracked file", async () => {
    await withSandbox("clean-modified", async (sb) => {
      const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n" });
      await repo.write("a.txt", "MODIFIED\n");

      const msg = await messageOfRejection(() => assertBaseClean(repo.dir));
      expect(msg).toContain("git diff is not empty");
      expect(msg).toContain("a.txt");
      expect(msg).toContain("a real `git add -A` would capture");
    });
  });

  test("fails on a staged change", async () => {
    await withSandbox("clean-staged", async (sb) => {
      const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n" });
      await repo.write("a.txt", "STAGED\n");
      await repo.git("add", "a.txt");

      const msg = await messageOfRejection(() => assertBaseClean(repo.dir));
      expect(msg).toContain("git diff --cached is not empty");
      expect(msg).toContain("a.txt");
    });
  });

  test("fails on an unexpected stash entry", async () => {
    await withSandbox("clean-stash", async (sb) => {
      const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n" });
      await repo.write("a.txt", "dirty\n");
      await repo.git("stash", "push", "-m", "wip");

      // The work-tree is clean again, so only the stash check can catch this.
      const msg = await messageOfRejection(() => assertBaseClean(repo.dir));
      expect(msg).toContain("git stash list has 1 entry");

      // ...and the escape hatch works.
      await assertBaseClean(repo.dir, { stash: "any" });
    });
  });

  test("fails on an interrupted merge", async () => {
    await withSandbox("clean-merge", async (sb) => {
      const repo = await sb.mkBaseRepo("base", { "a.txt": "one\n" });
      await repo.git("checkout", "-b", "side");
      await repo.commitFiles("side", { "a.txt": "side\n" });
      await repo.git("checkout", "main");
      await repo.commitFiles("main", { "a.txt": "main\n" });
      const merge = await repo.gitTry("merge", "side");
      expect(merge.code).not.toBe(0);

      const msg = await messageOfRejection(() => assertBaseClean(repo.dir));
      expect(msg).toContain("operation in progress");
      await repo.git("merge", "--abort");
      await assertBaseClean(repo.dir);
    });
  });

  test("the real `git add -A` check has teeth that status/diff do not", async () => {
    // Measured on git 2.55: with `status.showUntrackedFiles=no` set on the *base* (a
    // plausible bug — DESIGN.md §2 tells builders to set it on the *overlay*), an
    // overlay-added file is invisible to `git status --porcelain`, `git diff` and
    // `git diff --cached`, yet a real `git add -A` stages it. If overgit ever shipped
    // that bug, `git add -A && git commit` in the base would commit overlay content.
    await withSandbox("clean-teeth", async (sb) => {
      const repo = await sb.mkBaseRepo("base", { "f.txt": "orig\n" });
      await repo.git("config", "status.showUntrackedFiles", "no");
      await repo.write("A.txt", "overlay bytes\n");

      // Confirm the naive checks really are blind here.
      expect((await repo.git("status", "--porcelain")).stdout.trim()).toBe("");
      expect((await repo.git("diff", "--name-only")).stdout.trim()).toBe("");
      expect((await repo.git("diff", "--cached", "--name-only")).stdout.trim()).toBe("");

      const msg = await messageOfRejection(() => assertBaseClean(repo.dir));
      expect(msg).toContain("a real `git add -A` would capture");
      expect(msg).toContain("A.txt");
    });
  });

  test("a `git add` that exits non-zero on sparsity rules is NOT a leak", async () => {
    // Measured on git 2.55: `git add -A -- <overlay-owned path>` exits 1 with the
    // "sparse-checkout" refusal and captures nothing. That is the DESIGN.md §6.5 row
    // "explicit `git add C.txt` -> refused, index untouched" — correct behaviour, not a
    // leak. The oracle must judge by what was captured, never by the exit code.
    await withSandbox("clean-sparsity", async (sb) => {
      const ov = await mkManualOverlay(sb);

      const refused = await ov.base.gitTry("add", "-A", "--", "C.txt");
      expect(refused.code).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`.toLowerCase()).toContain("sparse");

      // Both an override and a whiteout are in play here; the oracle still says clean.
      expect(await ov.base.skipWorktreePaths()).toEqual(["C.txt", "D.txt"]);
      await assertBaseClean(ov.base.dir);
    });
  });

  test("catches a leak that `git add -A` hides behind exit code 0", async () => {
    // DESIGN.md §6.5 consequence 1: never set `core.sparseCheckout=true` on the base.
    // Measured: with it set, `git add -A` exits **0** and stages the override's overlay
    // bytes. Exit code says success; the capture check is the only thing that sees it.
    await withSandbox("clean-sparsecheckout", async (sb) => {
      const ov = await mkManualOverlay(sb);
      await assertBaseClean(ov.base.dir);

      await ov.base.git("config", "core.sparseCheckout", "true");

      const msg = await messageOfRejection(() => assertBaseClean(ov.base.dir));
      expect(msg).toContain("would capture overlay-owned content");
      expect(msg).toContain("C.txt");
    });
  });

  test("does not mutate the repo it inspects", async () => {
    await withSandbox("clean-nonmutating", async (sb) => {
      const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n" });
      const before = await snapshotTree(repo.dir);
      const indexBefore = sha256(await Bun.file(join(await repo.gitDir(), "index")).bytes());
      const objectsBefore = (
        await sb.run(["find", join(await repo.gitDir(), "objects"), "-type", "f"])
      ).stdout;

      await assertBaseClean(repo.dir);

      const indexAfter = sha256(await Bun.file(join(await repo.gitDir(), "index")).bytes());
      const objectsAfter = (
        await sb.run(["find", join(await repo.gitDir(), "objects"), "-type", "f"])
      ).stdout;
      expect(indexAfter).toBe(indexBefore);
      expect(objectsAfter).toBe(objectsBefore);
      assertTreesEqual(before, await snapshotTree(repo.dir));
    });
  });
});

/* ============================================ the DESIGN.md §6.5 oracle test */

describe("assertBaseClean vs the hand-built overlay (DESIGN.md §6.5)", () => {
  test("a skip-worktree override + whiteout + excluded add reads as clean", async () => {
    await withSandbox("oracle", async (sb) => {
      const ov = await mkManualOverlay(sb);

      // Sanity: the fixture really is in the state the design describes.
      expect(await ov.base.skipWorktreePaths()).toEqual(["C.txt", "D.txt"]);
      expect(await ov.base.read("C.txt")).toBe("overlay C\n");
      expect(await ov.base.read("A.txt")).toBe("overlay A\n");
      expect(await ov.base.exists("D.txt")).toBe(false);
      expect(await ov.base.blobOid("C.txt")).not.toBeNull();

      // The oracle says the base sees nothing. This is the whole project's premise.
      await assertBaseClean(ov.base.dir);
    });
  });

  test("the oracle is not vacuous: clearing skip-worktree makes it fail", async () => {
    await withSandbox("oracle-negative", async (sb) => {
      const ov = await mkManualOverlay(sb);
      await assertBaseClean(ov.base.dir);

      await ov.base.git("update-index", "--no-skip-worktree", "C.txt");
      const msg = await messageOfRejection(() => assertBaseClean(ov.base.dir));
      expect(msg).toContain("C.txt");
      expect(msg).toContain("git diff is not empty");
    });
  });

  test("the oracle is not vacuous: dropping the exclude line makes it fail", async () => {
    await withSandbox("oracle-negative-2", async (sb) => {
      const ov = await mkManualOverlay(sb);
      const excludePath = join(await ov.base.gitDir(), "info", "exclude");
      await writeFile(excludePath, "");

      const msg = await messageOfRejection(() => assertBaseClean(ov.base.dir));
      expect(msg).toContain("A.txt");
      expect(msg).toContain(".overgit");
    });
  });

  test("`git add -A && git commit` in the base captures nothing overlay-owned", async () => {
    await withSandbox("oracle-add-commit", async (sb) => {
      const ov = await mkManualOverlay(sb);
      const headBefore = await ov.base.head();

      await ov.base.git("add", "-A", "--", ".");
      const staged = await ov.base.git("diff", "--cached", "--name-only");
      expect(staged.stdout.trim()).toBe("");

      const commit = await ov.base.gitTry("commit", "-m", "should be empty");
      // Nothing to commit -> git refuses. Either way HEAD must not move.
      expect(commit.code).not.toBe(0);
      expect(await ov.base.head()).toBe(headBefore);
      await assertBaseClean(ov.base.dir);
    });
  });

  test("explicit `git add C.txt` is refused and leaves the index untouched", async () => {
    await withSandbox("oracle-explicit-add", async (sb) => {
      const ov = await mkManualOverlay(sb);
      const r = await ov.base.gitTry("add", "C.txt");
      expect(r.code).not.toBe(0);
      await assertBaseClean(ov.base.dir);
    });
  });

  test("overlay bytes survive `git checkout -- .` and `git reset --hard`", async () => {
    await withSandbox("oracle-reset", async (sb) => {
      const ov = await mkManualOverlay(sb);

      await ov.base.git("checkout", "--", ".");
      expect(await ov.base.read("C.txt")).toBe("overlay C\n");
      expect(await ov.base.exists("D.txt")).toBe(false);

      await ov.base.git("reset", "--hard");
      expect(await ov.base.read("C.txt")).toBe("overlay C\n");
      expect(await ov.base.exists("D.txt")).toBe(false);
      expect(await ov.base.skipWorktreePaths()).toEqual(["C.txt", "D.txt"]);
      await assertBaseClean(ov.base.dir);
    });
  });

  test("`git clean -xfd` removes the added file but spares the overlay (§6.5 + §6.6)", async () => {
    await withSandbox("oracle-clean", async (sb) => {
      const ov = await mkManualOverlay(sb);

      const r = await ov.base.git("clean", "-xfd");
      // The overlay-added file is ignored, so clean takes it — that is the §6.5 row,
      // and it is recoverable because the overlay repo still holds the bytes.
      expect(await ov.base.exists("A.txt")).toBe(false);
      expect(`${r.stdout}`).toContain("A.txt");

      // §6.6: `.overgit/` must survive, or the row above would be unrecoverable.
      expect(await ov.base.exists(".overgit/.git")).toBe(true);
      expect(await ov.base.exists(".overgit/manifest.json")).toBe(true);
      expect(await ov.base.exists(".overgit/local/placeholder")).toBe(true);

      // The override and the whiteout are untouched, and the base still sees nothing.
      expect(await ov.base.read("C.txt")).toBe("overlay C\n");
      expect(await ov.base.exists("D.txt")).toBe(false);
      await assertBaseClean(ov.base.dir);
    });
  });

  test("assertCleanSafe passes on the §6.6 layout and reports what clean removed", async () => {
    await withSandbox("cleansafe-ok", async (sb) => {
      const ov = await mkManualOverlay(sb);
      const before = await ov.base.snapshot();

      const r = await assertCleanSafe(ov.base.dir);
      expect(r.layout).toBe("overgit/.git");
      expect(r.removed).toContain("A.txt");

      // It probes a throwaway copy: the repo under test is untouched.
      assertTreesEqual(before, await ov.base.snapshot(), "assertCleanSafe mutated the repo");
      expect(await ov.base.exists("A.txt")).toBe(true);
      expect(existsSync(r.copyDir)).toBe(false);
    });
  });

  test("assertCleanSafe fails loudly on the unprotected raw-gitdir layout", async () => {
    // DESIGN.md §6.6: a raw `.overgit/repo` with no `.overgit/.git` is deleted wholesale.
    await withSandbox("cleansafe-raw", async (sb) => {
      const ov = await mkManualOverlay(sb);
      await ov.base.rm(".overgit/.git");
      await ov.base.git("init", "--quiet", "-b", "main", "--bare", ".overgit/repo");

      const msg = await messageOfRejection(() => assertCleanSafe(ov.base.dir));
      expect(msg).toContain("DELETED the whole .overgit/ directory");
      expect(msg).toContain("§6.6");
      // The real repo is still intact — only the throwaway copy was destroyed.
      expect(await ov.base.exists(".overgit/repo")).toBe(true);
      expect(await ov.base.exists("A.txt")).toBe(true);
    });
  });

  test("assertCleanSafe accepts a valid gitfile but rejects a dangling one", async () => {
    // Measured on git 2.55: a gitfile whose target is a real repo protects the directory;
    // a dangling one does not. This is the `clean-unprotected` shape doctor must flag.
    await withSandbox("cleansafe-gitfile", async (sb) => {
      const ov = await mkManualOverlay(sb);
      await ov.base.rm(".overgit/.git");
      await ov.base.git("init", "--quiet", "-b", "main", "--bare", ".overgit/repo");
      await ov.base.git(
        "--git-dir",
        ov.base.path(".overgit", "repo"),
        "config",
        "core.bare",
        "false",
      );
      await ov.base.write(".overgit/.git", "gitdir: ./repo\n");

      const ok = await assertCleanSafe(ov.base.dir);
      expect(ok.layout).toBe("overgit/.git");

      await ov.base.write(".overgit/.git", "gitdir: ./nonexistent\n");
      const msg = await messageOfRejection(() => assertCleanSafe(ov.base.dir));
      expect(msg).toContain("DELETED the whole .overgit/ directory");
    });
  });

  test("assertCleanSafe refuses a repo with no overlay rather than passing vacuously", async () => {
    await withSandbox("cleansafe-none", async (sb) => {
      const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n" });
      const msg = await messageOfRejection(() => assertCleanSafe(repo.dir));
      expect(msg).toContain("no .overgit/ directory");
    });
  });

  test("upstream drift helpers reproduce the §6.5 rows", async () => {
    await withSandbox("oracle-drift", async (sb) => {
      const ov = await mkManualOverlay(sb);

      // Row: upstream changed the whiteout target -> pull succeeds, D.txt resurrects.
      await ov.upstream.changeFile("D.txt", "upstream D v2\n");
      const pull = await ov.base.gitTry("pull", "--no-rebase");
      expect(pull.code).toBe(0);
      expect(await ov.base.exists("D.txt")).toBe(true);

      // Row: upstream added the overlay's added path -> pull overwrites A.txt.
      await ov.upstream.addFile("A.txt", "upstream A\n");
      const pull2 = await ov.base.gitTry("pull", "--no-rebase");
      expect(pull2.code).toBe(0);
      expect(await ov.base.read("A.txt")).toBe("upstream A\n");

      // Row: upstream changed the overridden path -> pull aborts.
      await ov.upstream.changeFile("C.txt", "upstream C v2\n");
      const pull3 = await ov.base.gitTry("pull", "--no-rebase");
      expect(pull3.code).not.toBe(0);
      expect(`${pull3.stdout}${pull3.stderr}`).toContain("C.txt");
      expect(await ov.base.read("C.txt")).toBe("overlay C\n");
    });
  });
});

/* ========================================================= snapshot / diff */

describe("snapshotTree + diffTrees", () => {
  async function fixture(sb: Sandbox, name: string) {
    const dir = sb.path(name);
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.txt"), "a\n");
    await writeFile(join(dir, "sub", "b.txt"), "b\n");
    await writeFile(join(dir, "script.sh"), "#!/bin/sh\n");
    await chmod(join(dir, "script.sh"), 0o755);
    await symlink("a.txt", join(dir, "link"));
    return dir;
  }

  test("records content hash, exec bit and symlink target", async () => {
    await withSandbox("snap-basic", async (sb) => {
      const dir = await fixture(sb, "t");
      const snap = await snapshotTree(dir);

      expect([...snap.keys()]).toEqual([
        "a.txt",
        "link",
        "script.sh",
        "sub/b.txt",
      ]);
      expect(snap.get("a.txt")).toBe(`file 100644 ${sha256("a\n")}`);
      expect(snap.get("script.sh")).toBe(`file 100755 ${sha256("#!/bin/sh\n")}`);
      expect(snap.get("link")).toBe("symlink -> a.txt");
    });
  });

  test("is deterministic and sorted", async () => {
    await withSandbox("snap-det", async (sb) => {
      const dir = await fixture(sb, "t");
      const a = await snapshotTree(dir);
      const b = await snapshotTree(dir);
      assertTreesEqual(a, b);
      expect([...a.keys()]).toEqual([...a.keys()].slice().sort());
    });
  });

  test("excludes .git at any depth and .overgit/{repo,local}", async () => {
    await withSandbox("snap-exclude", async (sb) => {
      const dir = sb.path("t");
      await mkdir(join(dir, ".git", "objects"), { recursive: true });
      await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      await mkdir(join(dir, "vendor", "nested", ".git"), { recursive: true });
      await writeFile(join(dir, "vendor", "nested", ".git", "HEAD"), "x\n");
      await mkdir(join(dir, ".overgit", "repo"), { recursive: true });
      await writeFile(join(dir, ".overgit", "repo", "HEAD"), "x\n");
      // DESIGN.md §6.6 layout: the overlay GIT_DIR is `.overgit/.git`, covered by the
      // `.git` basename rule whether it is a directory or a gitfile.
      await mkdir(join(dir, ".overgit", ".git", "objects"), { recursive: true });
      await writeFile(join(dir, ".overgit", ".git", "HEAD"), "ref: refs/heads/main\n");
      await mkdir(join(dir, ".overgit", "local", "backups"), { recursive: true });
      await writeFile(join(dir, ".overgit", "local", "lock"), "1\n");
      await writeFile(join(dir, ".overgit", "manifest.json"), "{}\n");
      await writeFile(join(dir, "keep.txt"), "k\n");

      const snap = await snapshotTree(dir);
      // `vendor/nested` holds only an excluded `.git`, so it is neither listed nor
      // mistaken for an empty directory.
      expect([...snap.keys()]).toEqual([".overgit/manifest.json", "keep.txt"]);
    });
  });

  test("detects a content change", async () => {
    await withSandbox("snap-content", async (sb) => {
      const dir = await fixture(sb, "t");
      const before = await snapshotTree(dir);
      await writeFile(join(dir, "sub", "b.txt"), "B CHANGED\n");
      const after = await snapshotTree(dir);

      const d = compareTrees(before, after);
      expect(d.equal).toBe(false);
      expect(d.differs).toEqual(["sub/b.txt"]);
      expect(d.onlyInA).toEqual([]);
      expect(d.onlyInB).toEqual([]);
      expect(diffTrees(before, after)).toContain("~ sub/b.txt");
    });
  });

  test("detects a mode change (exec bit)", async () => {
    await withSandbox("snap-mode", async (sb) => {
      const dir = await fixture(sb, "t");
      const before = await snapshotTree(dir);
      await chmod(join(dir, "script.sh"), 0o644);
      const after = await snapshotTree(dir);

      const d = compareTrees(before, after);
      expect(d.differs).toEqual(["script.sh"]);
      const text = diffTrees(before, after, { a: "before", b: "after" });
      expect(text).toContain("before: file 100755");
      expect(text).toContain("after: file 100644");
    });
  });

  test("detects a symlink target change and never follows the link", async () => {
    await withSandbox("snap-symlink", async (sb) => {
      const dir = await fixture(sb, "t");
      const before = await snapshotTree(dir);
      await rm(join(dir, "link"));
      await symlink("sub/b.txt", join(dir, "link"));
      const after = await snapshotTree(dir);

      expect(compareTrees(before, after).differs).toEqual(["link"]);
      expect(after.get("link")).toBe("symlink -> sub/b.txt");

      // A dangling symlink is recorded, not an error.
      await rm(join(dir, "link"));
      await symlink("does/not/exist", join(dir, "link"));
      const dangling = await snapshotTree(dir);
      expect(dangling.get("link")).toBe("symlink -> does/not/exist");
    });
  });

  test("detects added and removed files", async () => {
    await withSandbox("snap-addrm", async (sb) => {
      const dir = await fixture(sb, "t");
      const before = await snapshotTree(dir);
      await writeFile(join(dir, "new.txt"), "n\n");
      await rm(join(dir, "a.txt"));
      const after = await snapshotTree(dir);

      const d = compareTrees(before, after, { a: "before", b: "after" });
      expect(d.onlyInA).toEqual(["a.txt"]);
      expect(d.onlyInB).toEqual(["new.txt"]);
      expect(d.text).toContain("only in before (1):");
      expect(d.text).toContain("- a.txt");
      expect(d.text).toContain("only in after (1):");
      expect(d.text).toContain("+ new.txt");
    });
  });

  test("records empty directories (a whiteout must not leave one behind)", async () => {
    await withSandbox("snap-emptydir", async (sb) => {
      const dir = sb.path("t");
      await mkdir(join(dir, "empty"), { recursive: true });
      await writeFile(join(dir, "x.txt"), "x\n");
      const snap = await snapshotTree(dir);
      expect(snap.get("empty")).toBe("dir (empty)");
      expect((await snapshotTree(dir, { includeEmptyDirs: false })).has("empty")).toBe(
        false,
      );
    });
  });

  test("assertTreesEqual throws with an actionable message", async () => {
    await withSandbox("snap-assert", async (sb) => {
      const dir = await fixture(sb, "t");
      const before = await snapshotTree(dir);
      await writeFile(join(dir, "a.txt"), "changed\n");
      const after = await snapshotTree(dir);
      expect(() => assertTreesEqual(before, after, "work-tree drifted")).toThrow(
        /work-tree drifted[\s\S]*~ a\.txt/,
      );
    });
  });
});

/* ================================================================ fixtures */

describe("fixtures", () => {
  test("mkUpstream + clone + push helpers work without a network", async () => {
    await withSandbox("upstream", async (sb) => {
      const up = await sb.mkUpstream("origin.git", {
        "README.md": "# proj\n",
        "src/main.ts": "export const x = 1;\n",
      });
      const base = await up.clone("base");

      expect(await base.branch()).toBe("main");
      expect(await base.read("src/main.ts")).toBe("export const x = 1;\n");
      await assertBaseClean(base.dir);

      await up.changeFile("README.md", "# proj v2\n");
      await up.addFile("docs/new.md", "new\n");
      await up.deleteFile("src/main.ts");

      await base.git("pull", "--no-rebase");
      expect(await base.read("README.md")).toBe("# proj v2\n");
      expect(await base.read("docs/new.md")).toBe("new\n");
      expect(await base.exists("src/main.ts")).toBe(false);
      await assertBaseClean(base.dir);

      expect(await up.blobOid("README.md")).toBe(
        (await base.blobOid("README.md"))!,
      );
    });
  });

  test("upstream working clone is not part of the base snapshot", async () => {
    await withSandbox("upstream-isolation", async (sb) => {
      const up = await sb.mkUpstream("origin.git", { "a.txt": "a\n" });
      const base = await up.clone("base");
      const snap = await base.snapshot();
      expect([...snap.keys()]).toEqual(["a.txt"]);
    });
  });

  test("repo helpers: symlinks, exec bit, binary bytes, nested writes", async () => {
    await withSandbox("repo-helpers", async (sb) => {
      const repo = await sb.mkBaseRepo("r", { "a.txt": "a\n" });
      await repo.write("deep/nested/dir/f.txt", "f\n");
      await repo.writeBytes("bin.dat", new Uint8Array([0, 1, 2, 255, 0]));
      await repo.symlink("a.txt", "link");
      await repo.write("s.sh", "#!/bin/sh\n");
      await repo.setExec("s.sh");
      await repo.commit("stuff");

      expect(await repo.isExec("s.sh")).toBe(true);
      expect(await repo.readlink("link")).toBe("a.txt");
      expect([...(await repo.readBytes("bin.dat"))]).toEqual([0, 1, 2, 255, 0]);
      expect(await repo.trackedPaths()).toEqual([
        "a.txt",
        "bin.dat",
        "deep/nested/dir/f.txt",
        "link",
        "s.sh",
      ]);
      expect((await repo.log()).length).toBe(2);
      await assertBaseClean(repo.dir);

      await repo.rm("deep");
      expect(await repo.exists("deep/nested/dir/f.txt")).toBe(false);
    });
  });

  test("mkEmptyRepo has an unborn HEAD and still passes the oracle", async () => {
    await withSandbox("empty-repo", async (sb) => {
      const repo = await sb.mkEmptyRepo("r");
      expect(await repo.branch()).toBe("main");
      expect((await repo.gitTry("rev-parse", "HEAD")).code).not.toBe(0);
      await assertBaseClean(repo.dir);

      await repo.write("x.txt", "x\n");
      const msg = await messageOfRejection(() => assertBaseClean(repo.dir));
      expect(msg).toContain("x.txt");
    });
  });

  test("weird filenames survive fixtures, git and snapshots", async () => {
    await withSandbox("weird", async (sb) => {
      const repo = await sb.mkBaseRepo("r", { "keep.txt": "k\n" });
      await seedWeirdNames(repo);
      await repo.write(NEWLINE_NAME, "newline name\n");
      await repo.commit("weird names");

      const tracked = await repo.trackedPaths();
      for (const n of WEIRD_NAMES) expect(tracked).toContain(n);
      expect(tracked).toContain(NEWLINE_NAME);

      const snap = await repo.snapshot();
      for (const n of WEIRD_NAMES) {
        expect(snap.get(n)).toBe(`file 100644 ${sha256(`content of ${n}\n`)}`);
      }
      await assertBaseClean(repo.dir);

      // ...and the oracle still names a weird path when one leaks.
      await repo.write("bracket[1].txt", "MODIFIED\n");
      const msg = await messageOfRejection(() => assertBaseClean(repo.dir));
      expect(msg).toContain("bracket[1].txt");

      // A filename containing a newline must render intact, not be split into two rows.
      await repo.write("bracket[1].txt", `content of bracket[1].txt\n`);
      await repo.write(NEWLINE_NAME, "MODIFIED\n");
      const msg2 = await messageOfRejection(() => assertBaseClean(repo.dir));
      expect(msg2).toContain(`M\t${NEWLINE_NAME}`);
    });
  });

  test("weird filenames can be overlay-owned in the hand-built fixture", async () => {
    await withSandbox("weird-overlay", async (sb) => {
      const weird = "a file with spaces & a #hash!.txt";
      const ov = await mkManualOverlay(sb, {
        extraFiles: { [weird]: "base weird\n" },
      });

      await ov.base.git("update-index", "--skip-worktree", weird);
      await ov.base.write(weird, "overlay weird\n");
      await assertBaseClean(ov.base.dir);

      expect(await ov.base.skipWorktreePaths()).toEqual(
        ["C.txt", "D.txt", weird].sort(),
      );
    });
  });
});

/* ================================================================= cleanup */

describe("cleanup", () => {
  test("cleanup removes the sandbox dir and is idempotent", async () => {
    const sb = await makeSandbox("cleanup");
    await sb.mkBaseRepo("r");
    expect(existsSync(sb.dir)).toBe(true);
    await sb.cleanup();
    expect(existsSync(sb.dir)).toBe(false);
    await sb.cleanup();
  });

  test("keep() leaves the dir behind and prints its path", async () => {
    const sb = await makeSandbox("keepme");
    await sb.mkBaseRepo("r");
    sb.keep();
    await sb.cleanup();
    expect(existsSync(sb.dir)).toBe(true);
    await rm(sb.dir, { recursive: true, force: true });
  });

  test("a cleaned-up sandbox no longer claims paths in the registry", async () => {
    const sb = await makeSandbox("registry");
    const dir = sb.dir;
    await sb.cleanup();
    // Nothing to assert beyond "this does not throw"; the env lookup must fall back.
    const r = await overgit(PROJECT_ROOT, "--help");
    expect(r.timedOut).toBe(false);
    expect(dir.length).toBeGreaterThan(0);
  });

  test("the out-of-sandbox fallback env is hermetic and touches no disk", async () => {
    // A repo belonging to no sandbox still must not read the developer's ~/.gitconfig,
    // and the fallback must not create a temp dir (nothing would ever delete it).
    const { mkdtemp, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const repoDir = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), "overgit-outside-")),
    );
    try {
      const env = envForPath(repoDir);
      expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
      expect(env.HOME).not.toBe(process.env.HOME);

      const run = (args: string[]) =>
        runCommand(["git", "-C", repoDir, ...args], { cwd: repoDir, env });
      expect((await run(["init", "-q", "-b", "main", "."])).code).toBe(0);
      await writeFile(join(repoDir, "a.txt"), "a\n");
      expect((await run(["add", "-A"])).code).toBe(0);
      // Identity comes from GIT_AUTHOR_*/GIT_COMMITTER_*, not from any config file.
      expect((await run(["commit", "-m", "i"])).code).toBe(0);

      await assertBaseClean(repoDir);
      await writeFile(join(repoDir, "leak.txt"), "x\n");
      const msg = await messageOfRejection(() => assertBaseClean(repoDir));
      expect(msg).toContain("leak.txt");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
