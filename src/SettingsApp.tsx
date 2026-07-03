import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import FilesPanel from "./components/FilesPanel";
import SettingsPanel from "./components/SettingsPanel";
import type { SettingsSection } from "./lib/hudWindow";
import * as api from "./lib/tauriApi";
import type { Settings } from "./lib/types";

/**
 * Das Einstellungsfenster — bewusst konventionell, im Stil der macOS-
 * Systemeinstellungen: Seitenleiste auf echtem Vibrancy-Glas (das Fenster
 * trägt Sidebar-Material), Inhaltsbereich auf solider Fläche. Erreichbar
 * nur übers Tray-Menü; der rote Schließen-Knopf versteckt es nur.
 */

const NAV: { id: SettingsSection; label: string; glyph: string }[] = [
  { id: "allgemein", label: "Allgemein", glyph: "⚙" },
  { id: "aktivierung", label: "Aktivierung", glyph: "◉" },
  { id: "stimme", label: "Stimme & Gehör", glyph: "♪" },
  { id: "keys", label: "API-Keys", glyph: "⚿" },
  { id: "bilder", label: "Bilder", glyph: "▣" },
  { id: "gedaechtnis", label: "Gedächtnis", glyph: "✎" },
  { id: "faehigkeiten", label: "Fähigkeiten", glyph: "⌘" },
  { id: "diagnose", label: "Diagnose", glyph: "✦" },
  { id: "persona", label: "Persona", glyph: "☰" },
];

export default function SettingsApp() {
  const [section, setSection] = useState<SettingsSection>("allgemein");
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
    const unOpen = listen<{ section?: SettingsSection }>(
      "settings-open",
      (e) => {
        if (e.payload?.section) setSection(e.payload.section);
        // Fenster sichtbar → Settings können sich geändert haben (Tool-Calls).
        api.getSettings().then(setSettings).catch(() => {});
      },
    );
    return () => {
      unOpen.then((f) => f());
    };
  }, []);

  return (
    <div className="settings-window">
      <aside className="settings-sidebar">
        {/* Freiraum für die Ampel-Knöpfe (Overlay-Titelleiste). */}
        <div className="settings-traffic" data-tauri-drag-region />
        <div className="settings-app" data-tauri-drag-region>
          Otto
        </div>
        <nav className="settings-nav">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={section === n.id ? "active" : ""}
              onClick={() => setSection(n.id)}
            >
              <span className="glyph" aria-hidden>
                {n.glyph}
              </span>
              {n.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="settings-content">
        <header className="settings-header" data-tauri-drag-region>
          {NAV.find((n) => n.id === section)?.label}
        </header>
        <div className="settings-scroll">
          {section === "persona" ? (
            <FilesPanel />
          ) : (
            <SettingsPanel
              section={section}
              settings={settings}
              onSaved={(s) => {
                setSettings(s);
                void emit("settings-changed", {});
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
