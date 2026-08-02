/**
 * Regressions found by a blind UX review — a reviewer working from `README.md` only, with
 * the source deliberately out of reach.
 *
 * Each of these was a case where the tool told the user something that was wrong, told them
 * to run something that failed, or reported success while doing nothing. They are grouped
 * here because they share a cause worth naming: every one was invisible to a reviewer who
 * could read the implementation, and obvious to one who could not.
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
  type Upstream,
} from "./helpers/harness.ts";

let sb: Sandbox;

beforeEach(async () => {
  sb = await makeSandbox("ux");
});

afterAll(cleanupAllSandboxes);

/** A base clone with one override, plus its upstream, so upstream can be moved. */
async function mkOverridden(): Promise<{ base: Repo; upstream: Upstream }> {
  const upstream = await sb.mkUpstream("upstream", {
    "cfg/app.toml": "port = 8080\n",
    "other.txt": "untouched\n",
  });
  const base = await upstream.clone("base");
  expectOk(await overgit(base.dir, "init"));
  await base.write("cfg/app.toml", "port = 3000\n");
  expectOk(await overgit(base.dir, "add", "cfg/app.toml"));
  expectOk(await overgit(base.dir, "commit", "-m", "overlay"));
  return { base, upstream };
}

describe("blindness between fetch and pull", () => {
  test("status names the un-pulled commits and the owned path they touch", async () => {
    const { base, upstream } = await mkOverridden();
    await upstream.changeFile("cfg/app.toml", "port = 8080\nworkers = 4\n");
    await base.git("fetch"); // fetch only — the base's HEAD has NOT moved

    const r = expectOk(await overgit(base.dir, "status"));
    // The bug: every diagnostic said "none" / "no problems" / "up to date" while the change
    // sat in the base's refs. Plain `git status` was more informative than the merged view.
    expect(r.stdout).toContain("not yet pulled");
    expect(r.stdout).toContain("cfg/app.toml");
    expect(r.stdout).toContain("detach");
  });

  test("`sync --dry-run` does not claim to be up to date when it isn't", async () => {
    const { base, upstream } = await mkOverridden();
    await upstream.changeFile("cfg/app.toml", "port = 8080\nworkers = 4\n");
    await base.git("fetch");

    const r = await overgit(base.dir, "sync", "--dry-run");
    // "already up to date" full stop was a *wrong answer*, not merely a quiet one.
    expect(r.stdout).toContain("ahead and has not been pulled");
    expect(r.stdout).toContain("cfg/app.toml");
  });

  test("un-pulled commits that touch nothing owned say so, rather than alarming", async () => {
    const { base, upstream } = await mkOverridden();
    await upstream.changeFile("other.txt", "upstream edited this\n");
    await base.git("fetch");

    const r = expectOk(await overgit(base.dir, "status"));
    expect(r.stdout).toContain("nothing the overlay owns");
  });
});

describe("status and doctor must not contradict each other", () => {
  test("a stray skip-worktree bit is reported by both, not just doctor", async () => {
    const { base } = await mkOverridden();
    // A bit overgit does not own: doctor reports it, status used to say "no problems".
    await base.git("update-index", "--skip-worktree", "other.txt");

    const status = expectOk(await overgit(base.dir, "status"));
    const doctor = await overgit(base.dir, "doctor");

    expect(doctor.code).toBe(4);
    expect(status.stdout).not.toContain("doctor   no problems");
    expect(status.stdout).toContain("run `overgit doctor`");
  });
});

describe("the tool never sends you into its own error", () => {
  test("mid-conflict, status suggests --continue rather than a bare sync", async () => {
    const { base, upstream } = await mkOverridden();
    await upstream.changeFile("cfg/app.toml", "port = 9999\nworkers = 4\n");
    expectOk(await overgit(base.dir, "detach"));
    await base.git("pull");
    expectOk(await overgit(base.dir, "attach"));

    const sync = await overgit(base.dir, "sync");
    expect(sync.code).toBe(3); // conflicted

    const r = expectOk(await overgit(base.dir, "status"));
    expect(r.stdout).toContain("overgit sync --continue");
    // A bare `overgit sync` here errors with SYNC_IN_PROGRESS, so it must not be advertised.
    expect(r.stdout).not.toMatch(/run `overgit sync` to merge/);
  });

  test("`sync --continue` after `resolve` finished the sync is a no-op, not an error", async () => {
    const { base, upstream } = await mkOverridden();
    await upstream.changeFile("cfg/app.toml", "port = 9999\nworkers = 4\n");
    expectOk(await overgit(base.dir, "detach"));
    await base.git("pull");
    expectOk(await overgit(base.dir, "attach"));
    await overgit(base.dir, "sync");

    await base.write("cfg/app.toml", "port = 3000\nworkers = 4\n");
    expectOk(await overgit(base.dir, "resolve", "cfg/app.toml"));
    // The conflict message tells the user to run both, so both must work.
    expectOk(await overgit(base.dir, "sync", "--continue"));
  });

  test("an in-progress sync alone does not make doctor exit 4", async () => {
    const { base, upstream } = await mkOverridden();
    await upstream.changeFile("cfg/app.toml", "port = 9999\nworkers = 4\n");
    expectOk(await overgit(base.dir, "detach"));
    await base.git("pull");
    expectOk(await overgit(base.dir, "attach"));
    await overgit(base.dir, "sync"); // leaves a conflict, hence a sync in progress

    const r = await overgit(base.dir, "doctor");
    expect(r.stdout + r.stderr).toContain("sync-in-progress");
    // It is a state the user was told to be in, not an inconsistency; scripts testing
    // `overgit doctor` for problems must not fire spuriously mid-conflict.
    expect(r.code).toBe(0);
  });
});

describe("global option errors do not contradict the help", () => {
  test("an unknown global option lists the options overgit actually takes", async () => {
    const { base } = await mkOverridden();
    const r = expectFail(await overgit(base.dir, "--frobnicate"), 2);
    expect(r.stderr).not.toContain("takes no options");
    expect(r.stderr).toContain("-C");
    expect(r.stderr).toContain("--no-color");
  });
});

describe("`which` answers the question `list` makes you scan for", () => {
  test("it names the owner and kind, and exits 1 for anything unowned", async () => {
    const { base } = await mkOverridden();
    await base.write("loose.txt", "mine, but not taken\n");

    const owned = expectOk(await overgit(base.dir, "which", "cfg/app.toml"));
    expect(owned.stdout).toContain("the overlay owns this");
    expect(owned.stdout).toContain("override");

    const mixed = expectFail(await overgit(base.dir, "which", "cfg/app.toml", "loose.txt"), 1);
    expect(mixed.stdout).toContain("not tracked by either");

    const baseOwned = expectFail(await overgit(base.dir, "which", "other.txt"), 1);
    expect(baseOwned.stdout).toContain("the base tracks this");
  });

  test("--porcelain is NUL-terminated with the path last", async () => {
    const { base } = await mkOverridden();
    const r = expectOk(await overgit(base.dir, "which", "--porcelain", "cfg/app.toml"));
    expect(r.stdout).toBe("overlay\toverride\tcfg/app.toml\0");
  });
});
