fn truncate_output(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…\n[gekürzt, {} Zeichen insgesamt]", &s[..max], s.len())
    }
}

#[tauri::command]
pub async fn run_terminal(
    command: String,
    timeout_s: Option<u64>,
) -> Result<serde_json::Value, String> {
    crate::shell_safety::validate_shell_command(&command)?;
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

        let deadline = std::time::Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
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
        }
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "exit_code": output.status.code(),
            "stdout": truncate_output(&String::from_utf8_lossy(&output.stdout), 8000),
            "stderr": truncate_output(&String::from_utf8_lossy(&output.stderr), 4000),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}
