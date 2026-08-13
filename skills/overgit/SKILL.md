---
name: overgit
description: Layer a private git overlay on top of a repo you don't control, so local edits are versioned and pushable but invisible to the shared repo. Use when the user wants to keep local-only changes to a team/vendor/upstream repo (a changed config, a personal script, a file they want hidden) without committing to it, without a patch queue, and without .gitignore hacks. Triggers include "keep my own changes out of this repo", "local-only edits to a shared checkout", "carry my tweaks to another machine", "overgit", or any base/overlay work-tree question.
---

# overgit

Two git repositories, one working directory. The **base** is the repo the user does not
control (`.git`); the **overlay** is theirs (`.overgit/.git`), sharing the same work-tree and
applying on top. overgit never commits to the base and never lets overlay files show up in
its `git status`.

`overgit --help` is the reference: every command, the three ownership kinds, exit codes.
`overgit help <command>` explains one in full, including the `--porcelain` formats and every
`doctor` problem id. Read those rather than guessing. What follows is only what they do not
tell you.

## Traps

**Edit the file, then `overgit add` it.** `add` stages the current work-tree bytes. Adding
first and editing after leaves the overlay holding the base's version, which looks like it
worked and is not what the user asked for.

**Pass directories, never shell globs.** `overgit add docs` expands recursively including
dotfiles; `overgit add docs/*.md` silently misses `docs/sub/c.md` and `docs/.hidden`. The
glob looks equivalent and is worse than an error, because nothing is reported.

**Never enable `core.sparseCheckout` to work around the `git pull` abort.** It looks like a
fix and is the one change that breaks invisibility: git then *clears* the skip-worktree bit
on every override present in the work-tree, and the next `git add -A` in the base commits the
user's private content into the shared repository. overgit refuses to run mutating commands
while it is on. The correct workaround is `overgit detach`, the git command, `overgit attach`.

**A binary or symlink conflict is a decision, not a conflict.** There are no markers to edit,
so `sync --continue` refuses rather than silently accepting the overlay's bytes and recording
upstream as merged. Answer with `overgit resolve --keep` or `--take-upstream`.

**`overgit commit` refuses while a sync is unfinished.** Finish or `--abort` it first.

## Reading `overgit status`

Three lines mean act now, and plain `git status` cannot produce any of them:

- `the base can see N overlay paths — this is a leak` → invisibility is broken. `doctor --fix`.
- `base upstream N commits behind … not yet pulled` → it names the owned paths those commits
  touch, which are exactly the paths that will make `git pull` abort.
- `upstream moved under N overlay paths` → run `overgit sync`.

When anything else looks wrong, run `overgit doctor` before forming a theory. It names the
path and the exact command, and `--fix` never overwrites bytes without first copying them to
`.overgit/local/backups/` and saying where.

## Recovery

Overlay content is never only in the work-tree: `overgit add` stages it into the overlay repo
immediately. So `git clean -xfd`, `git stash -a`, `git reset --hard` and a clobbering pull are
all undone by `overgit apply`.

Two things that no command can undo:

- `git clean -xffd` (double force) deletes `.overgit/` outright. Recovering a machine needs
  the overlay to have been pushed. Suggest `overgit push` early.
- A filename containing a newline, or ending in a carriage return, cannot be `add`ed at all;
  it is unrepresentable in a gitignore line. Overrides and whiteouts of such files are fine.

Stacking overlays and paths inside a submodule are not supported and are refused by name.
