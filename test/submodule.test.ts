/**
 * Submodules are not overlay territory.
 *
 * A file under a submodule belongs to the submodule's own repository: the base's index holds
 * a single gitlink (mode 160000) for the whole subtree, there is no blob to fork from, and
 * the base's `.git/info/exclude` does not govern files inside a nested repo. Taking one used
 * to silently succeed and produce an overlay entry that no `apply` on another machine could
 * reproduce; taking the submodule *directory* leaked a raw git error about `vendor/lib/.git`.
 *
 * These tests drive the real CLI, because the defect was only visible end to end.
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
  sb = await makeSandbox("submodule");
});

afterAll(cleanupAllSandboxes);

/** A base repo with `vendor/lib` as a real submodule, plus an initialised overlay. */
async function mkFixture(): Promise<Repo> {
  const lib = await sb.mkBaseRepo("lib", { "lib.txt": "from the library\n" });
  const base = await sb.mkBaseRepo("base", { "a.txt": "base a\n" });

  // Local-path submodules are refused by default since git 2.38 (CVE-2022-39253).
  await base.git("-c", "protocol.file.allow=always", "submodule", "add", "--quiet", lib.dir, "vendor/lib");
  await base.commit("add submodule");

  expectOk(await overgit(base.dir, "init"));
  return base;
}

describe("submodules are refused, not silently absorbed", () => {
  test("the base index really does hold a gitlink", async () => {
    const base = await mkFixture();
    const entry = (await base.git("ls-files", "-s", "vendor/lib")).stdout;
    expect(entry).toContain("160000");
  });

  test("`add <submodule>` fails with a submodule error, not a raw git error", async () => {
    const base = await mkFixture();
    const r = expectFail(await overgit(base.dir, "add", "vendor/lib"), 1);
    expect(r.stderr).toContain("vendor/lib is a submodule");
    expect(r.stderr).toContain("git -C vendor/lib");
    // The regression: git's own complaint about the gitlink must never reach the user.
    expect(r.stderr).not.toContain("update-index");
    expect(r.stderr).not.toContain("Invalid path");
    expect(r.stderr).not.toContain("fatal:");
  });

  test("`add <file inside a submodule>` is refused and owns nothing", async () => {
    const base = await mkFixture();
    const r = expectFail(await overgit(base.dir, "add", "vendor/lib/lib.txt"), 1);
    expect(r.stderr).toContain("inside the submodule vendor/lib");

    const list = expectOk(await overgit(base.dir, "list"));
    expect(list.stdout.trim()).not.toContain("vendor/lib");
  });

  test("`rm <file inside a submodule>` is refused too", async () => {
    const base = await mkFixture();
    const r = expectFail(await overgit(base.dir, "rm", "vendor/lib/lib.txt"), 1);
    expect(r.stderr).toContain("inside the submodule vendor/lib");
    // The submodule's file is still there — a refusal must not delete anything.
    expect(await base.exists("vendor/lib/lib.txt")).toBe(true);
  });

  test("expanding a directory skips submodule contents rather than failing", async () => {
    const base = await mkFixture();
    await base.write("vendor/notes.txt", "mine\n");

    const r = expectOk(await overgit(base.dir, "add", "vendor"));
    expect(r.stdout).toContain("vendor/notes.txt");
    expect(r.stdout).toContain("inside the submodule vendor/lib");
    expect(r.stdout).not.toContain("vendor/lib/lib.txt  was untracked");

    const list = expectOk(await overgit(base.dir, "list"));
    expect(list.stdout).toContain("vendor/notes.txt");
    expect(list.stdout).not.toContain("vendor/lib/lib.txt");
  });

  test("the base stays clean throughout, submodule included", async () => {
    const base = await mkFixture();
    await base.write("vendor/notes.txt", "mine\n");
    expectOk(await overgit(base.dir, "add", "vendor"));
    expectFail(await overgit(base.dir, "add", "vendor/lib/lib.txt"), 1);

    expect((await base.git("status", "--porcelain")).stdout).toBe("");
    expect((await base.git("diff")).stdout).toBe("");
    // `git status` in a superproject also reports dirty submodules; there must be none.
    expect((await base.git("status", "--porcelain", "--ignore-submodules=none")).stdout).toBe("");
  });
});
