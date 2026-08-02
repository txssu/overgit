/**
 * `apply` / `attach`, `detach`, and `doctor` — the commands that reconcile the work-tree
 * with the manifest, and the one that explains why it needed reconciling.
 */

import { withLock } from "../../context.ts";
import { EXIT } from "../../errors.ts";
import type { Problem } from "../../doctor.ts";
import { boolFlag, rejectArgs } from "../args.ts";
import type { CommandSpec, Env } from "../command.ts";
import { openContext, reportApply, reportBackups, warnDeclined } from "../common.ts";
import { columns, displayPath, plural, type Ui } from "../../ui.ts";

export const applyCommand: CommandSpec = {
  name: "apply",
  aliases: ["attach"],
  summary: "make the work-tree match the manifest (also spelled `attach`)",
  usage: ["overgit apply [--dry-run] [--force]", "overgit attach"],
  flags: {
    "dry-run": {
      type: "boolean",
      short: "n",
      description: "report what would change and exit 4 if anything would",
    },
    force: {
      type: "boolean",
      description: "replace a directory or special file sitting where a file belongs",
    },
  },
  description: [
    "The reconciler, and the answer to almost every 'my tree looks wrong' question.",
    "It writes each owned path's content, removes each whited-out file, re-sets the base's",
    "skip-worktree bits and regenerates the managed block in .git/info/exclude.",
    "",
    "It is idempotent: a second run in a row changes nothing.",
    "",
    "It never does a bulk checkout. Files are written one at a time, and any bytes that",
    "match neither the overlay's content nor the base's are copied into",
    ".overgit/local/backups/ first and the path is printed.",
    "",
    "`overgit attach` is the same command, named for what it does after `overgit detach`.",
    "",
    "Exit codes: 0 normally; 4 when `--dry-run` finds drift.",
  ],
  examples: [
    { cmd: "overgit apply", what: "put the overlay back after `git clean -xfd`" },
    { cmd: "overgit apply --dry-run", what: "check for drift in a script (exit 4 = drift)" },
  ],
  async run(env: Env): Promise<number> {
    rejectArgs(env.args, "apply");
    const dryRun = boolFlag(env.args, "dry-run");
    const force = boolFlag(env.args, "force");

    const ctx = await openContext(env, { requireOverlay: true });
    // `attach` is `applyState` plus clearing the detached marker: a successful apply *is*
    // a remount, so leaving the marker behind would make `overgit status` lie.
    const { attach } = await import("../../bootstrap.ts");
    const report = await withLock(ctx, () => attach(ctx, { dryRun, force }));

    reportApply(env.ui, report, { dryRun });
    warnDeclined(env.ui, report);

    return dryRun && report.changed ? EXIT.PROBLEMS : EXIT.OK;
  },
};

export const detachCommand: CommandSpec = {
  name: "detach",
  summary: "unmount the overlay so plain git can do anything it likes",
  usage: ["overgit detach [--force]"],
  flags: {
    force: {
      type: "boolean",
      short: "f",
      description: "detach even when a work-tree file holds unexpected bytes",
    },
  },
  description: [
    "Restores base-pristine bytes everywhere, clears the skip-worktree bits, drops the",
    "managed exclude block and removes the files the overlay added. Afterwards the work-",
    "tree is an ordinary checkout of the base and git has no reason to complain.",
    "",
    "Nothing is lost: every owned path's content is staged into the overlay first, so",
    "`overgit attach` puts it all back byte for byte.",
    "",
    "This exists because of a measured git limitation. `git pull` and `git checkout` abort",
    "with 'your local changes would be overwritten' when upstream touches a file the",
    "overlay overrides — skip-worktree does not protect it. The recipe is:",
    "",
    "    overgit detach",
    "    git pull            # or git checkout <branch>, git stash, anything",
    "    overgit attach",
  ],
  examples: [
    { cmd: "overgit detach && git pull && overgit attach", what: "the whole recipe" },
  ],
  async run(env: Env): Promise<number> {
    rejectArgs(env.args, "detach");
    const force = boolFlag(env.args, "force");
    const ctx = await openContext(env, { requireOverlay: true });
    const { detach } = await import("../../bootstrap.ts");

    const report = await withLock(ctx, () => detach(ctx, { force }));

    if (report.alreadyDetached) {
      env.ui.say("the overlay is already detached");
      env.ui.say("run `overgit attach` to mount it again");
      return 0;
    }

    const rows: string[][] = [];
    for (const p of report.restored) rows.push(["restored", displayPath(p)]);
    for (const p of report.removed) rows.push(["removed", displayPath(p)]);
    if (rows.length === 0) {
      env.ui.say("the overlay owned nothing to unmount");
    } else {
      env.ui.say(`detached ${plural(rows.length, "path")}:`);
      env.ui.sayAll(columns(rows));
    }
    for (const a of report.actions) {
      if (a.action === "noop" && a.detail !== undefined) {
        env.ui.warn(`${displayPath(a.path)}: ${a.detail}`);
      }
    }
    reportBackups(env.ui, report.backups);
    env.ui.say("");
    env.ui.say("the work-tree is now pristine base content — run any git command you like,");
    env.ui.say("then `overgit attach` to mount the overlay again");
    return 0;
  },
};

/* ------------------------------------------------------------------ doctor */

function renderProblem(ui: Ui, p: Problem): string[] {
  const label =
    p.severity === "error" ? ui.s("error:", "red", "bold") : ui.s("warning:", "yellow", "bold");
  const id = ui.s(`[${p.id}]`, "dim");
  return [`${label} ${p.message}  ${id}`, `  ${ui.s("hint:", "cyan")} ${p.hint}`];
}

export const doctorCommand: CommandSpec = {
  name: "doctor",
  summary: "find (and with --fix, repair) drift between the overlay and the work-tree",
  usage: ["overgit doctor [--fix] [--porcelain]"],
  flags: {
    fix: { type: "boolean", description: "repair everything that is repairable" },
    porcelain: { type: "boolean", description: "`severityTABidTABfixableTABpathNUL` records" },
  },
  description: [
    "Checks every invariant overgit depends on: the skip-worktree bits, the managed",
    "exclude block, whether each owned path's work-tree bytes still match the overlay,",
    "whether a whiteout has been resurrected, whether the base has started tracking a path",
    "the overlay added, and whether a sync was interrupted.",
    "",
    "Each finding names the observed fact and the command that fixes it. `--fix` runs",
    "those repairs; anything it cannot fix is reported and left alone. Nothing is deleted",
    "without a copy under .overgit/local/backups/.",
    "",
    "Exit codes: 0 clean; 4 problems found (or problems remaining after `--fix`).",
    "That makes `overgit doctor` usable as a CI check.",
  ],
  examples: [
    { cmd: "overgit doctor", what: "what is wrong?" },
    { cmd: "overgit doctor --fix", what: "put it right" },
  ],
  async run(env: Env): Promise<number> {
    rejectArgs(env.args, "doctor");
    const fix = boolFlag(env.args, "fix");
    const porcelain = boolFlag(env.args, "porcelain");

    // Deliberately NOT `requireOverlay`. `clean-unprotected` — the one failure whose
    // consequence is unrecoverable — fires precisely when the overlay does not look healthy,
    // and gating on that made the check unreachable through the CLI: the user got
    // "no overlay, run `overgit init`" while `git clean -xfd` was poised to delete
    // `.overgit/` and everything in it. `diagnose` handles the missing-overlay case itself.
    const ctx = await openContext(env, { requireOverlay: false });
    const { diagnose, repair } = await import("../../doctor.ts");

    const found = await diagnose(ctx);
    let problems = found;
    let fixed: Problem[] = [];
    let backups: string[] = [];

    if (fix && found.length > 0) {
      const result = await withLock(ctx, () => repair(ctx, found));
      fixed = result.fixed;
      problems = result.remaining;
      backups = result.backups;
    }

    if (porcelain) {
      env.ui.raw(
        problems
          .map((p) => `${p.severity}\t${p.id}\t${p.fixable ? 1 : 0}\t${p.path ?? ""}\0`)
          .join(""),
      );
      return problems.length > 0 ? EXIT.PROBLEMS : EXIT.OK;
    }

    if (fix) {
      env.ui.say(
        fixed.length > 0 ? `fixed ${plural(fixed.length, "problem")}` : "nothing to fix",
      );
      if (fixed.length > 0) {
        env.ui.sayAll(columns(fixed.map((p) => [p.id, p.path === undefined ? "" : displayPath(p.path)])));
      }
      reportBackups(env.ui, backups);
      if (problems.length > 0) env.ui.say("");
    }

    if (problems.length === 0) {
      env.ui.say(fix ? "no problems remain" : "no problems found");
      return EXIT.OK;
    }

    for (const p of problems) for (const line of renderProblem(env.ui, p)) env.ui.print(line);

    const fixable = problems.filter((p) => p.fixable).length;
    env.ui.print("");
    env.ui.print(
      fix
        ? `${plural(problems.length, "problem")} could not be fixed automatically`
        : fixable > 0
          ? `${plural(problems.length, "problem")} (${fixable} fixable) — run \`overgit doctor --fix\``
          : problems.length === 1
            ? "1 problem, not fixable automatically"
            : `${problems.length} problems, none of them fixable automatically`,
    );

    // An in-progress sync is a *state*, not an inconsistency: the user is mid-workflow and
    // the tool told them to be. Reporting it is right; making `doctor` exit 4 for it is not,
    // because the documented "use `overgit doctor` in a script to test for problems" pattern
    // would then fire spuriously every time someone is part-way through a conflict.
    const onlyTransient = problems.every((p) => p.id === "sync-in-progress");
    return onlyTransient ? EXIT.OK : EXIT.PROBLEMS;
  },
};
