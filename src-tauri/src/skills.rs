// Skill-System (agentskills-Format, Progressive Disclosure).
//
// Skills sind Markdown-Dateien unter agent/skills/<name>.md mit YAML-
// Frontmatter (name + description). Nur Name + Beschreibung wandern in
// die Session-Instructions (~1 Zeile pro Skill); den Body liest Otto
// per read_skill erst, wenn er den Skill wirklich braucht.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn write_private(path: &std::path::Path, content: impl AsRef<[u8]>) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn skills_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent")
        .join("skills");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// Mitgelieferte Grundfähigkeiten (Mac-Steuerung über Bordmittel).
// Wie die Agent-Dateien: nur geseedet, wenn die Datei fehlt — vom Nutzer
// bearbeitete oder gelöschte Skills werden nie überschrieben. Gelöschte
// bleiben gelöscht, weil delete_skill eine leere Tombstone-Datei NICHT
// hinterlässt — bewusst simpel: Wer einen Default-Skill löscht, bekommt
// ihn beim nächsten Start wieder; dauerhaft loswerden = Inhalt ersetzen.
const DEFAULT_SKILLS: &[(&str, &str)] = &[
    (
        "mac-kalender-erinnerungen",
        include_str!("../defaults/skills/mac-kalender-erinnerungen.md"),
    ),
    ("mac-musik", include_str!("../defaults/skills/mac-musik.md")),
    (
        "mac-dateisuche",
        include_str!("../defaults/skills/mac-dateisuche.md"),
    ),
    (
        "mac-mail-notizen",
        include_str!("../defaults/skills/mac-mail-notizen.md"),
    ),
    (
        "mac-shortcuts",
        include_str!("../defaults/skills/mac-shortcuts.md"),
    ),
];

/// Beim App-Start aufrufen: fehlende Default-Skills anlegen.
pub fn seed_default_skills(app: &tauri::AppHandle) {
    let Ok(dir) = skills_dir(app) else { return };
    for (name, content) in DEFAULT_SKILLS {
        let path = dir.join(format!("{name}.md"));
        if !path.exists() {
            let _ = write_private(&path, content);
        }
    }
}

fn validate_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err("Ungültiger Skill-Name (nur kleinbuchstaben, ziffern, bindestriche).".into())
    }
}

/// Zieht `description:` aus dem YAML-Frontmatter; Fallback: erste
/// Textzeile des Bodys.
fn extract_description(content: &str) -> String {
    let mut in_frontmatter = false;
    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if i == 0 && trimmed == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if trimmed == "---" {
                in_frontmatter = false;
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("description:") {
                return rest.trim().trim_matches('"').to_string();
            }
            continue;
        }
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            return trimmed.chars().take(140).collect();
        }
    }
    String::new()
}

#[derive(Serialize)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
}

#[tauri::command]
pub fn skills_list(app: tauri::AppHandle) -> Result<Vec<SkillInfo>, String> {
    let dir = skills_dir(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let Some(name) = file.strip_suffix(".md") else {
            continue;
        };
        let content = fs::read_to_string(entry.path()).unwrap_or_default();
        out.push(SkillInfo {
            name: name.to_string(),
            description: extract_description(&content),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn skill_read(app: tauri::AppHandle, name: String) -> Result<String, String> {
    validate_name(&name)?;
    let path = skills_dir(&app)?.join(format!("{name}.md"));
    fs::read_to_string(&path).map_err(|_| format!("Skill „{name}“ existiert nicht."))
}

#[tauri::command]
pub fn skill_write(app: tauri::AppHandle, name: String, content: String) -> Result<(), String> {
    validate_name(&name)?;
    if content.trim().is_empty() {
        return Err("Leerer Skill-Inhalt.".into());
    }
    if content.len() > 20_000 {
        return Err("Skill zu lang (max. 20 000 Zeichen) — kürze auf das Wesentliche.".into());
    }
    let path = skills_dir(&app)?.join(format!("{name}.md"));
    write_private(&path, content)
}

#[tauri::command]
pub fn skill_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    validate_name(&name)?;
    let path = skills_dir(&app)?.join(format!("{name}.md"));
    fs::remove_file(&path).map_err(|_| format!("Skill „{name}“ existiert nicht."))
}
