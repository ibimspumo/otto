use tauri::Manager;

#[tauri::command]
pub fn panel_vibrancy(
    app: tauri::AppHandle,
    enable: bool,
    radius: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let win = app
            .get_webview_window("panel")
            .ok_or("Panel-Fenster fehlt")?;
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
        let _ = (app, enable, radius);
    }
    Ok(())
}
