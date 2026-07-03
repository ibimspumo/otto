import type { Update } from "../../lib/updater";
import type { Diagnostics, Settings } from "../../lib/types";
import type { ImageModelInfo } from "../../lib/imagegen";
import { Group, KeyInput, Row, Switch } from "./SettingsControls";

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

interface SectionProps {
  form: Settings;
  set: (patch: Partial<Settings>) => void;
}

export function GeneralSettings({
  autostart,
  updateStatus,
  foundUpdate,
  installing,
  onToggleAutostart,
  onRunUpdateCheck,
  onInstallUpdate,
}: {
  autostart: boolean | null;
  updateStatus: string | null;
  foundUpdate: Update | null;
  installing: boolean;
  onToggleAutostart: (enable: boolean) => void;
  onRunUpdateCheck: () => void;
  onInstallUpdate: () => void;
}) {
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
            onChange={onToggleAutostart}
          />
        </Row>
      </Group>
      <Group title="Updates">
        <Row
          label="Nach Updates suchen"
          hint={updateStatus ?? "Wird auch bei jedem App-Start geprüft."}
        >
          <span className="btn-row">
            <button className="push" type="button" onClick={onRunUpdateCheck}>
              Prüfen
            </button>
            {foundUpdate && (
              <button
                className="push primary"
                type="button"
                disabled={installing}
                onClick={onInstallUpdate}
              >
                {installing ? "Installiere…" : "Installieren"}
              </button>
            )}
          </span>
        </Row>
      </Group>
    </>
  );
}

export function ActivationSettings({
  form,
  set,
  permStatus,
  onCheckPermissions,
}: SectionProps & {
  permStatus: string | null;
  onCheckPermissions: () => void;
}) {
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
        <Row label="Zuruf-Phrase" hint="Kurze, markante Phrasen funktionieren am besten.">
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
        <Row
          label="Bedienungshilfen"
          hint={
            permStatus ??
            "„2x Cmd“ braucht die macOS-Freigabe „Bedienungshilfen“ — der Knopf öffnet bei Bedarf die Systemeinstellungen."
          }
        >
          <button className="push" type="button" onClick={onCheckPermissions}>
            Anfordern
          </button>
        </Row>
      </Group>
    </>
  );
}

export function VoiceSettings({ form, set }: SectionProps) {
  return (
    <>
      <Group title="Modell">
        <Row label="Realtime-Modell" hint="Standard: gpt-realtime-2.">
          <input type="text" value={form.model} onChange={(e) => set({ model: e.target.value })} />
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
          <select value={form.voice} onChange={(e) => set({ voice: e.target.value })}>
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
            <span className="mono slider-value">{form.vad_threshold.toFixed(2)}</span>
          </span>
        </Row>
      </Group>
    </>
  );
}

export function KeySettings({ form, set }: SectionProps) {
  return (
    <Group title="Keys bleiben lokal: auf macOS in der Keychain, sonst in der lokalen settings.json.">
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
}

export function ImageSettings({
  form,
  set,
  imageModels,
  modelFilter,
  setModelFilter,
}: SectionProps & {
  imageModels: ImageModelInfo[];
  modelFilter: string;
  setModelFilter: (value: string) => void;
}) {
  const f = modelFilter.trim().toLowerCase();
  const filtered = f
    ? imageModels.filter((m) => `${m.id} ${m.label}`.toLowerCase().includes(f))
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
          <select value={form.image_model} onChange={(e) => set({ image_model: e.target.value })}>
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </span>
      </Row>
    </Group>
  );
}

export function MemorySettings({ form, set }: SectionProps) {
  return (
    <Group>
      <Row
        label="Automatisches Gedächtnis"
        hint={
          <>
            Beim Trennen extrahiert ein stiller Hintergrund-Aufruf bleibende Fakten in
            Tagesnotizen; beim App-Start konsolidiert Otto sie nach MEMORY.md und USER.md.
            Transkripte bleiben lokal (SQLite) und werden nach{" "}
            {form.session_retention_days || 30} Tagen gelöscht.
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
}

function yesNo(v: boolean | null): string {
  if (v === null) return "unbekannt";
  return v ? "ja" : "nein";
}

export function DiagnosticsSettings({
  diag,
  onRefresh,
}: {
  diag: Diagnostics | null;
  onRefresh: () => void;
}) {
  if (!diag) {
    return (
      <Group title="App-Identität">
        <Row label="Status" hint="Diagnose wird geladen…">
          <button className="push" type="button" onClick={onRefresh}>
            Aktualisieren
          </button>
        </Row>
      </Group>
    );
  }

  // Läuft Otto NICHT aus /Applications und ist es auch keine Dev-Binary, ist
  // das der klassische „direkt aus dem Download gestartet“-Fall.
  const misplaced = !diag.in_applications && !diag.dev_build;
  const location = diag.translocated
    ? "App Translocation — Kopie ohne feste Identität"
    : diag.in_applications
      ? "im Ordner „Programme“ (/Applications) ✓"
      : diag.dev_build
        ? "Dev-/Debug-Version (nicht die installierte App)"
        : "außerhalb von /Applications";

  return (
    <>
      <Group title="App-Identität & Laufumgebung">
        <Row
          label="Standort"
          hint={
            diag.translocated || misplaced
              ? "Ohne feste Identität in /Applications merkt sich macOS keine Freigaben — siehe die Schritte unten."
              : "Alles in Ordnung."
          }
        >
          <span className="mono">{location}</span>
        </Row>
        <Row label="Programm-Pfad" hint="Aktueller Ort der laufenden Otto-Binary.">
          <span className="mono" style={{ wordBreak: "break-all" }}>
            {diag.bundle_path ?? diag.exe_path}
          </span>
        </Row>
        <Row label="Bundle-ID" hint="An diese Identität hängt macOS die Freigaben.">
          <span className="mono">{diag.bundle_id}</span>
        </Row>
        <Row label="Quarantäne" hint="Vom Download/DMG gesetztes Gatekeeper-Attribut.">
          <span className="mono">{yesNo(diag.quarantined)}</span>
        </Row>
        <Row
          label="Freigaben (Vorprüfung)"
          hint="Ohne Dialog geprüft — löst keine Systemabfrage aus."
        >
          <span className="mono">
            Bedienungshilfen: {diag.accessibility ? "✓" : "✗"}
          </span>
        </Row>
        <Row label="Neu prüfen" hint="Nach dem Verschieben/Neustart hier erneut prüfen.">
          <button className="push" type="button" onClick={onRefresh}>
            Aktualisieren
          </button>
        </Row>
      </Group>

      <Group title="Wenn Freigaben nicht greifen — so geht's (ohne Signatur)">
        <Row
          wide
          label="1 · App aus „Programme“ starten"
          hint="Otto per Finder nach /Applications ziehen und von dort öffnen. Nur eine App an einem festen Ort bekommt dauerhafte Freigaben — eine direkt aus dem Download/DMG gestartete Kopie läuft aus einem zufälligen, schreibgeschützten Pfad (App Translocation) und verliert alles beim Neustart."
        >
          <span className="row-hint">Finder → Otto nach „Programme“ ziehen</span>
        </Row>
        <Row
          wide
          label="2 · Quarantäne entfernen"
          hint="Beim ersten Start Rechtsklick auf Otto → „Öffnen“ (nicht Doppelklick) und den Gatekeeper-Dialog bestätigen. Alternativ im Terminal: xattr -cr /Applications/Otto.app"
        >
          <span className="mono">xattr -cr /Applications/Otto.app</span>
        </Row>
        <Row
          wide
          label="3 · Freigaben anfordern"
          hint="Unter Einstellungen → Aktivierung den Knopf „Anfordern“ nutzen; er öffnet die macOS-Einstellungen für „Bedienungshilfen“. Danach Otto einmal neu starten."
        >
          <span className="row-hint">Einstellungen → Aktivierung → „Anfordern“</span>
        </Row>
        <Row
          wide
          label="4 · TCC zurücksetzen (nur im Notfall)"
          hint="Sind noch alte Freigaben einer früheren Kopie hängen geblieben, im Terminal zurücksetzen und Otto neu starten. Setzt nur die Freigaben von Otto zurück, sonst nichts."
        >
          <span className="mono" style={{ wordBreak: "break-all" }}>
            {`tccutil reset Accessibility ${diag.bundle_id}`}
          </span>
        </Row>
      </Group>
    </>
  );
}

export function CapabilitySettings({
  form,
  set,
  cliStatus,
}: SectionProps & {
  cliStatus: { codex: boolean; claude: boolean } | null;
}) {
  return (
    <>
      <Group title="Werkzeuge — deaktivierte werden Otto gar nicht erst angeboten (gilt ab der nächsten Verbindung).">
        <Row label="Terminal-Befehle" hint="Apps starten und steuern, Shell-Kommandos.">
          <Switch
            label="Terminal erlauben"
            checked={form.terminal_enabled}
            onChange={(v) => set({ terminal_enabled: v })}
          />
        </Row>
      </Group>
      <Group title="Delegation">
        <Row
          label="Hintergrund-Agenten"
          hint={
            <>
              Otto gibt größere Aufgaben an einen lokalen CLI-Agenten ab und bleibt
              ansprechbar.{" "}
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
        <Row label="Standard-Agent" hint="Wird genommen, wenn Otto keinen Agenten explizit wählt.">
          <select
            value={form.cli_default}
            disabled={!form.cli_enabled}
            onChange={(e) => set({ cli_default: e.target.value })}
          >
            <option value="codex">
              Codex CLI{cliStatus && !cliStatus.codex ? " (nicht installiert)" : ""}
            </option>
            <option value="claude">
              Claude CLI{cliStatus && !cliStatus.claude ? " (nicht installiert)" : ""}
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
