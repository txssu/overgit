/**
 * Entry point: global options, dispatch, and the single place errors become exit codes.
 *
 * The global options are merged into each command's own flag table rather than being
 * stripped out of argv beforehand. That matters: a naive pre-scan would eat the `-q` in
 * `overgit commit -m -q`, because it does not know that `-m` takes a value. Letting the
 * real parser see both sets at once makes that impossible.
 *
 * Passthrough commands (`git`, `log`, `diff`, `push`, `pull`, `fetch`) are the exception —
 * their argv belongs to git, so global options have to come *before* the command name.
 */

import { isAbsolute, resolve } from "node:path";

import pkg from "../../package.json" with { type: "json" };
import { EXIT, OvergitError } from "../errors.ts";
import { Ui, type ColorMode } from "../ui.ts";
import { boolFlag, listFlag, parseArgs, stringFlag, suggest, usageError, type FlagSpecs, type ParsedArgs } from "./args.ts";
import type { CommandSpec, Env, Globals } from "./command.ts";
import { helpFor, topLevelHelp } from "./help.ts";
import { COMMANDS, findCommand } from "./registry.ts";

const GLOBAL_FLAGS: FlagSpecs = {
  quiet: { type: "boolean", short: "q", description: "suppress progress output", hidden: true },
  color: {
    type: "string",
    value: "<when>",
    choices: ["auto", "always", "never"],
    description: "when to colour",
    hidden: true,
  },
  "no-color": { type: "boolean", description: "never colour", hidden: true },
  help: { type: "boolean", short: "h", description: "show help", hidden: true },
  directory: {
    type: "string",
    short: "C",
    value: "<dir>",
    many: true,
    description: "run as if started in <dir>",
    hidden: true,
  },
};

const TOP_FLAGS: FlagSpecs = {
  ...GLOBAL_FLAGS,
  version: { type: "boolean", short: "V", description: "print the version", hidden: true },
};

function globalsFrom(p: ParsedArgs, base?: Globals): Globals {
  const color: ColorMode = boolFlag(p, "no-color")
    ? "never"
    : ((stringFlag(p, "color") as ColorMode | undefined) ?? base?.color ?? "auto");
  const dirs = listFlag(p, "directory");
  const directory = dirs.length > 0 ? dirs : base?.directory !== undefined ? [base.directory] : [];
  const g: Globals = {
    color,
    quiet: boolFlag(p, "quiet") || (base?.quiet ?? false),
  };
  const merged = resolveDirs(directory, base?.directory);
  if (merged !== undefined) g.directory = merged;
  return g;
}

/** `-C a -C b` composes, exactly as it does in git. */
function resolveDirs(dirs: string[], seed?: string): string | undefined {
  let cur = seed;
  for (const d of dirs) {
    cur = cur === undefined ? resolve(process.cwd(), d) : isAbsolute(d) ? resolve(d) : resolve(cur, d);
  }
  return cur;
}

/** Split argv into the options before the command, the command name, and the rest. */
function splitArgv(argv: string[]): { pre: string[]; name?: string; rest: string[] } {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) return { pre: argv.slice(0, i), name: a, rest: argv.slice(i + 1) };
    // A global option that takes a value swallows the next token, which would otherwise
    // look like the command name.
    if (a === "-C" || a === "--directory" || a === "--color") i++;
  }
  return { pre: argv, rest: [] };
}

function wantsHelp(spec: CommandSpec, rest: string[]): boolean {
  if (!spec.passthrough) return false;
  return rest[0] === "--help" || rest[0] === "-h";
}

/** Holds the most specific `Ui` we have built so far, so errors are rendered with it. */
interface UiSlot {
  ui: Ui;
}

async function dispatch(argv: string[], slot: UiSlot): Promise<number> {
  const { pre, name, rest } = splitArgv(argv);
  const preParsed = parseArgs(pre, TOP_FLAGS, "");
  let globals = globalsFrom(preParsed);
  let ui = new Ui({ color: globals.color, quiet: globals.quiet });
  slot.ui = ui;

  if (name === undefined) {
    if (boolFlag(preParsed, "version")) {
      ui.print(`overgit ${pkg.version}`);
      return EXIT.OK;
    }
    for (const line of topLevelHelp(ui)) ui.print(line);
    return EXIT.OK;
  }

  if (boolFlag(preParsed, "version")) {
    ui.print(`overgit ${pkg.version}`);
    return EXIT.OK;
  }

  if (name === "help") {
    for (const line of helpFor(ui, rest[0])) ui.print(line);
    return EXIT.OK;
  }

  const spec = findCommand(name);
  if (spec === undefined) {
    const near = suggest(
      name,
      COMMANDS.map((c) => c.name),
    );
    throw usageError(
      `\`${name}\` is not an overgit command`,
      near !== null
        ? `did you mean \`overgit ${near}\`?  (\`overgit help\` lists them all)`
        : "run `overgit help` for the command list",
    );
  }

  if (boolFlag(preParsed, "help") || wantsHelp(spec, rest)) {
    for (const line of helpFor(ui, spec.name)) ui.print(line);
    return EXIT.OK;
  }

  const args: ParsedArgs = spec.passthrough
    ? { flags: {}, positional: [] }
    : parseArgs(rest, { ...spec.flags, ...GLOBAL_FLAGS }, spec.name);

  if (!spec.passthrough) {
    globals = globalsFrom(args, globals);
    ui = new Ui({ color: globals.color, quiet: globals.quiet });
    slot.ui = ui;
    if (boolFlag(args, "help")) {
      for (const line of helpFor(ui, spec.name)) ui.print(line);
      return EXIT.OK;
    }
  }

  const cwd = globals.directory ?? process.cwd();
  const env: Env = { ui, cwd, args, argv: rest, globals };
  return spec.run(env);
}

/**
 * Never throws. Sets `process.exitCode` and returns it, so `bin/overgit` is a two-liner and
 * a test can import nothing and still get the real behaviour by spawning it.
 */
export async function main(argv: string[]): Promise<number> {
  const slot: UiSlot = { ui: new Ui() };
  let code: number = EXIT.OK;
  try {
    code = await dispatch(argv, slot);
  } catch (e) {
    slot.ui.reportError(e);
    code = e instanceof OvergitError ? e.exitCode : EXIT.ERROR;
  }
  process.exitCode = code;
  return code;
}
