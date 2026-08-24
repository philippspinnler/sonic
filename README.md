# Sonic

One window for all your Claude Code identities. Sessions in a sidebar with
live status (idle / working / waiting), isolated profiles per account or
client (own `CLAUDE_CONFIG_DIR`, own MCPs), Cmd+N to start a session in any
profile + folder.

## Dev

    npm install
    npm run tauri dev

Tests: `cargo test --manifest-path src-tauri/Cargo.toml` and `npm test`.

## How status works

Sonic merges three hooks (UserPromptSubmit/Notification/Stop) into each
profile's `settings.json` (original backed up as `settings.json.sonic-backup`).
The hook script no-ops unless the session was started by Sonic, so using a
profile from a plain terminal keeps working unchanged.

## Shortcuts

- `Cmd+N` new session (profile → folder)
- `Cmd+W` close selected session
- `Cmd+1..9` jump to session
- `Cmd+,` settings (profiles, claude binary, notifications)

Design: docs/superpowers/specs/2026-08-24-sonic-design.md
