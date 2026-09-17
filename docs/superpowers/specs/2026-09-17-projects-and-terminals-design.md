# Sonic — Projects with Multiple Terminals

**Date:** 2026-09-17
**Status:** Approved design, pre-implementation
**Author:** Philipp Spinnler

## 1. Problem

A sidebar row in Sonic is exactly one pty running one `claude`. Working on a project often
needs a second terminal in the same folder and identity: a plain shell to run tests, git, a dev
server, or tail logs, and sometimes a second Claude Code agent working in parallel. Today the
only options are a separate terminal app (losing the profile environment) or a second Sonic
session (a duplicate row with no relationship to the first).

## 2. Goals

- A sidebar row becomes a **project**: a profile plus a folder that owns one or more terminals.
- A project always has a Claude terminal from the moment it is created. No empty projects.
- Terminals are either **claude** (what Sonic runs today) or **shell** (the user's login shell in
  the project folder with the profile environment applied).
- A project with only its default Claude terminal looks and behaves exactly like a row today.
- Existing state files migrate automatically. No user-visible change for users who never add a
  second terminal.

## 3. Non-Goals (YAGNI)

- Split panes. One terminal is visible at a time; nested rows plus keyboard cycling cover the
  need for now, and splits touch the terminal fit logic that has been fragile.
- Project-level features beyond grouping (per-project env, editor integration, tasks). The
  container model leaves room for them; none are built here.
- Reordering terminals within a project. They keep creation order.
- Changing what happens when a profile is deleted while in use. Behavior stays as it is today.

## 4. Data Model

### 4.1 Persisted state (Rust, `state.json` version 2)

```rust
struct ProjectRecord {
    id: String,
    name: String,
    profile_id: String,
    cwd: String,
    created_at: String,
    terminals: Vec<TerminalRecord>,   // ordered, never empty on disk
}

struct TerminalRecord {
    id: String,
    kind: TerminalKind,               // Claude | Shell
    name: Option<String>,             // None = default name derived from kind and position
    claude_session_id: Option<String>, // Claude terminals only; used for --resume
    created_at: String,
}
```

`AppState.sessions` is replaced by `AppState.projects`. `recent_folders`, `settings` and
`restore_all_on_launch` are unchanged.

### 4.2 Migration

`state_version` becomes 2. Loading a version 1 file maps every `SessionRecord` to a
`ProjectRecord` with one Claude terminal whose `claude_session_id` is the old record's value.
Project id, name, profile, cwd and created_at carry over unchanged; the terminal gets a fresh id.
The migration is a pure function with a unit test and runs once, on load.

### 4.3 Invariants (enforced in Rust)

- Creating a project creates its first Claude terminal in the same operation.
- A project has at least one terminal. Closing the last terminal closes the project.
- The **primary** terminal of a project is its first Claude terminal. It is the default target
  for `⌘1-9` and for a click on the project row.

### 4.4 Runtime state (Rust)

- `procs: HashMap<TerminalId, SessionProc>` — live ptys, keyed by terminal id.
- Status is keyed by terminal id. `SONIC_SESSION_ID` carries the terminal id, so the hook script
  and socket protocol are unchanged. A `claude` started by hand inside a shell terminal therefore
  reports status to that shell's row.

### 4.5 Views sent to the frontend

```ts
interface ProjectView {
  id: string; name: string; cwd: string; branch: string | null;
  profileId: string; profileName: string; profileColor: string;
  terminals: TerminalView[];          // creation order
}
interface TerminalView {
  id: string; kind: "claude" | "shell"; name: string;  // name already defaulted
  status: Status;                      // idle | working | waiting | exited | unknown
  workingSince?: number;               // frontend-only, as today
}
```

One `projects` event replaces today's `sessions` event.

## 5. Sidebar and Selection

- A project with exactly one terminal renders as a single row identical to today's session row.
- With two or more terminals, terminal rows render indented under the project row. Each shows a
  status dot, a kind glyph (`✦` claude, `$` shell) and its name.
- Default names: `claude`, `claude 2`, `shell`, `shell 2`, numbered per kind within the project.
  Double-click renames a terminal or a project, as today.
- The project row's dot is a **rollup**: `waiting` > `working` > `idle` > `exited`. Shell
  terminals contribute only `exited`, so a live shell is silent and a dead one is visible.
- Selection is one `selectedTerminalId`. The project row highlights when any of its terminals is
  selected; the selected terminal row highlights within it.
- The frontend remembers the last selected terminal per project. Selecting a project (row click
  or `⌘1-9`) shows that terminal, falling back to the primary.
- Drag reorder moves whole projects. Terminal order is fixed.
- The working-time label moves to the terminal row when rows are expanded, and shows on the
  project row (for the primary) when collapsed.

## 6. Backend Commands

| Command | Effect |
|---|---|
| `new_project(profile_id, cwd, name?, resume_id?)` | Creates the project and its default Claude terminal (resuming if an id is given); returns both ids |
| `add_terminal(project_id, kind, resume_id?)` | Spawns a shell or Claude terminal in the project's folder and profile; `resume_id` applies to Claude terminals only |
| `close_terminal(id)` | Kills one pty; closes the project if it was the last terminal |
| `close_project(id)` | Kills every terminal in the project and removes it |
| `rename_project(id, name)`, `rename_terminal(id, name)` | As today's rename |
| `reorder_projects(ids)` | As today's reorder |
| `write_stdin(terminal_id, data)`, `resize(terminal_id, cols, rows)` | Unchanged shape, terminal id |
| `list_projects()` | Current views |
| `previous_projects()`, `discard_previous()` | Restore support, project-shaped |

`start_session` is removed. Restore uses `new_project` for the first Claude terminal (with its
resume id) and `add_terminal` for the rest.

### 6.1 Spawning

`SpawnSpec` gains `kind`. One spawn function, one branch:

- **Claude**: exactly today's command line (`claude`, optional `--resume`, configured binary).
- **Shell**: `$SHELL` with `/bin/zsh` as fallback, run as a login shell in the project folder.

Both set `CLAUDE_CONFIG_DIR`, the profile's env, `SONIC_SESSION_ID` (terminal id),
`SONIC_SOCKET` and `TERM`, and strip the nested-session markers, exactly as today.

## 7. Actions and Keyboard

| Shortcut | Action |
|---|---|
| `⌘N` | New project (profile, folder); opens with its Claude terminal |
| `⌘T` | New shell in the selected project |
| `⌘⇧T` | New Claude terminal in the selected project |
| `⌘W` | Close the selected terminal; closes the project if it was the last |
| `⌘⇧W` | Close the whole selected project |
| `⌘1` … `⌘9` | Jump to the n-th project, showing its remembered terminal |
| `⌘⇧]` / `⌘⇧[` | Next / previous terminal within the selected project |

Closing anything that is `working` asks first, as today. Closing a project with several
terminals asks once for the project.

Context menu, project row: Rename, New shell here, New Claude session here, Reveal folder in
Finder, Copy folder path, Close project. Terminal row: Rename, Close terminal.

File drops paste into the active terminal, as today.

## 8. Restore, Notifications, Edge Cases

- **Restore on launch** rebuilds each project in order, then its terminals in order. Claude
  terminals resume by id; shells start fresh in the same folder. The restore dialog lists
  projects. Auto-restore after an update restores everything, as today.
- **Notifications and dock badge** stay per terminal. The notification title is the project
  name, extended to `project · terminal` when the project has more than one terminal.
- **A terminal exits**: its row turns red and stays until closed, as today. If it was the last
  terminal, the project stays visible with the red rollup so the exit is noticed.
- **Unknown terminal id** on stdin/resize/status: ignored, as today for unknown sessions.
- **Profile deleted** while in use: unchanged from today.

## 9. Frontend Changes

- `store.ts`: state becomes `{ projects, selectedTerminalId }` plus a per-project last-selected
  map. `workingSince` tracking moves to terminals.
- `terminals.ts`: panes keyed by terminal id. No behavior change otherwise.
- `sidebar.ts`: renders projects with optional nested terminal rows; rollup and default naming
  are pure helpers in a new `projects.ts`.
- `restore.ts`, `newSession.ts`, `notify.ts`, `main.ts` (shortcuts), `contextMenu.ts` callers:
  adapted to projects and terminals.
- `ipc.ts`: new command bindings; `startSession` removed.

## 10. Testing

Rust unit tests:
- Version 1 to version 2 migration produces one Claude terminal per old session with the resume
  id preserved.
- Creating a project yields exactly one Claude terminal.
- Closing the last terminal removes the project; closing a non-last one does not.
- Rollup ordering, including shells contributing only `exited`.
- Shell spawn sets the profile env and runs in the project folder (extend the fake-binary test).

TypeScript (vitest):
- Default naming per kind and position.
- Terminal cycling order with `⌘⇧]` / `⌘⇧[` wrapping.
- Remembered terminal per project with fallback to primary.
- Sortable tests adjusted to project ids.

Manual: spawn a shell in the dev build, type `claude`, confirm the shell row's dot follows it.

## 11. Build Order (high level)

1. Rust: records, migration, invariants, tests. No behavior change yet.
2. Rust: spawn `kind`, commands, views, restore support.
3. Frontend: store and pure helpers with tests.
4. Frontend: sidebar rendering, selection, shortcuts, context menu.
5. Restore, notifications, README keyboard table.
