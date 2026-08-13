/**
 * `src/manifest.ts` and `src/exclude.ts`.
 *
 * The manifest half is mostly pure, so it is tested directly. The exclude half is only
 * meaningful if **real git** agrees, so every claim about escaping is checked by writing
 * the block into a real repo's `.git/info/exclude` and asking `git status` what it sees.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { cleanupAllSandboxes, makeSandbox, WEIRD_NAMES, type Repo, type Sandbox } from "./helpers/harness.ts";
import { discover, type Context } from "../src/context.ts";
import {
  cloneManifest,
  comparePaths,
  emptyManifest,
  entryOf,
  isValidBlobOid,
  manifestPathProblem,
  ownedPaths,
  parseManifest,
  pathsOfKind,
  readManifest,
  removeEntry,
  serializeManifest,
  setEntry,
  writeManifest,
} from "../src/manifest.ts";
import {
  applyManagedBlock,
  BEGIN_MARKER,
  currentExcludeBlock,
  desiredExcludeLines,
  END_MARKER,
  ensureOverlayExcludes,
  OVERLAY_EXCLUDE_LINES,
  readManagedBlock,
  removeExcludeBlock,
  syncExcludeBlock,
} from "../src/exclude.ts";
import { isOvergitError } from "../src/errors.ts";

/* ------------------------------------------------------------ hermetic in-process env */

/**
 * The harness hands its hermetic environment to *child* processes. These tests call the
 * modules in-process, so the same variables have to be installed on `process.env` for the
 * duration or the developer's own `~/.gitconfig` would leak in.
 */
const ENV_KEYS = [
  "HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CEILING_DIRECTORIES",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "LC_ALL",
  "LANG",
  "TZ",
] as const;

let savedEnv: Record<string, string | undefined> = {};

function installEnv(sb: Sandbox): void {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    const v = sb.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv = {};
}

let sb: Sandbox;

beforeEach(async () => {
  sb = await makeSandbox("manifest");
  installEnv(sb);
});

afterEach(async () => {
  restoreEnv();
  await sb.cleanup();
});

afterAll(cleanupAllSandboxes);

/** Minimal overlay so `discover` finds one, without pulling in `bootstrap.ts`. */
async function mkOverlay(repo: Repo): Promise<Context> {
  // `.overgit/` is an ordinary git repository directory.
  await repo.git("init", "--quiet", "-b", "main", ".overgit");
  const gd = repo.path(".overgit", ".git");
  await repo.git("--git-dir", gd, "config", "core.worktree", "../..");
  await repo.git("--git-dir", gd, "config", "status.showUntrackedFiles", "no");
  return discover(repo.dir, { requireOverlay: true });
}

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_256 = "c".repeat(64);

/* ------------------------------------------------------------------ manifest: shape */

describe("manifest serialisation", () => {
  test("empty manifest round-trips", () => {
    const m = emptyManifest();
    expect(serializeManifest(m)).toBe('{\n  "version": 1,\n  "entries": {}\n}\n');
    expect(parseManifest(serializeManifest(m), "x")).toEqual(m);
  });

  test("keys are sorted byte-wise and output is deterministic", () => {
    let m = emptyManifest();
    for (const p of ["z.txt", "a.txt", "M.txt", "dir/b.txt", "dir-a.txt"]) {
      m = setEntry(m, p, { kind: "add" });
    }
    const text = serializeManifest(m);
    const order = [...text.matchAll(/^ {4}"(.*)": \{/gm)].map((x) => x[1]);
    expect(order).toEqual(["M.txt", "a.txt", "dir-a.txt", "dir/b.txt", "z.txt"]);
    // Insertion order must not matter.
    let m2 = emptyManifest();
    for (const p of ["dir/b.txt", "z.txt", "M.txt", "dir-a.txt", "a.txt"]) {
      m2 = setEntry(m2, p, { kind: "add" });
    }
    expect(serializeManifest(m2)).toBe(text);
  });

  test("byte-wise ordering differs from JS string ordering for astral characters", () => {
    // "\u{1F600}" (emoji, 4 UTF-8 bytes starting F0) sorts *after* "" (3 bytes, EE)
    // in UTF-8, but *before* it as UTF-16 code units.
    const a = "\u{1F600}.txt";
    const b = ".txt";
    expect(a < b).toBe(true); // JS ordering
    expect(comparePaths(a, b)).toBeGreaterThan(0); // byte ordering
    let m = emptyManifest();
    m = setEntry(m, a, { kind: "add" });
    m = setEntry(m, b, { kind: "add" });
    expect(ownedPaths(m)).toEqual([b, a]);
  });

  test("serialised form is 2-space indented, LF, with a trailing newline", () => {
    let m = emptyManifest();
    m = setEntry(m, "src/config.ts", { kind: "override", baseBlob: OID_A });
    m = setEntry(m, "docs/legacy.md", { kind: "delete", baseBlob: OID_B });
    m = setEntry(m, "scripts/dev.sh", { kind: "add" });
    expect(serializeManifest(m)).toBe(
      [
        "{",
        '  "version": 1,',
        '  "entries": {',
        `    "docs/legacy.md": { "kind": "delete", "baseBlob": "${OID_B}" },`,
        '    "scripts/dev.sh": { "kind": "add" },',
        `    "src/config.ts": { "kind": "override", "baseBlob": "${OID_A}" }`,
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  test("weird path names survive a serialise/parse round trip", () => {
    let m = emptyManifest();
    for (const n of WEIRD_NAMES) m = setEntry(m, n, { kind: "add" });
    m = setEntry(m, "new\nline.txt", { kind: "override", baseBlob: OID_A });
    m = setEntry(m, "tab\there.txt", { kind: "add" });
    const back = parseManifest(serializeManifest(m), "x");
    expect(ownedPaths(back)).toEqual(ownedPaths(m));
    expect(entryOf(back, "new\nline.txt")).toEqual({ kind: "override", baseBlob: OID_A });
  });

  test("unknown top-level keys are preserved on rewrite", () => {
    const src = '{"version":1,"entries":{},"futureThing":{"a":[1,2]},"other":"x"}';
    const m = parseManifest(src, "x");
    expect(m["futureThing"]).toEqual({ a: [1, 2] });
    const text = serializeManifest(m);
    expect(parseManifest(text, "x")["futureThing"]).toEqual({ a: [1, 2] });
    expect(text.endsWith("\n")).toBe(true);
    // Ordering of the extra keys is stable too.
    expect(serializeManifest(parseManifest(text, "x"))).toBe(text);
  });

  test("cloneManifest / setEntry / removeEntry do not mutate the input", () => {
    const m = setEntry(emptyManifest(), "a.txt", { kind: "add" });
    const m2 = setEntry(m, "b.txt", { kind: "add" });
    const m3 = removeEntry(m2, "a.txt");
    expect(ownedPaths(m)).toEqual(["a.txt"]);
    expect(ownedPaths(m2)).toEqual(["a.txt", "b.txt"]);
    expect(ownedPaths(m3)).toEqual(["b.txt"]);
    const c = cloneManifest(m2);
    c.entries["a.txt"] = { kind: "override", baseBlob: OID_A };
    expect(entryOf(m2, "a.txt")).toEqual({ kind: "add" });
  });

  test("pathsOfKind splits by kind", () => {
    let m = emptyManifest();
    m = setEntry(m, "a", { kind: "add" });
    m = setEntry(m, "o", { kind: "override", baseBlob: OID_A });
    m = setEntry(m, "d", { kind: "delete", baseBlob: OID_B });
    expect(pathsOfKind(m, "add")).toEqual(["a"]);
    expect(pathsOfKind(m, "override")).toEqual(["o"]);
    expect(pathsOfKind(m, "delete")).toEqual(["d"]);
  });
});

describe("manifest validation", () => {
  const bad: [string, string][] = [
    ["not json at all", "MANIFEST_INVALID"],
    ["[]", "MANIFEST_INVALID"],
    ["null", "MANIFEST_INVALID"],
    ['{"entries":{}}', "MANIFEST_INVALID"],
    ['{"version":"1","entries":{}}', "MANIFEST_INVALID"],
    ['{"version":2,"entries":{}}', "MANIFEST_VERSION"],
    ['{"version":1,"entries":[]}', "MANIFEST_INVALID"],
    ['{"version":1,"entries":{"a":null}}', "MANIFEST_INVALID"],
    ['{"version":1,"entries":{"a":{"kind":"nope"}}}', "MANIFEST_INVALID"],
    ['{"version":1,"entries":{"a":{"kind":"override"}}}', "MANIFEST_INVALID"],
    ['{"version":1,"entries":{"a":{"kind":"override","baseBlob":"XYZ"}}}', "MANIFEST_INVALID"],
    ['{"version":1,"entries":{"/abs":{"kind":"add"}}}', "MANIFEST_INVALID"],
    ['{"version":1,"entries":{"../up":{"kind":"add"}}}', "MANIFEST_INVALID"],
    ['{"version":1,"entries":{"./here":{"kind":"add"}}}', "MANIFEST_INVALID"],
    ['{"version":1,"entries":{"trail/":{"kind":"add"}}}', "MANIFEST_INVALID"],
    ['{"version":1,"entries":{"a//b":{"kind":"add"}}}', "MANIFEST_INVALID"],
    ['{"version":1,"entries":{".git/config":{"kind":"add"}}}', "MANIFEST_INVALID"],
    ['{"version":1,"entries":{".overgit/x":{"kind":"add"}}}', "MANIFEST_INVALID"],
    ['{"version":1,"entries":{"A.txt":{"kind":"add"},"a.txt":{"kind":"add"}}}', "MANIFEST_INVALID"],
  ];

  for (const [src, code] of bad) {
    test(`rejects ${src.slice(0, 60)}`, () => {
      let caught: unknown;
      try {
        parseManifest(src, "/repo/.overgit/manifest.json");
      } catch (e) {
        caught = e;
      }
      expect(isOvergitError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe(code);
      // Every message names the file the user has to fix.
      expect((caught as Error).message).toContain("/repo/.overgit/manifest.json");
    });
  }

  test("a version bump asks the user to upgrade, not to hand-edit", () => {
    try {
      parseManifest('{"version":99,"entries":{}}', "m.json");
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as { hint?: string }).hint).toContain("upgrade overgit");
    }
  });

  test("accepts sha256 oids and a missing entries key", () => {
    const m = parseManifest(`{"version":1,"entries":{"a":{"kind":"delete","baseBlob":"${OID_256}"}}}`, "x");
    expect(entryOf(m, "a")).toEqual({ kind: "delete", baseBlob: OID_256 });
    expect(ownedPaths(parseManifest('{"version":1}', "x"))).toEqual([]);
  });

  test("isValidBlobOid / manifestPathProblem", () => {
    expect(isValidBlobOid(OID_A)).toBe(true);
    expect(isValidBlobOid(OID_256)).toBe(true);
    expect(isValidBlobOid("A".repeat(40))).toBe(false); // uppercase
    expect(isValidBlobOid("a".repeat(39))).toBe(false);
    expect(manifestPathProblem("ok/path.txt")).toBeNull();
    expect(manifestPathProblem("")).toBeTruthy();
    expect(manifestPathProblem(".GIT/x")).toBeTruthy(); // case-insensitive
  });

  test("a BOM does not stop the manifest from parsing", () => {
    expect(ownedPaths(parseManifest('﻿{"version":1,"entries":{}}', "x"))).toEqual([]);
  });
});

describe("manifest file i/o", () => {
  test("missing and empty files read as an empty manifest; writes are atomic", async () => {
    const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n" });
    const ctx = await mkOverlay(repo);

    expect(ownedPaths(await readManifest(ctx))).toEqual([]);
    await mkdir(ctx.overgitDir, { recursive: true });
    await writeFile(ctx.manifestPath, "   \n");
    expect(ownedPaths(await readManifest(ctx))).toEqual([]);

    let m = emptyManifest();
    m = setEntry(m, "a.txt", { kind: "override", baseBlob: OID_A });
    await writeManifest(ctx, m);
    expect(await readFile(ctx.manifestPath, "utf8")).toBe(serializeManifest(m));
    expect(entryOf(await readManifest(ctx), "a.txt")).toEqual({ kind: "override", baseBlob: OID_A });

    // No temp files left behind.
    const leftovers = (await Bun.$`ls ${ctx.overgitDir}`.text()).split("\n").filter(Boolean);
    expect(leftovers.filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("an unreadable manifest names the file and offers doctor", async () => {
    const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n" });
    const ctx = await mkOverlay(repo);
    await mkdir(ctx.overgitDir, { recursive: true });
    await writeFile(ctx.manifestPath, "{ this is not json");
    try {
      await readManifest(ctx);
      throw new Error("expected a throw");
    } catch (e) {
      expect(isOvergitError(e)).toBe(true);
      expect((e as Error).message).toContain(ctx.manifestPath);
      expect((e as { hint?: string }).hint).toContain("overgit doctor");
    }
  });
});

/* ------------------------------------------------------------------ exclude: pure */

const enc = new TextEncoder();
const dec = new TextDecoder();

function edit(text: string, lines: string[] | null): string {
  return dec.decode(applyManagedBlock(enc.encode(text), lines).bytes);
}

describe("managed block editing", () => {
  test("inserts into an empty file", () => {
    expect(edit("", ["/x"])).toBe(`${BEGIN_MARKER}\n/x\n${END_MARKER}\n`);
  });

  test("appends to a file with no trailing newline, adding one", () => {
    expect(edit("# mine", ["/x"])).toBe(`# mine\n${BEGIN_MARKER}\n/x\n${END_MARKER}\n`);
  });

  test("preserves content before and after the block byte for byte", () => {
    const before = `before\r\nline2\n${BEGIN_MARKER}\n/old\n${END_MARKER}\nafter\n\nmore`;
    expect(edit(before, ["/new"])).toBe(
      `before\r\nline2\n${BEGIN_MARKER}\n/new\n${END_MARKER}\nafter\n\nmore`,
    );
  });

  test("is idempotent", () => {
    const once = edit("keep\n", ["/a", "/b"]);
    expect(edit(once, ["/a", "/b"])).toBe(once);
    expect(applyManagedBlock(enc.encode(once), ["/a", "/b"]).changed).toBe(false);
  });

  test("repairs two blocks down to one, in the first block's position", () => {
    const src = `top\n${BEGIN_MARKER}\n/a\n${END_MARKER}\nmiddle\n${BEGIN_MARKER}\n/b\n${END_MARKER}\nend\n`;
    const out = applyManagedBlock(enc.encode(src), ["/c"]);
    expect(out.blocksFound).toBe(2);
    expect(dec.decode(out.bytes)).toBe(`top\n${BEGIN_MARKER}\n/c\n${END_MARKER}\nmiddle\nend\n`);
  });

  test("closes an unterminated block", () => {
    const src = `top\n${BEGIN_MARKER}\n/a\n/b\n`;
    expect(dec.decode(applyManagedBlock(enc.encode(src), ["/c"]).bytes)).toBe(
      `top\n${BEGIN_MARKER}\n/c\n${END_MARKER}\n`,
    );
  });

  test("removes an orphaned end marker", () => {
    const src = `top\n${END_MARKER}\nbottom\n`;
    expect(dec.decode(applyManagedBlock(enc.encode(src), ["/a"]).bytes)).toBe(
      `top\nbottom\n${BEGIN_MARKER}\n/a\n${END_MARKER}\n`,
    );
  });

  test("recognises markers written with CRLF", () => {
    const src = `x\r\n${BEGIN_MARKER}\r\n/old\r\n${END_MARKER}\r\ny\r\n`;
    expect(readManagedBlock(enc.encode(src))).toEqual(["/old"]);
    expect(dec.decode(applyManagedBlock(enc.encode(src), ["/new"]).bytes)).toBe(
      `x\r\n${BEGIN_MARKER}\n/new\n${END_MARKER}\ny\r\n`,
    );
  });

  test("recognises a marker on the first line behind a BOM", () => {
    const src = `﻿${BEGIN_MARKER}\n/a\n${END_MARKER}\n`;
    expect(readManagedBlock(enc.encode(src))).toEqual(["/a"]);
  });

  test("null removes the block and leaves everything else", () => {
    const src = `top\n${BEGIN_MARKER}\n/a\n${END_MARKER}\nbottom\n`;
    expect(dec.decode(applyManagedBlock(enc.encode(src), null).bytes)).toBe("top\nbottom\n");
  });

  test("non-UTF-8 bytes outside the block survive unchanged", () => {
    const raw = new Uint8Array([0xff, 0xfe, 0x0a, ...enc.encode("keep\n")]);
    const out = applyManagedBlock(raw, ["/a"]).bytes;
    expect([...out.slice(0, 3)]).toEqual([0xff, 0xfe, 0x0a]);
    expect(dec.decode(out.subarray(3))).toBe(`keep\n${BEGIN_MARKER}\n/a\n${END_MARKER}\n`);
  });

  test("readManagedBlock returns null when there is no block", () => {
    expect(readManagedBlock(enc.encode("nothing here\n"))).toBeNull();
  });
});

describe("desiredExcludeLines", () => {
  test("always starts with /.overgit/ and lists only add paths, sorted", () => {
    let m = emptyManifest();
    m = setEntry(m, "z.txt", { kind: "add" });
    m = setEntry(m, "a.txt", { kind: "add" });
    m = setEntry(m, "o.txt", { kind: "override", baseBlob: OID_A });
    m = setEntry(m, "d.txt", { kind: "delete", baseBlob: OID_B });
    expect(desiredExcludeLines(m)).toEqual(["/.overgit/", "/a.txt", "/z.txt"]);
  });
});

/* ------------------------------------------------- exclude: does real git agree? */

describe("exclude block against real git", () => {
  test("every weird name the overlay adds becomes invisible to the base", async () => {
    const names = [...WEIRD_NAMES, "trailing space .txt", "mid\rcarriage.txt", "café.txt"];
    const repo = await sb.mkBaseRepo("base", { "tracked.txt": "t\n" });
    const ctx = await mkOverlay(repo);

    for (const n of names) await repo.write(n, `content of ${n}\n`);
    // Decoys that must stay visible: they differ from an add path by exactly the
    // character an unescaped glob would swallow.
    await repo.write("starXnot-glob.txt", "decoy\n");
    await repo.write("bracket1.txt", "decoy\n");
    await repo.write("hashXtag.txt", "decoy\n");

    let m = emptyManifest();
    for (const n of names) m = setEntry(m, n, { kind: "add" });
    expect((await syncExcludeBlock(ctx, m)).changed).toBe(true);

    const untracked = (await repo.git("status", "--porcelain", "-z", "-uall")).stdout
      .split("\0")
      .filter(Boolean)
      .map((r) => r.slice(3));
    expect(untracked.sort()).toEqual(["bracket1.txt", "hashXtag.txt", "starXnot-glob.txt"].sort());
  });

  test("the block hides .overgit/ from the base", async () => {
    const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n" });
    const ctx = await mkOverlay(repo);
    await syncExcludeBlock(ctx, emptyManifest());
    await repo.write(".overgit/manifest.json", "{}\n");
    expect((await repo.git("status", "--porcelain")).stdout).toBe("");
  });

  test("syncExcludeBlock is idempotent and preserves the user's own lines", async () => {
    const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n" });
    const ctx = await mkOverlay(repo);
    const excl = join(await repo.gitDir(), "info", "exclude");
    await mkdir(join(await repo.gitDir(), "info"), { recursive: true });
    await writeFile(excl, "# my own notes\n*.log\n");

    const m = setEntry(emptyManifest(), "kept.txt", { kind: "add" });
    expect((await syncExcludeBlock(ctx, m)).changed).toBe(true);
    expect((await syncExcludeBlock(ctx, m)).changed).toBe(false);

    const text = await readFile(excl, "utf8");
    expect(text.startsWith("# my own notes\n*.log\n")).toBe(true);
    expect(await currentExcludeBlock(ctx)).toEqual(["/.overgit/", "/kept.txt"]);

    // A stale line disappears when the manifest changes, user content stays.
    await syncExcludeBlock(ctx, emptyManifest());
    expect(await currentExcludeBlock(ctx)).toEqual(["/.overgit/"]);
    expect((await readFile(excl, "utf8")).startsWith("# my own notes\n*.log\n")).toBe(true);

    await removeExcludeBlock(ctx);
    expect(await currentExcludeBlock(ctx)).toBeNull();
    expect(await readFile(excl, "utf8")).toBe("# my own notes\n*.log\n");
  });

  test("currentExcludeBlock is null before anything is written", async () => {
    const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n" });
    const ctx = await mkOverlay(repo);
    expect(await currentExcludeBlock(ctx)).toBeNull();
    await removeExcludeBlock(ctx); // must not throw on a missing file
  });

  test("ensureOverlayExcludes keeps the overlay from tracking its own storage", async () => {
    const repo = await sb.mkBaseRepo("base", { "a.txt": "a\n" });
    const ctx = await mkOverlay(repo);
    await ensureOverlayExcludes(ctx);
    const text = await readFile(join(ctx.overlayGitDir, "info", "exclude"), "utf8");
    for (const line of OVERLAY_EXCLUDE_LINES) expect(text).toContain(line);
    await ensureOverlayExcludes(ctx); // idempotent
    expect(await readFile(join(ctx.overlayGitDir, "info", "exclude"), "utf8")).toBe(text);

    // git agrees: the overlay does not offer its own storage as untracked.
    const r = await repo.git(
      "--git-dir",
      ctx.overlayGitDir,
      "--work-tree",
      repo.dir,
      "-c",
      "core.bare=false",
      "status",
      "--porcelain",
      "-uall",
      "--untracked-files=all",
    );
    expect(r.stdout).not.toContain(".overgit/.git");
    expect(r.stdout).not.toContain(".overgit/local");
  });
});
