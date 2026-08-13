/**
 * The command table. Order here is the order in `overgit help`, grouped by the question
 * the user is trying to answer rather than alphabetically.
 */

import type { CommandSpec } from "./command.ts";
import { cloneCommand, hooksCommand, initCommand } from "./commands/bootstrap.ts";
import {
  diffCommand,
  listCommand,
  logCommand,
  statusCommand,
  whichCommand,
} from "./commands/inspect.ts";
import {
  commitCommand,
  fetchCommand,
  gitCommand,
  pullCommand,
  pushCommand,
} from "./commands/overlay-git.ts";
import { addCommand, restoreCommand, rmCommand } from "./commands/ownership.ts";
import { applyCommand, detachCommand, doctorCommand } from "./commands/state.ts";
import { resolveCommand, syncCommand } from "./commands/sync.ts";

export interface Group {
  title: string;
  commands: CommandSpec[];
}

export const GROUPS: Group[] = [
  { title: "starting out", commands: [initCommand, cloneCommand] },
  { title: "what the overlay owns", commands: [addCommand, rmCommand, restoreCommand, listCommand, whichCommand] },
  { title: "looking at it", commands: [statusCommand, diffCommand, logCommand] },
  { title: "the overlay's history", commands: [commitCommand, pushCommand, pullCommand, fetchCommand] },
  {
    title: "keeping up with the base",
    commands: [syncCommand, resolveCommand, applyCommand, detachCommand],
  },
  { title: "when something is wrong", commands: [doctorCommand, hooksCommand, gitCommand] },
];

export const COMMANDS: CommandSpec[] = GROUPS.flatMap((g) => g.commands);

const BY_NAME = new Map<string, CommandSpec>();
for (const c of COMMANDS) {
  BY_NAME.set(c.name, c);
  for (const a of c.aliases ?? []) BY_NAME.set(a, c);
}

export function findCommand(name: string): CommandSpec | undefined {
  return BY_NAME.get(name);
}
