---
name: overgit
description: Layer a private git overlay on top of a repo you don't control, so local edits are versioned and pushable but invisible to the shared repo. Use when the user wants to keep local-only changes to a team/vendor/upstream repo (a changed config, a personal script, a file they want hidden) without committing to it, without a patch queue, and without .gitignore hacks. Triggers include "keep my own changes out of this repo", "local-only edits to a shared checkout", "carry my tweaks to another machine", "overgit", or any base/overlay work-tree question.
---

# overgit

Two git repositories, one working directory. The **base** is the repo you don't control
(`.git`). The **overlay** is yours (`.overgit/.git`), sharing the same work-tree and applying
*on top of* the base. Like OverlayFS, but both layers are git repos, so the upper one has a
history you can commit, push, and clone onto another machine.

overgit never commits to the base, never touches its remotes, and never lets your files show
up in its `git status`.

## The three powers

| kind | what it means | the base still believes |
|---|---|---|
| **add** | a file the base does not have | the file does not exist |
| **override** | your version of a file the base tracks | its own version is checked out, unmodified |
| **delete** | a file the base tracks, gone from your tree | the file is present and unmodified |

Mechanism, worth knowing because it explains every sharp edge below: an **add** is hidden by
a line in `.git/info/exclude` (never `.gitignore`); an **override** and a **delete** use
`git update-index --skip-worktree`. Exclude only hides *untracked* paths; skip-worktree only
exists for paths *in the index*. Which one applies is decided by the base's **current** state,
not by what the path was when you took it.

## Core workflow

```sh
overgit init --remote <your-overlay-url>   # inside an existing base checkout
edit config/app.toml && overgit add config/app.toml   # override (edit FIRST, then add)
overgit add scripts/dev.sh                 # add (file the base lacks)
overgit rm OLDNOTES.md                     # whiteout
overgit rm docs                            # directories expand recursively
overgit status                             # the merged view
overgit commit -m "my setup" && overgit push -u origin main
```

New machine, one command:

```sh
overgit clone --base <base-url> <overlay-url> <dir>
```

Byte-identical tree including file modes; re-running it is a clean no-op. If the base is
already checked out, drop `--base`.

`add`, `rm` and `restore` all accept directories and expand them recursively, including
nested files and dotfiles. Prefer that over a shell glob — `docs/*.md` silently misses
`docs/sub/c.md` and `docs/.hidden`. Whiting out every file in a directory also removes the
now-empty directory, since git cannot represent one and a fresh clone never has it.

## The thing that will bite first

**`git pull` and `git checkout <branch>` in the base ABORT when upstream touches a file you
override.** This is inherent to skip-worktree, not a bug. The remedy:

```sh
overgit detach     # work-tree becomes a byte-exact pristine base checkout
git pull           # or checkout, stash, rebase — anything
overgit attach     # overlay back on top
overgit sync       # three-way merge upstream's changes into your overrides
```

`overgit hooks install` automates the re-attach after pull/checkout. Your content is safe in
the overlay repo the whole time it's detached.

Do **not** try to fix this with `core.sparseCheckout=true` — git then *clears* the
skip-worktree bit on every override present in the work-tree, leaking all of them. overgit
refuses to run mutating commands while it's enabled.

## sync: merges vs decisions

A clean three-way merge just happens (byte-identical to `git merge-file`). A text conflict
leaves real markers, blocks only that path, and — importantly — the base stays clean *with
markers in the work-tree*. Resolve with `overgit resolve <path>` then `overgit sync --continue`.

Three situations are **decisions**, never auto-resolved. Answer them explicitly:

| situation | options |
|---|---|
| upstream deleted a file you override | `--keep` (becomes an add) · `--drop` |
| upstream added a path you had added | `--adopt` (becomes an override) · `--drop` |
| binary or symlink diverged three ways | `--keep` · `--take-upstream` |

Binary has no markers to edit, so it is a decision by design — `sync --continue` will refuse
rather than silently accept your bytes and discard upstream's.

`overgit sync --abort` restores everything byte-exactly and never advances a fork point.
`overgit commit` refuses while a sync is unfinished (it would commit the markers).

## When something looks wrong

`overgit doctor` first — it names the path and the exact command. `overgit doctor --fix`
repairs what is safely repairable and never overwrites bytes without copying them to
`.overgit/local/backups/` and telling you. `overgit apply` re-materialises the tree from the
overlay; it is idempotent.

Read `overgit status` carefully — it reports things plain `git status` cannot:
- **"the base can see N overlay paths — this is a leak"** → invisibility is broken; `doctor --fix`
- **"base upstream N commits behind … not yet pulled"** → naming owned paths the un-pulled
  commits touch, i.e. the ones that will make `git pull` abort
- **"upstream moved under N overlay paths"** → run `overgit sync`

`overgit which <path>` answers "is this file mine or the base's?" (exit 1 if the overlay
doesn't own it, so it works in scripts).

## Recovery facts

Overlay content is **never** only in the work-tree — `overgit add` stages it into the overlay
repo immediately. So `git clean -xfd`, `git stash -a`, `git reset --hard` and a clobbering
pull are all recoverable with `overgit apply`.

Two exceptions to know:
- **`git clean -xffd`** (double force) deletes `.overgit/` outright. Push your overlay; a
  machine is rebuilt with `overgit clone`.
- A filename containing a **newline**, or ending in a **carriage return**, cannot be `add`ed —
  it is unrepresentable in a gitignore line, so the pattern would degrade to a `?` wildcard
  and could let `git clean` delete an unrelated sibling. overgit refuses instead. Overrides
  and whiteouts of such files are fine.

## Escape hatches

The overlay is an ordinary git repo, so plain git works on it — useful for anything overgit
doesn't wrap:

```sh
git -C .overgit log --oneline     # or: overgit git <any-git-args>
```

Exit codes: `0` ok · `1` error · `2` usage · `3` conflicts/decisions pending · `4` doctor
found problems (or `--dry-run` found drift). An in-progress sync alone does not make doctor
exit 4. `overgit status --porcelain` is NUL-terminated, tab-separated, path last.

Not supported: stacking overlays, and paths inside a submodule (refused by name — they belong
to the submodule's own repo).
