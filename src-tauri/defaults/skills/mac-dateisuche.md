---
name: mac-dateisuche
description: Dateien blitzschnell systemweit finden — Spotlight (mdfind) über run_terminal, ganz ohne Berechtigungen.
---

# Dateien finden (Spotlight)

`mdfind` nutzt den Spotlight-Index: Ergebnisse in Millisekunden, keine TCC-Freigabe nötig. Immer über `run_terminal`.

## Nach Namen suchen

```
mdfind -name "Rechnung" | head -20
```

## Auf einen Ordner begrenzen

```
mdfind -onlyin ~/Documents "Vertrag Kündigungsfrist" | head -20
```

## Nach Typ + Zeitraum (Metadaten-Query)

```
mdfind 'kMDItemContentType == "com.adobe.pdf" && kMDItemFSCreationDate >= $time.today(-7)' -onlyin ~/Downloads
```

Nützliche Keys: `kMDItemFSName` (Dateiname), `kMDItemContentType`, `kMDItemFSCreationDate`, `kMDItemLastUsedDate`, `kMDItemAuthors`.

## Neueste Datei zuerst

`mdfind` sortiert nicht — für „die neueste“ kombiniere:

```
mdfind -onlyin ~/Downloads -name ".pdf" | head -50 | xargs -I{} stat -f "%m %N" "{}" | sort -rn | head -5
```

## Stolperfallen

- Volltext-Treffer (`"Begriff"` ohne -name) durchsuchen INHALTE — stark, aber liefert viel; mit `-onlyin` eingrenzen.
- Geschützte Ordner tauchen schlicht nicht auf (kein Fehler) — wenn nichts kommt, sag das ehrlich.
- Ergebnis-Pfade dem Nutzer als Markdown-Artefakt zeigen, wenn es mehr als 3 sind; einzelne Bilder kannst du mit import_image direkt zeigen.
