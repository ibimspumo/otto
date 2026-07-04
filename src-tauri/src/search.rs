use reqwest::header::{ACCEPT, CONTENT_TYPE, USER_AGENT};
use std::time::Duration;

const FETCH_TIMEOUT_SECS: u64 = 15;
const FETCH_MAX_BYTES: usize = 1_500_000;
const FETCH_DEFAULT_CHARS: usize = 12_000;
const FETCH_MAX_CHARS: usize = 20_000;
const FETCH_USER_AGENT: &str = "Otto-Recherche/1.0";

fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for c in input.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn html_entity(input: &str) -> Option<char> {
    match input {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        "ndash" => Some('-'),
        "mdash" => Some('-'),
        "hellip" => Some('…'),
        "lsquo" | "rsquo" => Some('\''),
        "ldquo" | "rdquo" => Some('"'),
        _ => {
            if let Some(hex) = input.strip_prefix("#x").or_else(|| input.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(dec) = input.strip_prefix('#') {
                dec.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                None
            }
        }
    }
}

fn decode_html_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '&' {
            let mut end = i + 1;
            while end < chars.len() && end - i <= 12 && chars[end] != ';' {
                end += 1;
            }
            if end < chars.len() && chars[end] == ';' {
                let name: String = chars[i + 1..end].iter().collect();
                if let Some(decoded) = html_entity(&name) {
                    out.push(decoded);
                    i = end + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn collapse_inline_ws(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut pending_space = false;
    for c in line.chars() {
        if c.is_whitespace() {
            pending_space = true;
        } else {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            out.push(c);
            pending_space = false;
        }
    }
    out
}

fn normalize_text(input: &str) -> String {
    let decoded = decode_html_entities(input).replace('\r', "\n");
    let mut lines = Vec::new();
    for raw in decoded.lines() {
        let line = collapse_inline_ws(raw).trim().to_string();
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines.join("\n")
}

fn tag_name(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('/')
        .trim_start_matches('!')
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn is_block_tag(name: &str) -> bool {
    matches!(
        name,
        "article"
            | "aside"
            | "blockquote"
            | "br"
            | "dd"
            | "div"
            | "dt"
            | "figcaption"
            | "figure"
            | "footer"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "hr"
            | "li"
            | "main"
            | "nav"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "table"
            | "tbody"
            | "td"
            | "tfoot"
            | "th"
            | "thead"
            | "tr"
            | "ul"
    )
}

fn html_to_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len().min(FETCH_DEFAULT_CHARS));
    let mut chars = input.chars();
    let mut skip_until: Option<String> = None;

    while let Some(c) = chars.next() {
        if c == '<' {
            let mut raw_tag = String::new();
            while let Some(next) = chars.next() {
                if next == '>' {
                    break;
                }
                if raw_tag.len() < 160 {
                    raw_tag.push(next);
                }
            }
            let trimmed = raw_tag.trim();
            let closing = trimmed.starts_with('/');
            let name = tag_name(trimmed);

            if let Some(skip) = skip_until.as_ref() {
                if closing && &name == skip {
                    skip_until = None;
                }
                continue;
            }

            if !closing
                && matches!(
                    name.as_str(),
                    "script" | "style" | "noscript" | "svg" | "canvas" | "head"
                )
            {
                skip_until = Some(name);
                continue;
            }

            if name == "li" && !closing {
                out.push('\n');
                out.push_str("- ");
            } else if is_block_tag(&name) {
                out.push('\n');
            } else {
                out.push(' ');
            }
            continue;
        }

        if skip_until.is_none() {
            out.push(c);
        }
    }

    normalize_text(&out)
}

fn extract_title(input: &str) -> Option<String> {
    let lower = input.to_ascii_lowercase();
    let title_start = lower.find("<title")?;
    let content_start = title_start + lower[title_start..].find('>')? + 1;
    let rel_end = lower[content_start..].find("</title>")?;
    let raw = &input[content_start..content_start + rel_end];
    let title = normalize_text(&strip_tags(raw));
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

fn looks_like_html(content_type: &str, body: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("html") {
        return true;
    }
    let trimmed = body.trim_start().to_ascii_lowercase();
    trimmed.starts_with("<!doctype html") || trimmed.starts_with("<html")
}

fn is_readable_content_type(content_type: &str) -> bool {
    if content_type.trim().is_empty() {
        return true;
    }
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    ct.starts_with("text/")
        || ct == "application/json"
        || ct == "application/ld+json"
        || ct == "application/xml"
        || ct == "application/xhtml+xml"
        || ct == "application/rss+xml"
        || ct == "application/atom+xml"
        || ct.ends_with("+xml")
}

fn truncate_chars(input: &str, max_chars: usize) -> (String, bool) {
    let mut out = String::with_capacity(input.len().min(max_chars));
    for (idx, c) in input.chars().enumerate() {
        if idx >= max_chars {
            return (out, true);
        }
        out.push(c);
    }
    (out, false)
}

/// Ein Brave-Treffer, auf ein gemeinsames Format normalisiert — egal ob
/// Web, News, Bilder oder Videos.
fn normalize_result(r: &serde_json::Value, search_type: &str) -> serde_json::Value {
    let get = |p: &str| r.pointer(p).and_then(|v| v.as_str()).unwrap_or("");
    let thumbnail = r
        .pointer("/thumbnail/src")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let description = match search_type {
        // Bild-Treffer haben keine Beschreibung; Videos tragen sie unter /description.
        "images" => String::new(),
        _ => strip_tags(get("/description")),
    };
    serde_json::json!({
        "title": strip_tags(get("/title")),
        "url": get("/url"),
        "description": description,
        "age": r.pointer("/age").and_then(|v| v.as_str()),
        "host": r.pointer("/meta_url/hostname").and_then(|v| v.as_str()),
        "thumbnail": thumbnail,
        "duration": r.pointer("/video/duration").and_then(|v| v.as_str()),
    })
}

#[tauri::command]
pub async fn brave_search(
    query: String,
    api_key: String,
    count: Option<u32>,
    search_type: Option<String>,
) -> Result<serde_json::Value, String> {
    if api_key.trim().is_empty() {
        return Err("Kein Brave-API-Key hinterlegt.".into());
    }
    let count = count.unwrap_or(6).clamp(1, 20);
    let search_type = match search_type.as_deref() {
        Some("news") => "news",
        Some("images") | Some("bilder") => "images",
        Some("videos") => "videos",
        _ => "web",
    };
    let endpoint = format!("https://api.search.brave.com/res/v1/{search_type}/search");
    // Ohne Timeout kann ein hängender Request Tool + Antwort einfrieren.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&endpoint)
        .query(&[("q", query.as_str()), ("count", &count.to_string())])
        .header("X-Subscription-Token", api_key.trim())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Netzwerkfehler: {e}"))?;

    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Ungültige Antwort der Brave API: {e}"))?;

    if !status.is_success() {
        let detail = body
            .pointer("/error/detail")
            .and_then(|v| v.as_str())
            .unwrap_or("unbekannter Fehler");
        return Err(format!("Brave API {status}: {detail}"));
    }

    // Web-Suche verschachtelt die Treffer unter /web/results, die
    // Spezial-Endpoints liefern sie direkt unter /results.
    let items_path = if search_type == "web" { "/web/results" } else { "/results" };
    let mut results = Vec::new();
    if let Some(items) = body.pointer(items_path).and_then(|v| v.as_array()) {
        for r in items.iter().take(count as usize) {
            results.push(normalize_result(r, search_type));
        }
    }
    Ok(serde_json::json!({ "query": query, "type": search_type, "results": results }))
}

#[tauri::command]
pub async fn web_fetch(url: String, max_chars: Option<u32>) -> Result<serde_json::Value, String> {
    let url = url.trim();
    let parsed = reqwest::Url::parse(url).map_err(|_| "Ungültige URL.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("web_fetch erlaubt nur http:// und https:// URLs.".into());
    }

    let max_chars = max_chars
        .unwrap_or(FETCH_DEFAULT_CHARS as u32)
        .clamp(1_000, FETCH_MAX_CHARS as u32) as usize;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| e.to_string())?;

    let mut resp = client
        .get(parsed)
        .header(USER_AGENT, FETCH_USER_AGENT)
        .header(
            ACCEPT,
            "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.2",
        )
        .send()
        .await
        .map_err(|e| format!("Netzwerkfehler: {e}"))?;

    let status = resp.status();
    let final_url = resp.url().to_string();
    if !matches!(resp.url().scheme(), "http" | "https") {
        return Err("Weiterleitung auf ein nicht erlaubtes URL-Schema blockiert.".into());
    }
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let declared_len = resp.content_length();

    if !status.is_success() {
        return Err(format!("Abruf fehlgeschlagen: HTTP {status}."));
    }
    if !is_readable_content_type(&content_type) {
        return Err(format!(
            "Die URL liefert keinen direkt lesbaren Text ({content_type})."
        ));
    }
    if declared_len.is_some_and(|len| len > FETCH_MAX_BYTES as u64) {
        return Err(format!(
            "Die Seite ist zu groß (Limit: {} KB).",
            FETCH_MAX_BYTES / 1000
        ));
    }

    let mut body = Vec::new();
    let mut body_truncated = false;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Lesefehler: {e}"))?
    {
        if body.len() + chunk.len() > FETCH_MAX_BYTES {
            let remaining = FETCH_MAX_BYTES.saturating_sub(body.len());
            if remaining > 0 {
                body.extend_from_slice(&chunk[..remaining]);
            }
            body_truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }

    let raw = String::from_utf8_lossy(&body);
    let is_html = looks_like_html(&content_type, &raw);
    let title = if is_html { extract_title(&raw) } else { None };
    let text = if is_html {
        html_to_text(&raw)
    } else {
        normalize_text(&raw)
    };
    let text_chars = text.chars().count();
    let (text, text_truncated) = truncate_chars(&text, max_chars);
    let returned_chars = text.chars().count();

    Ok(serde_json::json!({
        "url": url,
        "final_url": final_url,
        "status": status.as_u16(),
        "content_type": content_type,
        "title": title,
        "text": text,
        "text_chars": text_chars,
        "returned_chars": returned_chars,
        "bytes_read": body.len(),
        "truncated": body_truncated || text_truncated,
        "body_truncated": body_truncated,
        "limit_bytes": FETCH_MAX_BYTES,
        "limit_chars": max_chars,
    }))
}
