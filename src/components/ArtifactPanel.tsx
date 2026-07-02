import { useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Artifact, ImageState } from "../lib/types";

marked.setOptions({ gfm: true, breaks: true });

const KIND_GLYPH: Record<Artifact["kind"], string> = {
  markdown: "MD",
  code: "</>",
  html: "HTML",
  search: "WEB",
  image: "IMG",
};

type ImageAction = "favorite" | "delete" | "save";

interface ArtifactPanelProps {
  artifacts: Artifact[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  artifactStyle: string;
  images: Record<string, ImageState>;
  onImageAction: (id: string, action: ImageAction) => void;
}

function ImageGrid({
  ids,
  images,
  onAction,
}: {
  ids: string[];
  images: Record<string, ImageState>;
  onAction: (id: string, action: ImageAction) => void;
}) {
  const [zoomId, setZoomId] = useState<string | null>(null);
  const zoomed = zoomId ? images[zoomId] : null;

  return (
    <div className="artifact-body">
      <div className={`img-grid ${ids.length === 1 ? "single" : ""}`}>
        {ids.map((id) => {
          const st = images[id];
          const status = st?.status ?? "generating";
          return (
            <figure key={id} className={`img-cell ${status}`}>
              <div className="img-frame">
                {st?.url ? (
                  <img
                    src={st.url}
                    alt={st.meta?.name ?? "Generiertes Bild"}
                    onClick={() => status === "done" && setZoomId(id)}
                  />
                ) : (
                  <div className="img-placeholder" />
                )}
                {status === "generating" && <div className="img-scan" />}
                {status === "error" && (
                  <div className="img-error">{st?.error ?? "Fehler"}</div>
                )}
              </div>
              <figcaption>
                <span className="img-name" title={st?.meta?.prompt}>
                  {status === "generating" ? "generiert…" : (st?.meta?.name ?? id)}
                </span>
                {status === "done" && st?.meta && (
                  <span className="img-actions">
                    <button
                      title={st.meta.favorite ? "Favorit entfernen" : "Favorit"}
                      className={st.meta.favorite ? "fav on" : "fav"}
                      onClick={() => onAction(id, "favorite")}
                    >
                      ★
                    </button>
                    <button
                      title="Auf dem Schreibtisch speichern"
                      onClick={() => onAction(id, "save")}
                    >
                      ↓
                    </button>
                    <button title="Löschen" onClick={() => onAction(id, "delete")}>
                      ×
                    </button>
                  </span>
                )}
              </figcaption>
            </figure>
          );
        })}
      </div>
      {zoomed?.url && (
        <div className="img-lightbox" onClick={() => setZoomId(null)}>
          <img src={zoomed.url} alt={zoomed.meta?.name ?? ""} />
        </div>
      )}
    </div>
  );
}

/** Bindet STYLE.css in ein HTML-Artefakt ein — egal ob Fragment oder ganze Seite. */
function buildHtmlDoc(content: string, css: string): string {
  const style = `<style>${css}</style>`;
  if (/<html[\s>]/i.test(content)) {
    if (/<head[\s>]/i.test(content)) {
      return content.replace(/<head([^>]*)>/i, `<head$1>${style}`);
    }
    return content.replace(/<html([^>]*)>/i, `<html$1><head>${style}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${content}</body></html>`;
}

function handleLinkClick(e: React.MouseEvent) {
  const anchor = (e.target as HTMLElement).closest("a");
  if (anchor && /^https?:/.test(anchor.href)) {
    e.preventDefault();
    openUrl(anchor.href).catch(() => {});
  }
}

function MarkdownBody({ content }: { content: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(content, { async: false }) as string),
    [content],
  );
  return (
    <div
      className="md-body"
      onClick={handleLinkClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ArtifactBody({
  artifact,
  artifactStyle,
  images,
  onImageAction,
}: {
  artifact: Artifact;
  artifactStyle: string;
  images: Record<string, ImageState>;
  onImageAction: (id: string, action: ImageAction) => void;
}) {
  switch (artifact.kind) {
    case "image":
      return (
        <ImageGrid
          ids={artifact.imageIds ?? []}
          images={images}
          onAction={onImageAction}
        />
      );
    case "markdown":
      return (
        <div className="artifact-body">
          <MarkdownBody content={artifact.content} />
        </div>
      );
    case "code":
      return (
        <div className="artifact-body">
          <div className="code-body">{artifact.content}</div>
        </div>
      );
    case "html":
      return (
        <div className="artifact-body html-frame">
          <iframe
            title={artifact.title}
            sandbox="allow-scripts"
            srcDoc={buildHtmlDoc(artifact.content, artifactStyle)}
          />
        </div>
      );
    case "search":
      return (
        <div className="artifact-body">
          <p className="search-query">
            SUCHE&nbsp;→&nbsp;<b>{artifact.content}</b>
          </p>
          {(artifact.results ?? []).map((r, i) => (
            <div className="search-result" key={i}>
              <div className="src">
                <span>{r.host || new URL(r.url).hostname}</span>
                {r.age && <span>{r.age}</span>}
              </div>
              <h3>
                <a
                  href={r.url}
                  onClick={(e) => {
                    e.preventDefault();
                    openUrl(r.url).catch(() => {});
                  }}
                >
                  {r.title}
                </a>
              </h3>
              <p>{r.description}</p>
            </div>
          ))}
          {(artifact.results ?? []).length === 0 && (
            <p className="transcript-empty">Keine Treffer.</p>
          )}
        </div>
      );
  }
}

export default function ArtifactPanel({
  artifacts,
  activeId,
  onSelect,
  onClose,
  artifactStyle,
  images,
  onImageAction,
}: ArtifactPanelProps) {
  const active = artifacts.find((a) => a.id === activeId) ?? artifacts[0];

  const copy = () => {
    if (active) navigator.clipboard.writeText(active.content).catch(() => {});
  };

  return (
    <aside className="artifacts">
      <div className="artifacts-head">
        <div className="artifacts-eyebrow">
          <span>ARTEFAKTE</span>
          <span className="count">
            {artifacts.length > 0 ? `${artifacts.length}` : "—"}
          </span>
        </div>
        {artifacts.length > 0 && (
          <div className="artifact-tabs">
            {artifacts.map((a) => (
              <button
                key={a.id}
                className={active?.id === a.id ? "active" : ""}
                onClick={() => onSelect(a.id)}
                title={a.title}
              >
                <span className="kind">{KIND_GLYPH[a.kind]}</span>
                {a.title}
                <span
                  className="tab-close"
                  role="button"
                  aria-label={`${a.title} schließen`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(a.id);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {artifacts.length === 0 || !active ? (
        <div className="artifacts-empty">
          <div>
            <div className="glyph">[ ]</div>
            <p>
              Noch leer. Sag zum Beispiel: „Otto, such mal nach den Tauri-2-Neuerungen"
              oder „Erstell mir eine Packliste fürs Wochenende."
            </p>
          </div>
        </div>
      ) : (
        <div className="artifact-frame">
          <div className="artifact-meta">
            <span>
              {active.id} · {KIND_GLYPH[active.kind]}
              {active.language ? ` · ${active.language}` : ""}
            </span>
            <span className="actions">
              <button onClick={copy}>Kopieren</button>
            </span>
          </div>
          <ArtifactBody
            artifact={active}
            artifactStyle={artifactStyle}
            images={images}
            onImageAction={onImageAction}
          />
        </div>
      )}
    </aside>
  );
}
