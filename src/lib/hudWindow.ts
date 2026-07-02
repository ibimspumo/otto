// Fensterlogik der Systemschicht.
//
// Drei Fenster: die Insel (Label "main") — eine schwarze Kapsel, die oben
// mittig aus dem Notch wächst —, die Drops (Label "panel") — ein Stapel
// kleiner Live-Thumbnails unten links, der per Quick Look zur Vollansicht
// aufgeht — und die Einstellungen (Label "settings", echtes macOS-Fenster).

import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

async function anyMonitor(): Promise<Monitor | null> {
  return (await currentMonitor()) ?? (await primaryMonitor());
}

// ------------------------------------------------------------------
// Die Insel — Kapsel am Notch, wächst mit ihrem Inhalt
// ------------------------------------------------------------------

/** compact = nur der Kern; wide = Kern + Caption/Controls. */
export type IslandMode = "compact" | "wide";

// Fenstermaße (logische Punkte). Die Kapsel sitzt am oberen Fensterrand,
// darunter bleibt Luft, in die das Zustandslicht ausstrahlen kann.
const ISLAND_SIZE: Record<IslandMode, { w: number; h: number }> = {
  compact: { w: 52, h: 52 },
  wide: { w: 560, h: 56 },
};

/** Abstand der Pille zur Unterkante von Notch/Menüleiste. */
const ISLAND_GAP = 6;

// Höhe von Notch/Menüleiste (Safe Area) — einmal pro Laufzeit aus AppKit.
let topInsetCache: number | null = null;
async function topInset(): Promise<number> {
  if (topInsetCache !== null) return topInsetCache;
  try {
    topInsetCache = await invoke<number>("top_inset");
  } catch {
    topInsetCache = 38;
  }
  return topInsetCache;
}

/**
 * Positioniert die Insel oben mittig als schwebende Pille direkt UNTER
 * Notch/Menüleiste — auf Notch-Macs würde eine Kapsel an der Kante wie
 * eine zweite Notch aussehen (Doppel-Notch-Effekt), deshalb der Abstand.
 */
export async function layoutIsland(mode: IslandMode): Promise<void> {
  try {
    const win = getCurrentWindow();
    const monitor = await anyMonitor();
    if (!monitor) return;
    const sf = monitor.scaleFactor;
    const inset = await topInset();
    const w = Math.round(ISLAND_SIZE[mode].w * sf);
    const h = Math.round(ISLAND_SIZE[mode].h * sf);
    const x = Math.round(monitor.position.x + (monitor.size.width - w) / 2);
    const y = Math.round(monitor.position.y + (inset + ISLAND_GAP) * sf);
    await win.setSize(new PhysicalSize(w, h));
    await win.setPosition(new PhysicalPosition(x, y));
  } catch {
    // Fenstergeometrie ist Komfort — nie die App blockieren.
  }
}

export async function showIsland(): Promise<void> {
  try {
    const win = getCurrentWindow();
    await layoutIsland("compact");
    await win.show();
    await win.setFocus();
  } catch {
    // Ignorieren.
  }
}

export async function hideIsland(): Promise<void> {
  try {
    await getCurrentWindow().hide();
  } catch {
    // Ignorieren.
  }
}

export async function islandVisible(): Promise<boolean> {
  try {
    return await getCurrentWindow().isVisible();
  } catch {
    return false;
  }
}

export async function toggleIsland(): Promise<boolean> {
  if (await islandVisible()) {
    await hideIsland();
    return false;
  }
  await showIsland();
  return true;
}

// ------------------------------------------------------------------
// Die Drops — Stapel unten links + Quick Look
// ------------------------------------------------------------------

// Außenluft im Fenster, damit CSS-Schatten der Karten Platz haben.
export const DROP_PAD = 24;
// Breite einer Drop-Karte (CSS und Fensterbreite müssen übereinstimmen).
export const DROP_W = 304;

const QL_RADIUS = 16;

async function panelWindow(): Promise<WebviewWindow | null> {
  return WebviewWindow.getByLabel("panel");
}

/**
 * Stapel-Modus: Fenster unten links, exakt so hoch wie sein Inhalt.
 * Kein Fokus-Klau, kein Glas — die Karten tragen ihre Fläche selbst.
 */
export async function layoutDrops(contentHeight: number): Promise<void> {
  try {
    const panel = await panelWindow();
    const monitor = await anyMonitor();
    if (!panel || !monitor) return;
    const sf = monitor.scaleFactor;
    const w = Math.round((DROP_W + DROP_PAD * 2) * sf);
    const h = Math.round((contentHeight + DROP_PAD * 2) * sf);
    await invoke("panel_vibrancy", { enable: false, radius: 0 }).catch(() => {});
    await panel.setShadow(false).catch(() => {});
    await panel.setSize(new PhysicalSize(w, h));
    await panel.setPosition(
      new PhysicalPosition(
        Math.round(monitor.position.x + 12 * sf),
        Math.round(monitor.position.y + monitor.size.height - h - 78 * sf),
      ),
    );
    await panel.setAlwaysOnTop(true);
  } catch {
    // Ignorieren.
  }
}

/**
 * Quick Look: Fenster wächst zur Inhaltsgröße (Bilder in ihrer echten
 * Aspect Ratio), zentriert, mit echtem Vibrancy-Glas und Fensterschatten.
 * Liefert die tatsächlich gesetzte logische Größe zurück.
 */
export async function layoutQuickLook(
  wantW: number,
  wantH: number,
  size: "normal" | "large" = "normal",
): Promise<{ w: number; h: number }> {
  const fallback = { w: wantW, h: wantH };
  try {
    const panel = await panelWindow();
    const monitor = await anyMonitor();
    if (!panel || !monitor) return fallback;
    const sf = monitor.scaleFactor;
    const max = size === "large" ? 0.96 : 0.85;
    const maxW = (monitor.size.width / sf) * max;
    const maxH = (monitor.size.height / sf) * max;
    // Proportional einpassen — die Aspect Ratio des Inhalts bleibt erhalten.
    const scale = Math.min(1, maxW / wantW, maxH / wantH);
    const w = Math.round(wantW * scale);
    const h = Math.round(wantH * scale);
    await invoke("panel_vibrancy", { enable: true, radius: QL_RADIUS }).catch(
      () => {},
    );
    await panel.setShadow(size === "normal").catch(() => {});
    await panel.setSize(new PhysicalSize(Math.round(w * sf), Math.round(h * sf)));
    await panel.setPosition(
      new PhysicalPosition(
        Math.round(monitor.position.x + (monitor.size.width - w * sf) / 2),
        Math.round(
          monitor.position.y +
            Math.max(44 * sf, (monitor.size.height - h * sf) / 2 - 16 * sf),
        ),
      ),
    );
    await panel.setAlwaysOnTop(false);
    await panel.setFocus();
    return { w, h };
  } catch {
    return fallback;
  }
}

export async function showDrops(): Promise<void> {
  try {
    const panel = await panelWindow();
    if (!panel) return;
    // Der Stapel stiehlt keinen Fokus — der Nutzer arbeitet gerade woanders.
    await panel.show();
  } catch {
    // Ignorieren.
  }
}

export async function hideDrops(): Promise<void> {
  try {
    const panel = await panelWindow();
    await panel?.hide();
  } catch {
    // Ignorieren.
  }
}

// ------------------------------------------------------------------
// Einstellungen — echtes macOS-Fenster, nur übers Tray erreichbar
// ------------------------------------------------------------------

export type SettingsSection =
  | "allgemein"
  | "aktivierung"
  | "stimme"
  | "keys"
  | "bilder"
  | "gedaechtnis"
  | "faehigkeiten"
  | "diagnose"
  | "persona";

export async function showSettings(section?: SettingsSection): Promise<void> {
  try {
    const win = await WebviewWindow.getByLabel("settings");
    if (!win) return;
    await win.show();
    await win.unminimize().catch(() => {});
    await win.setFocus();
    if (section) await emit("settings-open", { section });
  } catch {
    // Ignorieren.
  }
}
