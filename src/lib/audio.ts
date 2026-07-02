import { b64FromFloat32, float32FromB64, rms } from "./pcm";

/**
 * Mikrofon-Capture und PCM-Playback über AudioWorklets,
 * beides mit 24 kHz mono — das native Format der Realtime API.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private playNode: AudioWorkletNode | null = null;
  private audioEl: HTMLAudioElement | null = null;

  onPcmChunk?: (b64: string) => void;
  onInputLevel?: (v: number) => void;
  onOutputLevel?: (v: number) => void;
  onDrained?: () => void;

  get running(): boolean {
    return this.ctx !== null;
  }

  async start(): Promise<void> {
    if (this.ctx) return;
    const ctx = new AudioContext({ sampleRate: 24000 });
    this.ctx = ctx;
    await ctx.resume();
    await ctx.audioWorklet.addModule("/worklets/capture.js");
    await ctx.audioWorklet.addModule("/worklets/playback.js");

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const source = ctx.createMediaStreamSource(this.micStream);
    this.captureNode = new AudioWorkletNode(ctx, "pcm-capture");
    this.captureNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const chunk = e.data;
      this.onInputLevel?.(rms(chunk));
      this.onPcmChunk?.(b64FromFloat32(chunk));
    };
    // Stummer Sink, damit der Capture-Worklet Teil des aktiven Graphen ist.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(this.captureNode);
    this.captureNode.connect(sink).connect(ctx.destination);

    this.playNode = new AudioWorkletNode(ctx, "pcm-playback");
    this.playNode.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "level") this.onOutputLevel?.(m.value);
      else if (m.type === "drained") this.onDrained?.();
    };
    // Wiedergabe über ein <audio>-Element statt direkt an ctx.destination:
    // Nur dieser Pfad fließt in WebKits Echo-Unterdrückung ein — sonst hört
    // das Mikrofon Ottos Stimme aus den Lautsprechern und unterbricht ihn.
    const sinkStream = ctx.createMediaStreamDestination();
    this.playNode.connect(sinkStream);
    this.audioEl = new Audio();
    this.audioEl.srcObject = sinkStream.stream;
    this.audioEl.autoplay = true;
    await this.audioEl.play().catch(() => {});
  }

  enqueue(b64: string): void {
    if (!this.playNode) return;
    const f32 = float32FromB64(b64);
    this.playNode.port.postMessage({ type: "chunk", data: f32 }, [f32.buffer]);
  }

  clearPlayback(): void {
    this.playNode?.port.postMessage({ type: "clear" });
  }

  async stop(): Promise<void> {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.captureNode?.disconnect();
    this.playNode?.disconnect();
    this.captureNode = null;
    this.playNode = null;
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
      this.audioEl = null;
    }
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      await ctx.close().catch(() => {});
    }
  }
}
