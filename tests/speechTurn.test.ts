import { jest } from "@jest/globals";
import { SpeechTurn, type StreamingTTS } from "../src/speechTurn.js";

class FakeTTS implements StreamingTTS {
  onAudio: (pcm: string) => void = () => {};
  onFinal: () => void = () => {};
  onError: (err: Error) => void = () => {};
  start = jest.fn(async () => {});
  beginUtterance = jest.fn();
  sendText = jest.fn<(text: string) => void>();
  flush = jest.fn();
  close = jest.fn();
}

const ready = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const pcm = Buffer.alloc(9600, 1).toString("base64");

afterEach(() => { jest.useRealTimers(); });

test("finishing text waits for final audio and emits ordered boundaries with a stable id", async () => {
  const tts = new FakeTTS();
  const events: Record<string, unknown>[] = [];
  const turn = new SpeechTurn(tts, (e) => events.push(e), false);
  turn.write("Bon"); turn.write("jour.");
  await ready();
  expect(tts.sendText.mock.calls).toEqual([["Bon"], ["jour."]]);
  let finished = false;
  const done = turn.finishText().then(() => { finished = true; });
  await ready();
  expect(tts.flush).toHaveBeenCalledTimes(1);
  expect(finished).toBe(false);
  tts.onAudio(pcm); tts.onAudio(pcm);
  expect(events.map(e => e.type)).toEqual(["audio_start", "audio", "audio"]);
  tts.onFinal();
  await done;
  expect(events.map(e => e.type)).toEqual(["audio_start", "audio", "audio", "audio_end"]);
  expect(events.every(e => e.request_id === turn.id)).toBe(true);
  expect(events.at(-1)).toMatchObject({ status: "ok", audio_frames: 9600, audio_chunks: 2 });
  expect(tts.close).not.toHaveBeenCalled();
  await turn.finishText();
  expect(tts.flush).toHaveBeenCalledTimes(1);
});

test("provider failure closes the context once and ignores stale callbacks", async () => {
  const tts = new FakeTTS(); const events: Record<string, unknown>[] = [];
  const turn = new SpeechTurn(tts, (e) => events.push(e), false);
  turn.write("Bonjour."); await ready();
  const lateAudio = tts.onAudio; const lateFinal = tts.onFinal;
  const done = turn.finishText(); await ready();
  tts.onError(new Error("disconnected"));
  await done;
  lateAudio(pcm); lateFinal();
  expect(events.filter(e => e.type === "audio_end")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "audio_end", status: "error" });
  expect(events.filter(e => e.type === "audio")).toHaveLength(0);
  expect(tts.close).toHaveBeenCalledTimes(1);
});

test("a missing final event times out, while incoming audio refreshes the idle deadline", async () => {
  jest.useFakeTimers();
  const tts = new FakeTTS(); const events: Record<string, unknown>[] = [];
  const turn = new SpeechTurn(tts, (e) => events.push(e), false);
  turn.write("Bonjour."); await ready();
  const done = turn.finishText(); await ready();
  jest.advanceTimersByTime(29000); tts.onAudio(pcm);
  jest.advanceTimersByTime(29000);
  expect(events.some(e => e.type === "audio_end")).toBe(false);
  jest.advanceTimersByTime(1001);
  await done;
  expect(events.at(-1)).toMatchObject({ type: "audio_end", status: "error" });
  expect(tts.close).toHaveBeenCalledTimes(1);
});

test("disconnect before opening cannot start a new connection or emit late audio", async () => {
  const tts = new FakeTTS(); const events: Record<string, unknown>[] = [];
  const turn = new SpeechTurn(tts, (e) => events.push(e), false);
  turn.cancel(); await turn.finishText();
  expect(tts.start).not.toHaveBeenCalled();
  expect(tts.beginUtterance).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});

test("per-turn providers close on success and an empty reply cannot block the next", async () => {
  const tts = new FakeTTS(); const events: Record<string, unknown>[] = [];
  const turn = new SpeechTurn(tts, (e) => events.push(e), true);
  turn.write("Bonjour."); await ready();
  const done = turn.finishText(); await ready();
  tts.onAudio(pcm); tts.onFinal(); await done;
  expect(tts.close).toHaveBeenCalledTimes(1);
  const next = new SpeechTurn(new FakeTTS(), (e) => events.push(e), false);
  await next.finishText();
  expect(events.at(-1)).toMatchObject({ type: "audio_end", status: "ok", audio_frames: 0 });
});
