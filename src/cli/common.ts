/**
 * Helpers shared by more than one command: opening the two repositories, and turning the
 * engines' report objects into something a person can read.
 */

import { baseOperationInProgress, discover, type Context } from "../context.ts";
import { OvergitError } from "../errors.ts";
import { toRepoPath } from "../paths.ts";
import type { ApplyReport, OwnershipResult } from "../ownership.ts";
import { columns, displayPath, plural, type Ui } from "../ui.ts";
import type { Env } from "./command.ts";

/** Open the base (and, when asked, insist there is an overlay). */
export function openContext(env: Env, opts?: { requireOverlay?: boolean }): Promise<Context> {
  return discover(env.cwd, opts);
}

/**
 * Refuse to change what the overlay owns while the base is mid-merge/rebase.
 *
 * During a conflicted merge the base's index holds stage-1/2/3 entries: `update-index
 * --skip-worktree` fails on them, `HEAD:<path>` is not the blob the user is looking at, and
 * "the base's version" is not yet a single thing. Recording ownership against that state
 * would produce a manifest that is quietly wrong.
 *
 * `doctor` reports the same state instead of refusing, because being able to diagnose a
 * work-tree mid-merge is the point of it.
 */
export async function assertBaseIdle(ctx: Context, command: string): Promise<void> {
  const op = await baseOperationInProgress(ctx);
  if (op === null) return;
  throw new OvergitError(
    "DIRTY_WORKTREE",
    `the base repository is in the middle of ${op.what}, so \`overgit ${command}\` cannot record what it owns`,
    {
      hint: `${op.remedy}, then re-run \`overgit ${command}\``,
      details: [
        "during a conflicted merge the base's index holds several versions of a path,",
        "so there is no single “the base's version” to fork from",
      ],
    },
  );
}

/** Normalise user-supplied paths to repo-relative POSIX, in the order given. */
export function repoPaths(ctx: Context, inputs: string[]): string[] {
  return inputs.map((p) => toRepoPath(ctx.root, ctx.cwd, p));
}

/* ------------------------------------------------------------------ ownership */

const TO_LABEL: Record<string, string> = {
  add: "add",
  override: "override",
  delete: "delete",
  // "release" is internal jargon: the user ran `restore`, and what they care about is that
  // the base owns the path again.
  none: "back to base",
};

const FROM_DETAIL: Record<string, string> = {
  base: "was tracked by the base",
  untracked: "was untracked",
  absent: "did not exist",
  add: "was an overlay add",
  override: "was an override",
  delete: "was a whiteout",
};

/**
 * Print what an ownership operation actually did. Every line names the path and says which
 * of the three overlay powers now applies to it, because "added" on its own does not
 * distinguish `add` from `override` — and that distinction is the whole tool.
 */
export function reportOwnership(ui: Ui, result: OwnershipResult, verb: string): void {
  const rows = result.changes.map((c) => [
    TO_LABEL[c.to] ?? c.to,
    displayPath(c.path),
    FROM_DETAIL[c.from] ?? "",
  ]);
  if (rows.length > 0) {
    ui.say(`${verb} ${plural(rows.length, "path")}:`);
    ui.sayAll(columns(rows));
  } else {
    ui.say("nothing to do");
  }

  if (result.skipped.length > 0) {
    ui.say("");
    ui.say(`skipped ${plural(result.skipped.length, "path")}:`);
    ui.sayAll(columns(result.skipped.map((s) => [displayPath(s.path), s.reason])));
  }

  reportBackups(ui, result.backups);
}

/**
 * Backups are never chatter: they are the only record of bytes overgit moved out of the
 * way, so they go to stderr and survive `--quiet`.
 */
export function reportBackups(ui: Ui, backups: string[]): void {
  if (backups.length === 0) return;
  ui.warn(
    `saved ${plural(backups.length, "file")} that did not match what overgit expected:`,
  );
  for (const b of backups) ui.errLine(`    ${displayPath(b)}`);
}

/* ------------------------------------------------------------------ applyState */

const ACTION_LABEL: Record<string, string> = {
  "write-override": "wrote override",
  "write-add": "wrote add",
  "remove-whiteout": "removed",
  "set-skip": "hid from base",
  "clear-skip": "unhid in base",
  exclude: "exclude block",
  backup: "backed up",
  noop: "unchanged",
};

const DRY_LABEL: Record<string, string> = {
  "write-override": "would write override",
  "write-add": "would write add",
  "remove-whiteout": "would remove",
  "set-skip": "would hide from base",
  "clear-skip": "would unhide in base",
  exclude: "would rewrite exclude block",
  backup: "would back up",
  noop: "unchanged",
};

export interface ApplyRenderOptions {
  dryRun?: boolean;
  /** Headline verb, e.g. `applied` or `re-attached`. */
  verb?: string;
}

/** Render an `ApplyReport`, skipping the (usually enormous) list of no-ops. */
export function reportApply(ui: Ui, report: ApplyReport, opts: ApplyRenderOptions = {}): void {
  const labels = opts.dryRun ? DRY_LABEL : ACTION_LABEL;
  const interesting = report.actions.filter((a) => a.action !== "noop");
  const noops = report.actions.length - interesting.length;

  if (interesting.length === 0) {
    ui.say(
      noops > 0
        ? `already up to date (${plural(noops, "path")} already correct)`
        : "already up to date",
    );
    return;
  }

  const verb = opts.verb ?? (opts.dryRun ? "would change" : "changed");
  ui.say(`${verb} ${plural(interesting.length, "path")}:`);
  ui.sayAll(
    columns(
      interesting.map((a) => [
        labels[a.action] ?? a.action,
        displayPath(a.path),
        a.detail ?? "",
      ]),
    ),
  );
  if (noops > 0) ui.say(`${plural(noops, "path")} already correct`);
  reportBackups(ui, report.backups);
}

/** Explain the no-op actions `applyState` reports when it declines to touch something. */
export function warnDeclined(ui: Ui, report: ApplyReport): void {
  for (const a of report.actions) {
    if (a.action === "noop" && a.detail !== undefined) {
      ui.warn(`${displayPath(a.path)}: ${a.detail}`);
    }
  }
}
