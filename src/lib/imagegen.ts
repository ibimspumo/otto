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

  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
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
