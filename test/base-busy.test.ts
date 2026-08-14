/**
 * The ownership commands while the base repository is in the middle of something.
 *
 * A conflicted merge fills the base's index with stage 1/2/3 entries: `update-index
 * --skip-worktree` fails on them, `HEAD:<path>` is not the blob the user is looking at, and
 * there is no single "the base's version" for the manifest to fork from. `add`, `rm` and
 * `restore` went ahead anyway and recorded a manifest that was quietly wrong — the guard
 * that says otherwise was written, argued its own case in a doc comment, and was wired to
 * nothing.
 *
 * The list of markers is the other half: doctor's copy knew about `sequencer`, the copy
 * these commands would have used did not, so a multi-commit cherry-pick was invisible to
 * exactly the commands that write the manifest. There is one list now.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanupAllSandboxes,
  expectFail,
  expectOk,
  makeSandbox,
  overgit,
  type Repo,
  type Sandbox,
} from "./helpers/harness.ts";

let sb: Sandbox;

beforeEach(async () => {
  sb = await makeSandbox("base-busy");
});

afterAll(cleanupAllSandboxes);

/**
 * A base with an overlay that owns `owned.txt`, and a real conflicted merge in progress on
 * `shared.txt`. Nothing here is faked: the markers are the ones git wrote.
 */
async function mkConflicted(): Promise<Repo> {
  const base = await sb.mkBaseRepo("base", { "shared.txt": "one\n", "owned.txt": "base\n" });
  expectOk(await overgit(base.dir, "init"));
  await base.write("owned.txt", "overlay\n");
  expectOk(await overgit(base.dir, "add", "owned.txt"));
  expectOk(await overgit(base.dir, "commit", "-m", "overlay"));

  await base.git("checkout", "-b", "other");
  await base.write("shared.txt", "their side\n");
  await base.commit("other side");
  await base.git("checkout", "main");
  await base.write("shared.txt", "our side\n");
  await base.commit("our side");

  const m = await base.gitTry("merge", "other");
  expect(m.code, "the merge was supposed to conflict").not.toBe(0);
  expect(await base.exists(".git/MERGE_HEAD")).toBe(true);
  return base;
}

/** What the manifest owns, as the CLI reports it. */
async function owned(base: Repo): Promise<string[]> {
  const r = expectOk(await overgit(base.dir, "list", "--porcelain"));
  return r.stdout
    .split("\0")
    .filter((s) => s.length > 0)
    .map((s) => s.split("\t")[1]!);
}

describe("mid-merge, the ownership commands refuse instead of guessing", () => {
  test("`add` of the conflicted path refuses, names the way out, and writes nothing", async () => {
    const base = await mkConflicted();

    const r = expectFail(await overgit(base.dir, "add", "shared.txt"), 1);
    expect(r.stderr).toContain("in the middle of a merge");
    expect(r.stderr).toContain("git merge --continue");
    expect(r.stderr).toContain("git merge --abort");

    expect(await owned(base)).toEqual(["owned.txt"]);
    expect(await base.excludeLines()).toEqual(["/.overgit/"]);
  });

  test("`add` of an unrelated path refuses too — the index is what is unusable", async () => {
    const base = await mkConflicted();
    await base.write("new.txt", "mine\n");

    expect(expectFail(await overgit(base.dir, "add", "new.txt"), 1).stderr).toContain(
      "in the middle of a merge",
    );
    expect(await owned(base)).toEqual(["owned.txt"]);
  });

  test("`rm` and `restore` refuse on the same terms", async () => {
    const base = await mkConflicted();

    for (const cmd of ["rm", "restore"]) {
      const r = expectFail(await overgit(base.dir, cmd, "owned.txt"), 1);
      expect(r.stderr, cmd).toContain("in the middle of a merge");
      expect(r.stderr, cmd).toContain(`\`overgit ${cmd}\``);
    }

    // The whole point: `owned.txt` is still an override, still hidden, still the overlay's.
    expect(await owned(base)).toEqual(["owned.txt"]);
    expect(await base.read("owned.txt")).toBe("overlay\n");
    expect(await base.skipWorktreePaths()).toEqual(["owned.txt"]);
  });

  test("finishing the merge lets the very same command through", async () => {
    const base = await mkConflicted();
    expectFail(await overgit(base.dir, "add", "shared.txt"), 1);

    await base.git("merge", "--abort");
    expect(await base.exists(".git/MERGE_HEAD")).toBe(false);

    await base.write("shared.txt", "mine now\n");
    expectOk(await overgit(base.dir, "add", "shared.txt"));
    expect((await owned(base)).sort()).toEqual(["owned.txt", "shared.txt"]);
    await base.assertClean();
  });
});

describe("every marker git can leave behind counts, not just MERGE_HEAD", () => {
  test("a bare `sequencer` directory — a cherry-pick or revert between commits", async () => {
    const base = await sb.mkBaseRepo("base", { "f.txt": "base\n" });
    expectOk(await overgit(base.dir, "init"));
    await base.write("new.txt", "mine\n");

    await mkdir(join(await base.gitDir(), "sequencer"), { recursive: true });

    const r = expectFail(await overgit(base.dir, "add", "new.txt"), 1);
    expect(r.stderr).toContain("cherry-pick or revert sequence");
    expect(await owned(base)).toEqual([]);
  });

  test("mid-rebase counts, and says how to end a rebase", async () => {
    const base = await sb.mkBaseRepo("base", { "f.txt": "base\n" });
    expectOk(await overgit(base.dir, "init"));
    await base.write("new.txt", "mine\n");

    await mkdir(join(await base.gitDir(), "rebase-merge"), { recursive: true });

    const r = expectFail(await overgit(base.dir, "add", "new.txt"), 1);
    expect(r.stderr).toContain("in the middle of a rebase");
    expect(r.stderr).toContain("git rebase --abort");
  });
});
