# Otto — Kontext für Coding-Agenten

Deutschsprachiger Jarvis-artiger Realtime-Voice-Agent als Tauri-2-**Menüleisten-App** (macOS).
UI-Sprache und Nutzerkommunikation: Deutsch.

## Leitplanken

- **Systemschicht statt Programm**: Otto lebt im Tray (kein Dock-Icon, `ActivationPolicy::Accessory`). Seine Präsenz ist **die Insel** (Fenster `main`): eine voll gerundete schwarze Pille, die mit ~6 pt Abstand UNTER Notch/Menüleiste schwebt (Dynamic-Island-Prinzip; die Höhe liefert `top_inset` aus NSScreen-Safe-Area — direkt an der Kante sähe sie auf Notch-Macs wie eine zweite Notch aus). Darin nur der Orb-Kern (`Orb3D variant="core"`), eine Caption-Zeile (aktuelle Aktivität) und Hover-Controls. KEINE Transkript-/Textausgabe (bewusste Nutzer-Entscheidung). Das Fenster wird pro Zustand ECHT umgesetzt (`layoutIsland` compact 280×104 / wide 560×104), damit nie unsichtbare Fläche Klicks frisst. Start unsichtbar; Hotkey/Tray = Summon, Esc/Hotkey = Dismiss (trennt UND versteckt). Standard-Hotkey ist **„2x Cmd“** (zweimal ⌘ kurz hintereinander) über native NSEvent-FlagsChanged-Monitore (`native.rs`, Event `double-cmd`, braucht Bedienungshilfen) — es sind ZWEI: der globale sieht nur Events an andere Apps, der lokale den eigenen Prozess (sonst ist der Hotkey tot, sobald ein Otto-Fenster Key ist); klassische Kombos laufen weiter übers Global-Shortcut-Plugin. Die Insel erscheint beim Summon OHNE Fokus (`showIsland` ruft kein `setFocus` — dem Nutzer nie die Tastatur wegnehmen); Esc greift deshalb erst nach Klick auf die Insel, Dismiss ohne Klick läuft über den Hotkey. Wake Word ist ab Werk AUS: solange NSSpeechRecognizer lauscht, zeigt macOS ein nicht unterdrückbares schwebendes Mikrofon-Widget.
- **Ergebnisse materialisieren als Drops**: Erstellt Otto ein Artefakt (Bild, Suche, Dokument, HTML), erscheint es im Panel-Fenster (Label `panel`, React-Wurzel `PanelApp.tsx` via `index.html?panel=1`) als **Drop** unten links — kleines Live-Thumbnail ohne Fokus-Klau, wie ein macOS-Screenshot. Jeder Typ wird ECHT gerendert (HTML als skaliertes iframe, Markdown als Mini-Dokument, Bilder progressiv), nie als Rohtext. Neuestes Artefakt = Hero-Karte, ältere = Zeilen darüber, Rest = Zähler-Chip; fertige Drops verwerfen sich nach 3 min selbst (nie während Generierung, nie das geöffnete). Klick = **Quick Look**: Das Fenster wächst zur Inhaltsgröße (Bilder in ihrer ECHTEN Aspect Ratio via `size`/`meta.size`, Cap 85 % Monitor), zentriert, mit Vibrancy (zur Laufzeit via Rust-Command `panel_vibrancy` geschaltet — der Stapel läuft OHNE Fenster-Glas, sonst wären die Lücken zwischen Karten Blur). Auch per Stimme: Tool `present_artifact` (gross/klein) wirkt wie ein Klick (Event `panel-present`; bei zuem Fenster über `pendingPresent` NACH `panel-open` gesendet, sonst schluckt der fresh-Reset den Wunsch); `open_image`/`show_gallery` öffnen direkt groß, `create_artifact` hat einen optionalen `present`-Parameter. Esc: Quick Look → Stapel → zu. Orchestrator bleibt App.tsx: Zustand per Events (`panel-state`, `panel-open` {fresh}), Aktionen zurück (`panel-action`, `panel-close`); Stapel-/Quick-Look-Modus verwaltet PanelApp selbst. Fenster-Helfer in `lib/hudWindow.ts`.
- **Einstellungen sind bewusst konventionell**: eigenes Fenster (Label `settings`, `SettingsApp.tsx` via `index.html?settings=1`) im Stil der macOS-Systemeinstellungen — Sidebar auf echtem Sidebar-Vibrancy, solider Inhaltsbereich, Auto-Save (debounced, kein Speichern-Knopf), Persona-Dateien als Abschnitt. Nur übers Tray erreichbar; der rote Schließen-Knopf versteckt nur (CloseRequested-Handler in lib.rs).
- **Monochrom + Zustand als Licht**: Die UI ist komplett monochrom (SF Pro/System-Fonts, Grauwerte, keine Webfonts). Farbe existiert NUR als Licht: Bernstein = spricht, Eisblau = hört, Violett = denkt/arbeitet — als Orb-Kern, Glow unter der Insel (`.island-glow`, `--light`) und 2px-Lebensader an generierenden Drops. Nie als Button-/Border-/Deko-Farbe.
- **Otto redet nicht, während Tools laufen** (bewusste Nutzer-Entscheidung); die UI zeigt stattdessen eine Live-Aktivitätszeile. Keine Modell-/API-Telemetrie in der UI.
- Ottos Persona lebt in editierbaren Agent-Dateien, nicht im Code. SOUL.md darf Otto nie selbst editieren (Persona-Selbstkorruption).

## Architektur

- **Frontend** `src/`: React + TS. `App.tsx` ist der Orchestrator (State-Maschine, Tool-Executor, Fenster-Modi).
  - `lib/realtime.ts` — WebSocket zur GA-Realtime-API (`wss://api.openai.com/v1/realtime`, Key als Subprotokoll `openai-insecure-api-key.<key>`, KEIN Beta-Subprotokoll). GA-Eventnamen (`response.output_audio.delta` …). Gegen Unterbrechungen durch Hintergrundgeräusche: `noise_reduction: far_field` + hohe VAD-Schwelle (Setting `vad_threshold`, Default 0.85, Slider in den Einstellungen).
  - `lib/audio.ts` + `public/worklets/` — Mikrofon-Capture & PCM-Playback (24 kHz PCM16). Wiedergabe läuft über ein `<audio>`-Element (MediaStreamDestination), sonst greift WebKits Echo-Unterdrückung nicht und Otto unterbricht sich selbst.
  - `lib/hudWindow.ts` — Fensterlogik: Insel (`layoutIsland`/`showIsland`/`toggleIsland`), Drops (`layoutDrops` — Fensterhöhe = Inhaltshöhe, unten links), Quick Look (`layoutQuickLook` — proportionale Inhaltsgröße, zentriert) und `showSettings(section)`.
  - `lib/memory.ts` — Memory-Flush (Session-Ende → Tagesnotiz via Chat Completions, Modell `memory_model`) und „Dreaming" (App-Start: Catch-up-Flush unverarbeiteter Sessions, Konsolidierung nach MEMORY.md/USER.md wenn >20 h her, Aufräumen). MEMORY.md hat ein hartes Budget (`MEMORY_BUDGET_CHARS`), bei Überlauf zwingt `remember` Otto zu `rewrite_memory`.
  - `lib/imagegen.ts` — OpenAI Images API (SSE-Streaming mit Partial Images) + OpenRouter Unified Image API (`/api/v1/images`). `fetchImageModels` lädt die komplette OpenRouter-Modell-Liste (Cache pro Laufzeit), `findImageModels` = Fuzzy-Suche fürs `find_image_model`-Tool. Transparenz kann NUR `gpt-image-1` (Auto-Fallback).
  - `lib/tools.ts` — Tool-Definitionen + Instructions-Preamble.
  - `components/ArtifactContent.tsx` — gemeinsame Voll-Renderer (Markdown, HTML-iframe mit STYLE.css, Suche, Bildraster); `PanelApp.tsx` enthält die Mini-Renderer der Drops.
- **Rust** `src-tauri/src/`: `lib.rs` (Settings, Agent-Dateien mit Default-Seeding, Brave Search, `run_terminal`, Setup: Accessory-Policy + Tray + Vibrancy), `tray.rs` (Tray-Icon zur Laufzeit gezeichnet als Template-Image, Menü → Events `tray-toggle`/`tray-connect`/`tray-settings`), `sessions.rs` (SQLite + FTS5 unter `sessions.db`: Transkript-Protokolle, `processed`-Flag, Volltextsuche, Cleanup; verwaiste Sessions werden nach 6 h als beendet markiert), `memory.rs` (Tagesnotizen `agent/memory/YYYY-MM-DD.md`, `state.json` für Konsolidierungs-Zeitstempel), `skills.rs` (Skills `agent/skills/*.md`, Frontmatter-Parsing für Progressive Disclosure), `images.rs` (persistente Galerie), `cli.rs` (Jobs: Codex/Claude CLI **und `shell`** via `zsh -lc` in eigener Prozessgruppe; Events `cli-line`/`cli-done`), `wake.rs` (Wake Word über NSSpeechRecognizer).
- **Aktivierung**: Wake Word lauscht nur bei getrennter Session; globaler Hotkey = Summon (Fenster zeigen + verbinden) bzw. Dismiss (trennen + verstecken). Tray-Linksklick toggelt das Fenster. Job-Ergebnisse ohne laufende Session landen in `pendingJobResults` und werden bei der nächsten Verbindung nachgereicht.
- **Gedächtnis-Schichten**: (1) MEMORY.md/USER.md kuratiert, (2) Tagesnotizen (heute+gestern in Instructions), (3) `search_sessions`-FTS über alle Roh-Transkripte (Retention `session_retention_days`, Default 30 Tage).
- **Skills**: Nur Name+Beschreibung in den Instructions; Body via `read_skill`. Otto legt Skills nach verifiziertem Erfolg selbst an (`save_skill`), löscht falsche (`delete_skill`).
- **Non-blocking Terminal**: `run_terminal` mit `background=true` läuft als `shell`-Job über die cli.rs-Infrastruktur (job_id sofort, Ergebnis als Systemnachricht, Abbruch via `cancel_job`).

## Stolperfallen

- Neue Default-Agent-Dateien werden nur geseedet, wenn sie fehlen — nach Änderungen an `src-tauri/defaults/` die Datei auch nach `~/Library/Application Support/de.agentz.otto/agent/` kopieren.
- `RealtimeClient`-Callbacks werden bei connect() eingefroren: veränderliche Daten im Tool-Executor IMMER über Refs lesen (`settingsRefValue`, `artifactsRef`, `imagesRef`, …).
- `response.create` nie senden, solange eine Antwort läuft → `requestResponse()`/`pendingCreate` in App.tsx nutzen.
- Insel- und Panel-Fenster sind `transparent` + `decorations:false`. Vibrancy: Settings-Fenster bekommt Sidebar-Material im Setup; das Panel-Fenster schaltet sein Glas ZUR LAUFZEIT (`panel_vibrancy`-Command, Radius 16 = `border-radius` von `.ql-shell`; im Stapel-Modus AUS, Fensterschatten via `setShadow` analog). Drop-Karten tragen CSS-Schatten — dafür sind 24 px Luft (`DROP_PAD`) im Fenster; `DROP_W` (304) muss mit der CSS-Kartenbreite übereinstimmen.
- Die Insel liegt über der Menüleiste (y = 0). `layoutIsland` muss bei JEDER Zustandsbreite neu zentrieren; die Kapselbreite animiert CSS-seitig (`.island`/`.island.wide`), das Fenster springt — Reihenfolge beachten, sonst clippt die Kapsel.
- Das Panel-Fenster spiegelt Daten per Tauri-Events aus dem main-Fenster; nach dem Speichern von Bildern wird die leichte `asset://`-URL statt der Daten-URL verwendet, sonst werden die `panel-state`-Events megabytegroß.
- rusqlite läuft mit `bundled`-Feature (FTS5 inklusive) — kein System-SQLite nötig.
- Panics landen in `/tmp/otto-crash.log`; `ExitRequested` ohne Code wird verhindert (Fenster oft unsichtbar!). Beenden nur über das Tray-Menü (`app.exit(0)`).
- **Fehler-Politik**: Technische/transiente Fehler (Realtime-Server-Events wie „active response in progress“, fehlgeschlagene Responses) gehen NIE in die UI — sie laufen über `onLog`/`api.logLine` ins interne Log `otto.log` im App-Datenordner (Rotation bei 1 MB). Nur nutzer-relevante Fehler (Key fehlt, Mikro verweigert, Verbindung tot) erscheinen in der Insel und blenden sich nach 10 s selbst aus.
- `NSSpeechRecognizer` ist deprecated, aber der einzige kostenlose Offline-Weg für Wake Words. Er ist main-thread-gebunden (`run_on_main_thread` + mpsc in `wake.rs`); Delegate wird nur weak gehalten — Recognizer UND Delegate müssen im `thread_local` am Leben bleiben.
- CLI-/Shell-Jobs laufen in eigener Prozessgruppe (`process_group(0)`); Kill immer an `-pid`, sonst überleben Kinder als Waisen. Watchdog beendet nach 30 min.
- Versionsnummer an DREI Stellen pflegen: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
- **Versionierung ist Nutzer-Entscheidung**: Die Version wird NIE eigenmächtig hochgestellt. Wenn ein Stand release-würdig wirkt, dem Nutzer einen Vorschlag machen (welche Version, warum) — er entscheidet, ob und wann.
- Bild-Artefakte: `ImageState.size` wird schon beim Start der Generierung gesetzt — Quick Look leitet daraus die Fenster-Ratio ab. Beim Anlegen neuer Bildpfade immer mitgeben.

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
`agent/skills/` (Skills), `images/` (Galerie), `sessions.db` (Transkripte, SQLite+FTS5),
`otto.log` (internes Diagnose-Log, Rotation bei 1 MB).
