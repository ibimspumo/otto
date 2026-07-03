// Bild-Aufbereitung für den Realtime-Bild-Input ("Otto sieht").
//
// Screenshots aus der Zwischenablage (⌘⇧⌃4) kommen als PNG oder TIFF —
// WebKit dekodiert beides nativ. Vor dem Senden wird auf eine sinnvolle
// Kantenlänge skaliert und als JPEG kodiert: spart massiv Tokens, und
// UI-Text bleibt bei ~1600 px problemlos lesbar.

const MAX_EDGE = 1600;

export async function prepareImageForRealtime(
  b64: string,
  format: string,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const mime = format === "tiff" ? "image/tiff" : "image/png";
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Bild aus der Zwischenablage ließ sich nicht dekodieren."));
    img.src = `data:${mime};base64,${b64}`;
  });
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas nicht verfügbar.");
  ctx.drawImage(img, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.85), width: w, height: h };
}
