/**
 * A small, strict option parser.
 *
 * Strict is the point: an unknown flag is a *usage* error (exit 2) with a suggestion, not
 * something silently forwarded to git. The one exception is a `passthrough` command, whose
 * argv belongs to git and is never inspected.
 *
 * Accepted forms: `--flag`, `--flag=value`, `--flag value`, `-f`, `-f value`, `-fvalue`,
 * clustered booleans (`-ab`), and `--` to stop option parsing.
 */

import { OvergitError } from "../errors.ts";

export interface FlagSpec {
  /** `boolean` takes no value; `string` requires one. */
  type: "boolean" | "string";
  short?: string;
  /** Placeholder shown in help for `string` flags, e.g. `<url>`. */
  value?: string;
  description: string;
  /** Repeatable string flags collect into an array (`--only a --only b`). */
  many?: boolean;
  /** Allowed values for a string flag; anything else is a usage error. */
  choices?: readonly string[];
  hidden?: boolean;
}

export type FlagSpecs = Record<string, FlagSpec>;

export interface ParsedArgs {
  flags: Record<string, string | string[] | boolean | undefined>;
  positional: string[];
}

/** Levenshtein distance, capped — only used to say "did you mean". */
function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

/** The closest candidate within a small edit distance, or `null`. */
export function suggest(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const c of candidates) {
    const d = distance(input, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function usage(message: string, hint?: string): OvergitError {
  return new OvergitError("USAGE", message, hint === undefined ? {} : { hint });
}

function unknownFlag(flag: string, specs: FlagSpecs, command: string): OvergitError {
  const names = Object.keys(specs)
    .filter((n) => !specs[n]!.hidden)
    .map((n) => `--${n}`);
  const near = suggest(flag.replace(/^-+/, ""), Object.keys(specs));
  // An empty `command` means the option came before the command name, so it is global.
  const helpPage = command === "" ? "overgit help" : `overgit help ${command}`;
  const where = command === "" ? "overgit" : `overgit ${command}`;
  // Global options are parsed before the command name, so `specs` is empty here — but
  // `overgit` plainly *does* take options, and saying otherwise contradicts `overgit help`.
  const globals = "-C <dir>, -q/--quiet, --color, --no-color, -h/--help, -V/--version";
  const hint = near
    ? `did you mean \`--${near}\`?  (\`${helpPage}\` lists every option)`
    : names.length > 0
      ? `\`${where}\` accepts: ${names.join(", ")} — see \`${helpPage}\``
      : command === ""
        ? `\`overgit\` accepts: ${globals} — see \`${helpPage}\``
        : `\`${where}\` takes no options — see \`${helpPage}\``;
  return usage(`unknown option \`${flag}\` for \`${where}\``, hint);
}

/**
 * Parse `argv` against `specs`.
 *
 * `command` only ever appears in error messages, so the hint can name the right help page.
 */
export function parseArgs(argv: string[], specs: FlagSpecs, command: string): ParsedArgs {
  const shorts = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.short !== undefined) shorts.set(spec.short, name);
  }

  const flags: ParsedArgs["flags"] = {};
  const positional: string[] = [];
  let noMoreOptions = false;

  const setValue = (name: string, spec: FlagSpec, raw: string, value: string): void => {
    if (spec.choices !== undefined && !spec.choices.includes(value)) {
      throw usage(
        `\`${raw}\` does not accept the value \`${value}\``,
        `valid values are: ${spec.choices.join(", ")}`,
      );
    }
    if (spec.many) {
      const prev = flags[name];
      flags[name] = Array.isArray(prev) ? [...prev, value] : [value];
    } else {
      flags[name] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (noMoreOptions || arg === "-" || !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      noMoreOptions = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq < 0 ? undefined : arg.slice(eq + 1);
      const spec = specs[name];
      if (!spec) {
        // `--no-foo` turns off a boolean `--foo`; git users expect it to work.
        const negated = name.startsWith("no-") ? specs[name.slice(3)] : undefined;
        if (negated && negated.type === "boolean" && inline === undefined) {
          flags[name.slice(3)] = false;
          continue;
        }
        throw unknownFlag(`--${name}`, specs, command);
      }
      if (spec.type === "boolean") {
        if (inline !== undefined) {
          if (inline === "true" || inline === "false") {
            flags[name] = inline === "true";
            continue;
          }
          throw usage(`\`--${name}\` is a flag and takes no value`, `drop the \`=${inline}\``);
        }
        flags[name] = true;
        continue;
      }
      if (inline !== undefined) {
        setValue(name, spec, `--${name}`, inline);
        continue;
      }
      const next = argv[++i];
      if (next === undefined) {
        throw usage(
          `\`--${name}\` needs a value`,
          `try \`--${name} ${spec.value ?? "<value>"}\``,
        );
      }
      setValue(name, spec, `--${name}`, next);
      continue;
    }

    // Short cluster: `-ab`, `-m msg`, `-mmsg`.
    const cluster = arg.slice(1);
    for (let k = 0; k < cluster.length; k++) {
      const letter = cluster[k]!;
      const name = shorts.get(letter);
      const spec = name === undefined ? undefined : specs[name];
      if (name === undefined || spec === undefined) {
        throw unknownFlag(`-${letter}`, specs, command);
      }
      if (spec.type === "boolean") {
        flags[name] = true;
        continue;
      }
      const rest = cluster.slice(k + 1);
      if (rest.length > 0) {
        setValue(name, spec, `-${letter}`, rest);
        k = cluster.length;
        break;
      }
      const next = argv[++i];
      if (next === undefined) {
        throw usage(`\`-${letter}\` needs a value`, `try \`-${letter} ${spec.value ?? "<value>"}\``);
      }
      setValue(name, spec, `-${letter}`, next);
      break;
    }
  }

  return { flags, positional };
}

/* ------------------------------------------------------------------ typed readers */

export function boolFlag(p: ParsedArgs, name: string): boolean {
  return p.flags[name] === true;
}

export function stringFlag(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags[name];
  if (v === undefined || typeof v === "boolean") return undefined;
  return Array.isArray(v) ? v[v.length - 1] : v;
}

export function listFlag(p: ParsedArgs, name: string): string[] {
  const v = p.flags[name];
  if (v === undefined || typeof v === "boolean") return [];
  return Array.isArray(v) ? v : [v];
}

/** Usage error naming the command, for "this command needs arguments". */
export function requireArgs(p: ParsedArgs, command: string, what: string): string[] {
  if (p.positional.length === 0) {
    throw usage(`\`overgit ${command}\` needs ${what}`, `see \`overgit help ${command}\``);
  }
  return p.positional;
}

export function rejectArgs(p: ParsedArgs, command: string): void {
  if (p.positional.length > 0) {
    throw usage(
      `\`overgit ${command}\` takes no arguments, but got \`${p.positional[0]}\``,
      `see \`overgit help ${command}\``,
    );
  }
}

export { usage as usageError };
