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
