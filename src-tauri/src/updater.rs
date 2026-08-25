use serde::Serialize;
use std::path::{Path, PathBuf};

pub const CASK: &str = "claude-code@latest";
pub const SONIC_CASK: &str = "sonic";

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// version brew has installed (None when claude isn't the brew cask)
    pub installed: Option<String>,
    /// newer version brew can upgrade to
    pub latest: Option<String>,
    pub needs_upgrade: bool,
    /// running sessions were started from a different binary than the one on disk now
    pub needs_restart: bool,
}

/// Parse `brew outdated --cask <cask> --json` output. Returns
/// (installed, latest) when the cask is outdated, None otherwise.
pub fn parse_brew_outdated(json: &str) -> Option<(String, String)> {
    parse_brew_outdated_for(json, CASK)
}

pub fn parse_brew_outdated_for(json: &str, cask: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let cask = v["casks"].as_array()?.iter().find(|c| c["name"].as_str() == Some(cask))?;
    let installed = cask["installed_versions"].as_array()?.first()?.as_str()?.to_string();
    let latest = cask["current_version"].as_str()?.to_string();
    Some((installed, latest))
}

/// Parse `brew list --cask --versions <CASK>` output ("claude-code@latest 2.1.245").
pub fn parse_brew_installed(out: &str) -> Option<String> {
    let line = out.lines().find(|l| l.starts_with(CASK))?;
    line.split_whitespace().nth(1).map(str::to_string)
}

/// Where the `claude` binary really lives — the cask symlink resolves to a
/// versioned Caskroom path, so this changes whenever brew upgrades.
pub fn resolve_bin(bin: &str) -> Option<PathBuf> {
    std::fs::canonicalize(Path::new(bin)).ok()
}

pub fn compute(
    brew_outdated_json: Option<&str>,
    brew_installed: Option<&str>,
    running_bins: &[PathBuf],
    current_bin: Option<&Path>,
) -> UpdateInfo {
    let outdated = brew_outdated_json.and_then(parse_brew_outdated);
    let installed = outdated.as_ref().map(|(i, _)| i.clone())
        .or_else(|| brew_installed.and_then(parse_brew_installed));
    let latest = outdated.as_ref().map(|(_, l)| l.clone());
    let needs_restart = match current_bin {
        Some(cur) => running_bins.iter().any(|b| b != cur),
        None => false,
    };
    UpdateInfo { needs_upgrade: latest.is_some(), installed, latest, needs_restart }
}

fn zsh(cmd: &str) -> std::io::Result<std::process::Output> {
    std::process::Command::new("/bin/zsh").args(["-lc", cmd]).output()
}

pub fn check(running_bins: &[PathBuf], claude_bin: &str) -> UpdateInfo {
    let outdated = zsh(&format!("brew outdated --cask {CASK} --json")).ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string());
    let installed = zsh(&format!("brew list --cask --versions {CASK}")).ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string());
    let current = resolve_bin(claude_bin);
    compute(outdated.as_deref(), installed.as_deref(), running_bins, current.as_deref())
}

/// Newer Sonic version available via the `sonic` cask, if any.
pub fn check_sonic() -> Option<String> {
    // the tap is a local git clone that `brew outdated` never refreshes on its own
    let _ = zsh("brew update --quiet");
    let out = zsh(&format!("brew outdated --cask {SONIC_CASK} --json")).ok()
        .filter(|o| o.status.success())?;
    parse_brew_outdated_for(&String::from_utf8_lossy(&out.stdout), SONIC_CASK).map(|(_, l)| l)
}

pub fn upgrade() -> Result<(), String> {
    upgrade_cask(CASK)
}

pub fn upgrade_sonic() -> Result<(), String> {
    upgrade_cask(SONIC_CASK)
}

fn upgrade_cask(cask: &str) -> Result<(), String> {
    let out = zsh(&format!("brew upgrade --cask {cask}")).map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { "brew upgrade failed".into() } else { err })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUTDATED: &str = r#"{"formulae":[],"casks":[{"name":"claude-code@latest","installed_versions":["2.1.245"],"current_version":"2.1.250"}]}"#;

    #[test]
    fn parses_outdated_cask() {
        assert_eq!(parse_brew_outdated(OUTDATED), Some(("2.1.245".into(), "2.1.250".into())));
        assert_eq!(parse_brew_outdated(r#"{"formulae":[],"casks":[]}"#), None);
        assert_eq!(parse_brew_outdated("nope"), None);
    }

    #[test]
    fn parses_outdated_sonic_cask() {
        let j = r#"{"formulae":[],"casks":[{"name":"sonic","installed_versions":["0.1.3"],"current_version":"0.1.4"}]}"#;
        assert_eq!(parse_brew_outdated_for(j, SONIC_CASK), Some(("0.1.3".into(), "0.1.4".into())));
        assert_eq!(parse_brew_outdated_for(j, CASK), None);
        assert_eq!(parse_brew_outdated_for(r#"{"casks":[]}"#, SONIC_CASK), None);
    }

    #[test]
    fn parses_installed_version() {
        assert_eq!(parse_brew_installed("claude-code@latest 2.1.245\n"), Some("2.1.245".into()));
        assert_eq!(parse_brew_installed(""), None);
    }

    #[test]
    fn upgrade_available() {
        let cur = PathBuf::from("/Caskroom/c/2.1.245/claude");
        let info = compute(Some(OUTDATED), None, &[cur.clone()], Some(&cur));
        assert!(info.needs_upgrade && !info.needs_restart);
        assert_eq!(info.latest.as_deref(), Some("2.1.250"));
    }

    #[test]
    fn restart_needed_after_upgrade_outside_sonic() {
        let old = PathBuf::from("/Caskroom/c/2.1.245/claude");
        let new = PathBuf::from("/Caskroom/c/2.1.250/claude");
        let info = compute(Some(r#"{"casks":[]}"#), Some("claude-code@latest 2.1.250"), &[old], Some(&new));
        assert!(!info.needs_upgrade && info.needs_restart);
        assert_eq!(info.installed.as_deref(), Some("2.1.250"));
    }

    #[test]
    fn nothing_to_do() {
        let cur = PathBuf::from("/x/claude");
        let info = compute(None, None, &[cur.clone()], Some(&cur));
        assert_eq!(info, UpdateInfo::default());
    }
}
