/**
 * Read-only commands: `status`, `list`, `diff`, `log`.
 *
 * None of these mutate anything, so none of them take the lock — `overgit status` has to
 * work while a `sync` is running in another terminal, otherwise it is useless exactly when
 * you need it.
 */

import { computeStatus } from "../../status.ts";
import { KINDS, readManifest, ownedPaths, type Kind } from "../../manifest.ts";
import { boolFlag, rejectArgs, requireArgs, stringFlag } from "../args.ts";
import type { CommandSpec, Env } from "../command.ts";
import { openContext, repoPaths } from "../common.ts";
import { gitPassthrough } from "../passthrough.ts";
import { columns, displayPath } from "../../ui.ts";
import {
  renderStatusLong,
  renderStatusPorcelain,
  renderStatusShort,
} from "../render-status.ts";

export const statusCommand: CommandSpec = {
  name: "status",
  summary: "the merged view: base, overlay, and what is about to go wrong",
  usage: ["overgit status [--short] [--porcelain]"],
  flags: {
    short: { type: "boolean", short: "s", description: "one line per path, fixed-width prefix" },
    porcelain: { type: "boolean", description: "stable machine format (NUL-terminated records)" },
  },
  description: [
    "Shows both repositories at once. The base's own changes are listed with every path",
    "the overlay owns removed, so what you see is genuinely the base's work — an",
    "overridden file is not `modified`, it is overgit's.",
    "",
    "`--short` legend, four fixed columns then the path:",
    "  K  + add   ~ override   - delete   b a base-side change",
    "  S  S staged in the overlay, . not",
    "  W  M modified, ! missing (or a whiteout that came back), . clean",
    "  U  < upstream changed, x upstream deleted, + the base now tracks it,",
    "     ? unknown, . unchanged",
    "For a `b` row, S and W are git's own two porcelain-v1 characters.",
    "",
    "`--porcelain` writes NUL-terminated records of tab-separated fields with the path",
    "always last, so a path containing a tab or a newline still parses. Record names and",
    "field order are stable; see README.md.",
    "",
    "status always exits 0 when it managed to report. Use `overgit doctor` (exit 4) to",
    "test for problems in a script.",
  ],
  examples: [
    { cmd: "overgit status", what: "the full picture" },
    { cmd: "overgit status --short", what: "one line per path" },
    {
      cmd: "overgit status --porcelain | tr '\\0' '\\n'",
      what: "machine format, one record per line",
    },
  ],
  async run(env: Env): Promise<number> {
    rejectArgs(env.args, "status");
    const short = boolFlag(env.args, "short");
    const porcelain = boolFlag(env.args, "porcelain");
    if (short && porcelain) {
      const { usageError } = await import("../args.ts");
      throw usageError(
        "`--short` and `--porcelain` are two different formats",
        "pick one; `--porcelain` is the stable one for scripts",
      );
    }

    const ctx = await openContext(env, { requireOverlay: true });
    const s = await computeStatus(ctx);

    if (porcelain) {
      env.ui.raw(renderStatusPorcelain(s));
      return 0;
    }
    for (const line of short ? renderStatusShort(s) : renderStatusLong(s, env.ui)) {
      env.ui.print(line);
    }
    return 0;
  },
};

export const listCommand: CommandSpec = {
  name: "list",
  summary: "list the paths the overlay owns",
  usage: ["overgit list [--kind add|override|delete] [--porcelain]"],
  flags: {
    kind: {
      type: "string",
      value: "<kind>",
      description: "only paths of this kind",
      choices: KINDS,
    },
    porcelain: { type: "boolean", description: "`<kind>TAB<path>NUL` records" },
  },
  description: [
    "The manifest, printed. This is the portable half of the overlay's state — everything",
    "else (skip-worktree bits, the exclude block, the work-tree bytes) is rebuilt from it",
    "by `overgit apply`.",
  ],
  examples: [
    { cmd: "overgit list", what: "everything the overlay owns" },
    { cmd: "overgit list --kind override", what: "just the overridden files" },
  ],
  async run(env: Env): Promise<number> {
    rejectArgs(env.args, "list");
    const kind = stringFlag(env.args, "kind") as Kind | undefined;
    const porcelain = boolFlag(env.args, "porcelain");

    const ctx = await openContext(env, { requireOverlay: true });
    const manifest = await readManifest(ctx);
    const paths = ownedPaths(manifest).filter(
      (p) => kind === undefined || manifest.entries[p]!.kind === kind,
    );

    if (porcelain) {
      env.ui.raw(paths.map((p) => `${manifest.entries[p]!.kind}\t${p}\0`).join(""));
      return 0;
    }
    if (paths.length === 0) {
      env.ui.say(
        kind === undefined
          ? "the overlay owns nothing yet — run `overgit add <path>`"
          : `the overlay owns no ${kind} paths`,
      );
      return 0;
    }
    for (const line of columns(
      paths.map((p) => [manifest.entries[p]!.kind, displayPath(p)]),
      "",
    )) {
      env.ui.print(line);
    }
    return 0;
  },
};

export const diffCommand: CommandSpec = {
  name: "diff",
  summary: "diff the overlay's own content (plain `git diff`)",
  usage: ["overgit diff [<git-diff-args>...] [<path>...]"],
  flags: {},
  passthrough: true,
  description: [
    "Runs `git diff` against the overlay repository. Only paths the overlay owns are",
    "tracked there, so this never shows the base's work.",
    "",
    "Every `git diff` option works: `--cached`, `--stat`, `-U0`, a revision range.",
  ],
  examples: [
    { cmd: "overgit diff", what: "unstaged overlay changes" },
    { cmd: "overgit diff --cached", what: "what `overgit commit` would record" },
  ],
  async run(env: Env): Promise<number> {
    const ctx = await openContext(env, { requireOverlay: true });
    return gitPassthrough({
      gitDir: ctx.overlayGitDir,
      workTree: ctx.root,
      cwd: env.cwd,
      args: ["diff", ...env.argv],
    });
  },
};

export const logCommand: CommandSpec = {
  name: "log",
  summary: "the overlay's history (plain `git log`)",
  usage: ["overgit log [<git-log-args>...]"],
  flags: {},
  passthrough: true,
  description: [
    "Runs `git log` against the overlay repository. The overlay is an ordinary git repo,",
    "so every option and pager behaviour you know applies.",
  ],
  examples: [
    { cmd: "overgit log --oneline", what: "compact history" },
    { cmd: "overgit log -p -- src/config.ts", what: "history of one overridden file" },
  ],
  async run(env: Env): Promise<number> {
    const ctx = await openContext(env, { requireOverlay: true });
    return gitPassthrough({
      gitDir: ctx.overlayGitDir,
      workTree: ctx.root,
      cwd: env.cwd,
      args: ["log", ...env.argv],
    });
  },
};

/**
 * `overgit which` — answer "is this file mine or the base's?" for a specific path.
 *
 * `vcsh which` exists for exactly this reason, and a blind UX review found its absence to be
 * the one thing genuinely harder here than in the reference tools: with a large tree, `list`
 * makes you eyeball a whole manifest to answer a question about one file.
 */
export const whichCommand: CommandSpec = {
  name: "which",
  summary: "say who owns a path, and why",
  usage: ["overgit which <path>..."],
  flags: {
    porcelain: { type: "boolean", description: "`<owner>TAB<kind>TAB<path>NUL` records" },
  },
  description: [
    "Answers the question `overgit list` makes you scan for: is this particular file the",
    "overlay's or the base's? Exits 1 if any path is owned by neither, so it is usable in",
    "a script as a test.",
  ],
  examples: [
    { cmd: "overgit which config/app.toml", what: "who owns one file" },
    { cmd: "overgit which src/*.ts", what: "several at once" },
  ],
  async run(env: Env): Promise<number> {
    const inputs = requireArgs(env.args, "which", "at least one path");
    const porcelain = boolFlag(env.args, "porcelain");

    const ctx = await openContext(env, { requireOverlay: true });
    const manifest = await readManifest(ctx);
    const paths = repoPaths(ctx, inputs);

    const rows: [string, string][] = [];
    let unowned = 0;
    const out: string[] = [];

    for (const p of paths) {
      const entry = manifest.entries[p];
      if (entry !== undefined) {
        if (porcelain) out.push(`overlay\t${entry.kind}\t${p}\0`);
        else rows.push([displayPath(p), `the overlay owns this — ${entry.kind}`]);
        continue;
      }
      const tracked = await ctx.base.isTracked(p);
      unowned++;
      if (porcelain) out.push(`base\t${tracked ? "tracked" : "untracked"}\t${p}\0`);
      else {
        rows.push([
          displayPath(p),
          tracked
            ? "the base tracks this — `overgit add` to override it"
            : "not tracked by either — `overgit add` to add it to the overlay",
        ]);
      }
    }

    if (porcelain) env.ui.raw(out.join(""));
    else env.ui.sayAll(columns(rows));
    return unowned > 0 ? 1 : 0;
  },
};
