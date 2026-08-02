/**
 * Directory arguments to `add`, `rm` and `restore`.
 *
 * `add` expanded directories from the start; `rm` and `restore` refused them, which is an
 * asymmetry a user hits within minutes. The obvious workaround — a shell glob like
 * `docs/*.md` — silently misses nested files and dotfiles, so it is worse than an error.
 *
 * The expansion comes from the base index and the manifest, never from the work-tree: a
 * whited-out path is *absent* from the work-tree, and those are exactly the paths a
 * `restore <dir>` most needs to bring back.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

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
  sb = await makeSandbox("dirs");
});

afterAll(cleanupAllSandboxes);

async function mkBase(): Promise<Repo> {
  const upstream = await sb.mkUpstream("upstream", {
    "docs/a.md": "a\n",
    "docs/b.md": "b\n",
    "docs/sub/c.md": "c\n",
    "docs/.hidden": "dot\n",
    "README.md": "readme\n",
  });
  const base = await upstream.clone("base");
  expectOk(await overgit(base.dir, "init"));
  return base;
}

/** The base must not be able to see or capture anything after the operation. */
async function assertBaseBlind(base: Repo, label: string): Promise<void> {
  expect((await base.git("status", "--porcelain")).stdout, `${label}: status`).toBe("");
  await base.git("add", "-A");
  const staged = (await base.git("diff", "--cached", "--name-only")).stdout.trim();
  await base.gitTry("reset");
  expect(staged, `${label}: git add -A captured something`).toBe("");
}

describe("`overgit rm <directory>`", () => {
  test("whites out every file under it, recursively, dotfiles included", async () => {
    const base = await mkBase();
    const r = expectOk(await overgit(base.dir, "rm", "docs"));

    for (const p of ["docs/a.md", "docs/b.md", "docs/sub/c.md", "docs/.hidden"]) {
      expect(r.stdout, `expected ${p} in the output`).toContain(p);
    }
    // A shell glob (`docs/*.md`) would have missed both of these.
    expect(r.stdout).toContain("docs/sub/c.md");
    expect(r.stdout).toContain("docs/.hidden");

    const list = expectOk(await overgit(base.dir, "list"));
    expect(list.stdout).toContain("docs/sub/c.md");

    await assertBaseBlind(base, "after rm of a directory");
    // The base still believes every one of them is present and unmodified.
    expect((await base.git("ls-files", "docs")).stdout.trim().split("\n").length).toBe(4);
  });

  test("prunes the directory itself, because git cannot represent an empty one", async () => {
    const base = await mkBase();
    expectOk(await overgit(base.dir, "rm", "docs"));
    // Leaving an empty husk would make the tree differ from what a fresh `overgit clone`
    // produces, which would break the round-trip guarantee.
    expect(await base.exists("docs")).toBe(false);
  });

  test("a directory git knows nothing about is skipped, not silently deleted", async () => {
    const base = await mkBase();
    await base.write("scratch/notes.txt", "untracked\n");

    const r = expectOk(await overgit(base.dir, "rm", "scratch"));
    expect(r.stdout + r.stderr).toContain("nothing tracked by the base");
    // Deleting untracked files is not overgit's business.
    expect(await base.exists("scratch/notes.txt")).toBe(true);
  });

  test("a nonexistent path is still an error", async () => {
    const base = await mkBase();
    const r = expectFail(await overgit(base.dir, "rm", "nope"), 1);
    expect(r.stderr).toContain("does not exist");
  });
});

describe("`overgit restore <directory>`", () => {
  test("brings back every whited-out file under it", async () => {
    const base = await mkBase();
    expectOk(await overgit(base.dir, "rm", "docs"));
    expect(await base.exists("docs")).toBe(false);

    // The work-tree cannot be the expansion source here: every path is absent from it.
    const r = expectOk(await overgit(base.dir, "restore", "docs"));
    expect(r.stdout).toContain("docs/sub/c.md");

    expect(await base.read("docs/a.md")).toBe("a\n");
    expect(await base.read("docs/sub/c.md")).toBe("c\n");
    expect(await base.read("docs/.hidden")).toBe("dot\n");
    expect((await base.git("status", "--porcelain")).stdout).toBe("");
    expect((await overgit(base.dir, "list")).stdout).not.toContain("docs/");
  });

  test("round-trips: rm a directory, restore it, tree is byte-identical", async () => {
    const base = await mkBase();
    const before = await base.snapshot();
    expectOk(await overgit(base.dir, "rm", "docs"));
    expectOk(await overgit(base.dir, "restore", "docs"));
    const after = await base.snapshot();
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });
});

describe("`overgit add <directory>` keeps working", () => {
  test("it expands, and mixed directories validate before mutating anything", async () => {
    const base = await mkBase();
    await base.write("mine/x.txt", "x\n");
    await base.write("mine/y.txt", "y\n");
    const r = expectOk(await overgit(base.dir, "add", "mine"));
    expect(r.stdout).toContain("mine/x.txt");
    expect(r.stdout).toContain("mine/y.txt");

    // A directory holding an add with uncommitted overlay changes must refuse *before*
    // touching anything — validate-everything-then-mutate, so nothing is left half-done.
    const bad = expectFail(await overgit(base.dir, "rm", "mine"), 1);
    expect(bad.stderr).toContain("uncommitted changes");
    expect(await base.exists("mine/x.txt")).toBe(true);
    expect(await base.exists("mine/y.txt")).toBe(true);
    await assertBaseBlind(base, "after a refused rm");
  });
});
