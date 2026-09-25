import type { StreamingTTS } from "./speechTurn.js";

export interface FinalTranscriptInfo {
  fromFinalize: boolean;
  end: number | null;
}

/** A streaming speech-to-text session. `DeepgramStreamingSTT` implements this; any
 * other provider that matches this shape (structurally, no explicit `implements`
 * needed) can be used in its place. */
export interface StreamingSTT {
  sampleRate: number;
  readonly audioSecondsSent: number;
  readonly finalAudioSeconds: number;
  onInterim: (text: string) => void;
  onFinal: (text: string, speechFinal: boolean, info: FinalTranscriptInfo) => void;
  onUtteranceEnd: () => void;
  onError: (err: Error) => void;
  start(): Promise<void>;
  sendAudio(pcm16Buffer: Buffer): void;
  finalize(): boolean;
  keepAlive(): void;
  close(): void;
  reconfigure(opts: { sampleRate?: number; language?: string }): Promise<void>;
}

/**
 * How a `VoiceTurnSession` obtains a TTS context for each utterance.
 * - `persistent`: one long-lived `StreamingTTS` connection reused across turns
 *   (e.g. Cartesia's websocket, which supports concurrent contexts). Started once
 *   up front and closed on session shutdown.
 * - non-persistent: a fresh `StreamingTTS` instance created per turn and closed
 *   when that turn's audio is done (e.g. ElevenLabs' per-utterance websocket).
 */
export type TTSRoute =
  | { persistent: true; instance: StreamingTTS & { start(): Promise<void>; beginUtterance(): void } }
  | { persistent: false; create: () => StreamingTTS };
