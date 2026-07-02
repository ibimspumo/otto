import { useEffect, useState } from "react";
import { cuPermissions, saveSettings } from "../lib/tauriApi";
import { IMAGE_MODELS } from "../lib/imagegen";
import { checkForUpdate, installAndRelaunch, type Update } from "../lib/updater";
import type { Settings } from "../lib/types";

const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];

const VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
];

interface SettingsPanelProps {
  settings: Settings | null;
  onSaved: (settings: Settings) => void;
}

export default function SettingsPanel({ settings, onSaved }: SettingsPanelProps) {
  const [form, setForm] = useState<Settings | null>(settings);
  const [showOpenai, setShowOpenai] = useState(false);
  const [showBrave, setShowBrave] = useState(false);
  const [showOpenrouter, setShowOpenrouter] = useState(false);
  const [saved, setSaved] = useState(false);
  const [permStatus, setPermStatus] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [foundUpdate, setFoundUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);

  async function runUpdateCheck() {
    setUpdateStatus("Prüfe…");
    setFoundUpdate(null);
    const u = await checkForUpdate();
    if (u) {
      setFoundUpdate(u);
      setUpdateStatus(`Update auf Version ${u.version} verfügbar.`);
    } else {
      setUpdateStatus("Otto ist aktuell (oder die Prüfung ist im Dev-Modus nicht möglich).");
    }
  }

  async function installUpdate() {
    if (!foundUpdate || installing) return;
    setInstalling(true);
    try {
      await installAndRelaunch(foundUpdate, (p) =>
        setUpdateStatus(`Lädt herunter… ${p}%`),
      );
    } catch (e) {
      setInstalling(false);
      setUpdateStatus(`Update fehlgeschlagen: ${String(e)}`);
    }
  }

  async function checkPermissions() {
    try {
      const p = await cuPermissions(true);
      setPermStatus(
        `Bildschirmaufnahme: ${p.screen ? "✓" : "✗"} · Bedienungshilfen: ${p.accessibility ? "✓" : "✗"}` +
          (p.screen && p.accessibility
            ? ""
            : " — nach dem Erteilen Otto neu starten."),
      );
    } catch (e) {
      setPermStatus(String(e));
    }
  }

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  if (!form) return <section className="panel" />;

  const set = (patch: Partial<Settings>) => {
    setForm({ ...form, ...patch });
    setSaved(false);
  };

  async function save() {
    if (!form) return;
    await saveSettings(form);
    onSaved(form);
    setSaved(true);
  }

  return (
    <section className="panel">
      <h2 className="panel-title">Einstellungen</h2>
      <p className="panel-sub">
        Keys werden nur lokal gespeichert (settings.json im App-Konfigurationsordner)
        und direkt von deinem Rechner aus verwendet.
      </p>

      <div className="settings-form">
        <label className="field">
          <span className="label">OpenAI API-Key</span>
          <span className="key-row">
            <input
              type={showOpenai ? "text" : "password"}
              value={form.openai_api_key}
              placeholder="sk-…"
              onChange={(e) => set({ openai_api_key: e.target.value })}
            />
            <button
              className="btn small"
              type="button"
              onClick={() => setShowOpenai(!showOpenai)}
            >
              {showOpenai ? "Verbergen" : "Zeigen"}
            </button>
          </span>
          <span className="hint">
            Für die Realtime-Sprachverbindung. Erstellen unter
            platform.openai.com → API keys.
          </span>
        </label>

        <label className="field">
          <span className="label">Brave Search API-Key</span>
          <span className="key-row">
            <input
              type={showBrave ? "text" : "password"}
              value={form.brave_api_key}
              placeholder="BSA…"
              onChange={(e) => set({ brave_api_key: e.target.value })}
            />
            <button
              className="btn small"
              type="button"
              onClick={() => setShowBrave(!showBrave)}
            >
              {showBrave ? "Verbergen" : "Zeigen"}
            </button>
          </span>
          <span className="hint">
            Optional — nötig für Ottos Websuche. Kostenlosen Key gibt es unter
            brave.com/search/api.
          </span>
        </label>

        <label className="field">
          <span className="label">OpenRouter API-Key</span>
          <span className="key-row">
            <input
              type={showOpenrouter ? "text" : "password"}
              value={form.openrouter_api_key}
              placeholder="sk-or-…"
              onChange={(e) => set({ openrouter_api_key: e.target.value })}
            />
            <button
              className="btn small"
              type="button"
              onClick={() => setShowOpenrouter(!showOpenrouter)}
            >
              {showOpenrouter ? "Verbergen" : "Zeigen"}
            </button>
          </span>
          <span className="hint">
            Optional — nur nötig für Bildgenerierung mit Nano Banana.
            Key gibt es unter openrouter.ai → Keys.
          </span>
        </label>

        <label className="field">
          <span className="label">Bildmodell</span>
          <select
            value={form.image_model}
            onChange={(e) => set({ image_model: e.target.value })}
          >
            {IMAGE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="hint">
            Für generate_image/edit_image. Transparente Hintergründe (Logos)
            kann nur GPT Image 1 — Otto wechselt dafür automatisch dorthin.
          </span>
        </label>

        <label className="field">
          <span className="label">Modell</span>
          <input
            type="text"
            value={form.model}
            onChange={(e) => set({ model: e.target.value })}
          />
          <span className="hint">
            Name des Realtime-Modells. Standard: gpt-realtime-2.
          </span>
        </label>

        <label className="field">
          <span className="label">Reasoning-Level</span>
          <select
            value={form.reasoning_effort}
            onChange={(e) => set({ reasoning_effort: e.target.value })}
          >
            {REASONING_LEVELS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <span className="hint">
            Nur für gpt-realtime-2: höhere Stufen denken gründlicher, antworten
            aber langsamer. Empfehlung: low.
          </span>
        </label>

        <label className="field">
          <span className="label">Stimme</span>
          <select
            value={form.voice}
            onChange={(e) => set({ voice: e.target.value })}
          >
            {VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <span className="hint">Gilt ab der nächsten Verbindung.</span>
        </label>

        <div className="field">
          <span className="label">Fähigkeiten</span>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.terminal_enabled}
              onChange={(e) => set({ terminal_enabled: e.target.checked })}
            />
            Terminal-Befehle erlauben (Apps starten/steuern, Shell)
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.computer_use_enabled}
              onChange={(e) => set({ computer_use_enabled: e.target.checked })}
            />
            Computer Use erlauben (Bildschirm sehen, klicken, tippen)
          </label>
          <span className="hint">
            Deaktivierte Werkzeuge werden Otto gar nicht erst angeboten —
            gilt ab der nächsten Verbindung.
          </span>
        </div>

        <label className="field">
          <span className="label">Computer-Use-Modell</span>
          <input
            type="text"
            value={form.computer_model}
            onChange={(e) => set({ computer_model: e.target.value })}
          />
          <span className="hint">
            Standard: gpt-5.5 (natives Computer-Use über die Responses API).
            Alternativen: gpt-5.4 oder computer-use-preview (nur Tier 3, wird
            im Juli 2026 abgeschaltet).
          </span>
        </label>

        <label className="field">
          <span className="label">Computer Use — Systemfreigaben</span>
          <span className="key-row">
            <button className="btn small" type="button" onClick={checkPermissions}>
              Freigaben anfordern
            </button>
          </span>
          <span className="hint">
            {permStatus ??
              "Otto braucht „Bildschirmaufnahme“ und „Bedienungshilfen“ (Systemeinstellungen → Datenschutz & Sicherheit). Der Button löst die macOS-Abfragen aus."}
          </span>
        </label>

        <div className="field">
          <span className="label">Updates</span>
          <span className="key-row">
            <button className="btn small" type="button" onClick={runUpdateCheck}>
              Nach Updates suchen
            </button>
            {foundUpdate && (
              <button
                className="btn primary small"
                type="button"
                disabled={installing}
                onClick={installUpdate}
              >
                {installing ? "Installiere…" : "Herunterladen & neu starten"}
              </button>
            )}
          </span>
          <span className="hint">{updateStatus ?? "Wird auch bei jedem App-Start geprüft."}</span>
        </div>

        <div>
          <button className="btn primary" onClick={save}>
            Speichern
          </button>
          {saved && <span className="saved-note">Gespeichert.</span>}
        </div>
      </div>
    </section>
  );
}
