mod agent_files;
mod cli;
mod computer_use;
mod context;
mod diagnostics;
mod fs_util;
mod images;
mod logging;
mod memory;
mod native;
mod search;
mod settings;
mod shell_safety;
mod sessions;
mod skills;
mod terminal;
mod tray;
mod wake;
mod window_effects;

use tauri::Manager;

/// Sauberes App-Ende: Das Frontend ruft dies NACH Disconnect + Memory-Flush
/// auf (Tray-Quit sendet erst "app-quit" und wartet). Laufende Job-
/// Prozessgruppen werden mitgenommen, damit keine Waisen überleben.
#[tauri::command]
fn app_exit(app: tauri::AppHandle) {
    cli::kill_all_jobs();
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Panics landen in /tmp/otto-crash.log, damit Abstürze nachvollziehbar sind.
    std::panic::set_hook(Box::new(|info| {
        logging::crash_log(&format!("PANIC: {info}"));
        eprintln!("PANIC: {info}");
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // Menüleisten-App: kein Dock-Icon, Präsenz nur oben rechts.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tray::setup(app.handle())?;
            // Mitgelieferte Mac-Steuerungs-Skills anlegen (nur wenn fehlend).
            skills::seed_default_skills(app.handle());
            // App-Identität & TCC-Vorprüfung protokollieren — macht spätere
            // Freigabe-Probleme (Translocation, Dev-Binary) nachvollziehbar.
            diagnostics::log_startup(app.handle());
            // Einstellungsfenster: Sidebar-Vibrancy über die ganze Fläche —
            // die Seitenleiste bleibt im CSS transparent (echtes Glas), der
            // Inhaltsbereich bekommt eine solide Fläche darüber.
            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("settings") {
                let _ = window_vibrancy::apply_vibrancy(
                    &win,
                    window_vibrancy::NSVisualEffectMaterial::Sidebar,
                    None,
                    None,
                );
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Der rote Schließen-Knopf des Einstellungsfensters versteckt es
            // nur — zerstören würde spätere getByLabel-Aufrufe brechen.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "settings" {
                    api.prevent_close();
                    let _ = window.hide();
                    #[cfg(target_os = "macos")]
                    let _ = window.app_handle().set_dock_visibility(false);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            agent_files::list_agent_files,
            agent_files::read_agent_file,
            agent_files::write_agent_file,
            agent_files::agent_dir_path,
            search::brave_search,
            diagnostics::app_diagnostics,
            diagnostics::request_accessibility,
            terminal::run_terminal,
            window_effects::panel_vibrancy,
            logging::log_line,
            native::top_inset,
            native::dblcmd_start,
            native::dblcmd_stop,
            native::hot_corner_start,
            native::hot_corner_stop,
            context::screen_context,
            context::clipboard_image,
            context::file_read_b64,
            cli::cli_job_start,
            cli::cli_job_result,
            cli::codex_image_job_start,
            cli::cli_job_cancel,
            cli::cli_available,
            computer_use::codex_computer_use_status,
            computer_use::codex_computer_use_call,
            wake::wake_word_start,
            wake::wake_word_stop,
            sessions::session_start,
            sessions::session_append,
            sessions::session_end,
            sessions::sessions_search,
            sessions::sessions_unprocessed,
            sessions::session_mark_processed,
            sessions::sessions_cleanup,
            memory::memory_note_append,
            memory::memory_notes_recent,
            memory::memory_notes_cleanup,
            memory::memory_state_get,
            memory::memory_state_set,
            skills::skills_list,
            skills::skill_read,
            skills::skill_write,
            skills::skill_delete,
            images::images_list,
            images::image_folders_list,
            images::image_folder_create,
            images::image_set_folder,
            images::image_store,
            images::image_read_b64,
            images::image_delete,
            images::image_rename,
            images::image_favorite,
            images::image_export,
            images::image_import,
            app_exit
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // Nicht beenden, nur weil (z. B. während Computer Use) kein
            // Fenster sichtbar ist oder das Hauptfenster geschlossen wurde.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                if code.is_none() {
                    logging::crash_log("ExitRequested ohne Code — verhindert (Fenster zu?)");
                    api.prevent_exit();
                }
            }
        });
}
