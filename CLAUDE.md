# Otto — Kontext für Claude

Deutschsprachiger Jarvis-artiger Realtime-Voice-Agent als Tauri-2-Desktop-App (macOS).
UI-Sprache und Nutzerkommunikation: Deutsch.

## Leitplanken

- **Der 3D-Orb ist die Bühne**; das Artefakt-Panel erscheint nur bei Bedarf (Slide-Animation) und Otto steuert es selbst per Tools.
- **Zustandsfarben konsequent**: Bernstein = spricht, Eisblau = hört, Violett = denkt.
- **Otto redet nicht, während Tools laufen** (bewusste Nutzer-Entscheidung); die UI zeigt stattdessen eine Live-Aktivitätszeile. Keine Modell-/API-Telemetrie in der UI.
- Ottos Persona lebt in editierbaren Agent-Dateien, nicht im Code.

## Architektur

- **Frontend** `src/`: React + TS. `App.tsx` ist der Orchestrator (State-Maschine, Tool-Executor).
  - `lib/realtime.ts` — WebSocket zur GA-Realtime-API (`wss://api.openai.com/v1/realtime`, Key als Subprotokoll `openai-insecure-api-key.<key>`, KEIN Beta-Subprotokoll). GA-Eventnamen (`response.output_audio.delta` …).
  - `lib/audio.ts` + `public/worklets/` — Mikrofon-Capture & PCM-Playback (24 kHz PCM16). Wiedergabe läuft über ein `<audio>`-Element (MediaStreamDestination), sonst greift WebKits Echo-Unterdrückung nicht und Otto unterbricht sich selbst.
  - `lib/imagegen.ts` — OpenAI Images API (SSE-Streaming mit Partial Images) + OpenRouter Unified Image API (`/api/v1/images`, Nano Banana). Transparenz kann NUR `gpt-image-1` (Auto-Fallback).
  - `lib/tools.ts` — Tool-Definitionen + Instructions-Preamble.
  - `lib/miniMode.ts` + `MiniOrb.tsx` — transparentes Always-on-top-Fenster (Label `mini`) während Computer Use.
- **Rust** `src-tauri/src/`: `lib.rs` (Settings, Agent-Dateien mit Default-Seeding, Brave Search, `run_terminal`), `images.rs` (persistente Galerie: `images/index.json`, Import mit sips-Kompression), `computer_use.rs` (Responses API `tools:[{type:"computer"}]` mit gpt-5.5; liefert `actions`-ARRAY, Koordinaten in Screenshot-Pixeln → `coord_scale`; Abbruch über `cu_cancel`; macOS-TCC-Checks).

## Stolperfallen

- Neue Default-Agent-Dateien werden nur geseedet, wenn sie fehlen — nach Änderungen an `src-tauri/defaults/` die Datei auch nach `~/Library/Application Support/de.agentz.otto/agent/` kopieren.
- `RealtimeClient`-Callbacks werden bei connect() eingefroren: veränderliche Daten im Tool-Executor IMMER über Refs lesen (`settingsRefValue`, `artifactsRef`, `imagesRef`, …).
- `response.create` nie senden, solange eine Antwort läuft → `requestResponse()`/`pendingCreate` in App.tsx nutzen.
- `computer-use-preview` ist Tier-3-beschränkt und deprecated (Shutdown 07/2026) — Standard ist gpt-5.5, Modell in den Settings änderbar.
- Panics landen in `/tmp/otto-crash.log`; `ExitRequested` ohne Code wird verhindert (Mini-Modus).
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
`agent/*.md|css` (Persona), `images/` (Galerie).
