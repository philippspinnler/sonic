use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io, path::{Path, PathBuf}};

pub const MAX_RECENT: usize = 10;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SessionRecord {
    pub id: String,
    pub name: String,
    pub profile_id: String,
    pub cwd: String,
    #[serde(default)]
    pub claude_session_id: Option<String>,
    pub created_at: String,
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
    #[serde(default)] pub sessions: Vec<SessionRecord>,
    #[serde(default)] pub recent_folders: HashMap<String, Vec<String>>,
    #[serde(default)] pub settings: AppSettings,
    /// set before a self-restart so the next launch restores all sessions without asking
    #[serde(default)] pub restore_all_on_launch: bool,
}

pub const STATE_VERSION: u32 = 1;
fn state_version() -> u32 { STATE_VERSION }
impl Default for AppState {
    fn default() -> Self {
        Self { version: STATE_VERSION, sessions: Vec::new(), recent_folders: HashMap::new(),
               settings: AppSettings::default(), restore_all_on_launch: false }
    }
}

fn state_path(base: &Path) -> PathBuf { base.join("state.json") }

pub fn load(base: &Path) -> AppState {
    let p = state_path(base);
    let Ok(text) = fs::read_to_string(&p) else { return AppState::default() };
    match serde_json::from_str(&text) {
        Ok(s) => s,
        Err(_) => {
            let _ = fs::rename(&p, base.join("state.json.corrupt"));
            AppState::default()
        }
    }
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

    fn rec(id: &str) -> SessionRecord {
        SessionRecord {
            id: id.into(), name: "n".into(), profile_id: "p".into(),
            cwd: "/tmp".into(), claude_session_id: None, created_at: "2026-08-24".into(),
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
        s.sessions.push(rec("a"));
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
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("state.json"), r#"{"sessions":[],"settings":{"notifications":false}}"#).unwrap();
        let s = load(d.path());
        assert_eq!(s.version, STATE_VERSION);
        assert!(!s.settings.notifications);
        assert_eq!(s.settings.font_size, 13);
    }

    #[test]
    fn notifications_default_true() {
        assert!(AppState::default().settings.notifications);
    }
}
