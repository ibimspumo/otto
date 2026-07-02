# Product

## Register

product

## Users

Ein einzelner Power-User (Entwickler, deutschsprachig), der Otto als persönlichen
Jarvis-artigen Sprachassistenten auf dem eigenen Mac nutzt — freihändig, im Alltag,
oft nebenbei während anderer Arbeit. Primäre Interaktion ist Sprache; der Bildschirm
zeigt, was Otto tut und erstellt.

## Product Purpose

Otto ist ein Realtime-Voice-Agent als Desktop-App (Tauri 2). Er hört zu, antwortet
mit Stimme, recherchiert im Web, erstellt Inhalte und kann den Computer steuern.
Erfolg heißt: Otto fühlt sich nicht wie eine App an, sondern wie eine native
Systemschicht von macOS — man vergisst die UI und redet einfach mit ihm.

## Brand Personality

„Ironman, als hätte Apple es gestaltet": keine Sci-Fi-Deko, sondern das Gegenteil —
Zurückhaltung, Material, Präzision. Zwei Organe:

- **Die Insel**: eine schwarze Kapsel, die aus dem Notch wächst, als wäre sie Teil
  der Hardware. Darin lebt der Orb-Kern (Arc Reactor im Miniaturformat) — das
  einzige farbige Element der ganzen UI.
- **Die Drops**: alles, was Otto erzeugt, materialisiert sich als kleines
  Live-Thumbnail unten links (wie ein macOS-Screenshot) und wächst per Quick Look
  zur Vollansicht in Inhaltsgröße.

Deutsch, direkt, trockener Humor (Ottos Stimme, nicht die UI).

## Anti-references

- Generische SaaS-Dashboards (Karten-Grids, Hero-Metriken, Gradient-Text).
- Chat-Apps: Otto ist kein Chatfenster mit Sprechblasen.
- Verspielte Sci-Fi-Klischees (Orbitron-Font, Neon-Overload, Scanline-Kitsch,
  HUD-Eckklammern).
- Web-App-Ästhetik: Webfonts, eigene Fensterchrome, App-Rahmen. Otto nutzt
  SF Pro, echtes Vibrancy und Systemkonventionen.
- Technik-Telemetrie im Vordergrund (Modellnamen, API-Details) — der Nutzer will
  sehen *was passiert*, nicht *womit*.

## Design Principles

1. **Systemschicht, nicht App.** Alles sieht aus und verhält sich, als hätte
   macOS es eingebaut: die Insel wie Hardware, die Drops wie Screenshots, die
   Einstellungen wie Systemeinstellungen.
2. **Zustand ist Licht, UI ist monochrom.** Bernstein = spricht, Eisblau = hört,
   Violett = denkt/arbeitet — ausschließlich als Licht (Orb-Kern, Glow, Lebensader),
   nie als Button-, Border- oder Dekofarbe. Alles andere: Grauwerte auf Schwarz/Glas.
3. **Ergebnisse sind echt, sofort und klein.** Jedes Artefakt wird von der ersten
   Sekunde an echt gerendert (Bild baut sich progressiv auf, HTML als Miniatur-Seite)
   — erst als Drop, auf Klick in Inhaltsgröße. Nie Rohtext, nie Platzhalter-Theater.
4. **Zeigen statt sagen.** Aktivität ist eine lesbare Live-Zeile in der Insel
   („durchsucht das Web…"), kein Spinner, kein Fachjargon.
5. **Motion trägt Bedeutung.** Die Kapsel weitet sich, weil Otto etwas zu sagen hat;
   der Drop gleitet herein, weil etwas entstanden ist; Quick Look wächst, weil der
   Fokus wechselt. Nichts animiert ohne Zustandswechsel. 150–300 ms, ease-out.

## Accessibility & Inclusion

- `prefers-reduced-motion` wird überall respektiert (Kern ruhig, keine Slides,
  Crossfades statt Bewegung).
- Kontrast: Fließtext ≥ 4.5:1 auf dunklen Flächen; Zustandsfarben nie als einziges
  Signal (immer Text-Label bzw. Caption daneben).
- Tastatur: sichtbarer Fokus, Esc-Hierarchie (Quick Look → Stapel → zu), ⌘S im
  Persona-Editor.
