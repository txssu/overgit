/**
 * Commands that are (mostly) plain git against the overlay: `commit`, `push`, `pull`,
 * `fetch`, and the `git` escape hatch.
 *
 * The overlay is an ordinary repository, so these deliberately hand the terminal to git
 * rather than paraphrasing it: you get git's progress bars, git's credential prompt, git's
 * pager and git's exit code. Two of them do something extra:
 *
 *  - `commit` stages the work-tree bytes of every path the overlay owns first (that is the
 *    `-a` you would otherwise have to remember), plus the manifest;
 *  - `pull` runs `applyState` afterwards, because a pull can bring in a manifest that owns
 *    paths this machine has not materialised yet.
 */

import { OvergitError } from "../../errors.ts";
import { withLock } from "../../context.ts";
import { readManifest, ownedPaths, stageManifest } from "../../manifest.ts";
import { readWorktreeEntry, stageOverlayContent } from "../../ownership.ts";
import { boolFlag, stringFlag } from "../args.ts";
import type { CommandSpec, Env } from "../command.ts";
import { openContext, reportApply } from "../common.ts";
import { gitPassthrough } from "../passthrough.ts";
import { displayPath, plural } from "../../ui.ts";
import type { Context } from "../../context.ts";
import type { Ui } from "../../ui.ts";

/**
 * Stage every owned path's current work-tree bytes into the overlay index.
 *
 * A path that is missing from the work-tree is **skipped, not staged as a deletion**. A
 * `git clean -xfd` in the base removes overlay-added files; if commit recorded that as a
 * deletion, the one command that is supposed to protect your content would be the one that
 * destroys it. Missing paths are reported instead, and `overgit apply` puts them back.
 */
async function stageOwnedPaths(ctx: Context, ui: Ui): Promise<{ staged: number; missing: string[] }> {
  const manifest = await readManifest(ctx);
  const missing: string[] = [];
  let staged = 0;

  for (const p of ownedPaths(manifest)) {
    if (manifest.entries[p]!.kind === "delete") continue;
    const entry = await readWorktreeEntry(ctx.root, p);
    if (entry === null) {
      missing.push(p);
      continue;
    }
    await stageOverlayContent(ctx, p, entry.mode, entry.content);
    staged++;
  }

  // The manifest is tracked by the overlay: it is what makes the state portable.
  await stageManifest(ctx, manifest);

  if (missing.length > 0) {
    ui.warn(
      `${plural(missing.length, "owned path")} missing from the work-tree; left as-is rather than committing a deletion:`,
    );
    for (const p of missing) ui.errLine(`    ${displayPath(p)}`);
    ui.errLine(`  run \`overgit apply\` to put them back, or \`overgit rm\` to drop them`);
  }
  return { staged, missing };
}

export const commitCommand: CommandSpec = {
  name: "commit",
  summary: "record the overlay's current content",
  usage: ["overgit commit -m <message> [--amend] [--no-all]"],
  flags: {
    message: { type: "string", short: "m", value: "<message>", description: "commit message" },
    amend: { type: "boolean", description: "replace the previous overlay commit" },
    all: {
      type: "boolean",
      description: "stage every owned path first (default; disable with --no-all)",
    },
  },
  description: [
    "Stages the current work-tree bytes of every path the overlay owns, then commits the",
    "overlay. `--no-all` skips the staging step and commits exactly what is in the",
    "overlay index already.",
    "",
    "Without `-m`, git opens your editor as usual.",
    "",
    "An owned path that is missing from the work-tree is never committed as a deletion —",
    "that would turn a `git clean -xfd` into permanent data loss. Use `overgit rm` to drop",
    "a path on purpose.",
  ],
  examples: [
    { cmd: 'overgit commit -m "override the dev config"', what: "record everything owned" },
    { cmd: "overgit commit --amend -m 'better message'", what: "fix the last overlay commit" },
  ],
  async run(env: Env): Promise<number> {
    const message = stringFlag(env.args, "message");
    const amend = boolFlag(env.args, "amend");
    const all = env.args.flags["all"] !== false;

    const ctx = await openContext(env, { requireOverlay: true });

    // Refuse to commit into a half-finished sync. `commit` re-stages from the work-tree, so
    // a conflicted file goes in with its `<<<<<<<` markers intact — and `sync --abort`
    // afterwards restores the work-tree but cannot un-commit, so `overgit push` publishes
    // the markers and a fresh `overgit clone` materialises them on the next machine. Git
    // refuses to commit with unmerged paths for exactly this reason.
    const { readSyncState } = await import("../../sync.ts");
    const pending = await readSyncState(ctx);
    const conflicted = pending === null ? [] : Object.keys(pending.conflicts).sort();
    const decisions = pending === null ? [] : pending.decisions.map((d) => d.path).sort();
    if (conflicted.length > 0 || decisions.length > 0) {
      throw new OvergitError(
        "CONFLICTS_PENDING",
        `a sync is in progress, so \`overgit commit\` would record unresolved content`,
        {
          hint: "finish it with `overgit resolve <path>...` and `overgit sync --continue`, or undo it with `overgit sync --abort`",
          details: [
            ...conflicted.map((p) => `conflicted: ${p}`),
            ...decisions.map((p) => `needs a decision: ${p}`),
          ],
          paths: [...conflicted, ...decisions],
        },
      );
    }

    if (all) await withLock(ctx, () => stageOwnedPaths(ctx, env.ui));

    const args = ["commit"];
    if (amend) args.push("--amend");
    if (message !== undefined) args.push("-m", message);
    if (env.ui.quiet) args.push("--quiet");
    args.push(...env.args.positional);

    return gitPassthrough({
      gitDir: ctx.overlayGitDir,
      workTree: ctx.root,
      cwd: env.cwd,
      args,
    });
  },
};

export const pushCommand: CommandSpec = {
  name: "push",
  summary: "push the overlay to its remote (plain `git push`)",
  usage: ["overgit push [<git-push-args>...]"],
  flags: {},
  passthrough: true,
  description: [
    "A pure passthrough. The overlay is a normal repository with a normal remote, so",
    "`overgit push -u origin main` does exactly what it says.",
  ],
  examples: [{ cmd: "overgit push -u origin main", what: "publish the overlay" }],
  async run(env: Env): Promise<number> {
    const ctx = await openContext(env, { requireOverlay: true });
    return gitPassthrough({
      gitDir: ctx.overlayGitDir,
      workTree: ctx.root,
      cwd: env.cwd,
      args: ["push", ...env.argv],
    });
  },
};

export const fetchCommand: CommandSpec = {
  name: "fetch",
  summary: "fetch the overlay's remote (plain `git fetch`)",
  usage: ["overgit fetch [<git-fetch-args>...]"],
  flags: {},
  passthrough: true,
  async run(env: Env): Promise<number> {
    const ctx = await openContext(env, { requireOverlay: true });
    return gitPassthrough({
      gitDir: ctx.overlayGitDir,
      workTree: ctx.root,
      cwd: env.cwd,
      args: ["fetch", ...env.argv],
    });
  },
};

export const pullCommand: CommandSpec = {
  name: "pull",
  summary: "pull the overlay, then re-apply it to the work-tree",
  usage: ["overgit pull [<git-pull-args>...]"],
  flags: {},
  passthrough: true,
  description: [
    "`git pull` in the overlay, followed by `overgit apply`.",
    "",
    "The extra step matters: a pull can bring in a manifest entry from another machine",
    "whose content has never been written here. Without the apply the work-tree would",
    "silently disagree with the overlay. If the apply changed anything you are told what.",
    "",
    "This pulls the *overlay*. The base repository is yours to pull yourself.",
  ],
  examples: [{ cmd: "overgit pull", what: "sync this machine with the overlay's remote" }],
  async run(env: Env): Promise<number> {
    const ctx = await openContext(env, { requireOverlay: true });
    const code = await gitPassthrough({
      gitDir: ctx.overlayGitDir,
      workTree: ctx.root,
      cwd: env.cwd,
      args: ["pull", ...env.argv],
    });
    if (code !== 0) {
      env.ui.warn("the overlay pull failed; the work-tree was left untouched");
      return code;
    }

    const { attach } = await import("../../bootstrap.ts");
    const report = await withLock(ctx, () => attach(ctx));
    if (report.changed) {
      env.ui.say("");
      env.ui.warn("the pull changed what the overlay owns; the work-tree was updated");
      reportApply(env.ui, report, { verb: "applied" });
    }
    return 0;
  },
};

export const gitCommand: CommandSpec = {
  name: "git",
  summary: "run any git command against the overlay repository",
  usage: ["overgit git <args>..."],
  flags: {},
  passthrough: true,
  description: [
    "The escape hatch. Runs git with GIT_DIR set to .overgit/.git and the work-tree set to",
    "the repository root, so anything git can do to the overlay, you can do.",
    "",
    "overgit does not check what you asked for. `overgit git checkout .` will happily",
    "splatter the overlay's whole tree across the work-tree, which is precisely what the",
    "rest of the tool refuses to do — `overgit apply` is the safe equivalent.",
  ],
  examples: [
    { cmd: "overgit git remote -v", what: "where does the overlay push?" },
    { cmd: "overgit git reset HEAD~1", what: "undo the last overlay commit, keep the content" },
  ],
  async run(env: Env): Promise<number> {
    if (env.argv.length === 0) {
      const { usageError } = await import("../args.ts");
      throw usageError(
        "`overgit git` needs a git command to run",
        "for example `overgit git remote -v`",
      );
    }
    const ctx = await openContext(env, { requireOverlay: true });
    return gitPassthrough({
      gitDir: ctx.overlayGitDir,
      workTree: ctx.root,
      cwd: env.cwd,
      args: env.argv,
    });
  },
};
