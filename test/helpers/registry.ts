/**
 * Sandbox registry.
 *
 * `overgit(cwd, ...args)` and `assertBaseClean(repoDir)` have frozen signatures that take
 * only a path — no env parameter. They still have to run hermetically, so the sandbox that
 * owns a path is looked up here. The innermost registered sandbox containing the path
 * wins; a path outside every sandbox falls back to a process-wide hermetic env (still
 * isolated from `~/.gitconfig`, just shared).
 */

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { buildSandboxEnv, HOST_TMPDIR } from "./env.ts";

export interface RegisteredSandbox {
  dir: string;
  env: Record<string, string>;
}

const sandboxes: RegisteredSandbox[] = [];

export function registerSandbox(s: RegisteredSandbox): void {
  sandboxes.push(s);
}

export function unregisterSandbox(s: RegisteredSandbox): void {
  const i = sandboxes.indexOf(s);
  if (i >= 0) sandboxes.splice(i, 1);
}

/** True when `child` is `parent` or lives under it. Both must be absolute + realpath'd. */
export function isPathInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(p);
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

let fallbackEnv: Record<string, string> | undefined;

/**
 * Env for paths that belong to no sandbox.
 *
 * Creates nothing on disk: `GIT_CONFIG_GLOBAL=/dev/null` makes git ignore `$HOME`
 * entirely for configuration, and identity comes from `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.
 * A temp dir here would be process-shared and would leak, since `bun test` does not run
 * `process.on("exit")` handlers.
 */
function fallback(): Record<string, string> {
  if (!fallbackEnv) {
    const tmp = HOST_TMPDIR;
    fallbackEnv = buildSandboxEnv({
      dir: tmp,
      home: "/nonexistent-overgit-test-home",
      tmp,
      gitConfigPath: "/dev/null",
      ceiling: tmp,
    });
  }
  return fallbackEnv;
}

/** Hermetic env for a path. Never returns the parent process's environment. */
export function envForPath(p: string): Record<string, string> {
  const real = realpathOrSelf(p);
  let best: RegisteredSandbox | undefined;
  for (const s of sandboxes) {
    if (!isPathInside(s.dir, real)) continue;
    if (!best || s.dir.length > best.dir.length) best = s;
  }
  return best ? best.env : fallback();
}
