# Otto

Deutschsprachiger Realtime-Voice-Agent als macOS-Desktop-App (Tauri 2 + React + Three.js).
Sprechen statt tippen: Otto hört zu, antwortet mit Stimme und zeigt alles Zeigbare im
Artefakt-Panel — Recherchen, Dokumente, Code, generierte Bilder.

## Features

- **Realtime-Sprachgespräch** über die OpenAI Realtime API (`gpt-realtime-2`), mit Barge-in und Echo-Unterdrückung
- **3D-Glutkern**: audio-reaktive Visualisierung — Bernstein = spricht, Eisblau = hört, Violett = denkt
- **Artefakt-Panel on demand**: Markdown, Code, HTML (mit editierbarem Design-System `STYLE.css`), Suchergebnisse
- **Bildgenerierung**: GPT Image 2 / GPT Image 1 / Nano Banana (OpenRouter), 1K–4K, Transparenz, Live-Streaming, Edits per Zuruf, persistente Galerie mit Import von Dateien/URLs
- **Websuche** via Brave Search API
- **Terminal-Befehle & Computer Use** (gpt-5.5): Apps steuern per Shell in Sekunden, oder visuell mit Maus/Tastatur — mit Mini-Orb in der Bildschirmecke und Abbrechen-Button
- **Agent-Dateien** (`SOUL.md`, `USER.md`, `MEMORY.md`, `TOOLS.md`, `STYLE.css`): definieren Ottos Identität, in der App editierbar
- **Auto-Updates** über GitHub Releases (Prüfung bei App-Start + manuell in den Einstellungen)

## Setup

Voraussetzungen: Node ≥ 20, Rust (rustup), Xcode Command Line Tools.

```sh
npm install
npm run tauri dev     # Entwicklung
npm run tauri build   # Release-Bundle (.app/.dmg)
```

Erster Start: In den **Einstellungen** den OpenAI-API-Key eintragen (Pflicht), optional
Brave-Search- und OpenRouter-Keys. Für Computer Use die macOS-Freigaben
(Bildschirmaufnahme + Bedienungshilfen) über den Button in den Einstellungen anfordern.

## Release veröffentlichen

Version in `package.json`, `src-tauri/tauri.conf.json` und `src-tauri/Cargo.toml` anheben, dann:

```sh
git tag v0.4.0 && git push --tags
```

Die GitHub Action baut das signierte Universal-Bundle und veröffentlicht das Release
inkl. `latest.json` — laufende Installationen bieten das Update dann automatisch an.

## Daten & Architektur

Details in [CLAUDE.md](CLAUDE.md). Kurzfassung: React-Frontend (`src/`) spricht die
OpenAI-APIs direkt; Rust (`src-tauri/`) übernimmt Settings, Agent-Dateien, Bildspeicher,
Brave Search, Terminal und Computer Use. Nutzerdaten liegen unter
`~/Library/Application Support/de.agentz.otto/`.
