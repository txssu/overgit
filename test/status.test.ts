/**
 * `src/status.ts` — the merged view.
 *
 * The claim under test: `overgit status` is not a `git status` proxy. `base.entries` has
 * everything the overlay owns removed from it, so what is left is genuinely the base's own
 * work, and `upstream` says — per file — what the base did to the blob the overlay forked
 * from.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanupAllSandboxes,
  makeSandbox,
  type Repo,
  type Sandbox,
  type Upstream,
} from "./helpers/harness.ts";
import { discover, type Context } from "../src/context.ts";
import { emptyManifest, readManifest, setEntry, writeManifest } from "../src/manifest.ts";
import { ensureOverlayExcludes, syncExcludeBlock } from "../src/exclude.ts";
import { applyState, takeOwnership, whiteout } from "../src/ownership.ts";
import { computeStatus, type OverlayFileStatus } from "../src/status.ts";

/* ------------------------------------------------------------ hermetic in-process env */

const ENV_KEYS = [
  "HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CEILING_DIRECTORIES",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "LC_ALL",
  "LANG",
  "TZ",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let sb: Sandbox;

beforeEach(async () => {
  sb = await makeSandbox("status");
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    const v = sb.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await sb.cleanup();
});

afterAll(cleanupAllSandboxes);

/* ------------------------------------------------------------------ fixture */

interface Fixture {
  repo: Repo;
  ctx: Context;
  upstream: Upstream;
}

async function mkFixture(
  extra: Record<string, string> = {},
  opts: { commit?: boolean } = {},
): Promise<Fixture> {
  const upstream = await sb.mkUpstream("upstream", {
    "B.txt": "base B\n",
    "C.txt": "base C\n",
    "D.txt": "base D\n",
    ...extra,
  });
  const repo = await upstream.clone("base");
  // `.overgit/` is an ordinary git repository directory, so its GIT_DIR is
  // `.overgit/.git`. That is what makes `git clean -xfd` in the base skip it entirely.
  await repo.git("init", "--quiet", "-b", "main", ".overgit");
  const gd = repo.path(".overgit", ".git");
  await repo.git("--git-dir", gd, "config", "core.worktree", "../..");
  await repo.git("--git-dir", gd, "config", "status.showUntrackedFiles", "no");
  const ctx = await discover(repo.dir, { requireOverlay: true });
  // `overgit init` writes an empty manifest and commits it; an overlay with no manifest file
  // at all is a state the tool never produces, and doctor rightly reports it as
  // `manifest-missing` (a missing manifest otherwise masquerades as "owns nothing").
  await writeManifest(ctx, emptyManifest());
  await syncExcludeBlock(ctx, emptyManifest());
  await ensureOverlayExcludes(ctx);
  // `overgit init` makes an initial commit so `HEAD` resolves; an overlay without one is a
  // state the tool never produces, and `doctor` rightly warns that its content exists only
  // in the index and cannot be pushed. Commit here so the fixture is a real overgit overlay.
  if (opts.commit !== false) {
    await ctx.overlay.commit("overgit: initialise overlay", { allowEmpty: true });
  }
  return { repo, ctx, upstream };
}

/** The standard A/C/D overlay on top of `mkFixture`. */
async function mkMounted(extra: Record<string, string> = {}): Promise<Fixture> {
  const f = await mkFixture(extra);
  await f.repo.write("A.txt", "overlay A\n");
  await f.repo.write("C.txt", "overlay C\n");
  await takeOwnership(f.ctx, ["A.txt", "C.txt"]);
  await whiteout(f.ctx, ["D.txt"]);
  await f.ctx.overlay.commit("overlay v1");
  return f;
}

function fileOf(files: OverlayFileStatus[], p: string): OverlayFileStatus {
  const f = files.find((x) => x.path === p);
  if (!f) throw new Error(`no status entry for ${p}; have ${files.map((x) => x.path).join(", ")}`);
  return f;
}

/* ------------------------------------------------------------------ base.entries */

describe("base.entries excludes everything overgit owns", () => {
  test("a clean overlay leaves the base view empty", async () => {
    const { ctx } = await mkMounted();
    const s = await computeStatus(ctx);
    expect(s.base.entries).toEqual([]);
    expect(s.base.branch).toBe("main");
    expect(s.base.head).not.toBeNull();
  });

  test("the base's own work still shows, overlay-owned paths never do", async () => {
    const { repo, ctx } = await mkMounted();
    await repo.write("B.txt", "the user edited this\n"); // base's own modification
    await repo.write("new-untracked.txt", "theirs\n"); // base's own untracked file
    // These would all show in a plain `git status` were it not for skip-worktree/exclude.
    await repo.write("C.txt", "overlay edit\n");

    const s = await computeStatus(ctx);
    expect(s.base.entries.map((e) => `${e.x}${e.y} ${e.path}`).sort()).toEqual([
      " M B.txt",
      "?? new-untracked.txt",
    ]);
  });

  test("an overlay path the base *can* see is still filtered out", async () => {
    const { repo, ctx } = await mkMounted();
    // Drop the skip-worktree bit behind overgit's back: raw `git status` now reports C.txt.
    await repo.git("update-index", "--no-skip-worktree", "C.txt");
    expect((await repo.git("status", "--porcelain")).stdout).toBe(" M C.txt\n");

    const s = await computeStatus(ctx);
    expect(s.base.entries).toEqual([]); // overgit owns it; it is not the base's business
    expect(s.problems).toBeGreaterThan(0); // but it *is* a problem
  });

  test("`.overgit/` never appears in the base view", async () => {
    const { repo, ctx } = await mkMounted();
    await repo.write(".overgit/local/scratch", "x\n");
    const s = await computeStatus(ctx);
    expect(s.base.entries.filter((e) => e.path.startsWith(".overgit"))).toEqual([]);
  });

  test("a rename whose source the overlay owns is filtered out", async () => {
    const { repo, ctx } = await mkMounted();
    await repo.git("update-index", "--no-skip-worktree", "C.txt");
    await repo.git("mv", "C.txt", "C-renamed.txt");
    const s = await computeStatus(ctx);
    expect(s.base.entries.some((e) => e.origPath === "C.txt" || e.path === "C.txt")).toBe(false);
  });
});

/* ------------------------------------------------------------------ per-file status */

describe("per-file overlay status", () => {
  test("a settled overlay reports clean for every kind", async () => {
    const { ctx } = await mkMounted();
    const s = await computeStatus(ctx);
    expect(s.files.map((f) => f.path)).toEqual(["A.txt", "C.txt", "D.txt"]);
    for (const f of s.files) {
      expect({ ...f, path: undefined, kind: undefined }).toEqual({
        path: undefined,
        kind: undefined,
        staged: false,
        worktreeDirty: false,
        missing: false,
        upstream: "same",
      });
    }
    expect(s.syncPending).toEqual([]);
    expect(s.problems).toBe(0);
  });

  test("staged means overlay HEAD differs from the overlay index", async () => {
    const { repo, ctx } = await mkMounted();
    await repo.write("A.txt", "overlay A v2\n");
    await takeOwnership(ctx, ["A.txt"], { force: true }); // re-stages, does not commit

    const s = await computeStatus(ctx);
    expect(fileOf(s.files, "A.txt").staged).toBe(true);
    expect(fileOf(s.files, "A.txt").worktreeDirty).toBe(false);
    expect(fileOf(s.files, "C.txt").staged).toBe(false);
  });

  test("worktreeDirty means the work-tree differs from the overlay index", async () => {
    const { repo, ctx } = await mkMounted();
    await repo.write("C.txt", "edited in the work-tree\n");
    const s = await computeStatus(ctx);
    expect(fileOf(s.files, "C.txt").worktreeDirty).toBe(true);
    expect(fileOf(s.files, "C.txt").staged).toBe(false);
    expect(fileOf(s.files, "C.txt").missing).toBe(false);
  });

  test("a mode change alone is dirty", async () => {
    const { repo, ctx } = await mkMounted();
    await repo.setExec("A.txt", true);
    expect(fileOf((await computeStatus(ctx)).files, "A.txt").worktreeDirty).toBe(true);
  });

  test("missing is set when an owned file is gone from the work-tree", async () => {
    const { repo, ctx } = await mkMounted();
    await rm(repo.path("A.txt"));
    const f = fileOf((await computeStatus(ctx)).files, "A.txt");
    expect(f.missing).toBe(true);
    expect(f.worktreeDirty).toBe(true);
  });

  test("a whiteout is never `missing`, but a resurrected file is dirty", async () => {
    const { repo, ctx } = await mkMounted();
    expect(fileOf((await computeStatus(ctx)).files, "D.txt")).toMatchObject({
      missing: false,
      worktreeDirty: false,
    });

    await repo.write("D.txt", "it came back\n");
    const f = fileOf((await computeStatus(ctx)).files, "D.txt");
    expect(f.missing).toBe(false);
    expect(f.worktreeDirty).toBe(true);
  });

  test("symlinks and exec bits do not read as spurious drift", async () => {
    const { repo, ctx } = await mkMounted();
    await repo.write("run.sh", "#!/bin/sh\n");
    await repo.setExec("run.sh", true);
    await symlink("B.txt", repo.path("link"));
    await takeOwnership(ctx, ["run.sh", "link"]);
    await ctx.overlay.commit("modes");

    const s = await computeStatus(ctx);
    for (const p of ["run.sh", "link"]) {
      expect(fileOf(s.files, p)).toMatchObject({ staged: false, worktreeDirty: false, missing: false });
    }
    expect(s.problems).toBe(0);
  });
});

/* ------------------------------------------------------------------ upstream */

describe("upstream: base HEAD versus the recorded baseBlob", () => {
  test("unchanged upstream is `same`", async () => {
    const { ctx } = await mkMounted();
    const s = await computeStatus(ctx);
    expect(s.files.map((f) => f.upstream)).toEqual(["same", "same", "same"]);
    expect(s.syncPending).toEqual([]);
    expect(s.pullBlocked).toEqual([]);
  });

  test("an upstream edit to an overridden file is `changed` and blocks `git pull`", async () => {
    const { repo, ctx, upstream } = await mkMounted();
    await upstream.changeFile("C.txt", "upstream moved C\n");
    // The pull itself aborts on an override — fetch + reset the ref to simulate having it.
    await repo.git("fetch", "--quiet", "origin");
    const pull = await repo.gitTry("pull", "--no-rebase", "--quiet");
    expect(pull.code).not.toBe(0);
    expect(pull.stderr).toContain("local changes");

    // Move the base's HEAD the way a successful pull would, without touching the work-tree.
    await repo.git("update-ref", "refs/heads/main", "origin/main");

    const s = await computeStatus(ctx);
    expect(fileOf(s.files, "C.txt").upstream).toBe("changed");
    expect(s.syncPending).toEqual(["C.txt"]);
    expect(s.pullBlocked).toEqual(["C.txt"]);
  });

  test("an upstream deletion of an overridden file is `deleted`", async () => {
    const { repo, ctx, upstream } = await mkMounted();
    await upstream.deleteFile("C.txt");
    await repo.git("fetch", "--quiet", "origin");
    await repo.git("update-ref", "refs/heads/main", "origin/main");

    const s = await computeStatus(ctx);
    expect(fileOf(s.files, "C.txt").upstream).toBe("deleted");
    expect(s.pullBlocked).toEqual(["C.txt"]);
  });

  test("an upstream edit to a whited-out file is `changed` but does not block a pull", async () => {
    const { repo, ctx, upstream } = await mkMounted();
    await upstream.changeFile("D.txt", "upstream moved D\n");
    await repo.git("pull", "--no-rebase", "--quiet"); // succeeds, resurrects D.txt
    await applyState(ctx);

    const s = await computeStatus(ctx);
    expect(fileOf(s.files, "D.txt").upstream).toBe("changed");
    expect(s.syncPending).toEqual(["D.txt"]);
    expect(s.pullBlocked).toEqual([]); // whiteouts never abort a pull
  });

  test("the base starting to track an added path is the `added` collision", async () => {
    const { repo, ctx, upstream } = await mkMounted();
    await upstream.addFile("A.txt", "upstream's own A\n");
    await repo.git("pull", "--no-rebase", "--quiet");
    await applyState(ctx);

    const s = await computeStatus(ctx);
    expect(fileOf(s.files, "A.txt").upstream).toBe("added");
    expect(s.syncPending).toEqual(["A.txt"]);
    expect(s.problems).toBeGreaterThan(0);
    expect(s.pullBlocked).toEqual([]); // an `add` collision is not an override
  });

  test("an add the base never sees stays `same`", async () => {
    const { ctx } = await mkMounted();
    expect(fileOf((await computeStatus(ctx)).files, "A.txt").upstream).toBe("same");
  });
});

/* ------------------------------------------------------------------ overlay + flags */

describe("overlay branch, upstream tracking and ahead/behind", () => {
  test("reports the overlay branch and head, and null upstream with no remote", async () => {
    const { ctx } = await mkMounted();
    const s = await computeStatus(ctx);
    expect(s.overlay.branch).toBe("main");
    expect(s.overlay.head).not.toBeNull();
    expect(s.overlay.upstream).toBeNull();
    expect(s.overlay.ahead).toBe(0);
    expect(s.overlay.behind).toBe(0);
  });

  test("reports ahead/behind against a real overlay remote", async () => {
    const { ctx } = await mkMounted();
    const remote = await sb.mkBareRepo("overlay-remote");
    await ctx.overlay.run(["remote", "add", "origin", remote.dir]);
    await ctx.overlay.run(["push", "--quiet", "-u", "origin", "HEAD:refs/heads/main"]);

    let s = await computeStatus(ctx);
    expect(s.overlay.upstream).toBe("origin/main");
    expect(s.overlay.ahead).toBe(0);
    expect(s.overlay.behind).toBe(0);

    await ctx.overlay.commit("another overlay commit", { allowEmpty: true });
    s = await computeStatus(ctx);
    expect(s.overlay.ahead).toBe(1);
    expect(s.overlay.behind).toBe(0);
  });

  test("an overlay with no commits reports a null head", async () => {
    const { repo, ctx } = await mkFixture({}, { commit: false });
    await repo.write("A.txt", "a\n");
    await takeOwnership(ctx, ["A.txt"]);
    const s = await computeStatus(ctx);
    expect(s.overlay.head).toBeNull();
    expect(fileOf(s.files, "A.txt").staged).toBe(true); // in the index, not yet in HEAD
    expect(fileOf(s.files, "A.txt").worktreeDirty).toBe(false);
  });

  test("syncInProgress and detached are read from .overgit/local", async () => {
    const { repo, ctx } = await mkMounted();
    expect((await computeStatus(ctx)).syncInProgress).toBe(false);
    expect((await computeStatus(ctx)).detached).toBe(false);

    await mkdir(repo.path(".overgit", "local"), { recursive: true });
    await writeFile(repo.path(".overgit", "local", "sync-state.json"), "{}\n");
    await writeFile(repo.path(".overgit", "local", "detached"), "");
    const s = await computeStatus(ctx);
    expect(s.syncInProgress).toBe(true);
    expect(s.detached).toBe(true);
    expect(s.problems).toBeGreaterThan(0);

    // A marker too damaged to parse is still a marker: it must not read as "mounted", and
    // it must not claim the detach was interrupted either — it says nothing about that.
    expect(s.detach).toMatchObject({ detachedAt: "", overlayHead: null, complete: true });
  });
});

/* ------------------------------------------------------------------ problems */

describe("the cheap problem count", () => {
  test("zero on a healthy overlay", async () => {
    const { ctx } = await mkMounted();
    expect((await computeStatus(ctx)).problems).toBe(0);
  });

  test("counts a missing skip-worktree bit", async () => {
    const { repo, ctx } = await mkMounted();
    await repo.git("update-index", "--no-skip-worktree", "D.txt");
    expect((await computeStatus(ctx)).problems).toBe(1);
  });

  test("counts a stale exclude block", async () => {
    const { repo, ctx } = await mkMounted();
    await writeFile(join(await repo.gitDir(), "info", "exclude"), "# wiped\n");
    expect((await computeStatus(ctx)).problems).toBe(1);
  });

  test("counts a manifest entry the overlay has no content for", async () => {
    const { ctx } = await mkMounted();
    let m = await readManifest(ctx);
    m = setEntry(m, "ghost.txt", { kind: "add" });
    await writeManifest(ctx, m);

    const s = await computeStatus(ctx);
    // The orphan entry plus the exclude block that no longer lists it.
    expect(s.problems).toBe(2);
    expect(fileOf(s.files, "ghost.txt")).toMatchObject({ missing: true, worktreeDirty: false });
  });

  test("an empty overlay is a valid, problem-free state", async () => {
    const { ctx } = await mkFixture();
    const s = await computeStatus(ctx);
    expect(s.files).toEqual([]);
    expect(s.syncPending).toEqual([]);
    expect(s.problems).toBe(0);
    expect(s.base.entries).toEqual([]);
  });
});
