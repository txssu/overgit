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
project root. Nothing is hidden from you — plain git works on it (`git -C .overgit log`).

## Install

Requires [Bun](https://bun.sh) ≥ 1.1 and a system `git` ≥ 2.30. Linux and macOS.

```sh
git clone <this-repo> overgit
cd overgit
bun install
ln -s "$PWD/bin/overgit" ~/.local/bin/overgit   # anywhere on your PATH
```

## Sixty seconds

In a clone of any git repository:

```console
$ overgit init --remote git@example.com:me/my-overlay.git
$ overgit add config/app.toml    # override — the base tracks it, you changed it
$ overgit add scripts/dev.sh     # add — the base has never heard of it
$ overgit rm OLDNOTES.md         # delete — gone for you, still there for the base
$ overgit commit -m 'my local dev setup'
$ overgit push -u origin main

$ git status --porcelain
$
```

Empty. Not "ignored", not "stashed" — the base repo genuinely believes it is clean, and
even `git add -A && git commit` captures nothing of yours.

From there:

* **Upstream touched a file you override?** `git pull` refuses — by design. Run
  `overgit detach` → `git pull` → `overgit attach` (or `overgit hooks install` once to
  automate it), then `overgit sync` to three-way-merge upstream's changes into your
  overrides, with real conflict markers and `overgit resolve`.
* **A new machine?** `overgit clone --base <base-url> <overlay-url> <dir>` reproduces
  your tree byte-for-byte, modes included.
* **Something looks off?** `overgit doctor` explains what and why; `overgit apply` puts
  the work-tree back.

The [full walkthrough](docs/guide.md) shows each of these with real transcripts.

## Commands

`overgit --help` lists every command, grouped by workflow, with examples, global options
and exit codes; `overgit help <command>` explains one in detail. The stable `--porcelain`
output formats and the concrete mechanism — exclude patterns, `skip-worktree` bits, the
manifest — are in [docs/reference.md](docs/reference.md).

## Known limitations

They are real, and listed rather than discovered later — each with its why and its remedy,
in [docs/limitations.md](docs/limitations.md). The one you will meet first: `git pull` and
`git checkout` abort when upstream touches a file you override, because git refuses to
overwrite a `skip-worktree` file — the detach → pull → attach cycle above is the remedy.
The one that bites: `git clean -xffd` (double `-f`) deletes `.overgit/`, so keep your
overlay pushed.

## Development

```sh
bun install
bun test          # 426 integration tests; they spawn the real binary against real repos
bun run typecheck
```

The tests build throwaway git repositories in temp directories and drive `bin/overgit` as a
subprocess. There are no mocks: if a test says the base stays clean, a real `git status`
said so. `DESIGN.md` records the internal contract and the **measured** git behaviour the
design rests on.

## Licence

MIT.
