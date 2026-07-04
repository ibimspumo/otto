use tauri::Manager;

#[tauri::command]
pub fn window_vibrancy(
    app: tauri::AppHandle,
    label: String,
    enable: bool,
    radius: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win = app
            .get_webview_window(&label)
            .ok_or_else(|| format!("Fenster {label} fehlt"))?;
        if enable {
            window_vibrancy::apply_vibrancy(
                &win,
                window_vibrancy::NSVisualEffectMaterial::HudWindow,
                None,
                Some(radius),
            )
            .map_err(|e| e.to_string())?;
        } else {
            window_vibrancy::clear_vibrancy(&win).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label, enable, radius);
    }
    Ok(())
}

#[tauri::command]
pub fn panel_vibrancy(
    app: tauri::AppHandle,
    enable: bool,
    radius: f64,
) -> Result<(), String> {
    window_vibrancy(app, "panel".to_string(), enable, radius)
}
