/**
 * `applyState` — the idempotent reconciler.
 *
 * Two properties are load-bearing and both are proved here by executing, not reasoning:
 *
 *  1. **Idempotency.** A second consecutive run reports `changed === false` and no
 *     non-`noop` action. "Fresh clone + one command reproduces the tree" rests on it.
 *  2. **Recovery.** Every row of the DESIGN.md §6.5 drift matrix — `git checkout -- .`,
 *     `git reset --hard`, `git clean -xfd`, `git stash -a`, and a `git pull` that
 *     resurrects a whiteout or clobbers an overlay-added file — is repaired by one
 *     `applyState`, byte for byte, because overlay content lives in the overlay repo and
 *     never only in the work-tree.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertBaseClean,
  cleanupAllSandboxes,
  makeSandbox,
  pathExists,
  WEIRD_NAMES,
  type Repo,
  type Sandbox,
  type Upstream,
} from "./helpers/harness.ts";
import { discover, type Context } from "../src/context.ts";
import { emptyManifest, ownedPaths, readManifest, setEntry, writeManifest } from "../src/manifest.ts";
import { currentExcludeBlock, ensureOverlayExcludes, syncExcludeBlock } from "../src/exclude.ts";
import {
  applyState,
  restoreToBase,
  stageOverlayContent,
  takeOwnership,
  whiteout,
  type ApplyReport,
} from "../src/ownership.ts";
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
  sb = await makeSandbox("apply");
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

/**
 * The DESIGN.md §6.5 layout, built with the real engine:
 *   `A.txt` overlay-added, `C.txt` overridden, `D.txt` whited out, `B.txt` plain base file.
 * Cloned from a local bare "remote" so `git pull` is a real operation.
 */
async function mkFixture(extra: Record<string, string> = {}): Promise<Fixture> {
  const upstream = await sb.mkUpstream("upstream", {
    "B.txt": "base B\n",
    "C.txt": "base C\n",
    "D.txt": "base D\n",
    ...extra,
  });
  const repo = await upstream.clone("base");
  // DESIGN §6.6: `.overgit/` is an ordinary git repository directory, so its GIT_DIR is
  // `.overgit/.git`. That is what makes `git clean -xfd` in the base skip it entirely.
  await repo.git("init", "--quiet", "-b", "main", ".overgit");
  const gd = repo.path(".overgit", ".git");
  await repo.git("--git-dir", gd, "config", "core.worktree", "../..");
  await repo.git("--git-dir", gd, "config", "status.showUntrackedFiles", "no");
  const ctx = await discover(repo.dir, { requireOverlay: true });
  await syncExcludeBlock(ctx, emptyManifest());
  await ensureOverlayExcludes(ctx);

  await repo.write("A.txt", "overlay A\n");
  await repo.write("C.txt", "overlay C\n");
  await takeOwnership(ctx, ["A.txt", "C.txt"]);
  await whiteout(ctx, ["D.txt"]);
  await ctx.overlay.commit("overlay v1");
  return { repo, ctx, upstream };
}

/** Every assertion that "the overlay is mounted correctly" boils down to. */
async function expectOverlayMounted(repo: Repo): Promise<void> {
  expect(await repo.read("A.txt")).toBe("overlay A\n");
  expect(await repo.read("C.txt")).toBe("overlay C\n");
  expect(await pathExists(repo.path("D.txt"))).toBe(false);
  expect(await repo.read("B.txt")).toBe("base B\n");
  expect((await repo.skipWorktreePaths()).sort()).toEqual(["C.txt", "D.txt"]);
}

function nonNoop(r: ApplyReport) {
  return r.actions.filter((a) => a.action !== "noop");
}

/* ------------------------------------------------------------------ idempotency */

describe("idempotency", () => {
  test("a second consecutive run is a complete no-op", async () => {
    const { repo, ctx } = await mkFixture();

    const first = await applyState(ctx);
    expect(first.changed).toBe(false); // the mutators already left it consistent
    const second = await applyState(ctx);
    expect(second.changed).toBe(false);
    expect(nonNoop(second)).toEqual([]);
    expect(second.backups).toEqual([]);
    await expectOverlayMounted(repo);
    await assertBaseClean(repo.dir);
  });

  test("after real drift, the first run changes things and the second does not", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.git("clean", "-xfd");
    await repo.git("checkout", "--", ".");

    const first = await applyState(ctx);
    expect(first.changed).toBe(true);
    const second = await applyState(ctx);
    expect(second.changed).toBe(false);
    expect(nonNoop(second)).toEqual([]);
    await expectOverlayMounted(repo);
    await assertBaseClean(repo.dir);
  });

  test("idempotent for exec bits and symlinks too", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("run.sh", "#!/bin/sh\necho hi\n");
    await repo.setExec("run.sh", true);
    await symlink("B.txt", repo.path("link"));
    await takeOwnership(ctx, ["run.sh", "link"]);
    await ctx.overlay.commit("modes");

    expect((await applyState(ctx)).changed).toBe(false);
    await rm(repo.path("run.sh"));
    await rm(repo.path("link"));

    const r = await applyState(ctx);
    expect(r.changed).toBe(true);
    expect(await repo.isExec("run.sh")).toBe(true);
    expect(await readlink(repo.path("link"))).toBe("B.txt");
    expect((await applyState(ctx)).changed).toBe(false);
  });

  test("a wrong exec bit alone counts as drift and is corrected", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("run.sh", "#!/bin/sh\n");
    await repo.setExec("run.sh", true);
    await takeOwnership(ctx, ["run.sh"]);
    await ctx.overlay.commit("exec");

    await chmod(repo.path("run.sh"), 0o644);
    const r = await applyState(ctx);
    expect(r.actions.find((a) => a.path === "run.sh")!.action).toBe("write-add");
    expect(await repo.isExec("run.sh")).toBe(true);
    expect((await applyState(ctx)).changed).toBe(false);
  });

  test("dry run reports the same work but writes nothing", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.git("clean", "-xfd");

    const dry = await applyState(ctx, { dryRun: true });
    expect(dry.changed).toBe(true);
    expect(dry.actions.find((a) => a.path === "A.txt")!.action).toBe("write-add");
    expect(await pathExists(repo.path("A.txt"))).toBe(false); // still gone

    const real = await applyState(ctx);
    expect(real.actions.filter((a) => a.action !== "noop").map((a) => a.path)).toEqual(
      dry.actions.filter((a) => a.action !== "noop").map((a) => a.path),
    );
    await expectOverlayMounted(repo);
  });
});

/* ------------------------------------------------------------------ the drift matrix */

describe("recovery from base git operations (DESIGN §6.5)", () => {
  test("git checkout -- . : overlay bytes survive, apply is a no-op", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.git("checkout", "--", ".");
    await expectOverlayMounted(repo);
    expect((await applyState(ctx)).changed).toBe(false);
    await assertBaseClean(repo.dir);
  });

  test("git reset --hard : overlay bytes and flags survive", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.git("reset", "--hard");
    await expectOverlayMounted(repo);
    expect((await applyState(ctx)).changed).toBe(false);
    await assertBaseClean(repo.dir);
  });

  test("git clean -xfd : takes the added file, leaves `.overgit/` completely alone", async () => {
    const { repo, ctx } = await mkFixture();
    // Force a real rescue first, so there is machine-local state with something to lose.
    await repo.write("C.txt", "bytes nobody expects\n");
    const rescued = (await applyState(ctx)).backups[0]!;
    expect(rescued).toStartWith(".overgit/local/backups/");

    // DESIGN §6.6: `.overgit/` is a git repository directory, so `clean` skips it. The
    // harness oracle runs a real `git clean -xfd` against a throwaway copy and asserts
    // `.overgit/` comes through byte-identical and still usable — overlay git internals,
    // `local/` and the rescued bytes included.
    const safe = await repo.assertCleanSafe();
    expect(safe.layout).toBe("overgit/.git");
    expect(safe.removed).toContain("A.txt");

    await repo.git("clean", "-xfd");
    expect(await pathExists(repo.path("A.txt"))).toBe(false);
    expect(await readFile(join(repo.dir, rescued), "utf8")).toBe("bytes nobody expects\n");
    expect(await ctx.overlay.headExists()).toBe(true);

    const r = await applyState(ctx);
    expect(r.actions.find((a) => a.path === "A.txt")).toEqual({
      path: "A.txt",
      action: "write-add",
      detail: "missing from the work-tree",
    });
    expect(r.backups).toEqual([]); // nothing was there to lose
    await expectOverlayMounted(repo);
    expect((await applyState(ctx)).changed).toBe(false);
    await assertBaseClean(repo.dir);
  });

  test("git clean -xffd still destroys the overlay — that is the documented limit", async () => {
    // Double-force means "remove nested repositories too", and git obeys. There is no code
    // fix for this; it belongs in the README next to the detach/attach limitation. Recorded
    // here so nobody later mistakes the `-xfd` protection for a general guarantee.
    const { repo } = await mkFixture();
    await repo.gitTry("clean", "-xffd");
    expect(await pathExists(repo.path(".overgit"))).toBe(false);
  });

  test("a missing overlay is a clean NO_OVERLAY error, never a raw git failure", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.gitTry("clean", "-xffd");

    for (const call of [
      () => applyState(ctx),
      () => takeOwnership(ctx, ["B.txt"]),
      () => whiteout(ctx, ["B.txt"]),
    ]) {
      let caught: unknown;
      try {
        await call();
      } catch (e) {
        caught = e;
      }
      expect(isOvergitError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe("NO_OVERLAY");
      expect((caught as { hint?: string }).hint).toContain("overgit init");
      // Specifically *not* "fatal: not a git repository: ...".
      expect((caught as Error).message).not.toContain("fatal:");
    }
  });

  test("git stash -a / git stash pop : survives, and apply repairs the gap", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.git("stash", "push", "--all", "-m", "everything");
    // `stash -a` takes the ignored A.txt away; overrides and whiteouts are unaffected.
    expect(await pathExists(repo.path("A.txt"))).toBe(false);

    const r = await applyState(ctx);
    expect(r.changed).toBe(true);
    await expectOverlayMounted(repo);

    await repo.gitTry("stash", "pop");
    // Whatever the stash put back, one apply makes the tree correct again.
    await applyState(ctx);
    await expectOverlayMounted(repo);
    expect((await applyState(ctx)).changed).toBe(false);
  });

  test("git pull that resurrects a whiteout : apply removes it again", async () => {
    const { repo, ctx, upstream } = await mkFixture();
    await upstream.changeFile("D.txt", "upstream changed D\n");
    await repo.git("pull", "--no-rebase", "--quiet");
    // Measured in DESIGN §6.5: the pull succeeds and D.txt comes back.
    expect(await pathExists(repo.path("D.txt"))).toBe(true);

    const r = await applyState(ctx);
    expect(r.actions.find((a) => a.path === "D.txt")!.action).toBe("remove-whiteout");
    // The resurrected bytes are the base's, already in its object store — no backup needed.
    expect(r.backups).toEqual([]);
    await expectOverlayMounted(repo);
    expect((await applyState(ctx)).changed).toBe(false);
    await assertBaseClean(repo.dir);
  });

  test("git pull that clobbers an overlay-added file : apply restores it and rescues the bytes", async () => {
    const { repo, ctx, upstream } = await mkFixture();
    await upstream.addFile("A.txt", "upstream's own A\n");
    await repo.git("pull", "--no-rebase", "--quiet");
    expect(await repo.read("A.txt")).toBe("upstream's own A\n");

    const r = await applyState(ctx);
    expect(await repo.read("A.txt")).toBe("overlay A\n");
    // No rescue: the clobbering bytes were the *base's* own committed content, so they are
    // already in the base object store and overwriting them loses nothing.
    expect(r.backups).toEqual([]);
    expect(await repo.show("A.txt")).toBe("upstream's own A\n");
    expect((await applyState(ctx)).changed).toBe(false);
  });

  test("a fresh clone of the overlay reproduces the tree with one applyState", async () => {
    const { repo, ctx, upstream } = await mkFixture();
    // Publish the overlay to a bare repo, exactly as `overgit push` would.
    const overlayRemote = await sb.mkBareRepo("overlay-remote");
    await ctx.overlay.run(["remote", "add", "origin", overlayRemote.dir]);
    await ctx.overlay.run(["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
    const wanted = await repo.snapshot({ exclude: [".overgit"] });

    // A brand-new machine: clone the base, clone the overlay, apply.
    const fresh = await upstream.clone("fresh");
    await fresh.git("clone", "--no-checkout", "--quiet", overlayRemote.dir, ".overgit");
    const fgd = fresh.path(".overgit", ".git");
    await fresh.git("--git-dir", fgd, "config", "core.worktree", "../..");
    await fresh.git("--git-dir", fgd, "config", "status.showUntrackedFiles", "no");
    const fctx = await discover(fresh.dir, { requireOverlay: true });
    // `read-tree HEAD` populates the index without touching the work-tree (bootstrap's job).
    await fctx.overlay.run(["read-tree", "HEAD"]);

    const r = await applyState(fctx);
    expect(r.changed).toBe(true);
    expect(await fresh.snapshot({ exclude: [".overgit"] })).toEqual(wanted);
    expect((await applyState(fctx)).changed).toBe(false);
    await assertBaseClean(fresh.dir);
  });
});

/* ------------------------------------------------------------------ backups */

describe("backup-on-surprise", () => {
  test("bytes matching neither the overlay nor the base are rescued and reported", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("C.txt", "something nobody has ever seen\n");

    const r = await applyState(ctx);
    expect(r.backups.length).toBe(1);
    expect(r.backups[0]).toStartWith(".overgit/local/backups/0001-");
    expect(await readFile(join(repo.dir, r.backups[0]!), "utf8")).toBe(
      "something nobody has ever seen\n",
    );
    expect(r.actions.some((a) => a.action === "backup" && a.detail === r.backups[0])).toBe(true);
    expect(await repo.read("C.txt")).toBe("overlay C\n");
  });

  test("bytes that ARE the base's content are not rescued (nothing would be lost)", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("C.txt", "base C\n"); // exactly the base blob
    const r = await applyState(ctx);
    expect(r.backups).toEqual([]);
    expect(r.actions.find((a) => a.path === "C.txt")!.action).toBe("write-override");
    expect(await repo.read("C.txt")).toBe("overlay C\n");
  });

  test("a resurrected whiteout with unexpected bytes is rescued before removal", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("D.txt", "someone recreated this by hand\n");

    const r = await applyState(ctx);
    expect(r.backups.length).toBe(1);
    expect(await readFile(join(repo.dir, r.backups[0]!), "utf8")).toBe(
      "someone recreated this by hand\n",
    );
    expect(await pathExists(repo.path("D.txt"))).toBe(false);
  });

  test("backup counters increment and the index log records provenance", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("C.txt", "surprise 1\n");
    await applyState(ctx);
    await repo.write("C.txt", "surprise 2\n");
    const r = await applyState(ctx);
    expect(r.backups[0]).toStartWith(".overgit/local/backups/0002-");

    const log = await readFile(repo.path(".overgit", "local", "backups", "index.log"), "utf8");
    const records = log.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records.map((x) => x["n"])).toEqual([1, 2]);
    expect(records.every((x) => x["path"] === "C.txt")).toBe(true);
  });

  test("dry run reports a rescue without writing one", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("C.txt", "surprise\n");
    const r = await applyState(ctx, { dryRun: true });
    expect(r.backups).toEqual([]);
    expect(r.actions.some((a) => a.action === "backup" && a.detail?.includes("dry run"))).toBe(true);
    expect(await pathExists(repo.path(".overgit/local/backups"))).toBe(false);
    expect(await repo.read("C.txt")).toBe("surprise\n");
  });
});

/* ------------------------------------------------------------------ repair semantics */

describe("what applyState reconciles", () => {
  test("it re-sets a skip-worktree bit that was cleared behind its back", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.git("update-index", "--no-skip-worktree", "C.txt");
    expect(await repo.skipWorktreePaths()).toEqual(["D.txt"]);

    const r = await applyState(ctx);
    expect(r.actions).toContainEqual({ path: "C.txt", action: "set-skip" });
    expect((await repo.skipWorktreePaths()).sort()).toEqual(["C.txt", "D.txt"]);
    expect((await applyState(ctx)).changed).toBe(false);
    await assertBaseClean(repo.dir);
  });

  test("it leaves a skip-worktree bit the overlay does not own alone", async () => {
    const { repo, ctx } = await mkFixture();
    // A user marking their own file is none of overgit's business; `doctor` reports it.
    await repo.git("update-index", "--skip-worktree", "B.txt");
    const r = await applyState(ctx);
    expect(r.changed).toBe(false);
    expect((await repo.skipWorktreePaths()).sort()).toEqual(["B.txt", "C.txt", "D.txt"]);
  });

  test("it regenerates a mangled exclude block and preserves the user's lines", async () => {
    const { repo, ctx } = await mkFixture();
    const excl = join(await repo.gitDir(), "info", "exclude");
    await writeFile(excl, "# my own note\n*.tmp\n");

    const r = await applyState(ctx);
    expect(r.actions).toContainEqual({
      path: ".git/info/exclude",
      action: "exclude",
      detail: "regenerated the managed block",
    });
    expect(await currentExcludeBlock(ctx)).toEqual(["/.overgit/", "/A.txt"]);
    expect((await readFile(excl, "utf8")).startsWith("# my own note\n*.tmp\n")).toBe(true);
    expect((await applyState(ctx)).changed).toBe(false);
    await assertBaseClean(repo.dir);
  });

  test("a manifest entry with no overlay content is reported, not acted on", async () => {
    const { repo, ctx } = await mkFixture();
    let m = await readManifest(ctx);
    m = setEntry(m, "ghost.txt", { kind: "add" });
    await writeManifest(ctx, m);

    const r = await applyState(ctx);
    const action = r.actions.find((a) => a.path === "ghost.txt")!;
    expect(action.action).toBe("noop");
    expect(action.detail).toContain("overgit doctor");
    expect(await pathExists(repo.path("ghost.txt"))).toBe(false);
    // The entry still earns its exclude line — the manifest says the overlay owns the
    // path, so the base must stay blind to it even while the content is missing. That is
    // the only change, and it does not repeat.
    expect(r.actions.filter((a) => a.action !== "noop").map((a) => a.action)).toEqual(["exclude"]);
    expect((await applyState(ctx)).changed).toBe(false);
  });

  test("a directory sitting where a file belongs needs --force", async () => {
    const { repo, ctx } = await mkFixture();
    await rm(repo.path("A.txt"));
    await mkdir(repo.path("A.txt", "surprise"), { recursive: true });
    await writeFile(repo.path("A.txt", "surprise", "x"), "inside\n");

    const soft = await applyState(ctx);
    expect(soft.actions.find((a) => a.path === "A.txt")!.detail).toContain("--force");
    expect(await pathExists(repo.path("A.txt", "surprise", "x"))).toBe(true);

    const forced = await applyState(ctx, { force: true });
    // The directory's contents are rescued first, then the file is written.
    expect(forced.actions.filter((a) => a.path === "A.txt").map((a) => a.action)).toEqual([
      "backup",
      "write-add",
    ]);
    expect(await repo.read("A.txt")).toBe("overlay A\n");
    // The rescue has to be the whole tree — a zero-byte placeholder would mean `--force`
    // quietly deleted the user's files.
    const backup = join(repo.dir, forced.backups[0]!);
    expect(await readFile(join(backup, "surprise", "x"), "utf8")).toBe("inside\n");
    expect((await applyState(ctx)).changed).toBe(false);
  });

  test("a directory rescue copies symlinks as symlinks rather than following them", async () => {
    const { repo, ctx } = await mkFixture();
    await rm(repo.path("A.txt"));
    await mkdir(repo.path("A.txt"), { recursive: true });
    await symlink("../../../etc/passwd", repo.path("A.txt", "escape"));

    const r = await applyState(ctx, { force: true });
    const backup = join(repo.dir, r.backups[0]!);
    expect(await readlink(join(backup, "escape"))).toBe("../../../etc/passwd");
    expect(await repo.read("A.txt")).toBe("overlay A\n");
  });

  test("it creates missing parent directories", async () => {
    const { repo, ctx } = await mkFixture();
    await repo.write("deep/nested/dir/file.txt", "deep\n");
    await takeOwnership(ctx, ["deep/nested/dir/file.txt"]);
    await ctx.overlay.commit("deep");
    await rm(repo.path("deep"), { recursive: true });

    await applyState(ctx);
    expect(await repo.read("deep/nested/dir/file.txt")).toBe("deep\n");
    expect((await applyState(ctx)).changed).toBe(false);
  });

  test("weird filenames survive a full clean → apply cycle", async () => {
    const { repo, ctx } = await mkFixture();
    for (const n of WEIRD_NAMES) await repo.write(n, `content of ${n}\n`);
    await takeOwnership(ctx, [...WEIRD_NAMES]);
    await ctx.overlay.commit("weird");
    const wanted = await repo.snapshot({ exclude: [".overgit"] });

    await repo.git("clean", "-xfd");
    for (const n of WEIRD_NAMES) expect(await pathExists(repo.path(n))).toBe(false);

    const r = await applyState(ctx);
    expect(r.changed).toBe(true);
    expect(await repo.snapshot({ exclude: [".overgit"] })).toEqual(wanted);
    expect((await applyState(ctx)).changed).toBe(false);
    await assertBaseClean(repo.dir);
  });

  test("an already-owned inexcludable path does not wedge applyState or restore", async () => {
    // `takeOwnership` refuses these now, but an older manifest or a hand-edit can still
    // contain one. The reconciler must carry on rather than throw — and `restore` must be
    // able to get the user back out.
    const { repo, ctx } = await mkFixture();
    const weird = "legacy\nname.txt";
    await repo.write(weird, "legacy content\n");
    // Plant it the way an old overgit would have: staged in the overlay + in the manifest.
    await stageOverlayContent(ctx, weird, "100644", new TextEncoder().encode("legacy content\n"));
    await writeManifest(ctx, setEntry(await readManifest(ctx), weird, { kind: "add" }));
    await ctx.overlay.commit("legacy overlay");

    const r = await applyState(ctx);
    expect(r.actions.find((a) => a.path === weird)!.action).toBe("noop");
    expect(await repo.read(weird)).toBe("legacy content\n");
    expect((await applyState(ctx)).changed).toBe(false); // still idempotent

    // The block *does* get the approximate `?` pattern. That is the deliberate choice for
    // an already-owned path: invisibility is the primary invariant, and omitting the line
    // would expose the file to the base's next `git add -A`. The residual risk to a sibling
    // is real, which is why `takeOwnership` refuses to create this state and why `doctor`
    // must report any that already exist.
    expect(await currentExcludeBlock(ctx)).toContain("/legacy?name.txt");

    // It is recoverable in both directions: the file can be restored...
    await restoreToBase(ctx, [weird], { keepFile: true });
    expect(ownedPaths(await readManifest(ctx))).not.toContain(weird);
    expect(await repo.read(weird)).toBe("legacy content\n");
    expect((await applyState(ctx)).changed).toBe(false);
    // ...and taking it again is refused, so the state cannot be recreated by accident.
    await expect(takeOwnership(ctx, [weird])).rejects.toThrow(/cannot be represented exactly/);
  });

  test("an empty manifest makes applyState a no-op that still writes the base block", async () => {
    const repo = await sb.mkBaseRepo("plain", { "x.txt": "x\n" });
    await repo.git("init", "--quiet", "-b", "main", ".overgit");
    const gd = repo.path(".overgit", ".git");
    await repo.git("--git-dir", gd, "config", "core.worktree", "../..");
    const ctx = await discover(repo.dir, { requireOverlay: true });

    const first = await applyState(ctx);
    expect(first.actions.map((a) => a.action)).toEqual(["exclude"]);
    expect(await currentExcludeBlock(ctx)).toEqual(["/.overgit/"]);
    expect((await applyState(ctx)).changed).toBe(false);
    await assertBaseClean(repo.dir);
  });
});
