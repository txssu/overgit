/**
 * The overlay manifest: `<root>/.overgit/manifest.json`.
 *
 * This file is *tracked by the overlay*, so it is the portable description of what the
 * overlay owns. Everything else (skip-worktree bits, the exclude block, the work-tree
 * bytes) is machine-local state that `applyState()` can rebuild from it.
 *
 * Serialisation is deterministic — keys sorted byte-wise, 2-space indent, LF, trailing
 * newline — so two machines that own the same paths produce byte-identical files and
 * merges stay line-oriented.
 *
 * This module deliberately depends on nothing but `errors.ts` and the `Context` *type*.
 * Path validation here is structural (shape of the string) rather than filesystem-aware:
 * `paths.ts` owns the semantics for user-supplied input, this owns the on-disk format.
 */

import { OvergitError } from "./errors.ts";
import type { Context } from "./context.ts";

export type Entry =
  | { kind: "add" }
  | { kind: "override"; baseBlob: string }
  | { kind: "delete"; baseBlob: string };

export interface Manifest {
  version: 1;
  entries: Record<string, Entry>;
  [k: string]: unknown;
}

export const MANIFEST_VERSION = 1 as const;

const KINDS = ["add", "override", "delete"] as const;
export type Kind = Entry["kind"];

const encoder = new TextEncoder();

/* ------------------------------------------------------------------ ordering */

/**
 * Byte-wise ascending comparison of two paths, as UTF-8.
 *
 * `a < b` in JavaScript compares UTF-16 code units, which orders astral characters
 * (emoji, rare CJK) *before* U+E000..U+FFFF because of surrogate pairs. Git — and any
 * other tool that sorts filenames — compares bytes. Doing it properly keeps the manifest
 * stable no matter which machine wrote it.
 */
export function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  // Fast path: pure ASCII compares identically in both encodings.
  if (isAscii(a) && isAscii(b)) return a < b ? -1 : 1;
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    const x = ab[i]!;
    const y = bb[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return ab.length === bb.length ? 0 : ab.length < bb.length ? -1 : 1;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

function sortedKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).sort(comparePaths);
}

/* ------------------------------------------------------------------ validation */

/** True for a syntactically valid git object id (sha1 or sha256, lowercase hex). */
export function isValidBlobOid(s: unknown): s is string {
  return typeof s === "string" && (s.length === 40 || s.length === 64) && /^[0-9a-f]+$/.test(s);
}

/**
 * Structural check for a manifest key. Repo-relative POSIX, no `.`/`..` segments, no
 * leading `./`, no trailing `/`, no empty segments, never absolute, never under a
 * reserved directory. Returns a reason string when invalid, `null` when fine.
 */
export function manifestPathProblem(p: string): string | null {
  if (typeof p !== "string" || p.length === 0) return "path is empty";
  if (p.startsWith("/")) return "path is absolute";
  // A backslash is a perfectly ordinary byte in a POSIX filename (`back\slash.txt`), and
  // overgit is Linux/macOS only — so `/` is the one separator and `\` is just content.
  if (p.endsWith("/")) return "path has a trailing slash";
  if (p.includes("//")) return "path has an empty segment";
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "." || s === "..") return "path contains a `.` or `..` segment";
  }
  const first = segs[0]!.toLowerCase();
  if (first === ".git" || first === ".overgit") return `path is under the reserved directory \`${segs[0]}\``;
  if (p.includes("\0")) return "path contains a NUL byte";
  return null;
}

/* ------------------------------------------------------------------ construction */

export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, entries: {} };
}

/** Structural copy; entries are cloned so callers can mutate freely. */
export function cloneManifest(m: Manifest): Manifest {
  const out: Manifest = { ...m, version: MANIFEST_VERSION, entries: {} };
  for (const [k, v] of Object.entries(m.entries)) out.entries[k] = { ...v };
  return out;
}

/** Returns a copy of `m` with `path` set to `e`. */
export function setEntry(m: Manifest, path: string, e: Entry): Manifest {
  const out = cloneManifest(m);
  out.entries[path] = { ...e };
  return out;
}

/** Returns a copy of `m` with `path` removed. */
export function removeEntry(m: Manifest, path: string): Manifest {
  const out = cloneManifest(m);
  delete out.entries[path];
  return out;
}

/* ------------------------------------------------------------------ queries */

export function entryOf(m: Manifest, p: string): Entry | undefined {
  return Object.prototype.hasOwnProperty.call(m.entries, p) ? m.entries[p] : undefined;
}

export function ownedPaths(m: Manifest): string[] {
  return sortedKeys(m.entries);
}

export function pathsOfKind(m: Manifest, kind: Kind): string[] {
  return ownedPaths(m).filter((p) => m.entries[p]!.kind === kind);
}

/** The base blob an override/whiteout forked from, or `null` for `add` entries. */
export function baseBlobOf(m: Manifest, p: string): string | null {
  const e = entryOf(m, p);
  if (!e || e.kind === "add") return null;
  return e.baseBlob;
}

/** Paths whose mechanism is a skip-worktree bit in the base (`override` + `delete`). */
export function skipWorktreeCandidates(m: Manifest): string[] {
  return ownedPaths(m).filter((p) => m.entries[p]!.kind !== "add");
}

/* ------------------------------------------------------------------ serialisation */

/**
 * Deterministic JSON. Top-level order is `version`, `entries`, then any preserved
 * unknown keys sorted byte-wise. Entry keys are sorted byte-wise; entry fields are
 * `kind` then `baseBlob`.
 */
export function serializeManifest(m: Manifest): string {
  const known = new Set(["version", "entries"]);
  const extraKeys = sortedKeys(m).filter((k) => !known.has(k));

  const lines: string[] = ["{"];
  lines.push(`  "version": ${JSON.stringify(MANIFEST_VERSION)},`);

  const paths = ownedPaths(m);
  if (paths.length === 0) {
    lines.push(`  "entries": {}${extraKeys.length > 0 ? "," : ""}`);
  } else {
    lines.push(`  "entries": {`);
    paths.forEach((p, i) => {
      const e = m.entries[p]!;
      const fields: string[] = [`"kind": ${JSON.stringify(e.kind)}`];
      if (e.kind !== "add") fields.push(`"baseBlob": ${JSON.stringify(e.baseBlob)}`);
      lines.push(`    ${JSON.stringify(p)}: { ${fields.join(", ")} }${i === paths.length - 1 ? "" : ","}`);
    });
    lines.push(`  }${extraKeys.length > 0 ? "," : ""}`);
  }

  extraKeys.forEach((k, i) => {
    const value = indentJson(JSON.stringify(m[k], null, 2) ?? "null", "  ");
    lines.push(`  ${JSON.stringify(k)}: ${value}${i === extraKeys.length - 1 ? "" : ","}`);
  });

  lines.push("}");
  return lines.join("\n") + "\n";
}

function indentJson(json: string, indent: string): string {
  return json.split("\n").join("\n" + indent);
}

function invalid(srcPath: string, detail: string): OvergitError {
  return new OvergitError("MANIFEST_INVALID", `${srcPath} is not a valid overgit manifest: ${detail}`, {
    hint: "fix the file by hand, or run `overgit doctor --fix` to rebuild it from the overlay",
    paths: [srcPath],
  });
}

export function parseManifest(text: string, srcPath: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch (e) {
    throw new OvergitError("MANIFEST_INVALID", `${srcPath} is not valid JSON: ${(e as Error).message}`, {
      hint: "fix the file by hand, or run `overgit doctor --fix` to rebuild it from the overlay",
      paths: [srcPath],
      cause: e,
    });
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid(srcPath, "top level is not a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const version = obj["version"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw invalid(srcPath, "`version` is missing or is not an integer");
  }
  if (version !== MANIFEST_VERSION) {
    throw new OvergitError(
      "MANIFEST_VERSION",
      `${srcPath} declares manifest version ${version}, but this overgit only understands version ${MANIFEST_VERSION}`,
      { hint: "upgrade overgit (`bun add -g overgit@latest`) and try again", paths: [srcPath] },
    );
  }

  const rawEntries = obj["entries"] ?? {};
  if (rawEntries === null || typeof rawEntries !== "object" || Array.isArray(rawEntries)) {
    throw invalid(srcPath, "`entries` is not a JSON object");
  }

  const entries: Record<string, Entry> = {};
  const seenLower = new Map<string, string>();
  for (const [p, v] of Object.entries(rawEntries as Record<string, unknown>)) {
    const problem = manifestPathProblem(p);
    if (problem) throw invalid(srcPath, `entry key ${JSON.stringify(p)}: ${problem}`);

    // Two entries differing only by case cannot both exist on a case-insensitive
    // filesystem; catching it here turns a mysterious apply into a clear message.
    const lower = p.toLowerCase();
    const prev = seenLower.get(lower);
    if (prev !== undefined) {
      throw invalid(
        srcPath,
        `entries ${JSON.stringify(prev)} and ${JSON.stringify(p)} differ only by letter case`,
      );
    }
    seenLower.set(lower, p);

    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw invalid(srcPath, `entry ${JSON.stringify(p)} is not a JSON object`);
    }
    const ev = v as Record<string, unknown>;
    const kind = ev["kind"];
    if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
      throw invalid(
        srcPath,
        `entry ${JSON.stringify(p)} has kind ${JSON.stringify(kind)}; expected one of ${KINDS.join(", ")}`,
      );
    }
    if (kind === "add") {
      entries[p] = { kind: "add" };
    } else {
      const baseBlob = ev["baseBlob"];
      if (!isValidBlobOid(baseBlob)) {
        throw invalid(
          srcPath,
          `entry ${JSON.stringify(p)} (kind ${kind}) has baseBlob ${JSON.stringify(baseBlob)}; expected 40 or 64 lowercase hex characters`,
        );
      }
      entries[p] = kind === "override" ? { kind: "override", baseBlob } : { kind: "delete", baseBlob };
    }
  }

  const out: Manifest = { version: MANIFEST_VERSION, entries };
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "version" && k !== "entries") out[k] = v; // forward compatibility
  }
  return out;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/* ------------------------------------------------------------------ file i/o */

export async function readManifest(ctx: Context): Promise<Manifest> {
  const file = Bun.file(ctx.manifestPath);
  let text: string;
  try {
    if (!(await file.exists())) return emptyManifest();
    text = await file.text();
  } catch (e) {
    throw new OvergitError("IO_FAILED", `cannot read ${ctx.manifestPath}: ${(e as Error).message}`, {
      hint: "check the file's permissions",
      paths: [ctx.manifestPath],
      cause: e,
    });
  }
  if (text.trim() === "") return emptyManifest();
  return parseManifest(text, ctx.manifestPath);
}

/** Atomic: writes a sibling temp file and renames over the target. */
export async function writeManifest(ctx: Context, m: Manifest): Promise<void> {
  const { dirname } = await import("node:path");
  const fs = await import("node:fs/promises");
  const dir = dirname(ctx.manifestPath);
  const tmp = `${ctx.manifestPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, serializeManifest(m), "utf8");
    await fs.rename(tmp, ctx.manifestPath);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new OvergitError("IO_FAILED", `cannot write ${ctx.manifestPath}: ${(e as Error).message}`, {
      hint: "check that .overgit/ exists and is writable",
      paths: [ctx.manifestPath],
      cause: e,
    });
  }
}
