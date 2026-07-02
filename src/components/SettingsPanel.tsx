import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cliAvailable, cuPermissions, saveSettings } from "../lib/tauriApi";
import {
  fetchImageModels,
  IMAGE_MODELS,
  type ImageModelInfo,
} from "../lib/imagegen";
import { checkForUpdate, installAndRelaunch, type Update } from "../lib/updater";
import type { SettingsSection } from "../lib/hudWindow";
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
  section: Exclude<SettingsSection, "persona">;
  settings: Settings | null;
  onSaved: (settings: Settings) => void;
}

// --- Bausteine im Stil der macOS-Systemeinstellungen -----------------

function Group({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="group">
      {title && <h3 className="group-title">{title}</h3>}
      <div className="group-box">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  /** wide = Control in voller Breite unter dem Label (Textareas, Slider). */
  wide?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`row ${wide ? "wide" : ""}`}>
      <div className="row-text">
        <span className="row-label">{label}</span>
        {hint && <span className="row-hint">{hint}</span>}
      </div>
      {children && <div className="row-ctl">{children}</div>}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      className="switch"
      role="switch"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function KeyInput({
  value,
  placeholder,
  onChange,
  label,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <span className="key-input">
      <input
        type={show ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="ghost"
        title={show ? "Verbergen" : "Zeigen"}
        onClick={() => setShow(!show)}
      >
        {show ? "◡" : "◉"}
      </button>
    </span>
  );
}

/**
 * Ein Abschnitt der Einstellungen. Speichert automatisch (debounced) —
 * wie die Systemeinstellungen: keine Speichern-Knöpfe, nur ein stilles
 * „Gespeichert" unten rechts.
 */
export default function SettingsPanel({
  section,
  settings,
  onSaved,
}: SettingsPanelProps) {
  const [form, setForm] = useState<Settings | null>(settings);
  const [saved, setSaved] = useState(false);
  const [permStatus, setPermStatus] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [foundUpdate, setFoundUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [cliStatus, setCliStatus] = useState<{
    codex: boolean;
    claude: boolean;
  } | null>(null);
  const [imageModels, setImageModels] = useState<ImageModelInfo[]>(
    IMAGE_MODELS.map((m) => ({ id: m.id, label: m.label, provider: m.provider })),
  );
  const [modelFilter, setModelFilter] = useState("");
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cliAvailable().then(setCliStatus).catch(() => setCliStatus(null));
    invoke<boolean>("plugin:autostart|is_enabled")
      .then(setAutostart)
      .catch(() => setAutostart(null));
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  // Dynamische Bildmodell-Liste: alle OpenRouter-Modelle plus die
  // OpenAI-Modelle — geladen, sobald ein OpenRouter-Key vorhanden ist.
  useEffect(() => {
    const key = settings?.openrouter_api_key ?? "";
    fetchImageModels(key)
      .then(setImageModels)
      .catch(() => {});
  }, [settings?.openrouter_api_key]);

  if (!form) return <div className="settings-pane" />;

  /** Ändern = Speichern (debounced 500 ms), wie in den Systemeinstellungen. */
  const set = (patch: Partial<Settings>) => {
    const next = { ...form, ...patch };
    setForm(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await saveSettings(next);
        onSaved(next);
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 1800);
      } catch {
        // Speichern schlägt praktisch nie fehl (lokale Datei) — still bleiben.
      }
    }, 500);
  };

  async function toggleAutostart(enable: boolean) {
    try {
      await invoke(enable ? "plugin:autostart|enable" : "plugin:autostart|disable");
      setAutostart(enable);
    } catch {
      // Im Dev-Modus nicht verfügbar — Anzeige unverändert lassen.
    }
  }

  async function runUpdateCheck() {
    setUpdateStatus("Prüfe…");
    setFoundUpdate(null);
    const u = await checkForUpdate();
    if (u) {
      setFoundUpdate(u);
      setUpdateStatus(`Update auf Version ${u.version} verfügbar.`);
    } else {
      setUpdateStatus(
        "Otto ist aktuell (oder die Prüfung ist im Dev-Modus nicht möglich).",
      );
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

  const body = (() => {
    switch (section) {
      case "allgemein":
        return (
          <>
            <Group>
              <Row
                label="Beim Login starten"
                hint={
                  autostart === null
                    ? "Im Dev-Modus nicht steuerbar — greift in der installierten App."
                    : "Otto startet unsichtbar; du rufst ihn per Hotkey, Zuruf oder Menüleiste."
                }
              >
                <Switch
                  label="Beim Login starten"
                  checked={autostart ?? false}
                  onChange={(v) => void toggleAutostart(v)}
                />
              </Row>
            </Group>
            <Group title="Updates">
              <Row
                label="Nach Updates suchen"
                hint={updateStatus ?? "Wird auch bei jedem App-Start geprüft."}
              >
                <span className="btn-row">
                  <button className="push" type="button" onClick={runUpdateCheck}>
                    Prüfen
                  </button>
                  {foundUpdate && (
                    <button
                      className="push primary"
                      type="button"
                      disabled={installing}
                      onClick={installUpdate}
                    >
                      {installing ? "Installiere…" : "Installieren"}
                    </button>
                  )}
                </span>
              </Row>
            </Group>
          </>
        );

      case "aktivierung":
        return (
          <>
            <Group title="Wake Word">
              <Row
                label="Auf Zuruf aktivieren"
                hint="Lauscht offline über macOS, keine API-Kosten — aber solange gelauscht wird, zeigt macOS dauerhaft den orangen Mikrofon-Indikator in der Menüleiste (Systemverhalten, nicht abschaltbar). Standard ist deshalb aus; Aktivierung per Hotkey."
              >
                <Switch
                  label="Wake Word aktivieren"
                  checked={form.wake_word_enabled}
                  onChange={(v) => set({ wake_word_enabled: v })}
                />
              </Row>
              <Row
                label="Zuruf-Phrase"
                hint="Kurze, markante Phrasen funktionieren am besten."
              >
                <input
                  type="text"
                  value={form.wake_word_phrase}
                  placeholder="Hey Otto"
                  disabled={!form.wake_word_enabled}
                  onChange={(e) => set({ wake_word_phrase: e.target.value })}
                />
              </Row>
            </Group>
            <Group title="Hotkey">
              <Row
                label="Globaler Hotkey"
                hint="Drücken verbindet Otto, erneutes Drücken trennt — systemweit."
              >
                <Switch
                  label="Hotkey aktivieren"
                  checked={form.hotkey_enabled}
                  onChange={(v) => set({ hotkey_enabled: v })}
                />
              </Row>
              <Row
                label="Tastenkombination"
                hint="„2x Cmd“ = zweimal schnell ⌘ tippen (braucht die Bedienungshilfen-Freigabe). Alternativ klassisch: „Alt+Space“, „Cmd+Shift+O“, „F19“…"
              >
                <input
                  type="text"
                  value={form.hotkey}
                  placeholder="2x Cmd"
                  disabled={!form.hotkey_enabled}
                  onChange={(e) => set({ hotkey: e.target.value })}
                />
              </Row>
            </Group>
          </>
        );

      case "stimme":
        return (
          <>
            <Group title="Modell">
              <Row
                label="Realtime-Modell"
                hint="Standard: gpt-realtime-2."
              >
                <input
                  type="text"
                  value={form.model}
                  onChange={(e) => set({ model: e.target.value })}
                />
              </Row>
              <Row
                label="Reasoning"
                hint="Höhere Stufen denken gründlicher, antworten aber langsamer. Empfehlung: low."
              >
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
              </Row>
              <Row label="Stimme" hint="Gilt ab der nächsten Verbindung.">
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
              </Row>
            </Group>
            <Group title="Gehör">
              <Row
                wide
                label="Mikrofon-Empfindlichkeit"
                hint="Höher = unempfindlicher: Otto lässt sich nicht von leisen Hintergrundgeräuschen unterbrechen, du musst aber deutlich sprechen. Standard 0.85 — gilt ab der nächsten Verbindung."
              >
                <span className="slider-row">
                  <input
                    type="range"
                    min={0.5}
                    max={0.95}
                    step={0.05}
                    value={form.vad_threshold}
                    onChange={(e) => set({ vad_threshold: Number(e.target.value) })}
                  />
                  <span className="mono slider-value">
                    {form.vad_threshold.toFixed(2)}
                  </span>
                </span>
              </Row>
            </Group>
          </>
        );

      case "keys":
        return (
          <Group title="Alle Keys bleiben lokal (settings.json) und werden nur direkt von deinem Rechner aus verwendet.">
            <Row
              label="OpenAI"
              hint="Für die Sprachverbindung. Erstellen unter platform.openai.com → API keys."
            >
              <KeyInput
                label="OpenAI API-Key"
                value={form.openai_api_key}
                placeholder="sk-…"
                onChange={(v) => set({ openai_api_key: v })}
              />
            </Row>
            <Row
              label="Brave Search"
              hint="Optional — nötig für die Websuche. Kostenlos unter brave.com/search/api."
            >
              <KeyInput
                label="Brave API-Key"
                value={form.brave_api_key}
                placeholder="BSA…"
                onChange={(v) => set({ brave_api_key: v })}
              />
            </Row>
            <Row
              label="OpenRouter"
              hint="Optional — nur für Bildmodelle wie Nano Banana. Key unter openrouter.ai → Keys."
            >
              <KeyInput
                label="OpenRouter API-Key"
                value={form.openrouter_api_key}
                placeholder="sk-or-…"
                onChange={(v) => set({ openrouter_api_key: v })}
              />
            </Row>
          </Group>
        );

      case "bilder":
        return (
          <Group title="Bildmodell">
            <Row
              wide
              label="Standard-Modell"
              hint="Für generate_image/edit_image — mit OpenRouter-Key erscheinen hier alle verfügbaren Bildmodelle. Otto kann per Stimme jederzeit ein anderes wählen („nimm mal Flux“). Transparente Hintergründe kann nur GPT Image 1 — Otto wechselt dafür automatisch."
            >
              <span className="stack">
                <input
                  type="text"
                  value={modelFilter}
                  placeholder="Filtern… (z. B. flux, gemini, seedream)"
                  onChange={(e) => setModelFilter(e.target.value)}
                />
                <select
                  value={form.image_model}
                  onChange={(e) => set({ image_model: e.target.value })}
                >
                  {(() => {
                    const f = modelFilter.trim().toLowerCase();
                    const filtered = f
                      ? imageModels.filter((m) =>
                          `${m.id} ${m.label}`.toLowerCase().includes(f),
                        )
                      : imageModels;
                    const list = filtered.some((m) => m.id === form.image_model)
                      ? filtered
                      : [
                          ...filtered,
                          imageModels.find((m) => m.id === form.image_model) ?? {
                            id: form.image_model,
                            label: form.image_model,
                            provider: "openrouter" as const,
                          },
                        ];
                    return list.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ));
                  })()}
                </select>
              </span>
            </Row>
          </Group>
        );

      case "gedaechtnis":
        return (
          <Group>
            <Row
              label="Automatisches Gedächtnis"
              hint={
                <>
                  Beim Trennen extrahiert ein stiller Hintergrund-Aufruf
                  bleibende Fakten in Tagesnotizen; beim App-Start konsolidiert
                  Otto sie nach MEMORY.md und USER.md. Transkripte bleiben lokal
                  (SQLite) und werden nach {form.session_retention_days || 30}{" "}
                  Tagen gelöscht.
                </>
              }
            >
              <Switch
                label="Automatisches Gedächtnis"
                checked={form.memory_enabled}
                onChange={(v) => set({ memory_enabled: v })}
              />
            </Row>
            <Row
              label="Gedächtnis-Modell"
              hint="Chat-Modell für Extraktion und Konsolidierung. Standard: gpt-5-mini."
            >
              <input
                type="text"
                value={form.memory_model}
                disabled={!form.memory_enabled}
                onChange={(e) => set({ memory_model: e.target.value })}
              />
            </Row>
          </Group>
        );

      case "faehigkeiten":
        return (
          <>
            <Group title="Werkzeuge — deaktivierte werden Otto gar nicht erst angeboten (gilt ab der nächsten Verbindung).">
              <Row
                label="Terminal-Befehle"
                hint="Apps starten und steuern, Shell-Kommandos."
              >
                <Switch
                  label="Terminal erlauben"
                  checked={form.terminal_enabled}
                  onChange={(v) => set({ terminal_enabled: v })}
                />
              </Row>
              <Row
                label="Computer Use"
                hint="Bildschirm sehen, klicken, tippen."
              >
                <Switch
                  label="Computer Use erlauben"
                  checked={form.computer_use_enabled}
                  onChange={(v) => set({ computer_use_enabled: v })}
                />
              </Row>
              <Row
                label="Computer-Use-Modell"
                hint="Standard: gpt-5.5 (Responses API). computer-use-preview ist Tier-3-beschränkt und endet 07/2026."
              >
                <input
                  type="text"
                  value={form.computer_model}
                  onChange={(e) => set({ computer_model: e.target.value })}
                />
              </Row>
              <Row
                label="Systemfreigaben"
                hint={
                  permStatus ??
                  "Otto braucht „Bildschirmaufnahme“ und „Bedienungshilfen“ — der Knopf löst die macOS-Abfragen aus."
                }
              >
                <button className="push" type="button" onClick={checkPermissions}>
                  Anfordern
                </button>
              </Row>
            </Group>
            <Group title="Delegation">
              <Row
                label="Hintergrund-Agenten"
                hint={
                  <>
                    Otto gibt größere Aufgaben an einen lokalen CLI-Agenten ab
                    und bleibt ansprechbar.{" "}
                    {cliStatus
                      ? `Gefunden: Codex ${cliStatus.codex ? "✓" : "✗"} · Claude ${cliStatus.claude ? "✓" : "✗"}.`
                      : ""}
                  </>
                }
              >
                <Switch
                  label="Delegation erlauben"
                  checked={form.cli_enabled}
                  onChange={(v) => set({ cli_enabled: v })}
                />
              </Row>
              <Row
                label="Standard-Agent"
                hint="Wird genommen, wenn Otto keinen Agenten explizit wählt."
              >
                <select
                  value={form.cli_default}
                  disabled={!form.cli_enabled}
                  onChange={(e) => set({ cli_default: e.target.value })}
                >
                  <option value="codex">
                    Codex CLI
                    {cliStatus && !cliStatus.codex ? " (nicht installiert)" : ""}
                  </option>
                  <option value="claude">
                    Claude CLI
                    {cliStatus && !cliStatus.claude ? " (nicht installiert)" : ""}
                  </option>
                </select>
              </Row>
              <Row
                wide
                label="Wofür welcher Agent?"
                hint="Freitext — Otto bekommt das als Kontext und richtet seine Wahl danach."
              >
                <textarea
                  rows={3}
                  value={form.cli_notes}
                  disabled={!form.cli_enabled}
                  placeholder="z. B.: Claude für Design- und Frontend-Aufgaben, Codex für Programmier- und Systemaufgaben."
                  onChange={(e) => set({ cli_notes: e.target.value })}
                />
              </Row>
            </Group>
          </>
        );
    }
  })();

  return (
    <div className="settings-pane">
      {body}
      <div className={`autosave ${saved ? "visible" : ""}`} aria-live="polite">
        Gespeichert
      </div>
    </div>
  );
}
