/**
 * `src/ownership.ts` — `takeOwnership`, `whiteout`, `restoreToBase`.
 *
 * These are integration tests against real git repositories. The central assertion is
 * `assertBaseClean`, the harness's invisibility oracle: after any sequence of overlay
 * operations the base's `git status`/`git diff` must be empty and a real `git add -A`
 * must capture nothing overlay-owned.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertBaseClean,
  cleanupAllSandboxes,
  makeSandbox,
  pathExists,
  WEIRD_NAMES,
  type Repo,
  type Sandbox,
} from "./helpers/harness.ts";
import { discover, type Context } from "../src/context.ts";
import { emptyManifest, entryOf, ownedPaths, readManifest } from "../src/manifest.ts";
import { currentExcludeBlock, ensureOverlayExcludes, syncExcludeBlock } from "../src/exclude.ts";
import { applyState, restoreToBase, takeOwnership, whiteout } from "../src/ownership.ts";
import { isOvergitError } from "../src/errors.ts";

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
  sb = await makeSandbox("ownership");
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
}

/**
 * A base repo plus an overlay in the shape `bootstrap.ts` builds: `.overgit/` is an
 * ordinary git repository directory with `core.worktree=../..`, and — importantly — the
 * base's exclude block is written straight away. Without that last step a plain `git add -A` in
 * the base sweeps `.overgit/` into the base's own history, which is precisely what the
 * managed block exists to prevent.
 */
async function mkFixture(files: Record<string, string> = {}): Promise<Fixture> {
  const repo = await sb.mkBaseRepo("base", { "B.txt": "base B\n", "C.txt": "base C\n", ...files });
  // `.overgit/` is an ordinary git repository directory, so its GIT_DIR is
  // `.overgit/.git`. That is what makes `git clean -xfd` in the base skip it entirely.
  await repo.git("init", "--quiet", "-b", "main", ".overgit");
  const gd = repo.path(".overgit", ".git");
  await repo.git("--git-dir", gd, "config", "core.worktree", "../..");
  await repo.git("--git-dir", gd, "config", "status.showUntrackedFiles", "no");
  const ctx = await discover(repo.dir, { requireOverlay: true });
  await syncExcludeBlock(ctx, emptyManifest());
  await ensureOverlayExcludes(ctx);
  return { repo, ctx };
}

/** Commit whatever the overlay currently has staged. */
async function overlayCommit(ctx: Context, msg = "overlay"): Promise<string> {
  return ctx.overlay.commit(msg);
}

async function skipBits(repo: Repo): Promise<string[]> {
  return repo.skipWorktreePaths();
}

async function catchErr(
  fn: () => Promise<unknown>,
): Promise<{ code: string; message: string; hint?: string; details: string[] }> {
  try {
    await fn();
  } catch (e) {
    if (!isOvergitError(e)) throw e;
    return { code: e.code, message: e.message, hint: e.hint, details: e.details };
  }
  throw new Error("expected the call to throw an OvergitError");
}

/* ------------------------------------------------------------------ takeOwnership */

describe("takeOwnership", () => {
  test("a base-tracked path becomes an override and the base goes blind", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("C.txt", "overlay C\n");

    const r = await takeOwnership(ctx, ["C.txt"]);
    expect(r.changes).toEqual([{ path: "C.txt", from: "base", to: "override" }]);

    const m = await readManifest(ctx);
    const baseBlob = await repo.blobOid("C.txt");
    expect(entryOf(m, "C.txt")).toEqual({ kind: "override", baseBlob: baseBlob! });
    expect(await skipBits(repo)).toEqual(["C.txt"]);
    expect(await repo.read("C.txt")).toBe("overlay C\n");
    await assertBaseClean(repo.dir);

    // The content is in the overlay object store, not just the work-tree.
    expect(await ctx.overlay.indexBlobOid("C.txt")).not.toBeNull();
    const oid = (await ctx.overlay.indexBlobOid("C.txt"))!;
    expect(new TextDecoder().decode(await ctx.overlay.catFileBlob(oid))).toBe("overlay C\n");
  });

  test("an untracked path becomes an add and is excluded from the base", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("A.txt", "overlay A\n");

    const r = await takeOwnership(ctx, ["A.txt"]);
    expect(r.changes).toEqual([{ path: "A.txt", from: "untracked", to: "add" }]);
    expect(entryOf(await readManifest(ctx), "A.txt")).toEqual({ kind: "add" });
    expect(await skipBits(repo)).toEqual([]);
    expect(await currentExcludeBlock(ctx)).toEqual(["/.overgit/", "/A.txt"]);
    await assertBaseClean(repo.dir);
  });

  test("the base captures nothing overlay-owned even after `git add -A && git commit`", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("A.txt", "overlay A\n");
    await repo.write("C.txt", "overlay C\n");
    await takeOwnership(ctx, ["A.txt", "C.txt"]);
    await whiteout(ctx, ["B.txt"]);

    const before = await repo.trackedPaths();
    await repo.git("add", "-A");
    await repo.gitTry("commit", "-m", "base does its own thing");
    expect(await repo.trackedPaths()).toEqual(before);
    expect(await repo.show("C.txt")).toBe("base C\n");
    expect(await repo.show("B.txt")).toBe("base B\n");
    await assertBaseClean(repo.dir);
  });

  test("the manifest is staged into the overlay index, not left in the work-tree", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("A.txt", "a\n");
    await takeOwnership(ctx, ["A.txt"]);
    const oid = await ctx.overlay.indexBlobOid(".overgit/manifest.json");
    expect(oid).not.toBeNull();
    expect(new TextDecoder().decode(await ctx.overlay.catFileBlob(oid!))).toBe(
      await readFile(ctx.manifestPath, "utf8"),
    );
  });

  test("records the executable bit and round-trips a symlink without following it", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("run.sh", "#!/bin/sh\necho hi\n");
    await repo.setExec("run.sh", true);
    await symlink("B.txt", repo.path("link"));
    await symlink("../../../etc/passwd", repo.path("escaping-link"));

    await takeOwnership(ctx, ["run.sh", "link", "escaping-link"]);

    expect(await ctx.overlay.fileMode("run.sh")).toBe("100755");
    expect(await ctx.overlay.fileMode("link")).toBe("120000");
    expect(await ctx.overlay.fileMode("escaping-link")).toBe("120000");
    const oid = (await ctx.overlay.indexBlobOid("escaping-link"))!;
    // The target is stored as content; nothing outside the work-tree was ever read.
    expect(new TextDecoder().decode(await ctx.overlay.catFileBlob(oid))).toBe("../../../etc/passwd");
    await assertBaseClean(repo.dir);
  });

  test("weird filenames survive add and stay invisible", async () => {
    const { repo, ctx } = await mkFixture();
    for (const n of WEIRD_NAMES) await repo.write(n, `content of ${n}\n`);
    await takeOwnership(ctx, [...WEIRD_NAMES]);

    const m = await readManifest(ctx);
    expect(ownedPaths(m).sort()).toEqual([...WEIRD_NAMES].sort());
    for (const n of WEIRD_NAMES) expect(entryOf(m, n)).toEqual({ kind: "add" });
    await assertBaseClean(repo.dir);
  });

  test("weird filenames survive override too (skip-worktree needs no escaping)", async () => {
    const { repo } = await mkFixture();
    for (const n of WEIRD_NAMES) await repo.write(n, `base ${n}\n`);
    await repo.commit("track the weird ones");
    const ctx = await discover(repo.dir, { requireOverlay: true });

    for (const n of WEIRD_NAMES) await repo.write(n, `overlay ${n}\n`);
    await takeOwnership(ctx, [...WEIRD_NAMES]);
    expect((await skipBits(repo)).sort()).toEqual([...WEIRD_NAMES].sort());
    await assertBaseClean(repo.dir);
  });

  test("a name that cannot be excluded exactly is refused for add", async () => {
    // `gitignoreEscape` degrades a newline (and a trailing CR) to `?`, which is a wildcard.
    // `/new?line.txt` would also hide `newXline.txt` — a file the user never named — and a
    // later `git clean -xfd` in the base would then delete it as ignored. Refuse instead.
    for (const name of ["new\nline.txt", "endswith-cr\r"]) {
      const { repo, ctx } = await mkFixture();
      await repo.write(name, "x\n");
      const e = await catchErr(() => takeOwnership(ctx, [name]));
      expect(e.code).toBe("PATH_FORBIDDEN");
      expect(e.message).toContain(JSON.stringify(name));
      expect(e.hint).toContain("rename the file");
      expect(e.details.join(" ")).toContain("git clean");
      expect(ownedPaths(await readManifest(ctx))).toEqual([]);
      expect(await currentExcludeBlock(ctx)).toEqual(["/.overgit/"]);
    }
  });

  test("the wildcard the refusal avoids really would hide an innocent sibling", async () => {
    // The refusal is only justified if the danger is real, so prove it against real git:
    // write the approximate pattern by hand and watch `newXline.txt` become ignored.
    const { repo } = await mkFixture();
    await repo.write("newXline.txt", "an unrelated file\n");
    const excl = join(await repo.gitDir(), "info", "exclude");
    await writeFile(excl, "/.overgit/\n/new?line.txt\n");

    expect((await repo.git("status", "--porcelain", "-uall")).stdout).toBe("");
    await repo.git("clean", "-xfd");
    expect(await pathExists(repo.path("newXline.txt"))).toBe(false);
  });

  test("but a newline filename the base tracks can still be overridden", async () => {
    const { repo } = await mkFixture();
    await repo.write("new\nline.txt", "base\n");
    await repo.commit("track it");
    const ctx = await discover(repo.dir, { requireOverlay: true });
    await repo.write("new\nline.txt", "overlay\n");
    const r = await takeOwnership(ctx, ["new\nline.txt"]);
    expect(r.changes[0]!.to).toBe("override");
    await assertBaseClean(repo.dir);
  });

  test("a missing path errors and names it", async () => {
    const { ctx } = await mkFixture();
    const e = await catchErr(() => takeOwnership(ctx, ["nope.txt"]));
    expect(e.code).toBe("PATH_NOT_FOUND");
    expect(e.message).toContain("nope.txt");
  });

  test("a base-tracked path deleted from the work-tree points at `overgit rm`", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.rm("B.txt");
    const e = await catchErr(() => takeOwnership(ctx, ["B.txt"]));
    expect(e.code).toBe("PATH_NOT_FOUND");
    expect(e.hint).toContain("overgit rm B.txt");
  });

  test("an already-owned path errors with its current kind, unless --force", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("A.txt", "v1\n");
    await takeOwnership(ctx, ["A.txt"]);

    const e = await catchErr(() => takeOwnership(ctx, ["A.txt"]));
    expect(e.code).toBe("ALREADY_OWNED");
    expect(e.message).toContain("A.txt");
    expect(e.message).toContain("add");

    await repo.write("A.txt", "v2\n");
    await takeOwnership(ctx, ["A.txt"], { force: true });
    const oid = (await ctx.overlay.indexBlobOid("A.txt"))!;
    expect(new TextDecoder().decode(await ctx.overlay.catFileBlob(oid))).toBe("v2\n");
  });

  test("reserved paths are refused", async () => {
    const { ctx } = await mkFixture();
    for (const p of [".git/config", ".overgit/manifest.json"]) {
      const e = await catchErr(() => takeOwnership(ctx, [p]));
      expect(e.code).toBe("PATH_FORBIDDEN");
    }
  });

  test("a directory expands to its files and skips ones already owned", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("d/one.txt", "1\n");
    await repo.write("d/sub/two.txt", "2\n");
    await takeOwnership(ctx, ["d/one.txt"]);

    const r = await takeOwnership(ctx, ["d"]);
    expect(r.changes.map((c) => c.path)).toEqual(["d/sub/two.txt"]);
    expect(r.skipped).toEqual([{ path: "d/one.txt", reason: "already owned (add)" }]);
    expect(ownedPaths(await readManifest(ctx))).toEqual(["d/one.txt", "d/sub/two.txt"]);
    await assertBaseClean(repo.dir);
  });

  test("one invalid path leaves the repository completely untouched", async () => {
    const { repo, ctx } = await mkFixture();
    for (const n of ["p1.txt", "p2.txt", "p3.txt", "p5.txt"]) await repo.write(n, `${n}\n`);
    const before = await repo.snapshot({ exclude: [".overgit"] });

    const e = await catchErr(() =>
      takeOwnership(ctx, ["p1.txt", "p2.txt", "p3.txt", "missing.txt", "p5.txt"]),
    );
    expect(e.code).toBe("PATH_NOT_FOUND");
    expect(e.message).toContain("missing.txt");

    expect(ownedPaths(await readManifest(ctx))).toEqual([]);
    expect(await ctx.overlay.lsFiles()).toEqual([]);
    expect(await currentExcludeBlock(ctx)).toEqual(["/.overgit/"]); // unchanged from init
    expect(await repo.snapshot({ exclude: [".overgit"] })).toEqual(before);
    // No `assertBaseClean` here on purpose: p1/p2/p3/p5 were never taken over, so they are
    // ordinary untracked files and the base is *supposed* to see them.
    expect(await skipBits(repo)).toEqual([]);
  });

  test("a case-only collision is refused instead of writing an unreadable manifest", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("Foo.txt", "one\n");
    await repo.write("foo.txt", "two\n");
    await takeOwnership(ctx, ["Foo.txt"]);

    const e = await catchErr(() => takeOwnership(ctx, ["foo.txt"]));
    expect(e.code).toBe("ALREADY_OWNED");
    expect(e.message).toContain("Foo.txt");
    expect(e.message).toContain("foo.txt");
    expect(e.hint).toContain("case-insensitive");
    // The manifest is still readable, which is the whole point.
    expect(ownedPaths(await readManifest(ctx))).toEqual(["Foo.txt"]);
  });

  test("a whiteout path whose file comes back is re-taken as an override", async () => {
    const { repo, ctx } = await mkFixture();
    await whiteout(ctx, ["C.txt"]);
    expect(await pathExists(repo.path("C.txt"))).toBe(false);

    await repo.write("C.txt", "resurrected\n");
    const r = await takeOwnership(ctx, ["C.txt"]);
    expect(r.changes).toEqual([{ path: "C.txt", from: "delete", to: "override" }]);
    expect(entryOf(await readManifest(ctx), "C.txt")!.kind).toBe("override");
    await assertBaseClean(repo.dir);
  });
});

/* ------------------------------------------------------------------ whiteout */

describe("whiteout", () => {
  test("a base file disappears from the work-tree while the base sees it as pristine", async () => {
    const { repo, ctx } = await mkFixture();
    const baseBlob = await repo.blobOid("C.txt");

    const r = await whiteout(ctx, ["C.txt"]);
    expect(r.changes).toEqual([{ path: "C.txt", from: "base", to: "delete" }]);
    expect(entryOf(await readManifest(ctx), "C.txt")).toEqual({ kind: "delete", baseBlob: baseBlob! });
    expect(await pathExists(repo.path("C.txt"))).toBe(false);
    expect(await skipBits(repo)).toEqual(["C.txt"]);
    expect(r.backups).toEqual([]); // the bytes were the base's, already in its object store
    await assertBaseClean(repo.dir);

    // The overlay does not track a whiteout path.
    expect(await ctx.overlay.indexBlobOid("C.txt")).toBeNull();
  });

  test("unsaved base modifications are rescued before the file goes", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("C.txt", "my unsaved work\n");

    const r = await whiteout(ctx, ["C.txt"]);
    expect(r.backups.length).toBe(1);
    expect(r.backups[0]).toStartWith(".overgit/local/backups/");
    expect(await readFile(join(repo.dir, r.backups[0]!), "utf8")).toBe("my unsaved work\n");
    expect(r.changes[0]!.backup).toBe(r.backups[0]!);
    await assertBaseClean(repo.dir);
  });

  test("un-adding an overlay-added file removes it everywhere and rescues its bytes", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("A.txt", "overlay A\n");
    await takeOwnership(ctx, ["A.txt"]);
    await overlayCommit(ctx);

    const r = await whiteout(ctx, ["A.txt"]);
    expect(r.changes).toEqual([{ path: "A.txt", from: "add", to: "none" }]);
    expect(ownedPaths(await readManifest(ctx))).toEqual([]);
    expect(await ctx.overlay.indexBlobOid("A.txt")).toBeNull();
    expect(await pathExists(repo.path("A.txt"))).toBe(false);
    expect(await currentExcludeBlock(ctx)).toEqual(["/.overgit/"]);
    await assertBaseClean(repo.dir);
  });

  test("un-adding refuses while the overlay has uncommitted changes, and says what to run", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("A.txt", "overlay A\n");
    await takeOwnership(ctx, ["A.txt"]); // staged, never committed

    const e = await catchErr(() => whiteout(ctx, ["A.txt"]));
    expect(e.code).toBe("DIRTY_OVERLAY");
    expect(e.message).toContain("A.txt");
    expect(e.hint).toContain("overgit commit");
    expect(await pathExists(repo.path("A.txt"))).toBe(true);

    const r = await whiteout(ctx, ["A.txt"], { force: true });
    expect(r.backups.length).toBe(1);
    expect(await readFile(join(repo.dir, r.backups[0]!), "utf8")).toBe("overlay A\n");
    expect(await pathExists(repo.path("A.txt"))).toBe(false);
  });

  test("an override converts to a whiteout without losing the overlay content", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("C.txt", "overlay C\n");
    await takeOwnership(ctx, ["C.txt"]);
    const overlayOid = (await ctx.overlay.indexBlobOid("C.txt"))!;
    await overlayCommit(ctx);

    const r = await whiteout(ctx, ["C.txt"]);
    expect(r.changes).toEqual([{ path: "C.txt", from: "override", to: "delete" }]);
    expect(entryOf(await readManifest(ctx), "C.txt")!.kind).toBe("delete");
    expect(await ctx.overlay.indexBlobOid("C.txt")).toBeNull();
    expect(await pathExists(repo.path("C.txt"))).toBe(false);
    // Still recoverable: the blob is in the overlay's history.
    expect(new TextDecoder().decode(await ctx.overlay.catFileBlob(overlayOid))).toBe("overlay C\n");
    await assertBaseClean(repo.dir);
  });

  test("an orphaned manifest entry can still be removed", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("A.txt", "overlay A\n");
    await takeOwnership(ctx, ["A.txt"]);
    await overlayCommit(ctx);
    // Drift: the overlay index loses the path while the manifest still claims it.
    await ctx.overlay.run(["rm", "--cached", "--quiet", "--", "A.txt"]);

    const r = await whiteout(ctx, ["A.txt"], { force: true });
    expect(r.changes).toEqual([
      { path: "A.txt", from: "add", to: "none", backup: r.backups[0]! },
    ]);
    expect(ownedPaths(await readManifest(ctx))).toEqual([]);
    expect(await pathExists(repo.path("A.txt"))).toBe(false);
  });

  test("whiteout is idempotent", async () => {
    const { ctx } = await mkFixture();
    await whiteout(ctx, ["C.txt"]);
    const r = await whiteout(ctx, ["C.txt"]);
    expect(r.changes).toEqual([]);
    expect(r.skipped).toEqual([{ path: "C.txt", reason: "already a whiteout" }]);
  });

  test("an override whose upstream vanished cannot be whited out, and says so", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("C.txt", "overlay C\n");
    await takeOwnership(ctx, ["C.txt"]);
    await overlayCommit(ctx);
    await repo.git("update-index", "--no-skip-worktree", "C.txt");
    await repo.git("rm", "--cached", "--quiet", "C.txt");

    const e = await catchErr(() => whiteout(ctx, ["C.txt"]));
    expect(e.code).toBe("NOT_TRACKED_BY_BASE");
    expect(e.message).toContain("no longer tracks C.txt");
    expect(e.hint).toContain("overgit sync");
    // The claim is untouched: nothing was half-done.
    expect(entryOf(await readManifest(ctx), "C.txt")!.kind).toBe("override");
    expect(await repo.read("C.txt")).toBe("overlay C\n");
  });

  test("an untracked, unowned file is refused rather than silently deleted", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("stray.txt", "not yours\n");
    const e = await catchErr(() => whiteout(ctx, ["stray.txt"]));
    expect(e.code).toBe("NOT_TRACKED_BY_BASE");
    expect(e.message).toContain("stray.txt");
    expect(await pathExists(repo.path("stray.txt"))).toBe(true);
  });

  test("whiteouts survive `git add -A && git commit` in the base", async () => {
    const { repo, ctx } = await mkFixture();
    await whiteout(ctx, ["B.txt", "C.txt"]);
    await repo.git("add", "-A");
    await repo.gitTry("commit", "-m", "base commit");
    expect((await repo.trackedPaths()).sort()).toEqual(["B.txt", "C.txt"]);
    expect(await repo.show("B.txt")).toBe("base B\n");
    await assertBaseClean(repo.dir);
  });
});

/* ------------------------------------------------------------------ restoreToBase */

describe("restoreToBase", () => {
  test("an override gives back byte-identical base content and clears the bit", async () => {
    const { repo, ctx } = await mkFixture();
    const original = await repo.readBytes("C.txt");
    await repo.write("C.txt", "overlay C\n");
    await takeOwnership(ctx, ["C.txt"]);
    await overlayCommit(ctx);

    const r = await restoreToBase(ctx, ["C.txt"]);
    expect(r.changes).toEqual([{ path: "C.txt", from: "override", to: "none" }]);
    expect(await repo.readBytes("C.txt")).toEqual(original);
    expect(await skipBits(repo)).toEqual([]);
    expect(ownedPaths(await readManifest(ctx))).toEqual([]);
    expect(await ctx.overlay.indexBlobOid("C.txt")).toBeNull();
    await assertBaseClean(repo.dir);
  });

  test("a whiteout gives the file back", async () => {
    const { repo, ctx } = await mkFixture();
    const original = await repo.readBytes("C.txt");
    await whiteout(ctx, ["C.txt"]);
    await restoreToBase(ctx, ["C.txt"]);
    expect(await repo.readBytes("C.txt")).toEqual(original);
    expect(await skipBits(repo)).toEqual([]);
    await assertBaseClean(repo.dir);
  });

  test("base file modes are restored exactly", async () => {
    const { repo } = await mkFixture();
    await repo.write("run.sh", "#!/bin/sh\n");
    await repo.setExec("run.sh", true);
    await symlink("B.txt", repo.path("link"));
    await repo.commit("modes");
    const ctx = await discover(repo.dir, { requireOverlay: true });

    await repo.write("run.sh", "overlay\n");
    await rm(repo.path("link"));
    await writeFile(repo.path("link"), "not a link any more\n");
    await takeOwnership(ctx, ["run.sh", "link"]);
    await overlayCommit(ctx);

    await restoreToBase(ctx, ["run.sh", "link"]);
    expect(await repo.isExec("run.sh")).toBe(true);
    expect(await readlink(repo.path("link"))).toBe("B.txt");
    await assertBaseClean(repo.dir);
  });

  test("an add is dropped and the file deleted, or kept with keepFile", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("A.txt", "overlay A\n");
    await repo.write("K.txt", "kept\n");
    await takeOwnership(ctx, ["A.txt", "K.txt"]);
    await overlayCommit(ctx);

    await restoreToBase(ctx, ["A.txt"]);
    expect(await pathExists(repo.path("A.txt"))).toBe(false);

    await restoreToBase(ctx, ["K.txt"], { keepFile: true });
    expect(await repo.read("K.txt")).toBe("kept\n");
    expect(ownedPaths(await readManifest(ctx))).toEqual([]);
    expect(await currentExcludeBlock(ctx)).toEqual(["/.overgit/"]);

    // K.txt is now an ordinary untracked file — visible again, which is the point.
    expect((await repo.git("status", "--porcelain")).stdout).toBe("?? K.txt\n");
  });

  test("refuses while the overlay has uncommitted changes and names the path", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("C.txt", "overlay C\n");
    await takeOwnership(ctx, ["C.txt"]);
    await overlayCommit(ctx);
    await repo.write("C.txt", "edited but not committed\n");

    const e = await catchErr(() => restoreToBase(ctx, ["C.txt"]));
    expect(e.code).toBe("DIRTY_OVERLAY");
    expect(e.message).toContain("C.txt");
    expect(e.hint).toContain("--force");
    expect(await repo.read("C.txt")).toBe("edited but not committed\n");

    const r = await restoreToBase(ctx, ["C.txt"], { force: true });
    expect(r.backups.length).toBe(1);
    expect(await readFile(join(repo.dir, r.backups[0]!), "utf8")).toBe("edited but not committed\n");
    expect(await repo.read("C.txt")).toBe("base C\n");
    await assertBaseClean(repo.dir);
  });

  test("a path the overlay does not own errors with NOT_OWNED", async () => {
    const { ctx } = await mkFixture();
    const e = await catchErr(() => restoreToBase(ctx, ["B.txt"]));
    expect(e.code).toBe("NOT_OWNED");
    expect(e.message).toContain("B.txt");
  });

  test("restoring uses the base index, so a staged base change is not clobbered", async () => {
    const { repo, ctx } = await mkFixture();
    // The base has a staged-but-uncommitted change to C.txt.
    await repo.write("C.txt", "staged in base\n");
    await repo.git("add", "C.txt");
    await repo.write("C.txt", "overlay C\n");
    await takeOwnership(ctx, ["C.txt"]);
    await overlayCommit(ctx);

    await restoreToBase(ctx, ["C.txt"]);
    // The work-tree matches the index, so the only thing git reports is the base's own
    // staged change — exactly what was there before overgit got involved.
    expect(await repo.read("C.txt")).toBe("staged in base\n");
    expect((await repo.git("status", "--porcelain")).stdout).toBe("M  C.txt\n");
  });

  test("weird names round-trip through take → restore byte for byte", async () => {
    const { repo } = await mkFixture();
    for (const n of WEIRD_NAMES) await repo.write(n, `base ${n}\n`);
    await repo.commit("weird base");
    const ctx = await discover(repo.dir, { requireOverlay: true });
    // `.overgit/` is overlay bookkeeping, not project content; the snapshot compares the
    // *project* tree, which is what "give it all back" has to reproduce exactly.
    const snap = () => repo.snapshot({ exclude: [".overgit"] });
    const before = await snap();

    for (const n of WEIRD_NAMES) await repo.write(n, `overlay ${n}\n`);
    await takeOwnership(ctx, [...WEIRD_NAMES]);
    await overlayCommit(ctx);
    await assertBaseClean(repo.dir);

    await restoreToBase(ctx, [...WEIRD_NAMES]);
    expect(await snap()).toEqual(before);
    expect(await skipBits(repo)).toEqual([]);
    await assertBaseClean(repo.dir);
  });

  test("a full add → whiteout → restore cycle leaves the base exactly as it started", async () => {
    const { repo, ctx } = await mkFixture({ "D.txt": "base D\n" });
    const snap = () => repo.snapshot({ exclude: [".overgit"] });
    const before = await snap();

    await repo.write("A.txt", "overlay A\n");
    await repo.write("C.txt", "overlay C\n");
    await takeOwnership(ctx, ["A.txt", "C.txt"]);
    await whiteout(ctx, ["D.txt"]);
    await overlayCommit(ctx);
    await assertBaseClean(repo.dir);

    await restoreToBase(ctx, ["A.txt", "C.txt", "D.txt"]);
    expect(await snap()).toEqual(before);
    expect(await skipBits(repo)).toEqual([]);
    expect(await currentExcludeBlock(ctx)).toEqual(["/.overgit/"]);
    await assertBaseClean(repo.dir);
  });

  test("restore refuses an override the base stopped tracking, and --force drops it", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("C.txt", "overlay C\n");
    await takeOwnership(ctx, ["C.txt"]);
    await overlayCommit(ctx);

    // Simulate the base dropping the path (what `git pull` of an upstream delete does).
    await repo.git("update-index", "--no-skip-worktree", "C.txt");
    await repo.git("rm", "--cached", "--quiet", "C.txt");

    const e = await catchErr(() => restoreToBase(ctx, ["C.txt"]));
    expect(e.code).toBe("NOT_TRACKED_BY_BASE");
    expect(e.hint).toContain("overgit sync");

    const r = await restoreToBase(ctx, ["C.txt"], { force: true });
    expect(r.backups.length).toBe(1);
    expect(await pathExists(repo.path("C.txt"))).toBe(false);
    expect(ownedPaths(await readManifest(ctx))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ interaction */

describe("ownership and applyState together", () => {
  test("applyState after a full ownership set is a no-op", async () => {
    const { repo, ctx } = await mkFixture({ "D.txt": "base D\n" });
    await repo.write("A.txt", "overlay A\n");
    await repo.write("C.txt", "overlay C\n");
    await takeOwnership(ctx, ["A.txt", "C.txt"]);
    await whiteout(ctx, ["D.txt"]);

    const r = await applyState(ctx);
    expect(r.changed).toBe(false);
    expect(r.actions.filter((a) => a.action !== "noop")).toEqual([]);
    await assertBaseClean(repo.dir);
  });

  test("a whiteout of an executable base file restores the exec bit", async () => {
    const { repo } = await mkFixture();
    await repo.write("run.sh", "#!/bin/sh\n");
    await repo.setExec("run.sh", true);
    await repo.commit("exec");
    const ctx = await discover(repo.dir, { requireOverlay: true });

    await whiteout(ctx, ["run.sh"]);
    expect(await pathExists(repo.path("run.sh"))).toBe(false);
    await restoreToBase(ctx, ["run.sh"]);
    expect(await repo.isExec("run.sh")).toBe(true);
    await assertBaseClean(repo.dir);
  });

  test("taking ownership of a file the base ignores still works", async () => {
    const { repo } = await mkFixture();
    await repo.write(".gitignore", "secret.env\n");
    await repo.commit("ignore rules");
    const ctx = await discover(repo.dir, { requireOverlay: true });

    await repo.write("secret.env", "TOKEN=1\n");
    const r = await takeOwnership(ctx, ["secret.env"]);
    expect(r.changes).toEqual([{ path: "secret.env", from: "untracked", to: "add" }]);
    // `git add` would have refused this path; plumbing does not care.
    expect(await ctx.overlay.indexBlobOid("secret.env")).not.toBeNull();
    await assertBaseClean(repo.dir);
  });
});
