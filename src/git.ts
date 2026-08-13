/**
 * Thin, paranoid wrapper around the system `git` binary.
 *
 * Design rules:
 *  - every command that offers `-z` uses it, and output is parsed NUL-delimited, because
 *    real paths contain spaces, quotes, `#`, `[`, `!` and newlines;
 *  - blob content never makes a UTF-8 round trip (`catFileBlob` / `hashObject` are bytes);
 *  - the spawn environment is sanitised so behaviour does not depend on the ambient shell
 *    (in particular overgit can be invoked *from a git hook*, where `GIT_DIR`,
 *    `GIT_INDEX_FILE` and friends are set and would silently retarget every command);
 *  - `core.quotepath=false` is forced so any accidental non-`-z` path output is raw;
 *  - read-only commands run with `GIT_OPTIONAL_LOCKS=0` so `overgit status` never fights
 *    a concurrent `git` for the index lock.
 *
 * Known limit: path *names* are JS strings, so a file name that is not valid UTF-8 cannot
 * round-trip (`node:fs` encodes string paths as UTF-8). Blob *content* is always exact
 * bytes. Nothing here crashes on such a name, but overgit cannot own one.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve as nodeResolve } from "node:path";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitBinaryResult {
  stdout: Uint8Array;
  stderr: string;
  code: number;
}

export interface GitRunOptions {
  cwd?: string;
  input?: string | Uint8Array;
  /** default false → throws GitError on non-zero exit */
  allowFailure?: boolean;
  env?: Record<string, string>;
}

/** First line of stderr, trimmed, with a `fatal: ` / `error: ` prefix kept. */
function firstStderrLine(stderr: string): string {
  for (const line of stderr.split("\n")) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return "";
}

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number;
  readonly stderr: string;
  readonly cwd: string;

  constructor(args: string[], exitCode: number, stderr: string, cwd: string) {
    // `args` is the full argv after `git`, which starts with the global -c options.
    // The subcommand is the first argument that is not part of a global option.
    const sub = subcommandOf(args);
    const detail = firstStderrLine(stderr);
    super(
      detail
        ? `git ${sub} failed (exit ${exitCode}): ${detail}`
        : `git ${sub} failed (exit ${exitCode})`,
    );
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.cwd = cwd;
  }
}

/** Global options that take a separate value argument. */
const GLOBAL_OPTS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace"]);

function subcommandOf(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (GLOBAL_OPTS_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return "<unknown>";
}

/**
 * Subcommands that never write to the repository, so they can run with
 * `GIT_OPTIONAL_LOCKS=0`. Conservative on purpose: anything not listed gets the lock.
 */
const READ_ONLY_SUBCOMMANDS = new Set([
  "cat-file",
  "check-ignore",
  "diff",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-tree",
  "merge-file",
  "rev-list",
  "rev-parse",
  "show",
  "status",
  "symbolic-ref",
  "var",
  "version",
]);

/**
 * Environment variables that must not leak in from the caller. Git hooks export most of
 * these; inheriting them would point our commands at the wrong repository or make
 * pathspec parsing behave differently from what this module assumes.
 */
/**
 * Variables that would silently retarget a git command at another repository. overgit can
 * be invoked from a git hook, where `GIT_DIR` and `GIT_INDEX_FILE` are exported — so every
 * spawn scrubs these, the terminal-attached ones in `cli/passthrough.ts` included.
 */
export const SCRUBBED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_INDEX_VERSION",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_LITERAL_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_QUARANTINE_PATH",
];

/**
 * Scrubbed on top of that for plumbing only. A user's `GIT_EXTERNAL_DIFF` is a legitimate
 * setting for the commands that hand the terminal to git, but it would corrupt output this
 * module parses.
 */
const SCRUBBED_ENV_PLUMBING = [...SCRUBBED_ENV, "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS"];

function buildEnv(readOnly: boolean, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const k of SCRUBBED_ENV_PLUMBING) delete env[k];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.GIT_ASKPASS = "";
  env.LC_ALL = "C";
  env.LANG = "C";
  if (readOnly) env.GIT_OPTIONAL_LOCKS = "0";
  else delete env.GIT_OPTIONAL_LOCKS;
  if (extra) Object.assign(env, extra);
  return env;
}

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? new TextEncoder().encode(input) : input;
}

/** Split NUL-delimited output, dropping the trailing empty element. */
export function splitNul(s: string): string[] {
  if (s.length === 0) return [];
  const parts = s.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Wrap a literal path so git treats it as an exact path and not a glob. Without this a
 * file genuinely named `star*.txt` matches `starX.txt` too (measured on git 2.55).
 */
export function literalPathspec(p: string): string {
  return `:(literal)${p}`;
}

/* ------------------------------------------------------------------ object ids */

const enc = new TextEncoder();

/** Git's blob OID for `bytes`, in whichever algorithm `likeOid` is written in. */
export function blobOidLike(bytes: Uint8Array, likeOid: string): string {
  const h = new Bun.CryptoHasher(likeOid.length === 64 ? "sha256" : "sha1");
  h.update(enc.encode(`blob ${bytes.byteLength}\0`));
  h.update(bytes);
  return h.digest("hex");
}

/** True when `content` hashes to `oid`. Absent content matches nothing, not even absence. */
export function contentIsOid(content: Uint8Array | null, oid: string | null | undefined): boolean {
  if (content === null || !oid) return false;
  return blobOidLike(content, oid) === oid;
}

/**
 * Abbreviated OID for messages. `absent` is what to print when there is no OID at all —
 * prose wants `(none)`, a status column wants `?`, and they must not drift apart.
 */
export function shortOid(o: string | null | undefined, absent = "(none)"): string {
  return o ? o.slice(0, 8) : absent;
}

/** The file modes overgit can store: regular, executable, symlink. No gitlinks. */
export const SUPPORTED_MODES = new Set(["100644", "100755", "120000"]);

export interface IndexEntry {
  path: string;
  oid: string;
  mode: string;
  stage: number;
  skipWorktree: boolean;
}

/** Index entries by path, conflict stages dropped — stage 0 is the only resolved state. */
export function indexMap<T extends IndexEntry>(entries: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const e of entries) if (e.stage === 0) m.set(e.path, e);
  return m;
}

export interface StatusEntry {
  x: string;
  y: string;
  path: string;
  origPath?: string;
}

export interface GitOptions {
  cwd: string;
  gitDir?: string;
  workTree?: string;
  /**
   * Forced `--untracked-files` value for `statusPorcelain`, so the result does not depend
   * on the repo's `status.showUntrackedFiles`. The overlay repo must use `"no"` (its
   * work-tree is full of the *base's* files, which are not its business).
   */
  untrackedFiles?: "no" | "normal" | "all";
}

/** Keep argv well under any plausible ARG_MAX / E2BIG limit. */
const MAX_ARGV_BYTES = 96 * 1024;

function chunkPathspecs(specs: string[]): string[][] {
  if (specs.length === 0) return [];
  const out: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const s of specs) {
    const n = Buffer.byteLength(s, "utf8") + 1;
    if (cur.length > 0 && size + n > MAX_ARGV_BYTES) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(s);
    size += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export class Git {
  readonly cwd: string;
  private readonly gitDir?: string;
  private readonly workTree?: string;
  private readonly untrackedFiles: "no" | "normal" | "all";

  constructor(opts: GitOptions) {
    this.cwd = opts.cwd;
    this.gitDir = opts.gitDir;
    this.workTree = opts.workTree;
    this.untrackedFiles = opts.untrackedFiles ?? "normal";
  }

  /** Global args that precede every subcommand. */
  private globalArgs(): string[] {
    const g: string[] = [];
    if (this.gitDir !== undefined) g.push("--git-dir", this.gitDir);
    if (this.workTree !== undefined) g.push("--work-tree", this.workTree);
    // Raw, unquoted paths everywhere, regardless of the user's core.quotepath.
    g.push("-c", "core.quotepath=false");
    return g;
  }

  private async spawn(
    args: string[],
    opts: GitRunOptions | undefined,
  ): Promise<{ stdout: Uint8Array; stderr: string; code: number; argv: string[]; cwd: string }> {
    const argv = [...this.globalArgs(), ...args];
    const cwd = opts?.cwd ?? this.cwd;
    const sub = subcommandOf(argv);
    let readOnly = READ_ONLY_SUBCOMMANDS.has(sub);
    // `symbolic-ref <ref> <value>` writes; the one-argument read form does not.
    if (readOnly && sub === "symbolic-ref" && args.filter((a) => !a.startsWith("-")).length > 2) {
      readOnly = false;
    }
    const env = buildEnv(readOnly, opts?.env);

    const input = opts?.input === undefined ? undefined : toBytes(opts.input);
    const proc = Bun.spawn({
      cmd: ["git", ...argv],
      cwd,
      env,
      // Never let git read the terminal: an unexpected prompt would hang the CLI.
      stdin: input === undefined ? "ignore" : input,
      stdout: "pipe",
      stderr: "pipe",
    });

    // stdout and stderr must be drained concurrently or a chatty command deadlocks.
    const [outBuf, errText, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    // Bun reports a signal death as 128+signo, so `code === 0` really does mean success.
    const stderr = proc.signalCode ? `${errText}git was killed by ${proc.signalCode}\n` : errText;
    return { stdout: new Uint8Array(outBuf), stderr, code, argv, cwd };
  }

  async run(args: string[], opts?: GitRunOptions): Promise<GitResult> {
    const r = await this.spawn(args, opts);
    if (r.code !== 0 && !opts?.allowFailure) {
      throw new GitError(r.argv, r.code, r.stderr, r.cwd);
    }
    return { stdout: new TextDecoder().decode(r.stdout), stderr: r.stderr, code: r.code };
  }

  async runBinary(args: string[], opts?: GitRunOptions): Promise<GitBinaryResult> {
    const r = await this.spawn(args, opts);
    if (r.code !== 0 && !opts?.allowFailure) {
      throw new GitError(r.argv, r.code, r.stderr, r.cwd);
    }
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
  }

  // repository shape

  async version(): Promise<{ major: number; minor: number; patch: number; raw: string }> {
    const { stdout } = await this.run(["version"]);
    const raw = stdout.trim();
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
    return {
      major: m ? Number(m[1]) : 0,
      minor: m ? Number(m[2]) : 0,
      patch: m && m[3] !== undefined ? Number(m[3]) : 0,
      raw,
    };
  }

  /** Resolve a revision to a full OID. `null` when it does not resolve. */
  async revParse(rev: string): Promise<string | null> {
    const r = await this.run(["rev-parse", "--verify", "--quiet", "--end-of-options", rev], {
      allowFailure: true,
    });
    if (r.code !== 0) return null;
    const oid = r.stdout.trim();
    return oid.length > 0 ? oid : null;
  }

  /** Absolute git dir for this worktree (resolves a `.git` *file*). */
  async resolveGitDir(): Promise<string> {
    const { stdout } = await this.run(["rev-parse", "--absolute-git-dir"]);
    return nodeResolve(this.cwd, stdout.trim());
  }

  /**
   * Absolute *common* git dir — where `info/exclude`, `objects/` and `refs/` live. Equal to
   * `resolveGitDir()` for an ordinary repo; differs inside a linked worktree, where
   * `info/exclude` is read from the main repo's `.git` (measured on git 2.55).
   *
   * `--git-common-dir` is reported *relative to the cwd* in an ordinary repo, so the
   * result must always be resolved against it.
   */
  async resolveCommonDir(): Promise<string> {
    const { stdout } = await this.run(["rev-parse", "--git-common-dir"]);
    return nodeResolve(this.cwd, stdout.trim());
  }

  async toplevel(): Promise<string> {
    const { stdout } = await this.run(["rev-parse", "--show-toplevel"]);
    return nodeResolve(this.cwd, stdout.trim());
  }

  /** Branch name, or `null` when HEAD is detached. Works on an unborn branch. */
  async currentBranch(): Promise<string | null> {
    const r = await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      allowFailure: true,
    });
    if (r.code !== 0) return null;
    const name = r.stdout.trim();
    return name.length > 0 ? name : null;
  }

  async headExists(): Promise<boolean> {
    return (await this.revParse("HEAD")) !== null;
  }

  // index / tree queries

  /** Every index entry for exactly `path` (all stages). */
  private async indexEntriesFor(path: string): Promise<IndexEntry[]> {
    const all = await this.lsFiles([literalPathspec(path)]);
    return all.filter((e) => e.path === path);
  }

  async isTracked(path: string): Promise<boolean> {
    return (await this.indexEntriesFor(path)).length > 0;
  }

  /** `HEAD:<path>` as a blob OID, or `null` when absent / not a blob (e.g. a directory). */
  async headBlobOid(path: string): Promise<string | null> {
    return this.treeBlobOid("HEAD", path);
  }

  /** `<rev>:<path>` as a blob OID, or `null` when absent / not a blob. */
  async treeBlobOid(rev: string, path: string): Promise<string | null> {
    const r = await this.run(["ls-tree", "-z", "--full-tree", rev, "--", literalPathspec(path)], {
      allowFailure: true,
    });
    if (r.code !== 0) return null;
    for (const rec of splitNul(r.stdout)) {
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      if (rec.slice(tab + 1) !== path) continue;
      // "<mode> SP <type> SP <oid>"
      const head = rec.slice(0, tab).split(" ");
      if (head.length < 3) continue;
      if (head[1] !== "blob") return null;
      return head[2]!;
    }
    return null;
  }

  /** Stage-0 blob OID in the index, or `null`. */
  async indexBlobOid(path: string): Promise<string | null> {
    const e = (await this.indexEntriesFor(path)).find((x) => x.stage === 0);
    return e ? e.oid : null;
  }

  /** Stage-0 index mode, e.g. `"100644"`, `"100755"`, `"120000"`. */
  async fileMode(path: string): Promise<string | null> {
    const e = (await this.indexEntriesFor(path)).find((x) => x.stage === 0);
    return e ? e.mode : null;
  }

  /**
   * Index contents. `-z -s -v`: the `-v` tag byte carries the skip-worktree bit
   * (`S`, or lowercase `s` when the path is *also* assume-unchanged — measured).
   *
   * `--full-name` makes the paths root-relative; without it `ls-files` reports paths
   * relative to the cwd, which would silently produce wrong keys for a `Git` whose cwd is
   * not the work-tree root.
   */
  async lsFiles(pathspec?: string[]): Promise<IndexEntry[]> {
    const base = ["ls-files", "-z", "-s", "-v", "--full-name"];
    const chunks = pathspec && pathspec.length > 0 ? chunkPathspecs(pathspec) : [[]];
    const out: IndexEntry[] = [];
    for (const chunk of chunks) {
      const args = chunk.length > 0 ? [...base, "--", ...chunk] : base;
      const { stdout } = await this.run(args);
      for (const rec of splitNul(stdout)) {
        const e = parseLsFilesRecord(rec);
        if (e) out.push(e);
      }
    }
    return out;
  }

  /** Recursive listing of a tree-ish. `stage` is always 0 and `skipWorktree` false. */
  async lsTree(rev: string): Promise<IndexEntry[]> {
    const { stdout } = await this.run(["ls-tree", "-r", "-z", "--full-tree", rev]);
    const out: IndexEntry[] = [];
    for (const rec of splitNul(stdout)) {
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      const head = rec.slice(0, tab).split(" ");
      if (head.length < 3) continue;
      out.push({
        path: rec.slice(tab + 1),
        mode: head[0]!,
        oid: head[2]!,
        stage: 0,
        skipWorktree: false,
      });
    }
    return out;
  }

  // objects

  /** Exact bytes of a blob. Never goes through a string. */
  async catFileBlob(oid: string): Promise<Uint8Array> {
    const { stdout } = await this.runBinary(["cat-file", "blob", oid]);
    return stdout;
  }

  async blobExists(oid: string): Promise<boolean> {
    const r = await this.run(["cat-file", "-t", oid], { allowFailure: true });
    return r.code === 0 && r.stdout.trim() === "blob";
  }

  /**
   * Hash (and optionally store) exact bytes. No filters are applied unless the caller
   * passes `path`, in which case gitattributes for that path do apply — overgit stores
   * work-tree bytes verbatim, so callers normally omit it.
   */
  async hashObject(
    content: Uint8Array,
    opts?: { write?: boolean; path?: string },
  ): Promise<string> {
    const args = ["hash-object", "-t", "blob"];
    if (opts?.write) args.push("-w");
    if (opts?.path !== undefined) args.push("--path", opts.path);
    else args.push("--no-filters");
    args.push("--stdin");
    const { stdout } = await this.run(args, { input: content });
    return stdout.trim();
  }

  // skip-worktree

  /** Fails loudly (GitError) if a path is not in the index — git cannot mark what it does not track. */
  async setSkipWorktree(paths: string[]): Promise<void> {
    await this.updateIndexFlag("--skip-worktree", paths);
  }

  async clearSkipWorktree(paths: string[]): Promise<void> {
    await this.updateIndexFlag("--no-skip-worktree", paths);
  }

  private async updateIndexFlag(flag: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    // `--stdin -z` avoids argv limits and any pathspec interpretation of the names.
    await this.run(["update-index", "-z", flag, "--stdin"], {
      input: paths.map((p) => `${p}\0`).join(""),
    });
  }

  /** Sorted, de-duplicated list of paths carrying the skip-worktree bit. */
  async skipWorktreePaths(): Promise<string[]> {
    const entries = await this.lsFiles();
    const set = new Set<string>();
    for (const e of entries) if (e.skipWorktree) set.add(e.path);
    return [...set].sort();
  }

  // status

  /**
   * Porcelain v1, NUL-delimited. `--untracked-files` and `--renames` are forced so the
   * output does not depend on the repo's config.
   */
  async statusPorcelain(
    pathspec?: string[],
    opts?: { untracked?: "no" | "normal" | "all" },
  ): Promise<StatusEntry[]> {
    const untracked = opts?.untracked ?? this.untrackedFiles;
    const base = [
      "status",
      "--porcelain",
      "-z",
      `--untracked-files=${untracked}`,
      "--ignored=no",
      "--renames",
    ];
    const chunks = pathspec && pathspec.length > 0 ? chunkPathspecs(pathspec) : [[]];
    const out: StatusEntry[] = [];
    for (const chunk of chunks) {
      const args = chunk.length > 0 ? [...base, "--", ...chunk] : base;
      const { stdout } = await this.run(args);
      out.push(...parseStatusZ(stdout));
    }
    return out;
  }

  /**
   * No modifications to *tracked* files. Untracked files are deliberately ignored: a repo
   * with stray build output is still "clean" for the purpose of taking ownership.
   */
  async isClean(): Promise<boolean> {
    const entries = await this.statusPorcelain(undefined, { untracked: "no" });
    return entries.length === 0;
  }

  // index mutation

  /** Stages exactly these paths (literal, never globbed). Records deletions too. */
  async addPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      input: paths.map((p) => `${literalPathspec(p)}\0`).join(""),
    });
  }

  /** Drops paths from the index, always leaving the work-tree file alone. */
  async rmCached(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(
      ["rm", "--cached", "--force", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul"],
      { input: paths.map((p) => `${literalPathspec(p)}\0`).join("") },
    );
  }

  /**
   * `update-index --add --cacheinfo <mode>,<oid>,<path>`. Git splits on the first two
   * commas, so a path containing commas is safe.
   */
  async updateIndexCacheinfo(mode: string, oid: string, path: string): Promise<void> {
    await this.run(["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`]);
  }

  /** Commits the current index and returns the new commit OID. */
  async commit(message: string, opts?: { allowEmpty?: boolean }): Promise<string> {
    const args = ["commit", "--quiet", "--cleanup=whitespace", "-F", "-"];
    if (opts?.allowEmpty) args.push("--allow-empty");
    await this.run(args, { input: message });
    const oid = await this.revParse("HEAD");
    if (oid === null) {
      throw new GitError(["commit"], 1, "HEAD did not resolve after commit\n", this.cwd);
    }
    return oid;
  }
}

/** `<tag> SP <mode> SP <oid> SP <stage> TAB <path>` */
function parseLsFilesRecord(rec: string): IndexEntry | null {
  if (rec.length < 4) return null;
  const tag = rec[0]!;
  const tab = rec.indexOf("\t");
  if (tab < 0) return null;
  const head = rec.slice(2, tab).split(" ");
  if (head.length < 3) return null;
  const stage = Number(head[2]);
  return {
    path: rec.slice(tab + 1),
    mode: head[0]!,
    oid: head[1]!,
    stage: Number.isFinite(stage) ? stage : 0,
    // 'S' = skip-worktree; 's' = skip-worktree *and* assume-unchanged.
    skipWorktree: tag === "S" || tag === "s",
  };
}

/**
 * `XY SP <path> NUL` — plus a second `NUL`-terminated field holding the original path when
 * X is `R` or `C`.
 */
export function parseStatusZ(stdout: string): StatusEntry[] {
  const recs = splitNul(stdout);
  const out: StatusEntry[] = [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]!;
    if (rec.length < 3) continue;
    const x = rec[0]!;
    const y = rec[1]!;
    const path = rec.slice(3);
    if ((x === "R" || x === "C") && i + 1 < recs.length) {
      out.push({ x, y, path, origPath: recs[++i]! });
    } else {
      out.push({ x, y, path });
    }
  }
  return out;
}

/* ---------------------------------------------- three-way blob merge */

export interface MergeFileResult {
  content: Uint8Array;
  conflicts: number;
  clean: boolean;
  /**
   * `git merge-file` *refuses* binary input outright — it
   * exits 255 with "Cannot merge binary files" even when two sides are identical. When
   * this is set, `content` is `ours` and the caller must resolve by hand.
   */
  binary: boolean;
}

/** git's own heuristic: a NUL in the first 8000 bytes (xdiff-interface.c). */
const FIRST_FEW_BYTES = 8000;
function looksBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, FIRST_FEW_BYTES);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Three-way merge of three blobs via `git merge-file -p`. Never touches the work-tree.
 *
 * Output is byte-identical to what the user would get from
 * `git merge-file -p -L ours -L base -L theirs ours base theirs`.
 *
 * `conflicts` is `git merge-file`'s exit code, i.e. the number of conflict hunks, which
 * **saturates at 127** (measured: 200 separate conflicts also report 127). Exit codes
 * >= 128 are real failures and raise `GitError`.
 */
export async function mergeBlobs(args: {
  base: Uint8Array;
  ours: Uint8Array;
  theirs: Uint8Array;
  labels: { base: string; ours: string; theirs: string };
  tmpDir: string;
  style?: "merge" | "diff3" | "zdiff3";
}): Promise<MergeFileResult> {
  const { base, ours, theirs, labels, tmpDir, style } = args;

  if (looksBinary(base) || looksBinary(ours) || looksBinary(theirs)) {
    // Resolve the trivial cases ourselves; git would just refuse.
    if (bytesEqual(ours, theirs)) return { content: ours, conflicts: 0, clean: true, binary: true };
    if (bytesEqual(ours, base)) return { content: theirs, conflicts: 0, clean: true, binary: true };
    if (bytesEqual(theirs, base)) return { content: ours, conflicts: 0, clean: true, binary: true };
    return { content: ours, conflicts: 1, clean: false, binary: true };
  }

  await mkdir(tmpDir, { recursive: true });
  const dir = await mkdtemp(join(tmpDir, "overgit-merge-"));
  try {
    const oursPath = join(dir, "ours");
    const basePath = join(dir, "base");
    const theirsPath = join(dir, "theirs");
    await Promise.all([
      writeFile(oursPath, ours),
      writeFile(basePath, base),
      writeFile(theirsPath, theirs),
    ]);

    const argv = ["merge-file", "-p"];
    if (style === "diff3") argv.push("--diff3");
    else if (style === "zdiff3") argv.push("--zdiff3");
    argv.push("-L", labels.ours, "-L", labels.base, "-L", labels.theirs);
    argv.push("--", oursPath, basePath, theirsPath);

    const git = new Git({ cwd: dir });
    const r = await git.runBinary(argv, { allowFailure: true });
    if (r.code >= 128 || r.code < 0) {
      throw new GitError(argv, r.code, r.stderr, dir);
    }
    return {
      content: r.stdout,
      conflicts: r.code,
      clean: r.code === 0,
      binary: false,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
