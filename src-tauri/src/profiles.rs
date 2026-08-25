use crate::hooks;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io, path::{Path, PathBuf}};

pub const PALETTE: [&str; 8] = [
    "#7aa2f7", "#9ece6a", "#e0af68", "#f7768e",
    "#bb9af7", "#7dcfff", "#ff9e64", "#73daca",
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub config_dir: PathBuf,
    pub managed: bool,
    #[serde(default)] pub env: HashMap<String, String>,
    pub color: String,
    #[serde(default)] pub hooks_ok: bool,
}

pub struct ProfileRegistry {
    profiles: Vec<Profile>,
    base: PathBuf,
}

pub fn slugify(name: &str) -> String {
    let s: String = name.trim().to_lowercase().chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let mut out = String::new();
    for c in s.chars() {
        if c == '-' && out.ends_with('-') { continue; }
        out.push(c);
    }
    out.trim_matches('-').to_string()
}

impl ProfileRegistry {
    fn file(base: &Path) -> PathBuf { base.join("profiles.json") }

    pub fn load(base: &Path) -> Self {
        let profiles = match fs::read_to_string(Self::file(base)) {
            Err(_) => Vec::new(),
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| {
                let _ = fs::rename(Self::file(base), base.join("profiles.json.corrupt"));
                Vec::new()
            }),
        };
        let mut reg = Self { profiles, base: base.to_path_buf() };
        reg.refresh_hooks();
        reg
    }

    /// Re-run the hook installer for every profile so upgrades that change
    /// the hook command (or a rewritten hook.sh) reach existing profiles.
    fn refresh_hooks(&mut self) {
        let Ok(script) = hooks::write_hook_script(&self.base) else { return };
        let mut changed = false;
        for p in &mut self.profiles {
            let ok = hooks::install_hooks(&p.config_dir, &script).is_ok();
            if ok != p.hooks_ok { p.hooks_ok = ok; changed = true; }
        }
        if changed { let _ = self.persist(); }
    }

    fn persist(&self) -> io::Result<()> {
        fs::create_dir_all(&self.base)?;
        fs::write(Self::file(&self.base), serde_json::to_vec_pretty(&self.profiles)?)
    }

    pub fn profiles(&self) -> &[Profile] { &self.profiles }

    pub fn get(&self, id: &str) -> Option<Profile> {
        self.profiles.iter().find(|p| p.id == id).cloned()
    }

    fn add(&mut self, name: &str, config_dir: PathBuf, managed: bool) -> io::Result<Profile> {
        let script = hooks::write_hook_script(&self.base)?;
        let hooks_ok = hooks::install_hooks(&config_dir, &script).is_ok();
        let p = Profile {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            config_dir,
            managed,
            env: HashMap::new(),
            color: PALETTE[self.profiles.len() % PALETTE.len()].to_string(),
            hooks_ok,
        };
        self.profiles.push(p.clone());
        self.persist()?;
        Ok(p)
    }

    pub fn create(&mut self, name: &str) -> io::Result<Profile> {
        let slug = slugify(name);
        let mut dir = self.base.join("profiles").join(&slug);
        let mut n = 1;
        while dir.exists() {
            n += 1;
            dir = self.base.join("profiles").join(format!("{slug}-{n}"));
        }
        fs::create_dir_all(&dir)?;
        self.add(name, dir, true)
    }

    pub fn import(&mut self, name: &str, dir: &Path) -> io::Result<Profile> {
        self.add(name, dir.to_path_buf(), false)
    }

    pub fn update(&mut self, p: Profile) -> io::Result<()> {
        if let Some(slot) = self.profiles.iter_mut().find(|x| x.id == p.id) { *slot = p; }
        self.persist()
    }

    pub fn delete(&mut self, id: &str) -> io::Result<()> {
        if let Some(p) = self.get(id) {
            if p.managed {
                let _ = trash::delete(&p.config_dir); // best effort; never rm -rf
            }
        }
        self.profiles.retain(|p| p.id != id);
        self.persist()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn load_repairs_hooks_of_existing_profiles() {
        let base = tempdir().unwrap();
        let cfg = tempdir().unwrap();
        let mut reg = ProfileRegistry::load(base.path());
        reg.import("old", cfg.path()).unwrap();
        // simulate a settings.json written by an older Sonic (unquoted path)
        let script = base.path().join("hook.sh").to_string_lossy().to_string();
        std::fs::write(cfg.path().join("settings.json"),
            format!(r#"{{"hooks":{{"Stop":[{{"hooks":[{{"type":"command","command":"{script} idle"}}]}}]}}}}"#)).unwrap();
        let _ = ProfileRegistry::load(base.path());
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(cfg.path().join("settings.json")).unwrap()).unwrap();
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap(), format!("'{script}' idle"));
        assert!(v["hooks"]["UserPromptSubmit"].is_array());
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Acme Corp"), "acme-corp");
        assert_eq!(slugify("  Süper / Näme  "), "s-per-n-me");
    }

    #[test]
    fn create_makes_managed_dir_with_hooks() {
        let d = tempdir().unwrap();
        let mut r = ProfileRegistry::load(d.path());
        let p = r.create("Acme Corp").unwrap();
        assert!(p.managed);
        assert!(p.hooks_ok);
        assert_eq!(p.config_dir, d.path().join("profiles/acme-corp"));
        assert!(p.config_dir.join("settings.json").exists());
        let r2 = ProfileRegistry::load(d.path());
        assert_eq!(r2.profiles().len(), 1);
        assert_eq!(r2.profiles()[0].name, "Acme Corp");
    }

    #[test]
    fn create_duplicate_names_get_distinct_dirs() {
        let d = tempdir().unwrap();
        let mut r = ProfileRegistry::load(d.path());
        let a = r.create("work").unwrap();
        let b = r.create("work").unwrap();
        assert_ne!(a.config_dir, b.config_dir);
    }

    #[test]
    fn import_points_at_existing_dir() {
        let d = tempdir().unwrap();
        let ext = tempdir().unwrap();
        std::fs::write(ext.path().join("settings.json"), "{}").unwrap();
        let mut r = ProfileRegistry::load(d.path());
        let p = r.import("old", ext.path()).unwrap();
        assert!(!p.managed);
        assert!(p.hooks_ok);
        assert_eq!(p.config_dir, ext.path());
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(ext.path().join("settings.json")).unwrap()).unwrap();
        assert!(v["hooks"]["Stop"].is_array());
    }

    #[test]
    fn import_malformed_settings_flags_hooks_not_ok() {
        let d = tempdir().unwrap();
        let ext = tempdir().unwrap();
        std::fs::write(ext.path().join("settings.json"), "{bad").unwrap();
        let mut r = ProfileRegistry::load(d.path());
        let p = r.import("bad", ext.path()).unwrap();
        assert!(!p.hooks_ok);
    }

    #[test]
    fn delete_imported_leaves_dir() {
        let d = tempdir().unwrap();
        let ext = tempdir().unwrap();
        let mut r = ProfileRegistry::load(d.path());
        let p = r.import("old", ext.path()).unwrap();
        r.delete(&p.id).unwrap();
        assert!(r.profiles().is_empty());
        assert!(ext.path().exists());
    }

    #[test]
    fn colors_cycle_palette() {
        let d = tempdir().unwrap();
        let mut r = ProfileRegistry::load(d.path());
        let a = r.create("a").unwrap();
        let b = r.create("b").unwrap();
        assert_ne!(a.color, b.color);
    }
}
