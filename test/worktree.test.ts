/**
 * `overgit worktree` and the base-side linked worktree story (`src/worktree.ts`, the
 * worktree-aware parts of `context.ts`, `exclude.ts` and `bootstrap.ts`).
 *
 * Everything drives the CLI out of process. What is under test:
 *
 *  1. `worktree add` gives the new tree the overlay's content and both bases stay clean,
 *  2. the overlay in the new tree is a linked worktree that plain git can use,
 *  3. the shared `info/exclude` block is the union of every work-tree's `add` paths, and
 *     survives `apply`, `detach` and `doctor` in either tree,
 *  4. `remove` refuses to discard uncommitted overlay content and prunes what it removes,
 *  5. `doctor` is clean in both trees, and repairs a hand-linked overlay worktree.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanupAllSandboxes,
  expectFail,
  expectOk,
  makeSandbox,
  overgit,
  type CmdResult,
  type Repo,
  type Sandbox,
} from "./helpers/harness.ts";

afterAll(cleanupAllSandboxes);

async function ogOk(cwd: string, ...args: string[]): Promise<CmdResult> {
  return expectOk(await overgit(cwd, ...args));
}

interface Fixture {
  sb: Sandbox;
  base: Repo;
}

/** A base with an overlay that overrides `C.txt`, whites out `D.txt` and adds `A.txt`. */
async function mkFixture(label: string): Promise<Fixture> {
  const sb = await makeSandbox(label);
  const base = await sb.mkBaseRepo("base", {
    "B.txt": "base B\n",
    "C.txt": "base C\n",
    "D.txt": "base D\n",
  });
  await ogOk(base.dir, "init");
  await base.write("C.txt", "overlay C\n");
  await ogOk(base.dir, "add", "C.txt");
  await base.write("A.txt", "overlay A\n");
  await ogOk(base.dir, "add", "A.txt");
  await ogOk(base.dir, "rm", "D.txt");
  await ogOk(base.dir, "commit", "-m", "overlay v1");
  return { sb, base };
}

/** The managed block's pattern lines in the base's *common* `info/exclude`. */
async function blockLines(base: Repo): Promise<string[]> {
  return (await base.excludeLines()).filter((l) => l.startsWith("/"));
}

async function addWorktree(f: Fixture, name: string, ...extra: string[]): Promise<Repo> {
  const r = await ogOk(f.base.dir, "worktree", "add", f.sb.path(name), ...extra);
  expect(r.stdout).toContain(`created the work-tree`);
  return f.sb.adopt(name);
}

describe("overgit worktree add", () => {
  test("the new tree has the overlay applied and both bases are clean", async () => {
    const f = await mkFixture("wt-add");
    const wt = await addWorktree(f, "wt", "-b", "hotfix");

    expect(await wt.read("A.txt")).toBe("overlay A\n");
    expect(await wt.read("C.txt")).toBe("overlay C\n");
    expect(await wt.exists("D.txt")).toBe(false);
    expect(await wt.read("B.txt")).toBe("base B\n");
    expect(await wt.branch()).toBe("hotfix");
    expect((await wt.skipWorktreePaths()).sort()).toEqual(["C.txt", "D.txt"]);

    await f.base.assertClean();
    await wt.assertClean();

    // The manifest is materialised so every command in the new tree sees the ownership.
    const status = await ogOk(wt.dir, "status");
    expect(status.stdout).toContain("overlay owns 3 paths");
    expect(status.stdout).toContain("overlay     on branch hotfix");
  });

  test("the overlay in the new tree is a linked worktree that plain git can use", async () => {
    const f = await mkFixture("wt-linked");
    const wt = await addWorktree(f, "wt", "-b", "hotfix");

    // A gitfile, pointing into the main overlay's `worktrees/`.
    const gitfile = await readFile(join(wt.dir, ".overgit", ".git"), "utf8");
    expect(gitfile).toMatch(/^gitdir: .*\/base\/\.overgit\/\.git\/worktrees\//);

    // Plain git: correct work-tree root, shared history, its own branch.
    const top = await wt.gitRun(["-C", wt.path(".overgit"), "rev-parse", "--show-toplevel"]);
    expect(top.stdout.trim()).toBe(wt.dir);
    const log = await wt.gitRun(["-C", wt.path(".overgit"), "log", "--format=%s"]);
    expect(log.stdout).toContain("overlay v1");
    const head = await wt.gitRun(["-C", wt.path(".overgit"), "symbolic-ref", "--short", "HEAD"]);
    expect(head.stdout.trim()).toBe("hotfix");

    // The main overlay still works after the move to per-worktree config.
    const mainTop = await f.base.gitRun(["-C", f.base.path(".overgit"), "rev-parse", "--show-toplevel"]);
    expect(mainTop.stdout.trim()).toBe(f.base.dir);
    const shared = await f.base.gitRun(["-C", f.base.path(".overgit"), "config", "--local", "--get", "core.worktree"], { allowFailure: true });
    expect(shared.code).not.toBe(0);

    // `git clean -xfd` in the new tree spares the gitfile overlay.
    await wt.write(".overgit/scratch", "x");
    const clean = await wt.gitRun(["clean", "-xfdn"]);
    expect(clean.stdout).not.toContain(".overgit");
  });

  test("an overlay commit in the new tree is visible from the main one", async () => {
    const f = await mkFixture("wt-commit");
    const wt = await addWorktree(f, "wt", "-b", "hotfix");
    await wt.write("E.txt", "E\n");
    await ogOk(wt.dir, "add", "E.txt");
    await ogOk(wt.dir, "commit", "-m", "add E in hotfix");

    const log = await f.base.gitRun(["-C", f.base.path(".overgit"), "log", "--format=%s", "hotfix"]);
    expect(log.stdout.split("\n")[0]).toBe("add E in hotfix");
    // ...and it never leaked into either base.
    await f.base.assertClean();
    await wt.assertClean();
  });

  test("defaults, --overlay-branch, and an overlay branch already checked out", async () => {
    const f = await mkFixture("wt-branches");
    const list1 = await ogOk(f.base.dir, "worktree", "list");
    expect(list1.stdout).toContain("main, current");

    // No -b: the base is on a detached HEAD, the overlay branch is named after the directory.
    const detached = await addWorktree(f, "review", "HEAD");
    expect(await detached.branch()).toBeNull();
    const list2 = await ogOk(f.base.dir, "worktree", "list");
    expect(list2.stdout).toMatch(/review\s+\(detached HEAD\)\s+overlay review, 3 paths/);

    // An explicit overlay branch.
    await addWorktree(f, "wt2", "-b", "feature", "--overlay-branch", "mine");
    const list3 = await ogOk(f.base.dir, "worktree", "list");
    expect(list3.stdout).toMatch(/wt2\s+feature\s+overlay mine, 3 paths/);

    // The overlay branch `main` is checked out in the main tree: git refuses, and the
    // message says how to pick another and how to clean up the base tree git made.
    const r = expectFail(await overgit(f.base.dir, "worktree", "add", f.sb.path("wt3"), "-b", "main-again", "--overlay-branch", "main"));
    expect(r.stderr).toContain("linking the overlay into it failed");
    expect(r.stderr).toContain("--overlay-branch");
  });

  test("refuses while the overlay is detached, and with a bad subcommand", async () => {
    const f = await mkFixture("wt-refuse");
    await ogOk(f.base.dir, "detach");
    const r = expectFail(await overgit(f.base.dir, "worktree", "add", f.sb.path("wt")));
    expect(r.stderr).toContain("detached");
    expect(await f.sb.adopt("wt").exists(".")).toBe(false);

    const u = expectFail(await overgit(f.base.dir, "worktree", "frobnicate"), 2);
    expect(u.stderr).toContain("no subcommand");
  });
});

describe("the shared exclude block", () => {
  test("is the union of every work-tree's add paths, in every tree's view", async () => {
    const f = await mkFixture("wt-union");
    const wt = await addWorktree(f, "wt", "-b", "hotfix");
    expect(await blockLines(f.base)).toEqual(["/.overgit/", "/A.txt"]);

    await wt.write("E.txt", "E\n");
    await ogOk(wt.dir, "add", "E.txt");
    expect(await blockLines(f.base)).toEqual(["/.overgit/", "/A.txt", "/E.txt"]);

    // `apply` and `doctor --fix` in the main tree keep the sibling's line.
    const apply = await ogOk(f.base.dir, "apply");
    expect(apply.stdout).toContain("already up to date");
    expect(await blockLines(f.base)).toEqual(["/.overgit/", "/A.txt", "/E.txt"]);
    await ogOk(f.base.dir, "doctor", "--fix");
    expect(await blockLines(f.base)).toEqual(["/.overgit/", "/A.txt", "/E.txt"]);

    // Both trees consider it correct.
    expect((await ogOk(f.base.dir, "doctor")).stdout).toContain("no problems");
    expect((await ogOk(wt.dir, "doctor")).stdout).toContain("no problems");
    const st = await ogOk(f.base.dir, "status");
    expect(st.stdout).toContain("doctor   no problems");
  });

  test("a detached sibling contributes nothing; a removed one drops out", async () => {
    const f = await mkFixture("wt-detach");
    const wt = await addWorktree(f, "wt", "-b", "hotfix");
    await wt.write("E.txt", "E\n");
    await ogOk(wt.dir, "add", "E.txt");
    await ogOk(wt.dir, "commit", "-m", "E");

    await ogOk(wt.dir, "detach");
    expect(await blockLines(f.base)).toEqual(["/.overgit/", "/A.txt"]);
    // Sibling's `add` from the main tree, while `wt` is detached, still sees only itself.
    await f.base.write("F.txt", "F\n");
    await ogOk(f.base.dir, "add", "F.txt");
    expect(await blockLines(f.base)).toEqual(["/.overgit/", "/A.txt", "/F.txt"]);

    await ogOk(wt.dir, "attach");
    expect(await blockLines(f.base)).toEqual(["/.overgit/", "/A.txt", "/E.txt", "/F.txt"]);

    await ogOk(f.base.dir, "worktree", "remove", f.sb.path("wt"));
    expect(await blockLines(f.base)).toEqual(["/.overgit/", "/A.txt", "/F.txt"]);
  });

  test("a plain `git worktree add` tree without an overlay is left alone", async () => {
    const f = await mkFixture("wt-plain");
    await f.base.git("worktree", "add", "-q", "-b", "plain", f.sb.path("plain"));
    const plain = f.sb.adopt("plain");
    expect(await plain.exists(".overgit")).toBe(false);
    expect(await plain.read("C.txt")).toBe("base C\n");

    await ogOk(f.base.dir, "apply");
    expect(await blockLines(f.base)).toEqual(["/.overgit/", "/A.txt"]);
    expect((await ogOk(f.base.dir, "doctor")).stdout).toContain("no problems");
    const list = await ogOk(f.base.dir, "worktree", "list");
    expect(list.stdout).toMatch(/plain\s+plain\s+no overlay/);
    // And nothing overgit does makes that tree dirty.
    await plain.assertClean();
  });
});

describe("overgit worktree remove", () => {
  test("refuses to discard uncommitted overlay content, --force does, and prunes", async () => {
    const f = await mkFixture("wt-remove");
    const wt = await addWorktree(f, "wt", "-b", "hotfix");
    await wt.write("E.txt", "E\n");
    await ogOk(wt.dir, "add", "E.txt");

    const r = expectFail(await overgit(f.base.dir, "worktree", "remove", f.sb.path("wt")));
    expect(r.stderr).toContain("uncommitted change");
    expect(await wt.exists("E.txt")).toBe(true);

    const ok = await ogOk(f.base.dir, "worktree", "remove", f.sb.path("wt"), "--force");
    expect(ok.stdout).toContain("overlay branch hotfix is still");
    expect(await wt.exists(".")).toBe(false);

    const bases = await f.base.gitRun(["worktree", "list", "--porcelain"]);
    expect(bases.stdout).not.toContain("/wt\n");
    const overlays = await f.base.gitRun(["-C", f.base.path(".overgit"), "worktree", "list", "--porcelain"]);
    expect(overlays.stdout).not.toContain("/wt/");
    const branch = await f.base.gitRun(["-C", f.base.path(".overgit"), "rev-parse", "--verify", "hotfix"]);
    expect(branch.code).toBe(0);
    expect((await ogOk(f.base.dir, "doctor")).stdout).toContain("no problems");
  });

  test("refuses the main tree, the current tree, and a stranger", async () => {
    const f = await mkFixture("wt-remove-refuse");
    const wt = await addWorktree(f, "wt", "-b", "hotfix");
    expect(expectFail(await overgit(f.base.dir, "worktree", "remove", f.base.dir)).stderr).toContain("main work-tree");
    expect(expectFail(await overgit(wt.dir, "worktree", "remove", wt.dir)).stderr).toContain("you are in");
    expect(expectFail(await overgit(f.base.dir, "worktree", "remove", f.sb.path("nope"))).stderr).toContain("no such directory");
    await f.sb.adopt("stranger").mkdirp(".");
    expect(expectFail(await overgit(f.base.dir, "worktree", "remove", f.sb.path("stranger"))).stderr).toContain("not a work-tree");
  });
});

describe("doctor in a linked worktree", () => {
  test("repairs an overlay worktree linked by hand with plain git", async () => {
    const f = await mkFixture("wt-hand");
    await f.base.git("worktree", "add", "-q", "-b", "hand", f.sb.path("hand"));
    const hand = f.sb.adopt("hand");
    // What a user who read the man page would do: no worktree config, wrong work-tree.
    await f.base.git("-C", f.base.path(".overgit"), "worktree", "add", "-q", "--no-checkout", "-b", "hand", hand.path(".overgit"));

    // The missing manifest is reported first and alone (see `diagnose`); the config problem
    // surfaces once that is restored. Each `--fix` round fixes what it reported.
    let seen = "";
    let rounds = 0;
    while ((await overgit(hand.dir, "doctor")).code !== 0) {
      expect(rounds++).toBeLessThan(4);
      const r = await overgit(hand.dir, "doctor", "--fix");
      seen += r.stdout + r.stderr;
    }
    // Both config files were repaired: the shared one (the extension) and the per-worktree one.
    expect(seen).toMatch(/overlay-config-broken\s+\S+\/\.overgit\/\.git\/config\n/);
    expect(seen).toMatch(/overlay-config-broken\s+\S+\/worktrees\/[^/]+\/config\.worktree\n/);
    expect(rounds).toBeGreaterThan(0);
    const top = await hand.gitRun(["-C", hand.path(".overgit"), "rev-parse", "--show-toplevel"]);
    expect(top.stdout.trim()).toBe(hand.dir);
    // The main overlay is still usable.
    expect((await ogOk(f.base.dir, "doctor")).stdout).toContain("no problems");
  });
});
