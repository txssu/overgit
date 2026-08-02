# overgit

Layer one git repository on top of another, in a single working directory.

You have a repo you don't control — a team project, a vendor drop, a fork you'd rather not
carry patches against. You want your own tweaks in it: a changed config, a personal script,
a file you'd rather not see. You want those tweaks **versioned, committed, pushed, and
cloned onto your next machine** — without them ever showing up in the shared repo's
`git status`, and without a patch queue to rebase.

overgit gives you a second git repository — the **overlay** — that shares the same working
directory and applies *on top of* the first one — the **base**.

Like OverlayFS, but both layers are git repositories, so the upper one has a history you can
commit, push, and clone.

---

## The mental model

```
    your working directory
    ┌─────────────────────────────────────────┐
    │  overlay   .overgit/.git   ← your repo  │   add · override · delete
    ├─────────────────────────────────────────┤
    │  base      .git            ← their repo │   read-only territory
    └─────────────────────────────────────────┘
```

The hierarchy is strict and one-directional. The overlay applies on top of the base, never
the reverse. overgit **never commits to the base**, never touches its remotes, and never
lets your files leak into it.

The overlay can do exactly three things:

| kind | what it means | the base still believes |
|---|---|---|
| **add** | a file the base does not have | the file does not exist |
| **override** | your version of a file the base tracks | its own version is checked out, unmodified |
| **delete** | a file the base tracks, gone from your tree | the file is present and unmodified |

The overlay is an ordinary git repository living in `.overgit/`, whose work-tree is your
project root. Nothing is hidden from you — plain git works on it:

```console
$ git -C .overgit log --oneline
588d507 take upstream workers setting
9f879a2 my local dev setup
```

---

## Install

Requires [Bun](https://bun.sh) ≥ 1.1 and a system `git` ≥ 2.30. Linux and macOS.

```sh
git clone <this-repo> overgit
cd overgit
bun install
ln -s "$PWD/bin/overgit" ~/.local/bin/overgit   # anywhere on your PATH
```

Verify:

```console
$ overgit --version
overgit 0.1.0
```

---

## Quickstart

Every command below is copy-pasteable, and the output is what it actually printed. Start in
a clone of any git repository.

**Create the overlay.** `--remote` is optional; you can add one later with
`overgit git remote add origin <url>`.

```console
$ overgit init --remote git@example.com:me/my-overlay.git
created an overlay in /home/ada/app/.overgit/.git on branch main

next:
  overgit add <path>            take a file (override it, or add a new one)
  overgit commit -m <message>   record it in the overlay
  overgit push -u origin main   publish it
```

**Override a file the base tracks.** Edit it first, then hand it to the overlay.

```console
$ printf 'host = "127.0.0.1"\nport = 3000\n' > config/app.toml
$ overgit add config/app.toml
took 1 path:
  override  config/app.toml  was tracked by the base

run `overgit commit -m <message>` to record this in the overlay's history
```

**Add a file the base does not have.**

```console
$ mkdir -p scripts && printf '#!/bin/sh\nexec bun run dev\n' > scripts/dev.sh
$ chmod +x scripts/dev.sh
$ overgit add scripts/dev.sh
took 1 path:
  add  scripts/dev.sh  was untracked

run `overgit commit -m <message>` to record this in the overlay's history
```

**Delete a file the base tracks** (a whiteout — the base still thinks it's there).

```console
$ overgit rm OLDNOTES.md
removed 1 path:
  delete  OLDNOTES.md  was tracked by the base
```

**Look at the merged view.**

```console
$ overgit status
base repo   on branch main
overlay     on branch main

overlay owns 3 paths
  delete    OLDNOTES.md
  override  config/app.toml  staged
  add       scripts/dev.sh   staged

base changes   none

doctor   no problems
```

**And now the point of the whole exercise** — the base sees nothing:

```console
$ git status --porcelain
$
```

Empty. Not "ignored", not "stashed" — the base repo genuinely believes it is clean. You can
prove it:

```console
$ git add -A && git commit -m 'this captures nothing of mine'
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
```

**Commit and publish the overlay.** This is ordinary git, on your own repo:

```console
$ overgit commit -m 'my local dev setup'
[main 9f879a2] my local dev setup
 3 files changed, 9 insertions(+), 1 deletion(-)
 create mode 100644 config/app.toml
 create mode 100755 scripts/dev.sh

$ overgit push -u origin main
```

---

## When upstream moves

Someone changes `config/app.toml` upstream — the file you override. Plain `git pull`
**refuses**, and it is right to:

```console
$ git pull
error: Your local changes to the following files would be overwritten by merge:
	config/app.toml
Please commit your changes or stash them before you merge.
Aborting
```

This is inherent to the mechanism, not a bug overgit can paper over (see
[Known limitations](#known-limitations)). The remedy is one command on each side —
**detach, do your git, attach**:

```console
$ overgit detach
detached 3 paths:
  restored  OLDNOTES.md
  restored  config/app.toml
  removed   scripts/dev.sh

the work-tree is now pristine base content — run any git command you like,
then `overgit attach` to mount the overlay again

$ git pull
Updating a2afb9b..0624468
Fast-forward
 config/app.toml | 1 +
 1 file changed, 1 insertion(+)

$ overgit attach
changed 6 paths:
  removed         OLDNOTES.md
  wrote override  config/app.toml    work-tree content differed
  wrote add       scripts/dev.sh     missing from the work-tree
  hid from base   OLDNOTES.md
  hid from base   config/app.toml
  exclude block   .git/info/exclude  regenerated the managed block
```

While detached, the work-tree is a byte-exact pristine base checkout — every git command
behaves normally. Your overlay content is safe in the overlay repository the whole time.

**Then merge upstream's changes into your override.** `overgit sync` does a true three-way
merge, using the blob you forked from as the merge base:

```console
$ overgit sync

1 path conflicted
  config/app.toml
  the work-tree files hold conflict markers. Edit them, then
  `overgit resolve <path>...` and `overgit sync --continue`.
  Shortcuts: `overgit resolve --keep <path>` keeps yours,
             `overgit resolve --take-upstream <path>` takes the base's.

$ cat config/app.toml
<<<<<<< config/app.toml (overlay)
host = "127.0.0.1"
port = 3000
=======
host = "0.0.0.0"
port = 8080
workers = 4
>>>>>>> config/app.toml (upstream 01ada069)
```

A conflict blocks nothing else — every other path still syncs, and `status`, `doctor` and
the rest keep working. **The base stays clean even with conflict markers sitting in the
work-tree.** Resolve it and carry on:

```console
$ printf 'host = "127.0.0.1"\nport = 3000\nworkers = 4\n' > config/app.toml
$ overgit resolve config/app.toml
marked 1 path resolved:
  config/app.toml

the sync is finished

$ overgit commit -m 'take upstream workers setting'
$ overgit push
```

If the merge is clean, `sync` just does it — the result is byte-identical to what
`git merge-file` would produce. `overgit sync --abort` puts everything back exactly as it
was, and never advances a fork point.

Some situations are **decisions**, never auto-resolved:

| situation | what you choose |
|---|---|
| upstream **deleted** a file you override | `--keep` (becomes an add) · `--drop` |
| upstream **added** a file you had added | `--adopt` (becomes an override) · `--drop` |
| a **binary** file diverged three ways | `--keep` · `--take-upstream` |

---

## A new machine

Base and overlay are both just git repositories, so a new machine is one command:

```console
$ overgit clone --base git@example.com:team/app.git git@example.com:me/my-overlay.git app
cloned the base into app
cloned the overlay into app/.overgit/.git
applied 6 paths:
  removed         OLDNOTES.md
  wrote override  config/app.toml    work-tree content differed
  wrote add       scripts/dev.sh     missing from the work-tree
  hid from base   OLDNOTES.md
  hid from base   config/app.toml
  exclude block   .git/info/exclude  regenerated the managed block

the overlay owns 3 paths — run `overgit status` in app
```

The result is byte-identical to the machine you left, file modes included:

```console
$ diff -r --exclude=.git --exclude=.overgit app app2 && echo identical
identical
```

Running it a second time is a no-op, not an error:

```console
$ overgit clone --base git@example.com:team/app.git git@example.com:me/my-overlay.git app
the overlay was already present in app
already up to date (3 paths already correct)

the overlay owns 3 paths — run `overgit status` in app
```

If you already have the base checked out, drop the `--base`:

```sh
overgit clone git@example.com:me/my-overlay.git
```

---

## When things drift

Git in the base can disturb the overlay — `git clean -xfd` removes your added files,
`git stash -a` takes them away, a pull can resurrect a file you whited out. None of it loses
data, because **overlay content is never only in the work-tree**: `overgit add` stages it
into the overlay repository immediately.

`overgit apply` puts everything back. `overgit doctor` explains what is wrong first:

```console
$ overgit doctor
no problems found
```

`doctor` checks the manifest against the overlay's objects, the base's index flags, the
managed exclude block and the work-tree, and reports anything inconsistent with a hint that
names the path and the command to run. `overgit doctor --fix` repairs what is safely
repairable; it never overwrites your bytes without first copying them to
`.overgit/local/backups/` and telling you where.

To have this happen automatically after every pull or checkout:

```sh
overgit hooks install
```

That writes a clearly delimited managed block into the base's `.git/hooks/` (never into its
history), preserving any hook content already there. `overgit hooks uninstall` removes it.

---

## Command reference

| command | what it does |
|---|---|
| `overgit init [--remote <url>] [--branch <name>]` | create an overlay in the current base repo |
| `overgit clone [--base <url>] <overlay-url> [<dir>]` | clone an overlay (and optionally its base); idempotent |
| `overgit add <path>...` | take ownership — override a base file, or add a new one (directories expand) |
| `overgit rm <path>...` | hide a base file (whiteout), or drop a file the overlay added (directories expand) |
| `overgit restore <path>... \| --all` | give paths back to the base (directories expand) |
| `overgit status [--short] [--porcelain]` | the merged view |
| `overgit list [--kind add\|override\|delete]` | what the overlay owns |
| `overgit which <path>...` | say who owns a path (exit 1 if the overlay does not) |
| `overgit diff [<path>...]` | diff the overlay's own content |
| `overgit commit -m <msg>` | record the overlay's current content (refuses mid-sync) |
| `overgit push` / `pull` / `fetch` / `log` | plain git on the overlay (`pull` re-applies afterwards) |
| `overgit sync [--dry-run] [--continue] [--abort]` | merge the base's upstream changes into your overrides |
| `overgit resolve <path>...` | mark resolved, or answer a decision (`--keep`, `--drop`, `--adopt`, `--take-upstream`) |
| `overgit apply` / `overgit attach` | make the work-tree match the overlay |
| `overgit detach` | unmount the overlay; the tree becomes a pristine base checkout |
| `overgit doctor [--fix]` | find and repair inconsistencies |
| `overgit hooks install \| uninstall` | opt-in base hooks that re-apply after pull/checkout |
| `overgit git <args>...` | run any git command against the overlay |

Global options: `-C <dir>`, `-q`/`--quiet`, `--color`/`--no-color`, `-h`/`--help`,
`-V`/`--version`.

Exit codes: `0` ok · `1` error · `2` usage · `3` conflicts or decisions pending ·
`4` `doctor` found problems, or `--dry-run` found drift. An in-progress sync is a state, not
a problem, so it does not by itself make `doctor` exit 4.

### Scripting: `--porcelain`

`overgit status --porcelain` is stable and script-safe: **NUL-terminated records**,
tab-separated fields, **path always last** — so paths containing spaces or tabs stay
unambiguous. Header records come first, then one `file` record per owned path:

```
version           <TAB> 1
base.branch       <TAB> main
base.head         <TAB> <oid>
overlay.branch    <TAB> main
overlay.head      <TAB> <oid>
overlay.upstream  <TAB> origin/main
overlay.ahead     <TAB> 0
overlay.behind    <TAB> 0
detached          <TAB> 0
sync-in-progress  <TAB> 0
problems          <TAB> 0
file <TAB> <kind> <TAB> <staged> <TAB> <dirty> <TAB> <missing> <TAB> <upstream> <TAB> <path>
```

`overgit list --porcelain` emits `<kind>TAB<path>NUL`; `overgit which --porcelain` emits
`<owner>TAB<kind>TAB<path>NUL`. Record names and field order are stable; new fields are only
ever appended. `overgit help status` documents the field values.

### How it works, concretely

* An **add** is listed in the base's `.git/info/exclude` — never `.gitignore`, so nothing
  local ever enters the base's history.
* An **override** and a **delete** set `git update-index --skip-worktree` on the path in the
  base, so the base skips the work-tree entirely and believes its own version is checked out.
* The overlay tracks your content, and `.overgit/manifest.json` records what is owned and
  which base blob each override forked from. The manifest is tracked *by the overlay*, which
  is how a fresh clone reproduces your tree.
* Machine-local state — sync progress, backups, the lock — lives in `.overgit/local/` and is
  never committed anywhere.

---

## Known limitations

These are real. They are listed here rather than discovered later.

**`git pull` and `git checkout` in the base abort when upstream touches a file you
override.** Git refuses to overwrite a `skip-worktree` file whose work-tree content differs.
This is inherent — enabling `core.sparseCheckout` looks like a fix and is a trap, because git
then *clears* the skip-worktree bit on any such file present in the work-tree, which would
leak every override into the base. The remedy is `overgit detach` → your git command →
`overgit attach`, or `overgit hooks install` to automate the reattach.

**`git clean -xffd` deletes your overlay.** `.overgit/` survives ordinary `git clean -xfd`,
because git refuses to clean a directory that is a repository. Double `-f` overrides that,
and it means what it says. Push your overlay to a remote; `overgit clone` restores a machine
from it.

**`git clean -xfd` and `git stash -a` remove overlay-*added* files** elsewhere in the tree,
because they are ignored from the base's point of view. Nothing is lost — `overgit apply`
restores them — but the files do disappear until you do.

**Filenames containing a newline, or ending in a carriage return, cannot be added.** Every
other filename overgit can own gets an exact, anchored `.git/info/exclude` pattern —
including names with spaces (leading, trailing, or in a directory component), `#`, `!`, `*`,
`?`, `[`, `]`, backslashes, tabs and other control bytes. Those two bytes cannot appear in a
gitignore line at all — a newline ends the line, and git strips a trailing CR even when
escaped — so the pattern would degrade to a `?` wildcard and could hide, and eventually let
`git clean` delete, an unrelated sibling file. overgit refuses rather than risk that. This is
a git format limit, not a shortcut. Overrides and whiteouts of such files are unaffected.

**Binary files cannot be three-way merged.** Git refuses if any of the three sides is binary
(its heuristic: a NUL byte in the first 8000 bytes). overgit resolves the trivial cases
silently — if two of the three sides are identical there is nothing to merge — but a genuine
divergence is surfaced as a decision, not a conflicted file, because there are no markers to
put in it.

**Commands that change the work-tree refuse while the base has `core.sparseCheckout`
enabled.** `add`, `rm`, `restore` and `apply` stop with an explanation; the read-only
commands (`status`, `list`, `which`, `doctor`) still run so you can diagnose, and `doctor`
reports it as `base-sparse-checkout`. With sparse checkout on, git *clears* the skip-worktree
bit on any overridden file present in the work-tree, so every override would become a visible
modification and the next `git add -A` would commit your overlay into the shared repository.
`git config --unset core.sparseCheckout` (or `git sparse-checkout disable`), then
`overgit doctor --fix`.

**`overgit hooks install` skips a hook written in another language.** Appending POSIX shell
to a Python or Ruby hook would make it a syntax error, and a failing hook makes *your* git
command exit non-zero. overgit says so and leaves the file alone; add
`overgit apply >/dev/null 2>&1 || true` to it by hand if you want the behaviour.

**One overlay per work-tree.** Stacking overlays is not supported.

**Submodules are not overlaid.** overgit refuses paths inside a submodule rather than
pretending.

**The base's index bits are shared state.** If you set `skip-worktree` on a path yourself,
`doctor` will report it as unowned rather than silently taking it over — and it will never
clear a bit on a path the overlay does not own.

---

## Development

```sh
bun install
bun test          # 426 integration tests; they spawn the real binary against real repos
bun run typecheck
```

The tests build throwaway git repositories in temp directories and drive `bin/overgit` as a
subprocess. There are no mocks: if a test says the base stays clean, a real `git status` said
so. `DESIGN.md` records the internal contract and, more usefully, the **measured** git
behaviour the design rests on — including the experiments that ruled out approaches which
look correct and are not.

## Licence

MIT.
