use std::{io::Read, path::PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct StatusEvent {
    pub sonic_session: String,
    pub state: String,
    pub claude_session_id: Option<String>,
}

pub fn parse_status_event(bytes: &[u8]) -> Option<StatusEvent> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    Some(StatusEvent {
        sonic_session: v["sonic_session"].as_str()?.to_string(),
        state: v["state"].as_str()?.to_string(),
        claude_session_id: v["hook"]["session_id"].as_str().map(str::to_string),
    })
}

pub fn start_listener(
    socket_path: PathBuf,
    on_event: impl Fn(StatusEvent) + Send + 'static,
) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(&socket_path);
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = std::os::unix::net::UnixListener::bind(&socket_path)?;
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let mut buf = Vec::new();
            if s.read_to_end(&mut buf).is_ok() {
                if let Some(ev) = parse_status_event(&buf) {
                    on_event(ev);
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use tempfile::tempdir;

    #[test]
    fn parse_extracts_fields() {
        let ev = parse_status_event(
            br#"{"sonic_session":"s1","state":"working","hook":{"session_id":"cc-42","other":1}}"#,
        )
        .unwrap();
        assert_eq!(ev.sonic_session, "s1");
        assert_eq!(ev.state, "working");
        assert_eq!(ev.claude_session_id.as_deref(), Some("cc-42"));
    }

    #[test]
    fn parse_garbage_is_none() {
        assert!(parse_status_event(b"not json").is_none());
        assert!(parse_status_event(br#"{"state":"idle"}"#).is_none());
    }

    #[test]
    fn listener_receives_via_unix_socket() {
        let d = tempdir().unwrap();
        let sock = d.path().join("s.sock");
        let (tx, rx) = mpsc::channel();
        start_listener(sock.clone(), move |ev| { let _ = tx.send(ev); }).unwrap();
        use std::io::Write;
        let mut c = std::os::unix::net::UnixStream::connect(&sock).unwrap();
        c.write_all(br#"{"sonic_session":"s9","state":"waiting","hook":{}}"#).unwrap();
        drop(c);
        let ev = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!((ev.sonic_session.as_str(), ev.state.as_str()), ("s9", "waiting"));
        assert_eq!(ev.claude_session_id, None);
    }

    #[test]
    fn hook_script_end_to_end() {
        let d = tempdir().unwrap();
        let script = crate::hooks::write_hook_script(d.path()).unwrap();
        let sock = d.path().join("s.sock");
        let (tx, rx) = mpsc::channel();
        start_listener(sock.clone(), move |ev| { let _ = tx.send(ev); }).unwrap();
        let status = std::process::Command::new("/bin/sh")
            .arg(script)
            .arg("working")
            .env("SONIC_SESSION_ID", "e2e-1")
            .env("SONIC_SOCKET", &sock)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut ch| {
                use std::io::Write;
                ch.stdin.take().unwrap().write_all(br#"{"session_id":"cc-7"}"#)?;
                ch.wait()
            })
            .unwrap();
        assert!(status.success());
        let ev = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(ev.sonic_session, "e2e-1");
        assert_eq!(ev.state, "working");
        assert_eq!(ev.claude_session_id.as_deref(), Some("cc-7"));
    }

    #[test]
    fn hook_script_noops_without_session_id() {
        let d = tempdir().unwrap();
        let script = crate::hooks::write_hook_script(d.path()).unwrap();
        let out = std::process::Command::new("/bin/sh")
            .arg(script)
            .arg("working")
            .env_remove("SONIC_SESSION_ID")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(out.stdout.is_empty());
    }
}
