/**
 * `overgit doctor`: problem detection and self-repair.
 *
 * Damage is applied with raw git or raw filesystem calls, never with overgit, so every
 * scenario here is a state a user can genuinely land in. The judgement call under test
 * throughout is drift (repair it) versus uncommitted work (never touch it).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertBaseClean,
  cleanupAllSandboxes,
  makeSandbox,
  snapshotTree,
  diffTrees,
  type Repo,
  type Sandbox,
  type TreeSnapshot,
  type Upstream,
} from "./helpers/harness.ts";

import { discover, type Context } from "../src/context.ts";
import { diagnose, repair, PROBLEM_IDS, type Problem, type ProblemId } from "../src/doctor.ts";
import { readManifest, writeManifest } from "../src/manifest.ts";
import { stageOverlayContent, takeOwnership, whiteout } from "../src/ownership.ts";

afterEach(cleanupAllSandboxes);

/* ------------------------------------------------------------------ hermetic env */

/**
 * `Git` spawns with a copy of `process.env`, so an in-process `diagnose(ctx)` would
 * otherwise read the developer's `~/.gitconfig`. `test/helpers/env.ts` documents this
 * exact pattern: copy the sandbox's env in, restore it afterwards.
 */
const ENV_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
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

const PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

function adoptEnv(sb: Sandbox): () => void {
  const saved = new Map<string, string | undefined>();
  for (const k of [...ENV_KEYS, ...PROXY_KEYS]) saved.set(k, process.env[k]);
  for (const k of ENV_KEYS) {
    const v = sb.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of PROXY_KEYS) delete process.env[k];
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/* ------------------------------------------------------------------ the fixture */

export const BASE_FILES: Record<string, string> = {
  "B.txt": "base B\n",
  "C.txt": "base C\n",
  "D.txt": "base D\n",
  "docs/note.md": "# base note\n",
};

const OVERLAY_A = "overlay A\n";
const OVERLAY_C = "overlay C\n";
const OVERLAY_NOTE = "# overlay note\n";
const OVERLAY_SH = "#!/bin/sh\necho overlay\n";

export interface Fixture {
  sb: Sandbox;
  upstream: Upstream;
  base: Repo;
  ctx: Context;
  /** Known-good work-tree snapshot: what `repair` must restore. */
  clean: TreeSnapshot;
  root: string;
  snapshot(): Promise<TreeSnapshot>;
}

/**
 * The standard overlay fixture, built with the real ownership engine:
 *
 *   A.txt         overlay `add`
 *   B.txt         plain base file, untouched
 *   C.txt         `override` (base has different bytes)
 *   D.txt         `delete` (whiteout)
 *   docs/note.md  `override` in a subdirectory
 *   bin/run.sh    overlay `add`, executable
 */
async function buildFixture(label: string): Promise<Fixture> {
  const sb = await makeSandbox(label);
  const restore = adoptEnv(sb);
  try {
    const upstream = await sb.mkUpstream("upstream", BASE_FILES);
    const base = await upstream.clone("base");

    // The overlay repo, exactly as `overgit init` will build it.
    await base.git("init", "--bare", "-b", "main", base.path(".overgit/.git"));
    const cfg = ".overgit/.git/config";
    await base.git("config", "--file", cfg, "core.bare", "false");
    await base.git("config", "--file", cfg, "core.worktree", "../..");
    await base.git("config", "--file", cfg, "status.showUntrackedFiles", "no");
    await base.mkdirp(".overgit/.git/info");
    await base.write(".overgit/.git/info/exclude", "");
    await base.mkdirp(".overgit/local");

    const ctx = await discover(base.dir, { requireOverlay: true });

    await base.write("A.txt", OVERLAY_A);
    await base.write("bin/run.sh", OVERLAY_SH);
    await base.setExec("bin/run.sh");

    await takeOwnership(ctx, ["A.txt", "bin/run.sh", "C.txt", "docs/note.md"], {
      repoRelative: true,
    });
    // Ownership records the *current* bytes; give the overrides their own content the way
    // a user would (edit, then commit).
    await base.write("C.txt", OVERLAY_C);
    await base.write("docs/note.md", OVERLAY_NOTE);
    await stageOverlayContent(ctx, "C.txt", "100644", new TextEncoder().encode(OVERLAY_C));
    await stageOverlayContent(
      ctx,
      "docs/note.md",
      "100644",
      new TextEncoder().encode(OVERLAY_NOTE),
    );
    await whiteout(ctx, ["D.txt"], { repoRelative: true });
    await ctx.overlay.commit("overlay: initial");

    const clean = await snapshotTree(base.dir);
    return {
      sb,
      upstream,
      base,
      ctx,
      clean,
      root: base.dir,
      snapshot: () => snapshotTree(base.dir),
    };
  } finally {
    restore();
  }
}

/** `buildFixture` + the sandbox env installed for the body + guaranteed cleanup. */
export async function withFixture(
  label: string,
  fn: (f: Fixture) => Promise<void>,
): Promise<void> {
  const f = await buildFixture(label);
  const restore = adoptEnv(f.sb);
  try {
    await fn(f);
  } finally {
    restore();
    await f.sb.cleanup();
  }
}

/* ------------------------------------------------------------------ assertions */

export function ids(problems: Problem[]): string[] {
  return [...new Set(problems.map((p) => p.id))].sort();
}

export function render(problems: Problem[]): string {
  if (problems.length === 0) return "(no problems)";
  return problems
    .map((p) => `  ${p.severity} ${p.id} ${p.path ?? "-"} fixable=${p.fixable}\n    ${p.message}\n    hint: ${p.hint}`)
    .join("\n");
}

export function find(problems: Problem[], id: ProblemId, path?: string): Problem {
  const hit = problems.find((p) => p.id === id && (path === undefined || p.path === path));
  if (!hit) {
    throw new Error(
      `expected a ${id} problem${path ? ` for ${path}` : ""}, got:\n${render(problems)}`,
    );
  }
  return hit;
}

export function expectNoProblems(problems: Problem[], what = "diagnose"): void {
  if (problems.length > 0) {
    throw new Error(`expected ${what} to report nothing, got:\n${render(problems)}`);
  }
}

export function expectNoErrors(problems: Problem[], what = "diagnose"): void {
  const errors = problems.filter((p) => p.severity === "error");
  if (errors.length > 0) {
    throw new Error(`expected ${what} to report no errors, got:\n${render(errors)}`);
  }
}

export function expectTreeEquals(actual: TreeSnapshot, want: TreeSnapshot, what: string): void {
  const d = diffTrees(actual, want, { a: "actual", b: "expected" });
  if (d !== "") throw new Error(`${what}\n${d}`);
}

/** diagnose → repair → diagnose; asserts the second repair has nothing left to do. */
export async function fixAll(
  ctx: Context,
): Promise<{ before: Problem[]; after: Problem[]; backups: string[] }> {
  const before = await diagnose(ctx);
  const r1 = await repair(ctx, before);
  const after = await diagnose(ctx);
  const r2 = await repair(ctx, after);
  if (r2.fixed.length > 0) {
    throw new Error(
      `repair is not idempotent: a second --fix still changed things:\n${render(r2.fixed)}`,
    );
  }
  return { before, after, backups: r1.backups };
}

/* ================================================================== the tests */

describe("a healthy overlay", () => {
  test("diagnoses clean, and the base cannot see the overlay", async () => {
    await withFixture("doctor-healthy", async (f) => {
      expectNoProblems(await diagnose(f.ctx));
      await assertBaseClean(f.root, { label: "healthy fixture" });

      // The fixture really is the §6.5 layout.
      expect(await f.base.read("A.txt")).toBe(OVERLAY_A);
      expect(await f.base.read("C.txt")).toBe(OVERLAY_C);
      expect(await f.base.exists("D.txt")).toBe(false);
      expect(await f.base.skipWorktreePaths()).toEqual(["C.txt", "D.txt", "docs/note.md"]);
      expect(await f.base.isExec("bin/run.sh")).toBe(true);
    });
  });

  test("repair on a healthy overlay changes nothing at all", async () => {
    await withFixture("doctor-healthy-noop", async (f) => {
      const before = await f.snapshot();
      const r = await repair(f.ctx, await diagnose(f.ctx));
      expect(r.fixed).toEqual([]);
      expect(r.backups).toEqual([]);
      expectTreeEquals(await f.snapshot(), before, "repair touched a healthy work-tree");
      expectNoProblems(await diagnose(f.ctx));
    });
  });
});

describe("uncommitted work is not drift", () => {
  test("an edited override is left alone by diagnose and by repair", async () => {
    await withFixture("doctor-user-edit", async (f) => {
      const mine = "overlay C, edited by me\n";
      await f.base.write("C.txt", mine);

      expectNoProblems(await diagnose(f.ctx), "diagnose on an uncommitted edit");

      await repair(f.ctx, await diagnose(f.ctx));
      expect(await f.base.read("C.txt")).toBe(mine);
      await assertBaseClean(f.root, { label: "edited override" });
    });
  });

  test("an edited overlay-added file is left alone", async () => {
    await withFixture("doctor-user-edit-add", async (f) => {
      const mine = "overlay A, work in progress\n";
      await f.base.write("A.txt", mine);
      expectNoProblems(await diagnose(f.ctx));
      await repair(f.ctx, await diagnose(f.ctx));
      expect(await f.base.read("A.txt")).toBe(mine);
    });
  });

  test("a brand-new untracked file is nobody's business", async () => {
    await withFixture("doctor-untracked", async (f) => {
      await f.base.write("scratch.txt", "notes\n");
      expectNoProblems(await diagnose(f.ctx));
      await repair(f.ctx, await diagnose(f.ctx));
      expect(await f.base.exists("scratch.txt")).toBe(true);
    });
  });

  test("an edit whose bytes happen to equal the base's IS drift, and is repaired", async () => {
    // This is the one case where "differs from the overlay" is not user work: only git
    // puts the base's exact bytes back over an override.
    await withFixture("doctor-base-bytes", async (f) => {
      await f.base.write("C.txt", BASE_FILES["C.txt"]!);
      const p = find(await diagnose(f.ctx), "worktree-content-drift", "C.txt");
      expect(p.severity).toBe("error");
      expect(p.fixable).toBe(true);

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await f.base.read("C.txt")).toBe(OVERLAY_C);
    });
  });
});

describe("manifest problems", () => {
  test("orphan-manifest-entry: entry with no overlay blob, file present → re-staged", async () => {
    await withFixture("doctor-orphan-entry-present", async (f) => {
      // Drop C.txt from the overlay index *and* history, keeping the manifest entry.
      await f.ctx.overlay.rmCached(["C.txt"]);
      await f.ctx.overlay.commit("overlay: drop C from history");

      const p = find(await diagnose(f.ctx), "orphan-manifest-entry", "C.txt");
      expect(p.severity).toBe("error");
      expect(p.hint).toContain("C.txt");

      const { after } = await fixAll(f.ctx);
      expectNoErrors(after);
      // The work-tree bytes are preserved and are now in the overlay.
      expect(await f.base.read("C.txt")).toBe(OVERLAY_C);
      expect(await f.ctx.overlay.indexBlobOid("C.txt")).not.toBeNull();
      await assertBaseClean(f.root, { label: "after orphan re-stage" });
    });
  });

  test("orphan-manifest-entry: nothing anywhere → the path goes back to the base", async () => {
    await withFixture("doctor-orphan-entry-absent", async (f) => {
      await f.ctx.overlay.rmCached(["C.txt"]);
      await f.ctx.overlay.commit("overlay: drop C from history");
      await rm(join(f.root, "C.txt"));

      find(await diagnose(f.ctx), "orphan-manifest-entry", "C.txt");
      const { after } = await fixAll(f.ctx);
      expectNoErrors(after);

      // The base's own content is back and the base is clean again.
      expect(await f.base.read("C.txt")).toBe(BASE_FILES["C.txt"]!);
      expect(await f.base.skipWorktreePaths()).not.toContain("C.txt");
      const m = await readManifest(f.ctx);
      expect(m.entries["C.txt"]).toBeUndefined();
      await assertBaseClean(f.root, { label: "after orphan restore" });
    });
  });

  test("orphan-overlay-file: overlay tracks a path the manifest never heard of", async () => {
    await withFixture("doctor-orphan-overlay", async (f) => {
      await f.base.write("extra.txt", "overlay extra\n");
      await stageOverlayContent(
        f.ctx,
        "extra.txt",
        "100644",
        new TextEncoder().encode("overlay extra\n"),
      );

      const p = find(await diagnose(f.ctx), "orphan-overlay-file", "extra.txt");
      expect(p.fixable).toBe(true);
      expect(p.hint).toContain("extra.txt");

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      const m = await readManifest(f.ctx);
      expect(m.entries["extra.txt"]).toEqual({ kind: "add" });
      // …and it is now hidden from the base.
      await assertBaseClean(f.root, { label: "after adopting an orphan overlay file" });
    });
  });

  test("orphan-overlay-file becomes an override when the base tracks the path", async () => {
    await withFixture("doctor-orphan-overlay-override", async (f) => {
      await stageOverlayContent(
        f.ctx,
        "B.txt",
        "100644",
        new TextEncoder().encode("overlay B\n"),
      );
      find(await diagnose(f.ctx), "orphan-overlay-file", "B.txt");

      await fixAll(f.ctx);
      const m = await readManifest(f.ctx);
      expect(m.entries["B.txt"]?.kind).toBe("override");
      expect((m.entries["B.txt"] as { baseBlob: string }).baseBlob).toBe(
        (await f.base.blobOid("B.txt"))!,
      );
      expect(await f.base.skipWorktreePaths()).toContain("B.txt");
      await assertBaseClean(f.root, { label: "after adopting an overriding orphan" });
    });
  });

  test("manifest-unreadable: broken JSON is backed up and rebuilt from the overlay", async () => {
    await withFixture("doctor-manifest-broken", async (f) => {
      await writeFile(f.ctx.manifestPath, "{ this is not json");

      const problems = await diagnose(f.ctx);
      const p = find(problems, "manifest-unreadable");
      expect(p.fixable).toBe(true);
      expect(p.hint).toContain("backups");
      // Nothing else is guessed at while the manifest is unreadable.
      expect(problems.filter((x) => x.path === "C.txt")).toEqual([]);

      const { after, backups } = await fixAll(f.ctx);
      expect(backups.length).toBeGreaterThan(0);
      expect(await readFile(join(f.root, backups[0]!), "utf8")).toBe("{ this is not json");

      // The manifest is tracked *by the overlay*, so its own history still holds a correct
      // copy — including the whiteout, which cannot be inferred from the overlay index at
      // all (a whiteout has no overlay file). Recover from the committed blob rather than
      // reconstructing and silently dropping every `delete` entry.
      const m = await readManifest(f.ctx);
      expect(Object.keys(m.entries).sort()).toEqual([
        "A.txt",
        "C.txt",
        "D.txt",
        "bin/run.sh",
        "docs/note.md",
      ]);
      expect(m.entries["C.txt"]?.kind).toBe("override");
      expect(m.entries["A.txt"]?.kind).toBe("add");
      expect(m.entries["D.txt"]?.kind).toBe("delete");
      expectNoErrors(after);
    });
  });

  test("manifest-not-tracked: the overlay index has no manifest entry", async () => {
    await withFixture("doctor-manifest-untracked", async (f) => {
      await f.ctx.overlay.rmCached([".overgit/manifest.json"]);
      const p = find(await diagnose(f.ctx), "manifest-not-tracked");
      expect(p.fixable).toBe(true);

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await f.ctx.overlay.indexBlobOid(".overgit/manifest.json")).not.toBeNull();
    });
  });

  test("base-blob-missing is reported, and never silently re-pointed", async () => {
    await withFixture("doctor-base-blob-missing", async (f) => {
      const m = await readManifest(f.ctx);
      m.entries["C.txt"] = { kind: "override", baseBlob: "0".repeat(40) };
      await writeManifest(f.ctx, m);

      const p = find(await diagnose(f.ctx), "base-blob-missing", "C.txt");
      expect(p.severity).toBe("error");
      expect(p.fixable).toBe(false);
      expect(p.hint).toContain("C.txt");
      expect(p.hint).toContain("overgit sync");

      const r = await repair(f.ctx, await diagnose(f.ctx));
      expect(r.fixed.map((x) => x.id)).not.toContain("base-blob-missing");
      // The recorded fork point is untouched — doctor does not invent a merge base.
      const after = await readManifest(f.ctx);
      expect((after.entries["C.txt"] as { baseBlob: string }).baseBlob).toBe("0".repeat(40));
    });
  });

  test("overlay-index-missing-entry: in HEAD but dropped from the index", async () => {
    await withFixture("doctor-overlay-index-gap", async (f) => {
      await f.ctx.overlay.rmCached(["C.txt"]); // still in overlay HEAD
      const p = find(await diagnose(f.ctx), "overlay-index-missing-entry", "C.txt");
      expect(p.severity).toBe("error");
      expect(p.fixable).toBe(true);

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await f.ctx.overlay.indexBlobOid("C.txt")).toBe(
        (await f.ctx.overlay.treeBlobOid("HEAD", "C.txt"))!,
      );
    });
  });

  test("whiteout-tracked-by-overlay is reported but never auto-resolved", async () => {
    await withFixture("doctor-whiteout-tracked", async (f) => {
      await stageOverlayContent(f.ctx, "D.txt", "100644", new TextEncoder().encode("ghost\n"));
      const p = find(await diagnose(f.ctx), "whiteout-tracked-by-overlay", "D.txt");
      expect(p.fixable).toBe(false);
      expect(p.hint).toContain("overgit add");
      expect(p.hint).toContain("D.txt");
    });
  });
});

describe("base index flags", () => {
  test("missing-skip-worktree: the bit cleared by hand", async () => {
    await withFixture("doctor-missing-skip", async (f) => {
      await f.base.git("update-index", "--no-skip-worktree", "C.txt");
      // The base can now see the override — this is exactly the leak doctor exists for.
      expect((await f.base.gitTry("status", "--porcelain")).stdout).toContain("C.txt");

      const p = find(await diagnose(f.ctx), "missing-skip-worktree", "C.txt");
      expect(p.severity).toBe("error");
      expect(p.fixable).toBe(true);
      expect(p.hint).toContain("update-index --skip-worktree");

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await f.base.skipWorktreePaths()).toContain("C.txt");
      await assertBaseClean(f.root, { label: "after restoring skip-worktree" });
    });
  });

  test("missing-skip-worktree on a whiteout, where git reports a deletion", async () => {
    await withFixture("doctor-missing-skip-whiteout", async (f) => {
      await f.base.git("update-index", "--no-skip-worktree", "D.txt");
      const p = find(await diagnose(f.ctx), "missing-skip-worktree", "D.txt");
      expect(p.message).toContain("deleted");

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await f.base.exists("D.txt")).toBe(false);
      await assertBaseClean(f.root, { label: "after restoring a whiteout bit" });
    });
  });

  test("stray-skip-worktree: a bit on a path overgit does not own is reported, not cleared", async () => {
    await withFixture("doctor-stray-skip", async (f) => {
      await f.base.git("update-index", "--skip-worktree", "B.txt");
      const p = find(await diagnose(f.ctx), "stray-skip-worktree", "B.txt");
      expect(p.severity).toBe("warning");
      expect(p.fixable).toBe(false);
      expect(p.hint).toContain("B.txt");
      expect(p.hint).toContain("--no-skip-worktree");

      await repair(f.ctx, await diagnose(f.ctx));
      // A bit the user set themselves survives `doctor --fix`.
      expect(await f.base.skipWorktreePaths()).toContain("B.txt");
    });
  });

  test("assume-unchanged-set: the lowercase-`s` case is seen and cleared", async () => {
    await withFixture("doctor-assume-unchanged", async (f) => {
      await f.base.git("update-index", "--assume-unchanged", "C.txt");
      // Measured on git 2.55: `ls-files -v` tags it `s`, not `S`.
      const raw = (await f.base.git("ls-files", "-v", "C.txt")).stdout;
      expect(raw.startsWith("s ")).toBe(true);

      const p = find(await diagnose(f.ctx), "assume-unchanged-set", "C.txt");
      expect(p.fixable).toBe(true);
      expect(p.hint).toContain("--no-assume-unchanged");

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect((await f.base.git("ls-files", "-v", "C.txt")).stdout.startsWith("S ")).toBe(true);
      expect(await f.base.skipWorktreePaths()).toContain("C.txt");
    });
  });

  test("base-index-diverged: a staged base change frozen behind skip-worktree", async () => {
    await withFixture("doctor-base-staged", async (f) => {
      await f.base.git("update-index", "--no-skip-worktree", "C.txt");
      await f.base.write("C.txt", "staged in the base\n");
      await f.base.git("add", "C.txt");
      await f.base.git("update-index", "--skip-worktree", "C.txt");
      await f.base.write("C.txt", OVERLAY_C);

      const p = find(await diagnose(f.ctx), "base-index-diverged", "C.txt");
      expect(p.fixable).toBe(false);
      expect(p.hint).toContain("restore --staged");
      expect(p.hint).toContain("C.txt");
    });
  });
});

describe("the base's exclude block", () => {
  async function excludePath(f: Fixture): Promise<string> {
    return join(await f.base.gitDir(), "info", "exclude");
  }

  test("the whole block deleted", async () => {
    await withFixture("doctor-exclude-gone", async (f) => {
      await writeFile(await excludePath(f), "# just a comment\n");
      const p = find(await diagnose(f.ctx), "missing-exclude-line");
      expect(p.fixable).toBe(true);

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await readFile(await excludePath(f), "utf8")).toContain("# just a comment");
      await assertBaseClean(f.root, { label: "after rebuilding the exclude block" });
    });
  });

  test("one line removed by hand", async () => {
    await withFixture("doctor-exclude-line", async (f) => {
      const p = await excludePath(f);
      const text = await readFile(p, "utf8");
      await writeFile(p, text.replace("/A.txt\n", ""));

      const problem = find(await diagnose(f.ctx), "missing-exclude-line");
      expect(problem.message).toContain("/A.txt");
      // The base can see A.txt right now.
      expect((await f.base.gitTry("status", "--porcelain")).stdout).toContain("A.txt");

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      await assertBaseClean(f.root, { label: "after restoring an exclude line" });
    });
  });

  test("a stale line for a path the overlay no longer owns", async () => {
    await withFixture("doctor-exclude-stale", async (f) => {
      const p = await excludePath(f);
      await writeFile(p, (await readFile(p, "utf8")).replace("/A.txt\n", "/A.txt\n/gone.txt\n"));

      const problem = find(await diagnose(f.ctx), "stale-exclude-line");
      expect(problem.severity).toBe("warning");
      expect(problem.message).toContain("/gone.txt");

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await readFile(p, "utf8")).not.toContain("/gone.txt");
    });
  });

  test("the block duplicated", async () => {
    await withFixture("doctor-exclude-dupe", async (f) => {
      const p = await excludePath(f);
      const text = await readFile(p, "utf8");
      await writeFile(p, text + text);

      const problem = find(await diagnose(f.ctx), "duplicate-exclude-block");
      expect(problem.severity).toBe("error");
      expect(problem.fixable).toBe(true);

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      const fixedText = await readFile(p, "utf8");
      expect(fixedText.split("# >>> overgit managed block").length - 1).toBe(1);
      await assertBaseClean(f.root, { label: "after collapsing duplicate blocks" });
    });
  });

  test("content outside the block survives a repair byte for byte", async () => {
    await withFixture("doctor-exclude-preserve", async (f) => {
      const p = await excludePath(f);
      const mine = "# my own rules\n*.tmp\nbuild/\n";
      await writeFile(p, mine + (await readFile(p, "utf8")).replace("/A.txt\n", ""));

      await fixAll(f.ctx);
      const after = await readFile(p, "utf8");
      expect(after.startsWith(mine)).toBe(true);
      expect(after).toContain("/A.txt");
    });
  });

  test("gitignore-pollution: overgit state in a tracked .gitignore", async () => {
    await withFixture("doctor-gitignore", async (f) => {
      await f.base.write(".gitignore", "node_modules/\n.overgit/\n/A.txt\n");
      await f.base.git("add", ".gitignore");
      await f.base.git("commit", "-m", "add gitignore");

      const problems = await diagnose(f.ctx);
      const hits = problems.filter((x) => x.id === "gitignore-pollution");
      expect(hits.length).toBe(2);
      expect(hits.map((h) => h.message).join("\n")).toContain(".overgit/");
      expect(hits.map((h) => h.message).join("\n")).toContain("/A.txt");
      for (const h of hits) {
        expect(h.fixable).toBe(false);
        expect(h.path).toBe(".gitignore");
        expect(h.hint).toContain(".gitignore");
      }

      // overgit must never rewrite a file the base tracks.
      const before = await f.base.read(".gitignore");
      await repair(f.ctx, problems);
      expect(await f.base.read(".gitignore")).toBe(before);
    });
  });

  test("a nested tracked .gitignore is checked too", async () => {
    await withFixture("doctor-gitignore-nested", async (f) => {
      await f.base.write("docs/.gitignore", "*.bak\n.overgit\n");
      await f.base.git("add", "docs/.gitignore");
      await f.base.git("commit", "-m", "nested gitignore");
      const p = find(await diagnose(f.ctx), "gitignore-pollution", "docs/.gitignore");
      expect(p.message).toContain("line 2");
    });
  });
});

describe("the overlay repo's own configuration", () => {
  test("core.worktree wrong → detected and reset to the relocatable form", async () => {
    await withFixture("doctor-cfg-worktree", async (f) => {
      await f.base.git("config", "--file", ".overgit/.git/config", "core.worktree", "/nowhere");
      const p = find(await diagnose(f.ctx), "overlay-config-broken", ".overgit/.git/config");
      expect(p.severity).toBe("error");
      expect(p.fixable).toBe(true);
      expect(p.message).toContain("/nowhere");

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(
        (await f.base.git("config", "--file", ".overgit/.git/config", "core.worktree")).stdout.trim(),
      ).toBe("../..");
    });
  });

  test("an absolute core.worktree is a warning even while it still resolves", async () => {
    await withFixture("doctor-cfg-worktree-abs", async (f) => {
      await f.base.git("config", "--file", ".overgit/.git/config", "core.worktree", f.root);
      const p = find(await diagnose(f.ctx), "overlay-config-broken");
      expect(p.severity).toBe("warning");
      expect(p.message).toContain("renamed or moved");
      await fixAll(f.ctx);
      expect(
        (await f.base.git("config", "--file", ".overgit/.git/config", "core.worktree")).stdout.trim(),
      ).toBe("../..");
    });
  });

  test("moving the whole project directory: relative core.worktree survives", async () => {
    await withFixture("doctor-cfg-move", async (f) => {
      const moved = f.sb.path("base-renamed");
      await f.base.git("config", "--file", ".overgit/.git/config", "core.worktree", f.root);
      await Bun.$`mv ${f.root} ${moved}`.quiet();

      const ctx = await discover(moved, { requireOverlay: true });
      const p = find(await diagnose(ctx), "overlay-config-broken");
      expect(p.severity).toBe("error"); // it no longer resolves to the root
      await fixAll(ctx);
      expectNoProblems(await diagnose(ctx));

      // Plain git, with no --work-tree override, now finds the work-tree again.
      const r = await f.sb.run(["git", `--git-dir=${join(moved, ".overgit/.git")}`, "rev-parse", "--show-toplevel"], { cwd: moved });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(moved);
    });
  });

  test("core.bare and status.showUntrackedFiles are checked and repaired", async () => {
    await withFixture("doctor-cfg-misc", async (f) => {
      const cfg = ".overgit/.git/config";
      await f.base.git("config", "--file", cfg, "core.bare", "true");
      await f.base.git("config", "--file", cfg, "--unset", "status.showUntrackedFiles");

      const problems = (await diagnose(f.ctx)).filter((p) => p.id === "overlay-config-broken");
      expect(problems.length).toBe(2);

      await fixAll(f.ctx);
      expect((await f.base.git("config", "--file", cfg, "core.bare")).stdout.trim()).toBe("false");
      expect(
        (await f.base.git("config", "--file", cfg, "status.showUntrackedFiles")).stdout.trim(),
      ).toBe("no");
    });
  });

  test("the overlay's own info/exclude is rebuilt when it goes missing", async () => {
    await withFixture("doctor-cfg-exclude", async (f) => {
      await rm(join(f.ctx.overlayGitDir, "info", "exclude"), { force: true });
      const p = find(await diagnose(f.ctx), "overlay-config-broken", ".overgit/.git/info/exclude");
      expect(p.fixable).toBe(true);

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      const text = await readFile(join(f.ctx.overlayGitDir, "info", "exclude"), "utf8");
      expect(text).toContain("/.overgit/.git/");
      expect(text).toContain("/.overgit/local/");
    });
  });
});

describe("machine-local state", () => {
  test("interrupted-lock: a lock from a dead process is removed", async () => {
    await withFixture("doctor-lock-dead", async (f) => {
      const lock = join(f.ctx.localDir, "lock");
      await mkdir(f.ctx.localDir, { recursive: true });
      // pid 2^22-ish: guaranteed not to exist in a test sandbox.
      await writeFile(lock, "4194303\n2021-01-01T00:00:00.000Z\n");

      const p = find(await diagnose(f.ctx), "interrupted-lock");
      expect(p.fixable).toBe(true);
      expect(p.hint).toContain(lock);

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await f.base.exists(".overgit/local/lock")).toBe(false);
    });
  });

  test("a lock held by a live process is reported but never broken", async () => {
    await withFixture("doctor-lock-live", async (f) => {
      const lock = join(f.ctx.localDir, "lock");
      await mkdir(f.ctx.localDir, { recursive: true });
      const live = await Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
      try {
        await writeFile(lock, `${live.pid}\n`);
        const p = find(await diagnose(f.ctx), "interrupted-lock");
        expect(p.fixable).toBe(false);
        expect(p.message).toContain(String(live.pid));

        await repair(f.ctx, await diagnose(f.ctx));
        expect(await f.base.exists(".overgit/local/lock")).toBe(true);
      } finally {
        live.kill();
      }
    });
  });

  test("sync-in-progress blocks the risky fixes and says why", async () => {
    await withFixture("doctor-sync-pending", async (f) => {
      await rm(join(f.root, "A.txt")); // real drift, normally fixable
      await mkdir(f.ctx.localDir, { recursive: true });
      await writeFile(
        join(f.ctx.localDir, "sync-state.json"),
        JSON.stringify({ startedAt: "2021-01-01T00:00:00Z", conflicts: {}, decisions: [], merged: [] }),
      );

      const problems = await diagnose(f.ctx);
      find(problems, "sync-in-progress");
      const drift = find(problems, "worktree-content-drift", "A.txt");
      expect(drift.fixable).toBe(false);
      expect(drift.hint).toContain("overgit sync --abort");

      await repair(f.ctx, problems);
      expect(await f.base.exists("A.txt")).toBe(false); // untouched, as promised

      // Finish the sync and the same drift becomes fixable.
      await rm(join(f.ctx.localDir, "sync-state.json"));
      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await f.base.read("A.txt")).toBe(OVERLAY_A);
    });
  });

  test("a corrupt sync-state.json is an error, not a shrug", async () => {
    await withFixture("doctor-sync-corrupt", async (f) => {
      await mkdir(f.ctx.localDir, { recursive: true });
      await writeFile(join(f.ctx.localDir, "sync-state.json"), "half-written{");
      const p = find(await diagnose(f.ctx), "sync-in-progress");
      expect(p.severity).toBe("error");
      expect(p.hint).toContain("overgit sync --abort");
    });
  });

  test("a stale detach marker on a mounted overlay is removed", async () => {
    await withFixture("doctor-detach-stale", async (f) => {
      await writeFile(join(f.ctx.localDir, "detached"), "");
      const p = find(await diagnose(f.ctx), "stale-detach-marker");
      expect(p.severity).toBe("error");
      expect(p.fixable).toBe(true);

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await f.base.exists(".overgit/local/detached")).toBe(false);
    });
  });

  test("a genuinely detached overlay is reported once, and never silently re-mounted", async () => {
    await withFixture("doctor-detached", async (f) => {
      // Hand-built detached state: base-pristine work-tree, no bits, no exclude block.
      await f.base.git("update-index", "--no-skip-worktree", "C.txt", "D.txt", "docs/note.md");
      await f.base.git("checkout", "--", "C.txt", "D.txt", "docs/note.md");
      await rm(join(f.root, "A.txt"));
      await rm(join(f.root, "bin/run.sh"));
      await writeFile(join(await f.base.gitDir(), "info", "exclude"), "");
      await writeFile(join(f.ctx.localDir, "detached"), "");

      const problems = await diagnose(f.ctx);
      expect(ids(problems)).toEqual(["overlay-detached"]);
      expect(problems[0]!.fixable).toBe(false);
      expect(problems[0]!.hint).toContain("overgit attach");

      const before = await f.snapshot();
      await repair(f.ctx, problems);
      expectTreeEquals(await f.snapshot(), before, "doctor re-mounted a detached overlay");
    });
  });
});

describe("refusing to make things worse", () => {
  test("mid-merge in the base: drift is reported, but nothing is touched", async () => {
    await withFixture("doctor-mid-merge", async (f) => {
      await rm(join(f.root, "A.txt"));
      await mkdir(join(await f.base.gitDir()), { recursive: true });
      await writeFile(join(await f.base.gitDir(), "MERGE_HEAD"), `${await f.base.head()}\n`);

      const problems = await diagnose(f.ctx);
      const op = find(problems, "base-operation-in-progress");
      expect(op.message).toContain("a merge");
      const drift = find(problems, "worktree-content-drift", "A.txt");
      expect(drift.fixable).toBe(false);
      expect(drift.hint).toContain("merge");

      const before = await f.snapshot();
      const r = await repair(f.ctx, problems);
      expectTreeEquals(await f.snapshot(), before, "doctor touched a mid-merge work-tree");
      expect(r.fixed.map((x) => x.id)).not.toContain("worktree-content-drift");

      // Finish the merge and the same repair goes through.
      await rm(join(await f.base.gitDir(), "MERGE_HEAD"));
      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await f.base.read("A.txt")).toBe(OVERLAY_A);
    });
  });

  test("mid-rebase is recognised as well", async () => {
    await withFixture("doctor-mid-rebase", async (f) => {
      await mkdir(join(await f.base.gitDir(), "rebase-merge"), { recursive: true });
      const p = find(await diagnose(f.ctx), "base-operation-in-progress");
      expect(p.message).toContain("a rebase");
      expect(p.hint).toContain("git rebase --continue");
    });
  });

  test("a detached base HEAD is reported without breaking anything", async () => {
    await withFixture("doctor-detached-head", async (f) => {
      await f.base.git("checkout", "--detach", "HEAD");
      const problems = await diagnose(f.ctx);
      const p = find(problems, "base-detached-head");
      expect(p.severity).toBe("warning");
      expectNoErrors(problems);
      await assertBaseClean(f.root, { label: "detached base HEAD" });
    });
  });

  test("a directory where a file belongs is reported, never deleted", async () => {
    await withFixture("doctor-dir-blocks", async (f) => {
      await rm(join(f.root, "A.txt"));
      await mkdir(join(f.root, "A.txt", "inner"), { recursive: true });
      await writeFile(join(f.root, "A.txt", "inner", "keep.txt"), "precious\n");

      const p = find(await diagnose(f.ctx), "path-blocked", "A.txt");
      expect(p.severity).toBe("error");
      expect(p.fixable).toBe(false);
      expect(p.hint).toContain("rm -r A.txt");

      await repair(f.ctx, await diagnose(f.ctx));
      expect(await f.base.read("A.txt/inner/keep.txt")).toBe("precious\n");
    });
  });

  test("a directory on a whiteout path is reported, never deleted", async () => {
    await withFixture("doctor-dir-whiteout", async (f) => {
      await mkdir(join(f.root, "D.txt"), { recursive: true });
      await writeFile(join(f.root, "D.txt", "note"), "hi\n");
      const p = find(await diagnose(f.ctx), "path-blocked", "D.txt");
      expect(p.fixable).toBe(false);
      expect(p.hint).toContain("rm -r D.txt");
      await repair(f.ctx, await diagnose(f.ctx));
      expect(await f.base.exists("D.txt/note")).toBe(true);
    });
  });

  test("case-collision: the manifest's spelling and the disk's disagree", async () => {
    await withFixture("doctor-case", async (f) => {
      await rm(join(f.root, "A.txt"));
      await writeFile(join(f.root, "a.txt"), OVERLAY_A);

      const p = find(await diagnose(f.ctx), "case-collision", "A.txt");
      expect(p.severity).toBe("error");
      expect(p.fixable).toBe(false);
      expect(p.hint).toContain("mv a.txt A.txt");

      // Critically: doctor must NOT "restore" A.txt next to a.txt — on a
      // case-insensitive filesystem that would clobber the user's file.
      await repair(f.ctx, await diagnose(f.ctx));
      expect(await f.base.exists("A.txt")).toBe(false);
      expect(await f.base.read("a.txt")).toBe(OVERLAY_A);
    });
  });
});

describe("worktree type and mode", () => {
  test("worktree-mode-drift: same bytes, lost exec bit → repaired", async () => {
    await withFixture("doctor-mode", async (f) => {
      await chmod(join(f.root, "bin/run.sh"), 0o644);
      const p = find(await diagnose(f.ctx), "worktree-mode-drift", "bin/run.sh");
      expect(p.severity).toBe("warning");
      expect(p.fixable).toBe(true);
      expect(p.hint).toContain("bin/run.sh");

      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await f.base.isExec("bin/run.sh")).toBe(true);
      expect(await f.base.read("bin/run.sh")).toBe(OVERLAY_SH);
    });
  });

  test("worktree-type-changed: a file replaced by a symlink is reported, not clobbered", async () => {
    await withFixture("doctor-symlink", async (f) => {
      await rm(join(f.root, "A.txt"));
      await f.base.symlink("B.txt", "A.txt");

      const p = find(await diagnose(f.ctx), "worktree-type-changed", "A.txt");
      expect(p.severity).toBe("warning");
      expect(p.fixable).toBe(false);
      expect(p.hint).toContain("overgit commit");

      await repair(f.ctx, await diagnose(f.ctx));
      expect(await f.base.readlink("A.txt")).toBe("B.txt");
    });
  });

  test("a symlink the overlay owns round-trips through repair", async () => {
    await withFixture("doctor-symlink-owned", async (f) => {
      await f.base.symlink("B.txt", "link.txt");
      await takeOwnership(f.ctx, ["link.txt"], { repoRelative: true });
      await f.ctx.overlay.commit("overlay: add a symlink");
      expectNoProblems(await diagnose(f.ctx));

      await rm(join(f.root, "link.txt"));
      find(await diagnose(f.ctx), "worktree-content-drift", "link.txt");
      const { after } = await fixAll(f.ctx);
      expectNoProblems(after);
      expect(await f.base.readlink("link.txt")).toBe("B.txt");
    });
  });
});

describe("the overlay repository", () => {
  test("no-overlay-head: an overlay with no commits", async () => {
    await withFixture("doctor-no-head", async (f) => {
      await rm(join(f.ctx.overlayGitDir, "refs", "heads"), { recursive: true, force: true });
      const p = find(await diagnose(f.ctx), "no-overlay-head");
      expect(p.severity).toBe("warning");
      expect(p.hint).toContain("overgit commit");
      // The overlay index still holds everything, so nothing else is broken.
      expectNoErrors(await diagnose(f.ctx));
    });
  });

  test("no overlay at all", async () => {
    const sb = await makeSandbox("doctor-no-overlay");
    const restore = adoptEnv(sb);
    try {
      const base = await sb.mkBaseRepo("plain", { "a.txt": "a\n" });
      const ctx = await discover(base.dir);
      const problems = await diagnose(ctx);
      expect(ids(problems)).toEqual(["no-overlay"]);
      expect(problems[0]!.hint).toContain("overgit init");
    } finally {
      restore();
      await sb.cleanup();
    }
  });
});

describe("contract", () => {
  test("every problem carries a hint that names its path and a command", async () => {
    await withFixture("doctor-hints", async (f) => {
      // Pile on as much unrelated damage as one repo can hold.
      await f.base.git("update-index", "--no-skip-worktree", "C.txt");
      await f.base.git("update-index", "--skip-worktree", "B.txt");
      await rm(join(f.root, "A.txt"));
      await writeFile(join(await f.base.gitDir(), "info", "exclude"), "");
      await writeFile(join(f.ctx.localDir, "lock"), "4194303\n");

      const problems = await diagnose(f.ctx);
      expect(problems.length).toBeGreaterThan(3);
      for (const p of problems) {
        expect(p.hint.length).toBeGreaterThan(20);
        expect(p.message.length).toBeGreaterThan(20);
        expect(PROBLEM_IDS).toContain(p.id);
        if (p.path !== undefined && !p.path.startsWith(".")) {
          expect(`${p.hint} ${p.message}`).toContain(p.path);
        }
      }
    });
  });

  test("every id in the frozen list exists", () => {
    const frozen: ProblemId[] = [
      "no-overlay-head",
      "manifest-unreadable",
      "orphan-manifest-entry",
      "orphan-overlay-file",
      "missing-skip-worktree",
      "stray-skip-worktree",
      "missing-exclude-line",
      "stale-exclude-line",
      "worktree-content-drift",
      "whiteout-resurrected",
      "base-blob-missing",
      "upstream-gone",
      "add-now-tracked-by-base",
      "sync-in-progress",
      "overlay-config-broken",
      "gitignore-pollution",
      "case-collision",
      "interrupted-lock",
    ];
    for (const id of frozen) expect(PROBLEM_IDS).toContain(id);
  });

  test("diagnose never mutates the repository", async () => {
    await withFixture("doctor-readonly", async (f) => {
      await rm(join(f.root, "A.txt"));
      await f.base.git("update-index", "--no-skip-worktree", "C.txt");

      const before = await f.snapshot();
      const beforeSkip = await f.base.skipWorktreePaths();
      const beforeExclude = await readFile(join(await f.base.gitDir(), "info", "exclude"), "utf8");

      await diagnose(f.ctx);
      await diagnose(f.ctx);

      expectTreeEquals(await f.snapshot(), before, "diagnose changed the work-tree");
      expect(await f.base.skipWorktreePaths()).toEqual(beforeSkip);
      expect(await readFile(join(await f.base.gitDir(), "info", "exclude"), "utf8")).toBe(
        beforeExclude,
      );
    });
  });
});
