// Zwei-Schichten-Gedächtnis, Schicht 1: Tagesnotizen.
//
// memory/YYYY-MM-DD.md sammelt rohe Fakten aus dem Memory-Flush am
// Session-Ende. Beim Session-Start werden heute + gestern mitgeladen.
// Der Konsolidierungs-Job („Dreaming") promotet Wiederkehrendes nach
// MEMORY.md/USER.md und läuft beim App-Start, wenn er fällig ist —
// seinen Zeitstempel hält memory/state.json.

use chrono::{Duration, Local, NaiveDate};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn memory_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent")
        .join("memory");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn note_path(app: &tauri::AppHandle, date: &str) -> Result<PathBuf, String> {
    if NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
        return Err(format!("Ungültiges Datum: {date}"));
    }
    Ok(memory_dir(app)?.join(format!("{date}.md")))
}

/// Hängt extrahierte Fakten an die Tagesnotiz an (Standard: heute).
#[tauri::command]
pub fn memory_note_append(
    app: tauri::AppHandle,
    text: String,
    date: Option<String>,
) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }
    let date = date.unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let path = note_path(&app, &date)?;
    let mut content = if path.exists() {
        fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        format!("# Tagesnotiz {date}\n")
    };
    let stamp = Local::now().format("%H:%M");
    content = format!("{}\n## {stamp}\n{}\n", content.trim_end(), text);
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Liefert die Tagesnotizen der letzten `days` Tage (inkl. heute) als
/// einen zusammenhängenden Text — für die Session-Instructions und den
/// Konsolidierungs-Job.
#[tauri::command]
pub fn memory_notes_recent(app: tauri::AppHandle, days: u32) -> Result<String, String> {
    let dir = memory_dir(&app)?;
    let today = Local::now().date_naive();
    let mut parts = Vec::new();
    for i in (0..days.max(1)).rev() {
        let date = today - Duration::days(i as i64);
        let path = dir.join(format!("{}.md", date.format("%Y-%m-%d")));
        if let Ok(content) = fs::read_to_string(&path) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
    }
    Ok(parts.join("\n\n"))
}

/// Löscht Tagesnotizen, die älter als `keep_days` sind — die Essenz
/// lebt nach der Konsolidierung in MEMORY.md/USER.md weiter.
#[tauri::command]
pub fn memory_notes_cleanup(app: tauri::AppHandle, keep_days: u32) -> Result<u32, String> {
    let dir = memory_dir(&app)?;
    let cutoff = Local::now().date_naive() - Duration::days(keep_days as i64);
    let mut removed = 0;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".md") else {
            continue;
        };
        if let Ok(date) = NaiveDate::parse_from_str(stem, "%Y-%m-%d") {
            if date < cutoff && fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Kleiner Zustandsspeicher (memory/state.json) — z. B. Zeitpunkt der
/// letzten Konsolidierung.
#[tauri::command]
pub fn memory_state_get(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let path = memory_dir(&app)?.join("state.json");
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({})))
}

#[tauri::command]
pub fn memory_state_set(
    app: tauri::AppHandle,
    state: serde_json::Value,
) -> Result<(), String> {
    let path = memory_dir(&app)?.join("state.json");
    let raw = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}
