# overgit

Layer one git repository on top of another, in a single working directory.

You have a repo you don't control: a team project, a vendor drop, a fork you'd rather not
carry patches against. overgit gives you a second git repository, the overlay. It shares
that working directory and applies on top of the first one, the base. Your tweaks get
committed, pushed and cloned onto the next machine, and the base's `git status` never sees
them.

```
    your working directory
    ┌─────────────────────────────────────────┐
    │  overlay   .overgit/.git   ← your repo  │   add · override · delete
    ├─────────────────────────────────────────┤
    │  base      .git            ← their repo │
    └─────────────────────────────────────────┘
```

The overlay is an ordinary git repository in `.overgit/`, with your project root as its
work-tree. Plain git works on it: `git -C .overgit log`.

## Install

Needs a system `git` ≥ 2.30. Linux and macOS.

A standalone binary, nothing else required. Pick `linux-x64`, `linux-arm64`, `darwin-x64` or
`darwin-arm64` from the [releases page](https://github.com/txssu/overgit/releases):

```sh
curl -fsSL https://github.com/txssu/overgit/releases/latest/download/overgit-linux-x64 -o overgit
install -m 755 overgit ~/.local/bin/
```

Or from npm, which needs [Bun](https://bun.sh) ≥ 1.1 at run time:

```sh
bun install -g overgit    # or: npm install -g overgit
```

Or from source:

```sh
git clone https://github.com/txssu/overgit.git
cd overgit
bun install
bun link          # puts overgit in ~/.bun/bin
```

## Usage

In a clone of any git repository:

```console
$ overgit init --remote git@example.com:me/my-overlay.git
$ overgit hooks install          # put the overlay back after every pull or checkout

$ overgit add config/app.toml    # override: the base tracks it, you changed it
$ overgit add scripts/dev.sh     # add: the base has never heard of it
$ overgit rm OLDNOTES.md         # delete: gone for you, still there for the base
$ overgit commit -m 'my local dev setup'
$ overgit push -u origin main

$ git status --porcelain
$
```

Empty. Not "ignored", not "stashed": the base repo genuinely believes it is clean, and a
`git add -A && git commit` in it captures nothing of yours.

On a new machine, `overgit clone --base <base-url> <overlay-url> <dir>` rebuilds the same
tree, file modes and all.

`overgit --help` lists every command, and `overgit help <command>` explains one in full.

## When upstream moves

This is the one situation worth walking through before you meet it, because git's own error
message points the wrong way.

Someone changes `config/app.toml` upstream, the file you override. Plain `git pull` refuses,
and it is right to:

```console
$ git pull
error: Your local changes to the following files would be overwritten by merge:
	config/app.toml
Please commit your changes or stash them before you merge.
Aborting
```

Do not commit or stash. Unmount the overlay, do your git, mount it again:

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

While detached the work-tree is a byte-exact pristine base checkout, so every git command
behaves normally. Your overlay content is safe in the overlay repository the whole time.
`overgit hooks install` automates the reattach; the detach is the part you run yourself.

Now merge upstream into your override. `overgit sync` does a true three-way merge, using
the blob you forked from as the merge base:

```console
$ overgit sync

1 path conflicted
  config/app.toml
  the work-tree files hold conflict markers. Edit them, then
  `overgit resolve <path>...` and `overgit sync --continue`.
  Shortcuts: `overgit resolve --keep <path>` keeps yours,
             `overgit resolve --take-upstream <path>` takes the base's.
```

A conflict blocks nothing else. Every other path still syncs, `status` and `doctor` keep
working, and the base stays clean even with conflict markers sitting in the work-tree.
Edit the file, then `overgit resolve <path>` and `overgit sync --continue`.

## Known limitations

They are real, so here is the whole list.

| limitation | why | remedy |
|---|---|---|
| `git pull` / `git checkout` in the base abort when upstream touches a file you override | git refuses to overwrite a differing `skip-worktree` file | `overgit detach`, git, `overgit attach`; or `overgit hooks install` |
| `git clean -xffd` (double `-f`) deletes `.overgit/` | double `-f` cleans even directories that are repositories | keep the overlay pushed; `overgit clone` restores it |
| `git clean -xfd` and `git stash -a` remove overlay-**added** files | added files are ignored from the base's point of view | `overgit apply` puts them back |
| filenames containing a newline, or ending in CR, cannot be **added** | not representable as an exact gitignore pattern | none, a git format limit; overrides and whiteouts are unaffected |
| binary files cannot be three-way merged | git refuses when any of the three sides is binary | surfaced as a decision: `--keep` / `--take-upstream` |
| work-tree commands refuse while the base has `core.sparseCheckout` | git would clear the `skip-worktree` bits and leak every override | disable sparse checkout, then `overgit doctor --fix` |
| `overgit hooks install` skips hooks written in another language | appending shell to a Python hook would break it | add `overgit apply \|\| true` to it by hand |
| one overlay per work-tree | stacking is not supported | none |
| submodules are not overlaid | overgit refuses paths inside a submodule | none |
| the base's index bits are shared state | a `skip-worktree` bit you set yourself is reported as unowned, never adopted | none |

Every row except the first three announces itself when you hit it, with the remedy in the
message. The `git clean` rows cannot: overgit is not running, so it never gets to speak.
Keep the overlay pushed.

## Development

```sh
bun install
bun test
bun run typecheck
```

## Licence

MIT.
