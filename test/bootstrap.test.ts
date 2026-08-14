/**
 * Bootstrap integration tests: `src/bootstrap.ts`, including detach/attach.
 *
 * Everything drives `bin/overgit` out of process, the way a user does, and never imports
 * `src/*` for an assertion. The properties under test, in rough order of how much they
 * matter:
 *
 *  1. one command reproduces the merged tree on a machine that has never seen the overlay,
 *  2. running that command again is a clean no-op,
 *  3. a run killed mid-clone never wedges the next one,
 *  4. the overlay never bulk-checkouts over the base's files,
 *  5. `detach` produces a byte-exact pristine base checkout and `attach` undoes it exactly,
 *  6. hooks are opt-in, preserve whatever was in the file, and cannot fail a git command.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  BUN_BIN,
  CLI_ENTRY,
  cleanupAllSandboxes,
  compareTrees,
  describeResult,
  envForPath,
  expectExit,
  expectOk,
  formatTree,
  makeSandbox,
  overgit as realOvergit,
  pathExists,
  runCommand,
  snapshotTree,
  type CmdResult,
  type Repo,
  type Sandbox,
  type Upstream,
} from "./helpers/harness.ts";
import { assertCleanSafe } from "./helpers/clean.ts";

/* ==================================================================== the CLI runner */

/** The argv `bin/overgit` is spawned with, so a hook shim can reproduce it. */
export function cliArgv(): string[] {
  return [BUN_BIN, "--env-file=/dev/null", CLI_ENTRY];
}

/** Run overgit in `cwd`. Resolves for any exit code. */
async function og(cwd: string, ...args: string[]): Promise<CmdResult> {
  return realOvergit(cwd, ...args);
}

async function ogOk(cwd: string, ...args: string[]): Promise<CmdResult> {
  return expectOk(await og(cwd, ...args));
}

/** A `PATH` entry holding an `overgit` executable, so git hooks can find one. */
async function makeOvergitShim(sb: Sandbox): Promise<string> {
  const dir = sb.path("shim-bin");
  await Bun.write(
    join(dir, "overgit"),
    `#!/bin/sh\nexec ${cliArgv().map((a) => `'${a}'`).join(" ")} "$@"\n`,
  );
  await runCommand(["chmod", "+x", join(dir, "overgit")], { cwd: sb.dir, env: sb.env });
  return dir;
}

afterAll(cleanupAllSandboxes);

/* ==================================================================== fixtures */

const OVERLAY_C = "overlay C\n";
const OVERLAY_A = "overlay A\n";

interface Fixture {
  sb: Sandbox;
  baseUpstream: Upstream;
  overlayRemote: Repo;
  base: Repo;
}

/**
 * A base clone with an overlay that overrides `C.txt`, whites out `D.txt` and adds
 * `A.txt`, pushed to a bare "remote". This is the standard overlay fixture, built with the
 * real commands rather than by hand.
 */
async function mkFixture(label: string): Promise<Fixture> {
  const sb = await makeSandbox(label);
  const baseUpstream = await sb.mkUpstream("base-remote", {
    "B.txt": "base B\n",
    "C.txt": "base C\n",
    "D.txt": "base D\n",
  });
  const overlayRemote = await sb.mkBareRepo("overlay-remote");
  const base = await baseUpstream.clone("base");

  await ogOk(base.dir, "init", "--remote", overlayRemote.dir);
  await base.write("C.txt", OVERLAY_C);
  await ogOk(base.dir, "add", "C.txt");
  await base.write("A.txt", OVERLAY_A);
  await ogOk(base.dir, "add", "A.txt");
  await ogOk(base.dir, "rm", "D.txt");
  await ogOk(base.dir, "commit", "-m", "overlay v1");
  await ogOk(base.dir, "push", "-u", "origin", "main");

  return { sb, baseUpstream, overlayRemote, base };
}

/** `git clean -xfd`-safe deep read of a file, for byte comparisons. */
async function bytes(p: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(p));
}

function stderrIsQuiet(r: CmdResult): void {
  expect(r.stderr).not.toMatch(/error|fatal|warning|traceback/i);
}

/* ==================================================================== init */

describe("overgit init", () => {
  test(
    "creates the overlay, commits an empty manifest, and hides itself from the base",
    async () => {
      const sb = await makeSandbox("init-basic");
      try {
        const base = await sb.mkBaseRepo("base", { "B.txt": "base B\n" });
        const r = await ogOk(base.dir, "init");
        stderrIsQuiet(r);

        // The overlay GIT_DIR is `.overgit/.git`, a *real* repository, so
        // `git clean -xfd` cannot destroy it.
        expect(await base.exists(".overgit/.git/HEAD")).toBe(true);
        expect(await base.exists(".overgit/manifest.json")).toBe(true);
        expect(JSON.parse(await base.read(".overgit/manifest.json"))).toEqual({
          version: 1,
          entries: {},
        });

        const cfg = await base.read(".overgit/.git/config");
        expect(cfg).toContain("worktree = ../..");
        expect(cfg).toMatch(/bare = false/);
        expect(cfg).toMatch(/showUntrackedFiles = no/);

        // HEAD must resolve — without a commit nothing could ever clone this overlay.
        const head = await base.gitRun([
          "--git-dir",
          base.path(".overgit/.git"),
          "rev-parse",
          "HEAD",
        ]);
        expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40,64}$/);

        expect(await base.excludeLines()).toContain("/.overgit/");
        await base.assertClean();
        await assertCleanSafe(base.dir, { label: "after init" });
      } finally {
        await sb.cleanup();
      }
    },
    30_000,
  );

  test(
    "refuses a second init and points at `overgit apply`",
    async () => {
      const sb = await makeSandbox("init-twice");
      try {
        const base = await sb.mkBaseRepo("base");
        await ogOk(base.dir, "init");
        const headBefore = (
          await base.gitRun(["--git-dir", base.path(".overgit/.git"), "rev-parse", "HEAD"])
        ).stdout.trim();

        const again = expectExit(await og(base.dir, "init"), 1);
        expect(again.stderr).toContain("overgit apply");
        expect(again.stderr.toLowerCase()).toContain("already");

        const headAfter = (
          await base.gitRun(["--git-dir", base.path(".overgit/.git"), "rev-parse", "HEAD"])
        ).stdout.trim();
        expect(headAfter).toBe(headBefore);
        await base.assertClean();
      } finally {
        await sb.cleanup();
      }
    },
    30_000,
  );

  test(
    "--remote configures origin and the branch upstream; --branch picks the branch",
    async () => {
      const sb = await makeSandbox("init-opts");
      try {
        const base = await sb.mkBaseRepo("base");
        const remote = await sb.mkBareRepo("overlay-remote");
        await ogOk(base.dir, "init", "--remote", remote.dir, "--branch", "overlay-main");

        const gd = ["--git-dir", base.path(".overgit/.git")];
        expect((await base.gitRun([...gd, "config", "--get", "remote.origin.url"])).stdout.trim())
          .toBe(remote.dir);
        expect((await base.gitRun([...gd, "symbolic-ref", "--short", "HEAD"])).stdout.trim())
          .toBe("overlay-main");
        expect(
          (await base.gitRun([...gd, "config", "--get", "branch.overlay-main.remote"])).stdout.trim(),
        ).toBe("origin");

        // The configured upstream is what makes `overgit push` work with no arguments.
        await ogOk(base.dir, "push");
        expect((await remote.gitRun(["rev-parse", "overlay-main"])).stdout.trim()).toMatch(
          /^[0-9a-f]{40,64}$/,
        );
      } finally {
        await sb.cleanup();
      }
    },
    30_000,
  );
});

/* ==================================================================== clone */

describe("overgit clone (inside an existing base checkout)", () => {
  test(
    "reproduces the merged tree, and a second run is a no-op",
    async () => {
      const f = await mkFixture("clone-in-base");
      try {
        const want = await f.base.snapshot();
        const fresh = await f.baseUpstream.clone("fresh");

        const first = await ogOk(fresh.dir, "clone", f.overlayRemote.dir);
        stderrIsQuiet(first);

        const got = await fresh.snapshot();
        const d = compareTrees(want, got, { a: "original", b: "fresh clone" });
        expect(d.text).toBe("");
        expect(d.equal).toBe(true);

        expect(await fresh.skipWorktreePaths()).toEqual(["C.txt", "D.txt"]);
        expect(await fresh.excludeLines()).toEqual(["/.overgit/", "/A.txt"]);
        await fresh.assertClean();
        await assertCleanSafe(fresh.dir, { label: "fresh clone" });

        // ── the same command again: nothing at all changes ──
        const overlayHeadBefore = (
          await fresh.gitRun(["--git-dir", fresh.path(".overgit/.git"), "rev-parse", "HEAD"])
        ).stdout.trim();
        const before = await fresh.snapshot();

        const second = expectOk(await og(fresh.dir, "clone", f.overlayRemote.dir));
        stderrIsQuiet(second);

        expect(compareTrees(before, await fresh.snapshot()).text).toBe("");
        expect(
          (await fresh.gitRun(["--git-dir", fresh.path(".overgit/.git"), "rev-parse", "HEAD"]))
            .stdout.trim(),
        ).toBe(overlayHeadBefore);
        expect(await fresh.skipWorktreePaths()).toEqual(["C.txt", "D.txt"]);
        await fresh.assertClean();
      } finally {
        await f.sb.cleanup();
      }
    },
    60_000,
  );

  test(
    "refuses when .overgit already points at a different overlay, and names both URLs",
    async () => {
      const f = await mkFixture("clone-wrong-origin");
      try {
        const other = await f.sb.mkBareRepo("other-overlay");
        const before = await f.base.snapshot();

        const r = expectExit(await og(f.base.dir, "clone", other.dir), 1);
        expect(r.stderr).toContain(f.overlayRemote.dir); // what is actually there
        expect(r.stderr).toContain(other.dir); // what was asked for

        expect(compareTrees(before, await f.base.snapshot()).text).toBe("");
        await f.base.assertClean();
      } finally {
        await f.sb.cleanup();
      }
    },
    45_000,
  );

  test(
    "sees an overlay whose `.git` is a gitfile, and refuses to clone over it",
    async () => {
      const f = await mkFixture("clone-gitfile-overlay");
      try {
        const other = await f.sb.mkBareRepo("other-overlay");

        // A *gitfile* at `.overgit/.git` pointing at a real repository beside it. `git clean
        // -xfd` still spares the directory and `git -C .overgit log` still works, so
        // `discover` calls it a healthy overlay — and `test/critic-regressions.test.ts` pins
        // that. `clone` had a second copy of the predicate that tested `.overgit/.git/HEAD`
        // and therefore said "no overlay here": it deleted the live gitfile, reported it as
        // leftovers from an interrupted run, and pointed `origin` at the other repository,
        // orphaning everything the user had.
        await rename(f.base.path(".overgit/.git"), f.base.path(".overgit/realgit"));
        await writeFile(f.base.path(".overgit/.git"), "gitdir: realgit\n");
        const before = await f.base.snapshot();

        const r = expectExit(await og(f.base.dir, "clone", other.dir), 1);
        expect(r.stderr).toContain(f.overlayRemote.dir); // what is actually there
        expect(r.stderr).toContain(other.dir); // what was asked for
        expect(r.stderr).not.toContain("interrupted run");

        expect(compareTrees(before, await f.base.snapshot()).text).toBe("");
        expect(await f.base.read(".overgit/.git")).toBe("gitdir: realgit\n");

        // And the same URL is still the documented clean no-op rather than a re-clone.
        const again = expectOk(await og(f.base.dir, "clone", f.overlayRemote.dir));
        expect(again.stdout).toContain("already present");
        expect(again.stderr).not.toContain("interrupted run");
        expect(await f.base.read(".overgit/.git")).toBe("gitdir: realgit\n");
        expect(compareTrees(before, await f.base.snapshot()).text).toBe("");
      } finally {
        await f.sb.cleanup();
      }
    },
    45_000,
  );

  test(
    "never bulk-checkouts: an overlay-tracked path with no manifest entry keeps the base's bytes",
    async () => {
      const sb = await makeSandbox("clone-no-bulk-checkout");
      try {
        const up = await sb.mkUpstream("base-remote", {
          "victim.txt": "BASE BYTES\n",
          "keep.txt": "keep\n",
        });
        const overlayRemote = await sb.mkBareRepo("overlay-remote");
        const base = await up.clone("base");

        await ogOk(base.dir, "init", "--remote", overlayRemote.dir);
        await base.write("victim.txt", "OVERLAY BYTES\n");
        await ogOk(base.dir, "add", "victim.txt");
        await ogOk(base.dir, "commit", "-m", "own victim.txt");

        // Now drop the manifest entry while leaving the blob in the overlay's tree. This is
        // exactly the shape a bulk `git checkout` would get wrong: the overlay tracks the
        // path, but nothing gives it the right to overwrite the base's copy.
        const m = JSON.parse(await base.read(".overgit/manifest.json")) as {
          entries: Record<string, unknown>;
        };
        delete m.entries["victim.txt"];
        await base.write(".overgit/manifest.json", JSON.stringify(m, null, 2) + "\n");
        await ogOk(base.dir, "git", "add", "--", ".overgit/manifest.json");
        await ogOk(base.dir, "git", "commit", "-q", "-m", "orphan the overlay blob");
        await ogOk(base.dir, "push", "-u", "origin", "main");

        const fresh = await up.clone("fresh");
        await ogOk(fresh.dir, "clone", overlayRemote.dir);

        expect(await fresh.read("victim.txt")).toBe("BASE BYTES\n");
        expect(await fresh.skipWorktreePaths()).toEqual([]);
        await fresh.assertClean();
      } finally {
        await sb.cleanup();
      }
    },
    60_000,
  );
});

describe("overgit clone --base (from nothing)", () => {
  test(
    "one command builds the whole thing, and repeating it changes nothing",
    async () => {
      const f = await mkFixture("clone-from-nothing");
      try {
        const want = await f.base.snapshot();
        const machine = await makeSandbox("clone-from-nothing-machine");
        try {
          const r = await og(
            machine.dir,
            "clone",
            "--base",
            f.baseUpstream.url,
            f.overlayRemote.dir,
            "proj",
          );
          expectOk(r);
          stderrIsQuiet(r);

          const proj = machine.adopt("proj");
          expect(compareTrees(want, await proj.snapshot(), { a: "original", b: "new machine" }).text)
            .toBe("");
          await proj.assertClean();
          await assertCleanSafe(proj.dir, { label: "new machine" });

          const before = await proj.snapshot();
          const second = expectOk(
            await og(
              machine.dir,
              "clone",
              "--base",
              f.baseUpstream.url,
              f.overlayRemote.dir,
              "proj",
            ),
          );
          stderrIsQuiet(second);
          expect(compareTrees(before, await proj.snapshot()).text).toBe("");
          await proj.assertClean();
        } finally {
          await machine.cleanup();
        }
      } finally {
        await f.sb.cleanup();
      }
    },
    60_000,
  );

  test(
    "refuses to bootstrap into a directory that is a different repository",
    async () => {
      const f = await mkFixture("clone-target-busy");
      try {
        const machine = await makeSandbox("clone-target-busy-machine");
        try {
          const decoy = await machine.mkUpstream("decoy-remote", { "x.txt": "x\n" });
          await decoy.clone("proj");

          const r = expectExit(
            await og(
              machine.dir,
              "clone",
              "--base",
              f.baseUpstream.url,
              f.overlayRemote.dir,
              "proj",
            ),
            1,
          );
          expect(r.stderr).toContain(machine.path("proj"));
          expect(r.stderr).toContain(f.baseUpstream.url);
          expect(await pathExists(machine.path("proj", ".overgit"))).toBe(false);
        } finally {
          await machine.cleanup();
        }
      } finally {
        await f.sb.cleanup();
      }
    },
    60_000,
  );
});

/* ==================================================================== interruption */

describe("interruption safety", () => {
  test(
    "a bootstrap killed mid-clone never wedges the next one",
    async () => {
      const f = await mkFixture("interrupt");
      try {
        // A fat overlay so `git clone` takes long enough for a kill to land inside it.
        const files: Record<string, string> = {};
        for (let i = 0; i < 60; i++) files[`big/f${i}.txt`] = `${"payload ".repeat(400)}${i}\n`;
        await f.base.writeFiles(files);
        await ogOk(f.base.dir, "add", ...Object.keys(files));
        await ogOk(f.base.dir, "commit", "-m", "fat overlay");
        await ogOk(f.base.dir, "push");

        const want = await f.base.snapshot();
        const machine = await makeSandbox("interrupt-machine");
        try {
          const argv = [
            ...cliArgv(),
            "clone",
            "--base",
            f.baseUpstream.url,
            f.overlayRemote.dir,
            "proj",
          ];
          /** How complete the overlay was when each victim died. */
          const phases: string[] = [];

          for (const delayMs of [15, 35, 60, 90, 130, 190, 260, 350]) {
            await rm(machine.path("proj"), { recursive: true, force: true });

            const victim = Bun.spawn({
              cmd: argv,
              cwd: machine.dir,
              env: envForPath(machine.dir),
              stdout: "pipe",
              stderr: "pipe",
            });
            await Bun.sleep(delayMs);
            victim.kill(9);
            await victim.exited;

            phases.push(
              !(await pathExists(machine.path("proj", ".overgit")))
                ? "no-overgit"
                : (await pathExists(machine.path("proj", ".overgit/.git/HEAD")))
                  ? "overlay-present"
                  : "overlay-incomplete",
            );

            // The *same one command* must finish the job.
            const rescue = await og(
              machine.dir,
              "clone",
              "--base",
              f.baseUpstream.url,
              f.overlayRemote.dir,
              "proj",
            );
            if (rescue.code !== 0) {
              throw new Error(
                `killing the bootstrap after ${delayMs}ms wedged it\n${describeResult(rescue)}`,
              );
            }

            const proj = machine.adopt("proj");
            const d = compareTrees(want, await proj.snapshot(), {
              a: "original",
              b: `recovered after ${delayMs}ms kill`,
            });
            if (!d.equal) {
              throw new Error(`recovery after a ${delayMs}ms kill produced a wrong tree\n${d.text}`);
            }
            await proj.assertClean({ label: `recovered after ${delayMs}ms` });

            // The scratch clone directory the victim was using must be gone, not orphaned.
            const overgitEntries = (
              await runCommand(["ls", "-a", proj.path(".overgit")], {
                cwd: proj.dir,
                env: machine.env,
              })
            ).stdout.split("\n");
            expect(overgitEntries.filter((e) => e.startsWith(".clone-"))).toEqual([]);

            // And the run after the recovery is still a clean no-op.
            const settled = await proj.snapshot();
            const noop = expectOk(
              await og(
                machine.dir,
                "clone",
                "--base",
                f.baseUpstream.url,
                f.overlayRemote.dir,
                "proj",
              ),
            );
            stderrIsQuiet(noop);
            expect(compareTrees(settled, await proj.snapshot()).text).toBe("");
          }

          // Guard against the sweep quietly degenerating into "always killed after the
          // bootstrap had already finished", which would prove nothing.
          expect(phases).toContain("no-overgit");
          expect(phases.filter((p) => p !== "overlay-present").length).toBeGreaterThan(0);
        } finally {
          await machine.cleanup();
        }
      } finally {
        await f.sb.cleanup();
      }
    },
    300_000,
  );
});

/* ==================================================================== detach / attach */

describe("overgit detach / attach", () => {
  test(
    "detach yields a byte-exact pristine base checkout and attach restores the overlay exactly",
    async () => {
      const f = await mkFixture("detach-roundtrip");
      try {
        const attached = await f.base.snapshot();

        expectOk(await og(f.base.dir, "detach"));

        // The marker `status`/`doctor` read to report the state.
        expect(await f.base.exists(".overgit/local/detached")).toBe(true);

        // *Pristine* means: indistinguishable from a plain `git clone` of the base.
        const pristine = await f.baseUpstream.clone("pristine");
        const detached = await snapshotTree(f.base.dir, { exclude: [".overgit"] });
        expect(
          compareTrees(await pristine.snapshot(), detached, { a: "git clone", b: "detached" }).text,
        ).toBe("");

        expect(await f.base.skipWorktreePaths()).toEqual([]);
        // `/.overgit/` stays: without it a `git add -A` in the detached state would commit
        // the whole overlay repository into the base's history.
        expect(await f.base.excludeLines()).toEqual(["/.overgit/"]);
        expect((await f.base.gitTry("diff", "HEAD", "--stat")).stdout).toBe("");
        await f.base.assertClean({ label: "detached" });

        expectOk(await og(f.base.dir, "attach"));
        expect(await f.base.exists(".overgit/local/detached")).toBe(false);
        expect(
          compareTrees(attached, await f.base.snapshot(), { a: "before detach", b: "after attach" })
            .text,
        ).toBe("");
        expect(await f.base.skipWorktreePaths()).toEqual(["C.txt", "D.txt"]);
        await f.base.assertClean({ label: "re-attached" });
      } finally {
        await f.sb.cleanup();
      }
    },
    60_000,
  );

  test(
    "a second detach is inert and cannot stage the base's bytes over the overlay's content",
    async () => {
      const f = await mkFixture("detach-twice");
      try {
        const attached = await f.base.snapshot();
        expectOk(await og(f.base.dir, "detach"));
        const overlayIndex = async (): Promise<string> =>
          (await f.base.gitRun(["--git-dir", f.base.path(".overgit/.git"), "ls-files", "-s"]))
            .stdout;
        const indexAfterFirst = await overlayIndex();
        const treeAfterFirst = await f.base.snapshot();

        const second = expectOk(await og(f.base.dir, "detach"));
        stderrIsQuiet(second);
        expect(await overlayIndex()).toBe(indexAfterFirst);
        expect(compareTrees(treeAfterFirst, await f.base.snapshot()).text).toBe("");

        // The proof that nothing was lost: attaching still produces the overlay's bytes.
        expectOk(await og(f.base.dir, "attach"));
        expect(compareTrees(attached, await f.base.snapshot()).text).toBe("");
        expect(await f.base.read("C.txt")).toBe(OVERLAY_C);
      } finally {
        await f.sb.cleanup();
      }
    },
    60_000,
  );

  test(
    "detach unblocks a `git pull` that git refuses to run",
    async () => {
      const f = await mkFixture("detach-unblocks-pull");
      try {
        await f.baseUpstream.changeFile("C.txt", "base C v2\n");

        // Measured row: upstream touched an overridden file, so git aborts.
        const blocked = await f.base.gitTry("pull", "--no-rebase");
        expect(blocked.code).not.toBe(0);
        expect(blocked.stderr + blocked.stdout).toMatch(/would be overwritten|Please commit/i);

        expectOk(await og(f.base.dir, "detach"));
        const pulled = await f.base.gitTry("pull", "--no-rebase");
        expect(pulled.code).toBe(0);
        expectOk(await og(f.base.dir, "attach"));

        // The overlay's bytes win in the work-tree; the base has moved underneath it.
        expect(await f.base.read("C.txt")).toBe(OVERLAY_C);
        expect(await f.base.show("C.txt")).toBe("base C v2\n");
        expect(await f.base.exists("D.txt")).toBe(false);
        expect(await f.base.read("A.txt")).toBe(OVERLAY_A);
        await f.base.assertClean({ label: "after detach/pull/attach" });
      } finally {
        await f.sb.cleanup();
      }
    },
    60_000,
  );

  test(
    "status reports what the marker records, not merely that there is one",
    async () => {
      const f = await mkFixture("detach-status-detail");
      try {
        const overlayHead = (
          await f.base.gitRun(["--git-dir", f.base.path(".overgit/.git"), "rev-parse", "HEAD"])
        ).stdout.trim();
        expectOk(await og(f.base.dir, "detach"));

        // The fields were written and never read back by anything: `status` and `doctor`
        // tested the file's existence and stopped there.
        const marker = JSON.parse(await f.base.read(".overgit/local/detached")) as {
          detachedAt: string;
          restored: string[];
          removed: string[];
        };
        expect(marker.restored.slice().sort()).toEqual(["C.txt", "D.txt"]);
        expect(marker.removed).toEqual(["A.txt"]);

        const long = expectOk(await og(f.base.dir, "status")).stdout;
        expect(long).toContain("DETACHED");
        expect(long).toContain(overlayHead.slice(0, 8));
        expect(long).toContain("3 paths");
        expect(long).toContain("2 restored from the base, 1 removed");

        const fields = expectOk(await og(f.base.dir, "status", "--porcelain"))
          .stdout.split("\0")
          .find((r) => r.startsWith("detach\t"))!
          .split("\t");
        expect(fields).toEqual(["detach", marker.detachedAt, overlayHead, "3", "1"]);
      } finally {
        await f.sb.cleanup();
      }
    },
    60_000,
  );

  test(
    "an interrupted detach is reported as one, not as pristine base content",
    async () => {
      const f = await mkFixture("detach-interrupted");
      try {
        expectOk(await og(f.base.dir, "detach"));

        // What a `kill -9` between the claim and the finalise leaves behind. The marker is
        // written before the first mutation precisely so this state is recognisable; until
        // `complete` was read back, `status` described it as a finished detach.
        const path = f.base.path(".overgit/local/detached");
        const m = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        await writeFile(
          path,
          JSON.stringify({ ...m, complete: false, restored: [], removed: [] }, null, 2) + "\n",
        );

        const long = expectOk(await og(f.base.dir, "status")).stdout;
        expect(long).toContain("interrupted");
        expect(long).toContain("overgit attach");
        expect(long).not.toContain("holds pristine base content");

        const short = expectOk(await og(f.base.dir, "status", "--short")).stdout;
        expect(short).toContain("# detached");
        expect(short).toContain("# detach-interrupted");
      } finally {
        await f.sb.cleanup();
      }
    },
    60_000,
  );

  test(
    "detach rescues a resurrected whiteout whose bytes are neither the base's nor a backup",
    async () => {
      const f = await mkFixture("detach-rescue");
      try {
        await f.base.write("D.txt", "somebody put this back\n");
        expectOk(await og(f.base.dir, "detach"));

        expect(await f.base.read("D.txt")).toBe("base D\n");
        const backups = (
          await runCommand(["ls", f.base.path(".overgit/local/backups")], {
            cwd: f.base.dir,
            env: f.sb.env,
          })
        ).stdout;
        expect(backups).toMatch(/D\.txt/);
      } finally {
        await f.sb.cleanup();
      }
    },
    45_000,
  );
});

/* ==================================================================== hooks */

describe("overgit hooks", () => {
  test(
    "install is opt-in, creates executable hooks with a shebang, and is idempotent",
    async () => {
      const f = await mkFixture("hooks-install");
      try {
        for (const h of ["post-merge", "post-checkout", "post-rewrite"]) {
          expect(await f.base.exists(`.git/hooks/${h}`)).toBe(false);
        }

        const r = await ogOk(f.base.dir, "hooks", "install");
        expect(r.stdout).toContain("post-merge");

        for (const h of ["post-merge", "post-checkout", "post-rewrite"]) {
          const p = f.base.path(".git/hooks", h);
          const text = await Bun.file(p).text();
          expect(text.startsWith("#!/bin/sh\n")).toBe(true);
          expect(text).toContain(">>> overgit managed block");
          expect(text).toContain("<<< overgit managed block");
          expect((await stat(p)).mode & 0o111).not.toBe(0);
          // The block must never `exit`: a user may append their own code after it.
          expect(text).not.toMatch(/^\s*exit\b/m);
          expect(
            (await runCommand(["sh", "-n", p], { cwd: f.base.dir, env: f.sb.env })).code,
          ).toBe(0);
        }

        const before = await bytes(f.base.path(".git/hooks/post-merge"));
        expectOk(await og(f.base.dir, "hooks", "install"));
        expect(await bytes(f.base.path(".git/hooks/post-merge"))).toEqual(before);
        await f.base.assertClean();
      } finally {
        await f.sb.cleanup();
      }
    },
    45_000,
  );

  test(
    "an existing hook keeps its content, mode and shebang; uninstall removes only the block",
    async () => {
      const f = await mkFixture("hooks-preserve");
      try {
        const userHook = '#!/bin/sh\nset -eu\necho "user post-merge ran" >&2\n';
        await f.base.write(".git/hooks/post-merge", userHook);
        await runCommand(["chmod", "0750", f.base.path(".git/hooks/post-merge")], {
          cwd: f.base.dir,
          env: f.sb.env,
        });

        await ogOk(f.base.dir, "hooks", "install");
        const merged = await Bun.file(f.base.path(".git/hooks/post-merge")).text();
        expect(merged.startsWith(userHook)).toBe(true);
        expect((await stat(f.base.path(".git/hooks/post-merge"))).mode & 0o7777).toBe(0o750);

        // The hook must not fail the user's git command even with no overgit on PATH.
        const bare = await runCommand(["sh", f.base.path(".git/hooks/post-merge")], {
          cwd: f.base.dir,
          env: { ...f.sb.env, PATH: "/usr/bin:/bin" },
        });
        expect(bare.code).toBe(0);
        expect(bare.stderr).toContain("user post-merge ran");

        await ogOk(f.base.dir, "hooks", "uninstall");
        expect(await Bun.file(f.base.path(".git/hooks/post-merge")).text()).toBe(userHook);
        expect((await stat(f.base.path(".git/hooks/post-merge"))).mode & 0o7777).toBe(0o750);
        // The two files overgit created are gone; the one it only edited stayed.
        expect(await f.base.exists(".git/hooks/post-checkout")).toBe(false);
        expect(await f.base.exists(".git/hooks/post-rewrite")).toBe(false);
        await f.base.assertClean();
      } finally {
        await f.sb.cleanup();
      }
    },
    45_000,
  );

  test(
    "the installed hook repairs drift after `git clean -xfd` + `git pull`",
    async () => {
      const f = await mkFixture("hooks-repair");
      try {
        await ogOk(f.base.dir, "hooks", "install");
        const shimDir = await makeOvergitShim(f.sb);
        const hookEnv = { PATH: `${shimDir}:${f.sb.env.PATH}` };
        const healthy = await f.base.snapshot();

        // Measured drift row: `git clean -xfd` removes overlay-*added* files (they are
        // ignored) but leaves `.overgit/` alone.
        await f.base.git("clean", "-xfd");
        expect(await f.base.exists("A.txt")).toBe(false);
        expect(await f.base.exists(".overgit/.git/HEAD")).toBe(true);

        await f.baseUpstream.changeFile("B.txt", "base B v2\n");
        const pull = await f.base.gitRun(["pull", "--no-rebase"], { env: hookEnv });
        expect(pull.code).toBe(0);

        expect(await f.base.read("A.txt")).toBe(OVERLAY_A);
        expect(await f.base.read("C.txt")).toBe(OVERLAY_C);
        expect(await f.base.exists("D.txt")).toBe(false);
        expect(await f.base.read("B.txt")).toBe("base B v2\n");
        await f.base.assertClean({ label: "after hook-driven repair" });

        // Everything except the file the base legitimately changed is back as it was.
        const now = await f.base.snapshot();
        const d = compareTrees(healthy, now, { a: "before drift", b: "after repair" });
        expect(d.onlyInA).toEqual([]);
        expect(d.onlyInB).toEqual([]);
        expect(d.differs).toEqual(["B.txt"]);
      } finally {
        await f.sb.cleanup();
      }
    },
    60_000,
  );
});

/* ==================================================================== relocatability */

test(
  "a bootstrapped tree still works after the whole directory is moved",
  async () => {
    const f = await mkFixture("relocate");
    try {
      const before = await f.base.snapshot();
      await runCommand(["mv", f.base.dir, f.sb.path("moved")], {
        cwd: f.sb.dir,
        env: f.sb.env,
      });
      const moved = f.sb.adopt("moved");

      // `core.worktree=../..` is relative, so nothing needs repointing.
      expectOk(await og(moved.dir, "apply"));
      expect(compareTrees(before, await moved.snapshot(), { a: "before move", b: "after move" }).text)
        .toBe("");
      await moved.assertClean({ label: "after move" });
      expect(formatTree(await moved.snapshot())).toContain("A.txt");
    } finally {
      await f.sb.cleanup();
    }
  },
  45_000,
);
