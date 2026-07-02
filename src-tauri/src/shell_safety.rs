const BLOCKED_TOKENS: &[&str] = &[
    "sudo",
    "su",
    "rm",
    "rmdir",
    "mv",
    "chmod",
    "chown",
    "chgrp",
    "dd",
    "mkfs",
    "diskutil",
    "launchctl",
    "kill",
    "killall",
    "pkill",
    "curl",
    "wget",
    "nc",
    "ncat",
    "ssh",
    "scp",
    "rsync",
    "osascript",
];

const ALLOWED_OSASCRIPT_SNIPPETS: &[&str] = &[
    "tell application \"Spotify\"",
    "tell application \"Music\"",
    "set volume",
    "output volume",
];

fn has_shell_metachar_pipeline(command: &str) -> bool {
    let lowered = command.to_ascii_lowercase();
    lowered.contains("| sh")
        || lowered.contains("|sh")
        || lowered.contains("| bash")
        || lowered.contains("|bash")
        || lowered.contains("$(curl")
        || lowered.contains("$(wget")
        || lowered.contains("`curl")
        || lowered.contains("`wget")
}

fn tokenize(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for c in command.chars() {
        if escaped {
            current.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                current.push(c);
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            continue;
        }
        if c.is_whitespace() || matches!(c, ';' | '&' | '|' | '<' | '>' | '(' | ')') {
            if !current.is_empty() {
                tokens.push(current.clone());
                current.clear();
            }
        } else {
            current.push(c);
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

pub fn validate_shell_command(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("Leerer Befehl.".into());
    }
    if trimmed.len() > 4_000 {
        return Err("Terminal-Befehl ist zu lang.".into());
    }
    if has_shell_metachar_pipeline(trimmed) {
        return Err("Aus Sicherheitsgründen blockiert: Download-zu-Shell-Pipeline.".into());
    }
    let lowered = trimmed.to_ascii_lowercase();
    if lowered.contains(">>")
        || lowered.contains(">/")
        || lowered.contains("> /")
        || lowered.contains(" 2>")
        || lowered.contains("&>")
    {
        return Err("Aus Sicherheitsgründen blockiert: Datei-Umleitungen sind im direkten Terminal-Tool nicht erlaubt.".into());
    }
    let allowed_osascript = lowered.contains("osascript")
        && ALLOWED_OSASCRIPT_SNIPPETS
            .iter()
            .any(|snippet| lowered.contains(&snippet.to_ascii_lowercase()));
    if lowered.contains("osascript") && !allowed_osascript {
        return Err("Aus Sicherheitsgründen blockiert: AppleScript ist nur für erlaubte System-/Mediensteuerung direkt zugelassen.".into());
    }
    for token in tokenize(trimmed) {
        let base = token.rsplit('/').next().unwrap_or(&token).to_ascii_lowercase();
        if base == "osascript" && allowed_osascript {
            continue;
        }
        if BLOCKED_TOKENS.iter().any(|blocked| *blocked == base) {
            return Err(format!(
                "Aus Sicherheitsgründen blockiert: „{base}“ darf nicht über das direkte Terminal-Tool laufen."
            ));
        }
    }
    Ok(())
}
