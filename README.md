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

Requires [Bun](https://bun.sh) ≥ 1.1 and a system `git` ≥ 2.30. Linux and macOS.

```sh
git clone <this-repo> overgit
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

On a new machine, `overgit clone --base <base-url> <overlay-url> <dir>` rebuilds the same
tree, file modes and all.

`overgit --help` lists every command. [docs/guide.md](docs/guide.md) walks through them
with real transcripts; [docs/reference.md](docs/reference.md) has the `--porcelain` formats
and the mechanism.

## Known limitations

Each one, with its remedy, is in [docs/limitations.md](docs/limitations.md). You will meet
this one first: `git pull` aborts when upstream touches a file you override, because git
refuses to overwrite a `skip-worktree` file. Run `overgit detach` first, then `git pull`,
then `overgit sync` to merge upstream into your overrides. The hooks reattach the overlay
for you; the detach is the part you run yourself.

Also watch `git clean -xffd`: the double `-f` deletes `.overgit/`. Keep the overlay pushed.

## Development

```sh
bun install
bun test
bun run typecheck
```

## Licence

MIT.
