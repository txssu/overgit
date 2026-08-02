/**
 * The flagship: **clone both repos onto a new machine, bootstrap with one command, get a
 * byte-identical merged tree — and running that command again changes nothing.**
 *
 * Everything else overgit does is in service of this. So the fixture is deliberately nasty:
 *
 *   * an **executable** file (the exec bit must survive the overlay's object store),
 *   * a **symlink** (mode 120000; the target is content, never followed),
 *   * a **binary** file with NUL bytes (no UTF-8 round trip anywhere),
 *   * a filename with a **space** and a **`#`** (gitignore-escaping, and pathspec globbing),
 *   * a file inside a **directory that only the overlay creates**,
 *   * an **override** of a base file, a **whiteout** of a base file, and plain **adds**.
 *
 * The "new machine" is a second sandbox: its own `HOME`, its own git config, nothing
 * inherited from the machine that built the overlay. The only thing shared is the pair of
 * bare repositories standing in for remotes.
 *
 * The comparison is `snapshotTree`, which records mode (exec bit), symlink targets and a
 * sha256 of every byte — and which includes `.overgit/manifest.json` while excluding the
 * two machine-local directories. Equality of two such snapshots is what "byte-identical
 * merged tree" means.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUN_BIN,
  CLI_ENTRY,
  DEFAULT_TIMEOUT_MS,
  PROJECT_ROOT,
  cleanupAllSandboxes,
  compareTrees,
  describeResult,
  envForPath,
  expectOk,
  formatTree,
  makeSandbox,
  overgit as realOvergit,
  runCommand,
  snapshotTree,
  type CmdResult,
  type Repo,
  type Sandbox,
  type Upstream,
} from "./helpers/harness.ts";
import { assertCleanSafe } from "./helpers/clean.ts";

/* ==================================================================== the CLI runner */

/**
 * Equivalent of `bin/overgit`, used only while `src/cli/**` does not load. Kept in step
 * with the copy in `bootstrap.test.ts`; both exist so each test file runs standalone.
 */
const DRIVER_SOURCE = `
const ROOT = ${JSON.stringify(PROJECT_ROOT)};
const bs = await import(ROOT + "/src/bootstrap.ts");
const ctxmod = await import(ROOT + "/src/context.ts");
const own = await import(ROOT + "/src/ownership.ts");
const mani = await import(ROOT + "/src/manifest.ts");
const errs = await import(ROOT + "/src/errors.ts");

const argv = Bun.argv.slice(2);
const cwd = process.cwd();
const value = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const ctx = () => ctxmod.discover(cwd, { requireOverlay: true });

try {
  const cmd = argv.shift();
  if (cmd === "init") {
    const r = await bs.initOverlay(cwd, { remote: value("--remote"), branch: value("--branch") });
    console.log("initialised an empty overlay in " + r.ctx.overgitDir);
  } else if (cmd === "clone") {
    const baseUrl = value("--base");
    const branch = value("--branch");
    const overlayUrl = argv.shift();
    const dir = argv.shift();
    const r = await bs.cloneOverlay({ overlayUrl, baseUrl, dir, cwd, branch });
    console.log(
      (r.alreadyPresent ? "already bootstrapped: " : "bootstrapped ") + r.owned + " path(s) in " + r.root,
    );
  } else if (cmd === "apply" || cmd === "attach") {
    console.log("apply: changed=" + (await bs.attach(await ctx(), { dryRun: flag("--dry-run") })).changed);
  } else if (cmd === "detach") {
    console.log("detach: alreadyDetached=" + (await bs.detach(await ctx(), { force: flag("--force") })).alreadyDetached);
  } else if (cmd === "add") {
    for (const c of (await own.takeOwnership(await ctx(), argv, { force: flag("--force") })).changes) {
      console.log(c.from + " -> " + c.to + "  " + c.path);
    }
  } else if (cmd === "rm") {
    for (const c of (await own.whiteout(await ctx(), argv, { force: flag("--force") })).changes) {
      console.log(c.from + " -> " + c.to + "  " + c.path);
    }
  } else if (cmd === "commit") {
    const c = await ctx();
    const msg = value("-m") ?? "overgit commit";
    const m = await mani.readManifest(c);
    for (const p of mani.ownedPaths(m)) {
      if (m.entries[p].kind === "delete") continue;
      const wt = await own.readWorktreeEntry(c.root, p);
      if (wt) await own.stageOverlayContent(c, p, wt.mode, wt.content);
    }
    console.log(await c.overlay.commit(msg));
  } else if (cmd === "push" || cmd === "git") {
    const c = await ctx();
    const r = await c.overlay.run(cmd === "git" ? argv : [cmd, ...argv], { allowFailure: true });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exit(r.code);
  } else if (cmd === "--version") {
    console.log("overgit 0.1.0 (test driver)");
  } else {
    process.stderr.write("error: unknown command " + cmd + "\\n");
    process.exit(2);
  }
} catch (e) {
  if (errs.isOvergitError(e)) {
    process.stderr.write("error: " + e.message + "\\n");
    for (const d of e.details) process.stderr.write("  " + d + "\\n");
    if (e.hint) process.stderr.write("  hint: " + e.hint + "\\n");
    process.exit(e.exitCode);
  }
  process.stderr.write("error: " + (e && e.message) + "\\n" + (e && e.stack) + "\\n");
  process.exit(1);
}
`;

let driverDir: string | null = null;
let driverPath: string | null = null;
let useRealCli = false;

beforeAll(async () => {
  if (existsSync(join(PROJECT_ROOT, "src", "cli", "main.ts"))) {
    const probe = await realOvergit(PROJECT_ROOT, "--version");
    if (probe.code === 0) {
      useRealCli = true;
      return;
    }
    console.warn(
      `[roundtrip.test] ${CLI_ENTRY} exists but \`--version\` exited ${probe.code}; ` +
        `driving src/bootstrap.ts directly instead.\n${describeResult(probe)}`,
    );
  }
  driverDir = await mkdtemp(join(tmpdir(), "overgit-p5-rt-driver-"));
  driverPath = join(driverDir, "overgit-driver.ts");
  await writeFile(driverPath, DRIVER_SOURCE);
});

afterAll(async () => {
  await cleanupAllSandboxes();
  if (driverDir) await rm(driverDir, { recursive: true, force: true });
});

async function og(cwd: string, ...args: string[]): Promise<CmdResult> {
  if (useRealCli) return realOvergit(cwd, ...args);
  return runCommand([BUN_BIN, driverPath!, ...args], {
    cwd,
    env: envForPath(cwd),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
}

async function ogOk(cwd: string, ...args: string[]): Promise<CmdResult> {
  return expectOk(await og(cwd, ...args));
}

/* ==================================================================== the fixture */

/** A filename with a space and a `#` — both are special in a gitignore pattern. */
const SPACY = "notes/a draft #2.md";
const BINARY = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x7f, 0x80, 0x0a]);
const SCRIPT = "#!/bin/sh\necho overlay tooling\n";

interface Origin {
  sb: Sandbox;
  baseUpstream: Upstream;
  overlayRemote: Repo;
  base: Repo;
  /** Byte-level snapshot of the merged tree the new machine has to reproduce. */
  want: Map<string, string>;
}

/**
 * Build the merged tree on "machine one" using the real commands, then push the overlay to
 * a bare repository. Nothing about the result is machine-specific: the manifest, the overlay
 * commits and the base commits are all that leave this function.
 */
async function buildOrigin(): Promise<Origin> {
  const sb = await makeSandbox("roundtrip-origin");

  const baseUpstream = await sb.mkUpstream("base-remote", {
    "README.md": "# project\n",
    "src/app.ts": "export const app = 1;\n",
    "src/config.ts": "export const env = 'production';\n",
    "docs/legacy.md": "this document is obsolete\n",
    "tools/base-tool.sh": "#!/bin/sh\necho base tooling\n",
  });
  const overlayRemote = await sb.mkBareRepo("overlay-remote");
  const base = await baseUpstream.clone("base");

  // The base's own executable bit, so we can tell overgit apart from a plain checkout.
  await base.setExec("tools/base-tool.sh");
  await base.git("update-index", "--chmod=+x", "tools/base-tool.sh");
  await base.commit("make base-tool executable");
  await base.git("push", "origin", "main");

  await ogOk(base.dir, "init", "--remote", overlayRemote.dir);

  // ── override: a base file the overlay replaces ──
  await base.write("src/config.ts", "export const env = 'local-dev';\n");
  await ogOk(base.dir, "add", "src/config.ts");

  // ── whiteout: a base file the overlay deletes ──
  await ogOk(base.dir, "rm", "docs/legacy.md");

  // ── adds, including every awkward file kind ──
  await base.write("scripts/dev.sh", SCRIPT);
  await base.setExec("scripts/dev.sh");
  await base.writeBytes("assets/blob.bin", BINARY);
  await base.symlink("../src/config.ts", "scripts/config-link.ts");
  await base.write(SPACY, "a draft, with a space and a hash in its name\n");
  await base.write("notes/plain.md", "ordinary\n");
  await ogOk(
    base.dir,
    "add",
    "scripts/dev.sh",
    "assets/blob.bin",
    "scripts/config-link.ts",
    SPACY,
    "notes/plain.md",
  );

  await ogOk(base.dir, "commit", "-m", "overlay: local dev setup");
  await ogOk(base.dir, "push", "-u", "origin", "main");

  // Sanity: the machine that built it is itself invisible to the base.
  await base.assertClean({ label: "origin machine" });

  const want = await base.snapshot();
  return { sb, baseUpstream, overlayRemote, base, want };
}

/** Everything the merged tree must contain, asserted directly rather than only by hash. */
async function assertMergedTree(repo: Repo, label: string): Promise<void> {
  expect(await repo.read("src/config.ts")).toBe("export const env = 'local-dev';\n");
  expect(await repo.read("src/app.ts")).toBe("export const app = 1;\n");
  expect(await repo.exists("docs/legacy.md")).toBe(false);
  expect(await repo.read("scripts/dev.sh")).toBe(SCRIPT);
  expect(await repo.isExec("scripts/dev.sh")).toBe(true);
  expect(await repo.isExec("tools/base-tool.sh")).toBe(true);
  expect(await repo.readBytes("assets/blob.bin")).toEqual(BINARY);
  expect(await repo.readlink("scripts/config-link.ts")).toBe("../src/config.ts");
  expect(await repo.read(SPACY)).toBe("a draft, with a space and a hash in its name\n");

  expect(await repo.skipWorktreePaths()).toEqual(["docs/legacy.md", "src/config.ts"]);
  expect(await repo.excludeLines()).toEqual([
    "/.overgit/",
    "/assets/blob.bin",
    "/notes/a\\ draft\\ \\#2.md",
    "/notes/plain.md",
    "/scripts/config-link.ts",
    "/scripts/dev.sh",
  ]);
  await repo.assertClean({ label });
}

/* ==================================================================== the test */

test(
  "a new machine reproduces the merged tree byte-for-byte with one command, twice",
  async () => {
    const origin = await buildOrigin();
    try {
      await assertMergedTree(origin.base, "origin machine");

      // ── the new machine: separate sandbox, separate HOME, separate git config ──
      const machine = await makeSandbox("roundtrip-new-machine");
      try {
        const first = await og(
          machine.dir,
          "clone",
          "--base",
          origin.baseUpstream.url,
          origin.overlayRemote.dir,
          "project",
        );
        expectOk(first);
        expect(first.stderr).not.toMatch(/error|fatal|warning|traceback/i);

        const proj = machine.adopt("project");
        const got = await proj.snapshot();
        const diff = compareTrees(origin.want, got, {
          a: "origin machine",
          b: "new machine",
        });
        if (!diff.equal) {
          throw new Error(
            `the bootstrapped tree is not byte-identical to the original\n${diff.text}\n\n` +
              `--- origin ---\n${formatTree(origin.want)}\n--- new machine ---\n${formatTree(got)}`,
          );
        }
        expect(diff.equal).toBe(true);
        // A snapshot of five entries would pass trivially; this one is substantial.
        // (10, not 11: whiting out the last file in a directory now prunes the empty
        // directory too, because git cannot represent one and a fresh clone never has it.)
        expect(got.size).toBeGreaterThanOrEqual(10);

        await assertMergedTree(proj, "new machine");
        await assertCleanSafe(proj.dir, { label: "new machine" });

        // ── the same command again: a clean no-op ──
        const before = await proj.snapshot();
        const overlayHead = (
          await proj.gitRun(["--git-dir", proj.path(".overgit/.git"), "rev-parse", "HEAD"])
        ).stdout.trim();
        const baseHead = await proj.head();

        const second = await og(
          machine.dir,
          "clone",
          "--base",
          origin.baseUpstream.url,
          origin.overlayRemote.dir,
          "project",
        );
        expectOk(second);
        expect(second.code).toBe(0);
        expect(second.stderr).not.toMatch(/error|fatal|warning|traceback/i);

        expect(compareTrees(before, await proj.snapshot(), { a: "run 1", b: "run 2" }).text).toBe("");
        expect(
          (await proj.gitRun(["--git-dir", proj.path(".overgit/.git"), "rev-parse", "HEAD"]))
            .stdout.trim(),
        ).toBe(overlayHead);
        expect(await proj.head()).toBe(baseHead);
        expect(
          (await proj.gitRun([
            "--git-dir",
            proj.path(".overgit/.git"),
            "status",
            "--porcelain",
          ])).stdout,
        ).toBe("");
        await assertMergedTree(proj, "new machine, second run");
      } finally {
        await machine.cleanup();
      }
    } finally {
      await origin.sb.cleanup();
    }
  },
  120_000,
);

test(
  "the in-base form of the same command produces the identical tree",
  async () => {
    const origin = await buildOrigin();
    try {
      const machine = await makeSandbox("roundtrip-in-base");
      try {
        // The user already has a base checkout and only wants the overlay on top of it.
        const cl = await runCommand(
          ["git", "clone", "--quiet", origin.baseUpstream.url, machine.path("checkout")],
          { cwd: machine.dir, env: machine.env },
        );
        expect(cl.code).toBe(0);
        const proj = machine.adopt("checkout");

        const r = await og(proj.dir, "clone", origin.overlayRemote.dir);
        expectOk(r);
        expect(r.stderr).not.toMatch(/error|fatal|warning|traceback/i);

        expect(
          compareTrees(origin.want, await proj.snapshot(), { a: "origin", b: "in-base clone" }).text,
        ).toBe("");
        await assertMergedTree(proj, "in-base clone");

        const before = await proj.snapshot();
        expectOk(await og(proj.dir, "clone", origin.overlayRemote.dir));
        expect(compareTrees(before, await proj.snapshot()).text).toBe("");
      } finally {
        await machine.cleanup();
      }
    } finally {
      await origin.sb.cleanup();
    }
  },
  120_000,
);

test(
  "detach and attach round-trip the merged tree byte-for-byte on the new machine",
  async () => {
    const origin = await buildOrigin();
    try {
      const machine = await makeSandbox("roundtrip-detach");
      try {
        await ogOk(
          machine.dir,
          "clone",
          "--base",
          origin.baseUpstream.url,
          origin.overlayRemote.dir,
          "project",
        );
        const proj = machine.adopt("project");
        const merged = await proj.snapshot();

        await ogOk(proj.dir, "detach");

        // Detached means: indistinguishable from a plain `git clone` of the base, except
        // for `.overgit/`, which the base can neither see nor commit.
        const pristineDir = machine.path("pristine");
        expect(
          (
            await runCommand(
              ["git", "clone", "--quiet", origin.baseUpstream.url, pristineDir],
              { cwd: machine.dir, env: machine.env },
            )
          ).code,
        ).toBe(0);
        const pristine = await snapshotTree(pristineDir);
        const detached = await snapshotTree(proj.dir, { exclude: [".overgit"] });
        expect(
          compareTrees(pristine, detached, { a: "plain git clone", b: "detached" }).text,
        ).toBe("");
        expect(await proj.skipWorktreePaths()).toEqual([]);
        expect(await proj.exists(".overgit/local/detached")).toBe(true);
        await proj.assertClean({ label: "detached" });

        await ogOk(proj.dir, "attach");
        expect(
          compareTrees(merged, await proj.snapshot(), { a: "before detach", b: "after attach" })
            .text,
        ).toBe("");
        expect(await proj.exists(".overgit/local/detached")).toBe(false);
        await assertMergedTree(proj, "after attach");
      } finally {
        await machine.cleanup();
      }
    } finally {
      await origin.sb.cleanup();
    }
  },
  120_000,
);
