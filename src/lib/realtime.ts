export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
  callId: string;
}

export interface RealtimeCallbacks {
  onOpen: () => void;
  onClose: () => void;
  /** Nutzer-relevante Fehler (Verbindung kaputt) — landen in der UI. */
  onError: (message: string) => void;
  /**
   * Technische Server-Fehler (z. B. „active response in progress“) —
   * gehören ins interne Log, nie in die UI.
   */
  onLog?: (message: string) => void;
  onAudio: (b64: string) => void;
  onSpeechStart: () => void;
  onSpeechStop: () => void;
  onResponseStart: () => void;
  onResponseDone: () => void;
  onUserTranscript: (text: string) => void;
  onAssistantDelta: (itemId: string, delta: string) => void;
  onAssistantDone: (itemId: string, text: string) => void;
  onFunctionCall: (call: FunctionCall) => void;
}

export interface McpServer {
  label: string;
  url: string;
}

interface SessionParams {
  model: string;
  voice: string;
  instructions: string;
  tools: object[];
  reasoningEffort?: string;
  /** VAD-Schwelle 0.3–0.99 — höher = unempfindlicher gegen Nebengeräusche. */
  vadThreshold?: number;
  /** Remote-MCP-Server — die Realtime API ruft deren Tools selbst auf. */
  mcpServers?: McpServer[];
}

/**
 * WebSocket-Client für die GA-Realtime-API (/v1/realtime).
 * Wichtig: kein "openai-beta.realtime-v1"-Subprotokoll mehr — die Beta-API
 * ist abgeschaltet und der Server lehnt Verbindungen damit ab.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private params: SessionParams | null = null;
  private closedByUs = false;

  constructor(private cb: RealtimeCallbacks) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(apiKey: string, params: SessionParams): void {
    this.params = params;
    this.closedByUs = false;

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(params.model)}`;
    // Browser-WebSockets können keine Header setzen — der Key wandert ins Subprotokoll.
    const ws = new WebSocket(url, [
      "realtime",
      `openai-insecure-api-key.${apiKey}`,
    ]);
    this.ws = ws;

    ws.onopen = () => {
      this.sendSessionUpdate();
      this.cb.onOpen();
    };
    ws.onmessage = (e) => {
      try {
        this.handle(JSON.parse(e.data as string));
      } catch {
        // Nicht-JSON-Frames ignorieren.
      }
    };
    ws.onerror = () => {
      if (!this.closedByUs) {
        this.cb.onError(
          "WebSocket-Fehler. Prüfe API-Key, Modellname und Internetverbindung.",
        );
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.cb.onClose();
    };
  }

  private send(payload: object): void {
    if (this.connected) this.ws!.send(JSON.stringify(payload));
  }

  private sendSessionUpdate(): void {
    const p = this.params!;
    const session: Record<string, unknown> = {
      type: "realtime",
      model: p.model,
      output_modalities: ["audio"],
      instructions: p.instructions,
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: "gpt-4o-transcribe", language: "de" },
          // Far-Field-Rauschunterdrückung filtert Fernseher, Ventilatoren
          // & Co. heraus, BEVOR die Sprach-Erkennung (VAD) sie sieht.
          noise_reduction: { type: "far_field" },
          // Hohe Schwelle + längere Stille: verhindert, dass leise
          // Hintergrundgeräusche oder Lautsprecher-Restecho als Nutzer-
          // Sprache gelten und Otto mitten im Satz abbrechen. Echtes
          // Reinreden funktioniert weiterhin. Schwelle in den
          // Einstellungen justierbar.
          turn_detection: {
            type: "server_vad",
            threshold: p.vadThreshold ?? 0.85,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: 24000 },
          voice: p.voice,
        },
      },
      tools: [
        ...p.tools,
        // MCP-Server: kein Executor-Code nötig — die API listet die Tools
        // selbst und führt die Aufrufe serverseitig aus.
        ...(p.mcpServers ?? []).map((s) => ({
          type: "mcp",
          server_label: s.label,
          server_url: s.url,
          require_approval: "never",
        })),
      ],
      tool_choice: "auto",
    };
    // Nur die Realtime-2-Modelle können Reasoning-Aufwand konfigurieren.
    if (/realtime-2/.test(p.model) && p.reasoningEffort) {
      session.reasoning = { effort: p.reasoningEffort };
    }
    this.send({ type: "session.update", session });
  }

  sendAudio(b64: string): void {
    this.send({ type: "input_audio_buffer.append", audio: b64 });
  }

  /** Legt das Ergebnis eines Function-Calls in die Konversation (ohne Antwort auszulösen). */
  sendFunctionOutput(callId: string, output: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
  }

  /**
   * Legt ein Bild in die Konversation (GA-Feature der Realtime API) —
   * z. B. einen Screenshot aus der Zwischenablage. Optional mit Text
   * im selben Item, damit das Modell weiß, worauf es schauen soll.
   */
  sendImage(dataUrl: string, text?: string): void {
    const content: Record<string, unknown>[] = [
      { type: "input_image", image_url: dataUrl, detail: "high" },
    ];
    if (text) content.push({ type: "input_text", text });
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content },
    });
  }

  /** Reicht nachträgliche Informationen (z. B. Suchergebnisse) als System-Nachricht nach. */
  sendSystemMessage(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text }],
      },
    });
  }

  /** Fordert eine neue Modell-Antwort an. Nie aufrufen, solange eine Antwort läuft. */
  createResponse(): void {
    this.send({ type: "response.create" });
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }

  private handle(msg: any): void {
    switch (msg.type) {
      case "error": {
        // Server-Fehler-Events sind fast immer transient (Race-Conditions
        // wie doppelte response.create) — still protokollieren.
        this.cb.onLog?.(msg.error?.message ?? "Unbekannter Server-Fehler");
        break;
      }
      case "input_audio_buffer.speech_started":
        this.cb.onSpeechStart();
        break;
      case "input_audio_buffer.speech_stopped":
        this.cb.onSpeechStop();
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (msg.transcript) this.cb.onUserTranscript(msg.transcript.trim());
        break;
      case "response.created":
        this.cb.onResponseStart();
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        this.cb.onAudio(msg.delta);
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        this.cb.onAssistantDelta(msg.item_id, msg.delta);
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        this.cb.onAssistantDone(msg.item_id, msg.transcript ?? "");
        break;
      case "response.output_item.done": {
        const item = msg.item;
        if (item?.type === "function_call") {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(item.arguments);
          } catch {
            // Defekte Argumente: leeres Objekt weiterreichen.
          }
          this.cb.onFunctionCall({ name: item.name, args, callId: item.call_id });
        }
        break;
      }
      case "response.done": {
        const status = msg.response?.status;
        if (status === "failed") {
          this.cb.onLog?.(
            `response failed: ${
              msg.response?.status_details?.error?.message ?? "unbekannt"
            }`,
          );
        }
        this.cb.onResponseDone();
        break;
      }
      default:
        break;
    }
  }
}
