---
name: mac-shortcuts
description: Kurzbefehle des Nutzers ausführen (shortcuts CLI) — der mächtigste Hebel für alles, was Otto nicht direkt darf.
---

# Kurzbefehle (Shortcuts) ausführen

Die Shortcuts-App ist Ottos verlängerter Arm: Was der Nutzer dort visuell baut (HomeKit, Fokus-Modi, Smart-Home, App-Aktionen), führt Otto per CLI aus — die Berechtigungen trägt die Shortcuts-App, nicht Otto.

## Verfügbare Kurzbefehle auflisten

```
shortcuts list
```

Merke dir die Namen relevanter Kurzbefehle mit remember, dann musst du nicht jedes Mal listen.

## Kurzbefehl ausführen

```
shortcuts run "Guten Morgen"
```

## Mit Eingabe und Ausgabe

```
echo "Eingabetext" | shortcuts run "Mein Kurzbefehl" -o /tmp/otto-shortcut-out.txt && cat /tmp/otto-shortcut-out.txt
```

## Stolperfallen

- Der Kurzbefehl-Name muss EXAKT stimmen (Groß-/Kleinschreibung) — bei Unsicherheit erst `shortcuts list`.
- Kurzbefehle mit Interaktions-Bausteinen (Menüs, „Frage stellen“) blockieren headless — schlage dem Nutzer vor, eine interaktionsfreie Variante zu bauen.
- Existiert für einen Wunsch kein Kurzbefehl, sag dem Nutzer konkret, welchen er in der Shortcuts-App anlegen könnte — danach kannst du ihn steuern.
