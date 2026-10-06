mod auth;
mod commands;
mod db;
mod graph;
mod model;
mod secrets;
mod settings;
mod state;
mod sync;
mod theme;

use std::sync::Arc;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMA-BUF renderer misbehaves on some NVIDIA/Wayland setups; let users opt out.
    if std::env::var_os("TERN_NO_DMABUF").is_some() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(url) = args.iter().find(|a| a.starts_with("mailto:")) {
                let _ = app.emit("app://mailto", url.clone());
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let db = db::Db::open()?;
            let st = state::AppState::new(db);
            *st.pending_mailto.lock().unwrap() = std::env::args().find(|a| a.starts_with("mailto:"));
            app.manage(Arc::new(st));
            theme::watch(app.handle().clone());
            sync::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_bootstrap,
            commands::theme_get,
            commands::settings_get,
            commands::settings_set,
            commands::secret_set,
            commands::secret_get,
            commands::accounts_list,
            commands::account_add_microsoft,
            commands::auth_cancel,
            commands::account_remove,
            commands::account_update,
            commands::folders_list,
            commands::messages_list,
            commands::message_get,
            commands::thread_get,
            commands::messages_set_read,
            commands::messages_set_flag,
            commands::messages_move,
            commands::messages_delete,
            commands::message_send,
            commands::attachment_save,
            commands::sync_now,
            commands::contacts_suggest,
            commands::annotations_set,
            commands::messages_untriaged,
            commands::take_pending_mailto,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tern");
}
