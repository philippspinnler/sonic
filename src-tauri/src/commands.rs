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
        match state.projects.iter_mut().find(|p| p.id == project_id) {
            Some(p) => p.terminals.push(term),
            None => {
                drop(state);
                kill_terminal(&ctx, &terminal_id);
                return Err("unknown project".into());
            }
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

#[tauri::command]
pub fn get_settings(ctx: State<AppCtx>) -> AppSettings {
    ctx.state.lock().unwrap().settings.clone()
}

#[tauri::command]
pub fn set_settings(ctx: State<AppCtx>, settings: AppSettings) {
    let mut state = ctx.state.lock().unwrap();
    state.settings = settings;
    let _ = state_store::save(&ctx.base, &state);
}

#[tauri::command]
pub fn check_claude(ctx: State<AppCtx>) -> Option<String> {
    claude_bin_path(&ctx)
}

fn claude_bin_path(ctx: &AppCtx) -> Option<String> {
    if let Some(bin) = &ctx.state.lock().unwrap().settings.claude_bin {
        return Some(bin.clone());
    }
    let out = std::process::Command::new("/bin/zsh")
        .args(["-lc", "command -v claude"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open").arg(&path).status().map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) links can be opened".into());
    }
    std::process::Command::new("open").arg(&url).status().map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    use std::io::Write;
    let mut child = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(err)?;
    child.stdin.take().ok_or("no stdin")?.write_all(text.as_bytes()).map_err(err)?;
    child.wait().map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn set_badge(app: AppHandle, count: i64) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(if count > 0 { Some(count) } else { None });
    }
}

#[tauri::command]
pub fn auto_restore(ctx: State<AppCtx>) -> bool {
    std::mem::take(&mut *ctx.auto_restore.lock().unwrap())
}

#[tauri::command]
pub async fn check_claude_update(app: AppHandle) -> updater::UpdateInfo {
    let (bins, claude_bin) = {
        let ctx = app.state::<AppCtx>();
        let procs = ctx.procs.lock().unwrap();
        let bins: Vec<PathBuf> = ctx.session_bins.lock().unwrap().iter()
            .filter(|(id, _)| procs.contains_key(*id))
            .map(|(_, b)| b.clone())
            .collect();
        (bins, claude_bin_path(&ctx))
    };
    let Some(claude_bin) = claude_bin else { return updater::UpdateInfo::default() };
    tauri::async_runtime::spawn_blocking(move || updater::check(&bins, &claude_bin))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn check_sonic_update() -> Option<String> {
    tauri::async_runtime::spawn_blocking(updater::check_sonic).await.ok().flatten()
}

#[tauri::command]
pub async fn update_sonic() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(updater::upgrade_sonic).await.map_err(err)?
}

#[tauri::command]
pub async fn update_claude() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(updater::upgrade).await.map_err(err)?
}

/// Persist running sessions with a restore-all flag, then relaunch Sonic.
#[tauri::command]
pub fn restart_with_sessions(app: AppHandle, ctx: State<AppCtx>) -> Result<(), String> {
    {
        let mut state = ctx.state.lock().unwrap();
        state.restore_all_on_launch = true;
        state_store::save(&ctx.base, &state).map_err(err)?;
    }
    for (_, p) in ctx.procs.lock().unwrap().iter_mut() {
        p.kill();
    }
    app.restart();
}
