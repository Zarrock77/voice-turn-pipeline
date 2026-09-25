import { randomUUID } from "node:crypto";

export interface StreamingTTS {
  onAudio: (pcm: string) => void;
  onFinal: () => void;
  onError: (error: Error) => void;
  start?: () => Promise<void>;
  beginUtterance?: () => void;
  sendText: (text: string) => void;
  flush: () => unknown;
  close: () => void;
}

/** Owns one TTS context until its final audio, including failure and disconnect paths. */
export class SpeechTurn {
  readonly id = randomUUID();
  private ready = false;
  private started = false;
  private finished = false;
  private hasText = false;
  private flushed = false;
  private pending: string[] = [];
  private timeout: NodeJS.Timeout | null = null;
  private audioFrames = 0;
  private audioChunks = 0;
  private resolveDone!: () => void;
  private readonly done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
  private readonly opening: Promise<void>;

  constructor(
    private readonly tts: StreamingTTS,
    private readonly send: (event: Record<string, unknown>) => void,
    private readonly closeOnDone: boolean,
    private readonly onFirstAudio: () => void = () => {},
    private readonly errorMessage: string = "TTS generation was interrupted. Please try again.",
  ) {
    tts.onAudio = (data) => {
      if (this.finished) return;
      this.timeout?.refresh();
      if (this.audioChunks === 0) this.onFirstAudio();
      this.audioChunks++;
      this.audioFrames += Buffer.from(data, "base64").length / 2;
      this.send({ type: "audio", request_id: this.id, data });
    };
    tts.onFinal = () => this.settle("ok");
    tts.onError = () => this.fail();
    this.opening = Promise.resolve().then(() => {
      if (!this.finished) return tts.start?.();
    }).then(() => {
      if (this.finished) return;
      tts.beginUtterance?.();
      this.ready = true;
      this.started = true;
      this.send({ type: "audio_start", request_id: this.id, sample_rate: 24000, channels: 1, encoding: "pcm_s16le" });
      for (const text of this.pending) tts.sendText(text);
      this.pending = [];
    }).catch(() => this.fail());
  }

  write(text: string): void {
    if (this.finished || !text) return;
    this.hasText = true;
    if (!this.ready) { this.pending.push(text); return; }
    try { this.tts.sendText(text); } catch { this.fail(); }
  }

  async finishText(): Promise<void> {
    await this.opening;
    if (!this.finished && !this.flushed) {
      this.flushed = true;
      if (!this.hasText) {
        this.settle("ok");
        this.tts.close(); // An unused context must not survive into the next turn.
      } else {
        // A provider that never sends its final event must not lock the conversation forever.
        this.timeout = setTimeout(() => this.fail(), 30000);
        try { this.tts.flush(); } catch { this.fail(); }
      }
    }
    await this.done;
  }

  cancel(): void {
    if (this.finished) return;
    this.settle("cancelled");
    this.tts.close();
  }

  private fail(): void {
    if (this.finished) return;
    this.send({ type: "error", message: this.errorMessage });
    this.settle("error");
    this.tts.close();
  }

  private settle(status: "ok" | "error" | "cancelled"): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    this.pending = [];
    this.tts.onAudio = () => {};
    this.tts.onFinal = () => {};
    this.tts.onError = () => {};
    if (this.started) {
      this.send({ type: "audio_end", request_id: this.id, status, audio_frames: this.audioFrames, audio_chunks: this.audioChunks });
      console.log(`[tts ${this.id}] ${status}: ${this.audioChunks} chunks, ${this.audioFrames} frames (${(this.audioFrames / 24000).toFixed(2)}s)`);
    }
    if (this.closeOnDone) this.tts.close();
    this.resolveDone();
  }
}
