# Projects with Multiple Terminals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each sidebar row into a project that owns one or more terminals (Claude or shell), always starting with a Claude terminal, with nested rows, keyboard cycling, and automatic migration of existing state.

**Architecture:** Rust owns the model: `ProjectRecord { terminals: Vec<TerminalRecord> }` persisted in `state.json` version 2, with migration from version 1 on load. Live ptys, statuses and events are keyed by terminal id, so the hook socket protocol is untouched. The frontend store holds `projects` plus one selected terminal id and a per-project "last selected" memory; the sidebar renders a `.project-group` per project containing the project row and, when there are two or more terminals, indented terminal rows.

**Tech Stack:** Rust (Tauri 2, serde, portable-pty), TypeScript (Vite, vitest, xterm.js). Tests: `cargo test` in `src-tauri`, `npx vitest run` at the repo root. Typecheck: `npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-09-17-projects-and-terminals-design.md`

## Global Constraints

- Commits are authored by the repository owner with no attribution trailers, and mention Claude only as the product feature name ("Claude terminal").
- `state.json` version becomes `2`. Version 1 files (or files without a version) migrate on load; nothing else in the file format changes.
- A project always has at least one terminal; creating a project creates its Claude terminal in the same operation.
- `SONIC_SESSION_ID` carries the terminal id. The hook script and socket JSON are unchanged.
- Shell terminals run `$SHELL` (fallback `/bin/zsh`) as a login shell in the project folder with the profile's `CLAUDE_CONFIG_DIR` and env.
- No split panes, no terminal reordering inside a project.
- Between Task 3 and Task 5 the TypeScript build is intentionally broken (backend API renamed before the frontend follows). `cargo test` must pass at every commit; `npx tsc --noEmit` and `npx vitest run` must pass again from Task 5 onward.

---

## File Structure

**Rust (`src-tauri/src/`)**
- `state_store.rs` — modify: `TerminalKind`, `TerminalRecord`, `ProjectRecord`, `AppState.projects`, version-1 migration, invariants (`remove_terminal`, `primary`, `terminal_name`).
- `sessions.rs` — modify: `SpawnCommand` enum (Claude vs Shell) on `SpawnSpec`, `login_shell()`.
- `commands.rs` — modify: project/terminal commands, `ProjectView`/`TerminalView`, events renamed to `projects-changed`, `terminal-data`, `terminal-status`.
- `lib.rs` — modify: restorable projects, menu items, handler list.

**TypeScript (`src/`)**
- `store.ts` — modify: `ProjectView`/`TerminalView` state, `setProjects`, `selectProject`, `findTerminal`, `allTerminals`.
- `projects.ts` — create: pure helpers `primaryTerminal`, `rollupStatus`, `cycleTerminal`, `terminalLabel`.
- `projects.test.ts` — create. `store.test.ts` — rewrite.
- `ipc.ts` — modify: new commands and events.
- `actions.ts` — modify: close/add/restart helpers for terminals and projects.
- `main.ts`, `terminals.ts`, `newSession.ts`, `settings.ts`, `restore.ts`, `notify.ts`, `emptyState.ts`, `updateBanner.ts` — modify: adapt to projects.
- `sidebar.ts` — rewrite: project groups with nested terminal rows, drag by group.
- `styles.css` — modify: terminal rows, group drag.
- `README.md` — modify: keyboard table, wording.

---

### Task 1: State model, migration and invariants (Rust)

**Files:**
- Modify: `src-tauri/src/state_store.rs`

**Interfaces:**
- Produces:
  - `pub enum TerminalKind { Claude, Shell }` (serde lowercase: `"claude"`, `"shell"`)
  - `pub struct TerminalRecord { id, kind, name: Option<String>, claude_session_id: Option<String>, created_at }`
  - `pub struct ProjectRecord { id, name, profile_id, cwd, created_at, terminals: Vec<TerminalRecord> }` with `fn primary(&self) -> Option<&TerminalRecord>` and `fn terminal_name(&self, id: &str) -> Option<String>`
  - `AppState { projects: Vec<ProjectRecord>, .. }` with `fn project_of(&self, terminal_id) -> Option<&ProjectRecord>`, `fn project_of_mut(&mut self, terminal_id) -> Option<&mut ProjectRecord>`, `fn remove_terminal(&mut self, terminal_id) -> Option<(String, bool)>`
  - `pub fn session_to_project(s: SessionRecordV1) -> ProjectRecord`
  - `pub const STATE_VERSION: u32 = 2`
- Consumed by: Tasks 2, 3.

- [ ] **Step 1: Write the failing tests**

Replace the whole `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/state_store.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn term(id: &str, kind: TerminalKind) -> TerminalRecord {
        TerminalRecord { id: id.into(), kind, name: None, claude_session_id: None, created_at: "2026-09-17".into() }
    }

    fn project(id: &str, terminals: Vec<TerminalRecord>) -> ProjectRecord {
        ProjectRecord {
            id: id.into(), name: "n".into(), profile_id: "p".into(),
            cwd: "/tmp".into(), created_at: "2026-09-17".into(), terminals,
        }
    }

    #[test]
    fn load_missing_returns_default() {
        let d = tempdir().unwrap();
        assert_eq!(load(d.path()), AppState::default());
    }

    #[test]
    fn save_load_roundtrip() {
        let d = tempdir().unwrap();
        let mut s = AppState::default();
        s.projects.push(project("a", vec![term("t1", TerminalKind::Claude), term("t2", TerminalKind::Shell)]));
        s.settings.claude_bin = Some("/opt/claude".into());
        save(d.path(), &s).unwrap();
        assert_eq!(load(d.path()), s);
    }

    #[test]
    fn corrupt_file_renamed_and_default_returned() {
        let d = tempdir().unwrap();
        std::fs::write(d.path().join("state.json"), "{not json").unwrap();
        assert_eq!(load(d.path()), AppState::default());
        assert!(d.path().join("state.json.corrupt").exists());
    }

    #[test]
    fn push_recent_dedupes_fronts_and_caps() {
        let mut s = AppState::default();
        for i in 0..12 { push_recent(&mut s, "p1", &format!("/f{i}")); }
        push_recent(&mut s, "p1", "/f5");
        let l = &s.recent_folders["p1"];
        assert_eq!(l.len(), MAX_RECENT);
        assert_eq!(l[0], "/f5");
        assert_eq!(l.iter().filter(|f| *f == "/f5").count(), 1);
    }

    #[test]
    fn legacy_file_without_version_loads_as_current() {
        let d = tempdir().unwrap();
        std::fs::write(d.path().join("state.json"), r#"{"sessions":[],"settings":{"notifications":false}}"#).unwrap();
        let s = load(d.path());
        assert_eq!(s.version, STATE_VERSION);
        assert!(!s.settings.notifications);
        assert_eq!(s.settings.font_size, 13);
    }

    #[test]
    fn v1_session_migrates_to_project_with_one_claude_terminal() {
        let d = tempdir().unwrap();
        std::fs::write(
            d.path().join("state.json"),
            r#"{"version":1,"sessions":[{"id":"s1","name":"web","profile_id":"p1","cwd":"/w",
                "claude_session_id":"cc-1","created_at":"2026-08-24T00:00:00Z"}],
                "recent_folders":{"p1":["/w"]},"restore_all_on_launch":true}"#,
        ).unwrap();
        let s = load(d.path());
        assert_eq!(s.version, 2);
        assert_eq!(s.projects.len(), 1);
        let p = &s.projects[0];
        assert_eq!((p.id.as_str(), p.name.as_str(), p.profile_id.as_str(), p.cwd.as_str()), ("s1", "web", "p1", "/w"));
        assert_eq!(p.created_at, "2026-08-24T00:00:00Z");
        assert_eq!(p.terminals.len(), 1);
        assert_eq!(p.terminals[0].kind, TerminalKind::Claude);
        assert_eq!(p.terminals[0].claude_session_id.as_deref(), Some("cc-1"));
        assert!(!p.terminals[0].id.is_empty());
        assert_eq!(s.recent_folders["p1"], vec!["/w".to_string()]);
        assert!(s.restore_all_on_launch);
        // migrated state is written back in the new format on next save
        save(d.path(), &s).unwrap();
        assert_eq!(load(d.path()), s);
    }

    #[test]
    fn terminal_names_are_numbered_per_kind() {
        let p = project("a", vec![
            term("c1", TerminalKind::Claude), term("s1", TerminalKind::Shell),
            term("c2", TerminalKind::Claude), term("s2", TerminalKind::Shell),
        ]);
        assert_eq!(p.terminal_name("c1").as_deref(), Some("claude"));
        assert_eq!(p.terminal_name("s1").as_deref(), Some("shell"));
        assert_eq!(p.terminal_name("c2").as_deref(), Some("claude 2"));
        assert_eq!(p.terminal_name("s2").as_deref(), Some("shell 2"));
        assert_eq!(p.terminal_name("nope"), None);
    }

    #[test]
    fn custom_terminal_name_wins() {
        let mut p = project("a", vec![term("c1", TerminalKind::Claude)]);
        p.terminals[0].name = Some("tests".into());
        assert_eq!(p.terminal_name("c1").as_deref(), Some("tests"));
    }

    #[test]
    fn primary_is_first_claude_terminal() {
        let p = project("a", vec![term("s1", TerminalKind::Shell), term("c1", TerminalKind::Claude)]);
        assert_eq!(p.primary().unwrap().id, "c1");
        let only_shell = project("b", vec![term("s1", TerminalKind::Shell)]);
        assert_eq!(only_shell.primary().unwrap().id, "s1");
        assert!(project("c", vec![]).primary().is_none());
    }

    #[test]
    fn remove_terminal_keeps_project_unless_last() {
        let mut s = AppState::default();
        s.projects.push(project("a", vec![term("c1", TerminalKind::Claude), term("s1", TerminalKind::Shell)]));
        assert_eq!(s.remove_terminal("s1"), Some(("a".to_string(), false)));
        assert_eq!(s.projects[0].terminals.len(), 1);
        assert_eq!(s.remove_terminal("c1"), Some(("a".to_string(), true)));
        assert!(s.projects.is_empty());
        assert_eq!(s.remove_terminal("c1"), None);
    }

    #[test]
    fn project_of_finds_by_terminal_id() {
        let mut s = AppState::default();
        s.projects.push(project("a", vec![term("c1", TerminalKind::Claude)]));
        s.projects.push(project("b", vec![term("c2", TerminalKind::Claude)]));
        assert_eq!(s.project_of("c2").unwrap().id, "b");
        assert!(s.project_of("zz").is_none());
        s.project_of_mut("c1").unwrap().name = "renamed".into();
        assert_eq!(s.projects[0].name, "renamed");
    }

    #[test]
    fn notifications_default_true() {
        assert!(AppState::default().settings.notifications);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test state_store 2>&1 | tail -20`
Expected: compile errors (`TerminalKind`, `ProjectRecord`, `projects` not found).

- [ ] **Step 3: Implement the model and migration**

Replace everything in `src-tauri/src/state_store.rs` above the `#[cfg(test)]` block with:

```rust
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io, path::{Path, PathBuf}};

pub const MAX_RECENT: usize = 10;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalKind {
    Claude,
    Shell,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TerminalRecord {
    pub id: String,
    pub kind: TerminalKind,
    /// user-given name; None means "derive from kind and position"
    #[serde(default)]
    pub name: Option<String>,
    /// Claude terminals only: id used for `claude --resume`
    #[serde(default)]
    pub claude_session_id: Option<String>,
    pub created_at: String,
}

/// A sidebar row: a profile plus a folder that owns one or more terminals.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub profile_id: String,
    pub cwd: String,
    pub created_at: String,
    #[serde(default)]
    pub terminals: Vec<TerminalRecord>,
}

impl ProjectRecord {
    /// The first Claude terminal, falling back to the first terminal of any kind.
    pub fn primary(&self) -> Option<&TerminalRecord> {
        self.terminals
            .iter()
            .find(|t| t.kind == TerminalKind::Claude)
            .or_else(|| self.terminals.first())
    }

    /// Display name: the custom name, else "claude", "claude 2", "shell", "shell 2"
    /// numbered per kind in creation order.
    pub fn terminal_name(&self, id: &str) -> Option<String> {
        let t = self.terminals.iter().find(|t| t.id == id)?;
        if let Some(n) = &t.name {
            return Some(n.clone());
        }
        let nth = self.terminals.iter().take_while(|x| x.id != id).filter(|x| x.kind == t.kind).count() + 1;
        let base = match t.kind {
            TerminalKind::Claude => "claude",
            TerminalKind::Shell => "shell",
        };
        Some(if nth == 1 { base.to_string() } else { format!("{base} {nth}") })
    }
}

/// A version-1 state file's session: one row was one claude pty.
#[derive(Deserialize, Clone, Debug)]
pub struct SessionRecordV1 {
    pub id: String,
    pub name: String,
    pub profile_id: String,
    pub cwd: String,
    #[serde(default)]
    pub claude_session_id: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize, Default)]
struct StateV1 {
    #[serde(default)]
    sessions: Vec<SessionRecordV1>,
    #[serde(default)]
    recent_folders: HashMap<String, Vec<String>>,
    #[serde(default)]
    settings: AppSettings,
    #[serde(default)]
    restore_all_on_launch: bool,
}

/// One old session becomes a project with a single Claude terminal that keeps the resume id.
pub fn session_to_project(s: SessionRecordV1) -> ProjectRecord {
    let created_at = s.created_at;
    ProjectRecord {
        id: s.id,
        name: s.name,
        profile_id: s.profile_id,
        cwd: s.cwd,
        created_at: created_at.clone(),
        terminals: vec![TerminalRecord {
            id: uuid::Uuid::new_v4().to_string(),
            kind: TerminalKind::Claude,
            name: None,
            claude_session_id: s.claude_session_id,
            created_at,
        }],
    }
}

fn from_v1(v1: StateV1) -> AppState {
    AppState {
        version: STATE_VERSION,
        projects: v1.sessions.into_iter().map(session_to_project).collect(),
        recent_folders: v1.recent_folders,
        settings: v1.settings,
        restore_all_on_launch: v1.restore_all_on_launch,
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AppSettings {
    #[serde(default)]
    pub claude_bin: Option<String>,
    #[serde(default = "yes")]
    pub notifications: bool,
    #[serde(default = "default_font_size")]
    pub font_size: u8,
}
fn yes() -> bool { true }
pub fn default_font_size() -> u8 { 13 }
impl Default for AppSettings {
    fn default() -> Self { Self { claude_bin: None, notifications: true, font_size: default_font_size() } }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AppState {
    /// schema version of this file; bump when a migration is needed
    #[serde(default = "state_version")] pub version: u32,
    #[serde(default)] pub projects: Vec<ProjectRecord>,
    #[serde(default)] pub recent_folders: HashMap<String, Vec<String>>,
    #[serde(default)] pub settings: AppSettings,
    /// set before a self-restart so the next launch restores all projects without asking
    #[serde(default)] pub restore_all_on_launch: bool,
}

pub const STATE_VERSION: u32 = 2;
fn state_version() -> u32 { STATE_VERSION }
impl Default for AppState {
    fn default() -> Self {
        Self { version: STATE_VERSION, projects: Vec::new(), recent_folders: HashMap::new(),
               settings: AppSettings::default(), restore_all_on_launch: false }
    }
}

impl AppState {
    pub fn project_of(&self, terminal_id: &str) -> Option<&ProjectRecord> {
        self.projects.iter().find(|p| p.terminals.iter().any(|t| t.id == terminal_id))
    }

    pub fn project_of_mut(&mut self, terminal_id: &str) -> Option<&mut ProjectRecord> {
        self.projects.iter_mut().find(|p| p.terminals.iter().any(|t| t.id == terminal_id))
    }

    /// Remove a terminal. When it was the project's last one the project goes too.
    /// Returns the project id and whether the project was removed.
    pub fn remove_terminal(&mut self, terminal_id: &str) -> Option<(String, bool)> {
        let pi = self.projects.iter().position(|p| p.terminals.iter().any(|t| t.id == terminal_id))?;
        let p = &mut self.projects[pi];
        p.terminals.retain(|t| t.id != terminal_id);
        let pid = p.id.clone();
        if p.terminals.is_empty() {
            self.projects.remove(pi);
            return Some((pid, true));
        }
        Some((pid, false))
    }
}

fn state_path(base: &Path) -> PathBuf { base.join("state.json") }

fn quarantine(base: &Path) -> AppState {
    let _ = fs::rename(state_path(base), base.join("state.json.corrupt"));
    AppState::default()
}

pub fn load(base: &Path) -> AppState {
    let Ok(text) = fs::read_to_string(state_path(base)) else { return AppState::default() };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return quarantine(base) };
    let version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(1);
    let parsed = if version < 2 {
        serde_json::from_value::<StateV1>(value).map(from_v1)
    } else {
        serde_json::from_value::<AppState>(value)
    };
    parsed.unwrap_or_else(|_| quarantine(base))
}

pub fn save(base: &Path, state: &AppState) -> io::Result<()> {
    fs::create_dir_all(base)?;
    let tmp = base.join("state.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(state)?)?;
    fs::rename(tmp, state_path(base))
}

pub fn push_recent(state: &mut AppState, profile_id: &str, folder: &str) {
    let list = state.recent_folders.entry(profile_id.to_string()).or_default();
    list.retain(|f| f != folder);
    list.insert(0, folder.to_string());
    list.truncate(MAX_RECENT);
}
```

- [ ] **Step 4: Run the state_store tests**

Run: `cd src-tauri && cargo test state_store 2>&1 | tail -20`
Expected: all `state_store::tests` pass. Other modules (`commands.rs`, `lib.rs`) will not compile yet because they still use `state.sessions` and `SessionRecord`; `cargo test state_store` compiles the whole crate, so if it fails on those files, temporarily proceed to Step 5 only after Task 3 makes the crate compile. To keep this task independently green, apply the minimal shim in `commands.rs`/`lib.rs` now: replace `state_store::{self, AppSettings, AppState, SessionRecord}` with `state_store::{self, AppSettings, AppState, ProjectRecord}`, change `restorable: Mutex<Vec<SessionRecord>>` to `Mutex<Vec<ProjectRecord>>`, `previous_sessions` to return `Vec<ProjectRecord>`, `std::mem::take(&mut state.sessions)` to `std::mem::take(&mut state.projects)`, and every remaining `state.sessions` use to `state.projects` with `r.terminals.first().map(|t| ...)` where a `claude_session_id` is touched. Task 3 replaces all of that anyway; the shim only needs to compile.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/state_store.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(state): projects own terminals; migrate v1 sessions on load"
```

---

### Task 2: Spawn shells as well as Claude (Rust)

**Files:**
- Modify: `src-tauri/src/sessions.rs`

**Interfaces:**
- Produces:
  - `pub enum SpawnCommand { Claude { bin: Option<String>, resume_id: Option<String> }, Shell { shell: String } }`
  - `SpawnSpec { session_id, cwd, config_dir, extra_env, socket_path, command: SpawnCommand }` (fields `claude_bin` and `resume_id` removed)
  - `pub fn login_shell() -> String`
- Consumed by: Task 3.

- [ ] **Step 1: Write the failing test and update the existing ones**

In the `tests` module of `src-tauri/src/sessions.rs`, change the two existing `SpawnSpec` literals: replace

```rust
            claude_bin: Some(fake.to_string_lossy().into_owned()),
            resume_id: Some("resume-xyz".into()),
```
with
```rust
            command: SpawnCommand::Claude { bin: Some(fake.to_string_lossy().into_owned()), resume_id: Some("resume-xyz".into()) },
```
and in `kill_terminates_child` replace
```rust
            claude_bin: Some(fake.to_string_lossy().into_owned()),
            resume_id: None,
```
with
```rust
            command: SpawnCommand::Claude { bin: Some(fake.to_string_lossy().into_owned()), resume_id: None },
```

Then add this test to the same module:

```rust
    #[test]
    fn shell_spawn_runs_login_shell_in_project_folder() {
        let d = tempdir().unwrap();
        let work = tempdir().unwrap();
        let fake = write_fake(d.path());
        let out = Arc::new(Mutex::new(Vec::<u8>::new()));
        let out2 = out.clone();
        let spec = SpawnSpec {
            session_id: "sid-3".into(),
            cwd: work.path().to_path_buf(),
            config_dir: d.path().join("cfg"),
            extra_env: Default::default(),
            socket_path: d.path().join("sock"),
            command: SpawnCommand::Shell { shell: fake.to_string_lossy().into_owned() },
        };
        let mut proc = spawn(&spec, move |b| out2.lock().unwrap().extend_from_slice(b), |_| {}).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let s = String::from_utf8_lossy(&out.lock().unwrap()).into_owned();
            if s.contains("FAKE start") { break; }
            assert!(std::time::Instant::now() < deadline, "no banner, got: {s}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let s = String::from_utf8_lossy(&out.lock().unwrap()).into_owned();
        assert!(s.contains("args=-l"), "shell must be a login shell, got: {s}");
        assert!(s.contains(&format!("config={}", d.path().join("cfg").display())));
        assert!(s.contains(&format!("cwd={}", std::fs::canonicalize(work.path()).unwrap().display())));
        assert!(!s.contains("--resume"));
        proc.write(b"quit\r").unwrap();
    }

    #[test]
    fn login_shell_falls_back_to_zsh() {
        // SHELL is normally set; the fallback path only needs to be a sane absolute path
        let sh = login_shell();
        assert!(sh.starts_with('/'), "got {sh}");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test sessions 2>&1 | tail -20`
Expected: compile error, `SpawnCommand` not found.

- [ ] **Step 3: Implement `SpawnCommand` and the shell branch**

In `src-tauri/src/sessions.rs`, replace the `SpawnSpec` struct with:

```rust
pub enum SpawnCommand {
    /// `claude`, optionally resuming a previous transcript
    Claude { bin: Option<String>, resume_id: Option<String> },
    /// the user's login shell, e.g. `/bin/zsh -l`
    Shell { shell: String },
}

pub struct SpawnSpec {
    pub session_id: String,
    pub cwd: PathBuf,
    pub config_dir: PathBuf,
    pub extra_env: HashMap<String, String>,
    pub socket_path: PathBuf,
    pub command: SpawnCommand,
}

/// The user's login shell from `$SHELL`, falling back to zsh (macOS default).
pub fn login_shell() -> String {
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into())
}
```

In `spawn`, replace

```rust
    let bin = spec.claude_bin.clone().unwrap_or_else(|| "claude".into());
    let mut shell_cmd = format!("exec {}", shell_quote(&bin));
    if let Some(rid) = &spec.resume_id {
        shell_cmd.push_str(&format!(" --resume {}", shell_quote(rid)));
    }
```
with
```rust
    let shell_cmd = match &spec.command {
        SpawnCommand::Claude { bin, resume_id } => {
            let bin = bin.clone().unwrap_or_else(|| "claude".into());
            let mut c = format!("exec {}", shell_quote(&bin));
            if let Some(rid) = resume_id {
                c.push_str(&format!(" --resume {}", shell_quote(rid)));
            }
            c
        }
        SpawnCommand::Shell { shell } => format!("exec {} -l", shell_quote(shell)),
    };
```

The `FAKE_CLAUDE` test script prints `cwd=$(pwd)`; on macOS a tempdir under `/var` resolves to `/private/var`, which is why the new test compares against the canonicalized path.

- [ ] **Step 4: Run the sessions tests**

Run: `cd src-tauri && cargo test sessions 2>&1 | tail -20`
Expected: `spawn_streams_env_stdin_and_exit`, `kill_terminates_child`, `shell_spawn_runs_login_shell_in_project_folder`, `login_shell_falls_back_to_zsh` pass. If `commands.rs` fails to compile because it still builds the old `SpawnSpec`, update its `SpawnSpec` literal to `command: SpawnCommand::Claude { bin: claude_bin, resume_id: resume_id.clone() }` (Task 3 rewrites this code anyway).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sessions.rs src-tauri/src/commands.rs
git commit -m "feat(pty): spawn shell terminals alongside claude"
```

---

### Task 3: Project and terminal commands, events, menu (Rust)

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 1 records and `AppState` helpers; Task 2 `SpawnCommand`, `login_shell`.
- Produces (Tauri commands, camelCase args from JS):
  - `list_projects() -> Vec<ProjectView>`
  - `new_project(profileId, cwd, name?, resumeId?) -> { projectId, terminalId }`
  - `add_terminal(projectId, kind: "claude" | "shell", resumeId?) -> terminalId`
  - `close_terminal(id)`, `close_project(id)`, `rename_project(id, name)`, `rename_terminal(id, name)`, `reorder_projects(ids)`
  - `write_stdin(id, dataB64)`, `resize_terminal(id, cols, rows)` where `id` is a terminal id
  - `previous_projects() -> Vec<ProjectRecord>`, `discard_previous()`
  - Events: `projects-changed: ProjectView[]`, `terminal-data: { id, dataB64 }`, `terminal-status: { id, status }`, `menu: string` with ids `new-project`, `new-shell`, `new-claude`, `close-terminal`, `close-project`, `settings`
  - `ProjectView { id, name, profileId, profileName, profileColor, cwd, branch, terminals: TerminalView[] }`, `TerminalView { id, kind, name, status }`

There are no unit tests for Tauri command handlers in this codebase (they need managed `State`); the logic they call is tested in Tasks 1 and 2. The check for this task is `cargo test` passing and `cargo build` clean.

- [ ] **Step 1: Rewrite the session part of `commands.rs`**

Replace everything in `src-tauri/src/commands.rs` from the top of the file through the end of `pub fn discard_previous` with the following. Keep `get_settings`, `set_settings`, `check_claude`, `claude_bin_path`, `reveal_in_finder`, `open_url`, `copy_text`, `set_badge`, `auto_restore`, `check_claude_update`, `check_sonic_update`, `update_sonic`, `update_claude`, `restart_with_sessions` exactly as they are.

```rust
use crate::{
    profiles::{Profile, ProfileRegistry},
    sessions::{self, SessionProc, SpawnCommand, SpawnSpec},
    state_store::{self, AppSettings, AppState, ProjectRecord, TerminalKind, TerminalRecord},
    status::StatusEvent,
    updater,
};
use base64::Engine;
use serde::Serialize;
use std::{collections::HashMap, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppCtx {
    pub base: PathBuf,
    pub socket: PathBuf,
    pub state: Mutex<AppState>,
    pub registry: Mutex<ProfileRegistry>,
    /// live ptys by terminal id
    pub procs: Mutex<HashMap<String, SessionProc>>,
    /// last known status by terminal id
    pub statuses: Mutex<HashMap<String, String>>,
    pub restorable: Mutex<Vec<ProjectRecord>>,
    pub auto_restore: Mutex<bool>,
    /// resolved claude binary each running Claude terminal was started from
    pub session_bins: Mutex<HashMap<String, PathBuf>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalView {
    pub id: String,
    pub kind: TerminalKind,
    pub name: String,
    pub status: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    pub id: String,
    pub name: String,
    pub profile_id: String,
    pub profile_name: String,
    pub profile_color: String,
    pub cwd: String,
    pub branch: Option<String>,
    pub terminals: Vec<TerminalView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewProject {
    pub project_id: String,
    pub terminal_id: String,
}

fn views(ctx: &AppCtx) -> Vec<ProjectView> {
    let state = ctx.state.lock().unwrap();
    let reg = ctx.registry.lock().unwrap();
    let statuses = ctx.statuses.lock().unwrap();
    state
        .projects
        .iter()
        .map(|p| {
            let prof = reg.get(&p.profile_id);
            ProjectView {
                id: p.id.clone(),
                name: p.name.clone(),
                profile_id: p.profile_id.clone(),
                profile_name: prof.as_ref().map(|x| x.name.clone()).unwrap_or_default(),
                profile_color: prof.as_ref().map(|x| x.color.clone()).unwrap_or("#565f89".into()),
                cwd: p.cwd.clone(),
                branch: crate::git::branch(std::path::Path::new(&p.cwd)),
                terminals: p
                    .terminals
                    .iter()
                    .map(|t| TerminalView {
                        id: t.id.clone(),
                        kind: t.kind,
                        name: p.terminal_name(&t.id).unwrap_or_default(),
                        status: statuses.get(&t.id).cloned().unwrap_or("idle".into()),
                    })
                    .collect(),
            }
        })
        .collect()
}

pub fn emit_projects(app: &AppHandle) {
    let ctx = app.state::<AppCtx>();
    let _ = app.emit("projects-changed", views(&ctx));
}

pub fn handle_status_event(app: &AppHandle, ev: StatusEvent) {
    let ctx = app.state::<AppCtx>();
    {
        let mut statuses = ctx.statuses.lock().unwrap();
        if !statuses.contains_key(&ev.sonic_session) {
            return; // unknown or stale terminal
        }
        statuses.insert(ev.sonic_session.clone(), ev.state.clone());
    }
    if let Some(cc_id) = ev.claude_session_id {
        let mut state = ctx.state.lock().unwrap();
        let changed = state
            .project_of_mut(&ev.sonic_session)
            .and_then(|p| p.terminals.iter_mut().find(|t| t.id == ev.sonic_session))
            .filter(|t| t.claude_session_id.as_deref() != Some(cc_id.as_str()))
            .map(|t| t.claude_session_id = Some(cc_id))
            .is_some();
        if changed {
            let _ = state_store::save(&ctx.base, &state);
        }
    }
    let _ = app.emit(
        "terminal-status",
        serde_json::json!({ "id": ev.sonic_session, "status": ev.state }),
    );
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn list_profiles(ctx: State<AppCtx>) -> Vec<Profile> {
    ctx.registry.lock().unwrap().profiles().to_vec()
}

#[tauri::command]
pub fn create_profile(ctx: State<AppCtx>, name: String) -> Result<Profile, String> {
    ctx.registry.lock().unwrap().create(&name).map_err(err)
}

#[tauri::command]
pub fn import_profile(ctx: State<AppCtx>, name: String, dir: String) -> Result<Profile, String> {
    ctx.registry.lock().unwrap().import(&name, std::path::Path::new(&dir)).map_err(err)
}

#[tauri::command]
pub fn update_profile(ctx: State<AppCtx>, profile: Profile) -> Result<(), String> {
    ctx.registry.lock().unwrap().update(profile).map_err(err)
}

#[tauri::command]
pub fn delete_profile(ctx: State<AppCtx>, id: String) -> Result<(), String> {
    let state = ctx.state.lock().unwrap();
    if state.projects.iter().any(|p| p.profile_id == id) {
        return Err("Close this profile's projects first".into());
    }
    drop(state);
    ctx.registry.lock().unwrap().delete(&id).map_err(err)
}

#[tauri::command]
pub fn list_projects(ctx: State<AppCtx>) -> Vec<ProjectView> {
    views(&ctx)
}

/// Spawn one pty for `profile` in `cwd`, register it in procs/statuses, and
/// return the record to attach to a project. Shared by new_project and add_terminal.
fn spawn_terminal(
    app: &AppHandle,
    ctx: &AppCtx,
    profile: &Profile,
    cwd: &str,
    kind: TerminalKind,
    resume_id: Option<String>,
) -> Result<TerminalRecord, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let command = match kind {
        TerminalKind::Claude => {
            let bin = ctx.state.lock().unwrap().settings.claude_bin.clone();
            if let Some(real) = claude_bin_path(ctx).and_then(|b| updater::resolve_bin(&b)) {
                ctx.session_bins.lock().unwrap().insert(id.clone(), real);
            }
            SpawnCommand::Claude { bin, resume_id: resume_id.clone() }
        }
        TerminalKind::Shell => SpawnCommand::Shell { shell: sessions::login_shell() },
    };
    let spec = SpawnSpec {
        session_id: id.clone(),
        cwd: PathBuf::from(cwd),
        config_dir: profile.config_dir.clone(),
        extra_env: profile.env.clone(),
        socket_path: ctx.socket.clone(),
        command,
    };
    let (app_out, app_exit, id_out, id_exit) = (app.clone(), app.clone(), id.clone(), id.clone());
    let proc = sessions::spawn(
        &spec,
        move |bytes| {
            let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
            let _ = app_out.emit("terminal-data", serde_json::json!({ "id": id_out, "dataB64": b64 }));
        },
        move |_code| {
            let ctx = app_exit.state::<AppCtx>();
            ctx.statuses.lock().unwrap().insert(id_exit.clone(), "exited".into());
            let _ = app_exit.emit(
                "terminal-status",
                serde_json::json!({ "id": id_exit, "status": "exited" }),
            );
        },
    )
    .map_err(err)?;
    ctx.procs.lock().unwrap().insert(id.clone(), proc);
    let initial = match kind {
        TerminalKind::Shell => "idle",
        TerminalKind::Claude if profile.hooks_ok => "idle",
        TerminalKind::Claude => "unknown",
    };
    ctx.statuses.lock().unwrap().insert(id.clone(), initial.into());
    Ok(TerminalRecord {
        id,
        kind,
        name: None,
        claude_session_id: match kind {
            TerminalKind::Claude => resume_id,
            TerminalKind::Shell => None,
        },
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Create a project and its default Claude terminal in one step.
#[tauri::command]
pub fn new_project(
    app: AppHandle,
    ctx: State<AppCtx>,
    profile_id: String,
    cwd: String,
    name: Option<String>,
    resume_id: Option<String>,
) -> Result<NewProject, String> {
    let profile = ctx.registry.lock().unwrap().get(&profile_id).ok_or("unknown profile")?;
    let term = spawn_terminal(&app, &ctx, &profile, &cwd, TerminalKind::Claude, resume_id)?;
    let default_name = PathBuf::from(&cwd)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| cwd.clone());
    let project = ProjectRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.unwrap_or(default_name),
        profile_id: profile_id.clone(),
        cwd: cwd.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        terminals: vec![term.clone()],
    };
    let project_id = project.id.clone();
    {
        let mut state = ctx.state.lock().unwrap();
        state.projects.push(project);
        state_store::push_recent(&mut state, &profile_id, &cwd);
        let _ = state_store::save(&ctx.base, &state);
    }
    emit_projects(&app);
    Ok(NewProject { project_id, terminal_id: term.id })
}

/// Add a shell or Claude terminal to an existing project.
#[tauri::command]
pub fn add_terminal(
    app: AppHandle,
    ctx: State<AppCtx>,
    project_id: String,
    kind: TerminalKind,
    resume_id: Option<String>,
) -> Result<String, String> {
    let (profile_id, cwd) = ctx
        .state
        .lock()
        .unwrap()
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| (p.profile_id.clone(), p.cwd.clone()))
        .ok_or("unknown project")?;
    let profile = ctx.registry.lock().unwrap().get(&profile_id).ok_or("unknown profile")?;
    let term = spawn_terminal(&app, &ctx, &profile, &cwd, kind, resume_id)?;
    let terminal_id = term.id.clone();
    {
        let mut state = ctx.state.lock().unwrap();
        if let Some(p) = state.projects.iter_mut().find(|p| p.id == project_id) {
            p.terminals.push(term);
        }
        let _ = state_store::save(&ctx.base, &state);
    }
    emit_projects(&app);
    Ok(terminal_id)
}

#[tauri::command]
pub fn write_stdin(app: AppHandle, ctx: State<AppCtx>, id: String, data_b64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64).map_err(err)?;
    let mut procs = ctx.procs.lock().unwrap();
    let proc = procs.get_mut(&id).ok_or("no such terminal")?;
    proc.write(&bytes).map_err(err)?;
    drop(procs);
    // fast-path: submitting while waiting flips to working; hooks confirm shortly after
    if bytes.contains(&b'\r') {
        let mut statuses = ctx.statuses.lock().unwrap();
        if statuses.get(&id).map(String::as_str) == Some("waiting") {
            statuses.insert(id.clone(), "working".into());
            drop(statuses);
            let _ = app.emit("terminal-status", serde_json::json!({ "id": id, "status": "working" }));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn resize_terminal(ctx: State<AppCtx>, id: String, cols: u16, rows: u16) {
    if let Some(p) = ctx.procs.lock().unwrap().get(&id) {
        p.resize(cols, rows);
    }
}

#[tauri::command]
pub fn rename_project(app: AppHandle, ctx: State<AppCtx>, id: String, name: String) {
    let mut state = ctx.state.lock().unwrap();
    if let Some(p) = state.projects.iter_mut().find(|p| p.id == id) {
        p.name = name;
    }
    let _ = state_store::save(&ctx.base, &state);
    drop(state);
    emit_projects(&app);
}

#[tauri::command]
pub fn rename_terminal(app: AppHandle, ctx: State<AppCtx>, id: String, name: String) {
    let mut state = ctx.state.lock().unwrap();
    if let Some(t) = state.project_of_mut(&id).and_then(|p| p.terminals.iter_mut().find(|t| t.id == id)) {
        t.name = Some(name);
    }
    let _ = state_store::save(&ctx.base, &state);
    drop(state);
    emit_projects(&app);
}

/// Reorder projects to match `ids`; unknown ids are ignored and projects not
/// mentioned keep their relative order at the end.
#[tauri::command]
pub fn reorder_projects(app: AppHandle, ctx: State<AppCtx>, ids: Vec<String>) {
    let mut state = ctx.state.lock().unwrap();
    let mut rest = std::mem::take(&mut state.projects);
    let mut ordered = Vec::with_capacity(rest.len());
    for id in &ids {
        if let Some(i) = rest.iter().position(|p| &p.id == id) {
            ordered.push(rest.remove(i));
        }
    }
    ordered.extend(rest);
    state.projects = ordered;
    let _ = state_store::save(&ctx.base, &state);
    drop(state);
    emit_projects(&app);
}

fn kill_terminal(ctx: &AppCtx, id: &str) {
    if let Some(mut p) = ctx.procs.lock().unwrap().remove(id) {
        p.kill();
    }
    ctx.statuses.lock().unwrap().remove(id);
    ctx.session_bins.lock().unwrap().remove(id);
}

/// Close one terminal. If it was the project's last, the project goes too.
#[tauri::command]
pub fn close_terminal(app: AppHandle, ctx: State<AppCtx>, id: String) {
    kill_terminal(&ctx, &id);
    let mut state = ctx.state.lock().unwrap();
    state.remove_terminal(&id);
    let _ = state_store::save(&ctx.base, &state);
    drop(state);
    emit_projects(&app);
}

#[tauri::command]
pub fn close_project(app: AppHandle, ctx: State<AppCtx>, id: String) {
    let terminal_ids: Vec<String> = ctx
        .state
        .lock()
        .unwrap()
        .projects
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.terminals.iter().map(|t| t.id.clone()).collect())
        .unwrap_or_default();
    for tid in &terminal_ids {
        kill_terminal(&ctx, tid);
    }
    let mut state = ctx.state.lock().unwrap();
    state.projects.retain(|p| p.id != id);
    let _ = state_store::save(&ctx.base, &state);
    drop(state);
    emit_projects(&app);
}

#[tauri::command]
pub fn recent_folders(ctx: State<AppCtx>, profile_id: String) -> Vec<String> {
    ctx.state.lock().unwrap().recent_folders.get(&profile_id).cloned().unwrap_or_default()
}

#[tauri::command]
pub fn previous_projects(ctx: State<AppCtx>) -> Vec<ProjectRecord> {
    ctx.restorable.lock().unwrap().clone()
}

#[tauri::command]
pub fn discard_previous(ctx: State<AppCtx>) {
    ctx.restorable.lock().unwrap().clear();
}
```

- [ ] **Step 2: Update `lib.rs`**

In `src-tauri/src/lib.rs`:

Replace `let restorable = std::mem::take(&mut state.sessions);` with `let restorable = std::mem::take(&mut state.projects);`.

Replace the menu-item block from `let new_s = ...` through `let session_menu = ... .build()?;` with:

```rust
            let new_p = MenuItemBuilder::with_id("new-project", "New Project")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let new_shell = MenuItemBuilder::with_id("new-shell", "New Shell in Project")
                .accelerator("CmdOrCtrl+T")
                .build(app)?;
            let new_claude = MenuItemBuilder::with_id("new-claude", "New Claude Terminal in Project")
                .accelerator("CmdOrCtrl+Shift+T")
                .build(app)?;
            let close_t = MenuItemBuilder::with_id("close-terminal", "Close Terminal")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;
            let close_p = MenuItemBuilder::with_id("close-project", "Close Project")
                .accelerator("CmdOrCtrl+Shift+W")
                .build(app)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Sonic")
                .item(&settings)
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let session_menu = SubmenuBuilder::new(app, "Project")
                .item(&new_p)
                .item(&new_shell)
                .item(&new_claude)
                .separator()
                .item(&close_t)
                .item(&close_p)
                .build()?;
```

Replace the handler list entries `commands::list_sessions, commands::start_session, commands::write_stdin, commands::resize_session, commands::rename_session, commands::reorder_sessions, commands::close_session, commands::recent_folders, commands::previous_sessions,` with:

```rust
            commands::list_projects,
            commands::new_project,
            commands::add_terminal,
            commands::write_stdin,
            commands::resize_terminal,
            commands::rename_project,
            commands::rename_terminal,
            commands::reorder_projects,
            commands::close_terminal,
            commands::close_project,
            commands::recent_folders,
            commands::previous_projects,
```

- [ ] **Step 3: Build and run all Rust tests**

Run: `cd src-tauri && cargo build 2>&1 | grep -E "^(warning|error)" ; cargo test 2>&1 | tail -5`
Expected: no errors, no new warnings about unused imports (remove any the compiler reports), all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(backend): project and terminal commands, menu, events"
```

---

### Task 4: Frontend store and pure project helpers (TypeScript)

**Files:**
- Create: `src/projects.ts`, `src/projects.test.ts`
- Modify: `src/store.ts`
- Rewrite: `src/store.test.ts`

**Interfaces:**
- Produces (`store.ts`): `TerminalKind`, `TerminalView`, `ProjectView`, `getState(): { projects, selectedId, lastSelected }`, `setProjects(projects, now?)`, `setStatus(terminalId, status, now?)`, `select(terminalId)`, `selectProject(projectId)`, `findTerminal(id) → { project, terminal } | undefined`, `selectedProject() → ProjectView | undefined`, `allTerminals(projects) → TerminalView[]`, `waitingCount()`, `formatElapsed`, `subscribe`, `_reset`.
- Produces (`projects.ts`): `primaryTerminal(p)`, `rollupStatus(p)`, `cycleTerminal(p, currentId, dir)`, `terminalLabel(p, t)`.
- Consumed by: Tasks 5, 6.

- [ ] **Step 1: Write the failing tests**

Create `src/projects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { primaryTerminal, rollupStatus, cycleTerminal, terminalLabel } from "./projects";
import type { ProjectView, TerminalView, Status, TerminalKind } from "./store";

const t = (id: string, kind: TerminalKind, status: Status = "idle"): TerminalView => ({ id, kind, name: id, status });
const p = (terminals: TerminalView[]): ProjectView => ({
  id: "p", name: "proj", profileId: "x", profileName: "X", profileColor: "#fff", cwd: "/w", branch: null, terminals,
});

describe("primaryTerminal", () => {
  it("is the first claude terminal, else the first terminal", () => {
    expect(primaryTerminal(p([t("s", "shell"), t("c", "claude")])).id).toBe("c");
    expect(primaryTerminal(p([t("s", "shell")])).id).toBe("s");
  });
});

describe("rollupStatus", () => {
  it("ranks waiting over working over idle over exited", () => {
    expect(rollupStatus(p([t("a", "claude", "idle"), t("b", "claude", "working")]))).toBe("working");
    expect(rollupStatus(p([t("a", "claude", "working"), t("b", "claude", "waiting")]))).toBe("waiting");
    expect(rollupStatus(p([t("a", "claude", "exited"), t("b", "claude", "idle")]))).toBe("idle");
    expect(rollupStatus(p([t("a", "claude", "exited")]))).toBe("exited");
  });
  it("ignores live shells but shows a dead one", () => {
    expect(rollupStatus(p([t("a", "claude", "idle"), t("s", "shell", "working")]))).toBe("idle");
    expect(rollupStatus(p([t("a", "claude", "idle"), t("s", "shell", "exited")]))).toBe("idle");
    expect(rollupStatus(p([t("a", "claude", "exited"), t("s", "shell", "exited")]))).toBe("exited");
    expect(rollupStatus(p([t("s", "shell", "exited")]))).toBe("exited");
    expect(rollupStatus(p([t("s", "shell", "idle")]))).toBe("idle");
  });
  it("keeps unknown visible when nothing else is known", () => {
    expect(rollupStatus(p([t("a", "claude", "unknown")]))).toBe("unknown");
    expect(rollupStatus(p([t("a", "claude", "unknown"), t("b", "claude", "idle")]))).toBe("idle");
  });
});

describe("cycleTerminal", () => {
  const proj = p([t("a", "claude"), t("b", "shell"), t("c", "claude")]);
  it("wraps forwards and backwards", () => {
    expect(cycleTerminal(proj, "a", 1).id).toBe("b");
    expect(cycleTerminal(proj, "c", 1).id).toBe("a");
    expect(cycleTerminal(proj, "a", -1).id).toBe("c");
  });
  it("starts from the first terminal when the current one is unknown", () => {
    expect(cycleTerminal(proj, "zz", 1).id).toBe("b");
  });
});

describe("terminalLabel", () => {
  it("adds the terminal name only when the project has several", () => {
    const one = p([t("a", "claude")]);
    expect(terminalLabel(one, one.terminals[0])).toBe("proj");
    const two = p([t("a", "claude"), t("b", "shell")]);
    expect(terminalLabel(two, two.terminals[1])).toBe("proj · b");
  });
});
```

Replace `src/store.test.ts` with:

```ts
import { describe, expect, test, beforeEach } from "vitest";
import {
  getState, setProjects, setStatus, select, selectProject, findTerminal, selectedProject,
  allTerminals, waitingCount, formatElapsed, _reset, ProjectView, TerminalView, Status, TerminalKind,
} from "./store";

const t = (id: string, kind: TerminalKind = "claude", status: Status = "idle"): TerminalView => ({ id, kind, name: id, status });
const pv = (id: string, terminals: TerminalView[]): ProjectView => ({
  id, name: id, profileId: "p", profileName: "P", profileColor: "#fff", cwd: "/x", branch: null, terminals,
});

beforeEach(() => _reset());

describe("store", () => {
  test("first project's primary terminal auto-selected", () => {
    setProjects([pv("a", [t("a-s", "shell"), t("a-c")]), pv("b", [t("b-c")])]);
    expect(getState().selectedId).toBe("a-c");
  });

  test("selection survives list update", () => {
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")])]);
    select("b-c");
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")]), pv("c", [t("c-c")])]);
    expect(getState().selectedId).toBe("b-c");
  });

  test("closing the selected terminal falls back within the same project", () => {
    setProjects([pv("a", [t("a-c"), t("a-s", "shell")]), pv("b", [t("b-c")])]);
    select("a-s");
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")])]);
    expect(getState().selectedId).toBe("a-c");
  });

  test("closing the selected project falls back to the first project", () => {
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")])]);
    select("b-c");
    setProjects([pv("a", [t("a-c")])]);
    expect(getState().selectedId).toBe("a-c");
  });

  test("selectProject remembers the last terminal picked in it", () => {
    setProjects([pv("a", [t("a-c"), t("a-s", "shell")]), pv("b", [t("b-c")])]);
    select("a-s");
    selectProject("b");
    expect(getState().selectedId).toBe("b-c");
    selectProject("a");
    expect(getState().selectedId).toBe("a-s");
  });

  test("selectProject falls back to primary when the remembered terminal is gone", () => {
    setProjects([pv("a", [t("a-c"), t("a-s", "shell")]), pv("b", [t("b-c")])]);
    select("a-s");
    selectProject("b");
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")])]);
    selectProject("a");
    expect(getState().selectedId).toBe("a-c");
  });

  test("setStatus updates one terminal", () => {
    setProjects([pv("a", [t("a-c"), t("a-s", "shell")])]);
    setStatus("a-s", "exited");
    expect(findTerminal("a-s")!.terminal.status).toBe("exited");
    expect(findTerminal("a-c")!.terminal.status).toBe("idle");
  });

  test("findTerminal and selectedProject", () => {
    setProjects([pv("a", [t("a-c")]), pv("b", [t("b-c")])]);
    expect(findTerminal("b-c")!.project.id).toBe("b");
    expect(findTerminal("zz")).toBeUndefined();
    select("b-c");
    expect(selectedProject()!.id).toBe("b");
  });

  test("waitingCount counts waiting terminals across projects", () => {
    setProjects([pv("a", [t("a-c", "claude", "waiting"), t("a-s", "shell")]), pv("b", [t("b-c", "claude", "waiting")])]);
    expect(waitingCount()).toBe(2);
    expect(allTerminals(getState().projects).length).toBe(3);
  });

  test("empty list clears selection", () => {
    setProjects([pv("a", [t("a-c")])]);
    setProjects([]);
    expect(getState().selectedId).toBeNull();
  });

  test("workingSince starts on transition to working and survives refreshes", () => {
    setProjects([pv("a", [t("a-c")])], 1000);
    setStatus("a-c", "working", 5000);
    expect(findTerminal("a-c")!.terminal.workingSince).toBe(5000);
    setProjects([pv("a", [t("a-c", "claude", "working")])], 9000);
    expect(findTerminal("a-c")!.terminal.workingSince).toBe(5000);
    setStatus("a-c", "idle", 12000);
    expect(findTerminal("a-c")!.terminal.workingSince).toBeUndefined();
  });
});

describe("formatElapsed", () => {
  test("formats minutes and hours", () => {
    expect(formatElapsed(undefined, 0)).toBeNull();
    expect(formatElapsed(0, 30_000)).toBe("<1m");
    expect(formatElapsed(0, 3 * 60_000)).toBe("3m");
    expect(formatElapsed(0, 65 * 60_000)).toBe("1h 05m");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/projects.test.ts src/store.test.ts 2>&1 | tail -15`
Expected: FAIL, `./projects` cannot be resolved and `setProjects` is not exported.

- [ ] **Step 3: Implement `store.ts` and `projects.ts`**

Replace `src/store.ts` with:

```ts
import { primaryTerminal } from "./projects";

export type Status = "idle" | "working" | "waiting" | "exited" | "unknown";
export type TerminalKind = "claude" | "shell";

export interface TerminalView {
  id: string;
  kind: TerminalKind;
  name: string;
  status: Status;
  /** epoch ms when the current "working" stretch began */
  workingSince?: number;
}

export interface ProjectView {
  id: string;
  name: string;
  profileId: string;
  profileName: string;
  profileColor: string;
  cwd: string;
  branch: string | null;
  terminals: TerminalView[];
}

interface State {
  projects: ProjectView[];
  /** selected terminal id */
  selectedId: string | null;
  /** project id → terminal id last selected in that project */
  lastSelected: Record<string, string>;
}

const empty = (): State => ({ projects: [], selectedId: null, lastSelected: {} });
let state: State = empty();
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function subscribe(fn: () => void): void {
  listeners.add(fn);
}

function notify(): void {
  listeners.forEach(fn => fn());
}

export function allTerminals(projects: ProjectView[]): TerminalView[] {
  return projects.flatMap(p => p.terminals);
}

export function findTerminal(id: string | null): { project: ProjectView; terminal: TerminalView } | undefined {
  if (!id) return undefined;
  for (const project of state.projects) {
    const terminal = project.terminals.find(t => t.id === id);
    if (terminal) return { project, terminal };
  }
  return undefined;
}

export function selectedProject(): ProjectView | undefined {
  return findTerminal(state.selectedId)?.project;
}

function withWorkingSince(next: TerminalView, prev: TerminalView | undefined, now: number): TerminalView {
  if (next.status !== "working") return { ...next, workingSince: undefined };
  return { ...next, workingSince: prev?.workingSince ?? now };
}

/** The terminal to show for a project: the one last picked in it, else its primary. */
function terminalFor(p: ProjectView, lastSelected: Record<string, string>): TerminalView {
  return p.terminals.find(t => t.id === lastSelected[p.id]) ?? primaryTerminal(p);
}

export function setProjects(projects: ProjectView[], now = Date.now()): void {
  const prev = new Map(allTerminals(state.projects).map(t => [t.id, t]));
  const next = projects.map(p => ({
    ...p,
    terminals: p.terminals.map(t => withWorkingSince(t, prev.get(t.id), now)),
  }));
  let selectedId = state.selectedId;
  if (!allTerminals(next).some(t => t.id === selectedId)) {
    const prevProjectId = selectedProject()?.id;
    const p = next.find(x => x.id === prevProjectId) ?? next[0];
    selectedId = p && p.terminals.length > 0 ? terminalFor(p, state.lastSelected).id : null;
  }
  state = { ...state, projects: next, selectedId };
  notify();
}

export function setStatus(id: string, status: Status, now = Date.now()): void {
  state = {
    ...state,
    projects: state.projects.map(p => ({
      ...p,
      terminals: p.terminals.map(t => (t.id === id ? withWorkingSince({ ...t, status }, t, now) : t)),
    })),
  };
  notify();
}

/** "3m", "1h 05m" — how long a terminal has been working; null when it isn't. */
export function formatElapsed(since: number | undefined, now: number): string | null {
  if (since === undefined) return null;
  const mins = Math.max(0, Math.floor((now - since) / 60000));
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** Select a terminal and remember it as the project's current one. */
export function select(id: string): void {
  const hit = findTerminal(id);
  const lastSelected = hit ? { ...state.lastSelected, [hit.project.id]: id } : state.lastSelected;
  state = { ...state, selectedId: id, lastSelected };
  notify();
}

/** Select a project: its remembered terminal, else its primary. */
export function selectProject(projectId: string): void {
  const p = state.projects.find(x => x.id === projectId);
  if (!p || p.terminals.length === 0) return;
  select(terminalFor(p, state.lastSelected).id);
}

export function waitingCount(): number {
  return allTerminals(state.projects).filter(t => t.status === "waiting").length;
}

export function _reset(): void {
  state = empty();
  listeners.clear();
}
```

Create `src/projects.ts`:

```ts
import type { ProjectView, TerminalView, Status } from "./store";

/** The first Claude terminal, else the first terminal. Callers guarantee at least one. */
export function primaryTerminal(p: ProjectView): TerminalView {
  return p.terminals.find(t => t.kind === "claude") ?? p.terminals[0];
}

// waiting beats working beats idle beats unknown beats exited
const RANK: Status[] = ["waiting", "working", "idle", "unknown", "exited"];

/** Project-row status. Live shells stay silent; a dead shell counts as exited. */
export function rollupStatus(p: ProjectView): Status {
  const votes = p.terminals
    .filter(t => t.kind === "claude" || t.status === "exited")
    .map(t => t.status);
  if (votes.length === 0) return "idle";
  return RANK.find(s => votes.includes(s)) ?? "idle";
}

/** Next (+1) or previous (-1) terminal in creation order, wrapping around. */
export function cycleTerminal(p: ProjectView, currentId: string | null, dir: 1 | -1): TerminalView {
  const n = p.terminals.length;
  const i = p.terminals.findIndex(t => t.id === currentId);
  return p.terminals[((i < 0 ? 0 : i) + dir + n) % n];
}

/** "proj" for a single-terminal project, "proj · shell 2" otherwise. */
export function terminalLabel(p: ProjectView, t: TerminalView): string {
  return p.terminals.length > 1 ? `${p.name} · ${t.name}` : p.name;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/projects.test.ts src/store.test.ts 2>&1 | tail -8`
Expected: all pass. (Other test files still pass; `npx tsc --noEmit` is still red until Task 5.)

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts src/projects.ts src/projects.test.ts
git commit -m "feat(store): projects with terminals, remembered selection, rollup helpers"
```

---

### Task 5: Wire the frontend to the new backend API

**Files:**
- Modify: `src/ipc.ts`, `src/actions.ts`, `src/main.ts`, `src/terminals.ts`, `src/newSession.ts`, `src/settings.ts`, `src/restore.ts`, `src/notify.ts`, `src/emptyState.ts`, `src/updateBanner.ts`

**Interfaces:**
- Consumes: Task 3 commands/events, Task 4 store and helpers.
- Produces (`actions.ts`): `closeTerminalWithConfirm(p, t)`, `closeProjectWithConfirm(p)`, `addTerminalAndSelect(projectId, kind)`, `restartTerminal(p, t)`, `shortenHome(path)`.
- `sidebar.ts` still imports the old names after this task and is rewritten in Task 6; to keep `tsc` green at the end of this task, apply the minimal sidebar edits listed in Step 8.

- [ ] **Step 1: `ipc.ts`**

Replace the session-related parts of `src/ipc.ts`. The file becomes:

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProjectView, TerminalView, TerminalKind, Status } from "./store";

export type { ProjectView, TerminalView, TerminalKind };

export interface Profile {
  id: string;
  name: string;
  configDir: string;
  managed: boolean;
  env: Record<string, string>;
  color: string;
  hooksOk: boolean;
}

export interface TerminalRecord {
  id: string;
  kind: TerminalKind;
  name: string | null;
  claude_session_id: string | null;
  created_at: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  profile_id: string;
  cwd: string;
  created_at: string;
  terminals: TerminalRecord[];
}

export interface AppSettings {
  claude_bin: string | null;
  notifications: boolean;
  font_size: number;
}

export interface NewProject {
  projectId: string;
  terminalId: string;
}

export const listProfiles = () => invoke<Profile[]>("list_profiles");
export const createProfile = (name: string) => invoke<Profile>("create_profile", { name });
export const importProfile = (name: string, dir: string) => invoke<Profile>("import_profile", { name, dir });
export const updateProfile = (profile: Profile) => invoke<void>("update_profile", { profile });
export const deleteProfile = (id: string) => invoke<void>("delete_profile", { id });
export const listProjects = () => invoke<ProjectView[]>("list_projects");
export const newProject = (profileId: string, cwd: string, name?: string | null, resumeId?: string | null) =>
  invoke<NewProject>("new_project", { profileId, cwd, name: name ?? null, resumeId: resumeId ?? null });
export const addTerminal = (projectId: string, kind: TerminalKind, resumeId?: string | null) =>
  invoke<string>("add_terminal", { projectId, kind, resumeId: resumeId ?? null });
export const writeStdin = (id: string, dataB64: string) => invoke<void>("write_stdin", { id, dataB64 });
export const resizeTerminal = (id: string, cols: number, rows: number) =>
  invoke<void>("resize_terminal", { id, cols, rows });
export const reorderProjects = (ids: string[]) => invoke<void>("reorder_projects", { ids });
export const renameProject = (id: string, name: string) => invoke<void>("rename_project", { id, name });
export const renameTerminal = (id: string, name: string) => invoke<void>("rename_terminal", { id, name });
export const closeTerminal = (id: string) => invoke<void>("close_terminal", { id });
export const closeProject = (id: string) => invoke<void>("close_project", { id });
export const recentFolders = (profileId: string) => invoke<string[]>("recent_folders", { profileId });
export const previousProjects = () => invoke<ProjectRecord[]>("previous_projects");
export const discardPrevious = () => invoke<void>("discard_previous");
export const getSettings = () => invoke<AppSettings>("get_settings");
export const openUrl = (url: string) => invoke<void>("open_url", { url });
export const setSettings = (settings: AppSettings) => invoke<void>("set_settings", { settings });
export const checkClaude = () => invoke<string | null>("check_claude");

export interface UpdateInfo {
  installed: string | null;
  latest: string | null;
  needsUpgrade: boolean;
  needsRestart: boolean;
}
export const autoRestore = () => invoke<boolean>("auto_restore");
export const checkClaudeUpdate = () => invoke<UpdateInfo>("check_claude_update");
export const updateClaude = () => invoke<void>("update_claude");
export const checkSonicUpdate = () => invoke<string | null>("check_sonic_update");
export const updateSonic = () => invoke<void>("update_sonic");
export const restartWithSessions = () => invoke<void>("restart_with_sessions");
export const setBadge = (count: number) => invoke<void>("set_badge", { count });
export const revealInFinder = (path: string) => invoke<void>("reveal_in_finder", { path });
export const copyText = (text: string) => invoke<void>("copy_text", { text });

export const onProjectsChanged = (fn: (p: ProjectView[]) => void) =>
  listen<ProjectView[]>("projects-changed", e => fn(e.payload));
export const onTerminalData = (fn: (id: string, dataB64: string) => void) =>
  listen<{ id: string; dataB64: string }>("terminal-data", e => fn(e.payload.id, e.payload.dataB64));
export const onTerminalStatus = (fn: (id: string, status: Status) => void) =>
  listen<{ id: string; status: Status }>("terminal-status", e => fn(e.payload.id, e.payload.status));
export const onMenu = (fn: (id: string) => void) => listen<string>("menu", e => fn(e.payload));
```

- [ ] **Step 2: `actions.ts`**

Replace `src/actions.ts` with:

```ts
import { ask } from "@tauri-apps/plugin-dialog";
import * as ipc from "./ipc";
import { select } from "./store";
import type { ProjectView, TerminalView, TerminalKind } from "./store";
import { terminalLabel } from "./projects";

export async function closeTerminalWithConfirm(p: ProjectView, t: TerminalView): Promise<void> {
  if (t.status === "working") {
    const yes = await ask(`"${terminalLabel(p, t)}" is still working. Close it anyway?`, { title: "Close terminal" });
    if (!yes) return;
  }
  await ipc.closeTerminal(t.id);
}

export async function closeProjectWithConfirm(p: ProjectView): Promise<void> {
  const working = p.terminals.filter(t => t.status === "working").length;
  if (working > 0) {
    const what = working === 1 ? "a terminal that is" : `${working} terminals that are`;
    const yes = await ask(`"${p.name}" has ${what} still working. Close the project anyway?`, { title: "Close project" });
    if (!yes) return;
  }
  await ipc.closeProject(p.id);
}

export async function addTerminalAndSelect(projectId: string, kind: TerminalKind): Promise<void> {
  const id = await ipc.addTerminal(projectId, kind);
  select(id);
}

/** Replace an exited terminal with a fresh one of the same kind in the same project. */
export async function restartTerminal(p: ProjectView, t: TerminalView): Promise<void> {
  const id = await ipc.addTerminal(p.id, t.kind);
  await ipc.closeTerminal(t.id);
  select(id);
}

export function shortenHome(path: string): string {
  const m = path.match(/^\/Users\/[^/]+(\/.*)?$/);
  return m ? "~" + (m[1] ?? "") : path;
}
```

- [ ] **Step 3: `terminals.ts`**

In `src/terminals.ts` change the import `import { writeStdin, resizeSession, openUrl } from "./ipc";` to `import { writeStdin, resizeTerminal, openUrl } from "./ipc";` and `void resizeSession(id, cols, rows);` to `void resizeTerminal(id, cols, rows);`. Nothing else changes: panes are already keyed by the id the backend sends, which is now the terminal id.

- [ ] **Step 4: `main.ts`**

Replace `src/main.ts` with:

```ts
import { getState, setProjects, setStatus, select, selectProject, selectedProject, findTerminal, allTerminals, subscribe } from "./store";
import { renderSidebar } from "./sidebar";
import { ensureTerminal, writeData, showTerminal, disposeTerminal, openSearch, setFontSize } from "./terminals";
import * as ipc from "./ipc";
import type { ProjectView } from "./store";
import { openNewSessionDialog } from "./newSession";
import { openSettings } from "./settings";
import { initNotifications } from "./notify";
import { maybeRestore } from "./restore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { closeTerminalWithConfirm, closeProjectWithConfirm, addTerminalAndSelect } from "./actions";
import { cycleTerminal } from "./projects";
import { initSidebarResizer } from "./layout";
import { initEmptyState } from "./emptyState";
import { ask } from "@tauri-apps/plugin-dialog";

async function closeSelectedTerminal(): Promise<void> {
  const hit = findTerminal(getState().selectedId);
  if (hit) await closeTerminalWithConfirm(hit.project, hit.terminal);
}

async function closeSelectedProject(): Promise<void> {
  const p = selectedProject();
  if (p) await closeProjectWithConfirm(p);
}

async function addToSelected(kind: "claude" | "shell"): Promise<void> {
  const p = selectedProject();
  if (p) await addTerminalAndSelect(p.id, kind);
}

function cycleSelected(dir: 1 | -1): void {
  const p = selectedProject();
  if (!p || p.terminals.length < 2) return;
  select(cycleTerminal(p, getState().selectedId, dir).id);
}

window.addEventListener("sonic:new-session", () => void openNewSessionDialog());
window.addEventListener("sonic:settings", () => void openSettings());

let knownIds = new Set<string>();

async function refresh(projects?: ProjectView[]): Promise<void> {
  const list = projects ?? (await ipc.listProjects());
  const ids = new Set<string>(allTerminals(list).map(t => t.id));
  for (const id of knownIds) if (!ids.has(id)) disposeTerminal(id);
  for (const id of ids) ensureTerminal(id);
  knownIds = ids;
  setProjects(list);
}

subscribe(() => showTerminal(getState().selectedId));

async function boot(): Promise<void> {
  await ipc.onProjectsChanged(p => void refresh(p));
  await ipc.onTerminalData((id, b64) => writeData(id, b64));
  await ipc.onTerminalStatus((id, status) => setStatus(id, status));
  await ipc.onMenu(id => {
    if (id === "new-project") void openNewSessionDialog();
    else if (id === "new-shell") void addToSelected("shell");
    else if (id === "new-claude") void addToSelected("claude");
    else if (id === "close-terminal") void closeSelectedTerminal();
    else if (id === "close-project") void closeSelectedProject();
    else if (id === "settings") window.dispatchEvent(new CustomEvent("sonic:settings"));
  });
  await initNotifications();
  setFontSize((await ipc.getSettings()).font_size);
  window.addEventListener("sonic:font-size", e => setFontSize((e as CustomEvent<number>).detail));
  initSidebarResizer();
  initEmptyState();
  await refresh();
  renderSidebar();
  setInterval(() => void refresh(), 30_000); // picks up branch switches

  const bin = await ipc.checkClaude();
  if (!bin) {
    const banner = document.createElement("div");
    banner.className = "banner";
    banner.textContent =
      "claude not found in your login shell PATH — set the binary path in Settings (⌘,)";
    document.body.prepend(banner);
  }

  await maybeRestore();

  await getCurrentWindow().onCloseRequested(async e => {
    const working = allTerminals(getState().projects).filter(t => t.status === "working");
    if (working.length > 0) {
      const yes = await ask(
        `${working.length} terminal(s) are still working. Quit anyway? (Claude terminals can be resumed on next launch.)`,
        { title: "Quit Sonic" },
      );
      if (!yes) e.preventDefault();
    }
  });
}

window.addEventListener("keydown", e => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === "f" && !e.shiftKey) {
    openSearch();
    e.preventDefault();
    return;
  }
  // ⌘⇧] / ⌘⇧[ cycle terminals inside the selected project (codes, since ⇧ changes e.key)
  if (e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
    cycleSelected(e.code === "BracketRight" ? 1 : -1);
    e.preventDefault();
    return;
  }
  if (/^[1-9]$/.test(e.key)) {
    const p = getState().projects[+e.key - 1];
    if (p) {
      selectProject(p.id);
      e.preventDefault();
    }
  }
});

void boot();
```

- [ ] **Step 5: `newSession.ts` and `settings.ts`**

In `src/newSession.ts`: change the import to `import { listProfiles, recentFolders, newProject, Profile } from "./ipc";`, the headings `New session — choose profile` to `New project — choose profile` and `New session — ${profile.name} — choose folder` to `New project — ${profile.name} — choose folder`, and in `pick` replace

```ts
      const id = await startSession(profile.id, folder);
      select(id);
```
with
```ts
      const { terminalId } = await newProject(profile.id, folder);
      select(terminalId);
```
and the error text `Failed to start session` with `Failed to start project`.

In `src/settings.ts` replace both occurrences of

```ts
      const id = await ipc.startSession(p.id, await homeDir(), null, `setup: ${p.name}`);
      closeSettings();
      select(id);
```
(one uses `p`, the other also `p` after `createProfile`) with
```ts
      const { terminalId } = await ipc.newProject(p.id, await homeDir(), `setup: ${p.name}`);
      closeSettings();
      select(terminalId);
```

- [ ] **Step 6: `restore.ts`**

Replace `src/restore.ts` with:

```ts
import * as ipc from "./ipc";
import type { ProjectRecord } from "./ipc";

/** Rebuild one project: its first Claude terminal comes with the project (resumed),
 *  every other terminal is added after it. Shells come back fresh. */
async function restoreProject(r: ProjectRecord): Promise<void> {
  const first = r.terminals.find(t => t.kind === "claude");
  const { projectId, terminalId } = await ipc.newProject(r.profile_id, r.cwd, r.name, first?.claude_session_id ?? null);
  if (first?.name) await ipc.renameTerminal(terminalId, first.name);
  for (const t of r.terminals) {
    if (t === first) continue;
    const id = await ipc.addTerminal(projectId, t.kind, t.kind === "claude" ? t.claude_session_id : null);
    if (t.name) await ipc.renameTerminal(id, t.name);
  }
}

async function restoreAll(records: ProjectRecord[]): Promise<void> {
  for (const r of records) {
    try {
      await restoreProject(r);
    } catch (e) {
      console.error("restore failed", r, e);
    }
  }
}

export async function maybeRestore(): Promise<void> {
  const prev = await ipc.previousProjects();
  if (prev.length === 0) return;
  // after an update-and-restart, bring everything back without asking
  if (await ipc.autoRestore()) {
    await restoreAll(prev);
    await ipc.discardPrevious();
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "dialog";
  box.innerHTML = `<h2>Restore previous projects?</h2><div id="restore-rows"></div>
    <div class="btn-row"><button id="r-yes">Restore selected</button><button id="r-no">Discard</button></div>`;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  const rows = box.querySelector("#restore-rows")!;
  const checks = new Map<string, HTMLInputElement>();
  for (const r of prev) {
    const row = document.createElement("label");
    row.className = "field row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    checks.set(r.id, cb);
    const text = document.createElement("span");
    const n = r.terminals.length;
    text.textContent = `${r.name} — ${r.cwd}` + (n > 1 ? ` (${n} terminals)` : "");
    row.append(cb, text);
    rows.appendChild(row);
  }
  const done = async (restore: boolean): Promise<void> => {
    if (restore) await restoreAll(prev.filter(r => checks.get(r.id)!.checked));
    await ipc.discardPrevious();
    overlay.remove();
  };
  box.querySelector("#r-yes")!.addEventListener("click", () => void done(true));
  box.querySelector("#r-no")!.addEventListener("click", () => void done(false));
}
```

- [ ] **Step 7: `notify.ts`, `emptyState.ts`, `updateBanner.ts`**

Replace `src/notify.ts` with:

```ts
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getState, subscribe, waitingCount } from "./store";
import { getSettings, setBadge } from "./ipc";
import { terminalLabel } from "./projects";

let lastStatuses = new Map<string, string>();
let enabled = true;

export async function initNotifications(): Promise<void> {
  enabled = (await getSettings()).notifications;
  if (enabled && !(await isPermissionGranted())) {
    enabled = (await requestPermission()) === "granted";
  }
  subscribe(onChange);
}

function onChange(): void {
  const { projects, selectedId } = getState();
  void setBadge(waitingCount());
  const next = new Map<string, string>();
  for (const p of projects) {
    for (const t of p.terminals) {
      next.set(t.id, t.status);
      const prev = lastStatuses.get(t.id);
      if (t.status === "waiting" && prev !== "waiting") {
        const focusedOnIt = document.hasFocus() && t.id === selectedId;
        if (enabled && !focusedOnIt) {
          sendNotification({
            title: `${terminalLabel(p, t)} needs your input`,
            body: `${p.profileName} · ${p.cwd}`,
          });
        }
      }
    }
  }
  lastStatuses = next;
}
```

In `src/emptyState.ts` replace `const { sessions } = getState();` / `if (sessions.length > 0) {` with `const { projects } = getState();` / `if (projects.length > 0) {`, and the text `No sessions` with `No projects`.

In `src/updateBanner.ts` change the import to also bring in `allTerminals`: `import { getState, allTerminals } from "./store";` and line 32 to
`const working = allTerminals(getState().projects).filter(t => t.status === "working").length;`.

- [ ] **Step 8: Minimal `sidebar.ts` edits so the build is green**

Task 6 rewrites `sidebar.ts`; for now make it compile against the new store by treating each project as a row for its primary terminal:

- Import line 1 becomes `import { getState, selectProject, subscribe, formatElapsed, ProjectView } from "./store";`
- Import line 2 becomes `import { renameProject, reorderProjects, revealInFinder, copyText } from "./ipc";`
- Import line 5 becomes `import { closeProjectWithConfirm, restartTerminal, shortenHome } from "./actions";`
- Add `import { primaryTerminal, rollupStatus } from "./projects";`
- Replace every `SessionView` with `ProjectView`, every `getState().sessions` with `getState().projects`, every `select(id)` with `selectProject(id)`, `renameSession` with `renameProject`, `reorderSessions` with `reorderProjects`, `closeSessionWithConfirm(s)` with `closeProjectWithConfirm(s)`.
- In `updateRow`, define `const primary = primaryTerminal(s); const status = rollupStatus(s);` and use `status` where `s.status` was, `primary.workingSince` where `s.workingSince` was. Replace the restart bar's click body with `e.stopPropagation(); void restartTerminal(s, primary);`.
- In `createRow`'s click handler use `getState().selectedId` compared against `primaryTerminal(s).id` only if you need it; simplest: `row.addEventListener("click", () => { if (dragged) return; selectProject(id); });`
- In `renderSidebar` compute `selected` as `s.terminals.some(t => t.id === selectedId)`.
- `setInterval` at the bottom: `getState().projects.some(p => p.terminals.some(t => t.workingSince !== undefined))`.

- [ ] **Step 9: Typecheck, test, and run the app**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -4`
Expected: no type errors; all tests pass.

Run: `npm run tauri dev` and confirm: existing projects appear (migrated from your old sessions) and restore works; ⌘N creates a project with a Claude terminal; ⌘T adds a shell (the sidebar does not show it yet, but ⌘⇧] switches to it and typing works); ⌘W closes the selected terminal; quit.

- [ ] **Step 10: Commit**

```bash
git add src
git commit -m "feat(ui): drive the frontend from projects and terminals"
```

---

### Task 6: Sidebar with nested terminal rows

**Files:**
- Rewrite: `src/sidebar.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: store (`getState`, `select`, `selectProject`, `subscribe`, `formatElapsed`), `projects.ts` helpers, `actions.ts` helpers, ipc (`renameProject`, `renameTerminal`, `reorderProjects`, `revealInFinder`, `copyText`), `sortable.ts`, `contextMenu.ts`, `updateBanner.ts`.
- Produces: `renderSidebar()` (unchanged signature).

Sidebar DOM logic is not unit tested in this codebase (it needs a DOM and Tauri); the sortable math it uses is already covered by `sortable.test.ts`. Verification is manual in Step 4.

- [ ] **Step 1: Rewrite `sidebar.ts`**

Replace `src/sidebar.ts` with:

```ts
import { getState, select, selectProject, subscribe, formatElapsed, ProjectView, TerminalView } from "./store";
import { renameProject, renameTerminal, reorderProjects, revealInFinder, copyText } from "./ipc";
import { moveItem, dropIndex } from "./sortable";
import { showContextMenu } from "./contextMenu";
import {
  closeProjectWithConfirm, closeTerminalWithConfirm, addTerminalAndSelect, restartTerminal, shortenHome,
} from "./actions";
import { primaryTerminal, rollupStatus } from "./projects";
import { initUpdateBanner } from "./updateBanner";

// Each project is a `.project-group`: its project row followed by one
// `.terminal-row` per terminal when there are two or more. Nodes are updated
// in place and keyed by id: rebuilding the DOM on every store change breaks
// double-click (second click hits a new node) and would destroy an
// in-progress rename input on any status event.
const groups = new Map<string, HTMLElement>();
const termRows = new Map<string, HTMLElement>();
let list: HTMLElement | null = null;

function ensureShell(): HTMLElement {
  if (list) return list;
  const el = document.getElementById("sidebar")!;
  list = document.createElement("div");
  list.className = "session-list";
  el.appendChild(list);
  const update = document.createElement("div");
  update.className = "update-banner";
  el.appendChild(update);
  initUpdateBanner(update);
  const version = document.createElement("div");
  version.className = "sidebar-version";
  version.textContent = `Sonic ${__APP_VERSION__}`;
  el.appendChild(version);
  const footer = document.createElement("div");
  footer.className = "sidebar-footer";
  footer.innerHTML = `<button id="btn-new">＋ New project</button><button id="btn-settings">⚙</button>`;
  el.appendChild(footer);
  footer.querySelector("#btn-new")!.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("sonic:new-session")),
  );
  footer.querySelector("#btn-settings")!.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("sonic:settings")),
  );
  return list;
}

function project(id: string): ProjectView | undefined {
  return getState().projects.find(p => p.id === id);
}

// ---- project rows ----

function createGroup(id: string): HTMLElement {
  const group = document.createElement("div");
  group.className = "project-group";
  group.dataset.id = id;
  const row = document.createElement("div");
  row.className = "session-row project";
  row.innerHTML = `
    <span class="dot"></span>
    <span class="row-main">
      <span class="row-top">
        <span class="row-name"></span>
        <span class="tag"></span>
      </span>
      <span class="folder"><bdi></bdi></span>
      <span class="row-meta"><span class="branch"></span><span class="elapsed"></span></span>
    </span>`;
  row.addEventListener("click", () => {
    if (dragged) return; // a completed drag is not a click
    selectProject(id);
  });
  row.addEventListener("mousedown", e => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("input, .restart")) return;
    beginDrag(group, id, e.clientY);
  });
  row.querySelector(".row-name")!.addEventListener("dblclick", e => {
    e.stopPropagation();
    startRename(row, name => void renameProject(id, name));
  });
  row.addEventListener("contextmenu", e => {
    e.preventDefault();
    selectProject(id);
    const p = project(id);
    if (p) showContextMenu(e.clientX, e.clientY, projectMenu(row, p));
  });
  group.appendChild(row);
  return group;
}

function setDot(dot: HTMLElement, status: TerminalView["status"]): void {
  dot.className = `dot ${status}`;
  dot.title = status === "unknown"
    ? "Status unknown: Sonic's hooks are not installed for this profile (its settings.json could not be parsed). See Settings."
    : status;
}

function setRestart(row: HTMLElement, show: boolean, onClick: () => void): void {
  const existing = row.querySelector<HTMLElement>(".restart");
  if (show && !existing) {
    const bar = document.createElement("span");
    bar.className = "restart";
    bar.textContent = "↻";
    bar.title = "Restart in same folder";
    bar.addEventListener("click", e => {
      e.stopPropagation();
      onClick();
    });
    row.appendChild(bar);
  } else if (!show && existing) {
    existing.remove();
  }
}

function updateProjectRow(row: HTMLElement, p: ProjectView, selected: boolean, expanded: boolean): void {
  const status = rollupStatus(p);
  const primary = primaryTerminal(p);
  row.className =
    "session-row project" +
    (selected ? (expanded ? " group-selected" : " selected") : "") +
    (status === "waiting" ? " waiting" : "");
  setDot(row.querySelector<HTMLElement>(".dot")!, status);
  const nameEl = row.querySelector<HTMLElement>(".row-name");
  if (nameEl && nameEl.textContent !== p.name) nameEl.textContent = p.name; // absent while renaming
  const tag = row.querySelector<HTMLElement>(".tag")!;
  tag.textContent = p.profileName;
  tag.style.color = p.profileColor;
  tag.style.borderColor = p.profileColor;
  const folder = row.querySelector<HTMLElement>(".folder")!;
  folder.querySelector("bdi")!.textContent = shortenHome(p.cwd);
  folder.title = p.cwd;
  const branch = row.querySelector<HTMLElement>(".branch")!;
  branch.textContent = p.branch ? `⎇ ${p.branch}` : "";
  const elapsed = row.querySelector<HTMLElement>(".elapsed")!;
  elapsed.textContent = expanded ? "" : (formatElapsed(primary.workingSince, Date.now()) ?? "");
  row.querySelector<HTMLElement>(".row-meta")!.hidden = !p.branch && !elapsed.textContent;
  setRestart(row, !expanded && primary.status === "exited", () => void restartTerminal(p, primary));
}

// ---- terminal rows (only when a project has two or more) ----

function createTerminalRow(projectId: string, id: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "terminal-row";
  row.dataset.id = id;
  row.innerHTML = `<span class="dot"></span><span class="kind"></span><span class="row-name"></span><span class="elapsed"></span>`;
  row.addEventListener("click", () => {
    if (dragged) return;
    select(id);
  });
  row.querySelector(".row-name")!.addEventListener("dblclick", e => {
    e.stopPropagation();
    startRename(row, name => void renameTerminal(id, name));
  });
  row.addEventListener("contextmenu", e => {
    e.preventDefault();
    select(id);
    const p = project(projectId);
    const t = p?.terminals.find(x => x.id === id);
    if (p && t) showContextMenu(e.clientX, e.clientY, terminalMenu(row, p, t));
  });
  return row;
}

function updateTerminalRow(row: HTMLElement, p: ProjectView, t: TerminalView, selected: boolean): void {
  row.className = "terminal-row" + (selected ? " selected" : "") + (t.status === "waiting" ? " waiting" : "");
  setDot(row.querySelector<HTMLElement>(".dot")!, t.status);
  row.querySelector<HTMLElement>(".kind")!.textContent = t.kind === "claude" ? "✦" : "$";
  const nameEl = row.querySelector<HTMLElement>(".row-name");
  if (nameEl && nameEl.textContent !== t.name) nameEl.textContent = t.name;
  row.querySelector<HTMLElement>(".elapsed")!.textContent = formatElapsed(t.workingSince, Date.now()) ?? "";
  setRestart(row, t.status === "exited", () => void restartTerminal(p, t));
}

export function renderSidebar(): void {
  const list = ensureShell();
  const { projects, selectedId } = getState();
  const seen = new Set<string>();
  projects.forEach((p, i) => {
    seen.add(p.id);
    let group = groups.get(p.id);
    if (!group) {
      group = createGroup(p.id);
      groups.set(p.id, group);
    }
    const expanded = p.terminals.length > 1;
    const selectedInProject = p.terminals.some(t => t.id === selectedId);
    updateProjectRow(group.firstElementChild as HTMLElement, p, selectedInProject, expanded);

    const wanted = expanded ? p.terminals : [];
    wanted.forEach((t, j) => {
      let row = termRows.get(t.id);
      if (!row) {
        row = createTerminalRow(p.id, t.id);
        termRows.set(t.id, row);
      }
      updateTerminalRow(row, p, t, t.id === selectedId);
      const slot = group!.children[j + 1] ?? null; // index 0 is the project row
      if (slot !== row) group!.insertBefore(row, slot);
    });
    for (const el of [...group.querySelectorAll<HTMLElement>(".terminal-row")]) {
      const tid = el.dataset.id!;
      if (!wanted.some(t => t.id === tid)) {
        el.remove();
        termRows.delete(tid);
      }
    }
    // only move nodes whose position actually changed (moving blurs inputs)
    if (!sorting && list.children[i] !== group) list.insertBefore(group, list.children[i] ?? null);
  });
  for (const [id, group] of groups) {
    if (!seen.has(id)) {
      for (const el of group.querySelectorAll<HTMLElement>(".terminal-row")) termRows.delete(el.dataset.id!);
      group.remove();
      groups.delete(id);
    }
  }
}

// ---- drag-to-reorder projects (pointer based: the webview's native DnD is
// taken by Tauri for file drops, so the HTML5 drag API never fires in-page) ----
const DRAG_THRESHOLD = 5;
let dragged = false;
let sorting = false; // renderSidebar must not move nodes while a drag is in flight

function beginDrag(group: HTMLElement, id: string, startY: number): void {
  const list = ensureShell();
  let placeholder: HTMLElement | null = null;
  let target = -1;
  const from = getState().projects.findIndex(p => p.id === id);

  const onMove = (e: MouseEvent): void => {
    const dy = e.clientY - startY;
    if (!placeholder) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return;
      dragged = true;
      placeholder = document.createElement("div");
      placeholder.className = "drop-placeholder";
      placeholder.style.height = `${group.offsetHeight}px`;
      group.classList.add("dragging");
      group.style.width = `${group.offsetWidth}px`;
      list.insertBefore(placeholder, group);
      document.body.classList.add("sorting");
      sorting = true;
    }
    group.style.transform = `translateY(${dy}px)`;
    const others = [...list.querySelectorAll<HTMLElement>(".project-group:not(.dragging)")];
    const centers = others.map(g => { const b = g.getBoundingClientRect(); return b.top + b.height / 2; });
    target = dropIndex(centers, e.clientY);
    list.insertBefore(placeholder, others[target] ?? null);
  };
  const onUp = (): void => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (!placeholder) return;
    placeholder.remove();
    group.classList.remove("dragging");
    group.style.transform = "";
    group.style.width = "";
    document.body.classList.remove("sorting");
    sorting = false;
    const ids = getState().projects.map(p => p.id);
    const next = moveItem(ids, from, target);
    if (next.some((v, i) => v !== ids[i])) void reorderProjects(next);
    // let the click that follows mouseup see `dragged`, then reset
    setTimeout(() => { dragged = false; }, 0);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// ---- context menus ----

function projectMenu(row: HTMLElement, p: ProjectView) {
  return [
    { label: "Rename…", action: () => startRename(row, name => void renameProject(p.id, name)) },
    { label: "New shell here", action: () => void addTerminalAndSelect(p.id, "shell") },
    { label: "New Claude terminal here", action: () => void addTerminalAndSelect(p.id, "claude") },
    { label: "Reveal folder in Finder", action: () => void revealInFinder(p.cwd) },
    { label: "Copy folder path", action: () => void copyText(p.cwd) },
    { label: "Close project", danger: true, action: () => void closeProjectWithConfirm(p) },
  ];
}

function terminalMenu(row: HTMLElement, p: ProjectView, t: TerminalView) {
  return [
    { label: "Rename…", action: () => startRename(row, name => void renameTerminal(t.id, name)) },
    { label: "Close terminal", danger: true, action: () => void closeTerminalWithConfirm(p, t) },
  ];
}

// ---- inline rename (shared by project and terminal rows) ----

function startRename(row: HTMLElement, save: (name: string) => void): void {
  const nameEl = row.querySelector<HTMLElement>(".row-name");
  if (!nameEl) return; // already renaming
  const current = nameEl.textContent ?? "";
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = current;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    input.replaceWith(nameEl);
    const next = input.value.trim();
    if (commit && next && next !== current) save(next);
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", e => e.stopPropagation());
  input.addEventListener("mousedown", e => e.stopPropagation());
  input.addEventListener("dblclick", e => e.stopPropagation());
}

subscribe(renderSidebar);

// keep the elapsed-time labels moving
setInterval(() => {
  if (getState().projects.some(p => p.terminals.some(t => t.workingSince !== undefined))) renderSidebar();
}, 30_000);
```

- [ ] **Step 2: Styles**

In `src/styles.css`, replace the line

```css
.session-row.dragging { position: relative; z-index: 10; opacity: 0.85; background: #292e42; box-shadow: 0 4px 12px #0008; pointer-events: none; }
```
with
```css
.project-group.dragging { position: relative; z-index: 10; opacity: 0.85; background: #292e42; box-shadow: 0 4px 12px #0008; pointer-events: none; }
.session-row.group-selected { background: #1f2335; }
.terminal-row { display: flex; gap: 8px; align-items: center; padding: 4px 12px 4px 30px; cursor: pointer; font-size: 12px; }
.terminal-row:hover { background: #1f2335; }
.terminal-row.selected { background: #292e42; }
.terminal-row.waiting { box-shadow: inset 2px 0 0 var(--waiting); }
.terminal-row .kind { color: var(--dim); font-family: Menlo, monospace; font-size: 11px; width: 10px; text-align: center; flex: none; }
.terminal-row .row-name { flex: 1; }
.terminal-row .elapsed { font-size: 11px; color: var(--accent); }
.terminal-row .restart { margin-left: 0; }
```

and change `body.sorting .session-row { transition: none; }` to `body.sorting .session-row, body.sorting .terminal-row { transition: none; }`.

- [ ] **Step 3: Typecheck and test**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -4`
Expected: clean, all pass.

- [ ] **Step 4: Manual verification in the dev build**

Run: `npm run tauri dev`. Check each:

1. A project with one terminal looks like before (no nested rows).
2. ⌘T adds a shell: two indented rows appear (`✦ claude`, `$ shell`), the shell is selected, the project row is lightly highlighted, the shell row strongly.
3. In the shell, run `claude`: the shell row's dot turns blue while it works (hooks report to the shell's terminal id).
4. ⌘⇧] and ⌘⇧[ cycle between the two rows. ⌘1 on another project and back returns to the shell (remembered).
5. Right-click the project row: New shell here / New Claude terminal here / Close project present. Right-click a terminal row: Rename… / Close terminal.
6. Double-click a terminal name, rename, Enter: the name sticks after a status event.
7. Drag a project by its row: the whole group (with nested rows) moves; order persists after restart.
8. ⌘W on the shell closes it: the project collapses to a single row. ⌘W on the last terminal closes the project.
9. Quit with a shell open, relaunch, restore: the shell comes back fresh, the Claude terminal resumes.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar.ts src/styles.css
git commit -m "feat(sidebar): nested terminal rows, project context menu, group drag"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

In the Install section's first-run text and the "How it works" bullets, replace "session" wording where a row is meant with "project" (keep "session" where it refers to a Claude Code session or `--resume`). Add a bullet under the sidebar description:

```markdown
- **Several terminals per project**: add a plain shell (`⌘T`) or a second Claude terminal (`⌘⇧T`)
  to any project. They run in the project folder with the profile's environment, show as
  indented rows, and cycle with `⌘⇧]` / `⌘⇧[`.
```

Replace the Keyboard table with:

```markdown
| Shortcut | Action |
|---|---|
| `⌘N` | New project (profile → folder), opens with its Claude terminal |
| `⌘T` | New shell in the selected project |
| `⌘⇧T` | New Claude terminal in the selected project |
| `⌘W` | Close the selected terminal (asks first if it's working); the last one closes the project |
| `⌘⇧W` | Close the selected project |
| `⌘1` … `⌘9` | Jump to the n-th project |
| `⌘⇧]` / `⌘⇧[` | Next / previous terminal in the project |
| `⌘F` | Find in the terminal |
| `⌘,` | Settings: profiles, `claude` binary path, notifications |
| double-click a name | Rename the project or terminal |
```

- [ ] **Step 2: Scan for leaked personal data and commit**

Run: `git grep -nE "/Users/[a-z]+|@[a-z-]+\.(ch|com)" -- . ':!package-lock.json'` (home paths, e-mail addresses)
Expected: no output.

```bash
git add README.md
git commit -m "docs: projects with multiple terminals"
```

---

## Self-review notes

- Spec §4.1–4.3 → Task 1. §4.4–4.5, §6, §6.1 → Tasks 2, 3. §5 → Tasks 4, 6. §7 → Tasks 3 (menu accelerators), 5 (cycling keys), 6 (context menus). §8 → Task 5 (restore, notifications, exited rows via restart bar in Task 6). §9 → Tasks 4–6. §10 → tests in Tasks 1, 2, 4 plus manual checks in Tasks 5 and 6. §11 order matches Tasks 1–7.
- Names used across tasks: `SpawnCommand`, `login_shell`, `TerminalKind`, `ProjectRecord`, `TerminalRecord`, `remove_terminal`, `project_of_mut`, `terminal_name`, `primary`; TS `setProjects`, `select`, `selectProject`, `findTerminal`, `selectedProject`, `allTerminals`, `primaryTerminal`, `rollupStatus`, `cycleTerminal`, `terminalLabel`, `closeTerminalWithConfirm`, `closeProjectWithConfirm`, `addTerminalAndSelect`, `restartTerminal`, ipc `newProject`, `addTerminal`, `closeTerminal`, `closeProject`, `renameProject`, `renameTerminal`, `reorderProjects`, `resizeTerminal`, `previousProjects`, events `projects-changed`, `terminal-data`, `terminal-status`, menu ids `new-project`, `new-shell`, `new-claude`, `close-terminal`, `close-project`.
