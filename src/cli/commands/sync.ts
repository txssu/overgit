/**
 * `sync` and `resolve` — reconciling the overlay with a base that has moved on.
 *
 * `sync` is a three-way merge per overridden path, with the recorded `baseBlob` as the
 * merge base. Two situations are never decided automatically because either answer loses
 * information: upstream deleted a file you override, and the base started tracking a path
 * you added. Those become *decisions*, and `resolve` is how you make them.
 */

import { withLock } from "../../context.ts";
import { EXIT, OvergitError } from "../../errors.ts";
import { entryOf, readManifest } from "../../manifest.ts";
import type { PlanItem, Situation, SyncReport } from "../../sync.ts";
import { boolFlag, listFlag, rejectArgs, requireArgs, stringFlag, usageError } from "../args.ts";
import type { CommandSpec, Env } from "../command.ts";
import { openContext, reportBackups, repoPaths } from "../common.ts";
import { columns, displayPath, plural, type Ui } from "../../ui.ts";
import { baseUpstreamState } from "../../status.ts";
import { ownedPaths } from "../../manifest.ts";
import type { Context } from "../../context.ts";

/**
 * "already up to date" is only true relative to the base's **HEAD**. Between a `git fetch`
 * and a `git pull` the change is already in the base's refs, and reporting "up to date"
 * about a file upstream demonstrably changed is a wrong answer, not merely a quiet one.
 * Returns the caveat lines to print alongside, or `[]` when there is genuinely nothing.
 */
async function unpulledNote(ctx: Context, ui: Ui): Promise<string[]> {
  const m = await readManifest(ctx).catch(() => null);
  if (m === null) return [];
  const bu = await baseUpstreamState(ctx, ownedPaths(m));
  if (bu.name === null || bu.behind <= 0) return [];
  const head = `${bu.name} is ${plural(bu.behind, "commit")} ahead and has not been pulled`;
  if (bu.touchesOwned.length === 0) {
    return ["", ui.s(head, "yellow"), "  none of it touches a path the overlay owns"];
  }
  return [
    "",
    ui.s(head, "yellow", "bold"),
    ...bu.touchesOwned.map((p) => `  ${displayPath(p)}  the overlay owns this one`),
    "  run `overgit detach`, `git pull`, `overgit attach`, then `overgit sync`",
  ];
}

const SITUATION_TEXT: Record<Situation, string> = {
  "up-to-date": "nothing changed upstream",
  "clean-merge": "the base's changes merge cleanly",
  conflict: "the base's changes conflict with yours",
  "upstream-deleted": "the base no longer tracks this path",
  "add-collision": "the base has started tracking a path the overlay added",
  "binary-conflict": "binary or symlink content diverged; it cannot be merged as text",
  "whiteout-upstream-changed": "the base changed a file the overlay hides",
  "local-missing": "the overlay's content is missing from the work-tree",
};

/** What the user can actually choose, per undecidable situation. */
const DECISIONS: Partial<Record<Situation, [string, string][]>> = {
  "upstream-deleted": [
    ["--keep", "keep your version; the overlay owns it outright"],
    ["--drop", "let the deletion stand; the overlay stops owning it"],
  ],
  "add-collision": [
    ["--adopt", "keep yours as an override of the base's new file"],
    ["--take-upstream", "discard yours and use the base's"],
    ["--drop", "stop owning the path entirely"],
  ],
  conflict: [
    ["--keep", "keep your version wholesale"],
    ["--take-upstream", "take the base's version wholesale"],
  ],
  // No markers can exist in binary content or a symlink target, so there is nothing to
  // hand-edit — the only honest options are the two wholesale ones.
  "binary-conflict": [
    ["--keep", "keep your version; upstream's revision is discarded"],
    ["--take-upstream", "take the base's version; yours is backed up first"],
  ],
  "local-missing": [["", "run `overgit apply` first — sync will not merge into a missing file"]],
};

function reportPlanItems(ui: Ui, items: PlanItem[], heading: string, first = false): void {
  if (items.length === 0) return;
  if (!first) ui.say("");
  ui.say(ui.s(heading, "bold"));
  ui.sayAll(
    columns(
      items.map((i) => [
        i.kind,
        displayPath(i.path),
        i.detail ?? SITUATION_TEXT[i.situation] ?? i.situation,
      ]),
    ),
  );
}

function reportDecisions(ui: Ui, items: PlanItem[]): void {
  if (items.length === 0) return;
  ui.say("");
  ui.say(ui.s(`${plural(items.length, "path")} need a decision`, "yellow", "bold"));
  for (const item of items) {
    ui.say(`  ${displayPath(item.path)}  ${ui.s(SITUATION_TEXT[item.situation] ?? "", "dim")}`);
    for (const [flag, what] of DECISIONS[item.situation] ?? []) {
      ui.say(
        flag === ""
          ? `      ${what}`
          : `      overgit resolve ${flag} ${displayPath(item.path)}`.padEnd(48) + `  ${what}`,
      );
    }
  }
}

function reportSync(ui: Ui, r: SyncReport, note: string[] = []): number {
  if (r.alreadyFinished) {
    ui.say("the sync is already finished — nothing to continue");
    return EXIT.OK;
  }
  let said = false;
  if (r.merged.length > 0) {
    said = true;
    ui.say(`merged ${plural(r.merged.length, "path")}:`);
    for (const p of r.merged) ui.say(`  ${displayPath(p)}`);
  }
  if (r.whiteoutsRepaired.length > 0) {
    said = true;
    ui.say(`re-hid ${plural(r.whiteoutsRepaired.length, "whiteout")} the base had changed:`);
    for (const p of r.whiteoutsRepaired) ui.say(`  ${displayPath(p)}`);
  }
  if (r.conflicted.length > 0) {
    said = true;
    ui.say("");
    ui.say(ui.s(`${plural(r.conflicted.length, "path")} conflicted`, "red", "bold"));
    for (const p of r.conflicted) ui.say(`  ${displayPath(p)}`);
    ui.say("  the work-tree files hold conflict markers. Edit them, then");
    ui.say("  `overgit resolve <path>...` and `overgit sync --continue`.");
    ui.say("  Shortcuts: `overgit resolve --keep <path>` keeps yours,");
    ui.say("             `overgit resolve --take-upstream <path>` takes the base's.");
  }
  if (r.pendingDecision.length > 0) said = true;
  reportDecisions(ui, r.pendingDecision);

  for (const s of r.skipped) ui.warn(`${displayPath(s.path)}: ${s.reason}`);
  reportBackups(ui, r.backups);

  if (!said) {
    ui.say(
      r.unchanged.length > 0
        ? `already up to date (${plural(r.unchanged.length, "path")} checked)`
        : "already up to date",
    );
    for (const line of note) ui.say(line);
  }
  return r.conflicted.length > 0 || r.pendingDecision.length > 0 ? EXIT.PENDING : EXIT.OK;
}

export const syncCommand: CommandSpec = {
  name: "sync",
  summary: "merge the base's upstream changes into the overlay's overrides",
  usage: [
    "overgit sync [--only <path>]... [--style merge|diff3|zdiff3]",
    "overgit sync --dry-run",
    "overgit sync --continue | --abort",
  ],
  flags: {
    "dry-run": {
      type: "boolean",
      short: "n",
      description: "show the plan and exit 4 if anything needs doing",
    },
    continue: { type: "boolean", description: "finish a sync after resolving its conflicts" },
    abort: { type: "boolean", description: "undo an in-progress sync completely" },
    only: { type: "string", value: "<path>", many: true, description: "sync just this path" },
    style: {
      type: "string",
      value: "<style>",
      description: "conflict marker style",
      choices: ["merge", "diff3", "zdiff3"],
    },
  },
  description: [
    "When you override a file, overgit records the base blob you forked from. `sync`",
    "three-way merges the base's current content against that fork point and your version,",
    "exactly as `git merge-file` would.",
    "",
    "A conflict leaves real conflict markers in the work-tree file and blocks nothing else:",
    "every other path still syncs, and `overgit status` and `overgit doctor` keep working.",
    "Edit the file, then `overgit resolve <path>` and `overgit sync --continue`.",
    "",
    "Three situations are never decided for you: upstream deleted a file you override,",
    "upstream added a path you had added, and a binary or symlink that diverged three",
    "ways. Each is answered with a flag; see `overgit help resolve`.",
    "",
    "Exit codes: 0 done; 3 conflicts or decisions pending; 4 `--dry-run` found work to do.",
  ],
  examples: [
    { cmd: "overgit sync --dry-run", what: "what would change? (exit 4 = something would)" },
    { cmd: "overgit sync", what: "merge upstream into every override" },
    { cmd: "overgit sync --style diff3", what: "conflict markers that show the fork point" },
  ],
  async run(env: Env): Promise<number> {
    rejectArgs(env.args, "sync");
    const dryRun = boolFlag(env.args, "dry-run");
    const cont = boolFlag(env.args, "continue");
    const abort = boolFlag(env.args, "abort");
    const only = listFlag(env.args, "only");
    const style = stringFlag(env.args, "style") as "merge" | "diff3" | "zdiff3" | undefined;

    const modes = [dryRun && "--dry-run", cont && "--continue", abort && "--abort"].filter(Boolean);
    if (modes.length > 1) {
      throw usageError(
        `\`overgit sync\` cannot do ${modes.join(" and ")} at once`,
        "pick one",
      );
    }

    const ctx = await openContext(env, { requireOverlay: true });
    const sync = await import("../../sync.ts");

    if (abort) {
      await withLock(ctx, () => sync.abortSync(ctx));
      env.ui.say("aborted the sync; every file is back where it was");
      return EXIT.OK;
    }

    if (dryRun) {
      const plan = await sync.planSync(ctx);
      const todo = plan.items.filter((i) => i.situation !== "up-to-date");
      if (todo.length === 0) {
        env.ui.say("already up to date with the base's current HEAD");
        for (const line of await unpulledNote(ctx, env.ui)) env.ui.say(line);
        return EXIT.OK;
      }
      reportPlanItems(env.ui, plan.clean, "would merge cleanly", true);
      reportPlanItems(env.ui, plan.conflicts, "would conflict", plan.clean.length === 0);
      reportPlanItems(
        env.ui,
        plan.blocked,
        "cannot be synced yet",
        plan.clean.length === 0 && plan.conflicts.length === 0,
      );
      reportDecisions(env.ui, plan.needsDecision);
      env.ui.say("");
      env.ui.say(
        `${plural(todo.length, "path")} ${todo.length === 1 ? "needs" : "need"} attention — run \`overgit sync\``,
      );
      return EXIT.PROBLEMS;
    }

    const report = await withLock(ctx, () =>
      cont
        ? sync.continueSync(ctx)
        : sync.runSync(ctx, {
            ...(only.length > 0 ? { only: repoPaths(ctx, only) } : {}),
            ...(style !== undefined ? { style } : {}),
          }),
    );
    return reportSync(env.ui, report, await unpulledNote(ctx, env.ui));
  },
};

const DECISION_FLAGS = ["keep", "drop", "adopt", "take-upstream"] as const;

export const resolveCommand: CommandSpec = {
  name: "resolve",
  summary: "mark a conflicted path resolved, or answer a pending decision",
  usage: [
    "overgit resolve <path>...",
    "overgit resolve --keep|--drop|--adopt|--take-upstream <path>...",
  ],
  flags: {
    keep: {
      type: "boolean",
      description: "upstream deleted it: keep your version (it becomes an overlay `add`)",
    },
    drop: { type: "boolean", description: "stop owning the path entirely" },
    adopt: {
      type: "boolean",
      description: "the base now tracks your added path: keep yours as an override of it",
    },
    "take-upstream": {
      type: "boolean",
      description: "discard the overlay's version and use the base's",
    },
    force: {
      type: "boolean",
      short: "f",
      description: "accept a file that still contains conflict markers",
    },
  },
  description: [
    "With no flag, this marks conflicted paths resolved: overgit takes whatever is in the",
    "work-tree now as the merged result and advances the recorded fork point. Run",
    "`overgit sync --continue` afterwards.",
    "",
    "With a flag it answers a decision `sync` refused to make:",
    "",
    "  --keep           the base deleted a file you override. Your content survives as an",
    "                   overlay `add` — the overlay owns it outright from now on.",
    "                   On a whited-out path this instead keeps the whiteout.",
    "  --drop           the overlay stops owning the path. The base's answer wins.",
    "  --adopt          the base started tracking a path you had added. Your version",
    "                   becomes an override of the base's new file; a three-way merge is",
    "                   attempted and may itself conflict.",
    "  --take-upstream  throw away the overlay's version and use the base's. The bytes",
    "                   being discarded are backed up first.",
  ],
  examples: [
    { cmd: "overgit resolve src/config.ts", what: "I fixed the conflict markers by hand" },
    { cmd: "overgit resolve --keep docs/legacy.md", what: "upstream deleted it; I want mine" },
    { cmd: "overgit resolve --adopt scripts/dev.sh", what: "the base added it too; merge" },
  ],
  async run(env: Env): Promise<number> {
    const chosen = DECISION_FLAGS.filter((f) => boolFlag(env.args, f));
    if (chosen.length > 1) {
      throw usageError(
        `\`overgit resolve\` takes one decision, but got --${chosen.join(" and --")}`,
        "pick one; see `overgit help resolve`",
      );
    }
    const inputs = requireArgs(env.args, "resolve", "at least one path");

    const ctx = await openContext(env, { requireOverlay: true });
    const paths = repoPaths(ctx, inputs);
    const sync = await import("../../sync.ts");

    if (chosen.length === 0) {
      const force = boolFlag(env.args, "force");
      const report = await withLock(ctx, () => sync.markResolved(ctx, paths, { force }));
      env.ui.say(`marked ${plural(paths.length, "path")} resolved:`);
      for (const p of paths) env.ui.say(`  ${displayPath(p)}`);
      reportBackups(env.ui, report.backups);
      env.ui.say("");
      env.ui.say(
        report.syncInProgress
          ? "run `overgit sync --continue` to finish"
          : "the sync is finished",
      );
      return EXIT.OK;
    }

    const flag = chosen[0]!;
    const manifest = await readManifest(ctx);
    const backups: string[] = [];
    await withLock(ctx, async () => {
      for (const p of paths) {
        const entry = entryOf(manifest, p);
        if (entry === undefined) {
          throw new OvergitError("NOT_OWNED", `the overlay does not own ${p}`, {
            hint: "run `overgit list` to see what it owns",
            paths: [p],
          });
        }
        // `keep` on a whiteout means "the whiteout survives" — the same intent under a
        // different name, so the CLI keeps one flag and picks the right verb.
        const decision = flag === "keep" && entry.kind === "delete" ? "keep-whiteout" : flag;
        const report = await sync.decide(ctx, p, decision);
        backups.push(...report.backups);
      }
    });

    env.ui.say(`applied --${flag} to ${plural(paths.length, "path")}:`);
    for (const p of paths) env.ui.say(`  ${displayPath(p)}`);
    reportBackups(env.ui, backups);
    return EXIT.OK;
  },
};
