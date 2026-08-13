# overgit reference

Material for scripting against overgit and for understanding the mechanism. The
[README](../README.md) has installation and the pitch; [guide.md](guide.md) is the full
walkthrough; `overgit --help` lists every command, with exit codes. One note beyond the
help text: an in-progress sync is a state, not a problem, so it does not by itself make
`doctor` exit 4.

## Scripting: `--porcelain`

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

## How it works, concretely

* An **add** is listed in the base's `.git/info/exclude` — never `.gitignore`, so nothing
  local ever enters the base's history.
* An **override** and a **delete** set `git update-index --skip-worktree` on the path in the
  base, so the base skips the work-tree entirely and believes its own version is checked out.
* The overlay tracks your content, and `.overgit/manifest.json` records what is owned and
  which base blob each override forked from. The manifest is tracked *by the overlay*, which
  is how a fresh clone reproduces your tree.
* Machine-local state — sync progress, backups, the lock — lives in `.overgit/local/` and is
  never committed anywhere.
