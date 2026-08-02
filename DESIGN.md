# overgit — internal design contract

**This file is the integration contract between parallel builders. Do not change a
public signature described here without saying so loudly in your final report.**

---

## 1. Mental model

One working directory, two git repositories:

* **base** — an ordinary git repo checked out at `<root>`. Its `.git` is at `<root>/.git`.
  overgit treats it as **read-only territory**: never commits to it, never touches its
  remotes, never writes to `.gitignore`, never leaves overlay content visible to it.
  The only base-side state overgit writes is:
  * `.git/info/exclude` (a clearly delimited managed block), and
  * index bits (`--skip-worktree`) for paths overgit owns, and
  * optionally `.git/hooks/*` (only via explicit `overgit hooks install`).
* **overlay** — a second git repo whose *GIT_DIR* is `<root>/.overgit/.git` and whose
  *work-tree* is `<root>`. It is a completely ordinary repo: it can have any remote,
  and `push`/`pull`/`log` are plain git.

The overlay applies **on top of** the base. Never the reverse.

### The three overlay powers

| kind       | base state                | worktree holds        | base must believe            |
|------------|---------------------------|-----------------------|------------------------------|
| `add`      | path untracked by base    | overlay's file        | path does not exist (ignored)|
| `override` | base tracks path (blob B) | overlay's version     | path present & pristine      |
| `delete`   | base tracks path (blob B) | nothing (file absent) | path present & pristine      |

Mechanism:

* `add` → path listed in the managed block of `.git/info/exclude`, tracked by overlay.
* `override` → `git -C <root> update-index --skip-worktree <path>`, overlay tracks the
  path with the overlay's content.
* `delete` → `git -C <root> update-index --skip-worktree <path>`, file removed from the
  work-tree, path recorded in the manifest as `delete`. The overlay does **not** track a
  file at that path.

### Safety invariant (the one that makes "no data loss" true)

> **Overlay content is never only in the work-tree.**

Every mutating command that takes ownership of content stages it into the overlay index
first (which writes the blob into `.overgit/.git/objects`). Therefore, even if git in the
base clobbers a work-tree file (`git checkout .`, `git stash -a`, a merge that overwrites
an ignored file), `overgit apply` / `overgit doctor --fix` can restore it byte-for-byte.

Base content is likewise always recoverable: `delete` and `override` keep the base blob
in the base object store (and the manifest records the OID we forked from).

Any command that would overwrite work-tree bytes that match *neither* the expected overlay
content *nor* the expected base content must first save them to
`.overgit/local/backups/<counter>-<slug>` and tell the user the path.

---

## 2. On-disk layout

```
<root>/
  .git/                       base repo (untouched except info/exclude + index bits)
  .overgit/                   <- an ORDINARY git repository directory
    .git/                     overlay GIT_DIR (core.bare=false, core.worktree=../..)
    manifest.json             TRACKED BY THE OVERLAY — the portable state
    local/                    never tracked, never in base: machine-local state
      sync-state.json         present only while a sync is in progress
      lock                    advisory lock file
      backups/                rescued bytes
  ...project files...
```

**The overlay is just a git repo living in `.overgit/` whose work-tree is the parent
directory.** That is the whole mental model, and the layout is load-bearing — see §6.6.

* Base `.git/info/exclude` managed block always contains `/.overgit/` plus one line per
  `add` path.
* Overlay `.overgit/.git/info/exclude` contains `/.overgit/.git/` and `/.overgit/local/`.
* Overlay config: `core.worktree=../..` (relative → relocatable), `core.bare=false`,
  `status.showUntrackedFiles=no` (the overlay must never treat the base's files as
  untracked noise).

The overlay is **never** allowed to do a bulk `git checkout` into the work-tree. Files are
materialised only by `applyState()`, one path at a time, with backup-on-surprise.

---

## 3. Manifest format

`<root>/.overgit/manifest.json`, UTF-8, LF, trailing newline, 2-space indent, **keys sorted
byte-wise ascending** so it is stable and merge-friendly.

```json
{
  "version": 1,
  "entries": {
    "docs/legacy.md": { "kind": "delete", "baseBlob": "b6fc4c6…" },
    "scripts/dev.sh": { "kind": "add" },
    "src/config.ts": { "kind": "override", "baseBlob": "8a1f0e2…" }
  }
}
```

* `baseBlob` — the base blob OID this override/whiteout forked from. **This is the merge
  base for `overgit sync`.** 40-hex (or 64-hex for sha256 repos).
* Unknown top-level keys are preserved on rewrite; unknown `version` → hard error with a
  hint to upgrade overgit.
* Paths are repo-relative POSIX, no leading `./`, no trailing `/`, never absolute.

---

## 4. Module map & ownership

Each file has exactly one owning builder. **Do not edit a file you do not own.** If you need
a change in someone else's module, report it; do not patch around it.

| module | owner | exports (contract) |
|---|---|---|
| `src/errors.ts` | lead (frozen) | `OvergitError`, `ErrorCode`, `isOvergitError` |
| `src/git.ts` | P1 | `Git`, `GitError`, `GitResult`, index/status/merge helpers |
| `src/paths.ts` | P1 | path normalisation + safety + gitignore escaping |
| `src/context.ts` | P1 | `Context`, `discover`, `withLock` |
| `src/manifest.ts` | P2 | manifest read/write/validate |
| `src/exclude.ts` | P2 | managed block in `.git/info/exclude` |
| `src/ownership.ts` | P2 | `takeOwnership`, `whiteout`, `restoreToBase`, `applyState` |
| `src/status.ts` | P2 | `computeStatus` (merged view data model) |
| `src/sync.ts` | P3 | plan/run/continue/abort/decide + 3-way merge |
| `src/bootstrap.ts` | P5 | `initOverlay`, `cloneOverlay`, `hooksInstall/Uninstall` |
| `src/doctor.ts` | P6 | `diagnose`, `repair`, `Problem` |
| `src/ui.ts` | P4 | colours, tables, error rendering |
| `src/cli/**` | P4 | arg parsing + command implementations + help |
| `README.md` | P4 | user-facing docs |
| `test/helpers/**` | P7 | fixture + CLI harness |
| `test/*.test.ts` | P7 + everyone | integration tests (each builder adds their own file) |

---

## 5. Public signatures (frozen)

### `src/errors.ts` (already written — read it)

### `src/git.ts`

```ts
export interface GitResult { stdout: string; stderr: string; code: number }
export interface GitBinaryResult { stdout: Uint8Array; stderr: string; code: number }
export interface GitRunOptions {
  cwd?: string
  input?: string | Uint8Array
  allowFailure?: boolean          // default false → throws GitError on non-zero
  env?: Record<string, string>
}
export class GitError extends Error {
  readonly args: string[]; readonly exitCode: number
  readonly stderr: string; readonly cwd: string
}

export interface IndexEntry { path: string; oid: string; mode: string; stage: number; skipWorktree: boolean }
export type StatusCode = string // 2-char XY from porcelain v1
export interface StatusEntry { x: string; y: string; path: string; origPath?: string }

export class Git {
  constructor(opts: { cwd: string; gitDir?: string; workTree?: string })
  readonly cwd: string
  run(args: string[], opts?: GitRunOptions): Promise<GitResult>
  runBinary(args: string[], opts?: GitRunOptions): Promise<GitBinaryResult>

  version(): Promise<{ major: number; minor: number; patch: number; raw: string }>
  revParse(rev: string): Promise<string | null>          // null when unresolvable
  resolveGitDir(): Promise<string>                       // absolute
  toplevel(): Promise<string>                            // absolute work-tree root
  currentBranch(): Promise<string | null>                // null when detached
  headExists(): Promise<boolean>

  isTracked(path: string): Promise<boolean>              // in index, any stage
  headBlobOid(path: string): Promise<string | null>      // HEAD:<path>, null if absent/not a blob
  indexBlobOid(path: string): Promise<string | null>
  fileMode(path: string): Promise<string | null>         // index mode e.g. "100755", "120000"
  lsFiles(pathspec?: string[]): Promise<IndexEntry[]>    // -z, includes skipWorktree flag
  lsTree(rev: string): Promise<IndexEntry[]>             // -r -z
  catFileBlob(oid: string): Promise<Uint8Array>
  blobExists(oid: string): Promise<boolean>
  hashObject(content: Uint8Array, opts?: { write?: boolean; path?: string }): Promise<string>

  setSkipWorktree(paths: string[]): Promise<void>        // no-op on []
  clearSkipWorktree(paths: string[]): Promise<void>
  skipWorktreePaths(): Promise<string[]>

  statusPorcelain(pathspec?: string[]): Promise<StatusEntry[]>  // -z, untracked included
  isClean(): Promise<boolean>

  addPaths(paths: string[]): Promise<void>               // git add -- <paths>
  rmCached(paths: string[]): Promise<void>
  updateIndexCacheinfo(mode, oid, path): Promise<void>   // --add --cacheinfo
  commit(message: string, opts?: { allowEmpty?: boolean }): Promise<string>
}

/** Three-way merge of blobs. Never touches the work-tree. */
export interface MergeFileResult { content: Uint8Array; conflicts: number; clean: boolean }
export function mergeBlobs(args: {
  base: Uint8Array; ours: Uint8Array; theirs: Uint8Array
  labels: { base: string; ours: string; theirs: string }
  tmpDir: string
  style?: "merge" | "diff3" | "zdiff3"
}): Promise<MergeFileResult>
```

Rules for P1:
* **Everything uses `-z`** where git offers it. Paths may contain spaces, quotes, newlines.
* Never use `--porcelain=v2` parsing shortcuts that lose rename info silently.
* All spawns get `GIT_OPTIONAL_LOCKS=0` where read-only, and a sanitised env:
  `GIT_CONFIG_NOSYSTEM` is **not** set (users have legit config), but
  `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `LC_ALL=C`, `GIT_ATTR_NOSYSTEM` unset.
  Force `-c core.quotepath=false`.
* Binary-safe: `catFileBlob` must return exact bytes (no utf-8 round-trip).

### `src/paths.ts`

```ts
/** Normalise a user-supplied path (relative to `cwd`) into a repo-relative POSIX path. */
export function toRepoPath(root: string, cwd: string, input: string): string
/** Throws PATH_FORBIDDEN / PATH_OUTSIDE_WORKTREE. Called by toRepoPath, exported for reuse. */
export function assertSafeRepoPath(repoPath: string): void
/** True for `.git`, `.git/**`, `.overgit`, `.overgit/**` (case-insensitive on the leading segment). */
export function isReservedPath(repoPath: string): boolean
/** Escape a repo-relative path into an anchored gitignore pattern (leading `/`). */
export function gitignoreEscape(repoPath: string): string
export function isPathInside(parentAbs: string, childAbs: string): boolean
```

Rules: reject `..` escape after normalisation; reject absolute paths outside root; resolve
symlinked *ancestors* and reject if the real path escapes root; do **not** deref a symlink
that is itself the target (symlinks are legitimate overlay content).

### `src/context.ts`

```ts
export interface Context {
  root: string           // realpath of base work-tree root
  cwd: string            // realpath of the invocation cwd
  baseGitDir: string     // absolute, resolved (handles `.git` file / worktrees)
  overgitDir: string     // <root>/.overgit
  overlayGitDir: string  // <root>/.overgit/.git
  localDir: string       // <root>/.overgit/local
  manifestPath: string   // <root>/.overgit/manifest.json
  base: Git
  overlay: Git
  hasOverlay: boolean
}
export function discover(cwd: string, opts?: { requireOverlay?: boolean }): Promise<Context>
export function withLock<T>(ctx: Context, fn: () => Promise<T>): Promise<T>
```

`discover` walks up from `cwd` for the base root. `requireOverlay: true` throws `NO_OVERLAY`
with hint `run \`overgit init\` …`. Refuses to run when `cwd` is inside `.git/`.
`withLock` creates `local/lock` with `O_EXCL`, stores pid, removes in `finally`; a stale
lock (pid gone) is broken with a warning. Throws `LOCKED` otherwise.

### `src/manifest.ts`

```ts
export type Entry =
  | { kind: "add" }
  | { kind: "override"; baseBlob: string }
  | { kind: "delete"; baseBlob: string }
export interface Manifest { version: 1; entries: Record<string, Entry>; [k: string]: unknown }

export function emptyManifest(): Manifest
export function serializeManifest(m: Manifest): string     // sorted, deterministic
export function parseManifest(text: string, srcPath: string): Manifest
export function readManifest(ctx: Context): Promise<Manifest>
export function writeManifest(ctx: Context, m: Manifest): Promise<void>  // atomic rename
export function ownedPaths(m: Manifest): string[]          // sorted
export function pathsOfKind(m: Manifest, kind: Entry["kind"]): string[]
export function entryOf(m: Manifest, p: string): Entry | undefined
```

### `src/exclude.ts`

```ts
export function desiredExcludeLines(m: Manifest): string[]
export function syncExcludeBlock(ctx: Context, m: Manifest): Promise<{ changed: boolean }>
export function currentExcludeBlock(ctx: Context): Promise<string[] | null>
export function removeExcludeBlock(ctx: Context): Promise<void>
export function ensureOverlayExcludes(ctx: Context): Promise<void>
```

Managed block markers (exact strings, frozen):

```
# >>> overgit managed block — do not edit (regenerate with `overgit doctor --fix`) >>>
…lines…
# <<< overgit managed block <<<
```

Content outside the block is preserved byte-for-byte. Writes are atomic. If the file has no
trailing newline before the block, one is added.

### `src/ownership.ts`

```ts
export interface OwnershipChange { path: string; from: "base" | "untracked" | "absent"; to: Entry["kind"] }
export interface OwnershipResult { changes: OwnershipChange[]; skipped: { path: string; reason: string }[] }

export function takeOwnership(ctx, paths: string[], opts?: { force?: boolean }): Promise<OwnershipResult>
export function whiteout(ctx, paths: string[], opts?: { force?: boolean }): Promise<OwnershipResult>
export function restoreToBase(ctx, paths: string[], opts?: { force?: boolean; keepFile?: boolean }): Promise<OwnershipResult>

export interface ApplyAction {
  path: string
  action: "write-override" | "write-add" | "remove-whiteout" | "set-skip" | "clear-skip"
         | "exclude" | "backup" | "noop"
  detail?: string
}
export interface ApplyReport { actions: ApplyAction[]; changed: boolean; backups: string[] }
export function applyState(ctx, opts?: { dryRun?: boolean; force?: boolean }): Promise<ApplyReport>
```

`applyState` is the idempotent reconciler and the heart of bootstrap + self-repair:

1. read manifest (+ overlay index/HEAD),
2. for every `add`/`override`: materialise the overlay's content (index entry preferred,
   else HEAD) into the work-tree **only if the bytes differ**; if the current bytes match
   neither overlay content nor (for overrides) the base blob, back up first,
3. for every `delete`: remove the file if present (backing it up if its bytes differ from
   the recorded `baseBlob`),
4. set skip-worktree on all `override`+`delete` paths that the base actually tracks,
5. regenerate the exclude block,
6. report every action. `changed === actions.some(a => a.action !== "noop")`.

**Second consecutive run must produce `changed === false` and zero non-noop actions.**
File modes (exec bit, symlinks) are honoured from the overlay index mode.

### `src/status.ts`

```ts
export interface OverlayFileStatus {
  path: string
  kind: Entry["kind"]
  staged: boolean          // differs between overlay HEAD and overlay index
  worktreeDirty: boolean   // differs between overlay index and work-tree
  missing: boolean         // expected in work-tree but absent
  upstream: "same" | "changed" | "deleted" | "added" | "unknown"  // base vs recorded baseBlob
}
export interface MergedStatus {
  base: { branch: string | null; head: string | null; entries: StatusEntry[] }
  overlay: { branch: string | null; head: string | null; upstream: string | null; ahead: number; behind: number }
  files: OverlayFileStatus[]
  syncPending: string[]        // paths where upstream !== "same"
  syncInProgress: boolean
  problems: number             // doctor problem count (cheap subset is fine)
}
export function computeStatus(ctx: Context): Promise<MergedStatus>
```

`base.entries` must **exclude** anything overgit owns (that's the point — a merged view,
not a `git status` proxy).

### `src/sync.ts`

```ts
export type Situation =
  | "up-to-date"
  | "clean-merge"          // override, upstream moved, 3-way merges cleanly
  | "conflict"             // override, upstream moved, 3-way conflicts
  | "upstream-deleted"     // override or delete: base no longer tracks the path → DECISION
  | "add-collision"        // add: base now tracks the path → DECISION
  | "whiteout-upstream-changed"   // delete: base content moved; informational, auto-advance
  | "local-missing"        // overlay content missing from work-tree; sync refuses

export interface PlanItem { path: string; kind: Entry["kind"]; situation: Situation
  fromBlob: string | null; toBlob: string | null }
export interface SyncPlan { items: PlanItem[]; needsDecision: PlanItem[]; clean: PlanItem[]; conflicts: PlanItem[] }

export function planSync(ctx: Context): Promise<SyncPlan>

export interface SyncOptions { dryRun?: boolean; only?: string[]; style?: "merge"|"diff3"|"zdiff3" }
export interface SyncReport { merged: string[]; conflicted: string[]; pendingDecision: PlanItem[]; unchanged: string[] }
export function runSync(ctx, opts?: SyncOptions): Promise<SyncReport>
export function continueSync(ctx): Promise<SyncReport>
export function abortSync(ctx): Promise<void>
export type Decision = "keep" | "drop" | "adopt" | "take-upstream" | "keep-whiteout"
export function decide(ctx, path: string, d: Decision): Promise<void>
export function markResolved(ctx, paths: string[]): Promise<void>
export interface SyncState { startedAt: string; conflicts: Record<string, {toBlob: string; fromBlob: string}>
  decisions: PlanItem[]; merged: string[] }
export function readSyncState(ctx): Promise<SyncState | null>
```

Merge honesty rules (critics will check these exactly):

* clean merge output must be **byte-identical** to `git merge-file -p ours base theirs`,
* conflicts get real conflict markers and the work-tree file is left conflicted, but
  **nothing else is blocked**: other paths still sync, `overgit status`/`doctor` still run,
* `baseBlob` is advanced only when a path is fully resolved (clean merge, or explicit
  `markResolved` / `sync --continue`),
* `upstream-deleted` and `add-collision` are **never** auto-resolved,
* `abortSync` restores every file it touched to the pre-sync bytes and leaves `baseBlob`
  untouched.

Decisions:
* `keep` (upstream deleted an overridden file) → entry becomes `add`, content preserved.
* `drop` → overlay stops owning the path entirely.
* `adopt` (base now tracks a path the overlay added) → entry becomes `override` with
  `baseBlob` = the new upstream blob; a 3-way merge against an empty base is attempted and
  may produce a conflict.
* `take-upstream` → discard overlay content for that path, restore base's (backs up first).
* `keep-whiteout` → whiteout survives; `baseBlob` advanced to the new upstream blob.

### `src/bootstrap.ts`

```ts
export function initOverlay(cwd: string, opts: { remote?: string; branch?: string }): Promise<{ ctx: Context; created: boolean }>
export function cloneOverlay(opts: {
  overlayUrl: string; baseUrl?: string; dir?: string; cwd: string; branch?: string
}): Promise<{ ctx: Context; apply: ApplyReport; alreadyPresent: boolean }>
export function hooksInstall(ctx: Context): Promise<string[]>
export function hooksUninstall(ctx: Context): Promise<string[]>
```

* `initOverlay` is idempotent-ish: on an existing overlay it throws `OVERLAY_EXISTS` with a
  hint pointing at `overgit apply`.
* `cloneOverlay` **must be safely re-runnable**: if `.overgit/.git` already exists and its
  `origin` matches `overlayUrl`, it does not re-clone — it just runs `applyState` and sets
  `alreadyPresent: true`. Running the documented bootstrap twice must be a no-op.
* Clone uses `--no-checkout` into `.overgit/.git`, sets `core.worktree=../..`,
  `status.showUntrackedFiles=no`, writes the overlay excludes, `read-tree HEAD` to populate
  the index **without touching the work-tree**, then hands over to `applyState`.
* Hooks are managed blocks in `post-merge`, `post-checkout`, `post-rewrite`; existing hook
  content is preserved; uninstall removes only the managed block.

### `src/doctor.ts`

```ts
export interface Problem {
  id: string                 // stable kebab id, e.g. "missing-skip-worktree"
  severity: "error" | "warning"
  path?: string
  message: string            // states the observed fact
  hint: string               // actionable, names the path and the command
  fixable: boolean
}
export function diagnose(ctx: Context): Promise<Problem[]>
export function repair(ctx: Context, problems: Problem[]): Promise<{ fixed: Problem[]; remaining: Problem[]; backups: string[] }>
```

Minimum check set (ids frozen so tests can assert them):
`no-overlay-head`, `manifest-unreadable`, `orphan-manifest-entry` (entry with no overlay
blob), `orphan-overlay-file` (overlay tracks a path with no manifest entry),
`missing-skip-worktree`, `stray-skip-worktree` (set on a path overgit does not own),
`missing-exclude-line`, `stale-exclude-line`, `worktree-content-drift` (override/add bytes
≠ overlay), `whiteout-resurrected` (whiteout path exists in work-tree),
`base-blob-missing`, `upstream-gone` (manifest says base tracks it, base doesn't),
`add-now-tracked-by-base` (collision), `sync-in-progress`, `overlay-config-broken`,
`gitignore-pollution` (overgit paths found in a tracked `.gitignore`),
`case-collision`, `interrupted-lock`.

`repair` must be safe to run repeatedly and must never delete user bytes without a backup.

### `src/ui.ts` + `src/cli/**`

```
overgit init [--remote <url>] [--branch <name>]
overgit clone <overlay-url> [--base <url>] [<dir>] [--branch <name>]
overgit add <path>...            take ownership (add or override)
overgit rm <path>...             whiteout a base file / drop an overlay-added file
overgit restore <path>... | --all   give paths back to the base
overgit status [--short] [--porcelain]
overgit diff [<path>...]
overgit list [--kind add|override|delete] [--porcelain]
overgit commit -m <msg> [--amend] [--no-all]
overgit push [args...] / overgit pull [args...] / overgit log [args...] / overgit fetch
overgit sync [--dry-run] [--continue] [--abort] [--style diff3]
overgit resolve <path>... | --keep/--drop/--adopt/--take-upstream <path>
overgit apply [--dry-run]
overgit doctor [--fix] [--porcelain]
overgit hooks install|uninstall
overgit git <args...>            escape hatch: run git against the overlay
overgit help [<command>] / --version
```

Exit codes (frozen): `0` ok · `1` error · `2` usage · `3` conflicts/decisions pending ·
`4` `doctor` found problems (without `--fix`) or `--dry-run` found drift.

Error rendering (frozen shape):

```
error: <one line, names the offending path>
  hint: <what to run / what to do>
```

Colour only when `stdout.isTTY` and `NO_COLOR` unset and `--no-color` absent.

`overgit pull` = overlay pull **followed by** `applyState` (and a warning if it changed
things). `overgit push` is plain passthrough.

---

## 6. Testing contract (P7 owns the harness)

`test/helpers/harness.ts`:

```ts
export interface Sandbox {
  dir: string                       // temp root, auto-cleaned
  path(...p: string[]): string
  mkBaseRepo(name: string, files?: Record<string,string>): Promise<Repo>
  cleanup(): Promise<void>
}
export interface Repo { dir: string; git(...args: string[]): Promise<CmdResult>
  write(p: string, c: string): Promise<void>; read(p: string): Promise<string>
  exists(p: string): Promise<boolean>; commit(msg: string): Promise<string> }
export interface CmdResult { stdout: string; stderr: string; code: number }
export function makeSandbox(label: string): Promise<Sandbox>
/** Spawns the real CLI (bin/overgit) — never imports the modules under test. */
export function overgit(cwd: string, ...args: string[]): Promise<CmdResult>
export function expectOk(r: CmdResult): CmdResult
/** Asserts base invisibility: status empty, diff empty, `add -A` captures nothing. */
export function assertBaseClean(repoDir: string): Promise<void>
/** Recursive byte-level tree snapshot excluding .git and .overgit/{repo,local}. */
export function snapshotTree(dir: string): Promise<Map<string, string>>  // path → sha256
```

Tests **must** spawn `bin/overgit` — no importing `src/*` for behavioural assertions.
Git identity is forced per-repo (`user.name`, `user.email`, `commit.gpgsign=false`,
`init.defaultBranch=main`) so tests are hermetic on any machine.

---

## 6.5 Empirical git behaviour (measured on git 2.55; do not re-litigate, do re-test)

This matrix was measured against real repos. It is the ground truth the whole design rests
on. Base = a clone with `C.txt` overridden (skip-worktree, worktree holds overlay bytes),
`D.txt` whited out (skip-worktree, file removed), `A.txt` overlay-added (listed in
`.git/info/exclude`).

| base operation | outcome |
|---|---|
| `git status` / `git diff` | clean — nothing leaks |
| `git add -A && git commit` | captures nothing overlay-owned |
| `git commit -am` | captures nothing |
| `git add C.txt` (explicit) | refused ("sparsity rules"), index untouched |
| `git checkout -- .` | overlay bytes **survive** |
| `git reset --hard` | overlay bytes **survive**, flags survive |
| `git stash` / `git stash pop` | override + whiteout survive; `stash -a` removes `A.txt`, `pop` restores it |
| `git clean -xfd` | **removes `A.txt`** (it is ignored) → restore from overlay |
| `git pull`, upstream touched neither | clean, no drift |
| `git pull`, upstream changed `D.txt` (whiteout) | **succeeds and resurrects `D.txt` in the work-tree** → drift |
| `git pull`, upstream added `A.txt` | **succeeds and overwrites the overlay's `A.txt`** with upstream bytes → drift + `add-collision` |
| `git pull`, upstream changed or deleted `C.txt` | **aborts**: "Your local changes … would be overwritten by merge" |
| `git checkout <branch>` where `C.txt` differs | **aborts** the same way |

Consequences, frozen:

1. **Never set `core.sparseCheckout=true` in the base.** It looks like it would make pulls
   honour skip-worktree, but git then *clears* the skip-worktree bit on any such file that
   exists in the work-tree, which instantly leaks every override. Measured, not guessed.
   **A user may already have it on**, which is a total, silent invisibility failure — so
   every mutator calls `assertNoSparseCheckout()` and refuses, and `doctor` reports
   `base-sparse-checkout` *alone* and short-circuits (otherwise it would emit one
   `missing-skip-worktree` per override, call each fixable, and `--fix` would set bits that
   git clears again on the next `git status` — an infinite loop that never names the cause).
   Refusing beats warning here: a warning scrolls away and the leak is permanent.
2. Drift is real but always *recoverable*, because overlay content lives in the overlay
   repo. `overgit apply` and `overgit doctor --fix` must repair every row above.
3. When git aborts (upstream touched an overridden file), the user needs an escape. That is
   `overgit detach` → run any base git command → `overgit attach`. Detach makes the work-tree
   a byte-exact pristine base checkout; attach re-applies the overlay. This limitation is
   inherent to skip-worktree and **must be documented honestly in the README**.

## 6.6 Why `.overgit/.git` (measured — this layout is load-bearing)

`git clean -xfd` in the base removes **ignored directories wholesale**, and `/.overgit/` is
ignored. Measured on git 2.55, with the overlay GIT_DIR as a raw directory at
`.overgit/repo`:

```
$ git clean -xfd -n
Would remove .overgit/
```

That destroys the overlay repository, the manifest and every backup. If the overlay has not
been pushed, **the user's work is gone**. It is the one drift row that would not be
recoverable, so it is not acceptable.

`git clean` skips a directory that is a git repository, and its test
(`is_nonbare_repository_dir`) looks for `<dir>/.git`. Measured outcomes:

| overlay GIT_DIR at | `git clean -xfd -n` | survives `-xfd` | survives `-xffd` |
|---|---|---|---|
| `.overgit/repo` (raw gitdir) | `Would remove .overgit/` | **no — total loss** | no |
| `.overgit/.git` (**chosen**) | *(prints nothing)* | **yes, everything** | no |

The governing rule, measured precisely:

> `git clean -xfd` skips `<dir>` **iff `<dir>/.git` resolves to a real repository.**

A gitfile *does* satisfy that rule, as long as its target genuinely exists:

| `.overgit/.git` is… | `git clean -xfd -n` |
|---|---|
| a real gitdir (**chosen**) | *(nothing — survives)* |
| a gitfile → a real raw gitdir | *(nothing — survives)* |
| a gitfile → a missing target | `Would remove .overgit/` |
| garbage, or an empty `.git/` dir | `Would remove .overgit/` |
| absent | `Would remove .overgit/` |

An earlier draft of this section claimed a gitfile "does not work". **That was wrong.** The
probe behind that claim created its target with `git init .overgit/repo`, which puts the
gitdir at `.overgit/repo/.git` — so the gitfile pointed at a work-tree, not a gitdir, and git
rejected it for a reason that had nothing to do with gitfiles. Two builders independently
measured the opposite and were correct. The lesson worth keeping: verify the *target* is a
gitdir before concluding anything about gitfiles, and re-measure a surprising result before
writing it into a contract other people build against.

We still choose the plain real gitdir at `.overgit/.git`: no indirection, one fewer thing to
corrupt, and `git -C .overgit <cmd>` works. But `doctor` must accept a valid gitfile as
healthy, and must treat a **dangling** gitfile as `clean-unprotected` — that is the shape
that silently loses everything.

So the overlay GIT_DIR is `<root>/.overgit/.git`, with `core.worktree=../..`. Consequences:

* `git clean -xfd` is a complete no-op for `.overgit/` — repo, manifest and `local/`
  (including backups) all survive.
* `git clean -xffd` still removes it. That is correct: double-force means the user meant it,
  and the README must say so next to the other limitations.
* `git -C .overgit log` / `status` just work, which makes the tool inspectable with plain git.
* Base invisibility is unaffected — `git status --porcelain` stays empty (measured).
* **Discovery hazard:** running git inside `<root>/.overgit/` resolves to the *overlay*, not
  the base (its `core.worktree` is `<root>`). `discover()` must detect that the repo it found
  is the overlay and keep looking for / resolve to the base, and must still refuse when cwd is
  inside a git dir.

## 6.7 Measured limits: gitignore representability and binary merges

**Filename exactness.** Every filename overgit can own gets an exact, anchored
`.git/info/exclude` pattern — spaces (leading, trailing, or inside a directory component),
`#`, `!`, `*`, `?`, `[`, `]`, backslash, tab, and other control bytes are all representable
and were verified with decoy siblings (the pattern must ignore the owned file and *not*
swallow a near-identical neighbour). Exactly two classes are **approximate**, because the
byte cannot appear in a gitignore line at all — a newline ends the line, and git strips a
trailing CR even when escaped:

| name | pattern | also hides |
|---|---|---|
| contains a newline | `/nl?name.txt` | `nlXname.txt` |
| ends with CR | `/endcr?` | `endcrX` |

`gitignorePatternIsApproximate()` reports these. The README must say so plainly; it is a
git format limit, not an overgit shortcut.

**Binary merges.** `git merge-file -p` on binary input: exit **255** always (never a
conflict count), stdout **0 bytes** always (all three inputs are validated before anything
is emitted, so never partial), stderr exactly `error: Cannot merge binary files: <path>`.
That `<path>` is the *temp* file name, so it is useless to a user — **never surface it**;
render the repo path from the manifest. Refusal triggers if **any** of the three sides is
binary, including a binary base with text ours/theirs. Git's heuristic is a NUL byte in the
**first 8000 bytes only** — a NUL at byte 9000 merges as ordinary text with markers — so
"is binary" is not "contains a NUL"; never write a detector that disagrees with git.

`mergeBlobs` deliberately improves on raw git by resolving trivial cases first:

* `binary: true, clean: true` — two sides agreed (ours==theirs, ours==base, or
  theirs==base). `content` is correct; nothing to ask the user. Raw git refuses even here.
* `binary: true, clean: false` — genuine divergence. `content` is `ours` verbatim,
  `conflicts` is 1 by convention, and there are **no conflict markers**. `sync` must treat
  this as a **decision**, never as a conflicted file — writing marker-free bytes and letting
  `sync --continue` accept them silently would be a data-loss bug.

### Additional commands implied by the above

```
overgit detach [--force]   unmount the overlay: restore base-pristine bytes, clear
                           skip-worktree bits, drop the exclude block, remove overlay-added
                           files. Overlay content is staged into the overlay index first so
                           nothing can be lost. Records `.overgit/local/detached` marker.
overgit attach             alias of `overgit apply` (mount the overlay again)
```

`overgit status` and `overgit doctor` must recognise the detached state and say so, and
must recognise "git pull will be blocked by N override(s)" and name the paths.

---

## 6.8 What the adversarial critic round changed (all measured)

Five fresh-context critics attacked the finished tool. Four returned FAIL. The findings that
changed the design, and why they are easy to get wrong:

**Hide by the base's *current* state, never by the manifest's kind.** Three critics found the
same leak from three directions. `.git/info/exclude` only hides *untracked* paths;
skip-worktree only exists for paths *in the index*. Upstream moves underneath us: an `add`
whose path the base starts tracking loses its exclude line's effect, and an `override` whose
path the base stops tracking loses its skip-worktree bit with the index entry. Either way the
overlay's private bytes become visible and the next `git add -A` commits them upstream. The
rule is now: **every owned path the base tracks gets skip-worktree; every owned path it does
not track gets an exclude line** — recomputed on every `applyState`. `sync` still surfaces
both as decisions; hiding is not deciding.

**Binary/symlink divergence is a `binary-conflict` decision, not a `conflict`.** There are no
markers to write into a PNG or a symlink target, so a marker-based flow has no trustworthy
"I resolved it" signal: `sync --continue` staged the untouched overlay bytes and advanced the
fork point, discarding upstream's revision while recording it as merged. Only `--keep` and
`--take-upstream` are offered, and both advance `baseBlob` so the decision is not re-asked.

**A missing manifest is not an empty overlay.** `readManifest` returns an empty manifest for
a nonexistent file. `doctor` therefore concluded the overlay owned nothing and reported its
*own* paths as `stray-skip-worktree`, hinting `--no-skip-worktree` — advice that un-hides the
overrides. New `manifest-missing` id, and `rebuildManifest` now reads
`HEAD:.overgit/manifest.json` first: the manifest is tracked *by the overlay*, so its history
holds a correct copy including the `delete` entries, which cannot be inferred from the index
at all (a whiteout has no overlay file).

**`detach` writes its marker before it mutates anything.** Written last, a kill mid-detach
left a markerless half-detached tree, so the next `detach` staged the *base's* restored bytes
over the overlay's index entry. Belt-and-braces: step 1 also refuses to stage bytes that are
the base's pristine content when the overlay's differ.

**`detach` restores with `git checkout -- <path>`, not a raw blob write.** With
`core.autocrlf=true` the work-tree should hold CRLF while the blob holds LF, so a raw write
left the base dirty and `git pull` aborted — making the *only* documented remedy unusable for
exactly the people who need it. Note `git checkout-index` writes the right bytes but leaves
the index's cached stat describing the old file, so `git status` reports ` M <path>` while
`git diff` is empty. Measured; use `git checkout`.

**Smaller, same theme — the tool must not undermine itself.** `overgit commit` refuses mid-
sync (it re-staged from the work-tree, so markers reached the overlay's history and `--abort`
could not un-commit them). `hooks install` refuses a non-POSIX-shell hook rather than
appending `sh` to it and making the user's `git checkout` exit non-zero. `doctor` no longer
requires a healthy overlay — `clean-unprotected` fires precisely when the overlay looks
wrong, so gating on it made the check unreachable. A *valid gitfile* at `.overgit/.git` is a
healthy overlay (§6.6); only a dangling one is `clean-unprotected`. And `status` reports
`visibleToBase` separately: subtracting owned paths is what makes it a merged view, but a
leak is *always* at an owned path, so the subtraction was hiding the one thing that matters.

---

## 7. Hard constraints (non-negotiable)

* TypeScript + Bun; shell out to system `git`; **no isomorphic-git**, no libgit2.
* Prefer plumbing where correctness depends on it: `merge-file`, `update-index
  --skip-worktree`, `cat-file`, `ls-files -z`, `hash-object`, `read-tree`, `checkout-index`.
* Local, machine-specific state never enters the base's history: `.git/info/exclude` only,
  **never** `.gitignore`.
* Refuse any path under `.git/` or `.overgit/`, or escaping the work-tree.
* Linux + macOS. Assume case-insensitive FS is possible; assume no GNU-only flags.
* No network in tests. No global git config mutation.
