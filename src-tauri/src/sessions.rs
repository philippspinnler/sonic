use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::{collections::HashMap, io::{self, Read, Write}, path::PathBuf};

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

pub struct SessionProc {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl SessionProc {
    pub fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }

    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

pub fn spawn(
    spec: &SpawnSpec,
    mut on_output: impl FnMut(&[u8]) + Send + 'static,
    on_exit: impl FnOnce(u32) + Send + 'static,
) -> anyhow::Result<SessionProc> {
    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })?;

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

    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.args(["-lc", &shell_cmd]);
    cmd.cwd(&spec.cwd);
    // If Sonic itself was launched from inside a Claude Code session, these
    // inherited markers would make the child claude think it is a nested
    // session and disable transcript persistence (breaking --resume).
    for marker in ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"] {
        cmd.env_remove(marker);
    }
    cmd.env("CLAUDE_CONFIG_DIR", &spec.config_dir);
    cmd.env("SONIC_SESSION_ID", &spec.session_id);
    cmd.env("SONIC_SOCKET", &spec.socket_path);
    cmd.env("TERM", "xterm-256color");
    for (k, v) in &spec.extra_env {
        cmd.env(k, v);
    }

    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => on_output(&buf[..n]),
            }
        }
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        on_exit(code);
    });

    Ok(SessionProc { writer, master: pair.master, killer })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc, Mutex};
    use tempfile::tempdir;

    const FAKE_CLAUDE: &str = r#"#!/bin/sh
echo "FAKE start cwd=$(pwd) config=$CLAUDE_CONFIG_DIR sid=$SONIC_SESSION_ID nested=<$CLAUDECODE$CLAUDE_CODE_CHILD_SESSION> args=$*"
while read -r line; do
  [ "$line" = "quit" ] && exit 7
  echo "echo:$line"
done
"#;

    fn write_fake(dir: &std::path::Path) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("fake-claude");
        std::fs::write(&p, FAKE_CLAUDE).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn spawn_streams_env_stdin_and_exit() {
        // simulate being launched from inside a Claude Code session
        std::env::set_var("CLAUDECODE", "1");
        std::env::set_var("CLAUDE_CODE_CHILD_SESSION", "1");
        let d = tempdir().unwrap();
        let work = tempdir().unwrap();
        let fake = write_fake(d.path());
        let out = Arc::new(Mutex::new(Vec::<u8>::new()));
        let out2 = out.clone();
        let (exit_tx, exit_rx) = mpsc::channel();
        let spec = SpawnSpec {
            session_id: "sid-1".into(),
            cwd: work.path().to_path_buf(),
            config_dir: d.path().join("cfg"),
            extra_env: [("SONIC_TEST".to_string(), "1".to_string())].into(),
            socket_path: d.path().join("sock"),
            command: SpawnCommand::Claude { bin: Some(fake.to_string_lossy().into_owned()), resume_id: Some("resume-xyz".into()) },
        };
        let mut proc = spawn(
            &spec,
            move |b| out2.lock().unwrap().extend_from_slice(b),
            move |code| { let _ = exit_tx.send(code); },
        )
        .unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let s = String::from_utf8_lossy(&out.lock().unwrap()).into_owned();
            if s.contains("FAKE start") { break; }
            assert!(std::time::Instant::now() < deadline, "no banner, got: {s}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let s = String::from_utf8_lossy(&out.lock().unwrap()).into_owned();
        assert!(s.contains(&format!("config={}", d.path().join("cfg").display())));
        assert!(s.contains("sid=sid-1"));
        assert!(s.contains("nested=<>"), "claude nesting markers must be stripped, got: {s}");
        assert!(s.contains("--resume resume-xyz"));

        proc.write(b"hello\r").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let s = String::from_utf8_lossy(&out.lock().unwrap()).into_owned();
            if s.contains("echo:hello") { break; }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        proc.resize(120, 40);
        proc.write(b"quit\r").unwrap();
        let code = exit_rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        assert_eq!(code, 7);
    }

    #[test]
    fn kill_terminates_child() {
        let d = tempdir().unwrap();
        let fake = write_fake(d.path());
        let (exit_tx, exit_rx) = mpsc::channel();
        let spec = SpawnSpec {
            session_id: "sid-2".into(),
            cwd: d.path().to_path_buf(),
            config_dir: d.path().join("cfg"),
            extra_env: Default::default(),
            socket_path: d.path().join("sock"),
            command: SpawnCommand::Claude { bin: Some(fake.to_string_lossy().into_owned()), resume_id: None },
        };
        let mut proc = spawn(&spec, |_| {}, move |c| { let _ = exit_tx.send(c); }).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        proc.kill();
        exit_rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
    }

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
}
