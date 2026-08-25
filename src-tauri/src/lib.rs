pub mod commands;
pub mod hooks;
pub mod profiles;
pub mod sessions;
pub mod state_store;
pub mod status;
pub mod updater;

use commands::AppCtx;
use std::{collections::HashMap, sync::Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let base = app.path().app_data_dir()?;
            std::fs::create_dir_all(&base)?;
            let socket = base.join("sonic.sock");

            let mut state = state_store::load(&base);
            let restorable = std::mem::take(&mut state.sessions);
            let auto_restore = std::mem::take(&mut state.restore_all_on_launch);

            app.manage(AppCtx {
                base: base.clone(),
                socket: socket.clone(),
                state: Mutex::new(state),
                registry: Mutex::new(profiles::ProfileRegistry::load(&base)),
                procs: Mutex::new(HashMap::new()),
                statuses: Mutex::new(HashMap::new()),
                restorable: Mutex::new(restorable),
                auto_restore: Mutex::new(auto_restore),
                session_bins: Mutex::new(HashMap::new()),
            });

            let handle = app.handle().clone();
            status::start_listener(socket, move |ev| {
                commands::handle_status_event(&handle, ev);
            })?;

            let new_s = MenuItemBuilder::with_id("new-session", "New Session")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let close_s = MenuItemBuilder::with_id("close-session", "Close Session")
                .accelerator("CmdOrCtrl+W")
                .build(app)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Sonic")
                .item(&settings)
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let session_menu = SubmenuBuilder::new(app, "Session")
                .item(&new_s)
                .item(&close_s)
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &session_menu])
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, ev| {
                let _ = app.emit("menu", ev.id().0.clone());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::create_profile,
            commands::import_profile,
            commands::update_profile,
            commands::delete_profile,
            commands::list_sessions,
            commands::start_session,
            commands::write_stdin,
            commands::resize_session,
            commands::rename_session,
            commands::close_session,
            commands::recent_folders,
            commands::previous_sessions,
            commands::discard_previous,
            commands::get_settings,
            commands::set_settings,
            commands::check_claude,
            commands::reveal_in_finder,
            commands::copy_text,
            commands::open_url,
            commands::set_badge,
            commands::auto_restore,
            commands::check_claude_update,
            commands::update_claude,
            commands::check_sonic_update,
            commands::update_sonic,
            commands::restart_with_sessions
        ])
        .build(tauri::generate_context!())
        .expect("error building sonic")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let ctx = app.state::<AppCtx>();
                for (_, p) in ctx.procs.lock().unwrap().iter_mut() {
                    p.kill();
                }
            }
        });
}
