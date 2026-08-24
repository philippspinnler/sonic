# Sonic — Design Spec

**Date:** 2026-08-24
**Status:** Approved design, pre-implementation
**Author:** Philipp Spinnler

## 1. Problem

The author works with several separate Claude Code identities — private, work, client projects, and more to come. Each identity is a separate `CLAUDE_CONFIG_DIR` (different Claude account, different MCP servers, different settings). Today this is managed with shell aliases that export the right config dir, which is clumsy: no overview of running sessions, no status visibility, and starting a session means remembering the right alias and cd-ing to the right folder.

Existing tools were evaluated (Claudy, AgentsRoom, claude-control, llmux, `claude agents`, Orca, Crystal, Conductor). None combine **identity-separated profiles** with a **lean live session dashboard**; the closest either lack profile isolation or bundle heavy orchestration features that are not wanted.

## 2. Goals

- One macOS window that lists all active Claude Code sessions in a left sidebar.
- Per-session status indicator: **idle**, **working**, or **waiting for input**.
- `Cmd+N` starts a new session: pick a profile (Claude instance), pick a folder, go.
- Full in-app profile management: create a profile (isolated config dir + guided login), import existing config dirs, edit, delete.
- macOS notification + dock badge when a non-focused session starts waiting for input.
- Recent-folder quick pick per profile in the new-session dialog.
- Sessions can be renamed in the sidebar.
- On relaunch, previously running sessions can be resumed (`claude --resume`).
- Written in Rust (Tauri 2 backend); lean by design.

## 3. Non-Goals (YAGNI)

- Git worktree management, parallel-agent orchestration, task backlogs, agent teams.
- Windows/Linux support (macOS only for v1; Tauri keeps the door open).
- Usage/rate-limit tracking, account auto-switching on limits.
- Detached sessions surviving app quit (explicitly decided against: sessions are child processes; resume covers the restart case).
- Any modification of Claude Code itself; only official mechanisms (env vars, hooks, `--resume`) are used.
- Support for other agents (Codex, Gemini, etc.).

## 4. Architecture Overview

Tauri 2 application. The **Rust core** owns all state and processes; the **webview frontend** (vanilla TypeScript + xterm.js, no UI framework) is a thin renderer.

```
┌────────────────────────────── Sonic.app ──────────────────────────────┐
│  Rust core (Tauri backend)                                            │
│  ┌────────────┐ ┌───────────────┐ ┌──────────────┐ ┌───────────────┐  │
│  │  Profile   │ │   Session     │ │ Status       │ │  State store  │  │
│  │  registry  │ │   manager     │ │ listener     │ │  (persistence)│  │
│  │            │ │ (PTY spawn)   │ │ (unix socket)│ │               │  │
│  └────────────┘ └──────┬────────┘ └──────▲───────┘ └───────────────┘  │
│                        │ PTY I/O         │ status events              │
│         Tauri IPC (commands + events)    │                            │
├──────────────────────────────────────────┼────────────────────────────┤
│  Webview frontend (TS + xterm.js)        │                            │
│  sidebar · terminal panes · dialogs      │                            │
└──────────────────────────────────────────┼────────────────────────────┘
                                           │
      claude process (per session) ── hooks fire ── hook.sh ── unix socket
```

Each session is a `claude` process on its own PTY, spawned with the profile's `CLAUDE_CONFIG_DIR` plus a `SONIC_SESSION_ID` env var. Hooks installed into each profile's `settings.json` report state transitions to the app over a unix socket. The webview renders each session in an xterm.js pane; only the selected session's pane is visible.

## 5. Components

### 5.1 Profile registry (Rust)

Owns the list of profiles. Persisted as `profiles.json` in the app data dir (`~/Library/Application Support/com.sonic.app/`).

Profile record:

```json
{
  "id": "uuid",
  "name": "acme corp",
  "config_dir": "~/Library/Application Support/com.sonic.app/profiles/acme-corp",
  "managed": true,
  "env": { "OPTIONAL_EXTRA": "value" },
  "color": "#7aa2f7"
}
```

- **Managed** profiles: the app created `config_dir` (under `<data>/profiles/<slug>/`) and may delete it on profile removal (with confirmation; directory is moved to Trash, never `rm -rf`).
- **Imported** profiles: `config_dir` points at a pre-existing directory (e.g. `~/.claude-acme`). Deletion only removes the registry entry, never touches the directory.
- `env`: extra environment variables applied to every session of this profile.
- `color`: sidebar tag color, assigned from a fixed palette at creation, editable.

Operations exposed as Tauri commands: `list_profiles`, `create_profile(name)`, `import_profile(name, path)`, `update_profile`, `delete_profile(id)`.

**Profile creation flow:** `create_profile` makes the directory, installs hooks (5.3), then the frontend opens a one-off **setup terminal pane** running `claude` with that `CLAUDE_CONFIG_DIR` so the user completes `/login` (and any MCP setup) interactively. Closing the pane finishes setup. The same pane can be reopened later from profile settings ("Open profile terminal") for MCP changes or re-login.

**Import flow:** native folder picker → sanity check (warn if the directory contains none of `settings.json` / `.credentials.json`, but allow) → install hooks (5.3).

### 5.2 Session manager (Rust)

Owns running sessions. One session = one `claude` child process on a PTY (`portable-pty` crate).

Session record (in-memory + persisted, see 5.4):

```json
{
  "id": "uuid",
  "name": "api refactor",
  "profile_id": "uuid",
  "cwd": "~/Workspace/acme/api",
  "status": "idle | working | waiting | exited",
  "claude_session_id": "captured from first hook event, nullable",
  "created_at": "iso8601"
}
```

Spawn: `claude` (binary resolved via the user's login shell `PATH`; overridable in app settings), with:

- `cwd` = chosen folder
- env = inherited login-shell env + `CLAUDE_CONFIG_DIR=<profile.config_dir>` + `SONIC_SESSION_ID=<session.id>` + profile `env` overrides
- PTY sized to the pane; resize events from the frontend are forwarded via `TIOCSWINSZ` (portable-pty API).

I/O: PTY output bytes are streamed to the frontend over a Tauri channel per session (raw bytes; xterm.js writes them directly). Keyboard input from xterm.js goes back over a Tauri command into the PTY. No parsing of terminal content — the stream is opaque.

Exit: when the child exits, status becomes `exited`; the pane shows the final screen plus a "session ended — restart / resume / close" bar. Closing a session with status `working` prompts for confirmation.

Commands: `start_session(profile_id, cwd, resume_claude_session_id?)`, `write_stdin(session_id, bytes)`, `resize(session_id, cols, rows)`, `rename_session(session_id, name)`, `close_session(session_id)`.

### 5.3 Status detection via hooks (Rust + shell)

The app installs three hooks into each profile's `<config_dir>/settings.json`:

| Hook event        | Reported state |
|-------------------|----------------|
| `UserPromptSubmit`| `working`      |
| `Notification`    | `waiting` (covers both permission requests and idle-prompt notifications) |
| `Stop`            | `idle`         |

All three run the same helper script, shipped by the app to `<data>/hook.sh`:

```sh
#!/bin/sh
# sonic status hook — no-ops outside sonic-managed sessions
[ -z "$SONIC_SESSION_ID" ] && exit 0
payload=$(cat)   # hook JSON from Claude Code on stdin (contains session_id)
printf '{"sonic_session":"%s","state":"%s","hook":%s}' \
  "$SONIC_SESSION_ID" "$1" "$payload" | nc -U "$SONIC_SOCKET" 2>/dev/null
exit 0
```

- `SONIC_SOCKET` is set per-session by the session manager (path: `<data>/sonic.sock`).
- The guard makes the hook a silent no-op when the profile is used outside Sonic (plain `claude` in a terminal keeps working, unaffected).
- The forwarded Claude Code payload gives us `session_id` (Claude's own), captured on first event and stored as `claude_session_id` for later `--resume`.

**Settings merge policy:** hooks are *merged* into `settings.json`, never overwritten. Before the first write, the file is backed up to `settings.json.sonic-backup`. Sonic's entries are identifiable (command path contains `hook.sh`) so installation is idempotent and uninstallable. Existing user hooks on the same events are preserved (Claude Code supports multiple hooks per event).

**Status listener:** a tokio unix-socket listener in the Rust core. Each connection delivers one JSON event → session status updated → `status_changed` event emitted to the frontend. Unknown `sonic_session` ids are ignored. State also transitions to `working` locally when the user submits input, as a fast-path; hooks remain the source of truth.

### 5.4 State store (Rust)

`state.json` in the app data dir, written on change (debounced):

- session records (5.2) — for **resume on relaunch**
- recent folders per profile (max 10, most-recent first)
- window size/position, sidebar width
- app settings (claude binary path override, notification toggle)

**Resume on relaunch:** at startup, if `state.json` contains sessions from the previous run, show a restore sheet listing them (name, profile, folder) with per-session checkboxes; selected ones start as `claude --resume <claude_session_id>` (falling back to a fresh `claude` in the same folder/profile if no id was captured). Unselected records are discarded.

### 5.5 Frontend (TypeScript + xterm.js)

No framework; a small hand-rolled store + DOM rendering. Modules:

- **Sidebar** (left, resizable): vertical session list. Each row: status dot (grey `idle`, pulsing blue `working`, yellow `waiting`, dim red `exited`; grey outline when status is unknown because hooks are unavailable, see §7), session name (double-click or `Enter` to rename inline), profile tag (colored, profile name), folder basename (tooltip: full path). Click to select. Rows ordered by creation; `waiting` rows get a subtle highlight. Bottom of sidebar: "＋ New session" button and a gear (settings).
- **Terminal area**: one xterm.js instance per session, kept alive (so scrollback survives switching), only the selected one visible. Fit addon for resize; WebGL addon for rendering.
- **New-session dialog** (`Cmd+N`): step 1 — profile list (keyboard navigable, `1..9` quick select); step 2 — recent folders for that profile (top) + "Browse…" opening the native folder picker (Tauri dialog plugin). `Enter` starts the session and focuses its pane.
- **Settings screen**: profile list with create / import / edit (name, color, env vars) / delete / "Open profile terminal"; app settings (claude path, notifications on/off).
- **Restore sheet**: shown at launch when previous sessions exist (5.4).

Keyboard shortcuts: `Cmd+N` new session, `Cmd+W` close selected session (confirm if working), `Cmd+1..9` select session by position, `Cmd+,` settings. Registered via the native menu (Tauri menu API) so they behave like a real Mac app and don't fight xterm.js focus.

### 5.6 Notifications (Rust)

When a session transitions to `waiting` and it is not the selected session of a focused window: post a macOS notification ("*name* is waiting for your input — *profile*") via the Tauri notification plugin, and set the dock badge to the count of `waiting` sessions. Badge clears as sessions are attended. Clicking the notification focuses the app and selects that session.

## 6. Data Flow (happy path)

1. `Cmd+N` → dialog → user picks profile "acme corp" + folder → `start_session`.
2. Rust spawns `claude` on a PTY with `CLAUDE_CONFIG_DIR`, `SONIC_SESSION_ID`, `SONIC_SOCKET`; session appears in sidebar as `idle`; PTY bytes stream into the xterm pane.
3. User types a prompt → `UserPromptSubmit` hook fires → socket event → dot turns blue (`working`).
4. Claude needs a permission decision → `Notification` hook → `waiting` → yellow dot; if unfocused, macOS notification + dock badge.
5. User answers; Claude finishes → `Stop` hook → `idle`.
6. User quits with sessions running → confirmation if any are `working` → children terminated (SIGTERM to process group, SIGKILL after grace) → state persisted.
7. Next launch → restore sheet → selected sessions restart with `claude --resume <id>`.

## 7. Error Handling

- **`claude` not found:** startup check via login shell; blocking banner with a settings link to set the path manually.
- **Hook install failure** (unwritable/malformed `settings.json`): profile is flagged in the UI ("status detection unavailable"); sessions still run, status shows as unknown (grey outline dot). Malformed JSON is never "fixed" automatically.
- **Socket failures:** listener recreates the socket on startup (stale file removed). Hook script failures are silent by design (never break the user's Claude session).
- **PTY spawn failure** (bad folder, permissions): dialog shows the error; no session record is created.
- **Child crash:** treated as exit (5.2); resume path available since folder/profile are known.
- **State file corrupt:** renamed to `state.json.corrupt`, app starts fresh, non-blocking warning shown.
- **Profile deletion:** confirmation dialog; managed dirs go to Trash; running sessions of that profile must be closed first.

## 8. Testing

- **Rust unit tests:** profile registry CRUD + persistence round-trip; settings.json hook merge (empty file, existing hooks on same event, idempotent re-install, backup creation, malformed JSON rejection); state store round-trip; recent-folders logic.
- **Integration test (no real Claude):** a fake `claude` shell script that reads stdin and emits hook calls via `hook.sh`, driven through the real session manager + socket listener — asserts spawn env, status transitions, exit handling, and `claude_session_id` capture.
- **Frontend:** logic kept in pure functions (store reducers, dialog state machine) with vitest tests; DOM/xterm layers stay thin and are covered manually.
- **Manual checklist** (per release): real login flow for a new profile, MCP-heavy profile, notification + badge behavior, resume after quit, resume after force-kill, external `claude` use of a Sonic-managed profile (hook no-op guard).

## 9. Build Order (high level — detailed plan follows separately)

1. Cargo/Tauri scaffold, app data dir, state store.
2. Profile registry + hook installer (pure logic, fully unit-tested).
3. Session manager: PTY spawn/stream/resize/exit with fake claude.
4. Socket listener + status pipeline.
5. Frontend: sidebar + terminal panes + Cmd+N dialog.
6. Profile management UI + setup terminal.
7. Notifications, badge, rename, resume-on-relaunch, polish.

## 10. Open Questions (deferred, not blockers)

- Exact `Notification` hook payload types to distinguish "permission" vs "idle prompt" (both map to `waiting` in v1; finer distinction is a possible later refinement).
- App icon / final name (working name **Sonic** — folder already named accordingly).
