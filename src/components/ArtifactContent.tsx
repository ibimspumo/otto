// Gemeinsame Inhalts-Renderer für Artefakte — genutzt von Quick Look
// (Vollansicht) und, in skalierter Form, von den Drop-Miniaturen.
// Grundsatz: Jeder Artefakt-Typ wird ECHT gerendert (HTML als Seite,
// Markdown als Dokument), nie als Rohtext-Ausschnitt.

import { useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Artifact, ImageState } from "../lib/types";

marked.setOptions({ gfm: true, breaks: true });

export type ImageAction = "favorite" | "delete" | "save";

/** Bindet STYLE.css in ein HTML-Artefakt ein — egal ob Fragment oder ganze Seite. */
export function buildHtmlDoc(content: string, css: string): string {
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${css.trim() ? `<style data-otto-style>${css}</style>` : ""}`;
  if (/<head[\s>]/i.test(content)) {
    return content.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  }
  if (/<html[\s>]/i.test(content)) {
    return content.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
  }
  if (/<body[\s>]/i.test(content)) {
    return content.replace(/<body([^>]*)>/i, `<head>${head}</head><body$1>`);
  }
  return `<!doctype html><html><head>${head}</head><body>${content}</body></html>`;
}

/** Links aus Artefakten öffnen immer im Standard-Browser. */
export function handleLinkClick(e: React.MouseEvent) {
  const anchor = (e.target as HTMLElement).closest("a");
  if (anchor && /^https?:/.test(anchor.href)) {
    e.preventDefault();
    openUrl(anchor.href).catch(() => {});
  }
}

export function MarkdownBody({ content }: { content: string }) {
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

export function SearchResults({ artifact }: { artifact: Artifact }) {
  return (
    <div className="search-list">
      <p className="search-query">
        Suche nach <b>„{artifact.content}“</b>
      </p>
      {(artifact.results ?? []).map((r, i) => {
        const host = r.host || safeHost(r.url);
        return (
          <div className="search-result" key={i}>
            <div className="src">
              <Favicon host={host} />
              <span>{host}</span>
              {r.age && <span className="age">{r.age}</span>}
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
        );
      })}
      {(artifact.results ?? []).length === 0 && (
        <p className="search-empty">Keine Treffer.</p>
      )}
    </div>
  );
}

export function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Kleines Favicon zum Suchtreffer — verschwindet still, wenn es fehlt. */
export function Favicon({ host }: { host: string }) {
  const [failed, setFailed] = useState(false);
  if (!host || failed) return null;
  return (
    <img
      className="favicon"
      src={`https://icons.duckduckgo.com/ip3/${host}.ico`}
      alt=""
      width={12}
      height={12}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function ImageGrid({
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
    <>
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
                {status === "generating" && <div className="img-life" />}
                {status === "error" && (
                  <div className="img-error">{st?.error ?? "Fehler"}</div>
                )}
              </div>
              <figcaption>
                <span className="img-name" title={st?.meta?.prompt}>
                  {status === "generating" ? "wird erzeugt…" : (st?.meta?.name ?? id)}
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
    </>
  );
}

/** Vollansicht eines Artefakts (Quick-Look-Inhalt). */
export function ArtifactBody({
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
    case "image": {
      const ids = artifact.imageIds ?? [];
      // Ein einzelnes Bild füllt das Fenster randlos — das Fenster hat
      // bereits die Aspect Ratio des Bildes.
      if (ids.length === 1) {
        const st = images[ids[0]];
        return (
          <div className={`ql-image ${st?.status ?? "generating"}`}>
            {st?.url ? (
              <img src={st.url} alt={st.meta?.name ?? artifact.title} />
            ) : (
              <div className="img-placeholder" />
            )}
            {st?.status === "generating" && <div className="img-life" />}
            {st?.status === "error" && (
              <div className="img-error">{st?.error ?? "Fehler"}</div>
            )}
          </div>
        );
      }
      return (
        <div className="ql-scroll">
          <ImageGrid ids={ids} images={images} onAction={onImageAction} />
        </div>
      );
    }
    case "markdown":
      return (
        <div className="ql-scroll doc">
          <MarkdownBody content={artifact.content} />
        </div>
      );
    case "code":
      return (
        <div className="ql-scroll">
          <pre className="code-body">{artifact.content}</pre>
        </div>
      );
    case "html":
      return (
        <div className="ql-html">
          <iframe
            title={artifact.title}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={buildHtmlDoc(artifact.content, artifactStyle)}
          />
        </div>
      );
    case "search":
      return (
        <div className="ql-scroll">
          <SearchResults artifact={artifact} />
        </div>
      );
  }
}
