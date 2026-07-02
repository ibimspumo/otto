//! Computer Use über OpenAIs Responses API.
//!
//! Loop: Screenshot → Modell → Aktion (Maus/Tastatur via enigo) → Screenshot → …
//! Screenshots werden auf die logische Displaygröße skaliert, damit
//! Modell-Koordinaten 1:1 den Mauskoordinaten entsprechen.

mod actions;
pub mod permissions;
mod screen;

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

use actions::{describe_action, execute_action};
use permissions::ensure_permissions;
use screen::{display_info, screenshot_b64};

const MAX_STEPS: usize = 60;

static CANCEL: AtomicBool = AtomicBool::new(false);

/// Bricht einen laufenden Computer-Use-Durchlauf ab.
#[tauri::command]
pub fn cu_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
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
    let tool = if model.starts_with("computer-use") {
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

        let actions: Vec<Value> = call["actions"].as_array().cloned().unwrap_or_else(|| {
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
