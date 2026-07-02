# Otto — Kontext für Codex

Deutschsprachiger Jarvis-artiger Realtime-Voice-Agent als Tauri-2-**Menüleisten-App** (macOS).
UI-Sprache und Nutzerkommunikation: Deutsch.

## Leitplanken

- **Präsenz statt Programm**: Otto lebt im Tray (kein Dock-Icon, `ActivationPolicy::Accessory`). Der Orb (Fenster `main`, 320×440) ist KOMPLETT transparent — NUR die 3D-Visualisierung plus eine Caption-Zeile (aktuelle Aktivität) und Hover-Controls. KEINE Transkript-/Textausgabe (bewusste Nutzer-Entscheidung). Er startet unsichtbar und wird per Hotkey/Wake-Word/Tray gerufen; Esc/Hotkey = Dismiss (trennt UND versteckt).
- **Ergebnisse fliegen als Peek-Karte ein**: Erstellt Otto ein Artefakt (Bild, Suche, Dokument), erscheint das Panel-Fenster (Label `panel`, Vibrancy-Glas, eigene React-Wurzel `PanelApp.tsx` via `index.html?panel=1`) zuerst klein unten links („peek", 400×330, kein Fokus-Klau, wie ein macOS-Screenshot-Thumbnail) — Klick vergrößert auf „full" (1100×720, zentriert). Einstellungen & Persona-Dateien gibt es NUR über das Tray-Menü (immer full); das Panel selbst hat keine Tabs. Orchestrator bleibt App.tsx: Zustand per Events (`panel-state`, `panel-open` {view, mode}), Aktionen zurück (`panel-action` inkl. `expand`, `panel-close`, `settings-changed`, `style-changed`). Fenster-Helfer in `lib/hudWindow.ts`.
- **Zustandsfarben konsequent**: Bernstein = spricht, Eisblau = hört, Violett = denkt. Die Zustandsfarbe strahlt als Aura hinter dem Orb (`.voice[data-state]`).
- **Otto redet nicht, während Tools laufen** (bewusste Nutzer-Entscheidung); die UI zeigt stattdessen eine Live-Aktivitätszeile. Keine Modell-/API-Telemetrie in der UI.
- Ottos Persona lebt in editierbaren Agent-Dateien, nicht im Code. SOUL.md darf Otto nie selbst editieren (Persona-Selbstkorruption).

## Architektur

- **Frontend** `src/`: React + TS. `App.tsx` ist der Orchestrator (State-Maschine, Tool-Executor, Fenster-Modi).
  - `lib/realtime.ts` — WebSocket zur GA-Realtime-API (`wss://api.openai.com/v1/realtime`, Key als Subprotokoll `openai-insecure-api-key.<key>`, KEIN Beta-Subprotokoll). GA-Eventnamen (`response.output_audio.delta` …). Gegen Unterbrechungen durch Hintergrundgeräusche: `noise_reduction: far_field` + hohe VAD-Schwelle (Setting `vad_threshold`, Default 0.85, Slider in den Einstellungen).
  - `lib/audio.ts` + `public/worklets/` — Mikrofon-Capture & PCM-Playback (24 kHz PCM16). Wiedergabe läuft über ein `<audio>`-Element (MediaStreamDestination), sonst greift WebKits Echo-Unterdrückung nicht und Otto unterbricht sich selbst.
  - `lib/hudWindow.ts` — Fensterlogik: Orb (oben zentriert, show/hide/toggle) und Panel (show/hide).
  - `lib/memory.ts` — Memory-Flush (Session-Ende → Tagesnotiz via Chat Completions, Modell `memory_model`) und „Dreaming" (App-Start: Catch-up-Flush unverarbeiteter Sessions, Konsolidierung nach MEMORY.md/USER.md wenn >20 h her, Aufräumen). MEMORY.md hat ein hartes Budget (`MEMORY_BUDGET_CHARS`), bei Überlauf zwingt `remember` Otto zu `rewrite_memory`.
  - `lib/imagegen.ts` — OpenAI Images API (SSE-Streaming mit Partial Images) + OpenRouter Unified Image API (`/api/v1/images`). `fetchImageModels` lädt die komplette OpenRouter-Modell-Liste (Cache pro Laufzeit), `findImageModels` = Fuzzy-Suche fürs `find_image_model`-Tool. Transparenz kann NUR `gpt-image-1` (Auto-Fallback).
  - `lib/tools.ts` — Tool-Definitionen + Instructions-Preamble.
  - `lib/miniMode.ts` + `MiniOrb.tsx` — transparentes Always-on-top-Fenster (Label `mini`) während Computer Use.
- **Rust** `src-tauri/src/`: `lib.rs` (Settings, Agent-Dateien mit Default-Seeding, Brave Search, `run_terminal`, Setup: Accessory-Policy + Tray + Vibrancy), `tray.rs` (Tray-Icon zur Laufzeit gezeichnet als Template-Image, Menü → Events `tray-toggle`/`tray-connect`/`tray-settings`), `sessions.rs` (SQLite + FTS5 unter `sessions.db`: Transkript-Protokolle, `processed`-Flag, Volltextsuche, Cleanup; verwaiste Sessions werden nach 6 h als beendet markiert), `memory.rs` (Tagesnotizen `agent/memory/YYYY-MM-DD.md`, `state.json` für Konsolidierungs-Zeitstempel), `skills.rs` (Skills `agent/skills/*.md`, Frontmatter-Parsing für Progressive Disclosure), `images.rs` (persistente Galerie), `computer_use.rs` (Responses API mit gpt-5.5, Abbruch über `cu_cancel`), `cli.rs` (Jobs: Codex/Codex CLI **und `shell`** via `zsh -lc` in eigener Prozessgruppe; Events `cli-line`/`cli-done`), `wake.rs` (Wake Word über NSSpeechRecognizer).
- **Aktivierung**: Wake Word lauscht nur bei getrennter Session; globaler Hotkey = Summon (Fenster zeigen + verbinden) bzw. Dismiss (trennen + verstecken). Tray-Linksklick toggelt das Fenster. Job-Ergebnisse ohne laufende Session landen in `pendingJobResults` und werden bei der nächsten Verbindung nachgereicht.
- **Gedächtnis-Schichten**: (1) MEMORY.md/USER.md kuratiert, (2) Tagesnotizen (heute+gestern in Instructions), (3) `search_sessions`-FTS über alle Roh-Transkripte (Retention `session_retention_days`, Default 30 Tage).
- **Skills**: Nur Name+Beschreibung in den Instructions; Body via `read_skill`. Otto legt Skills nach verifiziertem Erfolg selbst an (`save_skill`), löscht falsche (`delete_skill`).
- **Non-blocking Terminal**: `run_terminal` mit `background=true` läuft als `shell`-Job über die cli.rs-Infrastruktur (job_id sofort, Ergebnis als Systemnachricht, Abbruch via `cancel_job`).

## Stolperfallen

- Neue Default-Agent-Dateien werden nur geseedet, wenn sie fehlen — nach Änderungen an `src-tauri/defaults/` die Datei auch nach `~/Library/Application Support/de.agentz.otto/agent/` kopieren.
- `RealtimeClient`-Callbacks werden bei connect() eingefroren: veränderliche Daten im Tool-Executor IMMER über Refs lesen (`settingsRefValue`, `artifactsRef`, `imagesRef`, …).
- `response.create` nie senden, solange eine Antwort läuft → `requestResponse()`/`pendingCreate` in App.tsx nutzen.
- Beide Fenster sind `transparent` + `decorations:false`. Vibrancy liegt NUR auf dem Panel-Fenster (Radius 22 in lib.rs = `border-radius` von `.panel-shell`); der Orb hat gar keinen Hintergrund — Texte dort brauchen `text-shadow`, Chips eigene dunkle Flächen.
- Das Panel-Fenster spiegelt Daten per Tauri-Events aus dem main-Fenster; nach dem Speichern von Bildern wird die leichte `asset://`-URL statt der Daten-URL verwendet, sonst werden die `panel-state`-Events megabytegroß.
- rusqlite läuft mit `bundled`-Feature (FTS5 inklusive) — kein System-SQLite nötig.
- `computer-use-preview` ist Tier-3-beschränkt und deprecated (Shutdown 07/2026) — Standard ist gpt-5.5, Modell in den Settings änderbar.
- Panics landen in `/tmp/otto-crash.log`; `ExitRequested` ohne Code wird verhindert (Fenster oft unsichtbar!). Beenden nur über das Tray-Menü (`app.exit(0)`).
- `NSSpeechRecognizer` ist deprecated, aber der einzige kostenlose Offline-Weg für Wake Words. Er ist main-thread-gebunden (`run_on_main_thread` + mpsc in `wake.rs`); Delegate wird nur weak gehalten — Recognizer UND Delegate müssen im `thread_local` am Leben bleiben.
- CLI-/Shell-Jobs laufen in eigener Prozessgruppe (`process_group(0)`); Kill immer an `-pid`, sonst überleben Kinder als Waisen. Watchdog beendet nach 30 min.
- Versionsnummer an DREI Stellen pflegen: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (+ Wordmark in `App.tsx`).

## Befehle

```sh
npm run tauri dev       # App im Dev-Modus (Vite HMR + cargo watch)
npx tsc --noEmit        # Frontend-Typecheck
cargo check             # in src-tauri/
git tag vX.Y.Z && git push --tags   # Release + Auto-Update-Artefakte via GitHub Action
```

Updater: GitHub Releases (`latest.json`), Signatur-Key liegt lokal unter `~/.tauri/otto.key`
und als Secret `TAURI_SIGNING_PRIVATE_KEY` im Repo.

## Nutzerdaten (macOS)

`~/Library/Application Support/de.agentz.otto/` → `settings.json` (Keys unverschlüsselt),
`agent/*.md|css` (Persona), `agent/memory/` (Tagesnotizen + state.json),
`agent/skills/` (Skills), `images/` (Galerie), `sessions.db` (Transkripte, SQLite+FTS5).
