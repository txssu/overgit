/**
 * Rendering for `overgit status` — the merged view.
 *
 * Three renderings of one data model:
 *
 *  - **long**  the default. One screen that answers "what is the base doing, what does the
 *    overlay own, and what is about to go wrong".
 *  - **--short** one line per path, fixed-width prefix, legend in `overgit help status`.
 *  - **--porcelain** NUL-terminated records, tab-separated fields, **path always last** —
 *    the only field order that is safe when a filename may contain a tab.
 */

import { shortOid } from "../git.ts";
import type { MergedStatus, OverlayFileStatus } from "../status.ts";
import { columns, displayPath, plural, type Ui } from "../ui.ts";

const KIND_LABEL: Record<OverlayFileStatus["kind"], string> = {
  add: "add",
  override: "override",
  delete: "delete",
};

/** `~` override, `+` add, `-` delete. Also used by `--short`. */
const KIND_MARK: Record<OverlayFileStatus["kind"], string> = {
  add: "+",
  override: "~",
  delete: "-",
};

const abbrev = (oid: string | null): string => shortOid(oid, "?");

/** What the detach marker records, for the human-readable form. */
function detachPhrase(m: NonNullable<MergedStatus["detach"]>): string {
  const at = m.overlayHead === null ? "" : ` at overlay ${abbrev(m.overlayHead)}`;
  const head = `detached ${m.detachedAt}${at}, ${plural(m.paths.length, "path")}`;
  // The two lists are only filled in by the final write, so on an interrupted detach they
  // are empty and mean nothing.
  return m.complete
    ? `${head} (${m.restored.length} restored from the base, ${m.removed.length} removed)`
    : head;
}

function branchPhrase(branch: string | null, head: string | null): string {
  if (head === null) return "no commits yet";
  if (branch === null) return `HEAD detached at ${abbrev(head)}`;
  return `on branch ${branch}`;
}

function trackingPhrase(o: MergedStatus["overlay"]): string {
  if (o.upstream === null) return "";
  const bits: string[] = [];
  if (o.ahead > 0) bits.push(`ahead ${o.ahead}`);
  if (o.behind > 0) bits.push(`behind ${o.behind}`);
  const state = bits.length > 0 ? bits.join(", ") : "in sync";
  return `, tracking ${o.upstream} (${state})`;
}

/** Human words for one owned path's state. Empty when the path is exactly as recorded. */
export function fileNotes(f: OverlayFileStatus): string[] {
  const notes: string[] = [];
  if (f.staged) notes.push("staged");
  if (f.kind === "delete") {
    if (f.worktreeDirty) notes.push("file is back in the work-tree");
  } else {
    if (f.missing) notes.push("missing from the work-tree");
    else if (f.worktreeDirty) notes.push("modified");
  }
  switch (f.upstream) {
    case "changed":
      notes.push("upstream changed");
      break;
    case "deleted":
      notes.push("upstream deleted it");
      break;
    case "added":
      notes.push("the base now tracks this path");
      break;
    case "unknown":
      notes.push("upstream unknown");
      break;
    case "same":
      break;
  }
  return notes;
}

/* ------------------------------------------------------------------ long form */

export function renderStatusLong(s: MergedStatus, ui: Ui): string[] {
  const out: string[] = [];
  const head = (t: string): string => ui.s(t, "bold");

  out.push(
    ...columns(
      [
        ["base repo", branchPhrase(s.base.branch, s.base.head)],
        ["overlay", branchPhrase(s.overlay.branch, s.overlay.head) + trackingPhrase(s.overlay)],
      ],
      "",
      "   ",
    ),
  );

  if (s.detached) {
    const m = s.detach;
    out.push("");
    out.push(ui.s("the overlay is DETACHED", "yellow", "bold"));
    if (m !== null && m.detachedAt !== "") out.push(`  ${detachPhrase(m)}`);
    if (m !== null && !m.complete) {
      // Written before the first mutation, so this is the one reading that matters: the
      // work-tree is somewhere between the overlay's content and the base's.
      out.push("  that detach was interrupted, so the work-tree is only half unmounted");
      out.push("  run `overgit attach` to rebuild it from the overlay");
    } else {
      out.push("  the work-tree holds pristine base content; no overlay file is applied");
      out.push("  run `overgit attach` to mount the overlay again");
    }
  }

  if (s.syncInProgress) {
    out.push("");
    out.push(ui.s("a sync is in progress", "yellow", "bold"));
    out.push("  resolve the conflicted files, then `overgit sync --continue`");
    out.push("  or `overgit sync --abort` to put everything back");
  }

  out.push("");
  if (s.files.length === 0) {
    out.push("the overlay owns nothing yet");
    out.push("  `overgit add <path>` takes a file: tracked by the base becomes an override,");
    out.push("  untracked becomes an add");
  } else {
    out.push(head(`overlay owns ${plural(s.files.length, "path")}`));
    out.push(
      ...columns(
        s.files.map((f) => {
          const notes = fileNotes(f);
          return [
            colourKind(ui, f.kind),
            displayPath(f.path),
            notes.length > 0 ? ui.s(notes.join(", "), "dim") : "",
          ];
        }),
      ),
    );
  }

  out.push("");
  if (s.base.entries.length === 0) {
    out.push(`${head("base changes")}   none`);
  } else {
    out.push(head("base changes") + ui.s("   (paths the overlay owns are not listed)", "dim"));
    out.push(
      ...columns(
        s.base.entries.map((e) => [
          `${e.x}${e.y}`.replace(/ /g, "·"),
          e.origPath === undefined
            ? displayPath(e.path)
            : `${displayPath(e.origPath)} -> ${displayPath(e.path)}`,
        ]),
      ),
    );
  }

  // `pullBlocked` is a subset of `syncPending` by construction, so they share one block:
  // two separate lists of the same paths would just train the reader to skip both.
  const pending = new Set([...s.syncPending, ...s.pullBlocked]);
  if (pending.size > 0) {
    const blocked = new Set(s.pullBlocked);
    out.push("");
    out.push(ui.s(`upstream moved under ${plural(pending.size, "overlay path")}`, "yellow", "bold"));
    out.push(
      ...columns(
        [...pending].map((p) => [
          displayPath(p),
          blocked.has(p) ? ui.s("git in the base will abort on this one", "dim") : "",
        ]),
      ),
    );
    // Mid-sync, `overgit sync` errors with SYNC_IN_PROGRESS — so never print it as the next
    // step while a sync is open, or the tool walks the user into its own error.
    out.push(
      s.syncInProgress
        ? "  run `overgit sync --continue` to finish the sync in progress"
        : "  run `overgit sync` to merge the base's changes into the overlay",
    );
    if (blocked.size > 0) {
      out.push("  `git pull` / `git checkout` refuse to overwrite an overridden file, so until");
      out.push("  then: `overgit detach`, the git command, `overgit attach`");
    }
  }

  // The loudest thing status can say. `base.entries` subtracts overlay-owned paths — that is
  // what makes this a merged view — but the subtraction also hid the one case that matters
  // most: a leak is *always* at an owned path, so the merged view was reporting "base changes
  // none" at exactly the moment `git add -A` would have committed the user's private content.
  if (s.visibleToBase.length > 0) {
    out.push("");
    out.push(
      ui.s(
        `the base can see ${plural(s.visibleToBase.length, "overlay path")} — this is a leak`,
        "red",
        "bold",
      ),
    );
    out.push(...columns(s.visibleToBase.map((p) => [displayPath(p), ""])));
    out.push("  a plain `git add -A && git commit` in the base would capture them");
    out.push("  run `overgit doctor --fix` to hide them again");
  }

  // Between `git fetch` and `git pull` the base's HEAD has not moved, so nothing above
  // fires — yet the change is already sitting in the base's refs. Say so, and name the owned
  // paths it touches, because those are the ones that will make the pull abort.
  const bu = s.baseUpstream;
  if (bu.name !== null && bu.behind > 0) {
    out.push("");
    out.push(
      ui.s(
        `base upstream   ${plural(bu.behind, "commit")} behind ${bu.name}, not yet pulled`,
        "yellow",
        "bold",
      ),
    );
    if (bu.touchesOwned.length > 0) {
      out.push(
        ...columns(
          bu.touchesOwned.map((p) => [displayPath(p), ui.s("the overlay owns this one", "dim")]),
        ),
      );
      out.push("  `git pull` will abort on it — run `overgit detach`, `git pull`,");
      out.push("  `overgit attach`, then `overgit sync`");
    } else {
      out.push("  nothing the overlay owns — a plain `git pull` is safe");
    }
  }

  out.push("");
  out.push(
    s.problems === 0
      ? `${head("doctor")}   no problems`
      : `${head("doctor")}   ${ui.s(`${plural(s.problems, "problem")} — run \`overgit doctor\``, "yellow")}`,
  );

  return out;
}

function colourKind(ui: Ui, kind: OverlayFileStatus["kind"]): string {
  const label = KIND_LABEL[kind];
  switch (kind) {
    case "add":
      return ui.s(label, "green");
    case "override":
      return ui.s(label, "blue");
    case "delete":
      return ui.s(label, "magenta");
  }
}

/* ------------------------------------------------------------------ short form */

/** `KSWU <path>`, four fixed columns. The legend is in `overgit help status`. */
export function renderStatusShort(s: MergedStatus): string[] {
  const out: string[] = [];
  if (s.detached) out.push("# detached");
  if (s.detach !== null && !s.detach.complete) out.push("# detach-interrupted");
  if (s.syncInProgress) out.push("# sync-in-progress");

  for (const f of s.files) {
    const k = KIND_MARK[f.kind];
    const st = f.staged ? "S" : ".";
    const w =
      f.kind === "delete"
        ? f.worktreeDirty
          ? "!"
          : "."
        : f.missing
          ? "!"
          : f.worktreeDirty
            ? "M"
            : ".";
    const u =
      f.upstream === "changed"
        ? "<"
        : f.upstream === "deleted"
          ? "x"
          : f.upstream === "added"
            ? "+"
            : f.upstream === "unknown"
              ? "?"
              : ".";
    out.push(`${k}${st}${w}${u} ${displayPath(f.path)}`);
  }

  for (const e of s.base.entries) {
    out.push(`b${e.x}${e.y}. ${displayPath(e.path)}`);
  }

  if (s.problems > 0) out.push(`# ${plural(s.problems, "problem")} — run \`overgit doctor\``);
  return out;
}

/* ------------------------------------------------------------------ porcelain */

const P_VERSION = "1";

/**
 * Record names and field order are a CLI contract; `overgit help status` is where they are
 * written down. The path is always the last field, so a consumer splits on NUL and then on
 * the first N tabs.
 */
export function renderStatusPorcelain(s: MergedStatus): string {
  const rec: string[] = [];
  const push = (...fields: (string | number)[]): void => {
    rec.push(fields.join("\t") + "\0");
  };

  push("version", P_VERSION);
  push("base.branch", s.base.branch ?? "");
  push("base.head", s.base.head ?? "");
  push("overlay.branch", s.overlay.branch ?? "");
  push("overlay.head", s.overlay.head ?? "");
  push("overlay.upstream", s.overlay.upstream ?? "");
  push("overlay.ahead", s.overlay.ahead);
  push("overlay.behind", s.overlay.behind);
  push("detached", s.detached ? 1 : 0);
  if (s.detach !== null) {
    push(
      "detach",
      s.detach.detachedAt,
      s.detach.overlayHead ?? "",
      s.detach.paths.length,
      s.detach.complete ? 1 : 0,
    );
  }
  push("sync-in-progress", s.syncInProgress ? 1 : 0);
  push("problems", s.problems);

  for (const f of s.files) {
    push(
      "file",
      f.kind,
      f.staged ? 1 : 0,
      f.worktreeDirty ? 1 : 0,
      f.missing ? 1 : 0,
      f.upstream,
      f.path,
    );
  }
  for (const e of s.base.entries) {
    push("base", `${e.x}${e.y}`, e.path);
    if (e.origPath !== undefined) push("base-orig", `${e.x}${e.y}`, e.origPath);
  }
  for (const p of s.syncPending) push("sync-pending", p);
  for (const p of s.pullBlocked) push("pull-blocked", p);

  return rec.join("");
}
