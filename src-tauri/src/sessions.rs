use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::{collections::HashMap, io::{self, Read, Write}, path::PathBuf};

pub struct SpawnSpec {
    pub session_id: String,
    pub cwd: PathBuf,
    pub config_dir: PathBuf,
    pub extra_env: HashMap<String, String>,
    pub socket_path: PathBuf,
    pub claude_bin: Option<String>,
    pub resume_id: Option<String>,
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

    let bin = spec.claude_bin.clone().unwrap_or_else(|| "claude".into());
    let mut shell_cmd = format!("exec {}", shell_quote(&bin));
    if let Some(rid) = &spec.resume_id {
        shell_cmd.push_str(&format!(" --resume {}", shell_quote(rid)));
    }

    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.args(["-lc", &shell_cmd]);
    cmd.cwd(&spec.cwd);
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
echo "FAKE start cwd=$(pwd) config=$CLAUDE_CONFIG_DIR sid=$SONIC_SESSION_ID args=$*"
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
            claude_bin: Some(fake.to_string_lossy().into_owned()),
            resume_id: Some("resume-xyz".into()),
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
            claude_bin: Some(fake.to_string_lossy().into_owned()),
            resume_id: None,
        };
        let mut proc = spawn(&spec, |_| {}, move |c| { let _ = exit_tx.send(c); }).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        proc.kill();
        exit_rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
    }
}
