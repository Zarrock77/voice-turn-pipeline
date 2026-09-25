# voice-turn-pipeline

Streaming voice-turn orchestration for real-time WebSocket agents: speech-to-text in,
your own reply generation in the middle, streaming text-to-speech out. Vendor- and
transport-agnostic — you own the socket, the LLM call, and any persistence; this
package owns the push-to-talk state machine and the TTS turn lifecycle.

## What's in here

- `VoiceTurnSession` — the orchestrator. Feed it raw PCM16 audio, a commit signal, and
  an `audio_config` message; it drives STT, serializes utterances, and streams your
  reply text into TTS, emitting `user_transcript(_partial)` / `text` / `audio_start` /
  `audio` / `audio_end` / `error` events through a `send` callback you provide.
- `DeepgramStreamingSTT` — Deepgram streaming STT provider.
- `CartesiaStreamingTTS` — Cartesia streaming TTS provider (persistent websocket,
  supports back-to-back contexts).
- `ElevenLabsStreamingTTS` — ElevenLabs streaming TTS provider (per-utterance
  websocket).
- `SpeechTurn` — owns one TTS context from first text to final audio, including
  failure/disconnect/timeout paths. Used internally by `VoiceTurnSession`; exported
  in case you want to drive TTS directly without the STT/turn-queueing machinery.

None of these know about your transport, your LLM, or your users — `VoiceTurnSession`
only sees text in, text out.

## Install

```bash
npm install voice-turn-pipeline ws
```

`ws` is a peer dependency, needed only if you use the bundled Cartesia/ElevenLabs
providers (they open outbound websockets to those APIs). Bring your own STT/TTS
provider instead and you don't need it, as long as it matches the `StreamingSTT` /
`StreamingTTS` interfaces.

## Usage

```ts
import { WebSocketServer } from "ws";
import {
  VoiceTurnSession,
  DeepgramStreamingSTT,
  CartesiaStreamingTTS,
} from "voice-turn-pipeline";

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (ws) => {
  const stt = new DeepgramStreamingSTT(process.env.DEEPGRAM_API_KEY);
  const tts = new CartesiaStreamingTTS(process.env.CARTESIA_API_KEY, {
    voiceId: process.env.CARTESIA_VOICE_ID!,
  });

  const session = new VoiceTurnSession({
    send: (event) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(event)),
    close: (code, reason) => ws.close(code, reason),
    stt,
    ttsRoute: { persistent: true, instance: tts },
    // This is the only place your app logic lives: call your LLM, stream its
    // output through onDelta, return the full reply text.
    onUtterance: async (userText, onDelta) => {
      const reply = await myLLM.respond(userText, { onDelta });
      return reply;
    },
    // Optional: persist the turn. Runs in parallel with TTS teardown, so it
    // never delays audio delivery to the client.
    onTurnComplete: async (userText, replyText) => {
      await myHistoryStore.append(userText, replyText);
    },
  });

  session.start();

  ws.on("message", (raw) => {
    const str = raw.toString();
    if (str === "COMMIT") return session.onClientCommit();
    if (str.startsWith("{")) {
      const msg = JSON.parse(str);
      if (msg.type === "audio_config") return void session.onClientAudioConfig(msg);
      return; // other control messages are yours to handle
    }
    session.onClientAudio(Buffer.from(str, "base64")); // or raw binary frames
  });

  ws.on("close", () => session.shutdown());
});
```

Client wire protocol (what `VoiceTurnSession` expects you to route to it):

- `audio_config` — `{ type: "audio_config", sample_rate: number }`, sent once before
  streaming audio (and again if the input device changes).
- PCM16 mono audio chunks, in whatever framing your transport uses.
- A commit signal ("end of utterance", push-to-talk released) — `onClientCommit()`.

Events `VoiceTurnSession` sends back via `send`:

| type | when |
|---|---|
| `user_transcript_partial` | live STT interim result |
| `user_transcript` | a finalized STT segment |
| `text` | the full reply text, once generated |
| `audio_start` / `audio` / `audio_end` | one TTS turn's audio stream, tagged with a `request_id` |
| `error` | a recoverable or unrecoverable failure; unrecoverable ones also call `close()` |

## Bring your own provider

`StreamingSTT` and `StreamingTTS` are structural interfaces (see `src/types.ts` and
`src/speechTurn.ts`) — anything that matches the shape works, no need to extend a
base class. Swap in Azure/Google STT or any other TTS vendor by implementing the
interface and passing an instance in.

## License

MIT
