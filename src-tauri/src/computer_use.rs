//! Computer Use über OpenAIs `computer-use-preview`-Modell (Responses API).
//!
//! Loop: Screenshot → Modell → Aktion (Maus/Tastatur via enigo) → Screenshot → …
//! Screenshots werden auf die logische Displaygröße skaliert, damit
//! Modell-Koordinaten 1:1 den Mauskoordinaten entsprechen.
//!
//! Benötigt macOS-Berechtigungen: Bildschirmaufnahme (screencapture) und
//! Bedienungshilfen (enigo) für die App bzw. das Dev-Binary.

use base64::Engine;
use enigo::{
    Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse,
    Settings as EnigoSettings,
};
use serde_json::{json, Value};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

const MAX_STEPS: usize = 60;
/// Screenshots werden auf diese Breite verkleinert — kleiner = schneller,
/// die Klick-Koordinaten werden entsprechend zurückskaliert.
const SHOT_MAX_W: f64 = 1344.0;

static CANCEL: AtomicBool = AtomicBool::new(false);

/// Bricht einen laufenden Computer-Use-Durchlauf ab (Button im Mini-Orb).
#[tauri::command]
pub fn cu_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

// macOS-TCC-Freigaben: Bildschirmaufnahme (Screenshots) und
// Bedienungshilfen (synthetische Maus-/Tastatur-Events).
#[cfg(target_os = "macos")]
mod tcc {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGPreflightScreenCaptureAccess() -> bool;
        pub fn CGRequestScreenCaptureAccess() -> bool;
    }
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> bool;
    }
}

/// Prüft (und fordert auf Wunsch an) die Systemfreigaben für Computer Use.
/// `request = true` löst den macOS-Dialog für Bildschirmaufnahme aus und
/// öffnet die Bedienungshilfen-Einstellungen, falls nötig.
#[tauri::command]
pub fn cu_permissions(request: bool) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    unsafe {
        let mut screen = tcc::CGPreflightScreenCaptureAccess();
        if !screen && request {
            screen = tcc::CGRequestScreenCaptureAccess();
        }
        let accessibility = tcc::AXIsProcessTrusted();
        if !accessibility && request {
            let _ = std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
                .status();
        }
        Ok(json!({ "screen": screen, "accessibility": accessibility }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Ok(json!({ "screen": true, "accessibility": true }))
    }
}

fn ensure_permissions() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    unsafe {
        let screen = tcc::CGPreflightScreenCaptureAccess();
        let accessibility = tcc::AXIsProcessTrusted();
        if !screen || !accessibility {
            let mut missing = Vec::new();
            if !screen {
                missing.push("Bildschirmaufnahme");
            }
            if !accessibility {
                missing.push("Bedienungshilfen");
            }
            return Err(format!(
                "Fehlende macOS-Freigaben für Computer Use: {}. In den Einstellungen der App gibt es einen Button „Freigaben anfordern“; danach Otto neu starten. Sag das dem Nutzer.",
                missing.join(" und ")
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct Display {
    width: u32,  // logische Punkte
    height: u32,
    shot_w: u32, // Screenshot-Pixel (verkleinert)
    shot_h: u32,
    /// Modell-Koordinate (Screenshot-Pixel) × coord_scale = Maus-Koordinate.
    coord_scale: f64,
}

fn display_info(app: &tauri::AppHandle) -> Result<Display, String> {
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
        width,
        height,
        shot_w,
        shot_h,
        coord_scale: width as f64 / shot_w as f64,
    })
}

fn screenshot_b64(display: &Display) -> Result<String, String> {
    let dir = std::env::temp_dir().join("otto-cu");
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
    // Verkleinern + JPEG: deutlich weniger Tokens pro Schritt → schneller.
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
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn map_key(name: &str) -> Option<Key> {
    let up = name.trim().to_uppercase();
    Some(match up.as_str() {
        "ENTER" | "RETURN" => Key::Return,
        "TAB" => Key::Tab,
        "SPACE" | "SPACEBAR" => Key::Space,
        "BACKSPACE" => Key::Backspace,
        "DELETE" | "DEL" => Key::Delete,
        "ESC" | "ESCAPE" => Key::Escape,
        "CMD" | "COMMAND" | "META" | "SUPER" | "WIN" => Key::Meta,
        "CTRL" | "CONTROL" => Key::Control,
        "ALT" | "OPTION" => Key::Alt,
        "SHIFT" => Key::Shift,
        "LEFT" | "ARROWLEFT" => Key::LeftArrow,
        "RIGHT" | "ARROWRIGHT" => Key::RightArrow,
        "UP" | "ARROWUP" => Key::UpArrow,
        "DOWN" | "ARROWDOWN" => Key::DownArrow,
        "HOME" => Key::Home,
        "END" => Key::End,
        "PAGEUP" => Key::PageUp,
        "PAGEDOWN" => Key::PageDown,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        _ => {
            let mut chars = name.chars();
            let c = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            Key::Unicode(c.to_ascii_lowercase())
        }
    })
}

fn map_button(name: &str) -> Button {
    match name {
        "right" => Button::Right,
        "wheel" | "middle" => Button::Middle,
        _ => Button::Left,
    }
}

fn describe_action(action: &Value) -> String {
    let t = action["type"].as_str().unwrap_or("?");
    match t {
        "click" => format!(
            "klickt bei ({}, {})",
            action["x"].as_i64().unwrap_or(0),
            action["y"].as_i64().unwrap_or(0)
        ),
        "double_click" => format!(
            "doppelklickt bei ({}, {})",
            action["x"].as_i64().unwrap_or(0),
            action["y"].as_i64().unwrap_or(0)
        ),
        "type" => {
            let text = action["text"].as_str().unwrap_or("");
            let short: String = text.chars().take(40).collect();
            format!("tippt „{short}{}“", if text.len() > 40 { "…" } else { "" })
        }
        "keypress" => {
            let keys: Vec<String> = action["keys"]
                .as_array()
                .map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).collect())
                .unwrap_or_default();
            format!("drückt {}", keys.join("+"))
        }
        "scroll" => "scrollt".into(),
        "move" => "bewegt die Maus".into(),
        "drag" => "zieht die Maus".into(),
        "wait" => "wartet".into(),
        "screenshot" => "macht einen Screenshot".into(),
        other => other.into(),
    }
}

/// Punkt aus `{x, y}` ODER `[x, y]` (das neue Tool nutzt Arrays in drag-Pfaden).
fn point(v: &Value) -> (i32, i32) {
    if let Some(arr) = v.as_array() {
        (
            arr.first().and_then(|n| n.as_f64()).unwrap_or(0.0) as i32,
            arr.get(1).and_then(|n| n.as_f64()).unwrap_or(0.0) as i32,
        )
    } else {
        (
            v["x"].as_f64().unwrap_or(0.0) as i32,
            v["y"].as_f64().unwrap_or(0.0) as i32,
        )
    }
}

fn execute_action(action: &Value, coord_scale: f64) -> Result<(), String> {
    let mut enigo = Enigo::new(&EnigoSettings::default()).map_err(|e| {
        format!("Eingabesteuerung nicht verfügbar (Berechtigung „Bedienungshilfen“?): {e}")
    })?;
    let t = action["type"].as_str().unwrap_or("");
    // Screenshot-Pixel → logische Mauskoordinaten.
    let xy = move |a: &Value| {
        let (x, y) = point(a);
        (
            (x as f64 * coord_scale).round() as i32,
            (y as f64 * coord_scale).round() as i32,
        )
    };

    // Modifier-Tasten (z. B. Cmd-Klick) — gelten für Maus-Aktionen,
    // nicht für keypress/type, wo keys die Aktion selbst sind.
    let modifiers: Vec<Key> = if matches!(t, "click" | "double_click" | "drag" | "scroll" | "move") {
        action["keys"]
            .as_array()
            .map(|a| a.iter().filter_map(|k| k.as_str()).filter_map(map_key).collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    for k in &modifiers {
        enigo.key(*k, Direction::Press).map_err(|e| e.to_string())?;
    }
    let result = run_single_action(&mut enigo, t, action, &xy);
    for k in modifiers.iter().rev() {
        let _ = enigo.key(*k, Direction::Release);
    }
    result
}

fn run_single_action(
    enigo: &mut Enigo,
    t: &str,
    action: &Value,
    xy: &dyn Fn(&Value) -> (i32, i32),
) -> Result<(), String> {
    match t {
        "click" => {
            let (x, y) = xy(action);
            enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string())?;
            std::thread::sleep(std::time::Duration::from_millis(60));
            let btn = map_button(action["button"].as_str().unwrap_or("left"));
            enigo.button(btn, Direction::Click).map_err(|e| e.to_string())?;
        }
        "double_click" => {
            let (x, y) = xy(action);
            enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string())?;
            std::thread::sleep(std::time::Duration::from_millis(60));
            enigo.button(Button::Left, Direction::Click).map_err(|e| e.to_string())?;
            std::thread::sleep(std::time::Duration::from_millis(50));
            enigo.button(Button::Left, Direction::Click).map_err(|e| e.to_string())?;
        }
        "move" => {
            let (x, y) = xy(action);
            enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string())?;
        }
        "drag" => {
            let path = action["path"].as_array().cloned().unwrap_or_default();
            if let Some(first) = path.first() {
                let (x, y) = xy(first);
                enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string())?;
                std::thread::sleep(std::time::Duration::from_millis(80));
                enigo.button(Button::Left, Direction::Press).map_err(|e| e.to_string())?;
                for p in path.iter().skip(1) {
                    let (x, y) = xy(p);
                    enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string())?;
                    std::thread::sleep(std::time::Duration::from_millis(40));
                }
                enigo.button(Button::Left, Direction::Release).map_err(|e| e.to_string())?;
            }
        }
        "scroll" => {
            let (x, y) = xy(action);
            enigo.move_mouse(x, y, Coordinate::Abs).map_err(|e| e.to_string())?;
            // Preview-Tool: scroll_x/scroll_y — neues computer-Tool: scrollX/scrollY.
            let sy = action["scroll_y"]
                .as_f64()
                .or_else(|| action["scrollY"].as_f64())
                .unwrap_or(0.0);
            let sx = action["scroll_x"]
                .as_f64()
                .or_else(|| action["scrollX"].as_f64())
                .unwrap_or(0.0);
            // Modell liefert Pixel, enigo erwartet Zeilen.
            if sy.abs() >= 1.0 {
                enigo
                    .scroll((sy / 40.0).round() as i32, Axis::Vertical)
                    .map_err(|e| e.to_string())?;
            }
            if sx.abs() >= 1.0 {
                enigo
                    .scroll((sx / 40.0).round() as i32, Axis::Horizontal)
                    .map_err(|e| e.to_string())?;
            }
        }
        "type" => {
            let text = action["text"].as_str().unwrap_or("");
            enigo.text(text).map_err(|e| e.to_string())?;
        }
        "keypress" => {
            let keys: Vec<Key> = action["keys"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|k| k.as_str())
                        .filter_map(map_key)
                        .collect()
                })
                .unwrap_or_default();
            if keys.len() > 1 {
                for k in &keys {
                    enigo.key(*k, Direction::Press).map_err(|e| e.to_string())?;
                }
                for k in keys.iter().rev() {
                    enigo.key(*k, Direction::Release).map_err(|e| e.to_string())?;
                }
            } else if let Some(k) = keys.first() {
                enigo.key(*k, Direction::Click).map_err(|e| e.to_string())?;
            }
        }
        "wait" => std::thread::sleep(std::time::Duration::from_millis(1000)),
        "screenshot" => {}
        other => {
            return Err(format!(
                "Unbekannte Aktion „{other}“ — Rohdaten: {}",
                serde_json::to_string(action).unwrap_or_default()
            ))
        }
    }
    Ok(())
}

fn extract_text(output: &[Value]) -> String {
    let mut parts = Vec::new();
    for item in output {
        if item["type"] == "message" {
            if let Some(content) = item["content"].as_array() {
                for c in content {
                    if let Some(t) = c["text"].as_str() {
                        parts.push(t.to_string());
                    }
                }
            }
        }
    }
    parts.join("\n")
}

fn emit_status(app: &tauri::AppHandle, text: &str) {
    eprintln!("[computer-use] {text}");
    let _ = app.emit("cu-status", json!({ "text": text }));
}

#[tauri::command]
pub async fn run_computer_use(
    app: tauri::AppHandle,
    task: String,
    api_key: String,
    model: Option<String>,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Kein OpenAI-API-Key hinterlegt.".into());
    }
    ensure_permissions()?;
    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "gpt-5.5".into());
    let display = display_info(&app)?;
    // Das alte computer-use-preview braucht Tool-Typ + Display-Angaben;
    // das neue "computer"-Tool (gpt-5.4/5.5) akzeptiert nur {type}.
    let tool = if model.starts_with("computer-use") {
        // Maße = Screenshot-Pixel, denn in dem Raum liefert das Modell Koordinaten.
        json!({
            "type": "computer_use_preview",
            "display_width": display.shot_w,
            "display_height": display.shot_h,
            "environment": "mac"
        })
    } else {
        json!({ "type": "computer" })
    };
    let client = reqwest::Client::new();

    CANCEL.store(false, Ordering::SeqCst);
    emit_status(&app, "startet und macht einen Screenshot");
    let shot = {
        let d = display;
        tauri::async_runtime::spawn_blocking(move || screenshot_b64(&d))
            .await
            .map_err(|e| e.to_string())??
    };

    let mut input = json!([{
        "role": "user",
        "content": [
            { "type": "input_text", "text": task },
            { "type": "input_image", "image_url": format!("data:image/jpeg;base64,{shot}") }
        ]
    }]);
    let mut prev_id: Option<String> = None;

    for _step in 0..MAX_STEPS {
        if CANCEL.load(Ordering::SeqCst) {
            emit_status(&app, "abgebrochen");
            return Err("Computer Use wurde vom Nutzer abgebrochen.".into());
        }
        let mut body = json!({
            "model": model,
            "tools": [tool.clone()],
            "input": input,
            "truncation": "auto"
        });
        // Niedriger Reasoning-Aufwand: für UI-Schritte ausreichend, deutlich schneller.
        if !model.starts_with("computer-use") {
            body["reasoning"] = json!({ "effort": "low" });
        }
        if let Some(id) = &prev_id {
            body["previous_response_id"] = json!(id);
        }

        let resp = client
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(api_key.trim())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Netzwerkfehler: {e}"))?;
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;

        if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
            let msg = err["message"].as_str().unwrap_or("unbekannter Fehler");
            if msg.contains("does not exist")
                || msg.to_lowercase().contains("do not have access")
            {
                return Err(format!(
                    "OpenAI: {msg} — Das Computer-Use-Modell „{model}“ ist für diesen API-Key nicht verfügbar. In den Einstellungen lässt sich ein anderes Modell eintragen (z. B. gpt-5.4 oder computer-use-preview)."
                ));
            }
            return Err(format!("OpenAI: {msg}"));
        }
        prev_id = v["id"].as_str().map(String::from);

        let output = v["output"].as_array().cloned().unwrap_or_default();
        let call = output.iter().find(|o| o["type"] == "computer_call").cloned();

        let Some(call) = call else {
            let text = extract_text(&output);
            emit_status(&app, "fertig");
            return Ok(if text.is_empty() {
                "Aufgabe abgeschlossen.".into()
            } else {
                text
            });
        };

        // Neues computer-Tool: "actions" (Array). Preview-Tool: einzelnes "action".
        let actions: Vec<Value> = call["actions"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| {
                if call["action"].is_object() {
                    vec![call["action"].clone()]
                } else {
                    Vec::new()
                }
            });
        for action in actions {
            if CANCEL.load(Ordering::SeqCst) {
                emit_status(&app, "abgebrochen");
                return Err("Computer Use wurde vom Nutzer abgebrochen.".into());
            }
            emit_status(&app, &describe_action(&action));
            let scale = display.coord_scale;
            tauri::async_runtime::spawn_blocking(move || execute_action(&action, scale))
                .await
                .map_err(|e| e.to_string())??;
            let _ = tauri::async_runtime::spawn_blocking(|| {
                std::thread::sleep(std::time::Duration::from_millis(120))
            })
            .await;
        }

        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(300))
        })
        .await;
        let shot = {
            let d = display;
            tauri::async_runtime::spawn_blocking(move || screenshot_b64(&d))
                .await
                .map_err(|e| e.to_string())??
        };

        let mut out_item = json!({
            "type": "computer_call_output",
            "call_id": call["call_id"],
            "output": {
                "type": "computer_screenshot",
                "image_url": format!("data:image/jpeg;base64,{shot}"),
                "detail": "original"
            }
        });
        // Sicherheitshinweise des Modells bestätigen und dem Nutzer melden.
        if let Some(checks) = call["pending_safety_checks"].as_array() {
            if !checks.is_empty() {
                for c in checks {
                    if let Some(m) = c["message"].as_str() {
                        emit_status(&app, &format!("Sicherheitshinweis: {m}"));
                    }
                }
                out_item["acknowledged_safety_checks"] = json!(checks);
            }
        }
        input = json!([out_item]);
    }

    Err(format!("Abgebrochen nach {MAX_STEPS} Schritten."))
}
