/**
 * The managed block in `.git/info/exclude`.
 *
 * This is half of what makes the base blind to the overlay: every `add` path is listed
 * here, so the base does not even report it as untracked. (`override` and `delete` use
 * skip-worktree instead — see `ownership.ts`.)
 *
 * `.git/info/exclude` is a file users legitimately edit, and it is *not* in the base's
 * history, so we cannot afford to mangle it. Everything outside the markers is preserved
 * byte for byte: the block editor works on raw bytes rather than decoded strings, because
 * filenames are byte strings and need not be valid UTF-8.
 *
 * Measured on git 2.55 (see the tests in `test/manifest.test.ts`):
 *   * git strips a trailing CR from every pattern line, so a CRLF exclude file works and
 *     the managed block can always be written with LF;
 *   * git strips a UTF-8 BOM from the first line;
 *   * a missing final newline is not a problem for the last pattern;
 *   * there is **no** escape for a newline inside a pattern, and a pattern cannot end in
 *     a literal CR (the trailing-CR strip eats it). Those two filenames therefore cannot
 *     be hidden from the base at all — `ownership.ts` refuses them for `add`.
 */

import { OvergitError } from "./errors.ts";
import type { Context } from "./context.ts";
import type { Manifest } from "./manifest.ts";
import { pathsOfKind, ownedPaths, comparePaths } from "./manifest.ts";
import { gitignoreEscape } from "./paths.ts";

/**
 * Marker strings, byte-exact. Do not reformat: `doctor` finds the managed block by matching
 * these lines, so a changed one orphans every block already written to a user's repo.
 */
export const BEGIN_MARKER =
  "# >>> overgit managed block — do not edit (regenerate with `overgit doctor --fix`) >>>";
export const END_MARKER = "# <<< overgit managed block <<<";

/** Always present in the base's block: the overlay's own storage is never the base's. */
export const OVERGIT_DIR_PATTERN = "/.overgit/";

/**
 * Lines the overlay's own `info/exclude` must contain.
 *
 * `/.overgit/.git/` is belt-and-braces — git refuses to track anything under a `.git`
 * directory whatever the ignore rules say — but `/.overgit/local/` is load-bearing: it is
 * machine-local state that must never reach the overlay's history.
 */
export const OVERLAY_EXCLUDE_LINES = ["/.overgit/.git/", "/.overgit/local/"];

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

/* ------------------------------------------------------------------ pure block editing */

/**
 * The lines the base's managed block should contain for `m`: `/.overgit/` first, then one
 * anchored, escaped pattern per `add` path, sorted byte-wise.
 */
export function desiredExcludeLines(m: Manifest, baseTracks?: ReadonlySet<string>): string[] {
  // Hide by the mechanism that matches the base's *current* reality, not by the manifest's
  // historical kind. The two mechanisms are complementary and each only works in one case:
  // `.git/info/exclude` hides untracked paths and is completely inert for tracked ones,
  // while skip-worktree only exists for paths in the index.
  //
  // So a path's kind is not enough to decide. Upstream can move underneath us:
  //
  //   * an `add` whose path the base has started tracking (§6.5 add-collision) — its exclude
  //     line stops working, and writing the overlay's bytes leaves the base dirty;
  //   * an `override`/`delete` whose path the base has stopped tracking (`upstream-gone`) —
  //     its skip-worktree bit is gone with the index entry, and the overlay's bytes are then
  //     an untracked file that the next `git add -A` commits into the shared repo.
  //
  // Three independent adversarial reviews found that same leak from three directions. The
  // fix is one rule: **every owned path the base does not currently track gets an exclude
  // line**, and (in `ownership.ts`) every owned path it does track gets skip-worktree.
  // `sync` still surfaces both situations as decisions — this only stops the leak while the
  // user takes their time deciding.
  const owned =
    baseTracks === undefined
      ? pathsOfKind(m, "add")
      : ownedPaths(m).filter((p) => !baseTracks.has(p));
  return [OVERGIT_DIR_PATTERN, ...owned.sort(comparePaths).map((p) => gitignoreEscape(p))];
}

interface RawLine {
  /** Byte offset of the first byte of the line. */
  start: number;
  /** Byte offset just past the line's terminator (or the end of input). */
  end: number;
  /** Byte offset just past the line's content, before any CR/LF terminator. */
  contentEnd: number;
}

function splitLines(bytes: Uint8Array): RawLine[] {
  const out: RawLine[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      let contentEnd = i;
      if (contentEnd > start && bytes[contentEnd - 1] === 0x0d) contentEnd--;
      out.push({ start, end: i + 1, contentEnd });
      start = i + 1;
    }
  }
  if (start < bytes.length) {
    let contentEnd = bytes.length;
    if (contentEnd > start && bytes[contentEnd - 1] === 0x0d) contentEnd--;
    out.push({ start, end: bytes.length, contentEnd });
  }
  return out;
}

function lineEquals(bytes: Uint8Array, line: RawLine, want: Uint8Array): boolean {
  let s = line.start;
  let e = line.contentEnd;
  // A UTF-8 BOM only ever matters on the very first line; treat it as absent.
  if (s === 0 && e - s >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) s += 3;
  if (e - s !== want.length) return false;
  for (let i = 0; i < want.length; i++) if (bytes[s + i] !== want[i]) return false;
  return true;
}

interface FoundBlock {
  /** Byte offset where the block starts (the BEGIN line). */
  start: number;
  /** Byte offset just past the block (past the END line's terminator). */
  end: number;
  /** Byte ranges of the lines strictly between the markers. */
  inner: RawLine[];
  /** True when the file ended before an END marker was seen. */
  unterminated: boolean;
}

function findBlocks(bytes: Uint8Array): { blocks: FoundBlock[]; orphanEnds: RawLine[] } {
  const beginBytes = enc.encode(BEGIN_MARKER);
  const endBytes = enc.encode(END_MARKER);
  const lines = splitLines(bytes);
  const blocks: FoundBlock[] = [];
  const orphanEnds: RawLine[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (lineEquals(bytes, line, beginBytes)) {
      const inner: RawLine[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        const l = lines[j]!;
        if (lineEquals(bytes, l, endBytes)) {
          closed = true;
          break;
        }
        // A nested BEGIN means the previous block was never closed. Swallow it: the
        // whole run is overgit's garbage and gets replaced wholesale.
        inner.push(l);
      }
      const end = closed ? lines[j]!.end : bytes.length;
      blocks.push({ start: line.start, end, inner, unterminated: !closed });
      i = closed ? j + 1 : lines.length;
      continue;
    }
    if (lineEquals(bytes, line, endBytes)) orphanEnds.push(line);
    i++;
  }
  return { blocks, orphanEnds };
}

function renderBlock(lines: string[]): Uint8Array {
  const text = [BEGIN_MARKER, ...lines, END_MARKER].join("\n") + "\n";
  return enc.encode(text);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface BlockEditResult {
  bytes: Uint8Array;
  changed: boolean;
  /** How many managed blocks were found before the edit (>1 means a repair happened). */
  blocksFound: number;
}

/**
 * Replace (or insert, or with `lines === null` remove) the managed block in `bytes`.
 *
 * The new block goes exactly where the *first* existing block was, so a user's hand-written
 * lines keep their position relative to it. Any further blocks and any orphaned END markers
 * are removed — that is the "two blocks present → repair to one" case. Everything else is
 * copied through untouched.
 */
export function applyManagedBlock(bytes: Uint8Array, lines: string[] | null): BlockEditResult {
  const { blocks, orphanEnds } = findBlocks(bytes);

  // Byte ranges to drop, in order.
  const cuts: { start: number; end: number }[] = [
    ...blocks.map((b) => ({ start: b.start, end: b.end })),
    ...orphanEnds.map((l) => ({ start: l.start, end: l.end })),
  ].sort((a, b) => a.start - b.start);

  const insertAt = blocks.length > 0 ? blocks[0]!.start : null;
  const parts: Uint8Array[] = [];
  let cursor = 0;
  let inserted = false;

  for (const cut of cuts) {
    parts.push(bytes.subarray(cursor, cut.start));
    if (!inserted && insertAt !== null && cut.start === insertAt) {
      if (lines !== null) parts.push(renderBlock(lines));
      inserted = true;
    }
    cursor = cut.end;
  }
  parts.push(bytes.subarray(cursor));

  if (!inserted && lines !== null) {
    // Append at the end, making sure the preceding content ends with a newline. The
    // file's own line ending is irrelevant: git strips a trailing CR from every pattern.
    const tail = concat(parts);
    const needsNewline = tail.length > 0 && tail[tail.length - 1] !== 0x0a;
    const out = concat([tail, needsNewline ? enc.encode("\n") : new Uint8Array(0), renderBlock(lines)]);
    return { bytes: out, changed: !equalBytes(out, bytes), blocksFound: blocks.length };
  }

  const out = concat(parts);
  return { bytes: out, changed: !equalBytes(out, bytes), blocksFound: blocks.length };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The lines currently inside the managed block of `bytes`, or `null` when absent. */
export function readManagedBlock(bytes: Uint8Array): string[] | null {
  const { blocks } = findBlocks(bytes);
  const first = blocks[0];
  if (!first) return null;
  return first.inner.map((l) => dec.decode(bytes.subarray(l.start, l.contentEnd)));
}

/* ------------------------------------------------------------------ file i/o */

async function readBytes(path: string): Promise<Uint8Array> {
  const fs = await import("node:fs/promises");
  try {
    return new Uint8Array(await fs.readFile(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Uint8Array(0);
    throw new OvergitError("IO_FAILED", `cannot read ${path}: ${(e as Error).message}`, {
      hint: "check the file's permissions",
      paths: [path],
      cause: e,
    });
  }
}

/** Atomic write: sibling temp file, then rename. Creates parent directories. */
async function writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const fs = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const tmp = `${path}.overgit-tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new OvergitError("IO_FAILED", `cannot write ${path}: ${(e as Error).message}`, {
      hint: "check that the directory exists and is writable",
      paths: [path],
      cause: e,
    });
  }
}

function baseExcludePath(ctx: Context): string {
  return `${ctx.baseGitDir}/info/exclude`;
}

function overlayExcludePath(ctx: Context): string {
  return `${ctx.overlayGitDir}/info/exclude`;
}

/**
 * Make the base's managed block match `m`. Content outside the block is untouched.
 * Idempotent: a second call with the same manifest reports `changed: false`.
 */
export async function syncExcludeBlock(
  ctx: Context,
  m: Manifest,
  baseTracks?: ReadonlySet<string>,
): Promise<{ changed: boolean }> {
  const path = baseExcludePath(ctx);
  const before = await readBytes(path);
  // Ask the base what it actually tracks when the caller has not already looked, so the
  // exclude block reflects reality rather than the manifest's idea of it.
  const tracks =
    baseTracks ?? new Set((await ctx.base.lsFiles()).filter((e) => e.stage === 0).map((e) => e.path));
  const result = applyManagedBlock(before, desiredExcludeLines(m, tracks));
  if (!result.changed) return { changed: false };
  await writeBytesAtomic(path, result.bytes);
  return { changed: true };
}

/** The lines currently in the base's managed block, or `null` when there is no block. */
export async function currentExcludeBlock(ctx: Context): Promise<string[] | null> {
  return readManagedBlock(await readBytes(baseExcludePath(ctx)));
}

/** Remove the managed block from the base's exclude file, preserving everything else. */
export async function removeExcludeBlock(ctx: Context): Promise<void> {
  const path = baseExcludePath(ctx);
  const before = await readBytes(path);
  if (before.length === 0) return;
  const result = applyManagedBlock(before, null);
  if (result.changed) await writeBytesAtomic(path, result.bytes);
}

/**
 * Keep the overlay from ever tracking its own storage. Uses the same managed-block
 * mechanism so it is idempotent and preserves anything the user added.
 */
export async function ensureOverlayExcludes(ctx: Context): Promise<void> {
  const path = overlayExcludePath(ctx);
  const before = await readBytes(path);
  const result = applyManagedBlock(before, OVERLAY_EXCLUDE_LINES);
  if (result.changed) await writeBytesAtomic(path, result.bytes);
}
