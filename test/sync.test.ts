/**
 * `overgit sync`: the decisions, the interruptions, and the promise that nothing is lost.
 *
 * The merge arithmetic itself is proved against git in `test/merge.test.ts`. This file is
 * about everything around it — what sync refuses to decide on its own, what it records so
 * an interrupted run can be finished or undone, and whether the base repo can ever tell
 * that any of it happened.
 *
 * Deviation from the harness convention, declared: these drive `src/sync.ts` in process
 * rather than spawning `bin/overgit`, because sync's contract is the module API and the
 * plan/continue/abort states are easier to inspect there. Nothing is faked: real repos in
 * temp dirs, real `git`, real work-tree bytes, hermetic config, no network. The
 * interrupted-sync test does spawn a separate process, because that is the only honest way
 * to be killed mid-run.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertBaseClean,
  assertTreesEqual,
  cleanupAllSandboxes,
  expectExit,
  expectOk,
  makeSandbox,
  overgit,
  PROJECT_ROOT,
  snapshotTree,
  type Repo,
  type Sandbox,
  type Upstream,
} from "./helpers/harness.ts";

import type { Context } from "../src/context.ts";
import { attach, detach, initOverlay } from "../src/bootstrap.ts";
import { takeOwnership, whiteout } from "../src/ownership.ts";
import { readManifest } from "../src/manifest.ts";
import { computeStatus } from "../src/status.ts";
import { isOvergitError } from "../src/errors.ts";
import {
  abortSync,
  continueSync,
  decide,
  markResolved,
  planSync,
  readSyncState,
  runSync,
} from "../src/sync.ts";

/* ------------------------------------------------------------------ fixture */

function applyEnv(env: Record<string, string>): () => void {
  const scrub = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ];
  const saved = new Map<string, string | undefined>();
  for (const k of [...Object.keys(env), ...scrub]) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  Object.assign(process.env, env);
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

interface Fx {
  sb: Sandbox;
  upstream: Upstream;
  base: Repo;
  ctx: Context;
  close(): Promise<void>;
}

const open: Fx[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  await cleanupAllSandboxes();
});

async function mkFixture(label: string, baseFiles: Record<string, string>): Promise<Fx> {
  const sb = await makeSandbox(label);
  const restore = applyEnv(sb.env);
  const upstream = await sb.mkUpstream("upstream", baseFiles);
  const base = await upstream.clone("base");
  const { ctx } = await initOverlay(base.dir);
  const fx: Fx = {
    sb,
    upstream,
    base,
    ctx,
    async close() {
      restore();
      await sb.cleanup();
    },
  };
  open.push(fx);
  return fx;
}

async function override(fx: Fx, files: Record<string, string>): Promise<void> {
  for (const [p, c] of Object.entries(files)) await fx.base.write(p, c);
  await takeOwnership(fx.ctx, Object.keys(files), { repoRelative: true });
  await fx.ctx.overlay.commit(`overlay: own ${Object.keys(files).join(", ")}`);
}

async function add(fx: Fx, files: Record<string, string>): Promise<void> {
  await override(fx, files);
}

async function detachedPull(fx: Fx): Promise<void> {
  await detach(fx.ctx);
  await fx.base.git("pull", "--no-rebase", "origin", "main");
  await attach(fx.ctx);
}

const ORIGINAL = lines(20);
const OURS = lines(20, { 3: "line 3 — overlay" });
const THEIRS = lines(20, { 17: "line 17 — upstream" });
const THEIRS_CLASH = lines(20, { 3: "line 3 — upstream" });

function lines(n: number, mark: Record<number, string> = {}): string {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) out.push(mark[i] ?? `line ${i}`);
  return out.join("\n") + "\n";
}

async function expectThrows(fn: () => Promise<unknown>, code: string): Promise<Error> {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  if (caught === undefined) throw new Error(`expected an OvergitError(${code}), but nothing was thrown`);
  if (!isOvergitError(caught)) throw caught;
  if (caught.code !== code) {
    throw new Error(`expected code ${code}, got ${caught.code}: ${caught.message}`);
  }
  return caught as unknown as Error;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ no-op */

describe("nothing to do", () => {
  test("a sync with no upstream movement is a clean no-op, twice", async () => {
    const fx = await mkFixture("sync-noop", { "C.txt": ORIGINAL, "D.txt": "d\n", "B.txt": "b\n" });
    await override(fx, { "C.txt": OURS });
    await add(fx, { "A.txt": "overlay only\n" });
    await whiteout(fx.ctx, ["D.txt"], { repoRelative: true });

    const before = await snapshotTree(fx.base.dir);

    for (const pass of [1, 2]) {
      const report = await runSync(fx.ctx);
      expect(report.merged).toEqual([]);
      expect(report.conflicted).toEqual([]);
      expect(report.pendingDecision).toEqual([]);
      expect(report.whiteoutsRepaired).toEqual([]);
      expect(report.skipped).toEqual([]);
      expect(report.unchanged.sort()).toEqual(["A.txt", "C.txt", "D.txt"]);
      expect(report.syncInProgress).toBe(false);
      expect(await readSyncState(fx.ctx)).toBeNull();
      assertTreesEqual(await snapshotTree(fx.base.dir), before, `pass ${pass} changed the work-tree`);
    }

    await assertBaseClean(fx.base.dir, { label: "after two no-op syncs" });
  });

  test("an overlay that owns nothing syncs cleanly", async () => {
    const fx = await mkFixture("sync-empty", { "B.txt": "b\n" });
    const report = await runSync(fx.ctx);
    expect(report.unchanged).toEqual([]);
    expect(report.syncInProgress).toBe(false);
    expect(await readSyncState(fx.ctx)).toBeNull();
  });
});

/* ------------------------------------------------------------------ conflicts */

describe("conflicts", () => {
  test("a conflict blocks its own path only, and the base stays blind", async () => {
    const fx = await mkFixture("sync-conflict-scope", {
      "boom.txt": ORIGINAL,
      "fine.txt": ORIGINAL,
      "quiet.txt": "q\n",
    });
    await override(fx, { "boom.txt": OURS, "fine.txt": OURS });
    await add(fx, { "A.txt": "overlay only\n" });
    const before = await readManifest(fx.ctx);

    await fx.upstream.push("upstream moves two", { "boom.txt": THEIRS_CLASH, "fine.txt": THEIRS });
    await detachedPull(fx);

    const report = await runSync(fx.ctx);
    expect(report.conflicted).toEqual(["boom.txt"]);
    expect(report.merged).toEqual(["fine.txt"]);
    expect(report.unchanged).toEqual(["A.txt"]);
    expect(report.syncInProgress).toBe(true);

    // The fork point moved for the resolved path and stood still for the conflicted one.
    const after = await readManifest(fx.ctx);
    expect(after.entries["boom.txt"]).toEqual(before.entries["boom.txt"]!);
    expect(after.entries["fine.txt"]).not.toEqual(before.entries["fine.txt"]!);

    // Conflict markers are sitting in a tracked file and the base still sees nothing.
    expect(await fx.base.read("boom.txt")).toContain("<<<<<<<");
    await assertBaseClean(fx.base.dir, { label: "conflicted override" });

    // ...and the rest of the tool keeps working while the conflict is pending.
    const status = await computeStatus(fx.ctx);
    expect(status.syncInProgress).toBe(true);
    expect(status.files.map((f) => f.path).sort()).toEqual(["A.txt", "boom.txt", "fine.txt"]);

    const plan = await planSync(fx.ctx);
    expect(plan.items).toHaveLength(3);
  });

  test("a second sync refuses with SYNC_IN_PROGRESS and names --continue / --abort", async () => {
    const fx = await mkFixture("sync-in-progress", { "C.txt": ORIGINAL });
    await override(fx, { "C.txt": OURS });
    await fx.upstream.changeFile("C.txt", THEIRS_CLASH);
    await detachedPull(fx);
    await runSync(fx.ctx);

    const err = await expectThrows(() => runSync(fx.ctx), "SYNC_IN_PROGRESS");
    expect(err.message).toContain("still in progress");
    const oe = err as unknown as { hint?: string; details: string[]; exitCode: number };
    expect(oe.hint).toContain("--continue");
    expect(oe.hint).toContain("--abort");
    expect(oe.details).toContain("conflict: C.txt");
    expect(oe.exitCode).toBe(3);

    // A dry run is still allowed while a sync is stuck — that is when you want it most.
    const dry = await runSync(fx.ctx, { dryRun: true });
    expect(dry.syncInProgress).toBe(true);
  });

  test("--continue refuses a file that still has markers, then accepts the resolution", async () => {
    const fx = await mkFixture("sync-continue", { "C.txt": ORIGINAL, "E.txt": ORIGINAL });
    await override(fx, { "C.txt": OURS, "E.txt": OURS });
    await fx.upstream.push("clash", { "C.txt": THEIRS_CLASH, "E.txt": THEIRS_CLASH });
    await detachedPull(fx);
    const upstreamC = (await fx.base.blobOid("C.txt"))!;

    const first = await runSync(fx.ctx);
    expect(first.conflicted.sort()).toEqual(["C.txt", "E.txt"]);

    // Half-finished edit: markers still present.
    await expectThrows(() => continueSync(fx.ctx), "CONFLICTS_PENDING");
    // A refused --continue changes nothing: both paths are still conflicted.
    expect(Object.keys((await readSyncState(fx.ctx))!.conflicts).sort()).toEqual([
      "C.txt",
      "E.txt",
    ]);

    const resolved = lines(20, { 3: "line 3 — resolved by hand" });
    await fx.base.write("C.txt", resolved);
    await fx.base.write("E.txt", resolved);

    const report = await continueSync(fx.ctx);
    expect(report.merged.sort()).toEqual(["C.txt", "E.txt"]);
    expect(await readSyncState(fx.ctx)).toBeNull();

    // The resolution is the overlay's content now, and the fork point finally advanced.
    const m = await readManifest(fx.ctx);
    expect(m.entries["C.txt"]).toEqual({ kind: "override", baseBlob: upstreamC });
    const staged = await fx.ctx.overlay.indexBlobOid("C.txt");
    expect(new TextDecoder().decode(await fx.ctx.overlay.catFileBlob(staged!))).toBe(resolved);
    await assertBaseClean(fx.base.dir, { label: "after --continue" });
  });

  test("markResolved handles one path at a time and leaves the rest pending", async () => {
    const fx = await mkFixture("sync-mark", { "C.txt": ORIGINAL, "E.txt": ORIGINAL });
    await override(fx, { "C.txt": OURS, "E.txt": OURS });
    await fx.upstream.push("clash", { "C.txt": THEIRS_CLASH, "E.txt": THEIRS_CLASH });
    await detachedPull(fx);
    await runSync(fx.ctx);

    await fx.base.write("C.txt", "resolved C\n");
    const report = await markResolved(fx.ctx, ["C.txt"]);
    expect(report.merged).toEqual(["C.txt"]);
    expect(report.conflicted).toEqual(["E.txt"]);
    expect(report.syncInProgress).toBe(true);

    const state = (await readSyncState(fx.ctx))!;
    expect(Object.keys(state.conflicts)).toEqual(["E.txt"]);
  });

  test("a conflict can be decided outright with --keep or --take-upstream", async () => {
    const fx = await mkFixture("sync-decide-conflict", { "C.txt": ORIGINAL, "E.txt": ORIGINAL });
    await override(fx, { "C.txt": OURS, "E.txt": OURS });
    await fx.upstream.push("clash", { "C.txt": THEIRS_CLASH, "E.txt": THEIRS_CLASH });
    await detachedPull(fx);
    const upstreamText = await fx.base.show("E.txt");
    await runSync(fx.ctx);

    await decide(fx.ctx, "C.txt", "keep");
    expect(await fx.base.read("C.txt")).toBe(OURS);

    const report = await decide(fx.ctx, "E.txt", "take-upstream");
    expect(await fx.base.read("E.txt")).toBe(upstreamText);
    expect(report.syncInProgress).toBe(false);
    expect(await readSyncState(fx.ctx)).toBeNull();
    await assertBaseClean(fx.base.dir, { label: "after conflict decisions" });
  });
});

/* ------------------------------------------------------------------ abort */

describe("abort", () => {
  test("--abort restores every touched file byte-exactly and leaves baseBlob alone", async () => {
    const fx = await mkFixture("sync-abort", {
      "clean.txt": ORIGINAL,
      "boom.txt": ORIGINAL,
      "still.txt": "s\n",
      "gone.txt": "g\n",
    });
    await override(fx, { "clean.txt": OURS, "boom.txt": OURS, "still.txt": "overlay still\n" });
    await add(fx, { "A.txt": "overlay only\n" });
    await whiteout(fx.ctx, ["gone.txt"], { repoRelative: true });

    await fx.upstream.push("upstream moves both", {
      "clean.txt": THEIRS,
      "boom.txt": THEIRS_CLASH,
      "gone.txt": "g v2\n",
    });
    await detachedPull(fx);

    // An uncommitted overlay edit must survive the round trip too.
    await fx.base.write("still.txt", "overlay still, edited\n");

    const treeBefore = await snapshotTree(fx.base.dir);
    const manifestBefore = await readManifest(fx.ctx);
    const overlayBefore = await fx.ctx.overlay.lsFiles();

    const report = await runSync(fx.ctx);
    expect(report.merged).toEqual(["clean.txt"]);
    expect(report.conflicted).toEqual(["boom.txt"]);
    expect(report.whiteoutsRepaired).toEqual(["gone.txt"]);

    // Something really did change, or the restore below proves nothing.
    expect(await snapshotTree(fx.base.dir)).not.toEqual(treeBefore);

    await abortSync(fx.ctx);

    assertTreesEqual(
      await snapshotTree(fx.base.dir),
      treeBefore,
      "abort did not restore the work-tree byte-exactly",
    );
    expect(await readManifest(fx.ctx)).toEqual(manifestBefore);
    expect(await fx.ctx.overlay.lsFiles()).toEqual(overlayBefore);
    expect(await readSyncState(fx.ctx)).toBeNull();
    expect(await fx.base.read("still.txt")).toBe("overlay still, edited\n");
    await assertBaseClean(fx.base.dir, { label: "after abort" });

    // And the same sync can simply be run again.
    const again = await runSync(fx.ctx);
    expect(again.merged).toEqual(["clean.txt"]);
    expect(again.conflicted).toEqual(["boom.txt"]);
  });

  test("abort without a sync in progress refuses, but continue is a no-op", async () => {
    const fx = await mkFixture("sync-abort-none", { "C.txt": ORIGINAL });

    // Aborting nothing is a genuine sign of confusion, so it still errors.
    await expectThrows(() => abortSync(fx.ctx), "NO_SYNC_IN_PROGRESS");

    // `--continue` must NOT error. `overgit resolve` finishes the sync itself once the
    // last conflict is marked, and the conflict message tells the user to run `resolve`
    // *and* `sync --continue` — so the tool's own documented sequence lands here every
    // time. Erroring would mean following the printed instructions produces an error.
    const r = await continueSync(fx.ctx);
    expect(r.alreadyFinished).toBe(true);
    expect(r.merged).toEqual([]);
    expect(r.conflicted).toEqual([]);
    expect(r.syncInProgress).toBe(false);
  });

  test("hand-edited conflict files are still restored by abort", async () => {
    const fx = await mkFixture("sync-abort-edited", { "C.txt": ORIGINAL });
    await override(fx, { "C.txt": OURS });
    await fx.upstream.changeFile("C.txt", THEIRS_CLASH);
    await detachedPull(fx);

    const treeBefore = await snapshotTree(fx.base.dir);
    await runSync(fx.ctx);
    await fx.base.write("C.txt", "a half-finished manual resolution\n");

    await abortSync(fx.ctx);
    assertTreesEqual(await snapshotTree(fx.base.dir), treeBefore, "abort after a hand edit");
    expect(await fx.base.read("C.txt")).toBe(OURS);
  });
});

/* ------------------------------------------------------------------ decisions */

describe("upstream deleted an overridden file", () => {
  async function deletedFixture(label: string): Promise<Fx> {
    const fx = await mkFixture(label, { "C.txt": ORIGINAL, "B.txt": "b\n" });
    await override(fx, { "C.txt": OURS });
    await fx.upstream.deleteFile("C.txt");
    await detachedPull(fx);
    return fx;
  }

  test("it is surfaced as a decision and never auto-resolved", async () => {
    const fx = await deletedFixture("sync-deleted-plan");
    const before = await readManifest(fx.ctx);

    const plan = await planSync(fx.ctx);
    expect(plan.needsDecision.map((i) => i.path)).toEqual(["C.txt"]);
    expect(plan.needsDecision[0]!.situation).toBe("upstream-deleted");
    expect(plan.needsDecision[0]!.toBlob).toBeNull();

    const report = await runSync(fx.ctx);
    expect(report.pendingDecision.map((i) => i.path)).toEqual(["C.txt"]);
    expect(report.merged).toEqual([]);
    expect(report.syncInProgress).toBe(true);

    // Untouched: same bytes, same fork point.
    expect(await fx.base.read("C.txt")).toBe(OURS);
    expect(await readManifest(fx.ctx)).toEqual(before);

    // Running sync again while the decision is open refuses rather than guessing.
    await expectThrows(() => runSync(fx.ctx), "SYNC_IN_PROGRESS");
    await expectThrows(() => continueSync(fx.ctx), "DECISION_REQUIRED");
  });

  test("--keep turns the override into an overlay add", async () => {
    const fx = await deletedFixture("sync-deleted-keep");
    await runSync(fx.ctx);

    const report = await decide(fx.ctx, "C.txt", "keep");
    expect(report.syncInProgress).toBe(false);

    const m = await readManifest(fx.ctx);
    expect(m.entries["C.txt"]).toEqual({ kind: "add" });
    expect(await fx.base.read("C.txt")).toBe(OURS);
    expect(await fx.base.skipWorktreePaths()).not.toContain("C.txt");
    expect(await fx.base.excludeLines()).toContain("/C.txt");
    expect(await fx.ctx.overlay.indexBlobOid("C.txt")).not.toBeNull();
    await assertBaseClean(fx.base.dir, { label: "after --keep" });

    // Idempotent: nothing left to sync.
    const after = await runSync(fx.ctx);
    expect(after.unchanged).toEqual(["C.txt"]);
  });

  test("--drop gives the path up entirely and removes the file", async () => {
    const fx = await deletedFixture("sync-deleted-drop");
    await runSync(fx.ctx);
    await decide(fx.ctx, "C.txt", "drop");

    const m = await readManifest(fx.ctx);
    expect(m.entries["C.txt"]).toBeUndefined();
    expect(await fx.base.exists("C.txt")).toBe(false);
    expect(await fx.ctx.overlay.indexBlobOid("C.txt")).toBeNull();
    expect(await readSyncState(fx.ctx)).toBeNull();
    await assertBaseClean(fx.base.dir, { label: "after --drop" });
  });

  test("--take-upstream agrees with the deletion, and the bytes are still rescued", async () => {
    const fx = await deletedFixture("sync-deleted-take");
    await runSync(fx.ctx);
    const report = await decide(fx.ctx, "C.txt", "take-upstream");

    expect(await fx.base.exists("C.txt")).toBe(false);
    expect((await readManifest(fx.ctx)).entries["C.txt"]).toBeUndefined();
    expect(report.backups.length).toBeGreaterThan(0);
    const rescued = await readFile(join(fx.base.dir, report.backups[0]!), "utf8");
    expect(rescued).toBe(OURS);
    await assertBaseClean(fx.base.dir, { label: "after --take-upstream" });
  });

  test("an invalid decision is refused with the valid ones named", async () => {
    const fx = await deletedFixture("sync-deleted-bad");
    await runSync(fx.ctx);
    const err = await expectThrows(() => decide(fx.ctx, "C.txt", "adopt"), "USAGE");
    expect((err as unknown as { hint?: string }).hint).toContain("--keep");
    expect((err as unknown as { hint?: string }).hint).toContain("--drop");
    // Still pending, nothing half-applied.
    expect((await readSyncState(fx.ctx))!.decisions).toHaveLength(1);
  });

  test("a whited-out path deleted upstream is dropped, not resurrected", async () => {
    const fx = await mkFixture("sync-deleted-whiteout", { "D.txt": "d\n", "B.txt": "b\n" });
    await whiteout(fx.ctx, ["D.txt"], { repoRelative: true });
    await fx.upstream.deleteFile("D.txt");
    await detachedPull(fx);

    const report = await runSync(fx.ctx);
    expect(report.pendingDecision.map((i) => i.path)).toEqual(["D.txt"]);
    await decide(fx.ctx, "D.txt", "drop");

    expect((await readManifest(fx.ctx)).entries["D.txt"]).toBeUndefined();
    expect(await fx.base.exists("D.txt")).toBe(false);
    await assertBaseClean(fx.base.dir, { label: "whiteout deleted upstream" });
  });
});

describe("upstream added a path the overlay adds (collision)", () => {
  /** Builds the collision with a **plain** `git pull`, which succeeds and overwrites. */
  async function collisionFixture(label: string): Promise<Fx> {
    const fx = await mkFixture(label, { "B.txt": "b\n" });
    await add(fx, { "A.txt": lines(10, { 2: "line 2 — overlay" }) });

    await fx.upstream.addFile("A.txt", lines(10, { 8: "line 8 — upstream" }));
    const pull = await fx.base.gitTry("pull", "--no-rebase", "origin", "main");
    expect(pull.code).toBe(0); // measured in §6.5: the ignored file is silently overwritten
    return fx;
  }

  test("the collision is a decision, and the overlay's bytes are safe in the overlay", async () => {
    const fx = await collisionFixture("sync-collide-plan");

    // §6.5, re-measured: git overwrote the overlay's work-tree file with upstream's.
    expect(await fx.base.read("A.txt")).toContain("line 8 — upstream");
    expect(await fx.base.read("A.txt")).not.toContain("line 2 — overlay");

    const plan = await planSync(fx.ctx);
    expect(plan.needsDecision.map((i) => i.situation)).toEqual(["add-collision"]);

    const report = await runSync(fx.ctx);
    expect(report.pendingDecision.map((i) => i.path)).toEqual(["A.txt"]);
    expect((await readManifest(fx.ctx)).entries["A.txt"]).toEqual({ kind: "add" });
  });

  test("--adopt converts it to an override with the new baseBlob", async () => {
    const fx = await collisionFixture("sync-collide-adopt");
    const upstreamBlob = (await fx.base.blobOid("A.txt"))!;
    await runSync(fx.ctx);

    const report = await decide(fx.ctx, "A.txt", "adopt");

    // The ownership change lands immediately and unconditionally: `baseBlob` is
    // *established* (an `add` had none) rather than advanced past one, because the base
    // tracks the path now and an exclude line cannot hide a tracked file.
    expect((await readManifest(fx.ctx)).entries["A.txt"]).toEqual({
      kind: "override",
      baseBlob: upstreamBlob,
    });
    expect(await fx.base.skipWorktreePaths()).toContain("A.txt");
    expect(await fx.base.excludeLines()).not.toContain("/A.txt");

    // There is no common ancestor, so a genuinely divergent file conflicts, and both
    // sides' content is in the work-tree to reconcile.
    expect(report.conflicted).toEqual(["A.txt"]);
    const merged = await fx.base.read("A.txt");
    expect(merged).toContain("line 2 — overlay");
    expect(merged).toContain("line 8 — upstream");
    await assertBaseClean(fx.base.dir, { label: "after --adopt" });

    await fx.base.write("A.txt", "reconciled\n");
    await continueSync(fx.ctx);
    const after = await runSync(fx.ctx);
    expect(after.unchanged).toEqual(["A.txt"]);
    expect(after.syncInProgress).toBe(false);
  });

  test("--adopt is clean when upstream added the same bytes the overlay did", async () => {
    const fx = await mkFixture("sync-collide-adopt-same", { "B.txt": "b\n" });
    await add(fx, { "A.txt": "identical content\n" });
    await fx.upstream.addFile("A.txt", "identical content\n");
    await fx.base.git("pull", "--no-rebase", "origin", "main");
    await runSync(fx.ctx);

    const report = await decide(fx.ctx, "A.txt", "adopt");
    expect(report.conflicted).toEqual([]);
    expect(report.merged).toEqual(["A.txt"]);
    expect(report.syncInProgress).toBe(false);
    expect(await fx.base.read("A.txt")).toBe("identical content\n");
    await assertBaseClean(fx.base.dir, { label: "clean adoption" });
  });

  test("--adopt that conflicts still hides the path from the base", async () => {
    const fx = await mkFixture("sync-collide-adopt-conflict", { "B.txt": "b\n" });
    await add(fx, { "A.txt": "overlay line\n" });
    await fx.upstream.addFile("A.txt", "upstream line\n");
    await fx.base.git("pull", "--no-rebase", "origin", "main");
    await runSync(fx.ctx);

    const report = await decide(fx.ctx, "A.txt", "adopt");
    expect(report.conflicted).toEqual(["A.txt"]);
    expect(report.syncInProgress).toBe(true);

    expect(await fx.base.read("A.txt")).toContain("<<<<<<<");
    expect(await fx.base.skipWorktreePaths()).toContain("A.txt");
    // The whole point: a conflicted adoption must not leak into the base.
    await assertBaseClean(fx.base.dir, { label: "conflicted adoption" });

    await fx.base.write("A.txt", "both lines, merged by hand\n");
    const done = await continueSync(fx.ctx);
    expect(done.merged).toEqual(["A.txt"]);
    expect(await readSyncState(fx.ctx)).toBeNull();
    await assertBaseClean(fx.base.dir, { label: "resolved adoption" });
  });

  test("--drop hands the path to the base", async () => {
    const fx = await collisionFixture("sync-collide-drop");
    await runSync(fx.ctx);
    const report = await decide(fx.ctx, "A.txt", "drop");

    expect((await readManifest(fx.ctx)).entries["A.txt"]).toBeUndefined();
    expect(await fx.base.read("A.txt")).toContain("line 8 — upstream");
    expect(await fx.base.read("A.txt")).not.toContain("line 2 — overlay");
    expect(await fx.base.skipWorktreePaths()).not.toContain("A.txt");
    expect(await fx.ctx.overlay.indexBlobOid("A.txt")).toBeNull();

    // The overlay's bytes must survive being given up. This is the subtle one: the
    // work-tree held *upstream's* copy at decision time, so a naive work-tree rescue would
    // have saved the wrong file.
    const rescued = await Promise.all(
      report.backups.map((b) => readFile(join(fx.base.dir, b), "utf8")),
    );
    expect(rescued.some((t) => t.includes("line 2 — overlay"))).toBe(true);
    await assertBaseClean(fx.base.dir, { label: "after collision --drop" });
  });
});

describe("upstream changed a whited-out file", () => {
  test("the resurrection is repaired, baseBlob advances, and sync says what it did", async () => {
    const fx = await mkFixture("sync-whiteout", { "D.txt": "base d\n", "B.txt": "b\n" });
    await whiteout(fx.ctx, ["D.txt"], { repoRelative: true });
    expect(await fx.base.exists("D.txt")).toBe(false);

    await fx.upstream.changeFile("D.txt", "base d v2\n");
    // §6.5: a plain pull *succeeds* here and puts the file back in the work-tree.
    await fx.base.git("pull", "--no-rebase", "origin", "main");
    expect(await fx.base.exists("D.txt")).toBe(true);
    expect(await fx.base.skipWorktreePaths()).toContain("D.txt");

    const plan = await planSync(fx.ctx);
    expect(plan.items[0]!.situation).toBe("whiteout-upstream-changed");
    expect(plan.items[0]!.detail).toContain("the whiteout still hides it");

    const report = await runSync(fx.ctx);
    expect(report.whiteoutsRepaired).toEqual(["D.txt"]);
    expect(report.pendingDecision).toEqual([]);
    expect(report.syncInProgress).toBe(false);

    expect(await fx.base.exists("D.txt")).toBe(false);
    expect((await readManifest(fx.ctx)).entries["D.txt"]).toEqual({
      kind: "delete",
      baseBlob: (await fx.base.blobOid("D.txt"))!,
    });
    await assertBaseClean(fx.base.dir, { label: "after whiteout repair" });

    const again = await runSync(fx.ctx);
    expect(again.unchanged).toEqual(["D.txt"]);
    expect(again.whiteoutsRepaired).toEqual([]);
  });
});

/* ------------------------------------------------------------------ refusals */

describe("refusals and filters", () => {
  test("an override missing from the work-tree is skipped, not guessed at", async () => {
    const fx = await mkFixture("sync-local-missing", { "C.txt": ORIGINAL, "E.txt": ORIGINAL });
    await override(fx, { "C.txt": OURS, "E.txt": OURS });
    await fx.upstream.push("upstream moves both", { "C.txt": THEIRS, "E.txt": THEIRS });
    await detachedPull(fx);
    await fx.base.rm("C.txt");

    const plan = await planSync(fx.ctx);
    expect(plan.blocked.map((i) => i.path)).toEqual(["C.txt"]);

    const report = await runSync(fx.ctx);
    expect(report.skipped.map((s) => s.path)).toEqual(["C.txt"]);
    expect(report.skipped[0]!.reason).toContain("missing from the work-tree");
    expect(report.merged).toEqual(["E.txt"]);

    // The fork point of the missing path did not move.
    const m = await readManifest(fx.ctx);
    const e = m.entries["C.txt"]!;
    expect("baseBlob" in e ? e.baseBlob : null).toBe(
      (await fx.upstream.blobOid("C.txt", "HEAD~1"))!,
    );
  });

  test("--only restricts the run and reports what it left alone", async () => {
    const fx = await mkFixture("sync-only", { "C.txt": ORIGINAL, "E.txt": ORIGINAL });
    await override(fx, { "C.txt": OURS, "E.txt": OURS });
    await fx.upstream.push("upstream moves both", { "C.txt": THEIRS, "E.txt": THEIRS });
    await detachedPull(fx);

    const report = await runSync(fx.ctx, { only: ["C.txt"] });
    expect(report.merged).toEqual(["C.txt"]);
    expect(report.skipped).toEqual([{ path: "E.txt", reason: "not selected by --only" }]);
    expect(await fx.base.read("E.txt")).toBe(OURS);

    await expectThrows(() => runSync(fx.ctx, { only: ["nope.txt"] }), "NOT_OWNED");
  });

  test("a base with no commits never looks like an upstream deletion", async () => {
    const sb = await makeSandbox("sync-unborn");
    const restore = applyEnv(sb.env);
    const base = await sb.mkBaseRepo("base", { "C.txt": ORIGINAL });
    const { ctx } = await initOverlay(base.dir);
    const fx: Fx = {
      sb,
      base,
      ctx,
      upstream: undefined as unknown as Upstream,
      async close() {
        restore();
        await sb.cleanup();
      },
    };
    open.push(fx);

    await override(fx, { "C.txt": OURS });
    // Rewind the base to an unborn HEAD while the manifest still claims an override.
    await base.git("update-ref", "-d", "HEAD");

    const plan = await planSync(ctx);
    expect(plan.items[0]!.situation).toBe("up-to-date");
    expect(plan.items[0]!.detail).toContain("no commits");
    expect(plan.needsDecision).toEqual([]);
  });
});

/* ------------------------------------------------------------------ interruption */

describe("interrupted sync", () => {
  test("a sync killed mid-run is fully recovered by --abort", async () => {
    const fx = await mkFixture("sync-kill", {});

    // Enough paths that the run is comfortably longer than the time it takes to notice
    // progress, so the kill lands in the middle rather than before or after.
    const count = 120;
    const baseFiles: Record<string, string> = {};
    for (let i = 0; i < count; i++) baseFiles[`f${String(i).padStart(3, "0")}.txt`] = ORIGINAL;
    await fx.upstream.push("seed", baseFiles);
    await fx.base.git("pull", "--no-rebase", "origin", "main");

    const overlayFiles: Record<string, string> = {};
    for (const p of Object.keys(baseFiles)) overlayFiles[p] = OURS;
    await override(fx, overlayFiles);

    const upstreamFiles: Record<string, string> = {};
    for (const p of Object.keys(baseFiles)) upstreamFiles[p] = THEIRS;
    await fx.upstream.push("upstream moves everything", upstreamFiles);
    await detachedPull(fx);

    const treeBefore = await snapshotTree(fx.base.dir);
    const manifestBefore = await readManifest(fx.ctx);

    // A real, separate process — the only honest way to be killed mid-run.
    const driver = join(fx.sb.dir, "driver.ts");
    await writeFile(
      driver,
      [
        `import { discover } from ${JSON.stringify(join(PROJECT_ROOT, "src", "context.ts"))};`,
        `import { runSync } from ${JSON.stringify(join(PROJECT_ROOT, "src", "sync.ts"))};`,
        `const ctx = await discover(${JSON.stringify(fx.base.dir)}, { requireOverlay: true });`,
        `await runSync(ctx);`,
        "",
      ].join("\n"),
    );

    const proc = Bun.spawn({
      cmd: [process.execPath, "--env-file=/dev/null", driver],
      cwd: fx.base.dir,
      env: fx.sb.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const statePath = join(fx.base.dir, ".overgit", "local", "sync-state.json");
    const deadline = Date.now() + 25_000;
    let mergedWhenKilled = 0;
    for (;;) {
      if (Date.now() > deadline) {
        proc.kill(9);
        throw new Error("the sync never reported progress; nothing to interrupt");
      }
      try {
        const s = JSON.parse(await readFile(statePath, "utf8")) as { merged: string[] };
        if (s.merged.length >= 3) {
          mergedWhenKilled = s.merged.length;
          break;
        }
      } catch {
        /* not written yet, or caught mid-rename */
      }
      await Bun.sleep(5);
    }
    proc.kill(9);
    await proc.exited;

    // Genuinely half-done.
    expect(mergedWhenKilled).toBeGreaterThanOrEqual(3);
    expect(mergedWhenKilled).toBeLessThan(count);
    expect(await exists(statePath)).toBe(true);
    const stranded = await readSyncState(fx.ctx);
    expect(stranded!.merged.length).toBeGreaterThanOrEqual(3);

    // The killed process left its lock behind; abort must break the stale lock and finish.
    await abortSync(fx.ctx);

    assertTreesEqual(
      await snapshotTree(fx.base.dir),
      treeBefore,
      "abort after a kill -9 did not restore the work-tree",
    );
    expect(await readManifest(fx.ctx)).toEqual(manifestBefore);
    expect(await readSyncState(fx.ctx)).toBeNull();
    await assertBaseClean(fx.base.dir, { label: "after kill + abort" });

    // ...and the whole sync can be redone from scratch.
    const report = await runSync(fx.ctx);
    expect(report.merged).toHaveLength(count);
    expect(report.conflicted).toEqual([]);
  }, 90_000);

  test("a corrupt sync-state file refuses to be ignored", async () => {
    const fx = await mkFixture("sync-corrupt-state", { "C.txt": ORIGINAL });
    await override(fx, { "C.txt": OURS });
    await mkdir(join(fx.base.dir, ".overgit", "local"), { recursive: true });
    await writeFile(join(fx.base.dir, ".overgit", "local", "sync-state.json"), "{ not json");

    const err = await expectThrows(() => runSync(fx.ctx), "IO_FAILED");
    expect(err.message).toContain("not valid JSON");
    expect((err as unknown as { hint?: string }).hint).toContain("sync-state.json");

    await rm(join(fx.base.dir, ".overgit", "local", "sync-state.json"), { force: true });
    const report = await runSync(fx.ctx);
    expect(report.unchanged).toEqual(["C.txt"]);
  });
});

/* ------------------------------------------------------------------ the real CLI */

/**
 * End-to-end through `bin/overgit`, the way every other suite runs. These do not re-prove the
 * merge semantics above; they pin the wiring and the **frozen exit codes**: `0` done,
 * `3` conflicts or decisions pending, `4` a `--dry-run` that found work.
 */
describe("through the real CLI", () => {
  interface CliFx {
    sb: Sandbox;
    upstream: Upstream;
    base: Repo;
  }

  async function mkCli(label: string, baseFiles: Record<string, string>): Promise<CliFx> {
    const sb = await makeSandbox(label);
    const upstream = await sb.mkUpstream("upstream", baseFiles);
    const base = await upstream.clone("base");
    expectOk(await overgit(base.dir, "init"));
    return { sb, upstream, base };
  }

  /** `overgit detach` → `git pull` → `overgit attach`, all through the CLI. */
  async function cliDetachedPull(fx: CliFx): Promise<void> {
    expectOk(await overgit(fx.base.dir, "detach"));
    await fx.base.git("pull", "--no-rebase", "origin", "main");
    expectOk(await overgit(fx.base.dir, "attach"));
  }

  test("dry-run exits 4 when there is work, 0 when there is not", async () => {
    const fx = await mkCli("cli-dry", { "C.txt": ORIGINAL });
    expectOk(await overgit(fx.base.dir, "add", "C.txt"));
    await fx.base.write("C.txt", OURS);
    expectOk(await overgit(fx.base.dir, "commit", "-m", "overlay: own C.txt"));

    expectExit(await overgit(fx.base.dir, "sync", "--dry-run"), 0);

    await fx.upstream.changeFile("C.txt", THEIRS);
    await cliDetachedPull(fx);

    const dry = expectExit(await overgit(fx.base.dir, "sync", "--dry-run"), 4);
    expect(dry.stdout + dry.stderr).toContain("C.txt");
    // A dry run really is dry.
    expect(await fx.base.read("C.txt")).toBe(OURS);

    expectExit(await overgit(fx.base.dir, "sync"), 0);
    expect(await fx.base.read("C.txt")).toContain("line 17 — upstream");
    expectExit(await overgit(fx.base.dir, "sync", "--dry-run"), 0);
    await assertBaseClean(fx.base.dir, { label: "cli clean sync" });
  });

  test("a conflict exits 3, survives `status`/`doctor`, and finishes with --continue", async () => {
    const fx = await mkCli("cli-conflict", { "C.txt": ORIGINAL });
    expectOk(await overgit(fx.base.dir, "add", "C.txt"));
    await fx.base.write("C.txt", OURS);
    expectOk(await overgit(fx.base.dir, "commit", "-m", "own C.txt"));

    await fx.upstream.changeFile("C.txt", THEIRS_CLASH);
    await cliDetachedPull(fx);

    const sync = expectExit(await overgit(fx.base.dir, "sync"), 3);
    expect(sync.stdout + sync.stderr).toContain("C.txt");
    expect(await fx.base.read("C.txt")).toContain("<<<<<<<");

    // Conflict markers in a tracked file, and the base still cannot see anything.
    await assertBaseClean(fx.base.dir, { label: "cli conflicted override" });

    // Nothing else is blocked.
    expectOk(await overgit(fx.base.dir, "status"));
    const doctor = await overgit(fx.base.dir, "doctor");
    expect([0, 4]).toContain(doctor.code);

    // Starting another sync refuses and points at the way out.
    const again = expectExit(await overgit(fx.base.dir, "sync"), 3);
    expect(again.stderr).toContain("--continue");
    expect(again.stderr).toContain("--abort");

    // Markers still there → --continue refuses.
    expectExit(await overgit(fx.base.dir, "sync", "--continue"), 3);

    await fx.base.write("C.txt", lines(20, { 3: "line 3 — resolved" }));
    expectOk(await overgit(fx.base.dir, "sync", "--continue"));
    expectExit(await overgit(fx.base.dir, "sync", "--dry-run"), 0);
    await assertBaseClean(fx.base.dir, { label: "cli after --continue" });
  });

  test("--abort puts the work-tree back exactly", async () => {
    const fx = await mkCli("cli-abort", { "C.txt": ORIGINAL, "E.txt": ORIGINAL });
    expectOk(await overgit(fx.base.dir, "add", "C.txt", "E.txt"));
    await fx.base.write("C.txt", OURS);
    await fx.base.write("E.txt", OURS);
    expectOk(await overgit(fx.base.dir, "commit", "-m", "own both"));

    await fx.upstream.push("upstream moves both", { "C.txt": THEIRS_CLASH, "E.txt": THEIRS });
    await cliDetachedPull(fx);

    const before = await snapshotTree(fx.base.dir);
    expectExit(await overgit(fx.base.dir, "sync"), 3);
    expect(await snapshotTree(fx.base.dir)).not.toEqual(before);

    expectOk(await overgit(fx.base.dir, "sync", "--abort"));
    assertTreesEqual(await snapshotTree(fx.base.dir), before, "cli --abort did not restore");
    await assertBaseClean(fx.base.dir, { label: "cli after --abort" });
  });

  test("an upstream deletion exits 3 and is answered by `overgit resolve --keep`", async () => {
    const fx = await mkCli("cli-deleted", { "C.txt": ORIGINAL, "B.txt": "b\n" });
    expectOk(await overgit(fx.base.dir, "add", "C.txt"));
    await fx.base.write("C.txt", OURS);
    expectOk(await overgit(fx.base.dir, "commit", "-m", "own C.txt"));

    await fx.upstream.deleteFile("C.txt");
    await cliDetachedPull(fx);

    const sync = expectExit(await overgit(fx.base.dir, "sync"), 3);
    expect(sync.stdout + sync.stderr).toContain("C.txt");
    expect(await fx.base.read("C.txt")).toBe(OURS);

    expectOk(await overgit(fx.base.dir, "resolve", "--keep", "C.txt"));
    expect(await fx.base.read("C.txt")).toBe(OURS);
    expectExit(await overgit(fx.base.dir, "sync", "--dry-run"), 0);
    await assertBaseClean(fx.base.dir, { label: "cli after --keep" });
  });
});
