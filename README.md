<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="Otto App-Icon" />
</p>

<h1 align="center">Otto</h1>

<p align="center">
  <strong>Dein Sprachassistent für den Mac.</strong><br />
  Otto lebt in der Menüleiste, hört zu, antwortet mit Stimme — und erledigt Dinge.
</p>

---

## Wer ist Otto?

Otto ist kein Programm, das du öffnest — er ist einfach da. Zweimal kurz die
⌘-Taste tippen, und eine kleine schwarze Insel erscheint unter der Notch: Otto
hört zu. Du redest mit ihm wie mit einer Person, er antwortet mit Stimme, auf
Deutsch, direkt und mit trockenem Humor. Wenn du fertig bist, drückst du wieder
zweimal ⌘ und er verschwindet — kein Fenster, kein Dock-Icon, nichts im Weg.

Während Otto arbeitet, zeigt die Insel in einer Zeile, was gerade passiert
(„durchsucht das Web…“) und leuchtet in seiner Zustandsfarbe: Eisblau, wenn er
zuhört. Bernstein, wenn er spricht. Violett, wenn er denkt.

## Was kann Otto?

**Antworten und recherchieren.** Otto sucht im Web, fasst mündlich zusammen und
legt die Quellen als kleine Vorschau unten links auf deinen Bildschirm — wie ein
Screenshot-Thumbnail. Ein Klick (oder „zeig mir das groß“) öffnet die
Vollansicht; kurze Zeit später räumen sich die Vorschauen von selbst wieder weg.

**Bilder erzeugen.** „Otto, mal mir ein Logo mit transparentem Hintergrund“ —
das Bild baut sich live in der kleinen Vorschau auf und landet in einer
dauerhaften Galerie. Bearbeiten, umbenennen, favorisieren, auf den Schreibtisch
speichern: alles per Zuruf.

**Inhalte erstellen.** Listen, Dokumente, Tabellen, Code, sogar kleine
gestaltete Seiten — alles, was man besser liest als hört, erscheint als echtes,
gerendertes Dokument.

**Den Mac bedienen.** Otto öffnet Apps, führt Terminal-Befehle aus und kann auf
Wunsch sogar selbst sehen, klicken und tippen (Computer Use). Größere Aufgaben
delegiert er an lokale Coding-Agenten und meldet sich, wenn das Ergebnis da ist —
du kannst währenddessen ganz normal weiterreden.

**Sich erinnern.** Otto merkt sich von Sitzung zu Sitzung, was wichtig war —
wer du bist, woran ihr arbeitet, was er gelernt hat. Sein Gedächtnis, seine
Persönlichkeit und seine Fähigkeiten liegen als einfache Textdateien auf deinem
Mac und lassen sich in den Einstellungen anpassen.

## Loslegen

1. **Otto installieren** — aktuelles Release laden, App in den Programme-Ordner
   ziehen, starten. Otto erscheint als Icon in der Menüleiste.

   > **Hinweis:** Otto ist (noch) nicht von Apple notarisiert. Meldet macOS,
   > die App sei „beschädigt“ oder könne nicht geöffnet werden, einmal im
   > Terminal ausführen:
   >
   > ```sh
   > xattr -cr /Applications/Otto.app
   > ```
2. **OpenAI-API-Key eintragen** — beim ersten Start öffnen sich die
   Einstellungen automatisch. Der Key bleibt lokal auf deinem Mac und wird nur
   direkt von dort verwendet.
3. **Zweimal ⌘ tippen** und losreden.

Optional: ein Brave-Search-Key für die Websuche (kostenlos) und ein
OpenRouter-Key für zusätzliche Bildmodelle — beides in den Einstellungen.
Für Computer Use fragt macOS einmalig nach den Freigaben für Bildschirmaufnahme
und Bedienungshilfen.

## Privatsphäre

Alles, was Otto über dich weiß, liegt bei dir: API-Keys, Gedächtnis,
Gesprächsprotokolle und die Bildgalerie werden ausschließlich lokal unter
`~/Library/Application Support/de.agentz.otto/` gespeichert. Gesprochen wird
direkt mit den KI-Diensten deiner eigenen Keys — es gibt keinen Server
dazwischen. Das optionale Wake Word („Hey Otto“) läuft komplett offline,
zeigt aber systembedingt dauerhaft das macOS-Mikrofon-Symbol; deshalb ist es
ab Werk aus und die Aktivierung läuft über den Hotkey.

---

<sub>Für Entwickler: Otto ist eine Tauri-2-App (React + Rust). Details zu
Architektur und Entwicklung stehen in [CLAUDE.md](CLAUDE.md) — Entwicklung mit
`npm run tauri dev`, Releases entstehen per Git-Tag über GitHub Actions.</sub>
