use enigo::{
    Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse,
    Settings as EnigoSettings,
};
use serde_json::Value;

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

pub fn describe_action(action: &Value) -> String {
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

pub fn execute_action(action: &Value, coord_scale: f64) -> Result<(), String> {
    let mut enigo = Enigo::new(&EnigoSettings::default()).map_err(|e| {
        format!("Eingabesteuerung nicht verfügbar (Berechtigung „Bedienungshilfen“?): {e}")
    })?;
    let t = action["type"].as_str().unwrap_or("");
    let xy = move |a: &Value| {
        let (x, y) = point(a);
        (
            (x as f64 * coord_scale).round() as i32,
            (y as f64 * coord_scale).round() as i32,
        )
    };

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
            let sy = action["scroll_y"]
                .as_f64()
                .or_else(|| action["scrollY"].as_f64())
                .unwrap_or(0.0);
            let sx = action["scroll_x"]
                .as_f64()
                .or_else(|| action["scrollX"].as_f64())
                .unwrap_or(0.0);
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
