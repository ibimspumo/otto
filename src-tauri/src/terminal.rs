fn truncate_output(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…\n[gekürzt, {} Zeichen insgesamt]", &s[..max], s.len())
    }
}

#[tauri::command]
pub async fn run_terminal(
    app: tauri::AppHandle,
    command: String,
    timeout_s: Option<u64>,
) -> Result<serde_json::Value, String> {
    // YOLO-Modus: voller Systemzugriff wie ein normales Terminal — der
    // Befehls-Filter entfällt. Sonst gilt die restriktive Positivliste.
    if !crate::settings::yolo_enabled(&app) {
        crate::shell_safety::validate_shell_command(&command)?;
    }
    let timeout = std::time::Duration::from_secs(timeout_s.unwrap_or(30).clamp(1, 300));
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("/bin/zsh");
        cmd.args(["-lc", &command])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Start fehlgeschlagen: {e}"))?;
        let pid = child.id() as i32;

        // Pipes SOFORT in eigenen Threads leeren: Ein Kind, das mehr als
        // ~64 KB schreibt, blockiert sonst am vollen Pipe-Puffer und läuft
        // zwangsläufig in den Timeout (Deadlock).
        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();
        let stdout_thread = std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = Vec::new();
            if let Some(mut p) = stdout_pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        });
        let stderr_thread = std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = Vec::new();
            if let Some(mut p) = stderr_pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        });

        let deadline = std::time::Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        unsafe {
                            libc::kill(-pid, libc::SIGKILL);
                        }
                        let _ = child.wait();
                        return Err(format!(
                            "Timeout nach {} s — Befehl abgebrochen.",
                            timeout.as_secs()
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(e) => return Err(e.to_string()),
            }
        };
        let stdout = stdout_thread.join().unwrap_or_default();
        let stderr = stderr_thread.join().unwrap_or_default();
        Ok(serde_json::json!({
            "exit_code": status.code(),
            "stdout": truncate_output(&String::from_utf8_lossy(&stdout), 8000),
            "stderr": truncate_output(&String::from_utf8_lossy(&stderr), 4000),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}
