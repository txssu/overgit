/**
 * overgit integration-test harness.
 *
 * Everything a behavioural test needs, in one import:
 *
 *   import { makeSandbox, overgit, expectOk, assertBaseClean, snapshotTree } from "./helpers/harness.ts";
 *
 * Principles:
 *  - tests spawn the real CLI (`bin/overgit`); nothing here imports `src/*`,
 *  - every sandbox is hermetic (own HOME, own GIT_CONFIG_GLOBAL, no system config,
 *    no network — "remotes" are local bare repos),
 *  - sandbox dirs are realpath'd, because macOS `/tmp` is a symlink to `/private/tmp`
 *    and the tool reports realpath'd roots,
 *  - every spawn has a timeout, so a wedged CLI fails the test instead of hanging it.
 *
 * Set `OVERGIT_TEST_KEEP=1` to keep sandboxes on disk; their paths are printed.
 */

import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  realpath,
  lstat,
  stat,
  symlink as fsSymlink,
  readlink as fsReadlink,
  chmod,
} from "node:fs/promises";
import { rmSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  runCommand,
  describeResult,
  formatArgv,
  DEFAULT_TIMEOUT_MS,
  type CmdResult,
  type RunOptions,
} from "./exec.ts";
import {
  buildSandboxEnv,
  globalGitConfig,
  HOST_TMPDIR,
  TEST_EPOCH,
} from "./env.ts";
import {
  envForPath,
  registerSandbox,
  unregisterSandbox,
  type RegisteredSandbox,
} from "./registry.ts";
import {
  snapshotTree,
  type TreeSnapshot,
  type SnapshotOptions,
} from "./tree.ts";
import {
  assertBaseClean,
  assertCleanSafe,
  type AssertBaseCleanOptions,
  type CleanSafeOptions,
  type CleanSafeResult,
} from "./clean.ts";

export type { CmdResult, RunOptions } from "./exec.ts";
export type { TreeSnapshot, SnapshotOptions, TreeDiff } from "./tree.ts";
export type {
  AssertBaseCleanOptions,
  CleanSafeOptions,
  CleanSafeResult,
} from "./clean.ts";
export {
  snapshotTree,
  diffTrees,
  compareTrees,
  assertTreesEqual,
  assertTreesDiffer,
  formatTree,
  sha256,
  sha256File,
} from "./tree.ts";
export { assertBaseClean, assertCleanSafe } from "./clean.ts";
export { runCommand, describeResult, formatArgv, DEFAULT_TIMEOUT_MS } from "./exec.ts";
export { TEST_USER_NAME, TEST_USER_EMAIL, TEST_EPOCH } from "./env.ts";
export { isPathInside, envForPath } from "./registry.ts";

/* ------------------------------------------------------------------ constants */

/** Repo root, realpath'd (matters on macOS). */
export const PROJECT_ROOT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The CLI entrypoint under test. Never imported — always spawned. */
export const CLI_ENTRY = join(PROJECT_ROOT, "bin", "overgit");
/** The bun that is running these tests (more reliable than `bun` on PATH). */
export const BUN_BIN = process.execPath;

const KEEP = process.env.OVERGIT_TEST_KEEP === "1";

/**
 * Bun auto-loads `.env` from the cwd. A fixture repo containing a `.env` would therefore
 * leak variables into the CLI under test, so the harness disables it. Override with
 * `OVERGIT_TEST_ENV_FILE` if a test needs the default behaviour.
 */
const CLI_ENV_FILE = process.env.OVERGIT_TEST_ENV_FILE ?? "/dev/null";

/* ---------------------------------------------------------------- weird paths */

/**
 * Filenames the tool claims to survive. Safe on Linux and macOS and stable under
 * unicode normalisation (nothing here has an NFD form), so they can be compared to
 * string literals.
 */
export const WEIRD_NAMES: readonly string[] = [
  "a file with spaces.txt",
  "single'quote.txt",
  'double"quote.txt',
  "hash#tag.txt",
  "bang!bang.txt",
  "bracket[1].txt",
  "brace{2}.txt",
  "star*not-glob.txt",
  "semi;colon & amp.txt",
  "back\\slash.txt",
  "paren(3).txt",
  "dollar$var.txt",
  "unicode-日本語-🎉-Ω.txt",
  "dir with space/nested file!.txt",
  "-leading-dash.txt",
];

/**
 * `café.txt` has both an NFC and an NFD spelling and macOS (APFS/HFS+) may hand back a
 * different one than you wrote. Use it when you *want* to test normalisation; do not put
 * it in a snapshot that is compared against a literal.
 */
export const NFD_SENSITIVE_NAME = "café-nfd.txt";

/** A filename containing a newline. Legal on Linux/macOS; breaks naive `-z`-less parsing. */
export const NEWLINE_NAME = "new\nline.txt";

/* --------------------------------------------------------------------- errors */

export class CmdFailure extends Error {
  readonly result: CmdResult;
  constructor(message: string, result: CmdResult) {
    super(message);
    this.name = "CmdFailure";
    this.result = result;
  }
}

/** True when the failure is "the CLI does not exist / does not load", not a real exit. */
function looksLikeMissingCli(r: CmdResult): boolean {
  return (
    /Cannot find module|Could not resolve|error: Module not found|ENOENT/.test(
      r.stderr,
    ) && /bin\/overgit|src\//.test(r.stderr)
  );
}

/** Asserts exit code 0, with a failure message you can act on. */
export function expectOk(r: CmdResult): CmdResult {
  if (r.code === 0) return r;
  const extra = looksLikeMissingCli(r)
    ? "\n  note: the CLI failed to load — bin/overgit or a module it imports is missing.\n" +
      "        This is a build/ordering problem, not a behavioural failure."
    : "";
  throw new CmdFailure(
    `expected command to succeed, got exit ${r.code}\n${describeResult(r)}${extra}`,
    r,
  );
}

/** Asserts a non-zero exit; optionally an exact code (see EXIT in src/errors.ts). */
export function expectFail(r: CmdResult, code?: number): CmdResult {
  if (r.code === 0) {
    throw new CmdFailure(
      `expected command to fail, got exit 0\n${describeResult(r)}`,
      r,
    );
  }
  if (code !== undefined && r.code !== code) {
    throw new CmdFailure(
      `expected exit ${code}, got ${r.code}\n${describeResult(r)}`,
      r,
    );
  }
  return r;
}

/** Asserts an exact exit code (including 0). */
export function expectExit(r: CmdResult, code: number): CmdResult {
  if (r.code !== code) {
    throw new CmdFailure(
      `expected exit ${code}, got ${r.code}\n${describeResult(r)}`,
      r,
    );
  }
  return r;
}

/* ------------------------------------------------------------------- CLI spawn */

export interface OvergitRunOptions {
  /** Extra/overriding env for this invocation. `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  input?: string | Uint8Array;
  timeoutMs?: number;
}

/**
 * Spawn the real CLI. `cwd` selects the sandbox whose hermetic env is used, so this works
 * with the `overgit(cwd, ...args)` signature every test is written against.
 *
 * Resolves for any exit code, including failures — use `expectOk`/`expectFail` to assert.
 * It **rejects** only when the CLI has to be killed for exceeding `DEFAULT_TIMEOUT_MS`
 * (30s, override with `OVERGIT_TEST_TIMEOUT_MS`), so a wedged CLI fails loudly.
 */
export function overgit(cwd: string, ...args: string[]): Promise<CmdResult> {
  return overgitRun(cwd, args);
}

/** `overgit()` with stdin / extra env / a custom timeout. */
export async function overgitRun(
  cwd: string,
  args: string[],
  opts: OvergitRunOptions = {},
): Promise<CmdResult> {
  const env = { ...envForPath(cwd), ...(opts.env ?? {}) };
  return runCommand(
    [BUN_BIN, "--env-file=" + CLI_ENV_FILE, CLI_ENTRY, ...args],
    {
      cwd,
      env,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  );
}

/** `expectOk(await overgit(...))` in one call. */
export async function overgitOk(
  cwd: string,
  ...args: string[]
): Promise<CmdResult> {
  return expectOk(await overgit(cwd, ...args));
}

/* ----------------------------------------------------------------------- Repo */

export interface GitRunOptions extends OvergitRunOptions {
  /** Return the result instead of throwing on a non-zero exit. */
  allowFailure?: boolean;
}

export interface Repo {
  /** Work-tree root (or the repo dir itself when bare). Realpath'd. */
  dir: string;
  /** Repo name inside the sandbox. */
  name: string;
  bare: boolean;
  sandbox: Sandbox;

  /** Run git in this repo. **Throws** on a non-zero exit, with stderr in the message. */
  git(...args: string[]): Promise<CmdResult>;
  /** Non-throwing variant. */
  gitTry(...args: string[]): Promise<CmdResult>;
  /** Full control: stdin, extra env, timeout, allowFailure. */
  gitRun(args: string[], opts?: GitRunOptions): Promise<CmdResult>;
  /** Run the CLI under test with this repo as cwd. */
  overgit(...args: string[]): Promise<CmdResult>;

  path(...p: string[]): string;

  write(p: string, c: string): Promise<void>;
  writeBytes(p: string, c: Uint8Array): Promise<void>;
  writeFiles(files: Record<string, string>): Promise<void>;
  read(p: string): Promise<string>;
  readBytes(p: string): Promise<Uint8Array>;
  exists(p: string): Promise<boolean>;
  /** Remove a file or directory from the work-tree (fs-level, git knows nothing). */
  rm(p: string): Promise<void>;
  mkdirp(p: string): Promise<void>;
  symlink(target: string, p: string): Promise<void>;
  readlink(p: string): Promise<string>;
  setExec(p: string, exec?: boolean): Promise<void>;
  isExec(p: string): Promise<boolean>;

  /** `git add -A` then commit (empty commits allowed). Returns the commit oid. */
  commit(msg: string): Promise<string>;
  /** Write files (null value = delete) and commit them. Returns the commit oid. */
  commitFiles(msg: string, files: Record<string, string | null>): Promise<string>;

  head(): Promise<string>;
  branch(): Promise<string | null>;
  /** Oldest-first `<oid> <subject>` lines. */
  log(): Promise<string[]>;
  /** Blob oid of `path` at `rev` (default HEAD), or null when absent. */
  blobOid(path: string, rev?: string): Promise<string | null>;
  /** Contents of `rev:path`. */
  show(path: string, rev?: string): Promise<string>;
  /** Paths tracked in the index, sorted. */
  trackedPaths(): Promise<string[]>;
  /** Paths whose index entry has the skip-worktree bit, sorted. */
  skipWorktreePaths(): Promise<string[]>;
  /** Non-comment lines of `.git/info/exclude`. */
  excludeLines(): Promise<string[]>;
  /** Absolute, resolved git dir. */
  gitDir(): Promise<string>;

  /** Byte-level work-tree snapshot (excludes `.git`, `.overgit/repo`, `.overgit/local`). */
  snapshot(opts?: SnapshotOptions): Promise<TreeSnapshot>;
  /** The invisibility oracle, scoped to this repo. */
  assertClean(opts?: AssertBaseCleanOptions): Promise<void>;
  /** The `git clean -xfd` survival oracle, scoped to this repo. */
  assertCleanSafe(opts?: CleanSafeOptions): Promise<CleanSafeResult>;
}

class RepoImpl implements Repo {
  dir: string;
  name: string;
  bare: boolean;
  sandbox: Sandbox;
  /** Advances one second per `commit()` so oids are stable for a given sequence. */
  private clock = 0;

  constructor(sandbox: Sandbox, name: string, dir: string, bare: boolean) {
    this.sandbox = sandbox;
    this.name = name;
    this.dir = dir;
    this.bare = bare;
  }

  path(...p: string[]): string {
    return p.length ? join(this.dir, ...p) : this.dir;
  }

  async gitRun(args: string[], opts: GitRunOptions = {}): Promise<CmdResult> {
    const env = { ...this.sandbox.env, ...(opts.env ?? {}) };
    const argv = ["git", "-C", this.dir, "-c", "core.quotepath=false", ...args];
    const r = await runCommand(argv, {
      cwd: this.dir,
      env,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (r.code !== 0 && !opts.allowFailure) {
      throw new CmdFailure(
        `git failed in ${this.name} (exit ${r.code}): ${formatArgv(args)}\n${describeResult(r)}`,
        r,
      );
    }
    return r;
  }

  git(...args: string[]): Promise<CmdResult> {
    return this.gitRun(args);
  }

  gitTry(...args: string[]): Promise<CmdResult> {
    return this.gitRun(args, { allowFailure: true });
  }

  overgit(...args: string[]): Promise<CmdResult> {
    return overgitRun(this.dir, args);
  }

  async write(p: string, c: string): Promise<void> {
    const abs = this.path(p);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, c);
  }

  async writeBytes(p: string, c: Uint8Array): Promise<void> {
    const abs = this.path(p);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, c);
  }

  async writeFiles(files: Record<string, string>): Promise<void> {
    for (const [p, c] of Object.entries(files)) await this.write(p, c);
  }

  read(p: string): Promise<string> {
    return readFile(this.path(p), "utf8");
  }

  async readBytes(p: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(p)));
  }

  async exists(p: string): Promise<boolean> {
    try {
      await lstat(this.path(p));
      return true;
    } catch {
      return false;
    }
  }

  async rm(p: string): Promise<void> {
    await rm(this.path(p), { recursive: true, force: true });
  }

  async mkdirp(p: string): Promise<void> {
    await mkdir(this.path(p), { recursive: true });
  }

  async symlink(target: string, p: string): Promise<void> {
    const abs = this.path(p);
    await mkdir(dirname(abs), { recursive: true });
    await rm(abs, { force: true });
    await fsSymlink(target, abs);
  }

  readlink(p: string): Promise<string> {
    return fsReadlink(this.path(p));
  }

  async setExec(p: string, exec = true): Promise<void> {
    await chmod(this.path(p), exec ? 0o755 : 0o644);
  }

  async isExec(p: string): Promise<boolean> {
    return ((await stat(this.path(p))).mode & 0o111) !== 0;
  }

  private commitEnv(): Record<string, string> {
    const when = `${TEST_EPOCH + this.clock++} +0000`;
    return { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  }

  async commit(msg: string): Promise<string> {
    await this.gitRun(["add", "-A", "--", "."]);
    await this.gitRun(["commit", "--allow-empty", "-m", msg], {
      env: this.commitEnv(),
    });
    return this.head();
  }

  async commitFiles(
    msg: string,
    files: Record<string, string | null>,
  ): Promise<string> {
    for (const [p, c] of Object.entries(files)) {
      if (c === null) await this.rm(p);
      else await this.write(p, c);
    }
    return this.commit(msg);
  }

  async head(): Promise<string> {
    return (await this.gitRun(["rev-parse", "HEAD"])).stdout.trim();
  }

  async branch(): Promise<string | null> {
    const r = await this.gitRun(["symbolic-ref", "--short", "-q", "HEAD"], {
      allowFailure: true,
    });
    const name = r.stdout.trim();
    return r.code === 0 && name.length ? name : null;
  }

  async log(): Promise<string[]> {
    const r = await this.gitRun([
      "log",
      "--reverse",
      "--format=%H %s",
      "--no-decorate",
    ]);
    return r.stdout.split("\n").filter((l) => l.length > 0);
  }

  async blobOid(path: string, rev = "HEAD"): Promise<string | null> {
    const r = await this.gitRun(["rev-parse", "--verify", "-q", `${rev}:${path}`], {
      allowFailure: true,
    });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async show(path: string, rev = "HEAD"): Promise<string> {
    return (await this.gitRun(["show", `${rev}:${path}`])).stdout;
  }

  async trackedPaths(): Promise<string[]> {
    const r = await this.gitRun(["ls-files", "-z"]);
    return r.stdout.split("\0").filter((p) => p.length > 0).sort();
  }

  async skipWorktreePaths(): Promise<string[]> {
    const r = await this.gitRun(["ls-files", "-v", "-z"]);
    const out: string[] = [];
    for (const rec of r.stdout.split("\0")) {
      if (rec.length < 3) continue;
      // `git ls-files -v` tags each entry: `S` = skip-worktree (lowercased to `s` when the
      // entry is *also* assume-unchanged). Measured on git 2.55.
      const tag = rec[0]!;
      if (tag === "S" || tag === "s") out.push(rec.slice(2));
    }
    return out.sort();
  }

  async excludeLines(): Promise<string[]> {
    const p = join(await this.gitDir(), "info", "exclude");
    try {
      const text = await readFile(p, "utf8");
      return text.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    } catch {
      return [];
    }
  }

  async gitDir(): Promise<string> {
    return (await this.gitRun(["rev-parse", "--absolute-git-dir"])).stdout.trim();
  }

  snapshot(opts?: SnapshotOptions): Promise<TreeSnapshot> {
    return snapshotTree(this.dir, opts);
  }

  assertClean(opts?: AssertBaseCleanOptions): Promise<void> {
    return assertBaseClean(this.dir, { label: this.name, ...opts });
  }

  assertCleanSafe(opts?: CleanSafeOptions): Promise<CleanSafeResult> {
    return assertCleanSafe(this.dir, { label: this.name, ...opts });
  }
}

/* ------------------------------------------------------------------- Upstream */

/**
 * A local bare repo standing in for a network remote, plus a private working clone used
 * to publish new commits. This is how the drift matrix gets simulated
 * without touching the network.
 */
export interface Upstream {
  /** The bare repo directory (also usable verbatim as a git remote URL). */
  dir: string;
  url: string;
  name: string;
  /** Default branch (`main`). */
  branch: string;
  /** The bare repo itself, for plumbing queries. */
  repo: Repo;
  /** Private working clone the push helpers commit in. Not for assertions. */
  work: Repo;

  /** Clone the upstream into `<sandbox>/<name>`. This is a "base" repo. */
  clone(name: string, opts?: { branch?: string }): Promise<Repo>;

  /** Publish one commit. `null` value = delete the path. Returns the commit oid. */
  push(msg: string, changes: Record<string, string | null>): Promise<string>;
  /** Change an existing file upstream. */
  changeFile(p: string, content: string, msg?: string): Promise<string>;
  /** Add a new file upstream (the `add-collision` scenario). */
  addFile(p: string, content: string, msg?: string): Promise<string>;
  /** Delete a file upstream (the `upstream-deleted` scenario). */
  deleteFile(p: string, msg?: string): Promise<string>;

  /** Blob oid of `path` at `rev` (default the upstream branch tip). */
  blobOid(path: string, rev?: string): Promise<string | null>;
  head(): Promise<string>;
}

class UpstreamImpl implements Upstream {
  dir: string;
  url: string;
  name: string;
  branch: string;
  repo: Repo;
  work: Repo;
  private sandbox: Sandbox;

  constructor(
    sandbox: Sandbox,
    name: string,
    repo: Repo,
    work: Repo,
    branch: string,
  ) {
    this.sandbox = sandbox;
    this.name = name;
    this.dir = repo.dir;
    this.url = repo.dir;
    this.repo = repo;
    this.work = work;
    this.branch = branch;
  }

  async clone(name: string, opts: { branch?: string } = {}): Promise<Repo> {
    const dir = this.sandbox.path(name);
    const args = ["clone"];
    if (opts.branch) args.push("--branch", opts.branch);
    args.push(this.url, dir);
    const r = await runCommand(["git", ...args], {
      cwd: this.sandbox.dir,
      env: this.sandbox.env,
    });
    if (r.code !== 0) {
      throw new CmdFailure(
        `failed to clone upstream ${this.name} into ${name}\n${describeResult(r)}`,
        r,
      );
    }
    return this.sandbox.adopt(name, dir);
  }

  async push(msg: string, changes: Record<string, string | null>): Promise<string> {
    const oid = await this.work.commitFiles(msg, changes);
    await this.work.git("push", "origin", this.branch);
    return oid;
  }

  changeFile(p: string, content: string, msg?: string): Promise<string> {
    return this.push(msg ?? `upstream: change ${p}`, { [p]: content });
  }

  addFile(p: string, content: string, msg?: string): Promise<string> {
    return this.push(msg ?? `upstream: add ${p}`, { [p]: content });
  }

  deleteFile(p: string, msg?: string): Promise<string> {
    return this.push(msg ?? `upstream: delete ${p}`, { [p]: null });
  }

  blobOid(path: string, rev?: string): Promise<string | null> {
    return this.repo.blobOid(path, rev ?? this.branch);
  }

  head(): Promise<string> {
    return this.repo.gitRun(["rev-parse", this.branch]).then((r) => r.stdout.trim());
  }
}

/* -------------------------------------------------------------------- Sandbox */

export interface Sandbox {
  /** Temp root, realpath'd, auto-cleaned. */
  dir: string;
  label: string;
  /** `$HOME` for everything in this sandbox. */
  home: string;
  /** The file `GIT_CONFIG_GLOBAL` points at; append to it to change global config. */
  gitConfigPath: string;
  /** The hermetic environment every child process in this sandbox gets. */
  env: Record<string, string>;

  path(...p: string[]): string;

  /** Non-bare repo on `main` with an initial commit. */
  mkBaseRepo(name: string, files?: Record<string, string>): Promise<Repo>;
  /** Repo with no commits at all (unborn HEAD). */
  mkEmptyRepo(name: string): Promise<Repo>;
  /** Bare repo (a stand-in remote). */
  mkBareRepo(name: string): Promise<Repo>;
  /** Bare "remote" seeded with `files`, plus helpers to publish more commits. */
  mkUpstream(name: string, files?: Record<string, string>): Promise<Upstream>;

  /** Wrap an already-existing directory as a Repo (e.g. one the CLI created). */
  adopt(name: string, dir?: string): Repo;
  /** Run the CLI under test. */
  overgit(cwd: string, ...args: string[]): Promise<CmdResult>;
  /** Run an arbitrary command with the sandbox env. */
  run(argv: string[], opts?: RunOptions): Promise<CmdResult>;

  /** Keep this sandbox on disk and print its path (same as `OVERGIT_TEST_KEEP=1`). */
  keep(): void;
  cleanup(): Promise<void>;
}

class SandboxImpl implements Sandbox {
  dir: string;
  label: string;
  home: string;
  gitConfigPath: string;
  env: Record<string, string>;
  kept = false;
  private registration: RegisteredSandbox;
  private cleaned = false;
  private announced = false;

  constructor(
    label: string,
    dir: string,
    home: string,
    gitConfigPath: string,
    env: Record<string, string>,
  ) {
    this.label = label;
    this.dir = dir;
    this.home = home;
    this.gitConfigPath = gitConfigPath;
    this.env = env;
    this.registration = { dir, env };
    registerSandbox(this.registration);
  }

  path(...p: string[]): string {
    return p.length ? join(this.dir, ...p) : this.dir;
  }

  adopt(name: string, dir?: string): Repo {
    const abs = dir ?? this.path(name);
    return new RepoImpl(this, name, abs, false);
  }

  async run(argv: string[], opts: RunOptions = {}): Promise<CmdResult> {
    return runCommand(argv, {
      cwd: opts.cwd ?? this.dir,
      env: { ...this.env, ...(opts.env ?? {}) },
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  overgit(cwd: string, ...args: string[]): Promise<CmdResult> {
    return overgitRun(cwd, args);
  }

  private async initRepo(
    name: string,
    args: string[],
    bare: boolean,
  ): Promise<RepoImpl> {
    const dir = this.path(name);
    await mkdir(dir, { recursive: true });
    const real = await realpath(dir);
    const r = await this.run(["git", "init", ...args, real], { cwd: this.dir });
    if (r.code !== 0) {
      throw new CmdFailure(
        `git init failed for ${name}\n${describeResult(r)}`,
        r,
      );
    }
    return new RepoImpl(this, name, real, bare);
  }

  async mkEmptyRepo(name: string): Promise<Repo> {
    return this.initRepo(name, ["-b", "main"], false);
  }

  async mkBaseRepo(
    name: string,
    files?: Record<string, string>,
  ): Promise<Repo> {
    const repo = await this.initRepo(name, ["-b", "main"], false);
    await repo.writeFiles(files ?? { "README.md": `# ${name}\n` });
    await repo.commit("initial");
    return repo;
  }

  async mkBareRepo(name: string): Promise<Repo> {
    return this.initRepo(name, ["--bare", "-b", "main"], true);
  }

  async mkUpstream(
    name: string,
    files?: Record<string, string>,
  ): Promise<Upstream> {
    const branch = "main";
    const bare = await this.mkBareRepo(name);
    const workDir = this.path("_upstream-work", name);
    await mkdir(dirname(workDir), { recursive: true });
    const cl = await this.run(["git", "clone", bare.dir, workDir], {
      cwd: this.dir,
    });
    if (cl.code !== 0) {
      throw new CmdFailure(
        `failed to create upstream working clone for ${name}\n${describeResult(cl)}`,
        cl,
      );
    }
    const work = new RepoImpl(this, `_upstream-work/${name}`, await realpath(workDir), false);
    // The clone of an empty bare repo has an unborn HEAD; pin it to `branch` explicitly.
    await work.gitRun(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    await work.writeFiles(files ?? { "README.md": `# ${name}\n` });
    await work.commit("initial");
    await work.gitRun(["push", "-u", "origin", branch]);
    await bare.gitRun(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    return new UpstreamImpl(this, name, bare, work, branch);
  }

  keep(): void {
    this.kept = true;
    this.announce();
  }

  /** Print the sandbox path exactly once, so a kept sandbox is findable. */
  announce(): void {
    if (this.announced) return;
    this.announced = true;
    console.log(`[overgit-test] kept sandbox ${this.label}: ${this.dir}`);
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    unregisterSandbox(this.registration);
    LIVE.delete(this);
    if (KEEP || this.kept) {
      this.announce();
      return;
    }
    await rm(this.dir, { recursive: true, force: true });
  }
}

const LIVE = new Set<SandboxImpl>();
let exitHookInstalled = false;

/**
 * Best-effort net for plain `bun script.ts` runs.
 *
 * Measured: `bun test` does **not** run `process.on("exit")` handlers, so this is not a
 * guarantee inside the test runner. Tests own their cleanup — use `withSandbox`, or
 * `afterAll(cleanupAllSandboxes)` at the top of the test file.
 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const sb of LIVE) {
      if (KEEP || sb.kept) {
        sb.announce();
        continue;
      }
      try {
        rmSync(sb.dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });
}

/**
 * Create a hermetic sandbox.
 *
 * Cleanup is the test's job: prefer `withSandbox(label, fn)`, or call `sandbox.cleanup()`
 * and add `afterAll(cleanupAllSandboxes)` to the test file. `OVERGIT_TEST_KEEP=1` keeps
 * every sandbox on disk and prints its path.
 */
export async function makeSandbox(label: string): Promise<Sandbox> {
  installExitHook();
  // HOST_TMPDIR, not os.tmpdir(): a test may have pointed process.env.TMPDIR at another
  // sandbox, and nesting a sandbox inside one that is about to be deleted is fatal.
  const base = await realpath(process.env.OVERGIT_TEST_TMPDIR ?? HOST_TMPDIR);
  const slug = label.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40);
  // realpath again: macOS /tmp -> /private/tmp, and the tool reports resolved roots.
  const dir = await realpath(await mkdtemp(join(base, `overgit-${slug}-`)));

  const home = join(dir, "home");
  const tmp = join(dir, "tmp");
  await mkdir(home, { recursive: true });
  await mkdir(tmp, { recursive: true });
  await mkdir(join(home, ".config"), { recursive: true });

  const gitConfigPath = join(dir, "gitconfig");
  await writeFile(gitConfigPath, globalGitConfig());

  const env = buildSandboxEnv({
    dir,
    home,
    tmp,
    gitConfigPath,
    ceiling: base,
  });

  const sb = new SandboxImpl(label, dir, home, gitConfigPath, env);
  LIVE.add(sb);
  if (KEEP) console.log(`[overgit-test] sandbox ${label}: ${dir}`);
  return sb;
}

/** `makeSandbox` + guaranteed cleanup. */
export async function withSandbox<T>(
  label: string,
  fn: (sb: Sandbox) => Promise<T>,
): Promise<T> {
  const sb = await makeSandbox(label);
  try {
    return await fn(sb);
  } finally {
    await sb.cleanup();
  }
}

/** Clean up every sandbox still alive. Useful in a global `afterAll`. */
export async function cleanupAllSandboxes(): Promise<void> {
  for (const sb of [...LIVE]) await sb.cleanup();
}

/* ------------------------------------------------------- hand-built overlay fixture */

/**
 * The standard overlay fixture, built with **raw git only** — no overgit involved.
 *
 * This is the oracle's oracle: if `assertBaseClean` says this repo is clean, the oracle
 * agrees with the measured git behaviour the whole design rests on. Other builders can
 * use it to reproduce the drift matrix (`git pull`, `git clean -xfd`, `git stash -a`, …)
 * without depending on the CLI existing yet.
 *
 * Base layout after construction:
 *   A.txt  overlay-added   untracked by base, listed in `.git/info/exclude`
 *   B.txt  plain base file untouched
 *   C.txt  overridden      skip-worktree set, work-tree holds overlay bytes
 *   D.txt  whited out      skip-worktree set, file removed from the work-tree
 *   .overgit/.git          overlay GIT_DIR
 *   .overgit/…             manifest + local state, excluded via `.git/info/exclude`
 */
export interface ManualOverlay {
  upstream: Upstream;
  base: Repo;
  /** `["A.txt"]` */
  adds: string[];
  /** `["C.txt"]` */
  overrides: string[];
  /** `["D.txt"]` */
  whiteouts: string[];
  /** Bytes the overlay put in the work-tree, by path. */
  overlayContent: Record<string, string>;
  /** Bytes the base has committed, by path. */
  baseContent: Record<string, string>;
}

export interface ManualOverlayOptions {
  /** Sandbox-relative name for the base clone. Default `"base"`. */
  baseName?: string;
  /** Sandbox-relative name for the bare upstream. Default `"upstream"`. */
  upstreamName?: string;
  /** Extra files to seed upstream with (e.g. weird names). */
  extraFiles?: Record<string, string>;
}

export async function mkManualOverlay(
  sb: Sandbox,
  opts: ManualOverlayOptions = {},
): Promise<ManualOverlay> {
  const baseName = opts.baseName ?? "base";
  const upstreamName = opts.upstreamName ?? "upstream";

  const baseContent: Record<string, string> = {
    "B.txt": "base B\n",
    "C.txt": "base C\n",
    "D.txt": "base D\n",
    ...(opts.extraFiles ?? {}),
  };
  const upstream = await sb.mkUpstream(upstreamName, baseContent);
  const base = await upstream.clone(baseName);

  const overlayContent: Record<string, string> = {
    "A.txt": "overlay A\n",
    "C.txt": "overlay C\n",
  };

  // `add`: untracked by base, hidden through .git/info/exclude.
  const gitDir = await base.gitDir();
  await mkdir(join(gitDir, "info"), { recursive: true });
  await writeFile(
    join(gitDir, "info", "exclude"),
    [
      "# git ls-files --others --exclude-from=.git/info/exclude",
      "# >>> overgit managed block — do not edit (regenerate with `overgit doctor --fix`) >>>",
      "/.overgit/",
      "/A.txt",
      "# <<< overgit managed block <<<",
      "",
    ].join("\n"),
  );
  await base.write("A.txt", overlayContent["A.txt"]!);

  // `override`: flag first, then the bytes, so git never sees a modified tracked file.
  await base.git("update-index", "--skip-worktree", "C.txt");
  await base.write("C.txt", overlayContent["C.txt"]!);

  // `delete` (whiteout): flag, then remove from the work-tree.
  await base.git("update-index", "--skip-worktree", "D.txt");
  await base.rm("D.txt");

  // Overlay private state: the overlay GIT_DIR is
  // `.overgit/.git`, so `.overgit/` *is* an ordinary git repo directory.
  //
  // This is load-bearing, not cosmetic. Measured on git 2.55: `git clean -xfd` skips a
  // directory only when `<dir>/.git` resolves to a real repository. A raw gitdir at
  // `.overgit/repo` with no `.overgit/.git` gets the whole overlay deleted, which would
  // make the `git clean -xfd` row of the drift matrix unrecoverable rather than
  // recoverable — so the fixture must have the real shape for that row to mean anything.
  await base.git("init", "--quiet", "-b", "main", "--bare", ".overgit/.git");
  await base.git("--git-dir", base.path(".overgit", ".git"), "config", "core.bare", "false");
  await base.git(
    "--git-dir",
    base.path(".overgit", ".git"),
    "config",
    "core.worktree",
    "../..",
  );
  await base.write(".overgit/manifest.json", manualManifest(base, upstream));
  await base.mkdirp(".overgit/local");
  await base.write(".overgit/local/placeholder", "");

  return {
    upstream,
    base,
    adds: ["A.txt"],
    overrides: ["C.txt"],
    whiteouts: ["D.txt"],
    overlayContent,
    baseContent,
  };
}

function manualManifest(_base: Repo, _upstream: Upstream): string {
  // Placeholder shape only — the real manifest is P2's. Tests that care read real oids.
  return `${JSON.stringify(
    { version: 1, entries: { "A.txt": { kind: "add" } } },
    null,
    2,
  )}\n`;
}

/* ---------------------------------------------------------------- misc helpers */

/** Write every `WEIRD_NAMES` entry into `repo`, contents = the name itself. */
export async function seedWeirdNames(
  repo: Repo,
  names: readonly string[] = WEIRD_NAMES,
): Promise<string[]> {
  for (const n of names) await repo.write(n, `content of ${n}\n`);
  return [...names];
}

/** `true` when `p` exists (file, dir or dangling symlink). */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Assert a substring is present, with the whole haystack in the failure message. */
export function expectContains(
  haystack: string,
  needle: string,
  what = "output",
): void {
  if (!haystack.includes(needle)) {
    throw new Error(
      `expected ${what} to contain ${JSON.stringify(needle)}\n--- ${what} ---\n${haystack}\n--- end ---`,
    );
  }
}
