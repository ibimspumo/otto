import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

/**
 * Prüft auf ein Update (GitHub Releases). Liefert null, wenn keins da ist
 * oder die Prüfung fehlschlägt (z. B. im Dev-Modus oder offline).
 */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    return await check();
  } catch {
    return null;
  }
}

/** Lädt das Update herunter, installiert es und startet die App neu. */
export async function installAndRelaunch(
  update: Update,
  onProgress?: (percent: number) => void,
): Promise<void> {
  let total = 0;
  let received = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      if (total > 0) onProgress?.(Math.round((received / total) * 100));
    }
  });
  await relaunch();
}
