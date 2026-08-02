# overgit, the full walkthrough

Every command below is copy-pasteable, and the output is what it actually printed. Start in
a clone of any git repository. The [README](../README.md) has the mental model;
[limitations.md](limitations.md) has every caveat in full.

## Quickstart

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
[the limitations](limitations.md)). The remedy is one command on each side —
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
