// OpenAI Images API: Generierung mit Live-Streaming (Partial Images) und Edits.
//
// gpt-image-2 beherrscht flexible Größen bis 3840px Kante, aber KEINE
// Transparenz — dafür wird automatisch auf gpt-image-1 zurückgefallen.

export type Aspect = "square" | "landscape" | "portrait" | "wide";
export type Resolution = "1K" | "2K" | "4K";
export type Quality = "low" | "medium" | "high" | "auto";

export interface GenOptions {
  prompt: string;
  aspect: Aspect;
  resolution: Resolution;
  quality: Quality;
  transparent: boolean;
  /** gpt-image-2 | gpt-image-1 (OpenAI) oder OpenRouter-Slug (google/…) */
  model: string;
}

export const IMAGE_MODELS = [
  { id: "gpt-image-2", label: "GPT Image 2 (OpenAI)", provider: "openai" },
  { id: "gpt-image-1", label: "GPT Image 1 (OpenAI, kann Transparenz)", provider: "openai" },
  { id: "google/gemini-3.1-flash-image", label: "Nano Banana 2 (OpenRouter)", provider: "openrouter" },
  { id: "google/gemini-2.5-flash-image", label: "Nano Banana (OpenRouter)", provider: "openrouter" },
] as const;

export function isOpenAiImageModel(model: string): boolean {
  return model.startsWith("gpt-image");
}

export interface ImageModelInfo {
  id: string;
  label: string;
  provider: "openai" | "openrouter";
}

let openRouterModelsCache: ImageModelInfo[] | null = null;

/**
 * Lädt alle Bildmodelle der OpenRouter Unified Image API
 * (GET /api/v1/images/models) und cached sie für die App-Laufzeit.
 * Ohne Key oder bei Netzfehler bleibt die statische Liste der Fallback.
 */
export async function fetchImageModels(
  openrouterKey: string,
): Promise<ImageModelInfo[]> {
  const builtin: ImageModelInfo[] = IMAGE_MODELS.filter(
    (m) => m.provider === "openai",
  ).map((m) => ({ id: m.id, label: m.label, provider: "openai" }));
  if (!openrouterKey.trim()) {
    return [
      ...builtin,
      ...IMAGE_MODELS.filter((m) => m.provider === "openrouter").map((m) => ({
        id: m.id,
        label: m.label,
        provider: "openrouter" as const,
      })),
    ];
  }
  if (!openRouterModelsCache) {
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/images/models", {
        headers: { Authorization: `Bearer ${openrouterKey.trim()}` },
        signal: AbortSignal.timeout(20_000),
      });
      const json = await resp.json();
      const list: ImageModelInfo[] = (json?.data ?? [])
        .map((m: { id?: string; name?: string }) =>
          m.id
            ? {
                id: m.id,
                label: `${m.name ?? m.id} (OpenRouter)`,
                provider: "openrouter" as const,
              }
            : null,
        )
        .filter(Boolean);
      if (list.length > 0) openRouterModelsCache = list;
    } catch {
      // Netzfehler: statischer Fallback unten.
    }
  }
  const openrouter =
    openRouterModelsCache ??
    IMAGE_MODELS.filter((m) => m.provider === "openrouter").map((m) => ({
      id: m.id,
      label: m.label,
      provider: "openrouter" as const,
    }));
  return [...builtin, ...openrouter];
}

/**
 * Fuzzy-Suche über die Modell-Liste („nimm mal Flux“ →
 * black-forest-labs/flux…). Bewertet Treffer in id und Label.
 */
export function findImageModels(
  models: ImageModelInfo[],
  query: string,
): ImageModelInfo[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return models.slice(0, 10);
  return models
    .map((m) => {
      const hay = `${m.id} ${m.label}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (m.id.toLowerCase() === t) score += 6;
        else if (hay.includes(t)) score += 2;
      }
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.m);
}

const ASPECT_RATIOS: Record<Aspect, string> = {
  square: "1:1",
  landscape: "3:2",
  portrait: "2:3",
  wide: "16:9",
};

/** Kantenlängen: Vielfache von 16, Pixelbudget ≤ 8 294 400 (gpt-image-2). */
const SIZES: Record<Aspect, Record<Resolution, string>> = {
  square: { "1K": "1024x1024", "2K": "2048x2048", "4K": "2880x2880" },
  landscape: { "1K": "1536x1024", "2K": "2304x1536", "4K": "3456x2304" },
  portrait: { "1K": "1024x1536", "2K": "1536x2304", "4K": "2304x3456" },
  wide: { "1K": "1792x1008", "2K": "2560x1440", "4K": "3840x2160" },
};

export function resolveSize(aspect: Aspect, resolution: Resolution): string {
  return (SIZES[aspect] ?? SIZES.square)[resolution] ?? SIZES.square["1K"];
}

interface StreamEvent {
  type: string;
  b64_json?: string;
  partial_image_index?: number;
  error?: { message?: string };
}

/**
 * Generiert EIN Bild mit Streaming; Partial-Frames laufen über onPartial.
 * Für n Bilder wird die Funktion parallel n-mal aufgerufen.
 */
export async function generateImage(
  apiKey: string,
  opts: GenOptions,
  onPartial: (b64: string) => void,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    n: 1,
    size: resolveSize(opts.aspect, opts.resolution),
    quality: opts.quality,
    output_format: "png",
    stream: true,
    partial_images: 3,
  };
  if (opts.transparent) body.background = "transparent";

  // Inaktivitäts-Watchdog statt Gesamt-Timeout: Der SSE-Stream darf lange
  // laufen, aber nie STILL hängen — sonst klebt Tool, Antwort und Caption
  // für immer (der Kern des "Insel zeigt Veraltetes"-Bugs).
  const controller = new AbortController();
  let lastData = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastData > 90_000) controller.abort();
  }, 5_000);

  try {
    const resp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => null);
      throw new Error(err?.error?.message ?? `Bildgenerierung fehlgeschlagen (HTTP ${resp.status})`);
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalB64: string | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastData = Date.now();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        let event: StreamEvent;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event.type === "image_generation.partial_image" && event.b64_json) {
          onPartial(event.b64_json);
        } else if (event.type === "image_generation.completed" && event.b64_json) {
          finalB64 = event.b64_json;
        } else if (event.type === "error") {
          throw new Error(event.error?.message ?? "Bildgenerierung fehlgeschlagen.");
        }
      }
    }

    if (!finalB64) throw new Error("Kein Bild empfangen.");
    return finalB64;
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error("Bildgenerierung abgebrochen: keine Daten vom Server (Timeout).");
    }
    throw e;
  } finally {
    clearInterval(watchdog);
  }
}

function blobFromB64(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

export interface EditOptions {
  prompt: string;
  n: number;
  quality: Quality;
  size?: string;
  model: string;
}

/**
 * OpenRouter Unified Image API (Nano Banana & Co.): Generierung und — über
 * input_references — auch Bearbeitung. Kein Partial-Streaming, keine Transparenz.
 */
export async function generateImagesOpenRouter(
  apiKey: string,
  opts: {
    model: string;
    prompt: string;
    n: number;
    aspect: Aspect;
    resolution: Resolution;
    inputRefsB64?: string[];
  },
): Promise<string[]> {
  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    n: opts.n,
    resolution: opts.resolution,
    aspect_ratio: ASPECT_RATIOS[opts.aspect] ?? "1:1",
    output_format: "png",
  };
  if (opts.inputRefsB64?.length) {
    body.input_references = opts.inputRefsB64.map(
      (b64) => `data:image/png;base64,${b64}`,
    );
  }

  const resp = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(
      json?.error?.message ?? `OpenRouter-Bildgenerierung fehlgeschlagen (HTTP ${resp.status})`,
    );
  }
  const images: string[] = (json?.data ?? [])
    .map((d: { b64_json?: string; url?: string }) => {
      if (d.b64_json) return d.b64_json;
      // Manche Provider liefern data:-URLs statt b64_json.
      if (d.url?.startsWith("data:")) return d.url.split(",")[1];
      return null;
    })
    .filter(Boolean);
  if (images.length === 0) throw new Error("Keine Bilder von OpenRouter empfangen.");
  return images;
}

/** Bearbeitet ein oder mehrere Ausgangsbilder (OpenAI); liefert n neue Bilder (b64). */
export async function editImages(
  apiKey: string,
  baseImagesB64: string[],
  opts: EditOptions,
): Promise<string[]> {
  const form = new FormData();
  form.append("model", opts.model);
  form.append("prompt", opts.prompt);
  form.append("n", String(opts.n));
  form.append("quality", opts.quality);
  form.append("output_format", "png");
  if (opts.size) form.append("size", opts.size);
  baseImagesB64.forEach((b64, i) => {
    form.append("image[]", blobFromB64(b64), `bild-${i + 1}.png`);
  });

  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(300_000),
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(json?.error?.message ?? `Bildbearbeitung fehlgeschlagen (HTTP ${resp.status})`);
  }
  const images: string[] = (json?.data ?? [])
    .map((d: { b64_json?: string }) => d.b64_json)
    .filter(Boolean);
  if (images.length === 0) throw new Error("Keine bearbeiteten Bilder empfangen.");
  return images;
}
