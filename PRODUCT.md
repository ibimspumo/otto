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
mit Stimme, recherchiert im Web, erstellt Inhalte im Artefakt-Panel und kann den
Computer steuern. Erfolg heißt: Man vergisst die UI und redet einfach mit Otto —
die Oberfläche macht sichtbar, was passiert, und bleibt sonst aus dem Weg.

## Brand Personality

Ruhig, präzise, futuristisch. Wie die Konsole eines Raumschiffs in Bereitschaft:
dunkel, konzentriert, mit einem lebendigen Kern (dem 3D-Orb). Der Orb ist der Held;
alles andere ist Instrumentierung. Deutsch, direkt, trockener Humor (Ottos Stimme,
nicht die UI).

## Anti-references

- Generische SaaS-Dashboards (Karten-Grids, Hero-Metriken, Gradient-Text).
- Chat-Apps: Otto ist kein Chatfenster mit Sprechblasen.
- Verspielte Sci-Fi-Klischees (Orbitron-Font, Neon-Overload, Scanline-Kitsch).
- Technik-Telemetrie im Vordergrund (Modellnamen, API-Details) — der Nutzer will
  sehen *was passiert*, nicht *womit*.

## Design Principles

1. **Der Orb ist die Bühne.** Alles andere ordnet sich unter; Panels erscheinen
   nur, wenn sie gebraucht werden, und gehen wieder.
2. **Zustand ist Farbe.** Bernstein = spricht, Eisblau = hört, Violett = denkt —
   konsequent durch die ganze App, nie dekorativ.
3. **Zeigen statt sagen.** Aktivität wird als lesbare Live-Zeile sichtbar
   („durchsucht das Web…"), nicht als Spinner oder Fachjargon.
4. **Motion trägt Bedeutung.** Panels gleiten, weil sich der Fokus verschiebt;
   nichts animiert ohne Zustandswechsel.
5. **Instrument, nicht Poster.** Mono-Schrift für Messwerte, ruhige Flächen,
   Dichte nur wo Inhalt ist.

## Accessibility & Inclusion

- `prefers-reduced-motion` wird überall respektiert (Orb statisch ruhig, Panels
  ohne Slide, Crossfades).
- Kontrast: Fließtext ≥ 4.5:1 auf dunklen Flächen; Zustandsfarben nie als einziges
  Signal (immer Text-Label daneben).
- Tastatur: sichtbarer Fokus, ⌘S im Editor, Buttons erreichbar.
