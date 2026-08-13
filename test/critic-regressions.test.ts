/**
 * Leak regressions: overlay content becoming visible to the base when a path's real
 * base-side state stops matching what the manifest thinks it is.
 *
 * These drive the CLI end to end. Every defect here was invisible to the module-level
 * suite, which stayed green throughout, so keep them out of process.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanupAllSandboxes,
  expectOk,
  makeSandbox,
  overgit,
  type Repo,
  type Sandbox,
} from "./helpers/harness.ts";

let sb: Sandbox;

beforeEach(async () => {
  sb = await makeSandbox("critic");
});

afterAll(cleanupAllSandboxes);

/** The invisibility oracle, stated the way the README states it. */
async function assertBaseBlind(base: Repo, label: string): Promise<void> {
  expect((await base.git("status", "--porcelain")).stdout, `${label}: status`).toBe("");
  expect((await base.git("diff")).stdout, `${label}: diff`).toBe("");
  // The one that actually matters: would a routine commit capture the user's private bytes?
  await base.git("add", "-A");
  const staged = (await base.git("diff", "--cached", "--name-only")).stdout.trim();
  await base.gitTry("reset");
  expect(staged, `${label}: git add -A captured something`).toBe("");
}

describe("the base can never see the overlay, whatever upstream does", () => {
  test("upstream deleting an overridden file does not leak it (C5)", async () => {
    const upstream = await sb.mkUpstream("upstream", {
      "sub/config.toml": "host = base\n",
      "other.txt": "x\n",
    });
    const base = await upstream.clone("base");
    expectOk(await overgit(base.dir, "init"));
    await base.write("sub/config.toml", "host = overlay\n");
    expectOk(await overgit(base.dir, "add", "sub/config.toml"));
    expectOk(await overgit(base.dir, "commit", "-m", "overlay"));

    await upstream.deleteFile("sub/config.toml");
    expectOk(await overgit(base.dir, "detach"));
    await base.git("pull");
    expectOk(await overgit(base.dir, "attach"));

    // Before the fix: `?? sub/` and `git add -A` committed the overlay's private bytes into
    // the shared base repo. The path is no longer tracked, so skip-worktree cannot hide it —
    // it needs an exclude line instead, chosen from the base's *current* state.
    await assertBaseBlind(base, "upstream-gone after attach");
    expect(await base.read("sub/config.toml")).toBe("host = overlay\n");

    // And it is still surfaced as a decision rather than silently absorbed.
    const sync = await overgit(base.dir, "sync");
    expect(sync.code).toBe(3);
    expect(sync.stdout).toContain("no longer tracks");
    await assertBaseBlind(base, "decision pending");
  });

  test("upstream adding a path the overlay adds does not leak it (C2)", async () => {
    const upstream = await sb.mkUpstream("upstream", { "keep.txt": "base\n" });
    const base = await upstream.clone("base");
    expectOk(await overgit(base.dir, "init"));
    await base.write("scripts/dev.sh", "MY PRIVATE SCRIPT\n");
    expectOk(await overgit(base.dir, "add", "scripts/dev.sh"));
    expectOk(await overgit(base.dir, "commit", "-m", "overlay"));

    await upstream.addFile("scripts/dev.sh", "upstream version\n");
    expectOk(await overgit(base.dir, "detach"));
    await base.git("pull");
    expectOk(await overgit(base.dir, "attach"));

    // Before the fix: the exclude line went inert the moment the base indexed the path, so
    // the overlay's bytes showed up as a modification. Now skip-worktree covers it.
    await assertBaseBlind(base, "add-collision after attach");
    expect(await base.read("scripts/dev.sh")).toBe("MY PRIVATE SCRIPT\n");

    const sync = await overgit(base.dir, "sync");
    expect(sync.code).toBe(3);
    expect(sync.stdout).toContain("started tracking");
    await assertBaseBlind(base, "collision decision pending");
  });
});

describe("binary divergence is a decision, never a marker-free conflict (C3)", () => {
  // A NUL in the first 8000 bytes is git's own binary heuristic.
  const BASE_BIN = new Uint8Array([0x42, 0x00, 0x01, 0x02, 0x0a]);
  const OURS_BIN = new Uint8Array([0x4d, 0x00, 0x01, 0x02, 0x0a]);
  const THEIRS_BIN = new Uint8Array([0x55, 0x00, 0x01, 0x02, 0x0a]);

  test("`sync --continue` cannot silently accept the unmerged bytes", async () => {
    const upstream = await sb.mkUpstream("upstream", { "logo.bin": "placeholder\n" });
    await upstream.work.writeBytes("logo.bin", BASE_BIN);
    await upstream.push("binary base", {});

    const base = await upstream.clone("base");
    expectOk(await overgit(base.dir, "init"));
    await base.writeBytes("logo.bin", OURS_BIN);
    expectOk(await overgit(base.dir, "add", "logo.bin"));
    expectOk(await overgit(base.dir, "commit", "-m", "overlay binary"));

    await upstream.work.writeBytes("logo.bin", THEIRS_BIN);
    await upstream.push("binary upstream", {});

    expectOk(await overgit(base.dir, "detach"));
    await base.git("pull");
    expectOk(await overgit(base.dir, "attach"));

    const before = await readFile(join(base.dir, ".overgit/manifest.json"), "utf8");
    const sync = await overgit(base.dir, "sync");
    expect(sync.code).toBe(3);
    // It must NOT claim there are markers to edit — there are none, and cannot be.
    expect(sync.stdout).not.toContain("conflict markers");
    expect(sync.stdout).toContain("decision");

    // The whole defect: this used to exit 0, report "merged", and advance the fork point,
    // permanently discarding upstream's revision.
    const cont = await overgit(base.dir, "sync", "--continue");
    expect(cont.code).toBe(3);
    expect(await readFile(join(base.dir, ".overgit/manifest.json"), "utf8")).toBe(before);
    expect([...(await readFile(join(base.dir, "logo.bin")))]).toEqual([...OURS_BIN]);

    // The explicit answer works and is the only way through.
    expectOk(await overgit(base.dir, "resolve", "--take-upstream", "logo.bin"));
    expect([...(await readFile(join(base.dir, "logo.bin")))]).toEqual([...THEIRS_BIN]);
    await assertBaseBlind(base, "after binary take-upstream");
  });
});

describe("a deleted manifest is detected, not mistaken for an empty overlay (C6)", () => {
  test("doctor names it, recovers the whiteout, and never hints at un-hiding", async () => {
    const upstream = await sb.mkUpstream("upstream", {
      "config/app.toml": "port = 8080\n",
      "OLDNOTES.md": "old\n",
    });
    const base = await upstream.clone("base");
    expectOk(await overgit(base.dir, "init"));
    await base.write("config/app.toml", "port = 3000\n");
    expectOk(await overgit(base.dir, "add", "config/app.toml"));
    expectOk(await overgit(base.dir, "rm", "OLDNOTES.md"));
    expectOk(await overgit(base.dir, "commit", "-m", "overlay"));

    await rm(join(base.dir, ".overgit/manifest.json"));

    const d = await overgit(base.dir, "doctor");
    expect(d.stdout + d.stderr).toContain("manifest-missing");
    // The defect: doctor used to report the overlay's *own* paths as stray skip-worktree
    // bits and hint `--no-skip-worktree`, which un-hides the override so the next
    // `git add -A` commits it into the shared repo.
    expect(d.stdout + d.stderr).not.toContain("stray-skip-worktree");
    expect(d.stdout + d.stderr).not.toContain("--no-skip-worktree");

    expectOk(await overgit(base.dir, "doctor", "--fix"));

    // The whiteout cannot be reconstructed from the overlay index — it has no file. It comes
    // back because the manifest is tracked *by the overlay* and its history still holds it.
    const m = JSON.parse(await readFile(join(base.dir, ".overgit/manifest.json"), "utf8"));
    expect(Object.keys(m.entries).sort()).toEqual(["OLDNOTES.md", "config/app.toml"]);
    expect(m.entries["OLDNOTES.md"].kind).toBe("delete");
    await assertBaseBlind(base, "after manifest recovery");
  });
});

describe("an interrupted detach never overwrites overlay content (C5)", () => {
  test("a second detach on an already-detached tree keeps the overlay's bytes", async () => {
    const upstream = await sb.mkUpstream("upstream", { "exec.sh": "#!/bin/sh\necho base\n" });
    const base = await upstream.clone("base");
    expectOk(await overgit(base.dir, "init"));
    await base.write("exec.sh", "#!/bin/sh\necho overlay\n");
    await base.setExec("exec.sh");
    expectOk(await overgit(base.dir, "add", "exec.sh"));
    expectOk(await overgit(base.dir, "commit", "-m", "overlay"));

    expectOk(await overgit(base.dir, "detach"));
    // Simulate a detach killed before it could record the marker.
    await rm(join(base.dir, ".overgit/local/detached"));
    expectOk(await overgit(base.dir, "detach"));
    expectOk(await overgit(base.dir, "attach"));

    // Before the fix, the second detach staged the *base's* restored bytes over the
    // overlay's index entry — the one operation the code itself calls out as the way this
    // could lose data — and doctor reported everything healthy afterwards.
    expect(await base.read("exec.sh")).toBe("#!/bin/sh\necho overlay\n");
    expect(await base.isExec("exec.sh")).toBe(true);
    await assertBaseBlind(base, "after interrupted detach");
  });
});

describe("majors from the same critic round", () => {
  test("`overgit commit` refuses to publish conflict markers (C3)", async () => {
    const upstream = await sb.mkUpstream("upstream", { "cfg.txt": "base\n" });
    const base = await upstream.clone("base");
    expectOk(await overgit(base.dir, "init"));
    await base.write("cfg.txt", "overlay\n");
    expectOk(await overgit(base.dir, "add", "cfg.txt"));
    expectOk(await overgit(base.dir, "commit", "-m", "overlay"));

    await upstream.changeFile("cfg.txt", "upstream\n");
    expectOk(await overgit(base.dir, "detach"));
    await base.git("pull");
    expectOk(await overgit(base.dir, "attach"));
    expect((await overgit(base.dir, "sync")).code).toBe(3);
    expect(await base.read("cfg.txt")).toContain("<<<<<<<");

    // The defect: this exited 0 and committed the markers. `sync --abort` restores the
    // work-tree but cannot un-commit, so `push` published them and a fresh clone
    // materialised them on the next machine.
    const c = await overgit(base.dir, "commit", "-m", "wip");
    expect(c.code).toBe(3);
    expect(c.stderr).toContain("sync is in progress");

    const log = await overgit(base.dir, "log", "--oneline");
    expect(log.stdout).not.toContain("wip");
  });

  test("detach works under core.autocrlf, so the documented remedy works (C3)", async () => {
    const upstream = await sb.mkUpstream("upstream", { "f.txt": "line1\nline2\n" });
    const base = await upstream.clone("base");
    await base.git("config", "core.autocrlf", "true");
    expectOk(await overgit(base.dir, "init"));
    await base.write("f.txt", "mine1\r\nmine2\r\n");
    expectOk(await overgit(base.dir, "add", "f.txt"));
    expectOk(await overgit(base.dir, "commit", "-m", "overlay"));

    await upstream.changeFile("f.txt", "line1\nline2\nline3\n");
    expectOk(await overgit(base.dir, "detach"));

    // The defect: detach wrote raw blob bytes instead of checking out through git's
    // filters, so the base saw ` M f.txt`, `git pull` aborted, and detach→pull→attach —
    // the only remedy overgit offers — was unusable for anyone with autocrlf on.
    expect((await base.git("status", "--porcelain")).stdout).toBe("");
    await base.git("pull");
    expectOk(await overgit(base.dir, "attach"));
    expect(await base.read("f.txt")).toBe("mine1\r\nmine2\r\n");
    await assertBaseBlind(base, "autocrlf round-trip");
  });

  test("a valid gitfile overlay is healthy; a dangling one is clean-unprotected (C5/C6)", async () => {
    const upstream = await sb.mkUpstream("upstream", { "f.txt": "base\n" });
    const base = await upstream.clone("base");
    expectOk(await overgit(base.dir, "init"));
    await base.write("f.txt", "overlay\n");
    expectOk(await overgit(base.dir, "add", "f.txt"));
    expectOk(await overgit(base.dir, "commit", "-m", "overlay"));

    // A gitfile whose target is a real repo: `git clean -xfd` spares it, so it is healthy.
    await base.git("mv", ".overgit/.git", ".overgit/realgit").catch(() => {});
    await base.gitTry("mv", ".overgit/.git", ".overgit/realgit");
    const { rename, writeFile } = await import("node:fs/promises");
    await rename(join(base.dir, ".overgit/.git"), join(base.dir, ".overgit/realgit")).catch(
      () => {},
    );
    await writeFile(join(base.dir, ".overgit/.git"), "gitdir: realgit\n");
    expect((await base.git("clean", "-xfd", "-n")).stdout).toBe("");
    expectOk(await overgit(base.dir, "status"));

    // Dangling: git would delete the whole directory, and doctor must say so rather than
    // reporting "no overlay" (which was unreachable-by-CLI before).
    await writeFile(join(base.dir, ".overgit/.git"), "gitdir: nowhere\n");
    expect((await base.git("clean", "-xfd", "-n")).stdout).toContain(".overgit");
    const d = await overgit(base.dir, "doctor");
    expect(d.stdout + d.stderr).toContain("clean-unprotected");
  });

  test("hooks install refuses a non-POSIX-shell hook instead of breaking it (C5)", async () => {
    const upstream = await sb.mkUpstream("upstream", { "f.txt": "base\n" });
    const base = await upstream.clone("base");
    expectOk(await overgit(base.dir, "init"));

    const { writeFile, chmod } = await import("node:fs/promises");
    const hook = join(base.dir, ".git/hooks/post-checkout");
    await writeFile(hook, '#!/usr/bin/env python3\nprint("existing python hook")\n');
    await chmod(hook, 0o755);

    const r = await overgit(base.dir, "hooks", "install");
    expect(r.stderr).toContain("not a POSIX-shell hook");
    // Untouched, and still valid Python — appending sh to it made `git checkout` exit 1.
    expect(await base.read(".git/hooks/post-checkout")).toBe(
      '#!/usr/bin/env python3\nprint("existing python hook")\n',
    );
    expectOk(await base.gitRun(["checkout", "-b", "branch2"]));
  });

  test("status reports a leak at an owned path instead of 'base changes none' (C2)", async () => {
    const upstream = await sb.mkUpstream("upstream", { "C.txt": "base\n" });
    const base = await upstream.clone("base");
    expectOk(await overgit(base.dir, "init"));
    await base.write("C.txt", "overlay\n");
    expectOk(await overgit(base.dir, "add", "C.txt"));
    expectOk(await overgit(base.dir, "commit", "-m", "overlay"));

    // Break invisibility behind overgit's back.
    await base.git("update-index", "--no-skip-worktree", "C.txt");
    expect((await base.git("status", "--porcelain")).stdout).toBe(" M C.txt\n");

    const r = expectOk(await overgit(base.dir, "status"));
    // `base.entries` still subtracts owned paths — that is the merged view — but the leak
    // must be reported separately and loudly, not swallowed by the subtraction.
    expect(r.stdout).toContain("the base can see");
    expect(r.stdout).toContain("C.txt");
    expect(r.stdout).toContain("leak");
  });
});
