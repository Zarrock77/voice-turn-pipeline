import WebSocket from "ws";

export interface ElevenLabsStreamingTTSOptions {
  voiceId: string;
  modelId?: string;
  outputFormat?: string;
  languageCode?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  useSpeakerBoost?: boolean;
  autoMode?: boolean;
}

interface ElevenLabsVoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
}

interface ElevenLabsMessage {
  audio?: string;
  isFinal?: boolean;
  error?: string;
}

export class ElevenLabsStreamingTTS {
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly outputFormat: string;
  private readonly languageCode: string | undefined;
  private readonly autoMode: boolean;
  private readonly voiceSettings: ElevenLabsVoiceSettings;
  private ws: WebSocket | null = null;
  private finished = false;

  onAudio: (base64Pcm: string) => void = () => {};
  onFinal: () => void = () => {};
  onError: (err: Error) => void = () => {};

  constructor(
    apiKey: string | undefined | null,
    {
      voiceId,
      modelId = "eleven_flash_v2_5",
      outputFormat = "pcm_24000",
      languageCode,
      stability = 0.45,
      similarityBoost = 0.75,
      style = 0.0,
      speed = 1.0,
      useSpeakerBoost = true,
      autoMode = true,
    }: ElevenLabsStreamingTTSOptions,
  ) {
    if (!apiKey) throw new Error("ElevenLabsStreamingTTS: missing apiKey");
    if (!voiceId) throw new Error("ElevenLabsStreamingTTS: missing voiceId");
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.modelId = modelId;
    this.outputFormat = outputFormat;
    this.languageCode = languageCode;
    this.autoMode = autoMode;
    this.voiceSettings = {
      stability,
      similarity_boost: similarityBoost,
      style,
      use_speaker_boost: useSpeakerBoost,
      speed,
    };
  }

  async start(): Promise<void> {
    this.finished = false;
    const qs = new URLSearchParams({
      model_id: this.modelId,
      output_format: this.outputFormat,
      auto_mode: String(this.autoMode),
    });
    if (this.languageCode) qs.set("language_code", this.languageCode);

    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input?${qs}`;
    this.ws = new WebSocket(url, { headers: { "xi-api-key": this.apiKey } });
    const ws = this.ws;

    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => {
        reject(new Error("elevenlabs open timeout"));
        ws.terminate();
      }, 8000);
      ws.once("open", () => {
        clearTimeout(to);
        ws.send(JSON.stringify({
          text: " ",
          voice_settings: this.voiceSettings,
          generation_config: { chunk_length_schedule: [120, 160, 250, 290] },
        }));
        resolve();
      });
      ws.once("error", (err) => { clearTimeout(to); reject(err); });
      ws.once("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (d: Buffer) => (body += d.toString()));
        res.on("end", () => {
          clearTimeout(to);
          reject(new Error(`HTTP ${res.statusCode} — ${body.slice(0, 200)}`));
        });
      });
    });

    ws.on("error", (err) => {
      if (this.ws !== ws) return;
      console.error("[elevenlabs error]", err);
      this.onError(err);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      if (this.ws !== ws) return;
      let msg: ElevenLabsMessage;
      try {
        msg = JSON.parse(data.toString()) as ElevenLabsMessage;
      } catch {
        return;
      }
      if (msg.audio) this.onAudio(msg.audio);
      if (msg.isFinal) {
        this.finished = true;
        this.onFinal();
        try { this.ws?.close(); } catch { /* ignore */ }
      }
      if (msg.error) {
        console.error("[elevenlabs reply error]", msg);
        this.onError(new Error(msg.error));
      }
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.finished) this.onError(new Error("ElevenLabs closed before final audio"));
    });
  }

  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("ElevenLabs is not connected");
    if (!text) return;
    const framed = text.endsWith(" ") ? text : text + " ";
    this.ws.send(JSON.stringify({ text: framed }));
  }

  flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("ElevenLabs is not connected");
    this.ws.send(JSON.stringify({ text: "" }));
  }

  close(): void {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    try { ws.close(); } catch { /* ignore */ }
  }
}
