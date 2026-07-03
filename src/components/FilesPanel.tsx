import { useEffect, useState } from "react";
import {
  agentDirPath,
  listAgentFiles,
  readAgentFile,
  writeAgentFile,
} from "../lib/tauriApi";

interface FilesPanelProps {
  onStyleChanged: () => void;
}

export default function FilesPanel({ onStyleChanged }: FilesPanelProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [dirPath, setDirPath] = useState("");
  const [newName, setNewName] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const names = await listAgentFiles();
      setFiles(names);
      setDirPath(await agentDirPath());
      if (names.length) {
        setActive(names[0]);
        setContent(await readAgentFile(names[0]));
      }
    })().catch((e) => setStatus(String(e)));
  }, []);

  async function select(name: string) {
    if (dirty && !window.confirm("Ungespeicherte Änderungen verwerfen?")) return;
    setActive(name);
    setContent(await readAgentFile(name));
    setDirty(false);
    setStatus(null);
  }

  async function save() {
    if (!active) return;
    try {
      await writeAgentFile(active, content);
      setDirty(false);
      if (active === "STYLE.css") {
        onStyleChanged();
        setStatus("Gespeichert — Design-Datei aktualisiert.");
      } else {
        setStatus("Gespeichert — gilt ab der nächsten Verbindung.");
      }
    } catch (e) {
      setStatus(String(e));
    }
  }

  async function createFile() {
    let name = newName.trim();
    if (!name) return;
    if (!name.endsWith(".md") && !name.endsWith(".css")) name += ".md";
    try {
      await writeAgentFile(
        name,
        name.endsWith(".css") ? "/* Neues Stylesheet */\n" : `# ${name.replace(/\.md$/, "")}\n\n`,
      );
      const names = await listAgentFiles();
      setFiles(names);
      setNewName("");
      await select(name);
    } catch (e) {
      setStatus(String(e));
    }
  }

  return (
    <section className="files-pane">
      <p className="files-sub">
        Diese Dateien formen Ottos Persona, Gedächtnis und ergänzende Designnotizen.
        Werkzeuge und Systemfähigkeiten kommen aus dem App-Code. &nbsp;·&nbsp;{" "}
        <span className="mono">{dirPath}</span>
      </p>

      <div className="files">
        <div className="file-list">
          {files.map((f) => (
            <button
              key={f}
              className={f === active ? "active" : ""}
              onClick={() => select(f)}
            >
              {f}
            </button>
          ))}
          <div className="file-new">
            <input
              type="text"
              placeholder="NEUE.md"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createFile()}
            />
            <button className="push" onClick={createFile}>
              +
            </button>
          </div>
        </div>

        <div className="editor">
          <div className="editor-head">
            <span className="name">
              {active ?? "—"}
              {dirty && <span className="dirty"> ●</span>}
            </span>
          </div>
          <textarea
            value={content}
            spellCheck={false}
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
              setStatus(null);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                save();
              }
            }}
          />
          <div className="editor-foot">
            <button className="push primary" onClick={save} disabled={!dirty}>
              Speichern
            </button>
            <span className="note">{status ?? "⌘S zum Speichern"}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
