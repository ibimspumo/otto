// Hintergrund-Recherche: OpenAI Responses API im Background Mode mit
// Deep-Research-Modell + Web-Suche. Otto startet den Lauf, bleibt
// gesprächsbereit und bekommt das Ergebnis wie ein Job-Resultat.

const RESEARCH_MODEL = "o4-mini-deep-research";

interface ResponsesJson {
  id?: string;
  status?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { message?: string };
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey.trim()}`,
    "Content-Type": "application/json",
  };
}

function extractText(json: ResponsesJson): string {
  if (json.output_text?.trim()) return json.output_text.trim();
  const parts: string[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && c.text) parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

export async function startResearch(
  apiKey: string,
  question: string,
  model?: string,
): Promise<string> {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model: model?.trim() || RESEARCH_MODEL,
      input: question,
      background: true,
      tools: [{ type: "web_search_preview" }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await resp.json().catch(() => null)) as ResponsesJson | null;
  if (!resp.ok || !json?.id) {
    throw new Error(
      json?.error?.message ?? `Recherche-Start fehlgeschlagen (HTTP ${resp.status})`,
    );
  }
  return json.id;
}

export interface ResearchStatus {
  status: string;
  text: string;
  error?: string;
}

export async function pollResearch(
  apiKey: string,
  responseId: string,
): Promise<ResearchStatus> {
  const resp = await fetch(
    `https://api.openai.com/v1/responses/${encodeURIComponent(responseId)}`,
    { headers: headers(apiKey), signal: AbortSignal.timeout(30_000) },
  );
  const json = (await resp.json().catch(() => null)) as ResponsesJson | null;
  if (!resp.ok || !json) {
    throw new Error(
      json?.error?.message ?? `Recherche-Status fehlgeschlagen (HTTP ${resp.status})`,
    );
  }
  return {
    status: json.status ?? "unknown",
    text: extractText(json),
    error: json.error?.message,
  };
}

export async function cancelResearch(
  apiKey: string,
  responseId: string,
): Promise<void> {
  await fetch(
    `https://api.openai.com/v1/responses/${encodeURIComponent(responseId)}/cancel`,
    { method: "POST", headers: headers(apiKey), signal: AbortSignal.timeout(30_000) },
  ).catch(() => {});
}
