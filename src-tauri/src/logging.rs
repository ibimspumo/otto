use std::fs;
use tauri::Manager;

pub fn crash_log(msg: &str) {
    let path = std::env::temp_dir().join("otto-crash.log");
    let line = format!("[{:?}] {msg}\n", std::time::SystemTime::now());
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

#[tauri::command]
pub fn log_line(app: tauri::AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("otto.log");
    if let Ok(md) = fs::metadata(&path) {
        if md.len() > 1_000_000 {
            let _ = fs::remove_file(&path);
        }
    }
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "[{ts}] {}", line.trim()).map_err(|e| e.to_string())
}
