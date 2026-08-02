/**
 * The three commands that change who owns a path: `add`, `rm`, `restore`.
 *
 * All three take the advisory lock, because all three write the manifest, the overlay
 * index, the base's exclude block and the base's index bits — a half-finished one of those
 * is exactly the drift `doctor` exists to clean up, so it is worth not creating.
 */

import { withLock } from "../../context.ts";
import { ownedPaths, readManifest } from "../../manifest.ts";
import { restoreToBase, takeOwnership, whiteout } from "../../ownership.ts";
import { OvergitError } from "../../errors.ts";
import { boolFlag, requireArgs, usageError } from "../args.ts";
import type { CommandSpec, Env } from "../command.ts";
import { openContext, reportOwnership } from "../common.ts";

export const addCommand: CommandSpec = {
  name: "add",
  summary: "take ownership of a path (override it, or add a new file)",
  usage: ["overgit add [--force] <path>..."],
  flags: {
    force: {
      type: "boolean",
      short: "f",
      description: "re-stage a path the overlay already owns",
    },
  },
  description: [
    "What happens depends on whether the base tracks the path:",
    "",
    "  the base tracks it       -> `override`. The base is told the file is pristine",
    "                              (skip-worktree) while the work-tree holds your version.",
    "  the base does not        -> `add`. The path is listed in the base's",
    "                              .git/info/exclude, so the base cannot see it at all.",
    "",
    "A directory argument expands to the files under it. Paths already owned are reported",
    "as skipped rather than failing, so `overgit add src/` stays usable.",
    "",
    "The current work-tree bytes are staged into the overlay immediately, so nothing you",
    "own lives only in the work-tree.",
  ],
  examples: [
    { cmd: "overgit add .envrc", what: "hide a personal file from the base entirely" },
    { cmd: "overgit add src/config.ts", what: "override a file the base tracks" },
    { cmd: "overgit add scripts/", what: "take every file under scripts/" },
  ],
  async run(env: Env): Promise<number> {
    const paths = requireArgs(env.args, "add", "at least one path");
    const force = boolFlag(env.args, "force");
    const ctx = await openContext(env, { requireOverlay: true });
    const result = await withLock(ctx, () => takeOwnership(ctx, paths, { force }));
    reportOwnership(env.ui, result, "took");
    if (result.changes.length > 0) {
      env.ui.say("");
      env.ui.say("run `overgit commit -m <message>` to record this in the overlay's history");
    }
    return 0;
  },
};

export const rmCommand: CommandSpec = {
  name: "rm",
  summary: "hide a base file, or drop a file the overlay added",
  usage: ["overgit rm [--force] <path>..."],
  flags: {
    force: {
      type: "boolean",
      short: "f",
      description: "proceed even when the work-tree bytes are unexpected",
    },
  },
  description: [
    "For a path the base tracks, this records a `delete`: the file leaves the work-tree",
    "and the base is told it is still pristine. The base's blob is untouched, so",
    "`overgit restore <path>` brings it straight back.",
    "",
    "For a path the overlay added, this un-adds it: the overlay stops owning the path and",
    "the exclude line goes away.",
  ],
  examples: [
    { cmd: "overgit rm docs/legacy.md", what: "make a tracked file disappear locally" },
    { cmd: "overgit rm scripts/dev.sh", what: "stop overlaying a file you had added" },
  ],
  async run(env: Env): Promise<number> {
    const paths = requireArgs(env.args, "rm", "at least one path");
    const force = boolFlag(env.args, "force");
    const ctx = await openContext(env, { requireOverlay: true });
    const result = await withLock(ctx, () => whiteout(ctx, paths, { force }));
    reportOwnership(env.ui, result, "removed");
    return 0;
  },
};

export const restoreCommand: CommandSpec = {
  name: "restore",
  summary: "give paths back to the base",
  usage: ["overgit restore [--force] [--keep-file] <path>...", "overgit restore --all"],
  flags: {
    all: { type: "boolean", description: "restore every path the overlay owns" },
    force: {
      type: "boolean",
      short: "f",
      description: "proceed even when the work-tree bytes are unexpected",
    },
    "keep-file": {
      type: "boolean",
      description: "for `add` paths: leave the file on disk, untracked",
    },
  },
  description: [
    "The inverse of `add` and `rm`. An override or whiteout gets the base's content back",
    "and loses its skip-worktree bit; an add is deleted from the work-tree (or left there",
    "untracked with `--keep-file`) and loses its exclude line.",
    "",
    "The overlay's own history is not rewritten — the content stays in the overlay repo,",
    "so `overgit add` can take the path again later.",
  ],
  examples: [
    { cmd: "overgit restore src/config.ts", what: "put the base's version back" },
    { cmd: "overgit restore --all", what: "hand everything back (keeps the overlay's history)" },
  ],
  async run(env: Env): Promise<number> {
    const all = boolFlag(env.args, "all");
    const force = boolFlag(env.args, "force");
    const keepFile = boolFlag(env.args, "keep-file");

    if (all && env.args.positional.length > 0) {
      throw usageError(
        "`overgit restore --all` does not take path arguments",
        "drop `--all`, or drop the paths",
      );
    }
    if (!all && env.args.positional.length === 0) {
      throw usageError(
        "`overgit restore` needs at least one path, or `--all`",
        "see `overgit help restore`",
      );
    }

    const ctx = await openContext(env, { requireOverlay: true });
    const result = await withLock(ctx, async () => {
      if (!all) return restoreToBase(ctx, env.args.positional, { force, keepFile });
      const manifest = await readManifest(ctx);
      const paths = ownedPaths(manifest);
      if (paths.length === 0) {
        throw new OvergitError("NOT_OWNED", "the overlay owns nothing, so there is nothing to restore", {
          hint: "run `overgit add <path>` to take a file first",
        });
      }
      return restoreToBase(ctx, paths, { force, keepFile, repoRelative: true });
    });
    reportOwnership(env.ui, result, "restored");
    return 0;
  },
};
