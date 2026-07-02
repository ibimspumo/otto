use base64::Engine;
use std::process::Command;

/// Screenshots werden auf diese Breite verkleinert — kleiner = schneller,
/// die Klick-Koordinaten werden entsprechend zurückskaliert.
const SHOT_MAX_W: f64 = 1344.0;

#[derive(Clone, Copy)]
pub struct Display {
    pub shot_w: u32, // Screenshot-Pixel (verkleinert)
    pub shot_h: u32,
    /// Modell-Koordinate (Screenshot-Pixel) × coord_scale = Maus-Koordinate.
    pub coord_scale: f64,
}

pub fn display_info(app: &tauri::AppHandle) -> Result<Display, String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("Kein Display gefunden.")?;
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let width = (size.width as f64 / scale).round() as u32;
    let height = (size.height as f64 / scale).round() as u32;
    let down = (width as f64 / SHOT_MAX_W).max(1.0);
    let shot_w = (width as f64 / down).round() as u32;
    let shot_h = (height as f64 / down).round() as u32;
    Ok(Display {
        shot_w,
        shot_h,
        coord_scale: width as f64 / shot_w as f64,
    })
}

pub fn screenshot_b64(display: &Display) -> Result<String, String> {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("otto-cu-{unique}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let png = dir.join("shot.png");
    let jpg = dir.join("shot.jpg");
    let png_str = png.to_string_lossy().to_string();
    let jpg_str = jpg.to_string_lossy().to_string();

    let status = Command::new("screencapture")
        .args(["-x", &png_str])
        .status()
        .map_err(|e| format!("screencapture fehlgeschlagen: {e}"))?;
    if !status.success() {
        return Err(
            "Screenshot fehlgeschlagen. Hat Otto die Berechtigung „Bildschirmaufnahme“ in den Systemeinstellungen?"
                .into(),
        );
    }
    let status = Command::new("sips")
        .args([
            "-z",
            &display.shot_h.to_string(),
            &display.shot_w.to_string(),
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            "80",
            &png_str,
            "--out",
            &jpg_str,
        ])
        .status()
        .map_err(|e| format!("sips fehlgeschlagen: {e}"))?;
    if !status.success() {
        return Err("Screenshot-Konvertierung fehlgeschlagen.".into());
    }

    let bytes = std::fs::read(&jpg).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
