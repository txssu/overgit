# Known limitations, in full

They are real, and listed here rather than discovered later. The table is the index; each
row is explained in full below.

| limitation | why | remedy |
|---|---|---|
| `git pull` / `git checkout` in the base abort when upstream touches a file you override | git refuses to overwrite a differing `skip-worktree` file | `overgit detach` → git → `overgit attach`, or `overgit hooks install` |
| `git clean -xffd` (double `-f`) deletes `.overgit/` | double `-f` cleans even directories that are repositories | keep the overlay pushed; `overgit clone` restores it |
| `git clean -xfd` and `git stash -a` remove overlay-**added** files | added files are ignored from the base's point of view | `overgit apply` puts them back |
| filenames containing a newline, or ending in CR, cannot be **added** | not representable as an exact gitignore pattern | none — a git format limit; overrides and whiteouts unaffected |
| binary files cannot be three-way merged | git refuses when any of the three sides is binary | surfaced as a decision: `--keep` / `--take-upstream` |
| work-tree commands refuse while the base has `core.sparseCheckout` | git would clear the `skip-worktree` bits and leak every override | disable sparse checkout, then `overgit doctor --fix` |
| `overgit hooks install` skips hooks written in another language | appending shell to a Python hook would break it | add `overgit apply \|\| true` to it by hand |
| one overlay per work-tree | stacking is not supported | — |
| submodules are not overlaid | overgit refuses paths inside a submodule | — |
| the base's index bits are shared state | a `skip-worktree` bit you set yourself is reported as unowned, never adopted | — |

## `git pull` and `git checkout` in the base abort when upstream touches a file you override

Git refuses to overwrite a `skip-worktree` file whose work-tree content differs. This is
inherent — enabling `core.sparseCheckout` looks like a fix and is a trap, because git then
*clears* the skip-worktree bit on any such file present in the work-tree, which would leak
every override into the base. The remedy is `overgit detach` → your git command →
`overgit attach`, or `overgit hooks install` to automate the reattach.

## `git clean -xffd` deletes your overlay

`.overgit/` survives ordinary `git clean -xfd`, because git refuses to clean a directory
that is a repository. Double `-f` overrides that, and it means what it says. Push your
overlay to a remote; `overgit clone` restores a machine from it.

## `git clean -xfd` and `git stash -a` remove overlay-*added* files

They remove them elsewhere in the tree, because those files are ignored from the base's
point of view. Nothing is lost — `overgit apply` restores them — but the files do disappear
until you do.

## Filenames containing a newline, or ending in a carriage return, cannot be added

Every other filename overgit can own gets an exact, anchored `.git/info/exclude` pattern —
including names with spaces (leading, trailing, or in a directory component), `#`, `!`, `*`,
`?`, `[`, `]`, backslashes, tabs and other control bytes. Those two bytes cannot appear in a
gitignore line at all — a newline ends the line, and git strips a trailing CR even when
escaped — so the pattern would degrade to a `?` wildcard and could hide, and eventually let
`git clean` delete, an unrelated sibling file. overgit refuses rather than risk that. This is
a git format limit, not a shortcut. Overrides and whiteouts of such files are unaffected.

## Binary files cannot be three-way merged

Git refuses if any of the three sides is binary (its heuristic: a NUL byte in the first
8000 bytes). overgit resolves the trivial cases silently — if two of the three sides are
identical there is nothing to merge — but a genuine divergence is surfaced as a decision,
not a conflicted file, because there are no markers to put in it.

## Commands that change the work-tree refuse while the base has `core.sparseCheckout` enabled

`add`, `rm`, `restore` and `apply` stop with an explanation; the read-only commands
(`status`, `list`, `which`, `doctor`) still run so you can diagnose, and `doctor` reports it
as `base-sparse-checkout`. With sparse checkout on, git *clears* the skip-worktree bit on
any overridden file present in the work-tree, so every override would become a visible
modification and the next `git add -A` would commit your overlay into the shared repository.
`git config --unset core.sparseCheckout` (or `git sparse-checkout disable`), then
`overgit doctor --fix`.

## `overgit hooks install` skips a hook written in another language

Appending POSIX shell to a Python or Ruby hook would make it a syntax error, and a failing
hook makes *your* git command exit non-zero. overgit says so and leaves the file alone; add
`overgit apply >/dev/null 2>&1 || true` to it by hand if you want the behaviour.

## One overlay per work-tree

Stacking overlays is not supported.

## Submodules are not overlaid

overgit refuses paths inside a submodule rather than pretending.

## The base's index bits are shared state

If you set `skip-worktree` on a path yourself, `doctor` will report it as unowned rather
than silently taking it over — and it will never clear a bit on a path the overlay does not
own.
