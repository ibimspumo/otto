import { useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import {
  ArtifactBody,
  buildHtmlDoc,
  Favicon,
  MarkdownBody,
  safeHost,
  type ImageAction,
} from "./components/ArtifactContent";
import { DROP_W, layoutDrops, layoutQuickLook } from "./lib/hudWindow";
import type { Artifact, ImageState } from "./lib/types";

/** Zustand, den das Hauptfenster (der Orchestrator) hierher spiegelt. */
interface PanelState {
  artifacts: Artifact[];
  activeId: string | null;
  images: Record<string, ImageState>;
  artifactStyle: string;
}

type Mode = "stack" | "quicklook";

// ------------------------------------------------------------------
// Stapel-Geometrie: deterministisch berechnet, damit das Fenster exakt
// so hoch ist wie sein Inhalt (kein unsichtbarer Klick-Fresser).
// ------------------------------------------------------------------

const HERO_HEAD = 30;
const ROW_H = 44;
const GAP = 10;
const CHIP_H = 24;

function parseSize(size?: string): { w: number; h: number } | null {
  if (!size) return null;
  const [w, h] = size.split("x").map((v) => parseInt(v, 10));
  return w > 0 && h > 0 ? { w, h } : null;
}

/** Höhe der Hero-Vorschau — Bilder bekommen ihre echte Aspect Ratio. */
function heroPreviewHeight(
  a: Artifact,
  images: Record<string, ImageState>,
): number {
  if (a.kind === "image") {
    const first = (a.imageIds ?? [])[0];
    const st = first ? images[first] : undefined;
    const dims = parseSize(st?.meta?.size ?? st?.size);
    if (dims) {
      return Math.round(Math.min(240, Math.max(120, DROP_W * (dims.h / dims.w))));
    }
    return 190;
  }
  if (a.kind === "html") return 186;
  return 148;
}

function stackHeight(
  artifacts: Artifact[],
  images: Record<string, ImageState>,
): number {
  if (artifacts.length === 0) return ROW_H;
  const hero = artifacts[artifacts.length - 1];
  const rows = Math.min(3, artifacts.length - 1);
  const overflow = artifacts.length - 1 - rows;
  return (
    HERO_HEAD +
    heroPreviewHeight(hero, images) +
    rows * (ROW_H + GAP) +
    (overflow > 0 ? CHIP_H + GAP : 0)
  );
}

/** Gewünschte Quick-Look-Größe je Artefakt-Typ (logische Punkte). */
function desiredQuickLook(
  a: Artifact,
  images: Record<string, ImageState>,
): { w: number; h: number } {
  switch (a.kind) {
    case "image": {
      const ids = a.imageIds ?? [];
      if (ids.length === 1) {
        const st = images[ids[0]];
        const dims = parseSize(st?.meta?.size ?? st?.size);
        if (dims) {
          // Halbe Pixelmaße = natürliche Retina-Darstellungsgröße; die
          // Aspect Ratio des Fensters IST die des Bildes.
          return { w: Math.max(380, dims.w / 2), h: Math.max(300, dims.h / 2) };
        }
        return { w: 720, h: 560 };
      }
      return { w: 960, h: 660 };
    }
    case "html":
      return { w: 980, h: 700 };
    case "search":
      return { w: 620, h: 680 };
    default:
      return { w: 720, h: 680 };
  }
}

// ------------------------------------------------------------------
// Miniatur-Vorschauen: jeder Typ ECHT gerendert, nie Rohtext.
// ------------------------------------------------------------------

function DropPreview({
  artifact,
  images,
  artifactStyle,
}: {
  artifact: Artifact;
  images: Record<string, ImageState>;
  artifactStyle: string;
}) {
  switch (artifact.kind) {
    case "image": {
      const ids = artifact.imageIds ?? [];
      const st = ids[0] ? images[ids[0]] : undefined;
      return (
        <div className="mini-image">
          {st?.url ? (
            <img src={st.url} alt={artifact.title} />
          ) : (
            <div className="img-placeholder" />
          )}
          {ids.length > 1 && <span className="mini-more">+{ids.length - 1}</span>}
          {st?.status === "error" && (
            <div className="img-error">{st.error ?? "Fehler"}</div>
          )}
        </div>
      );
    }
    case "html":
      // Die Seite selbst, auf ein Drittel verkleinert — keine Interaktion.
      return (
        <div className="mini-html" aria-hidden>
          <iframe
            title={`${artifact.title} (Vorschau)`}
            sandbox="allow-scripts"
            tabIndex={-1}
            srcDoc={buildHtmlDoc(artifact.content, artifactStyle)}
          />
        </div>
      );
    case "markdown":
      return (
        <div className="mini-doc" aria-hidden>
          <div className="mini-doc-scale">
            <MarkdownBody content={artifact.content} />
          </div>
        </div>
      );
    case "code":
      return (
        <div className="mini-code" aria-hidden>
          <pre>{artifact.content.slice(0, 1600)}</pre>
        </div>
      );
    case "search":
      return (
        <div className="mini-search">
          {(artifact.results ?? []).slice(0, 3).map((r, i) => {
            const host = r.host || safeHost(r.url);
            return (
              <p key={i} className="mini-hit">
                <Favicon host={host} />
                <b>{r.title}</b>
                <span>{host}</span>
              </p>
            );
          })}
        </div>
      );
  }
}

const KIND_LABEL: Record<Artifact["kind"], string> = {
  markdown: "Dokument",
  code: "Code",
  html: "Seite",
  search: "Suche",
  image: "Bild",
};

function isGenerating(a: Artifact, images: Record<string, ImageState>): boolean {
  return (
    a.kind === "image" &&
    (a.imageIds ?? []).some((id) => images[id]?.status === "generating")
  );
}

// ------------------------------------------------------------------
// Das Panel: Drop-Stapel unten links, Quick Look zentriert.
// ------------------------------------------------------------------

export default function PanelApp() {
  const [state, setState] = useState<PanelState>({
    artifacts: [],
    activeId: null,
    images: {},
    artifactStyle: "",
  });
  const [mode, setMode] = useState<Mode>("stack");
  const [qlId, setQlId] = useState<string | null>(null);
  // Quick-Look-Wunsch per Stimme, dessen Artefakt noch nicht im
  // gespiegelten Zustand angekommen ist — wird beim nächsten Update eingelöst.
  const [pendingQl, setPendingQl] = useState<string | null>(null);
  const readySent = useRef(false);
  const modeRef = useRef<Mode>("stack");
  modeRef.current = mode;
  const stateRef = useRef<PanelState>(state);
  stateRef.current = state;
  const qlIdRef = useRef<string | null>(null);
  qlIdRef.current = qlId;

  useEffect(() => {
    const unState = listen<PanelState>("panel-state", (e) => setState(e.payload));
    // fresh = das Fenster war zu und geht neu auf: immer im Stapel starten.
    const unOpen = listen<{ fresh?: boolean }>("panel-open", (e) => {
      if (e.payload?.fresh) {
        setMode("stack");
        setQlId(null);
      }
    });
    // Quick Look per Stimme (present_artifact) — wirkt wie ein Klick.
    const unPresent = listen<{ mode: "gross" | "klein"; id?: string }>(
      "panel-present",
      (e) => {
        if (e.payload.mode === "klein") {
          setMode("stack");
          setQlId(null);
          setPendingQl(null);
          return;
        }
        const arts = stateRef.current.artifacts;
        const target = e.payload.id
          ? arts.find((a) => a.id === e.payload.id)
          : arts[arts.length - 1];
        if (target) {
          setQlId(target.id);
          setMode("quicklook");
        } else if (e.payload.id) {
          // Artefakt eilt dem panel-state-Spiegel voraus — vormerken.
          setPendingQl(e.payload.id);
        }
      },
    );
    if (!readySent.current) {
      readySent.current = true;
      void emit("panel-ready", {});
    }
    return () => {
      unState.then((f) => f());
      unOpen.then((f) => f());
      unPresent.then((f) => f());
    };
  }, []);

  // Esc: Quick Look → zurück zum Stapel; Stapel → Fenster schließen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (modeRef.current === "quicklook") {
        setMode("stack");
        setQlId(null);
      } else {
        void emit("panel-close", {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { artifacts, images, artifactStyle } = state;
  const hero = artifacts[artifacts.length - 1] ?? null;
  const older = artifacts.slice(0, -1);
  const rows = older.slice(-3);
  const overflow = older.length - rows.length;

  const qlArtifact = qlId
    ? (artifacts.find((a) => a.id === qlId) ?? null)
    : null;

  // Wird das Quick-Look-Artefakt geschlossen (z. B. per Stimme), fällt das
  // Fenster in den Stapel zurück.
  useEffect(() => {
    if (mode === "quicklook" && qlId && !artifacts.some((a) => a.id === qlId)) {
      setMode("stack");
      setQlId(null);
    }
  }, [mode, qlId, artifacts]);

  // Vorgemerkten Quick-Look-Wunsch einlösen, sobald das Artefakt im
  // gespiegelten Zustand angekommen ist.
  useEffect(() => {
    if (!pendingQl) return;
    if (artifacts.some((a) => a.id === pendingQl)) {
      setQlId(pendingQl);
      setMode("quicklook");
      setPendingQl(null);
    }
  }, [pendingQl, artifacts]);

  // Aufgeräumt wie Screenshots: Fertige Drops verschwinden nach 3 Minuten
  // von selbst — nie während der Generierung, nie das gerade Geöffnete.
  useEffect(() => {
    const EXPIRE_MS = 3 * 60_000;
    const tick = setInterval(() => {
      const { artifacts: arts, images: imgs } = stateRef.current;
      const now = Date.now();
      for (const a of arts) {
        if (a.id === qlIdRef.current) continue;
        if (isGenerating(a, imgs)) continue;
        // Bilder gelten ab dem Speicherzeitpunkt des letzten Bildes als
        // fertig, alles andere ab der letzten Änderung.
        const doneAt =
          a.kind === "image"
            ? Math.max(
                a.updatedAt,
                ...(a.imageIds ?? []).map(
                  (id) => imgs[id]?.meta?.created_ms ?? 0,
                ),
              )
            : a.updatedAt;
        if (now - doneAt > EXPIRE_MS) {
          void emit("panel-action", { type: "close", id: a.id });
        }
      }
    }, 15_000);
    return () => clearInterval(tick);
  }, []);

  // Stapel-Modus: Fenstergröße folgt exakt dem Inhalt.
  const stackH = useMemo(() => stackHeight(artifacts, images), [artifacts, images]);
  useEffect(() => {
    if (mode === "stack") void layoutDrops(stackH);
  }, [mode, stackH]);

  // Quick Look: Fenster wächst zur Inhaltsgröße (Bilder in echter Ratio).
  useEffect(() => {
    if (mode !== "quicklook" || !qlArtifact) return;
    const want = desiredQuickLook(qlArtifact, images);
    void layoutQuickLook(want.w, want.h);
    // Bewusst nur bei Artefakt-/Größenwechsel, nicht bei jedem images-Tick:
    // die Ratio steht schon während der Generierung fest (size).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, qlArtifact?.id, qlArtifact?.updatedAt]);

  const openQuickLook = (a: Artifact) => {
    setQlId(a.id);
    setMode("quicklook");
    void emit("panel-action", { type: "select", id: a.id });
  };

  const dismissDrop = (id: string) => {
    void emit("panel-action", { type: "close", id });
  };

  const onImageAction = (id: string, action: ImageAction) => {
    void emit("panel-action", { type: "image", id, action });
  };

  // --- Quick Look ---------------------------------------------------
  if (mode === "quicklook" && qlArtifact) {
    const copyable = qlArtifact.kind !== "image";
    return (
      <div className="ql-shell" data-kind={qlArtifact.kind}>
        <div className="ql-bar" data-tauri-drag-region>
          <button
            className="ql-close"
            title="Zurück (Esc)"
            aria-label="Zurück zum Stapel"
            onClick={() => {
              setMode("stack");
              setQlId(null);
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <span className="ql-title" data-tauri-drag-region>
            {qlArtifact.title}
          </span>
          <span className="ql-actions">
            {copyable && (
              <button
                onClick={() =>
                  navigator.clipboard.writeText(qlArtifact.content).catch(() => {})
                }
              >
                Kopieren
              </button>
            )}
          </span>
        </div>
        <div className="ql-content">
          <ArtifactBody
            artifact={qlArtifact}
            artifactStyle={artifactStyle}
            images={images}
            onImageAction={onImageAction}
          />
        </div>
      </div>
    );
  }

  // --- Drop-Stapel ---------------------------------------------------
  return (
    <div className="drops">
      {overflow > 0 && (
        <div className="drop-chip">{overflow} weitere im Stapel</div>
      )}
      {rows.map((a) => (
        <div key={a.id} className="drop row" onClick={() => openQuickLook(a)}>
          <span className="drop-kind">{KIND_LABEL[a.kind]}</span>
          <span className="drop-row-title">{a.title}</span>
          <button
            className="drop-close"
            title="Verwerfen"
            aria-label={`${a.title} verwerfen`}
            onClick={(e) => {
              e.stopPropagation();
              dismissDrop(a.id);
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ))}
      {hero && (
        <div
          key={hero.id}
          className={`drop hero ${isGenerating(hero, images) ? "generating" : ""}`}
          onClick={() => openQuickLook(hero)}
          title="Klicken zum Vergrößern"
        >
          <div className="drop-head">
            <span className="drop-kind">{KIND_LABEL[hero.kind]}</span>
            <span className="drop-title">{hero.title}</span>
            <button
              className="drop-close"
              title="Verwerfen"
              aria-label={`${hero.title} verwerfen`}
              onClick={(e) => {
                e.stopPropagation();
                dismissDrop(hero.id);
              }}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <div
            className="drop-preview"
            style={{ height: heroPreviewHeight(hero, images) }}
          >
            <DropPreview
              artifact={hero}
              images={images}
              artifactStyle={artifactStyle}
            />
          </div>
          {/* Die Lebensader: 2px Zustandslicht, solange generiert wird. */}
          <div className="drop-life" aria-hidden />
        </div>
      )}
    </div>
  );
}
