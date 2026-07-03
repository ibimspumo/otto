// Dokument-Input: "Otto, lies dieses PDF."
//
// Läuft über OpenRouter (file-Content-Type funktioniert modellübergreifend);
// Gemini Flash liest PDFs nativ — abgerechnet als normale Input-Tokens,
// keine separaten OCR-Gebühren für digitale PDFs.

const DOC_MODEL = "google/gemini-3.1-flash-lite";

export async function analyzeDocument(
  openrouterKey: string,
  file: { dataUrl?: string; url?: string; filename: string },
  frage: string,
): Promise<string> {
  const filePart = {
    type: "file",
    file: {
      filename: file.filename,
      file_data: file.dataUrl ?? file.url,
    },
  };
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterKey.trim()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/agentz/otto",
      "X-Title": "Otto",
    },
    body: JSON.stringify({
      model: DOC_MODEL,
      messages: [
        {
          role: "user",
          content: [
            filePart,
            {
              type: "text",
              text:
                frage.trim() ||
                "Fasse dieses Dokument strukturiert auf Deutsch zusammen: Zweck, Kernaussagen, wichtige Zahlen/Fristen/Klauseln. Nutze Markdown mit Abschnitten.",
            },
          ],
        },
      ],
      max_completion_tokens: 4000,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(
      json?.error?.message ?? `Dokument-Analyse fehlgeschlagen (HTTP ${resp.status})`,
    );
  }
  const content = String(json?.choices?.[0]?.message?.content ?? "").trim();
  if (!content) throw new Error("Dokument-Analyse lieferte keine Antwort.");
  return content;
}
