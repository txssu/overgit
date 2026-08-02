/**
 * `init` and `clone` — the two ways an overlay comes into existence.
 *
 * `bootstrap.ts` is imported lazily so that a broken or half-written bootstrap module
 * cannot stop `overgit status` or `overgit --help` from running.
 */

import { rejectArgs, requireArgs, stringFlag, usageError } from "../args.ts";
import type { CommandSpec, Env } from "../command.ts";
import { reportApply } from "../common.ts";
import { plural } from "../../ui.ts";
import { relative } from "node:path";

export const initCommand: CommandSpec = {
  name: "init",
  summary: "create an overlay in the current base repository",
  usage: ["overgit init [--remote <url>] [--branch <name>]"],
  flags: {
    remote: { type: "string", value: "<url>", description: "set the overlay's `origin`" },
    branch: { type: "string", value: "<name>", description: "initial overlay branch name" },
  },
  description: [
    "Creates .overgit/.git — a second git repository whose work-tree is this one. Nothing",
    "in the base repository changes except .git/info/exclude, which gains a managed block",
    "hiding .overgit/ itself.",
    "",
    "The overlay owns nothing until you run `overgit add`.",
  ],
  examples: [
    { cmd: "overgit init", what: "start a local-only overlay" },
    {
      cmd: "overgit init --remote git@example.com:me/dotfiles.git",
      what: "start one you can push",
    },
  ],
  async run(env: Env): Promise<number> {
    rejectArgs(env.args, "init");
    const { initOverlay } = await import("../../bootstrap.ts");
    const remote = stringFlag(env.args, "remote");
    const branch = stringFlag(env.args, "branch");

    const { ctx, branch: head } = await initOverlay(env.cwd, {
      ...(remote !== undefined ? { remote } : {}),
      ...(branch !== undefined ? { branch } : {}),
    });

    env.ui.say(
      head === null
        ? `created an overlay in ${ctx.overlayGitDir}`
        : `created an overlay in ${ctx.overlayGitDir} on branch ${head}`,
    );
    env.ui.say("");
    env.ui.say("next:");
    env.ui.say("  overgit add <path>            take a file (override it, or add a new one)");
    env.ui.say("  overgit commit -m <message>   record it in the overlay");
    if (remote !== undefined) {
      env.ui.say("  overgit push -u origin HEAD   publish it");
    } else {
      env.ui.say("  overgit git remote add origin <url>   then `overgit push -u origin HEAD`");
    }
    return 0;
  },
};

export const cloneCommand: CommandSpec = {
  name: "clone",
  summary: "clone an overlay (and optionally its base) onto this machine",
  usage: [
    "overgit clone <overlay-url> [<dir>] [--branch <name>]",
    "overgit clone <overlay-url> --base <base-url> [<dir>] [--branch <name>]",
  ],
  flags: {
    base: {
      type: "string",
      value: "<url>",
      description: "clone this base repository first, then overlay onto it",
    },
    branch: { type: "string", value: "<name>", description: "overlay branch to check out" },
  },
  description: [
    "The fresh-machine command. With `--base` it clones the base repository too, so one",
    "line takes you from nothing to a working tree with your overlay applied.",
    "",
    "Safe to re-run: if .overgit/.git already exists and points at the same URL, nothing",
    "is re-cloned — it just re-applies the overlay. Running the documented bootstrap twice",
    "is a no-op.",
    "",
    "Content is written one path at a time, and any work-tree bytes that match neither the",
    "overlay nor the base are saved under .overgit/local/backups/ before being replaced.",
  ],
  examples: [
    {
      cmd: "overgit clone git@example.com:me/overlay.git --base git@example.com:acme/app.git app",
      what: "clone both into ./app",
    },
    { cmd: "overgit clone git@example.com:me/overlay.git", what: "overlay onto the repo you are in" },
  ],
  async run(env: Env): Promise<number> {
    const positional = requireArgs(env.args, "clone", "the overlay's URL");
    if (positional.length > 2) {
      throw usageError(
        `\`overgit clone\` takes at most an URL and a directory, but got ${positional.length} arguments`,
        "see `overgit help clone`",
      );
    }
    const { cloneOverlay } = await import("../../bootstrap.ts");
    const overlayUrl = positional[0]!;
    const dir = positional[1];
    const baseUrl = stringFlag(env.args, "base");
    const branch = stringFlag(env.args, "branch");

    const result = await cloneOverlay({
      overlayUrl,
      cwd: env.cwd,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(dir !== undefined ? { dir } : {}),
      ...(branch !== undefined ? { branch } : {}),
    });

    const where = relative(env.cwd, result.root) || ".";
    if (result.baseCloned) env.ui.say(`cloned the base into ${where}`);
    env.ui.say(
      result.alreadyPresent
        ? `the overlay was already present in ${where}`
        : `cloned the overlay into ${where}/.overgit/.git`,
    );
    if (result.recovered.length > 0) {
      env.ui.warn(`cleaned up ${result.recovered.length} leftover file(s) from an interrupted run`);
    }
    reportApply(env.ui, result.apply, { verb: "applied" });
    env.ui.say("");
    env.ui.say(
      result.owned === 0
        ? `the overlay owns nothing yet — run \`overgit add <path>\` in ${where}`
        : `the overlay owns ${plural(result.owned, "path")} — run \`overgit status\` in ${where}`,
    );
    return 0;
  },
};

export const hooksCommand: CommandSpec = {
  name: "hooks",
  summary: "install or remove the base-repo hooks that re-apply the overlay",
  usage: ["overgit hooks install", "overgit hooks uninstall"],
  flags: {},
  description: [
    "Installs a managed block into the base repository's post-merge, post-checkout and",
    "post-rewrite hooks. Each one runs `overgit apply`, which repairs the drift a base",
    "`git pull` or `git checkout` can cause (see `overgit help doctor`).",
    "",
    "Existing hook content is preserved; uninstall removes only overgit's block.",
    "",
    "Hooks are opt-in. overgit never writes to .git/hooks without this command.",
  ],
  examples: [{ cmd: "overgit hooks install", what: "keep the overlay applied automatically" }],
  async run(env: Env): Promise<number> {
    const [action, ...rest] = env.args.positional;
    if (action === undefined) {
      throw usageError(
        "`overgit hooks` needs `install` or `uninstall`",
        "run `overgit hooks install` to add them",
      );
    }
    if (rest.length > 0) {
      throw usageError(
        `\`overgit hooks ${action}\` takes no further arguments, but got \`${rest[0]}\``,
        "see `overgit help hooks`",
      );
    }
    if (action !== "install" && action !== "uninstall") {
      throw usageError(
        `\`overgit hooks\` has no subcommand \`${action}\``,
        "the subcommands are `install` and `uninstall`",
      );
    }

    const { discover } = await import("../../context.ts");
    const ctx = await discover(env.cwd, { requireOverlay: true });
    const bootstrap = await import("../../bootstrap.ts");
    const touched =
      action === "install" ? await bootstrap.hooksInstall(ctx) : await bootstrap.hooksUninstall(ctx);

    if (touched.length === 0) {
      env.ui.say(action === "install" ? "hooks were already installed" : "no overgit hooks found");
      return 0;
    }
    env.ui.say(action === "install" ? "installed:" : "removed:");
    for (const h of touched) env.ui.say(`  ${h}`);
    return 0;
  },
};
