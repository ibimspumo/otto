use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

use crate::fs_util::write_private;

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
    pub terminal_enabled: bool,
    pub wake_word_enabled: bool,
    pub wake_word_phrase: String,
    pub hotkey_enabled: bool,
    pub hotkey: String,
    pub cli_enabled: bool,
    pub cli_default: String,
    pub cli_notes: String,
    /// „YOLO-Modus": hebt ALLE Sicherheitsschranken für Terminal und
    /// Delegation auf — `run_terminal`/`shell` laufen ohne Befehls-Filter,
    /// Codex mit `danger-full-access`, Claude mit
    /// `--dangerously-skip-permissions`. Voller Systemzugriff als der
    /// angemeldete Nutzer (kein Root ohne sudo-Passwort). Bewusst opt-in.
    pub yolo_mode: bool,
    pub memory_enabled: bool,
    pub memory_model: String,
    pub session_retention_days: u32,
    /// VAD-Schwelle (0.5–0.95): höher = unempfindlicher gegen
    /// Hintergrundgeräusche (Fernseher, Ventilator).
    pub vad_threshold: f32,
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
            terminal_enabled: true,
            wake_word_enabled: false,
            wake_word_phrase: "Hey Otto".into(),
            hotkey_enabled: true,
            hotkey: "2x Cmd".into(),
            cli_enabled: true,
            cli_default: "codex".into(),
            cli_notes: String::new(),
            yolo_mode: false,
            memory_enabled: true,
            memory_model: "gpt-5-mini".into(),
            session_retention_days: 30,
            vad_threshold: 0.85,
        }
    }
}

fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// Liest allein das `yolo_mode`-Flag aus settings.json (ohne Keychain-
/// Nebenwirkungen). Einzige Wahrheitsquelle für den Bypass der Terminal-/
/// Delegations-Schranken — so kann kein Frontend-Bug den YOLO-Modus
/// aktivieren, ohne dass er wirklich gespeichert wurde. Fehlt die Datei
/// oder das Feld, gilt `false`.
pub fn yolo_enabled(app: &tauri::AppHandle) -> bool {
    config_file(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .map(|s| s.yolo_mode)
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn keychain_service(field: &str) -> String {
    format!("de.agentz.otto.{field}")
}

#[cfg(target_os = "macos")]
fn keychain_get(field: &str) -> Option<String> {
    let service = keychain_service(field);
    let out = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            "otto",
            "-s",
            &service,
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim_end().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(not(target_os = "macos"))]
fn keychain_get(_field: &str) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn keychain_set(field: &str, value: &str) -> Result<(), String> {
    let service = keychain_service(field);
    let status = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-a",
            "otto",
            "-s",
            &service,
            "-w",
            value,
            "-U",
        ])
        .status()
        .map_err(|e| format!("Keychain nicht verfügbar: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Key konnte nicht in der macOS-Keychain gespeichert werden.".into())
    }
}

#[cfg(not(target_os = "macos"))]
fn keychain_set(_field: &str, _value: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn keychain_delete(field: &str) {
    let service = keychain_service(field);
    let _ = std::process::Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            "otto",
            "-s",
            &service,
        ])
        .status();
}

#[cfg(not(target_os = "macos"))]
fn keychain_delete(_field: &str) {}

fn sanitize_settings_for_disk(settings: &Settings) -> Settings {
    let mut disk = settings.clone();
    #[cfg(target_os = "macos")]
    {
        disk.openai_api_key.clear();
        disk.brave_api_key.clear();
        disk.openrouter_api_key.clear();
    }
    disk
}

fn normalize_settings(settings: &mut Settings) {
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
    if settings.wake_word_phrase.trim().is_empty() {
        settings.wake_word_phrase = "Hey Otto".into();
    }
    if settings.hotkey.trim().is_empty() {
        settings.hotkey = "2x Cmd".into();
    }
    if settings.cli_default.trim().is_empty() {
        settings.cli_default = "codex".into();
    }
    if settings.memory_model.trim().is_empty() {
        settings.memory_model = "gpt-5-mini".into();
    }
    if settings.session_retention_days == 0 {
        settings.session_retention_days = 30;
    }
    if !(0.3..=0.99).contains(&settings.vad_threshold) {
        settings.vad_threshold = 0.85;
    }
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    let path = config_file(&app)?;
    let mut migrated_keys = false;
    let mut settings = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str::<Settings>(&raw).unwrap_or_default()
    } else {
        Settings::default()
    };
    #[cfg(target_os = "macos")]
    {
        if settings.openai_api_key.trim().is_empty() {
            settings.openai_api_key = keychain_get("openai_api_key").unwrap_or_default();
        } else {
            keychain_set("openai_api_key", settings.openai_api_key.trim())?;
            migrated_keys = true;
        }
        if settings.brave_api_key.trim().is_empty() {
            settings.brave_api_key = keychain_get("brave_api_key").unwrap_or_default();
        } else {
            keychain_set("brave_api_key", settings.brave_api_key.trim())?;
            migrated_keys = true;
        }
        if settings.openrouter_api_key.trim().is_empty() {
            settings.openrouter_api_key = keychain_get("openrouter_api_key").unwrap_or_default();
        } else {
            keychain_set("openrouter_api_key", settings.openrouter_api_key.trim())?;
            migrated_keys = true;
        }
    }
    normalize_settings(&mut settings);
    if migrated_keys {
        let disk = sanitize_settings_for_disk(&settings);
        let raw = serde_json::to_string_pretty(&disk).map_err(|e| e.to_string())?;
        write_private(&path, raw)?;
    }
    Ok(settings)
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    let path = config_file(&app)?;
    if settings.openai_api_key.trim().is_empty() {
        keychain_delete("openai_api_key");
    } else {
        keychain_set("openai_api_key", settings.openai_api_key.trim())?;
    }
    if settings.brave_api_key.trim().is_empty() {
        keychain_delete("brave_api_key");
    } else {
        keychain_set("brave_api_key", settings.brave_api_key.trim())?;
    }
    if settings.openrouter_api_key.trim().is_empty() {
        keychain_delete("openrouter_api_key");
    } else {
        keychain_set("openrouter_api_key", settings.openrouter_api_key.trim())?;
    }
    let disk = sanitize_settings_for_disk(&settings);
    let raw = serde_json::to_string_pretty(&disk).map_err(|e| e.to_string())?;
    write_private(&path, raw)
}
