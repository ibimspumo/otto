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

#[tauri::command]
pub async fn brave_search(
    query: String,
    api_key: String,
    count: Option<u32>,
) -> Result<serde_json::Value, String> {
    if api_key.trim().is_empty() {
        return Err("Kein Brave-API-Key hinterlegt.".into());
    }
    let count = count.unwrap_or(6).clamp(1, 20);
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.search.brave.com/res/v1/web/search")
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

    let mut results = Vec::new();
    if let Some(items) = body.pointer("/web/results").and_then(|v| v.as_array()) {
        for r in items.iter().take(count as usize) {
            let get = |p: &str| r.pointer(p).and_then(|v| v.as_str()).unwrap_or("");
            results.push(serde_json::json!({
                "title": strip_tags(get("/title")),
                "url": get("/url"),
                "description": strip_tags(get("/description")),
                "age": r.pointer("/age").and_then(|v| v.as_str()),
                "host": r.pointer("/meta_url/hostname").and_then(|v| v.as_str()),
            }));
        }
    }
    Ok(serde_json::json!({ "query": query, "results": results }))
}
