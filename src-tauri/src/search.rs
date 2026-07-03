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
