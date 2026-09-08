/**
 * `worktree` — linked work-trees of the base that carry the overlay with them.
 */

import { relative } from "node:path";
import { boolFlag, stringFlag, usageError } from "../args.ts";
import type { CommandSpec, Env } from "../command.ts";
import { openContext, reportApply } from "../common.ts";
import { columns, plural } from "../../ui.ts";

const SUBCOMMANDS = ["add", "list", "remove"] as const;

export const worktreeCommand: CommandSpec = {
  name: "worktree",
  summary: "manage base work-trees that carry the overlay (git worktree, overlay included)",
  usage: [
    "overgit worktree add <path> [<commit-ish>] [-b <branch>] [--overlay-branch <name>]",
    "overgit worktree list",
    "overgit worktree remove <path> [--force]",
  ],
  flags: {
    branch: {
      type: "string",
      short: "b",
      value: "<name>",
      description: "add: create this base branch and check it out",
    },
    "overlay-branch": {
      type: "string",
      value: "<name>",
      description: "add: overlay branch for the new tree (default: the base branch's name)",
    },
    force: {
      type: "boolean",
      short: "f",
      description: "remove: discard the overlay's uncommitted changes there",
    },
  },
  description: [
    "`add` is `git worktree add` plus the overlay. The new directory is a linked work-tree",
    "of the base and its .overgit is a linked worktree of the overlay repository, so both",
    "halves share history with the tree you ran this from: commit and push the overlay",
    "from either. The overlay branch is created from the overlay's HEAD if it does not",
    "exist. Like any git branch it can be checked out in one worktree at a time.",
    "",
    "`remove` is `git worktree remove` for such a tree. It refuses while the overlay there",
    "has uncommitted changes, because git would delete them without a word.",
    "",
    "Plain `git worktree add` still works; the tree it makes has no overlay until you",
    "`overgit clone` into it. Every overgit command works inside a linked work-tree.",
    "",
    "One thing to know. The base keeps a single .git/info/exclude for all of its",
    "work-trees, and git has no per-work-tree exclude file. overgit therefore writes the",
    "union of every work-tree's overlay-added paths into it, so a file you `overgit add`",
    "in one work-tree is ignored by the base in all of them. Harmless where the file does",
    "not exist; in a work-tree where you created the same path by hand, `git clean -xfd`",
    "would delete it as ignored.",
  ],
  examples: [
    { cmd: "overgit worktree add ../app-hotfix -b hotfix", what: "a second checkout, overlay applied" },
    { cmd: "overgit worktree add ../app-review origin/pr-42", what: "review a branch with your setup on top" },
    { cmd: "overgit worktree list", what: "which work-trees have an overlay, and on what branch" },
    { cmd: "overgit worktree remove ../app-hotfix", what: "done with it" },
  ],
  async run(env: Env): Promise<number> {
    const [action, ...rest] = env.args.positional;
    if (action === undefined) {
      throw usageError(
        "`overgit worktree` needs a subcommand",
        `the subcommands are ${SUBCOMMANDS.map((s) => `\`${s}\``).join(", ")}`,
      );
    }
    switch (action) {
      case "add":
        return add(env, rest);
      case "list":
        return list(env, rest);
      case "remove":
        return remove(env, rest);
      default:
        throw usageError(
          `\`overgit worktree\` has no subcommand \`${action}\``,
          `the subcommands are ${SUBCOMMANDS.map((s) => `\`${s}\``).join(", ")}`,
        );
    }
  },
};

function noFlag(env: Env, sub: string, ...names: string[]): void {
  for (const n of names) {
    if (env.args.flags[n] !== undefined) {
      throw usageError(`\`--${n}\` does not apply to \`overgit worktree ${sub}\``, `see \`overgit help worktree\``);
    }
  }
}

async function add(env: Env, rest: string[]): Promise<number> {
  noFlag(env, "add", "force");
  const [path, commitish, extra] = rest;
  if (path === undefined) {
    throw usageError("`overgit worktree add` needs a path for the new work-tree", "see `overgit help worktree`");
  }
  if (extra !== undefined) {
    throw usageError(
      `\`overgit worktree add\` takes a path and an optional commit-ish, but got \`${extra}\` as well`,
      "see `overgit help worktree`",
    );
  }
  const branch = stringFlag(env.args, "branch");
  const overlayBranch = stringFlag(env.args, "overlay-branch");
  const ctx = await openContext(env, { requireOverlay: true });
  const { worktreeAdd } = await import("../../worktree.ts");

  const r = await worktreeAdd(ctx, {
    path,
    ...(commitish !== undefined ? { commitish } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(overlayBranch !== undefined ? { overlayBranch } : {}),
  });

  const where = relative(env.cwd, r.root) || ".";
  env.ui.say(
    `created the work-tree ${where}` +
      (r.baseBranch === null ? " (detached HEAD)" : ` on branch ${r.baseBranch}`) +
      (r.overlayBranch === null ? "" : `, overlay on branch ${r.overlayBranch}`),
  );
  reportApply(env.ui, r.apply, { verb: "applied" });
  env.ui.say("");
  env.ui.say(
    r.owned === 0
      ? `the overlay owns nothing yet — run \`overgit add <path>\` in ${where}`
      : `the overlay owns ${plural(r.owned, "path")} — run \`overgit status\` in ${where}`,
  );
  return 0;
}

async function list(env: Env, rest: string[]): Promise<number> {
  noFlag(env, "list", "branch", "overlay-branch", "force");
  if (rest.length > 0) {
    throw usageError(`\`overgit worktree list\` takes no arguments, but got \`${rest[0]}\``, "see `overgit help worktree`");
  }
  const ctx = await openContext(env);
  const { worktreeList } = await import("../../worktree.ts");
  const rows: string[][] = [];
  for (const w of await worktreeList(ctx)) {
    const marks = [w.main ? "main" : "", w.current ? "current" : ""].filter((m) => m !== "");
    const base = w.baseBranch ?? "(detached HEAD)";
    let overlay: string;
    if (w.overlay === null) overlay = "no overlay";
    else {
      overlay = `overlay ${w.overlay.branch ?? "(detached HEAD)"}, ${plural(w.overlay.owned, "path")}`;
      if (w.overlay.detached) overlay += ", detached";
    }
    rows.push([w.root, base, overlay, marks.join(", ")]);
  }
  env.ui.sayAll(columns(rows, ""));
  return 0;
}

async function remove(env: Env, rest: string[]): Promise<number> {
  noFlag(env, "remove", "branch", "overlay-branch");
  const [path, extra] = rest;
  if (path === undefined) {
    throw usageError("`overgit worktree remove` needs the work-tree's path", "see `overgit help worktree`");
  }
  if (extra !== undefined) {
    throw usageError(`\`overgit worktree remove\` takes one path, but got \`${extra}\` as well`, "see `overgit help worktree`");
  }
  const ctx = await openContext(env, { requireOverlay: true });
  const { worktreeRemove } = await import("../../worktree.ts");
  const r = await worktreeRemove(ctx, { path, force: boolFlag(env.args, "force") });
  env.ui.say(`removed the work-tree ${relative(env.cwd, r.root) || r.root}`);
  if (r.overlayBranch !== null) {
    env.ui.say(`its overlay branch ${r.overlayBranch} is still in the overlay repository`);
  }
  return 0;
}
