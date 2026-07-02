// Spielt PCM-Chunks aus einer Queue ab. Meldet Pegel (für den Orb)
// und "drained", wenn die Queue leer gespielt ist.
class PcmPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.playing = false;
    this.tick = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "chunk") {
        this.queue.push(m.data);
        this.playing = true;
      } else if (m.type === "clear") {
        this.queue = [];
        this.offset = 0;
        if (this.playing) {
          this.playing = false;
          this.port.postMessage({ type: "drained" });
        }
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    let filled = 0;
    let sum = 0;
    while (filled < out.length && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(out.length - filled, head.length - this.offset);
      for (let j = 0; j < take; j++) {
        const v = head[this.offset + j];
        out[filled + j] = v;
        sum += v * v;
      }
      filled += take;
      this.offset += take;
      if (this.offset >= head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    for (let j = filled; j < out.length; j++) out[j] = 0;

    if (this.playing && filled === 0 && this.queue.length === 0) {
      this.playing = false;
      this.port.postMessage({ type: "drained" });
    }
    if (++this.tick % 6 === 0) {
      this.port.postMessage({
        type: "level",
        value: filled ? Math.sqrt(sum / filled) : 0,
      });
    }
    return true;
  }
}

registerProcessor("pcm-playback", PcmPlayback);
