// Menüleisten-Präsenz: Tray-Icon + Menü.
//
// Otto lebt in der Menüleiste statt im Dock (ActivationPolicy::Accessory
// wird in lib.rs gesetzt). Linksklick aufs Icon toggelt den Orb; das
// Menü (Rechtsklick) bietet Öffnen, Einstellungen und Beenden. Alle
// Aktionen laufen als Events ins Frontend — dort lebt die Fensterlogik.
// Linksklick öffnet die Einstellungen; die Insel bleibt Hotkey/Wake/menügesteuert.

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;

/// Zeichnet das Tray-Icon zur Laufzeit: ein Orb-Ring mit Kernpunkt,
/// anti-aliased, monochrom — als Template-Image passt es sich hell/dunkel
/// an. 18×18 pt entspricht der üblichen Menüleisten-Glyphengröße.
fn orb_icon() -> Image<'static> {
    const S: usize = 18;
    let center = (S as f32 - 1.0) / 2.0;
    let mut rgba = vec![0u8; S * S * 4];
    // Deckkraft einer Ring-Kante: 1 innerhalb, weicher Abfall über 1 px.
    let ring = |d: f32, r: f32, w: f32| -> f32 {
        let half = w / 2.0;
        (1.0 - ((d - r).abs() - half).max(0.0)).clamp(0.0, 1.0)
    };
    let disc = |d: f32, r: f32| -> f32 { (1.0 - (d - r).max(0.0)).clamp(0.0, 1.0) };
    for y in 0..S {
        for x in 0..S {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let d = (dx * dx + dy * dy).sqrt();
            let a = ring(d, 6.6, 1.5).max(disc(d, 2.4));
            let i = (y * S + x) * 4;
            rgba[i] = 0;
            rgba[i + 1] = 0;
            rgba[i + 2] = 0;
            rgba[i + 3] = (a * 255.0) as u8;
        }
    }
    Image::new_owned(rgba, S as u32, S as u32)
}

pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let toggle = MenuItemBuilder::with_id("toggle", "Otto anzeigen/ausblenden").build(app)?;
    let connect = MenuItemBuilder::with_id("connect", "Sprechen (verbinden)").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Einstellungen…").build(app)?;
    let files = MenuItemBuilder::with_id("files", "Persona & Dateien…").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Otto beenden").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&toggle)
        .item(&connect)
        .separator()
        .item(&settings)
        .item(&files)
        .separator()
        .item(&quit)
        .build()?;

    TrayIconBuilder::with_id("otto-tray")
        .icon(orb_icon())
        .icon_as_template(true)
        .tooltip("Otto")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => {
                let _ = app.emit("tray-toggle", ());
            }
            "connect" => {
                let _ = app.emit("tray-connect", ());
            }
            "settings" => {
                let _ = app.emit("tray-settings", ());
            }
            "files" => {
                let _ = app.emit("tray-files", ());
            }
            "quit" => {
                // Kein hartes exit: Das Frontend bekommt die Chance, sauber
                // zu trennen (session_end + Memory-Flush) und ruft dann
                // app_exit auf. Fallback-Thread, falls das Frontend hängt
                // oder kein Fenster mehr lebt.
                let _ = app.emit("app-quit", ());
                let handle = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    crate::cli::kill_all_jobs();
                    handle.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = tray.app_handle().emit("tray-settings", ());
            }
        })
        .build(app)?;
    Ok(())
}
