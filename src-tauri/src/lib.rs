mod computer_use;
mod images;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub openai_api_key: String,
    pub brave_api_key: String,
    pub openrouter_api_key: String,
    pub model: String,
    pub voice: String,
    pub reasoning_effort: String,
    pub image_model: String,
    pub computer_model: String,
    pub computer_use_enabled: bool,
    pub terminal_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            openai_api_key: String::new(),
            brave_api_key: String::new(),
            openrouter_api_key: String::new(),
            model: String::new(),
            voice: String::new(),
            reasoning_effort: String::new(),
            image_model: String::new(),
            computer_model: String::new(),
            computer_use_enabled: true,
            terminal_enabled: true,
        }
    }
}

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    let path = config_file(&app)?;
    let mut settings = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<Settings>(&raw).unwrap_or_default()
    } else {
        Settings::default()
    };
    // "gpt-realtime" war der Seed-Default von v0.1.0 — auf Realtime 2 anheben.
    if settings.model.trim().is_empty() || settings.model.trim() == "gpt-realtime" {
        settings.model = "gpt-realtime-2".into();
    }
    if settings.voice.trim().is_empty() {
        settings.voice = "marin".into();
    }
    if settings.reasoning_effort.trim().is_empty() {
        settings.reasoning_effort = "low".into();
    }
    if settings.image_model.trim().is_empty() {
        settings.image_model = "gpt-image-2".into();
    }
    if settings.computer_model.trim().is_empty() {
        settings.computer_model = "gpt-5.5".into();
    }
    Ok(settings)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let path = config_file(&app)?;
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Agent-Dateien (SOUL.md & Co.)
// ---------------------------------------------------------------------------

const DEFAULT_FILES: &[(&str, &str)] = &[
    ("SOUL.md", include_str!("../defaults/SOUL.md")),
    ("USER.md", include_str!("../defaults/USER.md")),
    ("MEMORY.md", include_str!("../defaults/MEMORY.md")),
    ("TOOLS.md", include_str!("../defaults/TOOLS.md")),
    ("STYLE.css", include_str!("../defaults/STYLE.css")),
];

fn agent_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Fehlende Standard-Dateien anlegen, vorhandene nie überschreiben.
    for (name, content) in DEFAULT_FILES {
        let path = dir.join(name);
        if !path.exists() {
            fs::write(&path, content).map_err(|e| e.to_string())?;
        }
    }
    Ok(dir)
}

fn validate_name(name: &str) -> Result<(), String> {
    let ok = (name.ends_with(".md") || name.ends_with(".css"))
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name.len() > 3;
    if ok {
        Ok(())
    } else {
        Err("Ungültiger Dateiname (nur einfache .md- oder .css-Dateien erlaubt).".into())
    }
}

#[tauri::command]
fn list_agent_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = agent_dir(&app)?;
    let mut names: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".md") || n.ends_with(".css"))
        .collect();
    // Bekannte Dateien zuerst, Rest alphabetisch.
    let order = ["SOUL.md", "USER.md", "MEMORY.md", "TOOLS.md", "STYLE.css"];
    names.sort_by_key(|n| {
        let rank = order.iter().position(|o| o == n).unwrap_or(usize::MAX);
        (rank, n.clone())
    });
    Ok(names)
}

#[tauri::command]
fn read_agent_file(app: tauri::AppHandle, name: String) -> Result<String, String> {
    validate_name(&name)?;
    let path = agent_dir(&app)?.join(&name);
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_agent_file(app: tauri::AppHandle, name: String, content: String) -> Result<(), String> {
    validate_name(&name)?;
    let path = agent_dir(&app)?.join(&name);
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn agent_dir_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(agent_dir(&app)?.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Brave Search
// ---------------------------------------------------------------------------

fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for c in input.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

#[tauri::command]
async fn brave_search(
    query: String,
    api_key: String,
    count: Option<u32>,
) -> Result<serde_json::Value, String> {
    if api_key.trim().is_empty() {
        return Err("Kein Brave-API-Key hinterlegt.".into());
    }
    let count = count.unwrap_or(6).clamp(1, 20);
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.search.brave.com/res/v1/web/search")
        .query(&[("q", query.as_str()), ("count", &count.to_string())])
        .header("X-Subscription-Token", api_key.trim())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Netzwerkfehler: {e}"))?;

    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Ungültige Antwort der Brave API: {e}"))?;

    if !status.is_success() {
        let detail = body
            .pointer("/error/detail")
            .and_then(|v| v.as_str())
            .unwrap_or("unbekannter Fehler");
        return Err(format!("Brave API {status}: {detail}"));
    }

    let mut results = Vec::new();
    if let Some(items) = body.pointer("/web/results").and_then(|v| v.as_array()) {
        for r in items.iter().take(count as usize) {
            let get = |p: &str| r.pointer(p).and_then(|v| v.as_str()).unwrap_or("");
            results.push(serde_json::json!({
                "title": strip_tags(get("/title")),
                "url": get("/url"),
                "description": strip_tags(get("/description")),
                "age": r.pointer("/age").and_then(|v| v.as_str()),
                "host": r.pointer("/meta_url/hostname").and_then(|v| v.as_str()),
            }));
        }
    }
    Ok(serde_json::json!({ "query": query, "results": results }))
}

fn crash_log(msg: &str) {
    let path = std::env::temp_dir().join("otto-crash.log");
    let line = format!("[{:?}] {msg}\n", std::time::SystemTime::now());
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

// ---------------------------------------------------------------------------
// Terminal-Befehle (für Otto: Apps starten/steuern, schnelle Systemaufgaben)
// ---------------------------------------------------------------------------

fn truncate_output(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…\n[gekürzt, {} Zeichen insgesamt]", &s[..max], s.len())
    }
}

#[tauri::command]
async fn run_terminal(
    command: String,
    timeout_s: Option<u64>,
) -> Result<serde_json::Value, String> {
    let timeout = std::time::Duration::from_secs(timeout_s.unwrap_or(30).clamp(1, 300));
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = std::process::Command::new("/bin/zsh")
            .args(["-lc", &command])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Start fehlgeschlagen: {e}"))?;

        let deadline = std::time::Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!(
                            "Timeout nach {} s — Befehl abgebrochen.",
                            timeout.as_secs()
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        let output = child
            .wait_with_output()
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "exit_code": output.status.code(),
            "stdout": truncate_output(&String::from_utf8_lossy(&output.stdout), 8000),
            "stderr": truncate_output(&String::from_utf8_lossy(&output.stderr), 4000),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Panics landen in /tmp/otto-crash.log, damit Abstürze nachvollziehbar sind.
    std::panic::set_hook(Box::new(|info| {
        crash_log(&format!("PANIC: {info}"));
        eprintln!("PANIC: {info}");
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            list_agent_files,
            read_agent_file,
            write_agent_file,
            agent_dir_path,
            brave_search,
            computer_use::run_computer_use,
            computer_use::cu_permissions,
            computer_use::cu_cancel,
            run_terminal,
            images::images_list,
            images::image_store,
            images::image_read_b64,
            images::image_delete,
            images::image_rename,
            images::image_favorite,
            images::image_export,
            images::image_import
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // Nicht beenden, nur weil (z. B. während Computer Use) kein
            // Fenster sichtbar ist oder das Hauptfenster geschlossen wurde.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                if code.is_none() {
                    crash_log("ExitRequested ohne Code — verhindert (Fenster zu?)");
                    api.prevent_exit();
                }
            }
        });
}
