use std::{fs, io, path::{Path, PathBuf}};

pub const HOOK_EVENTS: [(&str, &str); 3] = [
    ("UserPromptSubmit", "working"),
    ("Notification", "waiting"),
    ("Stop", "idle"),
];

pub const HOOK_SCRIPT: &str = r#"#!/bin/sh
# sonic status hook - no-ops outside sonic-managed sessions
[ -z "$SONIC_SESSION_ID" ] && exit 0
[ -z "$SONIC_SOCKET" ] && exit 0
payload=$(cat)
[ -z "$payload" ] && payload='{}'
printf '{"sonic_session":"%s","state":"%s","hook":%s}' \
  "$SONIC_SESSION_ID" "$1" "$payload" | nc -U "$SONIC_SOCKET" 2>/dev/null
exit 0
"#;

#[derive(Debug)]
pub enum HookError { Malformed, Io(io::Error) }
impl From<io::Error> for HookError {
    fn from(e: io::Error) -> Self { HookError::Io(e) }
}

pub fn write_hook_script(base: &Path) -> io::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(base)?;
    let p = base.join("hook.sh");
    fs::write(&p, HOOK_SCRIPT)?;
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755))?;
    Ok(p)
}

pub fn install_hooks(config_dir: &Path, script: &Path) -> Result<(), HookError> {
    fs::create_dir_all(config_dir)?;
    let settings_path = config_dir.join("settings.json");
    let existed = settings_path.exists();
    let text = if existed { fs::read_to_string(&settings_path)? } else { "{}".to_string() };
    let mut root: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| HookError::Malformed)?;
    let obj = root.as_object_mut().ok_or(HookError::Malformed)?;
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    let hooks = hooks.as_object_mut().ok_or(HookError::Malformed)?;
    // Claude Code runs hook commands through a shell, so the path must be
    // quoted - the default data dir lives under "Application Support".
    let quoted = format!("'{}'", script.to_string_lossy().replace('\'', r"'\''"));
    let mut changed = false;
    for (event, state) in HOOK_EVENTS {
        let arr = hooks.entry(event).or_insert_with(|| serde_json::json!([]));
        let arr = arr.as_array_mut().ok_or(HookError::Malformed)?;
        let want = format!("{quoted} {state}");
        let ours = arr.iter_mut().find_map(|entry| {
            entry["hooks"].as_array_mut()?.iter_mut().find(|h|
                h["command"].as_str().is_some_and(|c| c.contains("hook.sh")))
        });
        match ours {
            Some(h) if h["command"].as_str() == Some(want.as_str()) => {}
            Some(h) => { h["command"] = serde_json::Value::String(want); changed = true; }
            None => {
                arr.push(serde_json::json!({
                    "hooks": [{ "type": "command", "command": want }]
                }));
                changed = true;
            }
        }
    }
    if changed {
        let backup = config_dir.join("settings.json.sonic-backup");
        if existed && !backup.exists() {
            fs::write(&backup, &text)?;
        }
        fs::write(&settings_path, serde_json::to_vec_pretty(&root).unwrap())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn install(dir: &std::path::Path) -> Result<(), HookError> {
        install_hooks(dir, std::path::Path::new("/data/hook.sh"))
    }

    #[test]
    fn script_written_executable() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempdir().unwrap();
        let p = write_hook_script(d.path()).unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111);
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.contains("SONIC_SESSION_ID"));
        assert!(body.contains("nc -U"));
    }

    #[test]
    fn install_into_empty_dir_creates_settings() {
        let d = tempdir().unwrap();
        install(d.path()).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(d.path().join("settings.json")).unwrap()).unwrap();
        for (event, state) in HOOK_EVENTS {
            let cmd = v["hooks"][event][0]["hooks"][0]["command"].as_str().unwrap();
            assert_eq!(cmd, format!("'/data/hook.sh' {state}"));
        }
        assert!(!d.path().join("settings.json.sonic-backup").exists());
    }

    #[test]
    fn existing_hooks_preserved_and_backed_up() {
        let d = tempdir().unwrap();
        let orig = r#"{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"my-own.sh"}]}]}}"#;
        std::fs::write(d.path().join("settings.json"), orig).unwrap();
        install(d.path()).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(d.path().join("settings.json")).unwrap()).unwrap();
        assert_eq!(v["model"], "opus");
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(std::fs::read_to_string(d.path().join("settings.json.sonic-backup")).unwrap(), orig);
    }

    #[test]
    fn script_path_with_space_is_quoted_and_old_entry_repaired() {
        let d = tempdir().unwrap();
        let script = std::path::Path::new("/Users/x/Library/Application Support/sonic/hook.sh");
        std::fs::write(d.path().join("settings.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/Users/x/Library/Application Support/sonic/hook.sh idle"}]}]}}"#).unwrap();
        install_hooks(d.path(), script).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(d.path().join("settings.json")).unwrap()).unwrap();
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1);
        let cmd = stop[0]["hooks"][0]["command"].as_str().unwrap();
        assert_eq!(cmd, "'/Users/x/Library/Application Support/sonic/hook.sh' idle");
        // the command must survive being run through a shell
        let out = std::process::Command::new("/bin/sh").arg("-c")
            .arg(cmd.replace("/Users/x/Library/Application Support/sonic/hook.sh", "/bin/echo"))
            .output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "idle");
    }

    #[test]
    fn idempotent_reinstall() {
        let d = tempdir().unwrap();
        install(d.path()).unwrap();
        let first = std::fs::read_to_string(d.path().join("settings.json")).unwrap();
        install(d.path()).unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join("settings.json")).unwrap(), first);
    }

    #[test]
    fn malformed_settings_rejected_untouched() {
        let d = tempdir().unwrap();
        std::fs::write(d.path().join("settings.json"), "{oops").unwrap();
        assert!(matches!(install(d.path()), Err(HookError::Malformed)));
        assert_eq!(std::fs::read_to_string(d.path().join("settings.json")).unwrap(), "{oops");
    }
}
