import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { hideDrops, showDrops } from "../lib/hudWindow";
import * as api from "../lib/tauriApi";
import type { Artifact, ImageState, Settings } from "../lib/types";
import type { ImageAction } from "../components/ArtifactContent";

interface UsePanelSyncArgs {
  panelOpen: boolean;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  pendingPresent: MutableRefObject<{ mode: "gross" | "klein"; id?: string } | null>;
  artifacts: Artifact[];
  activeArtifactId: string | null;
  images: Record<string, ImageState>;
  artifactStyle: string;
  artifactsRef: MutableRefObject<Artifact[]>;
  activeArtifactIdRef: MutableRefObject<string | null>;
  imagesRef: MutableRefObject<Record<string, ImageState>>;
  artifactStyleRef: MutableRefObject<string>;
  setActiveArtifactId: Dispatch<SetStateAction<string | null>>;
  setSettings: Dispatch<SetStateAction<Settings | null>>;
  closeArtifact: (id: string) => boolean;
  handleImageAction: (id: string, action: ImageAction) => Promise<void>;
  reloadArtifactStyle: () => void;
}

export function usePanelSync({
  panelOpen,
  setPanelOpen,
  pendingPresent,
  artifacts,
  activeArtifactId,
  images,
  artifactStyle,
  artifactsRef,
  activeArtifactIdRef,
  imagesRef,
  artifactStyleRef,
  setActiveArtifactId,
  setSettings,
  closeArtifact,
  handleImageAction,
  reloadArtifactStyle,
}: UsePanelSyncArgs) {
  const panelWasOpen = useRef(false);

  useEffect(() => {
    if (panelOpen) {
      void showDrops();
      void emit("panel-open", { fresh: !panelWasOpen.current });
      if (pendingPresent.current) {
        void emit("panel-present", pendingPresent.current);
        pendingPresent.current = null;
      }
    } else {
      void hideDrops();
    }
    panelWasOpen.current = panelOpen;
  }, [panelOpen, pendingPresent]);

  useEffect(() => {
    void emit("panel-state", {
      artifacts,
      activeId: activeArtifactId,
      images,
      artifactStyle,
    });
  }, [artifacts, activeArtifactId, images, artifactStyle]);

  useEffect(() => {
    const unReady = listen("panel-ready", () => {
      void emit("panel-state", {
        artifacts: artifactsRef.current,
        activeId: activeArtifactIdRef.current,
        images: imagesRef.current,
        artifactStyle: artifactStyleRef.current,
      });
    });
    const unClose = listen("panel-close", () => setPanelOpen(false));
    const unAction = listen<{
      type: "select" | "close" | "image";
      id?: string;
      action?: "favorite" | "delete" | "save";
    }>("panel-action", (e) => {
      const p = e.payload;
      if (p.type === "select" && p.id) {
        setActiveArtifactId(p.id);
      } else if (p.type === "close" && p.id) {
        closeArtifact(p.id);
      } else if (p.type === "image" && p.id && p.action) {
        void handleImageAction(p.id, p.action);
      }
    });
    const unStyle = listen("style-changed", () => reloadArtifactStyle());
    const unSettings = listen("settings-changed", () => {
      api
        .getSettings()
        .then(setSettings)
        .catch((e) => void api.logLine(`settings refresh failed: ${String(e)}`));
    });
    return () => {
      unReady.then((f) => f());
      unClose.then((f) => f());
      unAction.then((f) => f());
      unStyle.then((f) => f());
      unSettings.then((f) => f());
    };
  }, [
    artifactsRef,
    activeArtifactIdRef,
    imagesRef,
    artifactStyleRef,
    setPanelOpen,
    setActiveArtifactId,
    setSettings,
    closeArtifact,
    handleImageAction,
    reloadArtifactStyle,
  ]);

  return useCallback(() => {
    setPanelOpen((open) => !open);
  }, [setPanelOpen]);
}
