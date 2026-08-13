/**
 * The three-way merge engine, checked against git itself.
 *
 * The central claim of `overgit sync` is that an overridden file is reconciled with a
 * *real* three-way merge whose base is the recorded fork-point blob. "Real" is not a
 * feeling: every merge in this file is compared byte-for-byte against a hand-run
 * `git merge-file -p`, executed here in the test with the same three blobs. If overgit
 * ever grows its own diff algorithm, these tests go red.
 *
 * Everything runs against throwaway repos in temp dirs with a hermetic git config and no
 * network. `src/sync.ts` is driven in-process, as in `test/sync.test.ts`, but nothing is
 * mocked: real git, real objects, real work-tree.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertBaseClean,
  cleanupAllSandboxes,
  makeSandbox,
  type Repo,
  type Sandbox,
  type Upstream,
} from "./helpers/harness.ts";

import type { Context } from "../src/context.ts";
import { attach, detach, initOverlay } from "../src/bootstrap.ts";
import { takeOwnership } from "../src/ownership.ts";
import { readManifest } from "../src/manifest.ts";
import {
  continueSync,
  decide,
  planSync,
  readSyncState,
  runSync,
  upstreamCopyPath,
} from "../src/sync.ts";

/* ------------------------------------------------------------------ fixture */

/**
 * In-process `src/*` calls read `process.env`, so the sandbox's hermetic environment is
 * installed for the duration of a test. `test/helpers/env.ts` explicitly supports this.
 */
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

/** Put overlay bytes in the work-tree, take ownership, and commit them in the overlay. */
async function override(fx: Fx, files: Record<string, string>): Promise<void> {
  for (const [p, c] of Object.entries(files)) await fx.base.write(p, c);
  await takeOwnership(fx.ctx, Object.keys(files), { repoRelative: true });
  await fx.ctx.overlay.commit(`overlay: own ${Object.keys(files).join(", ")}`);
}

/**
 * The `overgit detach` → `git pull` → `overgit attach` dance.
 *
 * A plain `git pull` **aborts** when upstream touched an overridden file,
 * so this is the only way a base can actually move past an override.
 */
async function detachedPull(fx: Fx): Promise<void> {
  await detach(fx.ctx);
  await fx.base.git("pull", "--no-rebase", "origin", "main");
  await attach(fx.ctx);
}

/** Run `git merge-file -p` by hand, capturing exact bytes. This is the oracle. */
async function handMerge(
  fx: Fx,
  blobs: { ours: Uint8Array; base: Uint8Array; theirs: Uint8Array },
  args: string[] = [],
): Promise<{ bytes: Uint8Array; code: number }> {
  const dir = join(fx.sb.dir, `handmerge-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "ours"), blobs.ours);
  await writeFile(join(dir, "base"), blobs.base);
  await writeFile(join(dir, "theirs"), blobs.theirs);
  const proc = Bun.spawn({
    cmd: ["git", "merge-file", "-p", ...args, "--", "ours", "base", "theirs"],
    cwd: dir,
    env: fx.sb.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [buf, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    proc.exited,
  ]);
  return { bytes: new Uint8Array(buf), code };
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function readWt(fx: Fx, p: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(fx.base.dir, p)));
}

function expectSameBytes(actual: Uint8Array, want: Uint8Array, what: string): void {
  const a = Buffer.from(actual);
  const b = Buffer.from(want);
  if (a.equals(b)) return;
  throw new Error(
    `${what}: bytes differ\n--- overgit (${a.length}B) ---\n${a.toString("utf8")}\n--- git merge-file (${b.length}B) ---\n${b.toString("utf8")}\n--- end ---`,
  );
}

/** 20 numbered lines — enough separation for non-overlapping edits to merge cleanly. */
function numbered(n: number, mark: Record<number, string> = {}): string {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) out.push(mark[i] ?? `line ${i}`);
  return out.join("\n") + "\n";
}

const ORIGINAL = numbered(20);
const OURS = numbered(20, { 3: "line 3 — changed by the overlay" });
const THEIRS = numbered(20, { 17: "line 17 — changed upstream" });
/** Same line as `OURS`, so a three-way merge must conflict. */
const THEIRS_SAME_LINE = numbered(20, { 3: "line 3 — changed upstream" });

/* ------------------------------------------------------------------ tests */

describe("three-way merge fidelity", () => {
  test("a clean merge is byte-identical to `git merge-file -p ours base theirs`", async () => {
    const fx = await mkFixture("merge-clean", { "C.txt": ORIGINAL, "keep.txt": "x\n" });
    await override(fx, { "C.txt": OURS });

    await fx.upstream.changeFile("C.txt", THEIRS);
    await detachedPull(fx);

    const plan = await planSync(fx.ctx);
    expect(plan.items.map((i) => `${i.path}:${i.situation}`)).toEqual(["C.txt:clean-merge"]);

    const report = await runSync(fx.ctx);
    expect(report.merged).toEqual(["C.txt"]);
    expect(report.conflicted).toEqual([]);
    expect(report.syncInProgress).toBe(false);

    const oracle = await handMerge(fx, {
      ours: bytes(OURS),
      base: bytes(ORIGINAL),
      theirs: bytes(THEIRS),
    });
    expect(oracle.code).toBe(0);
    expectSameBytes(await readWt(fx, "C.txt"), oracle.bytes, "merged C.txt");

    // Both edits are actually present — a merge that silently took one side would still
    // be "byte-identical" to nothing.
    const merged = new TextDecoder().decode(await readWt(fx, "C.txt"));
    expect(merged).toContain("line 3 — changed by the overlay");
    expect(merged).toContain("line 17 — changed upstream");

    // The overlay index now holds the merged bytes, so the content is never work-tree-only.
    const staged = await fx.ctx.overlay.indexBlobOid("C.txt");
    expect(staged).not.toBeNull();
    expectSameBytes(await fx.ctx.overlay.catFileBlob(staged!), oracle.bytes, "overlay index blob");

    // baseBlob advanced to the blob we merged against.
    const m = await readManifest(fx.ctx);
    expect(m.entries["C.txt"]).toEqual({
      kind: "override",
      baseBlob: (await fx.base.blobOid("C.txt"))!,
    });

    await assertBaseClean(fx.base.dir, { label: "after clean merge" });
  });

  test("a conflict is byte-identical to `git merge-file -p` with the same labels", async () => {
    const fx = await mkFixture("merge-conflict", { "C.txt": ORIGINAL });
    await override(fx, { "C.txt": OURS });
    const forkBlob = (await readManifest(fx.ctx)).entries["C.txt"]!;

    await fx.upstream.changeFile("C.txt", THEIRS_SAME_LINE);
    await detachedPull(fx);
    const upstreamBlob = (await fx.base.blobOid("C.txt"))!;

    const report = await runSync(fx.ctx);
    expect(report.conflicted).toEqual(["C.txt"]);
    expect(report.merged).toEqual([]);
    expect(report.syncInProgress).toBe(true);

    const from = "baseBlob" in forkBlob ? forkBlob.baseBlob : "";
    const oracle = await handMerge(
      fx,
      { ours: bytes(OURS), base: bytes(ORIGINAL), theirs: bytes(THEIRS_SAME_LINE) },
      [
        "-L",
        "C.txt (overlay)",
        "-L",
        `C.txt (base ${from.slice(0, 8)})`,
        "-L",
        `C.txt (upstream ${upstreamBlob.slice(0, 8)})`,
      ],
    );
    expect(oracle.code).toBeGreaterThan(0);
    expectSameBytes(await readWt(fx, "C.txt"), oracle.bytes, "conflicted C.txt");

    const text = new TextDecoder().decode(await readWt(fx, "C.txt"));
    expect(text).toContain("<<<<<<< C.txt (overlay)");
    expect(text).toContain(">>>>>>> C.txt (upstream");
  });

  test("--style diff3 is passed straight through to git", async () => {
    const fx = await mkFixture("merge-diff3", { "C.txt": ORIGINAL });
    await override(fx, { "C.txt": OURS });
    const entry = (await readManifest(fx.ctx)).entries["C.txt"]!;
    const from = "baseBlob" in entry ? entry.baseBlob : "";

    await fx.upstream.changeFile("C.txt", THEIRS_SAME_LINE);
    await detachedPull(fx);
    const upstreamBlob = (await fx.base.blobOid("C.txt"))!;

    await runSync(fx.ctx, { style: "diff3" });

    const oracle = await handMerge(
      fx,
      { ours: bytes(OURS), base: bytes(ORIGINAL), theirs: bytes(THEIRS_SAME_LINE) },
      [
        "--diff3",
        "-L",
        "C.txt (overlay)",
        "-L",
        `C.txt (base ${from.slice(0, 8)})`,
        "-L",
        `C.txt (upstream ${upstreamBlob.slice(0, 8)})`,
      ],
    );
    expectSameBytes(await readWt(fx, "C.txt"), oracle.bytes, "diff3 conflict");
    expect(new TextDecoder().decode(await readWt(fx, "C.txt"))).toContain("||||||| C.txt (base");
  });

  test("uncommitted overlay edits are the `ours` side of the merge", async () => {
    const fx = await mkFixture("merge-ours-worktree", { "C.txt": ORIGINAL });
    await override(fx, { "C.txt": OURS });

    await fx.upstream.changeFile("C.txt", THEIRS);
    await detachedPull(fx);

    // The user keeps working after the pull; sync must not throw this away.
    const dirty = numbered(20, {
      3: "line 3 — changed by the overlay",
      8: "line 8 — uncommitted overlay edit",
    });
    await fx.base.write("C.txt", dirty);

    await runSync(fx.ctx);

    const oracle = await handMerge(fx, {
      ours: bytes(dirty),
      base: bytes(ORIGINAL),
      theirs: bytes(THEIRS),
    });
    expect(oracle.code).toBe(0);
    expectSameBytes(await readWt(fx, "C.txt"), oracle.bytes, "merged with dirty ours");
    expect(new TextDecoder().decode(await readWt(fx, "C.txt"))).toContain("uncommitted overlay edit");
  });
});

describe("merge honesty in awkward shapes", () => {
  test("a conflict on one path does not stop the others in the same run", async () => {
    const fx = await mkFixture("merge-partial", {
      "clean.txt": ORIGINAL,
      "boom.txt": ORIGINAL,
      "still.txt": ORIGINAL,
    });
    await override(fx, {
      "clean.txt": OURS,
      "boom.txt": OURS,
      "still.txt": "overlay only\n",
    });
    const before = await readManifest(fx.ctx);

    await fx.upstream.push("upstream moves two files", {
      "clean.txt": THEIRS,
      "boom.txt": THEIRS_SAME_LINE,
    });
    await detachedPull(fx);

    const report = await runSync(fx.ctx);
    expect(report.merged).toEqual(["clean.txt"]);
    expect(report.conflicted).toEqual(["boom.txt"]);
    expect(report.unchanged).toEqual(["still.txt"]);

    // The clean path really merged...
    const oracle = await handMerge(fx, {
      ours: bytes(OURS),
      base: bytes(ORIGINAL),
      theirs: bytes(THEIRS),
    });
    expectSameBytes(await readWt(fx, "clean.txt"), oracle.bytes, "clean.txt");

    // ...and the conflicted one kept its old fork point while the merged one advanced.
    const after = await readManifest(fx.ctx);
    expect(after.entries["boom.txt"]).toEqual(before.entries["boom.txt"]!);
    expect(after.entries["clean.txt"]).not.toEqual(before.entries["clean.txt"]!);

    // The subtle one: conflict markers are sitting in the work-tree and the base still
    // cannot see anything.
    expect(new TextDecoder().decode(await readWt(fx, "boom.txt"))).toContain("<<<<<<<");
    await assertBaseClean(fx.base.dir, { label: "conflict markers in work-tree" });
    expect(await fx.base.skipWorktreePaths()).toContain("boom.txt");
  });

  test("binary divergence is refused honestly and never corrupts the file", async () => {
    // A NUL in the first 8000 bytes is git's own binary heuristic.
    const original = " BIN original payload\n";
    const ours = " BIN overlay payload\n";
    const theirs = " BIN upstream payload\n";

    const fx = await mkFixture("merge-binary", { "logo.bin": original });
    await override(fx, { "logo.bin": ours });

    await fx.upstream.changeFile("logo.bin", theirs);
    await detachedPull(fx);

    // A DECISION, not a conflict. There are no markers to write into a binary file, so a
    // marker-based resolution flow has no trustworthy "I resolved it" signal — and
    // `sync --continue` would stage the untouched overlay bytes and advance the fork point,
    // silently discarding upstream's revision while recording it as merged.
    const plan = await planSync(fx.ctx);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.needsDecision).toHaveLength(1);
    expect(plan.needsDecision[0]!.situation).toBe("binary-conflict");
    expect(plan.needsDecision[0]!.binary).toBe(true);
    expect(plan.needsDecision[0]!.detail).toContain("binary");

    const report = await runSync(fx.ctx);
    expect(report.conflicted).toEqual([]);
    expect(report.pendingDecision.map((i) => i.path)).toEqual(["logo.bin"]);

    // The work-tree file is untouched — no markers, no truncation, still exactly ours.
    expectSameBytes(await readWt(fx, "logo.bin"), bytes(ours), "binary work-tree file");

    // The upstream version is put beside it so the user can actually resolve.
    const copy = join(fx.base.dir, upstreamCopyPath("logo.bin"));
    expectSameBytes(new Uint8Array(await readFile(copy)), bytes(theirs), "upstream copy");

    // And the fork point did not move.
    const m = await readManifest(fx.ctx);
    const e = m.entries["logo.bin"]!;
    const forkPoint = (await fx.upstream.blobOid("logo.bin", "HEAD~1"))!;
    expect("baseBlob" in e ? e.baseBlob : null).toBe(forkPoint);

    // The step the original test stopped one command short of, and the whole bug: running
    // what the tool tells you to run must NOT accept the unmerged bytes as a resolution.
    // It now refuses outright while the decision is pending.
    let refused: unknown = null;
    try {
      await continueSync(fx.ctx);
    } catch (e) {
      refused = e;
    }
    expect((refused as { code?: string } | null)?.code).toBe("DECISION_REQUIRED");
    const after = await readManifest(fx.ctx);
    const e2 = after.entries["logo.bin"]!;
    expect("baseBlob" in e2 ? e2.baseBlob : null).toBe(forkPoint);
    expectSameBytes(await readWt(fx, "logo.bin"), bytes(ours), "binary file after --continue");

    // Answering the decision explicitly is the only way through, and it works.
    await decide(fx.ctx, "logo.bin", "take-upstream");
    expectSameBytes(await readWt(fx, "logo.bin"), bytes(theirs), "after --take-upstream");
    const done = await readManifest(fx.ctx);
    const e3 = done.entries["logo.bin"]!;
    expect("baseBlob" in e3 ? e3.baseBlob : null).toBe(
      (await fx.upstream.blobOid("logo.bin", "HEAD"))!,
    );
    await assertBaseClean(fx.base.dir, { label: "after binary take-upstream" });
  });

  test("identical binary changes on both sides resolve cleanly", async () => {
    const original = " BIN v1\n";
    const same = " BIN v2\n";

    const fx = await mkFixture("merge-binary-same", { "logo.bin": original });
    await override(fx, { "logo.bin": same });

    await fx.upstream.changeFile("logo.bin", same);
    await detachedPull(fx);

    const report = await runSync(fx.ctx);
    expect(report.conflicted).toEqual([]);
    expect(report.merged).toEqual(["logo.bin"]);
    expectSameBytes(await readWt(fx, "logo.bin"), bytes(same), "converged binary");
    expect(await readSyncState(fx.ctx)).toBeNull();
  });

  test("a symlink override is never line-merged", async () => {
    const fx = await mkFixture("merge-symlink", { "link": "target-a\n", "target-a": "A\n", "target-b": "B\n" });
    // Replace the plain file with a real symlink upstream so both sides are 120000.
    await fx.upstream.work.rm("link");
    await fx.upstream.work.symlink("target-a", "link");
    await fx.upstream.push("link becomes a symlink", {});
    await fx.base.git("pull", "--no-rebase", "origin", "main");

    await fx.base.rm("link");
    await fx.base.symlink("target-b", "link");
    await takeOwnership(fx.ctx, ["link"], { repoRelative: true });
    await fx.ctx.overlay.commit("overlay: own link");

    await fx.upstream.work.rm("link");
    await fx.upstream.work.symlink("target-c", "link");
    await fx.upstream.push("upstream repoints link", { "target-c": "C\n" });
    await detachedPull(fx);

    const plan = await planSync(fx.ctx);
    const item = plan.items.find((i) => i.path === "link")!;
    // Same reasoning as binary: a symlink target has nowhere to put conflict markers.
    expect(item.situation).toBe("binary-conflict");
    expect(item.binary).toBe(true);
    expect(item.detail).toContain("symlink");

    await runSync(fx.ctx);
    // Still a symlink, still pointing where the overlay put it.
    expect(await fx.base.readlink("link")).toBe("target-b");
  });

  test("the overlay's file mode survives an upstream chmod, and sync says so", async () => {
    // A blob carries no mode and the manifest records only a blob, so there is no fork
    // mode to compare against. Rather than guess, sync keeps the overlay's mode and
    // reports upstream's — the one behaviour that never silently flips an exec bit.
    const fx = await mkFixture("merge-mode", { "run.sh": ORIGINAL });
    await override(fx, { "run.sh": OURS });
    expect(await fx.base.isExec("run.sh")).toBe(false);

    await fx.upstream.work.write("run.sh", THEIRS);
    await fx.upstream.work.setExec("run.sh", true);
    await fx.upstream.push("upstream makes run.sh executable", {});
    await detachedPull(fx);

    const plan = await planSync(fx.ctx);
    expect(plan.clean[0]!.detail).toContain("upstream has mode 100755");
    expect(plan.clean[0]!.detail).toContain("the overlay keeps 100644");

    const report = await runSync(fx.ctx);
    expect(report.merged).toEqual(["run.sh"]);
    expect(await fx.base.isExec("run.sh")).toBe(false);
    expect(await fx.ctx.overlay.fileMode("run.sh")).toBe("100644");

    // The *content* still merged properly.
    const oracle = await handMerge(fx, {
      ours: bytes(OURS),
      base: bytes(ORIGINAL),
      theirs: bytes(THEIRS),
    });
    expectSameBytes(await readWt(fx, "run.sh"), oracle.bytes, "content alongside mode change");
    await assertBaseClean(fx.base.dir, { label: "after upstream chmod" });
  });

  test("an executable overlay override keeps its exec bit through a merge", async () => {
    const fx = await mkFixture("merge-mode-ours", { "run.sh": ORIGINAL });
    await fx.base.write("run.sh", OURS);
    await fx.base.setExec("run.sh", true);
    await takeOwnership(fx.ctx, ["run.sh"], { repoRelative: true });
    await fx.ctx.overlay.commit("overlay: own run.sh");
    expect(await fx.ctx.overlay.fileMode("run.sh")).toBe("100755");

    await fx.upstream.changeFile("run.sh", THEIRS);
    await detachedPull(fx);

    await runSync(fx.ctx);
    expect(await fx.base.isExec("run.sh")).toBe(true);
    expect(await fx.ctx.overlay.fileMode("run.sh")).toBe("100755");
  });

  test("a missing fork-point blob is a conflict, not a silent take-upstream", async () => {
    const fx = await mkFixture("merge-lost-base", { "C.txt": ORIGINAL });
    await override(fx, { "C.txt": OURS });

    await fx.upstream.changeFile("C.txt", THEIRS);
    await detachedPull(fx);

    // Rewrite the manifest's fork point to a blob that exists nowhere.
    const manifestPath = fx.ctx.manifestPath;
    const text = await readFile(manifestPath, "utf8");
    await writeFile(
      manifestPath,
      text.replace(/"baseBlob": "[0-9a-f]+"/, `"baseBlob": "${"0".repeat(40)}"`),
    );

    const plan = await planSync(fx.ctx);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.detail).toContain("missing from the base object store");

    const report = await runSync(fx.ctx);
    expect(report.conflicted).toEqual(["C.txt"]);
    // Nothing was overwritten with upstream's guess.
    expectSameBytes(await readWt(fx, "C.txt"), bytes(OURS), "untouched on missing base blob");
  });

  test("`--dry-run` classifies without writing a byte", async () => {
    const fx = await mkFixture("merge-dry", { "clean.txt": ORIGINAL, "boom.txt": ORIGINAL });
    await override(fx, { "clean.txt": OURS, "boom.txt": OURS });
    await fx.upstream.push("upstream moves both", {
      "clean.txt": THEIRS,
      "boom.txt": THEIRS_SAME_LINE,
    });
    await detachedPull(fx);

    const before = await fx.base.snapshot();
    const report = await runSync(fx.ctx, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.merged).toEqual(["clean.txt"]);
    expect(report.conflicted).toEqual(["boom.txt"]);
    expect(report.syncInProgress).toBe(false);

    const after = await fx.base.snapshot();
    expect([...after.entries()]).toEqual([...before.entries()]);
    expect(await readSyncState(fx.ctx)).toBeNull();
    await rm(join(fx.base.dir, ".overgit", "local", "sync-state.json"), { force: true });
  });
});
