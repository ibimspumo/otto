import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
} from "@tauri-apps/api/window";

/**
 * Während Computer Use läuft, verschwindet das Hauptfenster und ein kleines,
 * transparentes Always-on-top-Fenster mit dem Orb wandert in die untere
 * rechte Bildschirmecke.
 */
export async function enterMiniMode(): Promise<void> {
  try {
    const mini = await WebviewWindow.getByLabel("mini");
    if (!mini) return;
    const monitor = await currentMonitor();
    if (monitor) {
      // Großzügiger Abstand nach unten, damit Dock/Bildschirmkante nichts abschneiden.
      const marginX = Math.round(28 * monitor.scaleFactor);
      const marginY = Math.round(110 * monitor.scaleFactor);
      const w = Math.round(240 * monitor.scaleFactor);
      const h = Math.round(300 * monitor.scaleFactor);
      await mini.setPosition(
        new PhysicalPosition(
          monitor.position.x + monitor.size.width - w - marginX,
          monitor.position.y + monitor.size.height - h - marginY,
        ),
      );
    }
    await mini.show();
    await getCurrentWindow().hide();
  } catch {
    // Fenstersteuerung fehlgeschlagen — Hauptfenster bleibt einfach sichtbar.
  }
}

export async function exitMiniMode(): Promise<void> {
  try {
    const main = getCurrentWindow();
    await main.show();
    await main.setFocus();
    const mini = await WebviewWindow.getByLabel("mini");
    await mini?.hide();
  } catch {
    // Ignorieren — schlimmstenfalls bleibt der Mini-Orb sichtbar.
  }
}
