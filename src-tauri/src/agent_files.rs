use std::fs;
use std::path::PathBuf;
use tauri::Manager;

use crate::fs_util::write_private;

const DEFAULT_FILES: &[(&str, &str)] = &[
    ("SOUL.md", include_str!("../defaults/SOUL.md")),
    ("USER.md", include_str!("../defaults/USER.md")),
    ("MEMORY.md", include_str!("../defaults/MEMORY.md")),
    ("STYLE.css", include_str!("../defaults/STYLE.css")),
];

fn agent_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, content) in DEFAULT_FILES {
        let path = dir.join(name);
        if !path.exists() {
            write_private(&path, content)?;
        }
    }
    Ok(dir)
}

fn validate_name(name: &str) -> Result<(), String> {
    let ok = (name.ends_with(".md") || name.ends_with(".css"))
        && name != "TOOLS.md"
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name.len() > 3;
    if ok {
        Ok(())
    } else {
        Err(
            "Ungültiger Dateiname (nur einfache .md- oder .css-Dateien erlaubt; TOOLS.md ist intern)."
                .into(),
        )
    }
}

#[tauri::command]
pub fn list_agent_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = agent_dir(&app)?;
    let mut names: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n != "TOOLS.md" && (n.ends_with(".md") || n.ends_with(".css")))
        .collect();
    let order = ["SOUL.md", "USER.md", "MEMORY.md", "STYLE.css"];
    names.sort_by_key(|n| {
        let rank = order.iter().position(|o| o == n).unwrap_or(usize::MAX);
        (rank, n.clone())
    });
    Ok(names)
}

#[tauri::command]
pub fn read_agent_file(app: tauri::AppHandle, name: String) -> Result<String, String> {
    validate_name(&name)?;
    let path = agent_dir(&app)?.join(&name);
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_agent_file(
    app: tauri::AppHandle,
    name: String,
    content: String,
) -> Result<(), String> {
    validate_name(&name)?;
    let path = agent_dir(&app)?.join(&name);
    write_private(&path, content)
}

#[tauri::command]
pub fn agent_dir_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(agent_dir(&app)?.to_string_lossy().into_owned())
}
