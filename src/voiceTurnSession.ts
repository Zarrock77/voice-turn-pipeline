import { SpeechTurn } from "./speechTurn.js";
import type { StreamingSTT, TTSRoute } from "./types.js";

export type { StreamingSTT, TTSRoute };

export interface AudioConfigMessage {
  sample_rate?: number;
  device?: string;
  bluetooth_hfp?: boolean;
}

export interface VoiceTurnSessionMessages {
  queuedAudioOverflow: string;
  transcriptionTimeout: string;
  sttDisconnected: string;
  microphoneFormatChanged: string;
  noSpeechRecognized: string;
  tooManyQueuedUtterances: string;
  voiceTurnInterrupted: string;
  ttsInterrupted: string;
  /** Prefix for a mid-utterance STT error: `${prefix}: ${err.message}`. */
  sttInputErrorPrefix: string;
  /** Prefix for an STT open/reconfigure failure: `${prefix}: ${err.message}`. */
  sttSetupErrorPrefix: string;
}

const DEFAULT_MESSAGES: VoiceTurnSessionMessages = {
  queuedAudioOverflow: "Too much queued speech. Please try again in a moment.",
  transcriptionTimeout: "Transcription could not finish. Please try your sentence again.",
  sttDisconnected: "Speech recognition is disconnected. Please try again.",
  microphoneFormatChanged: "The microphone format changed. Please try again.",
  noSpeechRecognized: "No speech was recognized. Please try your sentence again.",
  tooManyQueuedUtterances: "Too many pending voice requests. Please wait for the reply.",
  voiceTurnInterrupted: "The voice turn was interrupted.",
  ttsInterrupted: "TTS generation was interrupted. Please try again.",
  sttInputErrorPrefix: "speech-to-text",
  sttSetupErrorPrefix: "stt",
};

export const DEFAULT_KEEPALIVE_INTERVAL_MS = 8000;
export const DEFAULT_INPUT_FINALIZATION_TIMEOUT_MS = 5000;
const DEFAULT_MAX_QUEUED_AUDIO_SECONDS = 15;
const MAX_PENDING_UTTERANCES = 4;

export interface VoiceTurnSessionConfig {
  /**
   * Sends one JSON-serializable event to the client: `user_transcript_partial`,
   * `user_transcript`, `text`, `audio_start`, `audio`, `audio_end`, or `error`.
   * Must be a no-op (not throw) if the transport is no longer open.
   */
  send: (event: Record<string, unknown>) => void;
  /** Closes the underlying transport. Called when the input turn fails unrecoverably. */
  close: (code?: number, reason?: string) => void;
  stt: StreamingSTT;
  ttsRoute: TTSRoute;
  /**
   * Called once per finalized user utterance. Must resolve with the full reply
   * text. Call `onDelta` for each chunk of the reply as it becomes available so it
   * can be streamed into TTS incrementally instead of waiting for the full reply.
   */
  onUtterance: (userText: string, onDelta: (delta: string) => void) => Promise<string>;
  /**
   * Fired once a turn's TTS audio is fully sent, awaited in parallel with TTS
   * teardown so host-side work (e.g. persisting the turn) never delays audio
   * delivery. Errors are logged, not thrown.
   */
  onTurnComplete?: (userText: string, replyText: string) => void | Promise<void>;
  /** Prefix used in console logs (e.g. a connection or user id). Default: "voice-turn-session". */
  label?: string;
  keepAliveIntervalMs?: number;
  finalizationTimeoutMs?: number;
  /** How many seconds of PCM16 mono audio may queue while a commit is being finalized. Default: 15. */
  maxQueuedAudioSeconds?: number;
  messages?: Partial<VoiceTurnSessionMessages>;
}

/**
 * Owns one client's voice turn: push-to-talk audio in, streaming STT, a single
 * injected reply callback, and streaming TTS out. Vendor- and transport-agnostic —
 * the host supplies STT/TTS provider instances and a `send`/`close` pair instead of
 * a socket, and supplies the actual reply generation (LLM call, history, business
 * logic) via `onUtterance`.
 */
export class VoiceTurnSession {
  private readonly send: (event: Record<string, unknown>) => void;
  private readonly closeTransport: (code?: number, reason?: string) => void;
  private readonly stt: StreamingSTT;
  private readonly ttsRoute: TTSRoute;
  private readonly onUtterance: (userText: string, onDelta: (delta: string) => void) => Promise<string>;
  private readonly onTurnComplete?: (userText: string, replyText: string) => void | Promise<void>;
  private readonly label: string;
  private readonly keepAliveIntervalMs: number;
  private readonly finalizationTimeoutMs: number;
  private readonly maxQueuedAudioSeconds: number;
  private readonly messages: VoiceTurnSessionMessages;

  private utteranceInFlight = false;
  private pendingUtterances: string[] = [];
  private activeSpeech: SpeechTurn | null = null;
  private pendingTranscript = "";
  private commitRequested = false;
  private inputTurnId = 0;
  private inputOpen = false;
  private inputStartSeconds = 0;
  private finalizationTimer: NodeJS.Timeout | null = null;
  private readonly queuedInput: Array<Buffer | null> = [];
  private queuedInputBytes = 0;
  private disposed = false;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private _audioChunks = 0;
  private _audioBytes = 0;
  private _awaitingFirstConfig = true;
  private _preConfigBuffer: Buffer[] | null = null;
  private _sttOpened = false;

  constructor(config: VoiceTurnSessionConfig) {
    this.send = config.send;
    this.closeTransport = config.close;
    this.stt = config.stt;
    this.ttsRoute = config.ttsRoute;
    this.onUtterance = config.onUtterance;
    this.onTurnComplete = config.onTurnComplete;
    this.label = config.label ?? "voice-turn-session";
    this.keepAliveIntervalMs = config.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.finalizationTimeoutMs = config.finalizationTimeoutMs ?? DEFAULT_INPUT_FINALIZATION_TIMEOUT_MS;
    this.maxQueuedAudioSeconds = config.maxQueuedAudioSeconds ?? DEFAULT_MAX_QUEUED_AUDIO_SECONDS;
    this.messages = { ...DEFAULT_MESSAGES, ...(config.messages ?? {}) };
  }

  async start(): Promise<void> {
    this.stt.onInterim = (text) => {
      if (!this.inputOpen || this.disposed) return;
      this._send({ type: "user_transcript_partial", data: text });
    };

    this.stt.onFinal = (text, speechFinal, info) => {
      if (!this.inputOpen || this.disposed) return;
      if (info.end !== null && info.end <= this.inputStartSeconds + 0.0001) return;
      const clean = text.trim();
      if (clean) {
        this._send({ type: "user_transcript", data: text });
        this.pendingTranscript = this.pendingTranscript
          ? `${this.pendingTranscript} ${clean}`
          : clean;
      }
      console.log(`[${this.label}] stt final: "${text}" speech_final=${speechFinal} commit=${this.commitRequested}`);
      // PTT ends at COMMIT, not at a pause midway through a sentence.
      // A final segment alone may precede the remaining words of this turn.
      if (this.commitRequested && ((info.fromFinalize && info.end !== null) || this._inputAudioProcessed())) {
        this._flushUtterance();
      }
    };

    this.stt.onUtteranceEnd = () => {
      if (this.commitRequested && this._inputAudioProcessed()) {
        this._flushUtterance();
      }
    };

    this.stt.onError = (err) => {
      this._failInput(`${this.messages.sttInputErrorPrefix}: ${err?.message ?? err}`);
    };

    this._sttOpened = false;

    if (this.ttsRoute.persistent) {
      await this.ttsRoute.instance.start();
      if (this.disposed) { this.ttsRoute.instance.close(); return; }
      console.log(`[${this.label}] tts (persistent) ready`);
    }

    this.keepAliveTimer = setInterval(() => {
      if (!this.disposed) this.stt.keepAlive();
    }, this.keepAliveIntervalMs);
    console.log(`[${this.label}] started; STT waiting for audio_config`);
  }

  onClientAudio(pcm16Buffer: Buffer): void {
    if (this.disposed || !pcm16Buffer.length) return;
    if (this.commitRequested) {
      // Do not mix a new recording with STT results still closing the previous one.
      this.queuedInputBytes += pcm16Buffer.length;
      if (this.queuedInputBytes > this.maxQueuedAudioSeconds * this.stt.sampleRate * 2) {
        this._failInput(this.messages.queuedAudioOverflow);
        return;
      }
      this.queuedInput.push(pcm16Buffer);
      return;
    }
    if (!this.inputOpen) {
      this.inputOpen = true;
      this.inputTurnId++;
      this.inputStartSeconds = this.stt.audioSecondsSent;
    }
    this._audioChunks++;
    this._audioBytes += pcm16Buffer.length;
    if (this._audioChunks === 1 || this._audioChunks % 100 === 0) {
      console.log(`[${this.label}] audio chunk #${this._audioChunks}, ${pcm16Buffer.length}B (cum ${this._audioBytes}B)`);
    }
    if (this._awaitingFirstConfig) {
      if (!this._preConfigBuffer) this._preConfigBuffer = [];
      this._preConfigBuffer.push(pcm16Buffer);
      if (this._preConfigBuffer.length > 200) this._preConfigBuffer.shift();
      return;
    }
    this.stt.sendAudio(pcm16Buffer);
  }

  onClientCommit(): void {
    if (this.disposed) return;
    if (this.commitRequested) {
      if (this.queuedInput.length && this.queuedInput[this.queuedInput.length - 1] !== null) {
        this.queuedInput.push(null);
      }
      return;
    }
    if (!this.inputOpen) return;
    console.log(`[${this.label}] commit received (chunks so far: ${this._audioChunks})`);
    this.commitRequested = true;
    const turnId = this.inputTurnId;
    this.finalizationTimer = setTimeout(() => {
      if (this.commitRequested && this.inputTurnId === turnId) {
        this._failInput(this.messages.transcriptionTimeout);
      }
    }, this.finalizationTimeoutMs);
    this._finalizeInput();
  }

  private _inputAudioProcessed(): boolean {
    return this._sttOpened && this.stt.audioSecondsSent > 0
      && this.stt.finalAudioSeconds + 0.0001 >= this.stt.audioSecondsSent;
  }

  private _finalizeInput(): void {
    if (this.disposed || !this.commitRequested || !this._sttOpened) return;
    if (this._inputAudioProcessed()) this._flushUtterance();
    else if (!this.stt.finalize()) this._failInput(this.messages.sttDisconnected);
  }

  private _failInput(message: string): void {
    if (this.disposed) return;
    console.error(`[${this.label}] input turn ${this.inputTurnId} failed: ${message}`);
    this._send({ type: "error", message });
    // Reconnect starts a fresh STT timeline; old results cannot enter the next turn.
    this.shutdown();
    this.closeTransport(1011, "speech input failed");
  }

  async onClientAudioConfig(msg: AudioConfigMessage): Promise<void> {
    if (this.disposed) return;
    const rate = Number(msg?.sample_rate);
    if (!Number.isFinite(rate) || rate <= 0) return;
    const device = msg?.device || "(unknown)";
    const hfp = msg?.bluetooth_hfp ? " [Bluetooth HFP]" : "";
    console.log(`[${this.label}] audio_config: ${rate} Hz from "${device}"${hfp}`);

    try {
      if (!this._sttOpened) {
        this.stt.sampleRate = rate;
        await this.stt.start();
        this._sttOpened = true;
        console.log(`[${this.label}] STT opened at ${rate} Hz`);
      } else if (rate !== this.stt.sampleRate) {
        if (this.inputOpen) { this._failInput(this.messages.microphoneFormatChanged); return; }
        console.log(`[${this.label}] reconfiguring STT: ${this.stt.sampleRate} Hz -> ${rate} Hz`);
        await this.stt.reconfigure({ sampleRate: rate });
        console.log(`[${this.label}] STT reconfigured at ${rate} Hz`);
      }
    } catch (err) {
      console.error(`[${this.label}] STT open/reconfigure failed:`, err);
      this._send({ type: "error", message: `${this.messages.sttSetupErrorPrefix}: ${(err as Error)?.message ?? err}` });
      return;
    }

    if (this.disposed) { this.stt.close(); return; }

    this._awaitingFirstConfig = false;
    if (this._preConfigBuffer && this._preConfigBuffer.length) {
      console.log(`[${this.label}] flushing ${this._preConfigBuffer.length} pre-config audio chunks`);
      for (const buf of this._preConfigBuffer) this.stt.sendAudio(buf);
      this._preConfigBuffer = null;
    }
    this._finalizeInput();
  }

  private _flushUtterance(): void {
    if (!this.commitRequested || !this.inputOpen || this.disposed) return;
    const text = this.pendingTranscript;
    if (this.finalizationTimer) clearTimeout(this.finalizationTimer);
    this.finalizationTimer = null;
    this.pendingTranscript = "";
    this.commitRequested = false;
    this.inputOpen = false;
    this._audioChunks = 0;
    this._audioBytes = 0;
    console.log(`[${this.label}] input turn ${this.inputTurnId} finalized (${text.length} characters)`);
    if (text) void this._handleUtterance(text);
    else this._send({ type: "error", message: this.messages.noSpeechRecognized });
    while (this.queuedInput.length && !this.commitRequested && !this.disposed) {
      const next = this.queuedInput.shift()!;
      if (next === null) this.onClientCommit();
      else {
        this.queuedInputBytes -= next.length;
        this.onClientAudio(next);
      }
    }
  }

  private async _handleUtterance(userText: string): Promise<void> {
    if (this.disposed) return;
    if (this.utteranceInFlight) {
      if (this.pendingUtterances.length < MAX_PENDING_UTTERANCES) this.pendingUtterances.push(userText);
      else this._send({ type: "error", message: this.messages.tooManyQueuedUtterances });
      return;
    }
    this.utteranceInFlight = true;
    const t0 = Date.now();
    const mark = (step: string): void => console.log(`[${this.label}] +${Date.now() - t0}ms ${step}`);
    let speech: SpeechTurn | null = null;
    try {
      const tts = this.ttsRoute.persistent ? this.ttsRoute.instance : this.ttsRoute.create();
      const turn = new SpeechTurn(tts, (event) => this._send(event), !this.ttsRoute.persistent,
        () => mark("first audio chunk"), this.messages.ttsInterrupted);
      speech = this.activeSpeech = turn;
      mark("reply call");
      let firstDeltaAt: number | null = null;

      const full = await this.onUtterance(userText, (delta) => {
        if (!firstDeltaAt) {
          firstDeltaAt = Date.now();
          mark("first reply delta");
        }
        turn.write(delta);
      });
      if (this.disposed) return;
      mark("reply complete");
      this._send({ type: "text", data: full });
      // Finish TTS immediately; host-side work (e.g. persistence) must not delay the last audio.
      await Promise.all([
        turn.finishText(),
        this.onTurnComplete
          ? Promise.resolve(this.onTurnComplete(userText, full))
              .catch((err) => console.error(`[${this.label}] onTurnComplete failed:`, (err as Error)?.message ?? err))
          : Promise.resolve(),
      ]);
    } catch (err) {
      speech?.cancel();
      this._send({ type: "error", message: this.messages.voiceTurnInterrupted });
      console.error(`[${this.label}] voice turn failed`, (err as Error)?.message);
    } finally {
      // Also wait for connection cleanup on failure before reusing a persistent provider.
      await speech?.finishText();
      if (this.activeSpeech === speech) this.activeSpeech = null;
      this.utteranceInFlight = false;
      const next = this.pendingUtterances.shift();
      if (next && !this.disposed) void this._handleUtterance(next);
    }
  }

  private _send(obj: Record<string, unknown>): void {
    if (this.disposed) return;
    this.send(obj);
  }

  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.finalizationTimer) clearTimeout(this.finalizationTimer);
    this.finalizationTimer = null;
    this.queuedInput.length = 0;
    this.queuedInputBytes = 0;
    this._preConfigBuffer = null;
    this.pendingTranscript = "";
    this.commitRequested = false;
    this.inputOpen = false;
    this.pendingUtterances = [];
    this.activeSpeech?.cancel();
    this.activeSpeech = null;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.stt.close();
    if (this.ttsRoute.persistent) {
      this.ttsRoute.instance.close();
    }
    console.log(`[${this.label}] shutdown`);
  }
}
