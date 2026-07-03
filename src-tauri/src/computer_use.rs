use serde::Serialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const CLI_PATH_SETUP: &str = concat!(
    r#"PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:"#,
    r#"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin"; export PATH; "#
);
const BUNDLED_PLUGIN_DIR: &str =
    "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use";
const CODEX_NODE: &str = "/Applications/Codex.app/Contents/Resources/cua_node/bin/node";
const INSTALLED_PLUGIN_DIR_SUFFIX: &str = ".codex/computer-use";
const MCP_REL: &str =
    "Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";
const MAX_TEXT_CHARS: usize = 18_000;
const MCP_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Serialize)]
pub struct ComputerUseStatus {
    codex_cli: bool,
    codex_version: Option<String>,
    codex_app: bool,
    app_server_running: bool,
    bundled_plugin: bool,
    installed_plugin: bool,
    computer_use_service_running: bool,
    mcp_client: Option<String>,
    mcp_probe_ok: bool,
    mcp_tool_count: usize,
    ready: bool,
    hint: String,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

fn installed_plugin_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(INSTALLED_PLUGIN_DIR_SUFFIX))
}

fn plugin_dir() -> Option<PathBuf> {
    let installed = installed_plugin_dir()?;
    if installed.join(MCP_REL).is_file() {
        return Some(installed);
    }
    let bundled = PathBuf::from(BUNDLED_PLUGIN_DIR);
    if bundled.join(MCP_REL).is_file() {
        Some(bundled)
    } else {
        None
    }
}

fn has_shell_command(command: &str) -> bool {
    Command::new("/bin/zsh")
        .args(["-lc", &format!("{CLI_PATH_SETUP}{command}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn shell_output(command: &str) -> Option<String> {
    let out = Command::new("/bin/zsh")
        .args(["-lc", &format!("{CLI_PATH_SETUP}{command}")])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn is_running(pattern: &str) -> bool {
    Command::new("/usr/bin/pgrep")
        .args(["-f", pattern])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn truncate_text(s: &str) -> String {
    if s.len() <= MAX_TEXT_CHARS {
        return s.to_string();
    }
    let start = s
        .char_indices()
        .map(|(i, _)| i)
        .find(|&i| i >= s.len() - MAX_TEXT_CHARS)
        .unwrap_or(0);
    format!("[…{} Zeichen gekürzt]\n{}", start, &s[start..])
}

fn node_bin() -> Option<String> {
    if Path::new(CODEX_NODE).is_file() {
        return Some(CODEX_NODE.into());
    }
    shell_output("command -v node")
}

fn content_to_value(result: Value, tool: &str) -> Value {
    let mut parts = Vec::new();
    let mut images = 0usize;
    if let Some(content) = result.get("content").and_then(|v| v.as_array()) {
        for item in content {
            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                parts.push(text.to_string());
            } else if item.get("data").is_some()
                || item.get("type").and_then(|v| v.as_str()) == Some("image")
            {
                images += 1;
            }
        }
    }
    let text = truncate_text(&parts.join("\n\n"));
    json!({
        "ok": true,
        "tool": tool,
        "text": text,
        "images_omitted": images,
        "is_error": result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false),
        "hinweis": if images > 0 {
            "Der Computer-Use-Screenshot wurde vom lokalen MCP geliefert, aber für die Sprach-Tool-Antwort weggelassen; nutze den Accessibility-Baum und rufe bei Bedarf erneut get_state auf."
        } else {
            ""
        }
    })
}

fn call_mcp_tool(tool: &str, arguments: Value, timeout: Duration) -> Result<Value, String> {
    let dir = plugin_dir().ok_or_else(|| {
        "Codex Computer Use ist nicht gefunden. Installiere/öffne Codex Desktop und aktiviere dort Computer Use.".to_string()
    })?;
    let mcp = dir.join(MCP_REL);
    if !mcp.is_file() {
        return Err(format!("Computer-Use-MCP fehlt: {}", mcp.display()));
    }
    let node = node_bin().ok_or_else(|| {
        "Node.js fehlt. Installiere Codex Desktop vollständig oder stelle node im PATH bereit.".to_string()
    })?;

    const BRIDGE: &str = r#"
const {spawn} = require('child_process');
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const child = spawn(input.bin, ['mcp'], { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
let initialized = false;
let done = false;
let timeoutHandle = null;
function send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); }
function stripLargePayloads(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripLargePayloads);
  if ('data' in value || value.type === 'image') {
    return { type: 'image_omitted', mimeType: value.mimeType || value.mime_type || null };
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = stripLargePayloads(child);
  }
  return out;
}
function finish(value) {
  if (done) return;
  done = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  const raw = JSON.stringify(stripLargePayloads(value));
  process.stdout.write(raw, () => {
    child.kill();
    process.exit(value.ok ? 0 : 1);
  });
}
child.stderr.on('data', d => { stderr += d.toString(); });
child.stdout.on('data', d => {
  stdout += d.toString();
  let idx;
  while ((idx = stdout.indexOf('\n')) >= 0) {
    const line = stdout.slice(0, idx);
    stdout = stdout.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (!initialized && msg.id === 1) {
      if (msg.error) return finish({ ok: false, error: `initialize failed: ${JSON.stringify(msg.error)}` });
      initialized = true;
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      setTimeout(() => send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: input.tool, arguments: input.arguments }
      }), 250);
      continue;
    }
    if (msg.method === 'elicitation/create') {
      send({ jsonrpc: '2.0', id: msg.id, result: { action: 'accept', content: {}, _meta: {} } });
      continue;
    }
    if (msg.id === 2) {
      if (msg.error) return finish({ ok: false, error: `tool failed: ${JSON.stringify(msg.error)}` });
      return finish({ ok: true, result: msg.result });
    }
  }
});
child.on('exit', (code, signal) => {
  if (!done) finish({ ok: false, error: `mcp exited (${code ?? signal ?? 'unknown'}): ${stderr.trim()}` });
});
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: { elicitation: {} },
    clientInfo: { name: 'otto', version: '0.2.1' }
  }
});
timeoutHandle = setTimeout(() => finish({ ok: false, error: 'mcp timeout' }), Math.max(1000, input.timeoutMs));
"#;

    let payload = json!({
        "bin": mcp,
        "cwd": dir,
        "tool": tool,
        "arguments": arguments,
        "timeoutMs": timeout.as_millis() as u64,
    });
    let mut child = Command::new(node)
        .args(["-e", BRIDGE])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Computer-Use-Bridge konnte nicht gestartet werden: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("Kein MCP-stdin")?;
    stdin
        .write_all(serde_json::to_string(&payload).map_err(|e| e.to_string())?.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Bridge-Schreibfehler: {e}"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Computer-Use-Bridge fehlgeschlagen: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let msg: Value = serde_json::from_str(stdout.trim()).map_err(|e| {
        format!(
            "Computer-Use-Bridge lieferte kein JSON: {e}. stderr: {}",
            stderr.trim()
        )
    })?;
    if msg.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(msg
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Computer-Use-Bridge fehlgeschlagen.")
            .to_string())
    }
}

fn probe_mcp_tools() -> (bool, usize) {
    call_mcp_tool("list_apps", json!({}), Duration::from_secs(8))
        .ok()
        .map(|v| {
            let ok = !v.get("isError").and_then(|x| x.as_bool()).unwrap_or(false);
            (ok, if ok { 10 } else { 0 })
        })
        .unwrap_or((false, 0))
}

#[tauri::command]
pub async fn codex_computer_use_status() -> Result<ComputerUseStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let codex_cli = has_shell_command("command -v codex");
        let codex_version = shell_output("codex --version");
        let codex_app = Path::new("/Applications/Codex.app").exists();
        let bundled_plugin = Path::new(BUNDLED_PLUGIN_DIR).join(MCP_REL).is_file();
        let installed_plugin = installed_plugin_dir()
            .map(|p| p.join(MCP_REL).is_file())
            .unwrap_or(false);
        let app_server_running = is_running("codex app-server");
        let computer_use_service_running = is_running("SkyComputerUseService");
        let mcp_client = plugin_dir().map(|p| p.join(MCP_REL).to_string_lossy().to_string());
        let (mcp_probe_ok, mcp_tool_count) = if mcp_client.is_some() {
            probe_mcp_tools()
        } else {
            (false, 0)
        };
        let ready = codex_app && mcp_client.is_some() && mcp_probe_ok;
        let hint = if ready {
            "Codex Computer Use ist erreichbar.".into()
        } else if !codex_app {
            "Codex Desktop wurde unter /Applications/Codex.app nicht gefunden.".into()
        } else if mcp_client.is_none() {
            "Das Computer-Use-Plugin wurde nicht gefunden. Öffne Codex → Einstellungen → Computer Use und installiere es.".into()
        } else {
            "Das Plugin ist vorhanden, antwortet aber nicht. Öffne Codex einmal, prüfe Computer-Use- und macOS-Freigaben.".into()
        };
        ComputerUseStatus {
            codex_cli,
            codex_version,
            codex_app,
            app_server_running,
            bundled_plugin,
            installed_plugin,
            computer_use_service_running,
            mcp_client,
            mcp_probe_ok,
            mcp_tool_count,
            ready,
            hint,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

fn require_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Parameter fehlt: {key}"))
}

fn optional_number(args: &Value, key: &str) -> Option<f64> {
    args.get(key).and_then(|v| v.as_f64())
}

fn optional_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64())
}

#[tauri::command]
pub async fn codex_computer_use_call(args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let action = require_str(&args, "action")?;
        let tool_args = match action.as_str() {
            "list_apps" => json!({}),
            "get_state" => json!({ "app": require_str(&args, "app")? }),
            "click" => {
                let mut v = json!({ "app": require_str(&args, "app")? });
                if let Some(e) = args.get("element_index").and_then(|v| v.as_str()) {
                    v["element_index"] = json!(e);
                }
                if let Some(x) = optional_number(&args, "x") {
                    v["x"] = json!(x);
                }
                if let Some(y) = optional_number(&args, "y") {
                    v["y"] = json!(y);
                }
                if let Some(count) = optional_u64(&args, "click_count") {
                    v["click_count"] = json!(count);
                }
                if let Some(btn) = args.get("mouse_button").and_then(|v| v.as_str()) {
                    v["mouse_button"] = json!(btn);
                }
                v
            }
            "type_text" => json!({
                "app": require_str(&args, "app")?,
                "text": require_str(&args, "text")?
            }),
            "press_key" => json!({
                "app": require_str(&args, "app")?,
                "key": require_str(&args, "key")?
            }),
            "set_value" => json!({
                "app": require_str(&args, "app")?,
                "element_index": require_str(&args, "element_index")?,
                "value": require_str(&args, "value")?
            }),
            "scroll" => json!({
                "app": require_str(&args, "app")?,
                "element_index": require_str(&args, "element_index")?,
                "direction": require_str(&args, "direction")?,
                "pages": optional_number(&args, "pages").unwrap_or(1.0)
            }),
            "drag" => json!({
                "app": require_str(&args, "app")?,
                "from_x": optional_number(&args, "from_x").ok_or("Parameter fehlt: from_x")?,
                "from_y": optional_number(&args, "from_y").ok_or("Parameter fehlt: from_y")?,
                "to_x": optional_number(&args, "to_x").ok_or("Parameter fehlt: to_x")?,
                "to_y": optional_number(&args, "to_y").ok_or("Parameter fehlt: to_y")?
            }),
            "select_text" => {
                let mut v = json!({
                    "app": require_str(&args, "app")?,
                    "element_index": require_str(&args, "element_index")?,
                    "text": require_str(&args, "text")?
                });
                if let Some(sel) = args.get("selection").and_then(|v| v.as_str()) {
                    v["selection"] = json!(sel);
                }
                if let Some(prefix) = args.get("prefix").and_then(|v| v.as_str()) {
                    v["prefix"] = json!(prefix);
                }
                if let Some(suffix) = args.get("suffix").and_then(|v| v.as_str()) {
                    v["suffix"] = json!(suffix);
                }
                v
            }
            "secondary_action" => json!({
                "app": require_str(&args, "app")?,
                "element_index": require_str(&args, "element_index")?,
                "action": require_str(&args, "secondary_action")?
            }),
            other => return Err(format!("Unbekannte Computer-Use-Aktion: {other}")),
        };
        let tool = match action.as_str() {
            "list_apps" => "list_apps",
            "get_state" => "get_app_state",
            "secondary_action" => "perform_secondary_action",
            other => other,
        };
        let result = call_mcp_tool(tool, tool_args, MCP_TIMEOUT)?;
        Ok(content_to_value(result, tool))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn probe_real_codex_computer_use_mcp() {
        let result = call_mcp_tool("list_apps", json!({}), Duration::from_secs(45));
        eprintln!("Computer-Use-MCP-Probe: {result:#?}");
        let value = result.expect("Computer-Use-MCP-Probe fehlgeschlagen");
        let is_error = value
            .get("isError")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        assert!(!is_error, "Computer-Use-MCP meldet isError");
    }

    #[test]
    #[ignore]
    fn probe_real_codex_computer_use_get_state_without_large_json() {
        let result = call_mcp_tool(
            "get_app_state",
            json!({ "app": "TextEdit" }),
            Duration::from_secs(45),
        );
        eprintln!("Computer-Use-get_state-Probe: {result:#?}");
        let value = result.expect("Computer-Use-get_state fehlgeschlagen");
        let rendered = content_to_value(value, "get_app_state");
        let text = rendered.get("text").and_then(|v| v.as_str()).unwrap_or("");
        assert!(
            text.contains("Computer Use state") || text.contains("Computer Use server error"),
            "Unerwartete get_state-Antwort: {rendered:#?}"
        );
    }
}
