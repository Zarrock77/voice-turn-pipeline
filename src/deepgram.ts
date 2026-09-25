import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import type { ListenLiveClient, LiveSchema } from "@deepgram/sdk";
import type { FinalTranscriptInfo } from "./types.js";

export type { FinalTranscriptInfo };

export interface DeepgramStreamingSTTOptions {
  language?: string;
  sampleRate?: number;
  endpointingMs?: number;
  utteranceEndMs?: number;
}

export interface DeepgramReconfigureOptions {
  sampleRate?: number;
  language?: string;
}

interface DeepgramTranscriptEvent {
  channel?: { alternatives?: Array<{ transcript?: string }> };
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  start?: number;
  duration?: number;
}

export class DeepgramStreamingSTT {
  private readonly client: ReturnType<typeof createClient>;
  private language: string;
  sampleRate: number;
  private readonly endpointingMs: number;
  private readonly utteranceEndMs: number;
  private live: ListenLiveClient | null = null;
  private sentBytes = 0;
  private processedSeconds = 0;
  private readonly seenResults = new Set<string>();
  private readonly seenSegments = new Set<string>();

  get audioSecondsSent(): number { return this.sentBytes / (this.sampleRate * 2); }
  get finalAudioSeconds(): number { return this.processedSeconds; }

  onInterim: (text: string) => void = () => {};
  onFinal: (text: string, speechFinal: boolean, info: FinalTranscriptInfo) => void = () => {};
  onUtteranceEnd: () => void = () => {};
  onError: (err: Error) => void = () => {};

  constructor(
    apiKey: string | undefined | null,
    {
      language = "fr",
      sampleRate = 48000,
      endpointingMs = 300,
      utteranceEndMs = 1000,
    }: DeepgramStreamingSTTOptions = {},
  ) {
    if (!apiKey) throw new Error("DeepgramStreamingSTT: missing apiKey");
    this.client = createClient(apiKey);
    this.language = language;
    this.sampleRate = sampleRate;
    this.endpointingMs = endpointingMs;
    this.utteranceEndMs = Math.max(1000, utteranceEndMs);
  }

  async start(): Promise<void> {
    this.sentBytes = 0;
    this.processedSeconds = 0;
    this.seenResults.clear();
    this.seenSegments.clear();
    const liveOptions: LiveSchema = {
      model: "nova-3",
      language: this.language,
      encoding: "linear16",
      sample_rate: this.sampleRate,
      channels: 1,
      smart_format: true,
      interim_results: true,
      endpointing: this.endpointingMs,
      utterance_end_ms: this.utteranceEndMs,
      vad_events: true,
    };
    this.live = this.client.listen.live(liveOptions);
    const live = this.live;

    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("deepgram open timeout")), 8000);
      live.on(LiveTranscriptionEvents.Open, () => { clearTimeout(to); resolve(); });
      live.on(LiveTranscriptionEvents.Error, (err: Error) => { clearTimeout(to); reject(err); });
    });

    live.on(LiveTranscriptionEvents.Error, (err: Error) => {
      if (this.live !== live) return;
      console.error("[deepgram error]", err);
      this.onError(err);
    });

    for (const [evName, evValue] of Object.entries(LiveTranscriptionEvents)) {
      if (["Open", "Error", "Transcript", "UtteranceEnd"].includes(evName)) continue;
      live.on(evValue as LiveTranscriptionEvents, (...args: unknown[]) => {
        const preview = JSON.stringify(args[0] ?? {}).slice(0, 400);
        console.log(`[dg ${evName}]`, preview);
      });
    }

    live.on(LiveTranscriptionEvents.Transcript, (event: DeepgramTranscriptEvent) => {
      if (this.live !== live) return;
      const rawPreview = JSON.stringify(event).slice(0, 400);
      if (!event?.channel?.alternatives?.[0]?.transcript) {
        console.log("[dg Transcript empty]", rawPreview);
      }
      let text = event?.channel?.alternatives?.[0]?.transcript ?? "";
      if (event.is_final) {
        // Empty final results still carry completion of the audio stream.
        // Keep boundaries separate from words, and don't append replayed segments.
        if (Number.isFinite(event.start) && Number.isFinite(event.duration)) {
          const key = JSON.stringify([event.start, event.duration, text]);
          const resultKey = JSON.stringify([key, !!event.speech_final, !!event.from_finalize]);
          if (this.seenResults.has(resultKey)) return;
          this.seenResults.add(resultKey);
          if (this.seenSegments.has(key)) text = "";
          this.seenSegments.add(key);
          this.processedSeconds = Math.max(this.processedSeconds, event.start! + event.duration!);
          for (const set of [this.seenResults, this.seenSegments]) {
            if (set.size > 256) set.delete(set.values().next().value!);
          }
        }
        const end = Number.isFinite(event.start) && Number.isFinite(event.duration)
          ? event.start! + event.duration! : null;
        this.onFinal(text, !!event.speech_final, { fromFinalize: !!event.from_finalize, end });
      } else if (text) {
        this.onInterim(text);
      }
    });

    live.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      if (this.live !== live) return;
      this.onUtteranceEnd();
    });
  }

  sendAudio(pcm16Buffer: Buffer): void {
    if (!this.live) return;
    const maybeReady = (this.live as unknown as { getReadyState?: () => number }).getReadyState;
    if (typeof maybeReady === "function" && maybeReady.call(this.live) !== 1) return;
    // Deepgram's TS `send` signature wants ArrayBuffer/Blob; at runtime it
    // accepts Node Buffers (which are Uint8Arrays). Cast through unknown.
    (this.live as unknown as { send: (data: unknown) => void }).send(pcm16Buffer);
    this.sentBytes += pcm16Buffer.length;
  }

  finalize(): boolean {
    if (!this.live || this.live.getReadyState() !== 1) return false;
    try {
      this.live.send(JSON.stringify({ type: "Finalize" }));
      return true;
    } catch { return false; }
  }

  keepAlive(): void {
    if (!this.live) return;
    try {
      this.live.send(JSON.stringify({ type: "KeepAlive" }));
    } catch { /* ignore */ }
  }

  close(): void {
    if (!this.live) return;
    try {
      (this.live as unknown as { finish?: () => void; requestClose?: () => void }).finish?.();
    } catch { /* ignore */ }
    this.live = null;
  }

  async reconfigure({ sampleRate, language }: DeepgramReconfigureOptions = {}): Promise<void> {
    if (typeof sampleRate === "number" && sampleRate > 0) {
      this.sampleRate = sampleRate;
    }
    if (typeof language === "string" && language.length > 0) {
      this.language = language;
    }
    this.close();
    await this.start();
  }
}
