import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readdir,
  symlink,
  chmod,
  realpath,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git, GitError, mergeBlobs, parseStatusZ, splitNul, literalPathspec } from "../src/git.ts";

// Hermetic git: the developer's real config must not be able to change any result.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

/**
 * Captured at module load, never at test time. `bun test` runs every file in one process,
 * and the shared harness points `process.env.TMPDIR` at a sandbox that it later deletes —
 * so an `os.tmpdir()` call inside `beforeAll` can hand back a directory that is already
 * gone. See test/helpers/env.ts.
 */
const HOST_TMP = realpathSync(tmpdir());

const WEIRD = 'weird "na[m]e#!.txt';
const NEWLINE_NAME = "nl\nname.txt";
const TAB_NAME = "tab\there.txt";
const STAR = "star*.txt";

interface Sh {
  stdout: string;
  stderr: string;
  code: number;
}

async function sh(cwd: string, cmd: string[], input?: Uint8Array): Promise<Sh> {
  const p = Bun.spawn({
    cmd,
    cwd,
    env: { ...process.env } as Record<string, string>,
    stdin: input ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { stdout, stderr, code };
}

async function shBytes(cwd: string, cmd: string[]): Promise<Uint8Array> {
  const p = Bun.spawn({
    cmd,
    cwd,
    env: { ...process.env } as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [buf] = await Promise.all([new Response(p.stdout).arrayBuffer(), p.exited]);
  return new Uint8Array(buf);
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await sh(dir, ["git", "init", "-q", "-b", "main", "."]);
  await sh(dir, ["git", "config", "user.name", "overgit test"]);
  await sh(dir, ["git", "config", "user.email", "test@overgit.invalid"]);
  await sh(dir, ["git", "config", "commit.gpgsign", "false"]);
}

let root: string;
let repo: string;
let git: Git;

beforeAll(async () => {
  // realpath: on macOS os.tmpdir() is a symlink, and git always reports the resolved path.
  root = await realpath(await mkdtemp(join(HOST_TMP, "overgit-git-test-")));
  repo = join(root, "base");
  await initRepo(repo);
  await initRepo(join(root, "empty"));

  await writeFile(join(repo, "normal.txt"), "hello\n");
  await writeFile(join(repo, WEIRD), "weird\n");
  await writeFile(join(repo, NEWLINE_NAME), "newline\n");
  await writeFile(join(repo, TAB_NAME), "tab\n");
  await writeFile(join(repo, STAR), "star\n");
  await writeFile(join(repo, "starX.txt"), "starX\n");
  await mkdir(join(repo, "dir with space"), { recursive: true });
  await writeFile(join(repo, "dir with space", "f.txt"), "nested\n");
  await writeFile(join(repo, "exec.sh"), "#!/bin/sh\n");
  await chmod(join(repo, "exec.sh"), 0o755);
  await symlink("normal.txt", join(repo, "link.txt"));
  // Real binary bytes, including a lone 0xff which is not valid UTF-8.
  await writeFile(join(repo, "bin.dat"), new Uint8Array([0, 1, 2, 255, 254, 10, 0, 65]));

  await sh(repo, ["git", "add", "-A"]);
  await sh(repo, ["git", "commit", "-qm", "init"]);

  git = new Git({ cwd: repo });
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("helpers", () => {
  test("splitNul drops only the trailing empty field", () => {
    expect(splitNul("")).toEqual([]);
    expect(splitNul("a\0b\0")).toEqual(["a", "b"]);
    expect(splitNul("a\0\0b\0")).toEqual(["a", "", "b"]);
  });

  test("parseStatusZ pairs rename records", () => {
    const entries = parseStatusZ("R  new.txt\0old.txt\0 M other.txt\0");
    expect(entries).toEqual([
      { x: "R", y: " ", path: "new.txt", origPath: "old.txt" },
      { x: " ", y: "M", path: "other.txt" },
    ]);
  });
});

describe("repository shape", () => {
  test("version parses", async () => {
    const v = await git.version();
    expect(v.major).toBeGreaterThanOrEqual(2);
    expect(v.raw).toContain("git version");
  });

  test("toplevel / resolveGitDir / resolveCommonDir", async () => {
    const top = await git.toplevel();
    expect(await Bun.file(join(top, "normal.txt")).text()).toBe("hello\n");
    expect(await git.resolveGitDir()).toBe(join(top, ".git"));
    expect(await git.resolveCommonDir()).toBe(join(top, ".git"));
  });

  test("works from a subdirectory", async () => {
    const sub = new Git({ cwd: join(repo, "dir with space") });
    expect(await sub.toplevel()).toBe(await git.toplevel());
  });

  test("revParse resolves HEAD and returns null for nonsense", async () => {
    const head = await git.revParse("HEAD");
    expect(head).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await git.revParse("refs/heads/does-not-exist")).toBeNull();
    expect(await git.revParse("--not-a-rev")).toBeNull();
  });

  test("currentBranch and headExists", async () => {
    expect(await git.currentBranch()).toBe("main");
    expect(await git.headExists()).toBe(true);

    const empty = join(root, "empty");
    await initRepo(empty);
    const eg = new Git({ cwd: empty });
    expect(await eg.headExists()).toBe(false);
    // An unborn branch still has a symbolic HEAD.
    expect(await eg.currentBranch()).toBe("main");

    await sh(repo, ["git", "checkout", "-q", "--detach", "HEAD"]);
    expect(await git.currentBranch()).toBeNull();
    await sh(repo, ["git", "checkout", "-q", "main"]);
    expect(await git.currentBranch()).toBe("main");
  });
});

describe("index and tree queries", () => {
  test("isTracked handles weird names and does not glob", async () => {
    expect(await git.isTracked("normal.txt")).toBe(true);
    expect(await git.isTracked(WEIRD)).toBe(true);
    expect(await git.isTracked(NEWLINE_NAME)).toBe(true);
    expect(await git.isTracked(TAB_NAME)).toBe(true);
    expect(await git.headBlobOid(TAB_NAME)).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await git.isTracked("nope.txt")).toBe(false);
    // `star*.txt` must not be treated as a glob matching starX.txt.
    expect(await git.isTracked(STAR)).toBe(true);
    await sh(repo, ["git", "rm", "-q", "--cached", "--", literalPathspec(STAR)]);
    expect(await git.isTracked(STAR)).toBe(false);
    expect(await git.isTracked("starX.txt")).toBe(true);
    await sh(repo, ["git", "add", "--", literalPathspec(STAR)]);
    expect(await git.isTracked(STAR)).toBe(true);
  });

  test("isTracked on a directory is false", async () => {
    expect(await git.isTracked("dir with space")).toBe(false);
  });

  test("a leading colon is not mistaken for pathspec magic", async () => {
    const colon = join(root, "colon");
    await initRepo(colon);
    await writeFile(join(colon, ":colon.txt"), "c\n");
    const cg = new Git({ cwd: colon });
    await cg.addPaths([":colon.txt"]);
    expect(await cg.isTracked(":colon.txt")).toBe(true);
    expect((await cg.lsFiles()).map((e) => e.path)).toContain(":colon.txt");
  });

  test("lsFiles reports root-relative paths even from a subdirectory cwd", async () => {
    const sub = new Git({ cwd: join(repo, "dir with space") });
    const paths = (await sub.lsFiles()).map((e) => e.path);
    expect(paths).toContain("dir with space/f.txt");
  });

  test("an unborn repository answers cleanly", async () => {
    const eg = new Git({ cwd: join(root, "empty") });
    expect(await eg.lsFiles()).toEqual([]);
    expect(await eg.isClean()).toBe(true);
    expect(await eg.headBlobOid("anything.txt")).toBeNull();
    expect(await eg.skipWorktreePaths()).toEqual([]);
  });

  test("headBlobOid / indexBlobOid / fileMode", async () => {
    const oid = await git.headBlobOid("normal.txt");
    expect(oid).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await git.indexBlobOid("normal.txt")).toBe(oid!);
    expect(await git.fileMode("normal.txt")).toBe("100644");
    expect(await git.fileMode("exec.sh")).toBe("100755");
    expect(await git.fileMode("link.txt")).toBe("120000");

    expect(await git.headBlobOid(WEIRD)).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await git.headBlobOid(NEWLINE_NAME)).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await git.headBlobOid("nope.txt")).toBeNull();
    // A directory resolves to a tree, not a blob.
    expect(await git.headBlobOid("dir with space")).toBeNull();
  });

  test("lsFiles returns every entry with raw paths", async () => {
    const entries = await git.lsFiles();
    const paths = entries.map((e) => e.path);
    expect(paths).toContain(WEIRD);
    expect(paths).toContain(NEWLINE_NAME);
    // A tab in the name must not be confused with the mode/path separator.
    expect(paths).toContain(TAB_NAME);
    expect(paths).toContain("dir with space/f.txt");
    expect(paths).toContain(STAR);
    for (const e of entries) {
      expect(e.stage).toBe(0);
      expect(e.skipWorktree).toBe(false);
      expect(e.oid).toMatch(/^[0-9a-f]{40,64}$/);
    }
    expect(entries.find((e) => e.path === "link.txt")!.mode).toBe("120000");
  });

  test("lsTree mirrors the committed tree", async () => {
    const tree = await git.lsTree("HEAD");
    const byPath = new Map(tree.map((e) => [e.path, e]));
    expect(byPath.get(NEWLINE_NAME)).toBeDefined();
    expect(byPath.get(TAB_NAME)).toBeDefined();
    expect(byPath.get("exec.sh")!.mode).toBe("100755");
    expect(byPath.get("dir with space/f.txt")).toBeDefined();
  });
});

describe("objects", () => {
  test("catFileBlob returns exact bytes, including invalid UTF-8", async () => {
    const oid = (await git.headBlobOid("bin.dat"))!;
    const bytes = await git.catFileBlob(oid);
    expect(Array.from(bytes)).toEqual([0, 1, 2, 255, 254, 10, 0, 65]);
  });

  test("hashObject round-trips arbitrary bytes", async () => {
    const content = new Uint8Array([0, 200, 13, 10, 255, 0, 1]);
    const oid = await git.hashObject(content, { write: true });
    expect(await git.blobExists(oid)).toBe(true);
    expect(Array.from(await git.catFileBlob(oid))).toEqual(Array.from(content));

    // Without `write` the object must not land in the store.
    const dry = await git.hashObject(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));
    expect(dry).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await git.blobExists(dry)).toBe(false);
  });

  test("hashObject does not apply CRLF filters by default", async () => {
    // core.autocrlf would otherwise rewrite these bytes on the way in.
    await sh(repo, ["git", "config", "core.autocrlf", "true"]);
    try {
      const content = new TextEncoder().encode("a\r\nb\r\n");
      const oid = await git.hashObject(content, { write: true });
      expect(Array.from(await git.catFileBlob(oid))).toEqual(Array.from(content));
    } finally {
      await sh(repo, ["git", "config", "--unset", "core.autocrlf"]);
    }
  });

  test("hashObject handles empty content", async () => {
    const oid = await git.hashObject(new Uint8Array(0), { write: true });
    // The well-known empty-blob OID for sha1 repositories.
    expect(oid).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect((await git.catFileBlob(oid)).length).toBe(0);
  });

  test("blobExists is false for a tree and for garbage", async () => {
    const treeOid = (await sh(repo, ["git", "rev-parse", "HEAD^{tree}"])).stdout.trim();
    expect(await git.blobExists(treeOid)).toBe(false);
    expect(await git.blobExists("0".repeat(40))).toBe(false);
    expect(await git.blobExists("not-an-oid")).toBe(false);
  });
});

describe("skip-worktree", () => {
  test("set / list / clear survives weird names", async () => {
    await git.setSkipWorktree([WEIRD, NEWLINE_NAME]);
    const flagged = await git.skipWorktreePaths();
    expect(flagged).toContain(WEIRD);
    expect(flagged).toContain(NEWLINE_NAME);

    const entries = await git.lsFiles();
    expect(entries.find((e) => e.path === WEIRD)!.skipWorktree).toBe(true);
    expect(entries.find((e) => e.path === "normal.txt")!.skipWorktree).toBe(false);

    await git.clearSkipWorktree([WEIRD, NEWLINE_NAME]);
    expect(await git.skipWorktreePaths()).toEqual([]);
  });

  test("skip-worktree is still detected when assume-unchanged is also set", async () => {
    await git.setSkipWorktree(["normal.txt"]);
    await sh(repo, ["git", "update-index", "--assume-unchanged", "normal.txt"]);
    expect(await git.skipWorktreePaths()).toContain("normal.txt");
    await sh(repo, ["git", "update-index", "--no-assume-unchanged", "normal.txt"]);
    await git.clearSkipWorktree(["normal.txt"]);
  });

  test("empty input is a no-op", async () => {
    await git.setSkipWorktree([]);
    await git.clearSkipWorktree([]);
    expect(await git.skipWorktreePaths()).toEqual([]);
  });

  test("marking an untracked path fails loudly", async () => {
    let err: unknown;
    try {
      await git.setSkipWorktree(["definitely-not-in-index.txt"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitError);
    const ge = err as GitError;
    expect(ge.exitCode).toBe(128);
    expect(ge.cwd).toBe(repo);
    expect(ge.args).toContain("update-index");
    expect(ge.message).toContain("update-index");
    expect(ge.message.split("\n").length).toBe(1);
    expect(ge.stderr).toContain("definitely-not-in-index.txt");
  });
});

describe("status", () => {
  test("reports untracked regardless of status.showUntrackedFiles", async () => {
    await writeFile(join(repo, "untracked me.txt"), "u\n");
    await sh(repo, ["git", "config", "status.showUntrackedFiles", "no"]);
    try {
      const entries = await git.statusPorcelain();
      expect(entries.some((e) => e.path === "untracked me.txt" && e.x === "?")).toBe(true);
    } finally {
      await sh(repo, ["git", "config", "--unset", "status.showUntrackedFiles"]);
    }
  });

  test("an overlay-style Git suppresses untracked", async () => {
    const quiet = new Git({ cwd: repo, untrackedFiles: "no" });
    const entries = await quiet.statusPorcelain();
    expect(entries.some((e) => e.x === "?")).toBe(false);
  });

  test("modified, deleted and renamed entries", async () => {
    await writeFile(join(repo, WEIRD), "changed\n");
    const mod = await git.statusPorcelain();
    expect(mod.find((e) => e.path === WEIRD)).toEqual({ x: " ", y: "M", path: WEIRD });
    await sh(repo, ["git", "checkout", "-q", "--", WEIRD]);

    await sh(repo, ["git", "mv", "normal.txt", "renamed name.txt"]);
    const ren = await git.statusPorcelain();
    const r = ren.find((e) => e.path === "renamed name.txt");
    expect(r?.x).toBe("R");
    expect(r?.origPath).toBe("normal.txt");
    await sh(repo, ["git", "mv", "renamed name.txt", "normal.txt"]);

    await rm(join(repo, "dir with space/f.txt"));
    const del = await git.statusPorcelain();
    expect(del.find((e) => e.path === "dir with space/f.txt")?.y).toBe("D");
    await sh(repo, ["git", "checkout", "-q", "--", "dir with space/f.txt"]);
  });

  test("isClean ignores untracked files", async () => {
    expect(await git.isClean()).toBe(true);
    await writeFile(join(repo, "normal.txt"), "dirty\n");
    expect(await git.isClean()).toBe(false);
    await sh(repo, ["git", "checkout", "-q", "--", "normal.txt"]);
    expect(await git.isClean()).toBe(true);
  });

  test("pathspec filtering", async () => {
    await writeFile(join(repo, WEIRD), "changed\n");
    const scoped = await git.statusPorcelain([literalPathspec(WEIRD)]);
    expect(scoped.map((e) => e.path)).toEqual([WEIRD]);
    await sh(repo, ["git", "checkout", "-q", "--", WEIRD]);
  });
});

describe("index mutation", () => {
  let mutRepo: string;
  let mut: Git;

  beforeAll(async () => {
    mutRepo = join(root, "mutate");
    await initRepo(mutRepo);
    await writeFile(join(mutRepo, "seed.txt"), "seed\n");
    await sh(mutRepo, ["git", "add", "-A"]);
    await sh(mutRepo, ["git", "commit", "-qm", "seed"]);
    mut = new Git({ cwd: mutRepo });
  });

  test("addPaths stages exactly the named paths, never a glob", async () => {
    await writeFile(join(mutRepo, STAR), "a\n");
    await writeFile(join(mutRepo, "starX.txt"), "b\n");
    await mut.addPaths([STAR]);
    expect(await mut.isTracked(STAR)).toBe(true);
    expect(await mut.isTracked("starX.txt")).toBe(false);
    await mut.addPaths(["starX.txt"]);
    expect(await mut.isTracked("starX.txt")).toBe(true);
    await mut.addPaths([]);
  });

  test("addPaths records a deletion", async () => {
    await writeFile(join(mutRepo, "gone.txt"), "x\n");
    await mut.addPaths(["gone.txt"]);
    expect(await mut.isTracked("gone.txt")).toBe(true);
    await rm(join(mutRepo, "gone.txt"));
    await mut.addPaths(["gone.txt"]);
    expect(await mut.isTracked("gone.txt")).toBe(false);
  });

  test("rmCached leaves the work-tree file alone", async () => {
    await writeFile(join(mutRepo, WEIRD), "keep me\n");
    await mut.addPaths([WEIRD]);
    await mut.rmCached([WEIRD]);
    expect(await mut.isTracked(WEIRD)).toBe(false);
    expect(await Bun.file(join(mutRepo, WEIRD)).text()).toBe("keep me\n");
    await mut.rmCached([]);
  });

  test("updateIndexCacheinfo works for paths containing commas and newlines", async () => {
    const oid = await mut.hashObject(new TextEncoder().encode("cache\n"), { write: true });
    await mut.updateIndexCacheinfo("100644", oid, "a,b\nc.txt");
    expect(await mut.indexBlobOid("a,b\nc.txt")).toBe(oid);
    expect(await mut.fileMode("a,b\nc.txt")).toBe("100644");
  });

  test("commit returns the new OID and honours allowEmpty", async () => {
    await writeFile(join(mutRepo, "committed.txt"), "c\n");
    await mut.addPaths(["committed.txt"]);
    const oid = await mut.commit("a commit\n\nbody line");
    expect(oid).toMatch(/^[0-9a-f]{40,64}$/);
    expect((await sh(mutRepo, ["git", "log", "-1", "--pretty=%s"])).stdout.trim()).toBe("a commit");

    let err: unknown;
    try {
      await mut.commit("nothing to do");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitError);

    const empty = await mut.commit("empty on purpose", { allowEmpty: true });
    expect(empty).not.toBe(oid);
  });
});

describe("environment hygiene", () => {
  test("an inherited GIT_DIR does not retarget commands", async () => {
    // A git hook exports GIT_DIR; overgit must ignore it.
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(root, "empty", ".git");
    try {
      expect(await git.toplevel()).toBe(repo);
      expect(await git.isTracked("normal.txt")).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  test("an inherited GIT_LITERAL_PATHSPECS does not break :(literal)", async () => {
    const saved = process.env.GIT_LITERAL_PATHSPECS;
    process.env.GIT_LITERAL_PATHSPECS = "1";
    try {
      expect(await git.isTracked(WEIRD)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GIT_LITERAL_PATHSPECS;
      else process.env.GIT_LITERAL_PATHSPECS = saved;
    }
  });

  test("explicit gitDir/workTree targets the right repository", async () => {
    const alt = join(root, "alt");
    await initRepo(alt);
    await writeFile(join(alt, "only-here.txt"), "x\n");
    await sh(alt, ["git", "add", "-A"]);
    await sh(alt, ["git", "commit", "-qm", "x"]);
    const pointed = new Git({ cwd: repo, gitDir: join(alt, ".git"), workTree: alt });
    expect(await pointed.isTracked("only-here.txt")).toBe(true);
    expect(await pointed.isTracked("normal.txt")).toBe(false);
  });
});

describe("mergeBlobs", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  let tmp: string;

  beforeAll(async () => {
    tmp = join(root, "merge-tmp");
    await mkdir(tmp, { recursive: true });
  });

  /** Run the merge the way a user would, for a byte-for-byte comparison. */
  async function referenceMerge(
    base: Uint8Array,
    ours: Uint8Array,
    theirs: Uint8Array,
    style?: "diff3" | "zdiff3",
  ): Promise<Uint8Array> {
    const d = await mkdtemp(join(tmp, "ref-"));
    await writeFile(join(d, "b"), base);
    await writeFile(join(d, "o"), ours);
    await writeFile(join(d, "t"), theirs);
    const args = ["git", "merge-file", "-p"];
    if (style) args.push(`--${style}`);
    args.push("-L", "OURS", "-L", "BASE", "-L", "THEIRS", "--", "o", "b", "t");
    const out = await shBytes(d, args);
    await rm(d, { recursive: true, force: true });
    return out;
  }

  const labels = { base: "BASE", ours: "OURS", theirs: "THEIRS" };

  test("clean merge is byte-identical to git merge-file", async () => {
    const base = enc("a\nb\nc\n");
    const ours = enc("A1\nb\nc\n");
    const theirs = enc("a\nb\nC1\n");
    const r = await mergeBlobs({ base, ours, theirs, labels, tmpDir: tmp });
    expect(r.clean).toBe(true);
    expect(r.conflicts).toBe(0);
    expect(r.binary).toBe(false);
    expect(Array.from(r.content)).toEqual(Array.from(await referenceMerge(base, ours, theirs)));
    expect(dec(r.content)).toBe("A1\nb\nC1\n");
  });

  test("conflict markers use the supplied labels and count hunks", async () => {
    const base = enc("a\nb\nc\n");
    const ours = enc("a\nB2\nc\n");
    const theirs = enc("a\nB3\nc\n");
    const r = await mergeBlobs({ base, ours, theirs, labels, tmpDir: tmp });
    expect(r.clean).toBe(false);
    expect(r.conflicts).toBe(1);
    expect(dec(r.content)).toBe("a\n<<<<<<< OURS\nB2\n=======\nB3\n>>>>>>> THEIRS\nc\n");
    expect(Array.from(r.content)).toEqual(Array.from(await referenceMerge(base, ours, theirs)));
  });

  test("diff3 and zdiff3 styles", async () => {
    const base = enc("a\nb\nc\n");
    const ours = enc("a\nB2\nc\n");
    const theirs = enc("a\nB3\nc\n");
    for (const style of ["diff3", "zdiff3"] as const) {
      const r = await mergeBlobs({ base, ours, theirs, labels, tmpDir: tmp, style });
      expect(dec(r.content)).toContain("||||||| BASE");
      expect(Array.from(r.content)).toEqual(
        Array.from(await referenceMerge(base, ours, theirs, style)),
      );
    }
  });

  test("multiple conflicts are counted", async () => {
    const mk = (mid: string) => {
      const out: string[] = [];
      for (let i = 0; i < 3; i++) {
        out.push(`c${i}a`, `${mid}${i}`, `c${i}b`);
        for (let j = 0; j < 10; j++) out.push(`p${i}_${j}`);
      }
      return enc(out.join("\n") + "\n");
    };
    const r = await mergeBlobs({
      base: mk("x"),
      ours: mk("o"),
      theirs: mk("t"),
      labels,
      tmpDir: tmp,
    });
    expect(r.conflicts).toBe(3);
  });

  test("no trailing newline is preserved on a clean merge", async () => {
    const base = enc("a\nb\nc\n");
    const ours = enc("a\nb\nc\nd");
    const theirs = enc("a\nb\nc\n");
    const r = await mergeBlobs({ base, ours, theirs, labels, tmpDir: tmp });
    expect(r.clean).toBe(true);
    expect(dec(r.content)).toBe("a\nb\nc\nd");
    expect(Array.from(r.content)).toEqual(Array.from(await referenceMerge(base, ours, theirs)));
  });

  test("CRLF line endings survive", async () => {
    const base = enc("a\r\nb\r\nc\r\n");
    const ours = enc("a\r\nB2\r\nc\r\n");
    const theirs = enc("a\r\nB3\r\nc\r\n");
    const r = await mergeBlobs({ base, ours, theirs, labels, tmpDir: tmp });
    expect(Array.from(r.content)).toEqual(Array.from(await referenceMerge(base, ours, theirs)));
    expect(dec(r.content)).toContain("<<<<<<< OURS\r\n");
  });

  test("empty base (the adopt case) merges", async () => {
    const base = new Uint8Array(0);
    const ours = enc("x\ny\n");
    const theirs = enc("x\nz\n");
    const r = await mergeBlobs({ base, ours, theirs, labels, tmpDir: tmp });
    expect(r.clean).toBe(false);
    expect(Array.from(r.content)).toEqual(Array.from(await referenceMerge(base, ours, theirs)));

    // Identical adoption is clean.
    const same = await mergeBlobs({
      base,
      ours: enc("x\ny\n"),
      theirs: enc("x\ny\n"),
      labels,
      tmpDir: tmp,
    });
    expect(same.clean).toBe(true);
    expect(dec(same.content)).toBe("x\ny\n");
  });

  test("all three sides identical is a clean no-op", async () => {
    const b = enc("same\n");
    const r = await mergeBlobs({ base: b, ours: b, theirs: b, labels, tmpDir: tmp });
    expect(r.clean).toBe(true);
    expect(dec(r.content)).toBe("same\n");
  });

  test("binary content: trivial cases resolve, real divergence conflicts", async () => {
    const base = new Uint8Array([0, 1, 2, 3]);
    const oursB = new Uint8Array([0, 1, 2, 9]);
    const theirsB = new Uint8Array([0, 1, 2, 8]);

    // git merge-file itself refuses binary input outright, even when it is trivial.
    const bothSame = await mergeBlobs({
      base,
      ours: oursB,
      theirs: oursB,
      labels,
      tmpDir: tmp,
    });
    expect(bothSame.clean).toBe(true);
    expect(bothSame.binary).toBe(true);
    expect(Array.from(bothSame.content)).toEqual(Array.from(oursB));

    const onlyTheirs = await mergeBlobs({ base, ours: base, theirs: theirsB, labels, tmpDir: tmp });
    expect(onlyTheirs.clean).toBe(true);
    expect(Array.from(onlyTheirs.content)).toEqual(Array.from(theirsB));

    const onlyOurs = await mergeBlobs({ base, ours: oursB, theirs: base, labels, tmpDir: tmp });
    expect(onlyOurs.clean).toBe(true);
    expect(Array.from(onlyOurs.content)).toEqual(Array.from(oursB));

    const diverged = await mergeBlobs({
      base,
      ours: oursB,
      theirs: theirsB,
      labels,
      tmpDir: tmp,
    });
    expect(diverged.clean).toBe(false);
    expect(diverged.conflicts).toBe(1);
    expect(diverged.binary).toBe(true);
    expect(Array.from(diverged.content)).toEqual(Array.from(oursB));
  });

  test("a NUL past the first 8000 bytes is still treated as text (git's heuristic)", async () => {
    const filler = "x\n".repeat(5000); // 10000 bytes
    const base = enc(filler + "tail\n");
    const ours = enc(filler + "ours\n");
    const theirs = enc(filler + "theirs\n");
    const withNul = new Uint8Array(ours.length + 1);
    withNul.set(ours);
    withNul[ours.length] = 0;
    const r = await mergeBlobs({ base, ours: withNul, theirs, labels, tmpDir: tmp });
    expect(r.binary).toBe(false);
  });

  test("temp files are cleaned up", async () => {
    const before = (await readdir(tmp)).length;
    await mergeBlobs({
      base: enc("a\n"),
      ours: enc("b\n"),
      theirs: enc("c\n"),
      labels,
      tmpDir: tmp,
    });
    expect((await readdir(tmp)).length).toBe(before);
  });

  test("labels containing spaces and quotes are passed through verbatim", async () => {
    const r = await mergeBlobs({
      base: enc("a\nb\nc\n"),
      ours: enc("a\nB2\nc\n"),
      theirs: enc("a\nB3\nc\n"),
      labels: { base: 'base "b"', ours: "ours (overlay)", theirs: "theirs #1" },
      tmpDir: tmp,
      style: "diff3",
    });
    expect(dec(r.content)).toContain("<<<<<<< ours (overlay)");
    expect(dec(r.content)).toContain('||||||| base "b"');
    expect(dec(r.content)).toContain(">>>>>>> theirs #1");
  });
});
