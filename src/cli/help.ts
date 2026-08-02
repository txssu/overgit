/**
 * Help text, generated from the command table.
 *
 * Nothing here restates a flag by hand: the option list in `overgit help <cmd>` is the same
 * `FlagSpecs` object the parser uses, so a flag that exists is documented and a flag that is
 * documented parses. The only prose is the `description` and `examples` a command declares.
 */

import { columns, type Ui } from "../ui.ts";
import type { CommandSpec } from "./command.ts";
import { COMMANDS, GROUPS, findCommand } from "./registry.ts";
import { suggest, usageError } from "./args.ts";

const TAGLINE = "layer one git repository on top of another in a single working directory";

const MENTAL_MODEL = [
  "One working directory, two repositories. The base is an ordinary clone at the root and",
  "overgit never commits to it. The overlay lives in .overgit/.git, shares the same",
  "work-tree, and has three powers over it:",
  "",
  "  add        a file the base cannot see at all (it is in .git/info/exclude)",
  "  override   your version of a file the base tracks (the base still thinks it is clean)",
  "  delete     a file the base tracks, hidden from the work-tree",
  "",
  "Like OverlayFS, but the layers are git repositories, so the upper one has a history you",
  "can commit, push, and clone onto another machine.",
];

const GLOBAL_OPTIONS: [string, string][] = [
  ["-C <dir>", "run as if overgit had been started in <dir>"],
  ["-q, --quiet", "suppress progress and summaries (never errors or warnings)"],
  ["--no-color", "never colour the output (same as --color=never or NO_COLOR=1)"],
  ["--color=<when>", "auto (the default), always, never"],
  ["-h, --help", "this text; `overgit help <command>` for one command"],
  ["-V, --version", "print the version and exit"],
];

const EXIT_CODES: [string, string][] = [
  ["0", "ok"],
  ["1", "error"],
  ["2", "usage error"],
  ["3", "conflicts or decisions are pending"],
  ["4", "doctor found problems, or a --dry-run found drift"],
];

const TOP_EXAMPLES: [string, string][] = [
  ["overgit init", "start an overlay in the repo you are in"],
  ["overgit add .envrc", "hide a personal file from the base entirely"],
  ["overgit add src/config.ts", "override a file the base tracks"],
  ["overgit rm docs/legacy.md", "make a tracked file disappear locally"],
  ['overgit commit -m "my local setup"', "record it in the overlay"],
  ["overgit push -u origin main", "publish the overlay"],
  ["", ""],
  ["overgit clone <overlay-url> --base <base-url> app", "reproduce all of it elsewhere"],
];

export function topLevelHelp(ui: Ui): string[] {
  const out: string[] = [];
  const head = (t: string): string => ui.s(t, "bold");

  out.push(`${ui.s("overgit", "bold")} — ${TAGLINE}`);
  out.push("");
  out.push(...MENTAL_MODEL);
  out.push("");
  out.push(`${head("usage")}  overgit [<global-options>] <command> [<args>...]`);

  for (const group of GROUPS) {
    const visible = group.commands.filter((c) => !c.hidden);
    if (visible.length === 0) continue;
    out.push("");
    out.push(head(group.title));
    out.push(...columns(visible.map((c) => [c.name, c.summary])));
  }

  out.push("");
  out.push(head("examples"));
  out.push(...columns(TOP_EXAMPLES.map(([cmd, what]) => [cmd, what])));

  out.push("");
  out.push(head("global options"));
  out.push(...columns(GLOBAL_OPTIONS.map(([f, d]) => [f, d])));

  out.push("");
  out.push(head("exit codes"));
  out.push(...columns(EXIT_CODES.map(([c, d]) => [c, d])));

  out.push("");
  out.push("`overgit help <command>` explains any command in detail.");
  return out;
}

function optionLines(spec: CommandSpec): string[][] {
  const rows: string[][] = [];
  for (const [name, flag] of Object.entries(spec.flags)) {
    if (flag.hidden) continue;
    const long = flag.type === "string" ? `--${name} ${flag.value ?? "<value>"}` : `--${name}`;
    const label = flag.short !== undefined ? `-${flag.short}, ${long}` : `    ${long}`;
    const extra = flag.choices !== undefined ? ` (${flag.choices.join(" | ")})` : "";
    rows.push([label, flag.description + extra]);
  }
  return rows;
}

export function commandHelp(ui: Ui, spec: CommandSpec): string[] {
  const out: string[] = [];
  const head = (t: string): string => ui.s(t, "bold");

  out.push(`${ui.s(`overgit ${spec.name}`, "bold")} — ${spec.summary}`);
  if (spec.aliases !== undefined && spec.aliases.length > 0) {
    out.push(`aliases: ${spec.aliases.join(", ")}`);
  }
  out.push("");
  out.push(head("usage"));
  for (const u of spec.usage) out.push(`  ${u}`);

  if (spec.description !== undefined && spec.description.length > 0) {
    out.push("");
    out.push(...spec.description);
  }

  const options = optionLines(spec);
  if (options.length > 0) {
    out.push("");
    out.push(head("options"));
    out.push(...columns(options));
  } else if (spec.passthrough) {
    out.push("");
    out.push("Every argument is handed to git untouched.");
  }

  if (spec.examples !== undefined && spec.examples.length > 0) {
    out.push("");
    out.push(head("examples"));
    out.push(...columns(spec.examples.map((e) => [e.cmd, e.what])));
  }

  out.push("");
  out.push("`overgit help` lists every command and the global options.");
  return out;
}

/** `overgit help [<command>]`. Throws a usage error naming a near miss. */
export function helpFor(ui: Ui, name?: string): string[] {
  if (name === undefined) return topLevelHelp(ui);
  const spec = findCommand(name);
  if (spec !== undefined) return commandHelp(ui, spec);
  if (name === "help") {
    return [
      `${ui.s("overgit help", "bold")} — explain a command`,
      "",
      "usage",
      "  overgit help [<command>]",
    ];
  }
  const near = suggest(
    name,
    COMMANDS.map((c) => c.name),
  );
  throw usageError(
    `there is no \`overgit ${name}\` command`,
    near !== null ? `did you mean \`overgit ${near}\`?` : "run `overgit help` for the command list",
  );
}
