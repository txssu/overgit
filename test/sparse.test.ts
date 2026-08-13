/**
 * `core.sparseCheckout=true` in the base is the one configuration that silently defeats the
 * whole mechanism.
 *
 * Measured on git 2.55: with sparse checkout on, git *clears* the
 * skip-worktree bit on any file that is present in the work-tree. Every override then shows
 * up as an ordinary modification and the next `git add -A` in the base commits it — a total,
 * silent invisibility failure. It is why overgit never enables sparse checkout itself, but a
 * user may already have it on for their own reasons, and the tool has to cope with that.
 *
 * Before these tests existed, overgit did the worst possible thing: it carried on and leaked.
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
  sb = await makeSandbox("sparse");
});

afterAll(cleanupAllSandboxes);

async function mkBase(): Promise<Repo> {
  const base = await sb.mkBaseRepo("base", {
    "cfg/app.conf": "base cfg\n",
    "keep.txt": "base keep\n",
  });
  expectOk(await overgit(base.dir, "init"));
  return base;
}

describe("core.sparseCheckout in the base", () => {
  test("git really does clear the skip-worktree bit (the reason for all of this)", async () => {
    const base = await mkBase();
    await base.write("cfg/app.conf", "overlay cfg\n");
    expectOk(await overgit(base.dir, "add", "cfg/app.conf"));
    expect(await base.skipWorktreePaths()).toContain("cfg/app.conf");

    await base.git("config", "core.sparseCheckout", "true");
    await base.git("status", "--porcelain"); // this is what clears it

    expect(await base.skipWorktreePaths()).not.toContain("cfg/app.conf");
    // …and the override is now nakedly visible to the base.
    expect((await base.git("status", "--porcelain")).stdout).toContain("cfg/app.conf");
  });

  test("`add` refuses while sparse checkout is on", async () => {
    const base = await mkBase();
    await base.git("config", "core.sparseCheckout", "true");
    await base.write("cfg/app.conf", "overlay cfg\n");

    const r = expectFail(await overgit(base.dir, "add", "cfg/app.conf"), 1);
    expect(r.stderr).toContain("core.sparseCheckout");
    expect(r.stderr).toContain("git config --unset core.sparseCheckout");
    // Nothing was taken.
    expect((await overgit(base.dir, "list")).stdout).toContain("owns nothing");
  });

  test("`rm`, `restore` and `apply` refuse too", async () => {
    const base = await mkBase();
    // Own something first, so `restore` reaches the guard instead of short-circuiting on
    // "the overlay owns nothing".
    await base.write("cfg/app.conf", "overlay cfg\n");
    expectOk(await overgit(base.dir, "add", "cfg/app.conf"));
    expectOk(await overgit(base.dir, "commit", "-m", "overlay"));

    await base.git("config", "core.sparseCheckout", "true");
    for (const argv of [["rm", "keep.txt"], ["restore", "--all"], ["apply"]]) {
      const r = expectFail(await overgit(base.dir, ...argv), 1);
      expect(r.stderr).toContain("core.sparseCheckout");
    }
  });

  test("doctor names the root cause and does not offer a fix that would loop", async () => {
    const base = await mkBase();
    await base.write("cfg/app.conf", "overlay cfg\n");
    expectOk(await overgit(base.dir, "add", "cfg/app.conf"));
    await base.git("config", "core.sparseCheckout", "true");
    await base.git("status", "--porcelain");

    const r = await overgit(base.dir, "doctor");
    expect(r.stdout + r.stderr).toContain("base-sparse-checkout");
    // The symptom must NOT be reported as a fixable problem: setting the bit again would
    // just be cleared by git on the next status, for ever.
    expect(r.stdout + r.stderr).not.toContain("missing-skip-worktree");
    // …and it must not advertise an automatic fix for it, because there isn't one that
    // sticks: git clears the bit again on the next status.
    expect(r.stdout + r.stderr).not.toContain("run `overgit doctor --fix`");
    expect(r.stdout + r.stderr).toMatch(/not fixable automatically|none of them fixable/);
  });

  test("disabling it lets doctor --fix put everything back", async () => {
    const base = await mkBase();
    await base.write("cfg/app.conf", "overlay cfg\n");
    expectOk(await overgit(base.dir, "add", "cfg/app.conf"));
    expectOk(await overgit(base.dir, "commit", "-m", "overlay"));

    await base.git("config", "core.sparseCheckout", "true");
    await base.git("status", "--porcelain");
    await base.git("config", "--unset", "core.sparseCheckout");

    expectOk(await overgit(base.dir, "doctor", "--fix"));
    expect(await base.skipWorktreePaths()).toContain("cfg/app.conf");
    expect((await base.git("status", "--porcelain")).stdout).toBe("");
    expect((await base.git("diff")).stdout).toBe("");
    expect(await base.read("cfg/app.conf")).toBe("overlay cfg\n");
  });
});
