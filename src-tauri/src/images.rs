//! Persistenter Bildspeicher für generierte Bilder: PNG-Dateien plus
//! index.json (Reihenfolge = Galerie-Nummerierung) im App-Datenverzeichnis.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct ImageMeta {
    pub id: String,
    pub file: String,
    pub name: String,
    pub prompt: String,
    pub created_ms: u64,
    pub favorite: bool,
    pub transparent: bool,
    pub size: String,
    /// Absoluter Pfad — wird beim Listen berechnet, nicht gespeichert.
    pub path: String,
}

impl Default for ImageMeta {
    fn default() -> Self {
        ImageMeta {
            id: String::new(),
            file: String::new(),
            name: String::new(),
            prompt: String::new(),
            created_ms: 0,
            favorite: false,
            transparent: false,
            size: String::new(),
            path: String::new(),
        }
    }
}

fn images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("images");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn load_index(dir: &PathBuf) -> Vec<ImageMeta> {
    let path = dir.join("index.json");
    if !path.exists() {
        return Vec::new();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_index(dir: &PathBuf, index: &[ImageMeta]) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    fs::write(dir.join("index.json"), raw).map_err(|e| e.to_string())
}

fn with_paths(dir: &PathBuf, mut index: Vec<ImageMeta>) -> Vec<ImageMeta> {
    for m in &mut index {
        m.path = dir.join(&m.file).to_string_lossy().into_owned();
    }
    index
}

#[tauri::command]
pub fn images_list(app: tauri::AppHandle) -> Result<Vec<ImageMeta>, String> {
    let dir = images_dir(&app)?;
    Ok(with_paths(&dir, load_index(&dir)))
}

fn store_bytes(
    app: &tauri::AppHandle,
    id: &str,
    name: &str,
    prompt: &str,
    bytes: &[u8],
    transparent: bool,
    size: &str,
) -> Result<ImageMeta, String> {
    let dir = images_dir(app)?;
    let file = format!("{id}.png");
    fs::write(dir.join(&file), bytes).map_err(|e| e.to_string())?;

    let created_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let meta = ImageMeta {
        id: id.to_string(),
        file: file.clone(),
        name: name.to_string(),
        prompt: prompt.to_string(),
        created_ms,
        favorite: false,
        transparent,
        size: size.to_string(),
        path: dir.join(&file).to_string_lossy().into_owned(),
    };
    let mut index = load_index(&dir);
    index.retain(|m| m.id != id);
    index.push(meta.clone());
    save_index(&dir, &index)?;
    Ok(meta)
}

#[tauri::command]
pub fn image_store(
    app: tauri::AppHandle,
    id: String,
    name: String,
    prompt: String,
    b64: String,
    transparent: bool,
    size: String,
) -> Result<ImageMeta, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("Ungültige Bilddaten: {e}"))?;
    store_bytes(&app, &id, &name, &prompt, &bytes, transparent, &size)
}

/// Importiert ein Bild in die Galerie — von einem lokalen Pfad (auch ~/…)
/// oder einer http(s)-URL. Wird auf max. 2048 px Kante komprimiert (PNG,
/// Alpha bleibt erhalten), damit es als KI-Referenz taugt.
#[tauri::command]
pub async fn image_import(
    app: tauri::AppHandle,
    source: String,
    name: Option<String>,
) -> Result<ImageMeta, String> {
    let src = source.trim().to_string();

    let bytes: Vec<u8> = if src.starts_with("http://") || src.starts_with("https://") {
        let resp = reqwest::get(&src)
            .await
            .map_err(|e| format!("Download fehlgeschlagen: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Download fehlgeschlagen: HTTP {}", resp.status()));
        }
        let data = resp.bytes().await.map_err(|e| e.to_string())?;
        if data.len() > 50_000_000 {
            return Err("Bild ist größer als 50 MB.".into());
        }
        data.to_vec()
    } else {
        let expanded = if let Some(rest) = src.strip_prefix("~/") {
            app.path()
                .home_dir()
                .map_err(|e| e.to_string())?
                .join(rest)
                .to_string_lossy()
                .into_owned()
        } else {
            src.clone()
        };
        let p = PathBuf::from(&expanded);
        if !p.is_file() {
            return Err(format!("Datei nicht gefunden: {expanded}"));
        }
        fs::read(&p).map_err(|e| e.to_string())?
    };

    // Komprimieren/konvertieren via sips (blockierend → eigener Thread).
    let processed = tauri::async_runtime::spawn_blocking(move || -> Result<(Vec<u8>, String), String> {
        let dir = std::env::temp_dir().join("otto-import");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let raw = dir.join("raw");
        let out = dir.join("import.png");
        fs::write(&raw, &bytes).map_err(|e| e.to_string())?;
        let status = std::process::Command::new("sips")
            .args([
                "-Z",
                "2048",
                "-s",
                "format",
                "png",
                &raw.to_string_lossy(),
                "--out",
                &out.to_string_lossy(),
            ])
            .status()
            .map_err(|e| format!("sips fehlgeschlagen: {e}"))?;
        if !status.success() {
            return Err("Die Datei scheint kein lesbares Bild zu sein.".into());
        }
        // Größe auslesen (best effort).
        let size = std::process::Command::new("sips")
            .args(["-g", "pixelWidth", "-g", "pixelHeight", &out.to_string_lossy()])
            .output()
            .ok()
            .map(|o| {
                let text = String::from_utf8_lossy(&o.stdout).to_string();
                let get = |key: &str| {
                    text.lines()
                        .find(|l| l.contains(key))
                        .and_then(|l| l.split(':').nth(1))
                        .map(|v| v.trim().to_string())
                        .unwrap_or_default()
                };
                format!("{}x{}", get("pixelWidth"), get("pixelHeight"))
            })
            .unwrap_or_default();
        let data = fs::read(&out).map_err(|e| e.to_string())?;
        Ok((data, size))
    })
    .await
    .map_err(|e| e.to_string())??;

    let (data, size) = processed;
    let id = format!(
        "img-imp-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let fallback_name = src
        .rsplit('/')
        .next()
        .unwrap_or("Import")
        .split('?')
        .next()
        .unwrap_or("Import")
        .to_string();
    let name = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(fallback_name);
    store_bytes(
        &app,
        &id,
        &name,
        &format!("Importiert von {src}"),
        &data,
        false,
        &size,
    )
}

#[tauri::command]
pub fn image_read_b64(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let dir = images_dir(&app)?;
    let index = load_index(&dir);
    let meta = index
        .iter()
        .find(|m| m.id == id)
        .ok_or(format!("Bild {id} nicht gefunden."))?;
    let bytes = fs::read(dir.join(&meta.file)).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn image_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = images_dir(&app)?;
    let mut index = load_index(&dir);
    if let Some(meta) = index.iter().find(|m| m.id == id) {
        let _ = fs::remove_file(dir.join(&meta.file));
    }
    index.retain(|m| m.id != id);
    save_index(&dir, &index)
}

#[tauri::command]
pub fn image_rename(app: tauri::AppHandle, id: String, name: String) -> Result<(), String> {
    let dir = images_dir(&app)?;
    let mut index = load_index(&dir);
    let meta = index
        .iter_mut()
        .find(|m| m.id == id)
        .ok_or(format!("Bild {id} nicht gefunden."))?;
    meta.name = name;
    save_index(&dir, &index)
}

#[tauri::command]
pub fn image_favorite(
    app: tauri::AppHandle,
    id: String,
    favorite: bool,
) -> Result<(), String> {
    let dir = images_dir(&app)?;
    let mut index = load_index(&dir);
    let meta = index
        .iter_mut()
        .find(|m| m.id == id)
        .ok_or(format!("Bild {id} nicht gefunden."))?;
    meta.favorite = favorite;
    save_index(&dir, &index)
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "bild".into()
    } else {
        trimmed.to_string()
    }
}

/// Exportiert ein Bild z. B. auf den Schreibtisch. `dest` ist "desktop",
/// "downloads" oder ein absoluter Ordnerpfad; Standard ist der Schreibtisch.
#[tauri::command]
pub fn image_export(
    app: tauri::AppHandle,
    id: String,
    dest: Option<String>,
) -> Result<String, String> {
    let dir = images_dir(&app)?;
    let index = load_index(&dir);
    let meta = index
        .iter()
        .find(|m| m.id == id)
        .ok_or(format!("Bild {id} nicht gefunden."))?;

    let dest_dir = match dest.as_deref() {
        None | Some("desktop") | Some("Desktop") => {
            app.path().desktop_dir().map_err(|e| e.to_string())?
        }
        Some("downloads") | Some("Downloads") => {
            app.path().download_dir().map_err(|e| e.to_string())?
        }
        Some(p) => {
            let pb = PathBuf::from(p);
            if !pb.is_dir() {
                return Err(format!("Zielordner existiert nicht: {p}"));
            }
            pb
        }
    };

    let base = sanitize_filename(&meta.name);
    let mut target = dest_dir.join(format!("{base}.png"));
    let mut counter = 2;
    while target.exists() {
        target = dest_dir.join(format!("{base}-{counter}.png"));
        counter += 1;
    }
    fs::copy(dir.join(&meta.file), &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}
