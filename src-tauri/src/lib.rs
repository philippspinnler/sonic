pub mod hooks;
pub mod profiles;
pub mod sessions;
pub mod state_store;
pub mod status;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running sonic");
}
