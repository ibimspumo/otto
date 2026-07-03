// Werkzeug-Definitionen für die Realtime API (Function Calling).

export const toolDefs = [
  {
    type: "function",
    name: "create_artifact",
    description:
      "Erstellt ein neues Artefakt. Es erscheint als kleine Live-Vorschau (Drop) unten links. Nutze dies für alles, was der Nutzer lesen statt hören sollte: Listen, Code, Tabellen, Entwürfe, Zusammenfassungen. Gibt die id des Artefakts zurück.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Kurzer Titel des Artefakts" },
        kind: {
          type: "string",
          enum: ["markdown", "code", "html"],
          description:
            "markdown für Texte/Listen/Tabellen; code für Quelltext; html für gestaltete statische Seiten oder Dashboards. HTML-Artefakte führen aus Sicherheitsgründen kein JavaScript aus. In HTML-Artefakte wird STYLE.css automatisch eingebunden — nutze dessen CSS-Variablen und Klassen (.card, .grid, .badge, .kpi, .bar, .muted).",
        },
        language: {
          type: "string",
          description: "Programmiersprache, nur bei kind=code (z. B. python)",
        },
        content: { type: "string", description: "Vollständiger Inhalt" },
        present: {
          type: "boolean",
          description:
            "true = direkt groß öffnen (Quick Look) statt nur als kleine Vorschau — wenn der Nutzer den Inhalt sofort sehen will („zeig mir…“, „mach mal auf…“).",
        },
      },
      required: ["title", "kind", "content"],
    },
  },
  {
    type: "function",
    name: "present_artifact",
    description:
      "Öffnet ein Artefakt groß, noch größer als Lightbox oder verkleinert die Ansicht zurück in den Stapel. Nutze „gross“, wenn der Nutzer sagt „öffne/zeig mir das groß“; nutze „riesig“, wenn er „noch größer“, „maximal“, „Lightbox“ oder ähnlich sagt. Ohne id wird das neueste Artefakt genommen.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["gross", "riesig", "klein"],
          description:
            "gross = Quick Look öffnen, riesig = große Lightbox öffnen, klein = zurück in den Stapel",
        },
        id: {
          type: "string",
          description: "Optional: id des Artefakts (Standard: das neueste)",
        },
      },
      required: ["mode"],
    },
  },
  {
    type: "function",
    name: "update_artifact",
    description:
      "Ersetzt den Inhalt eines bestehenden Artefakts (per id). Nutze dies, um iterativ am selben Dokument zu arbeiten.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Die id des Artefakts" },
        title: { type: "string", description: "Optional: neuer Titel" },
        content: { type: "string", description: "Neuer vollständiger Inhalt" },
      },
      required: ["id", "content"],
    },
  },
  {
    type: "function",
    name: "web_search",
    description:
      "Websuche über Brave Search. Die Ergebnisse erscheinen automatisch im Artefakt-Panel; du bekommst sie zusätzlich als JSON zurück. Nutze dies für aktuelle oder unsichere Fakten.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Suchanfrage" },
        count: {
          type: "number",
          description: "Anzahl Ergebnisse (1–20, Standard 6)",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "toggle_artifact_panel",
    description:
      "Blendet den Ergebnis-Stapel (die Drops unten links) ein oder aus. Er erscheint automatisch, wenn du ein Artefakt erstellst — nutze dies, um ihn auf Wunsch des Nutzers zu schließen oder wieder zu zeigen.",
    parameters: {
      type: "object",
      properties: {
        visible: { type: "boolean", description: "true = einblenden, false = ausblenden" },
      },
      required: ["visible"],
    },
  },
  {
    type: "function",
    name: "close_artifact",
    description:
      "Verwirft ein Artefakt aus dem Stapel. Die ids stehen in den Ergebnissen von create_artifact/web_search oder via list_artifacts — frag den Nutzer NICHT nach ids. \"all\" verwirft alle. Wird das letzte Artefakt verworfen, verschwindet der Stapel.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Die id des Artefakts oder \"all\" für alle",
        },
      },
      required: ["id"],
    },
  },
  {
    type: "function",
    name: "list_artifacts",
    description:
      "Listet die Artefakte im Stapel (id, Titel, Typ) und ob er sichtbar ist. Nutze dies, bevor du Artefakte verwirfst oder wenn du dich auf vorhandene beziehen willst.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "run_terminal",
    description:
      "Führt einen kurzen Shell-Befehl auf dem Mac aus (zsh) und liefert stdout/stderr/exit_code. Gedacht für Systemaufgaben wie Apps öffnen oder Status auslesen. Standardmäßig gilt eine strenge Positivliste: destruktive Befehle, Datei-Umleitungen, Downloads, Netzwerk-Shell-Pipelines, Rechteänderungen und freie AppleScript-Automation werden blockiert. Ist der YOLO-Modus aktiv (Systemnachricht sagt es dir), entfallen diese Schranken und du hast vollen Terminal-Zugriff mit den Rechten des Nutzers. Für alles, was länger als ~20 Sekunden dauern könnte, setze background=true: der Befehl läuft dann als Hintergrund-Job, du bekommst sofort eine job_id und bleibst ansprechbar; das Ergebnis kommt automatisch als Systemnachricht (abbrechen mit cancel_job).",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Der Shell-Befehl" },
        timeout_s: {
          type: "number",
          description: "Timeout in Sekunden (Standard 30, max 300; nur ohne background)",
        },
        background: {
          type: "boolean",
          description:
            "true = als Hintergrund-Job starten (sofortige Rückkehr mit job_id)",
        },
      },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "delegate_task",
    description:
      "Delegiert eine Aufgabe an einen lokalen Hintergrund-Agenten (Codex CLI oder Claude CLI) mit vollem Datei- und Terminal-Zugriff auf diesem Mac. Nutze dies für alles, was länger dauert oder mehrere Schritte braucht: programmieren, Dateien suchen/umbauen, Projekte analysieren, mehrstufige Terminal-Arbeit. Der Aufruf kehrt SOFORT mit einer job_id zurück — du bleibst ansprechbar und das Ergebnis kommt automatisch als Systemnachricht. Kündige dem Nutzer knapp an, dass du dich meldest, sobald es fertig ist. Soll der Agent Bilder erzeugen, weise ihn in der Aufgabe an, am Ende die absoluten Dateipfade der Ergebnisse auszugeben — solche Bilder werden nach Job-Ende automatisch in die Galerie importiert und die Galerie-ids stehen in der Ergebnis-Nachricht (kein import_image nötig).",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Die Aufgabe, vollständig und präzise — mit allem Kontext (Pfade, Ziel, Fertig-Kriterium), denn der Agent kennt euer Gespräch nicht",
        },
        agent: {
          type: "string",
          enum: ["codex", "claude"],
          description:
            "Optional. Ohne Angabe gilt der Standard aus den Einstellungen; beachte die Hinweise des Nutzers, wofür welcher Agent besser ist.",
        },
        cwd: {
          type: "string",
          description:
            "Optional: Arbeitsverzeichnis (absolut oder ~/…). Standard: Home-Ordner.",
        },
      },
      required: ["task"],
    },
  },
  {
    type: "function",
    name: "cancel_job",
    description:
      "Bricht einen laufenden Hintergrund-Job ab (von delegate_task). \"all\" bricht alle laufenden Jobs ab. Nutze dies sofort, wenn der Nutzer abbrechen will.",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Die job_id oder \"all\"" },
      },
      required: ["job_id"],
    },
  },
  {
    type: "function",
    name: "generate_image",
    description:
      "Generiert 1–8 Bilder und zeigt sie live im Artefakt-Panel. Welches Modell rechnet (GPT Image 2 oder Nano Banana via OpenRouter), wählt der Nutzer in den Einstellungen. Standard: 1 Bild, quadratisch, 1K, quality auto. Bei Logos/Icons/Stickern setze transparent=true (wechselt automatisch zu gpt-image-1, dem einzigen Modell mit Transparenz). Die zurückgegebenen ids und Nummern brauchst du für edit_image, open_image usw.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Bildbeschreibung, detailliert" },
        n: { type: "number", description: "Anzahl Varianten (1–8, Standard 1)" },
        aspect: {
          type: "string",
          enum: ["square", "landscape", "portrait", "wide"],
          description: "Seitenverhältnis (Standard square; wide = 16:9)",
        },
        resolution: {
          type: "string",
          enum: ["1K", "2K", "4K"],
          description: "Auflösung (Standard 1K)",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high", "auto"],
          description: "Standard auto; high nur für finale Assets",
        },
        transparent: {
          type: "boolean",
          description: "Transparenter Hintergrund (Logos, Icons, Sticker)",
        },
        name: { type: "string", description: "Kurzer Name fürs Bild (Galerie)" },
        model: {
          type: "string",
          description:
            "Optional: Modell-Override für dieses Bild (z. B. gpt-image-2 oder ein OpenRouter-Slug wie black-forest-labs/flux…). Unbekannte Wünsche zuerst mit find_image_model auflösen; ohne Angabe gilt das Modell aus den Einstellungen.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: "edit_image",
    description:
      "Bearbeitet ein bestehendes Bild aus der Galerie (per id oder Nummer) mit einer Anweisung, z. B. „setz dem Hund einen roten Hut auf“. Erzeugt n neue Bilder in der Galerie; das Original bleibt erhalten. Für höhere Auflösung derselben Idee: resolution angeben.",
    parameters: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description:
            "Ausgangsbild: id (img-…), Galerie-Nummer (6), lokaler Dateipfad (~/Desktop/foto.jpg) oder Bild-URL — Pfade und URLs werden automatisch importiert",
        },
        prompt: { type: "string", description: "Was geändert werden soll" },
        n: { type: "number", description: "Anzahl Varianten (Standard 1)" },
        resolution: {
          type: "string",
          enum: ["1K", "2K", "4K"],
          description: "Optional: Zielauflösung",
        },
        aspect: {
          type: "string",
          enum: ["square", "landscape", "portrait", "wide"],
        },
        quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
        name: { type: "string", description: "Name für das Ergebnis" },
        model: {
          type: "string",
          description:
            "Optional: Modell-Override (siehe generate_image); ohne Angabe gilt das Modell aus den Einstellungen.",
        },
      },
      required: ["image", "prompt"],
    },
  },
  {
    type: "function",
    name: "find_image_model",
    description:
      "Durchsucht die verfügbaren Bildmodelle (OpenAI + alle OpenRouter-Modelle) unscharf nach Name oder Anbieter — z. B. „flux“, „seedream“, „nano banana“. Nutze dies, wenn der Nutzer ein bestimmtes Modell möchte, und übergib die gefundene id dann als model an generate_image/edit_image.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Suchbegriff (Modellname, Anbieter)" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "open_image",
    description:
      "Öffnet ein Bild aus der Galerie direkt groß (Quick Look, per id oder Nummer).",
    parameters: {
      type: "object",
      properties: {
        image: { type: "string", description: "id oder Galerie-Nummer" },
      },
      required: ["image"],
    },
  },
  {
    type: "function",
    name: "import_image",
    description:
      "Importiert ein Bild in die Galerie — von einem lokalen Dateipfad (absolut oder ~/…) oder einer Bild-URL aus dem Web. Es wird automatisch komprimiert (max. 2048 px) und ist danach wie jedes Galerie-Bild nutzbar, z. B. als Ausgangsbild für edit_image.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Dateipfad (z. B. ~/Desktop/foto.jpg) oder http(s)-URL",
        },
        name: { type: "string", description: "Optional: Name in der Galerie" },
      },
      required: ["source"],
    },
  },
  {
    type: "function",
    name: "show_gallery",
    description:
      "Zeigt die komplette Bildbibliothek (alle gespeicherten Bilder aus allen Sitzungen) direkt groß als Galerie (Quick Look).",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "list_images",
    description:
      "Listet alle Bilder der Galerie mit Nummer, id, Name, Prompt und Favoriten-Status. Nutze dies, wenn der Nutzer sich auf „Bild Nummer X“ bezieht und du die id nicht kennst.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "manage_image",
    description:
      "Verwaltet ein Bild der Galerie: löschen, umbenennen, favorisieren/entfavorisieren oder auf dem Rechner speichern (Standard-Ziel: Schreibtisch).",
    parameters: {
      type: "object",
      properties: {
        image: { type: "string", description: "id oder Galerie-Nummer" },
        action: {
          type: "string",
          enum: ["delete", "rename", "favorite", "unfavorite", "save"],
        },
        name: { type: "string", description: "Neuer Name (bei rename)" },
        destination: {
          type: "string",
          description:
            "Bei save: \"desktop\" (Standard), \"downloads\" oder absoluter Ordnerpfad",
        },
      },
      required: ["image", "action"],
    },
  },
  {
    type: "function",
    name: "get_artifact_style",
    description:
      "Liest STYLE.css — das Design-System, das automatisch in alle HTML-Artefakte eingebunden wird.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "set_artifact_style",
    description:
      "Ersetzt STYLE.css vollständig. Alle HTML-Artefakte (auch bereits angezeigte) verwenden sofort das neue Design-System. Nutze dies, wenn der Nutzer das Aussehen der Artefakte ändern möchte.",
    parameters: {
      type: "object",
      properties: {
        css: { type: "string", description: "Der vollständige neue CSS-Inhalt" },
      },
      required: ["css"],
    },
  },
  {
    type: "function",
    name: "remember",
    description:
      "Speichert eine dauerhafte Notiz in MEMORY.md, die du in künftigen Sitzungen liest. Nur für langfristig Wichtiges (Namen, Vorlieben, Projekte). MEMORY.md hat ein hartes Budget — bei Überlauf bekommst du einen Fehler und musst zuerst mit rewrite_memory konsolidieren (Überlappendes zusammenfassen, Veraltetes löschen).",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "Die Notiz, ein Satz" },
      },
      required: ["note"],
    },
  },
  {
    type: "function",
    name: "rewrite_memory",
    description:
      "Ersetzt MEMORY.md vollständig durch eine konsolidierte Fassung. Nutze dies, wenn remember wegen des Budgets fehlschlägt oder der Nutzer sein Gedächtnis aufräumen lässt: Überlappende Einträge zusammenfassen, Veraltetes entfernen, Wichtiges behalten. Struktur: Überschrift + Stichpunkte mit Datum.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Der vollständige neue Inhalt von MEMORY.md",
        },
      },
      required: ["content"],
    },
  },
  {
    type: "function",
    name: "search_sessions",
    description:
      "Volltextsuche über alle gespeicherten Gesprächsprotokolle vergangener Sitzungen (lokal, SQLite). Nutze dies, wenn der Nutzer sich auf frühere Gespräche bezieht („was hatten wir letzte Woche zu X besprochen?“) oder du Kontext aus der Vergangenheit brauchst, der nicht in MEMORY.md steht.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Suchbegriffe" },
        limit: { type: "number", description: "Max. Treffer (Standard 12)" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "read_skill",
    description:
      "Liest die vollständige Anleitung eines deiner Skills (die Liste mit Namen + Beschreibungen steht in deinen Instructions). Lies einen Skill IMMER, bevor du eine Aufgabe angehst, für die es einen passenden Skill gibt.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Der Skill-Name (kebab-case)" },
      },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "save_skill",
    description:
      "Legt einen Skill an oder aktualisiert ihn — eine wiederverwendbare Anleitung für eine Aufgabenart, die du künftig besser lösen willst. Speichere einen Skill NUR nach verifiziertem Erfolg (die Lösung hat nachweislich funktioniert), nach gelöstem Debugging oder wenn der Nutzer dich korrigiert hat. Format: YAML-Frontmatter (---, name: …, description: einzeiliger Auslöser-Satz, ---), danach Abschnitte „## Wann“, „## Vorgehen“, „## Stolperfallen“, „## Verifikation“. Kurz und konkret — keine Romane.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill-Name in kebab-case (z. B. spotify-steuerung)",
        },
        content: {
          type: "string",
          description: "Vollständiger Skill-Inhalt inkl. Frontmatter",
        },
      },
      required: ["name", "content"],
    },
  },
  {
    type: "function",
    name: "delete_skill",
    description:
      "Löscht einen Skill, der sich als falsch oder überflüssig erwiesen hat.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Der Skill-Name" },
      },
      required: ["name"],
    },
  },
];

export const INSTRUCTIONS_PREAMBLE = `Du bist Otto, ein deutschsprachiger Echtzeit-Sprachassistent. Du lebst als kleine Insel am Notch dieses Macs — es gibt kein klassisches App-Fenster. Der Nutzer ruft dich per Hotkey oder Zuruf und du erledigst Dinge; Ergebnisse erscheinen als kleine Live-Vorschauen (Drops) unten links, die der Nutzer per Klick vergrößert.
Neben deiner Stimme hast du Artefakte: Mit create_artifact und update_artifact zeigst du Inhalte (markdown, code oder html), mit web_search suchst du im Web (Ergebnisse erscheinen automatisch als Artefakt). Der Stapel gleitet automatisch herein, wenn du etwas erstellst; mit toggle_artifact_panel und close_artifact steuerst du ihn. Sagt der Nutzer „öffne/zeig mir das groß“, nutzt du present_artifact mit mode=gross; sagt er „noch größer“, „maximal“, „Lightbox“ oder ähnlich, nutzt du mode=riesig; sagt er „mach das wieder klein“, nutzt du mode=klein. Bei create_artifact kannst du mit present=true direkt groß öffnen. HTML-Artefakte binden automatisch das Design-System STYLE.css ein und führen kein JavaScript aus; mit get_artifact_style/set_artifact_style kannst du es lesen und umgestalten. Mit run_terminal führst du nur sichere, kurze Shell-Befehle aus (harmlose Status-/App-Aktionen; destruktive oder frei automatisierende Befehle werden blockiert; für Längeres background=true, dann bleibst du ansprechbar).
Gedächtnis: Du hast drei Schichten. (1) MEMORY.md und USER.md unten — kuratiertes Langzeitwissen, wird automatisch gepflegt. (2) Tagesnotizen der letzten Tage — rohe Fakten aus jüngsten Gesprächen, stehen ebenfalls unten. (3) search_sessions — Volltextsuche über ALLE alten Gesprächsprotokolle, wenn sich der Nutzer auf Früheres bezieht. Mit remember hältst du sofort Wichtiges in MEMORY.md fest (Budget beachten; bei Überlauf rewrite_memory). Frag NIE nach Dingen, die du selbst nachschlagen kannst — erst suchen (search_sessions, run_terminal, web_search), dann fragen.
Skills: Unten steht eine Liste deiner Skills (Name + Beschreibung). Passt einer zur Aufgabe, lies ihn ZUERST mit read_skill und folge ihm. Nach verifiziertem Erfolg bei einer neuen, wiederkehrenden Aufgabenart legst du mit save_skill selbst einen an (kurz, konkret, mit Stolperfallen) — so wirst du von Mal zu Mal besser. Falsche Skills löschst du mit delete_skill.
Bilder: Mit generate_image erzeugst du Bilder (Standard 1K quadratisch; „Logo“ → transparent=true; „4K“ → resolution="4K"; „zwei Versionen“ → n=2). Wünscht der Nutzer ein bestimmtes Modell („nimm mal Flux“), löst du es mit find_image_model auf und übergibst die id als model. Mit edit_image bearbeitest du ein vorhandenes Bild weiter. Der Nutzer zählt Bilder nach Galerie-Nummer („Bild 6“) — Nummern stehen in den Tool-Ergebnissen oder via list_images. open_image zeigt ein Bild groß, show_gallery die ganze Bibliothek, manage_image löscht/benennt/favorisiert/speichert. Die Bibliothek ist persistent.
Für alles Größere gibt es delegate_task: Es startet einen lokalen Hintergrund-Agenten (Codex CLI oder Claude CLI) mit Datei- und Terminal-Zugriff und kehrt sofort zurück — du bleibst ansprechbar, das Ergebnis kommt automatisch als Systemnachricht und du berichtest dann knapp. Erzeugt ein Job Bilddateien, gib dem Agenten in der Aufgabe mit, am Ende die absoluten Pfade auszugeben — diese Bilder landen automatisch in der Galerie und die Galerie-ids stehen in der Ergebnis-Nachricht. Mit cancel_job brichst du laufende Jobs (auch Hintergrund-Terminals) ab, sobald der Nutzer das will.
Werkzeuge nutzt du still: kein Zwang, Wartezeiten zu füllen — die Insel zeigt dem Nutzer live an, was gerade passiert. Nach dem Ergebnis fasst du mündlich knapp zusammen, Details stehen im Artefakt.
Die folgenden Dateien und Abschnitte definieren deine Identität, dein Wissen über den Nutzer, dein Gedächtnis, deine Skills und das Artefakt-Design. Halte dich an sie.`;
