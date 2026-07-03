// Sichtbare Jobs für Terminal-Läufe und lokale CLI-Agenten (Codex/Claude).
//
// delegate_task startet einen Job und kehrt sofort mit einer job_id zurück —
// Nicht-blockierende Läufe kehren sofort mit job_id zurück. Wartende Terminal-
// Läufe nutzen dieselbe Infrastruktur, warten im Frontend aber auf "cli-done".
// Fortschritt kommt zeilenweise als "cli-line"-Event, das Endergebnis als
// "cli-done"-Event.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::Emitter;

/// Sicherheitsnetz gegen vergessene Jobs — danach wird hart beendet.
const MAX_RUNTIME_SECS: u64 = 1800;
const MAX_OUTPUT_CHARS: usize = 200_000;
const CLI_PATH_SETUP: &str = concat!(
    r#"PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:"#,
    r#"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin"; export PATH; "#
);

fn jobs() -> &'static Mutex<HashMap<String, i32>> {
    static JOBS: OnceLock<Mutex<HashMap<String, i32>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancelled() -> &'static Mutex<HashSet<String>> {
    static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn done_results() -> &'static Mutex<HashMap<String, CliDone>> {
    static DONE_RESULTS: OnceLock<Mutex<HashMap<String, CliDone>>> = OnceLock::new();
    DONE_RESULTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    path.to_string()
}

fn truncate_tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // Bei Agent-Ausgaben ist das Ende (Fazit/Antwort) das Wichtigste.
    let cut = s.len() - max;
    let start = s
        .char_indices()
        .map(|(i, _)| i)
        .find(|&i| i >= cut)
        .unwrap_or(0);
    format!("[…{} Zeichen gekürzt]\n{}", cut, &s[start..])
}

#[derive(Serialize, Clone)]
struct CliLine {
    job_id: String,
    agent: String,
    line: String,
}

#[derive(Serialize, Clone)]
pub struct CliDone {
    job_id: String,
    agent: String,
    task: String,
    exit_code: Option<i32>,
    output: String,
    stderr: String,
    cancelled: bool,
    report_on_done: bool,
}

fn kill_group(pid: i32, signal: i32) {
    unsafe {
        // Negative PID = ganze Prozessgruppe (zsh + Agent + dessen Kinder).
        libc::kill(-pid, signal);
    }
}

/// Beim App-Ende alle laufenden Job-Prozessgruppen mitnehmen — sonst
/// überleben Codex/Claude/Shell-Kinder als Waisen.
pub fn kill_all_jobs() {
    if let Ok(map) = jobs().lock() {
        for pid in map.values() {
            kill_group(*pid, libc::SIGKILL);
        }
    }
}

fn start_job(
    app: tauri::AppHandle,
    agent: String,
    task: String,
    dir: String,
    cmdline: String,
    report_on_done: bool,
) -> Result<String, String> {
    if !std::path::Path::new(&dir).is_dir() {
        return Err(format!("Arbeitsverzeichnis existiert nicht: {dir}"));
    }

    let mut cmd = Command::new("/bin/zsh");
    cmd.args(["-lc", &cmdline])
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Start fehlgeschlagen: {e}"))?;
    let pid = child.id() as i32;

    static SEQ: AtomicU64 = AtomicU64::new(0);
    let job_id = format!("job-{}", SEQ.fetch_add(1, Ordering::Relaxed) + 1);
    jobs().lock().unwrap().insert(job_id.clone(), pid);

    let stdout = child.stdout.take().ok_or("Kein stdout-Handle")?;
    let stderr = child.stderr.take().ok_or("Kein stderr-Handle")?;
    let out_buf = Arc::new(Mutex::new(String::new()));
    let err_buf = Arc::new(Mutex::new(String::new()));

    // stdout: zeilenweise sammeln + live an die Aktivitätsanzeige.
    let out_reader = {
        let app = app.clone();
        let job_id = job_id.clone();
        let agent = agent.clone();
        let out_buf = Arc::clone(&out_buf);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                {
                    let mut buf = out_buf.lock().unwrap();
                    if buf.len() < MAX_OUTPUT_CHARS {
                        buf.push_str(&line);
                        buf.push('\n');
                    }
                }
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    let _ = app.emit(
                        "cli-line",
                        CliLine {
                            job_id: job_id.clone(),
                            agent: agent.clone(),
                            line: trimmed.chars().take(160).collect(),
                        },
                    );
                }
            }
        })
    };
    let err_reader = {
        let err_buf = Arc::clone(&err_buf);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut buf = err_buf.lock().unwrap();
                if buf.len() < MAX_OUTPUT_CHARS {
                    buf.push_str(&line);
                    buf.push('\n');
                }
            }
        })
    };

    // Watchdog: nach MAX_RUNTIME_SECS hart beenden, falls der Job noch lebt.
    {
        let job_id = job_id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(MAX_RUNTIME_SECS));
            if jobs().lock().unwrap().contains_key(&job_id) {
                cancelled().lock().unwrap().insert(job_id.clone());
                kill_group(pid, libc::SIGKILL);
            }
        });
    }

    // Warten + Abschluss-Event.
    {
        let job_id = job_id.clone();
        let agent = agent.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let _ = out_reader.join();
            let _ = err_reader.join();
            jobs().lock().unwrap().remove(&job_id);
            let was_cancelled = cancelled().lock().unwrap().remove(&job_id);
            let output = truncate_tail(&out_buf.lock().unwrap(), 12_000);
            let stderr_out = truncate_tail(&err_buf.lock().unwrap(), 4_000);
            let done = CliDone {
                job_id: job_id.clone(),
                agent,
                task,
                exit_code: status.ok().and_then(|s| s.code()),
                output,
                stderr: stderr_out,
                cancelled: was_cancelled,
                report_on_done,
            };
            {
                let mut results = done_results().lock().unwrap();
                if results.len() > 100 {
                    if let Some(oldest) = results.keys().next().cloned() {
                        results.remove(&oldest);
                    }
                }
                results.insert(job_id, done.clone());
            }
            let _ = app.emit("cli-done", done);
        });
    }

    Ok(job_id)
}

#[tauri::command]
pub fn cli_job_start(
    app: tauri::AppHandle,
    agent: String,
    task: String,
    cwd: Option<String>,
    report_on_done: Option<bool>,
) -> Result<String, String> {
    let task = task.trim().to_string();
    if task.is_empty() {
        return Err("Leere Aufgabe.".into());
    }
    // YOLO-Modus: die CLI-Agenten bekommen vollen System-/Netzzugriff,
    // Shell-Jobs laufen ohne Befehls-Filter.
    let yolo = crate::settings::yolo_enabled(&app);
    let cmdline = match agent.as_str() {
        "codex" => {
            let sandbox = if yolo { "danger-full-access" } else { "workspace-write" };
            format!(
                "{CLI_PATH_SETUP}codex exec -s {sandbox} --skip-git-repo-check {}",
                shell_quote(&task)
            )
        }
        "claude" => {
            let perm = if yolo {
                "--dangerously-skip-permissions"
            } else {
                "--permission-mode acceptEdits"
            };
            format!("{CLI_PATH_SETUP}claude -p {} {perm}", shell_quote(&task))
        }
        // Terminal: task IST der Shell-Befehl. Gleiche Infrastruktur wie die
        // CLI-Agenten (Streaming, Cancel, Watchdog).
        "shell" => {
            if !yolo {
                crate::shell_safety::validate_shell_command(&task)?;
            }
            format!("{CLI_PATH_SETUP}{task}")
        }
        other => return Err(format!("Unbekannter Agent: {other} (codex, claude oder shell)")),
    };
    let dir = cwd
        .map(|d| expand_tilde(d.trim()))
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/".into()));
    start_job(app, agent, task, dir, cmdline, report_on_done.unwrap_or(true))
}

#[tauri::command]
pub fn cli_job_result(job_id: String) -> Result<Option<CliDone>, String> {
    Ok(done_results().lock().unwrap().get(&job_id).cloned())
}

/// Spezialpfad für Codex' eingebaute imagegen-Skill. Er benutzt `--image … --`
/// als echte CLI-Argumentgrenze; sonst kann ein Bildpfad den Prompt schlucken.
#[tauri::command]
pub fn codex_image_job_start(
    app: tauri::AppHandle,
    task: String,
    image_paths: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let task = task.trim().to_string();
    if task.is_empty() {
        return Err("Leere Aufgabe.".into());
    }
    let dir = if let Some(cwd) = cwd.map(|d| expand_tilde(d.trim())).filter(|d| !d.is_empty()) {
        cwd
    } else {
        let dir = std::env::temp_dir().join("otto-codex-imagegen");
        std::fs::create_dir_all(&dir).map_err(|e| format!("Arbeitsordner fehlt: {e}"))?;
        dir.to_string_lossy().to_string()
    };
    let mut images = Vec::new();
    for raw in image_paths {
        let path = expand_tilde(raw.trim());
        if path.is_empty() {
            continue;
        }
        if !std::path::Path::new(&path).is_file() {
            return Err(format!("Bilddatei existiert nicht: {path}"));
        }
        images.push(path);
    }
    let yolo = crate::settings::yolo_enabled(&app);
    let sandbox = if yolo { "danger-full-access" } else { "workspace-write" };
    let mut cmdline = format!(
        "{CLI_PATH_SETUP}codex exec --json --ephemeral --ignore-rules -s {sandbox} --skip-git-repo-check -C {} ",
        shell_quote(&dir)
    );
    if !images.is_empty() {
        cmdline.push_str("--image ");
        for image in &images {
            cmdline.push_str(&shell_quote(image));
            cmdline.push(' ');
        }
    }
    cmdline.push_str("-- ");
    cmdline.push_str(&shell_quote(&task));
    start_job(app, "codex-image".into(), task, dir, cmdline, true)
}

#[tauri::command]
pub fn cli_job_cancel(job_id: String) -> Result<Vec<String>, String> {
    let targets: Vec<(String, i32)> = {
        let map = jobs().lock().unwrap();
        if job_id == "all" {
            map.iter().map(|(k, v)| (k.clone(), *v)).collect()
        } else {
            map.get(&job_id)
                .map(|pid| vec![(job_id.clone(), *pid)])
                .unwrap_or_default()
        }
    };
    if targets.is_empty() {
        return Err(if job_id == "all" {
            "Keine laufenden Jobs.".into()
        } else {
            format!("Job {job_id} läuft nicht (mehr).")
        });
    }
    for (id, pid) in &targets {
        cancelled().lock().unwrap().insert(id.clone());
        kill_group(*pid, libc::SIGTERM);
        // Nachfassen, falls SIGTERM ignoriert wird.
        let pid = *pid;
        let id = id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            if jobs().lock().unwrap().contains_key(&id) {
                kill_group(pid, libc::SIGKILL);
            }
        });
    }
    Ok(targets.into_iter().map(|(id, _)| id).collect())
}

/// Prüft, welche CLI-Agenten auf diesem Mac installiert sind (Login-Shell-PATH).
#[tauri::command]
pub async fn cli_available() -> Result<serde_json::Value, String> {
    fn has(bin: &str) -> bool {
        Command::new("/bin/zsh")
            .args(["-lc", &format!("{CLI_PATH_SETUP}command -v {bin}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    tauri::async_runtime::spawn_blocking(|| {
        serde_json::json!({ "codex": has("codex"), "claude": has("claude") })
    })
    .await
    .map_err(|e| e.to_string())
}
