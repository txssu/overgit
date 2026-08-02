/**
 * The shape every command declares.
 *
 * `overgit help <command>` is generated from this table, so help text and the parser can
 * never drift apart: if a flag exists it is documented, and if it is documented it parses.
 */

import type { FlagSpecs, ParsedArgs } from "./args.ts";
import type { ColorMode, Ui } from "../ui.ts";

export interface Globals {
  color: ColorMode;
  quiet: boolean;
  /** `-C <dir>`: run as if overgit had been started there. */
  directory?: string;
}

export interface Env {
  ui: Ui;
  /** Directory the command runs in (after `-C`). Always absolute. */
  cwd: string;
  args: ParsedArgs;
  /** argv after the command name, untouched. Passthrough commands read this. */
  argv: string[];
  globals: Globals;
}

export interface Example {
  cmd: string;
  what: string;
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  /** One line, lower-case, no trailing period — shown in the command list. */
  summary: string;
  /** One or more usage lines, each starting with `overgit `. */
  usage: string[];
  flags: FlagSpecs;
  /** Paragraphs for `overgit help <name>`. Wrapped as written; keep lines short. */
  description?: string[];
  examples?: Example[];
  /** Skip flag parsing entirely; `env.argv` is the command's own argv. */
  passthrough?: boolean;
  /** Hidden from the top-level list (aliases, escape hatches). */
  hidden?: boolean;
  /** Resolves to the process exit code. Throwing is fine — `main` renders it. */
  run(env: Env): Promise<number>;
}
