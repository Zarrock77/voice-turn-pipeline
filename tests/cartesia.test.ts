import { jest } from "@jest/globals";
import { EventEmitter } from "node:events";

const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  constructor() { super(); sockets.push(this); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
  open() { this.readyState = 1; this.emit("open"); }
  message(msg: Record<string, unknown>) { this.emit("message", Buffer.from(JSON.stringify(msg))); }
}
jest.unstable_mockModule("ws", () => ({ default: FakeSocket }));
const { CartesiaStreamingTTS } = await import("../src/cartesia.js");
beforeEach(() => { sockets.length = 0; });

test("reuses an open socket and forbids replacing a context before final audio", async () => {
  const tts = new CartesiaStreamingTTS("fake-key", { voiceId: "test-voice" });
  const opened = tts.start(); sockets[0].open(); await opened;
  await tts.start(); expect(sockets).toHaveLength(1);
  tts.beginUtterance(); tts.sendText("Bonjour."); tts.flush();
  const id = sockets[0].sent[0].context_id;
  expect(() => tts.beginUtterance()).toThrow("has not finished");
  const audio = jest.fn(); const done = jest.fn();
  tts.onAudio = audio; tts.onFinal = done;
  sockets[0].message({ type: "chunk", context_id: id, data: "AAAA" });
  sockets[0].message({ type: "done", context_id: id, done: true });
  expect(audio).toHaveBeenCalledTimes(1); expect(done).toHaveBeenCalledTimes(1);
  expect(() => tts.beginUtterance()).not.toThrow();
  tts.close();
});

test("unexpected close reports incomplete speech and stale sockets cannot affect reconnection", async () => {
  const tts = new CartesiaStreamingTTS("fake-key", { voiceId: "test-voice" });
  const opened = tts.start(); sockets[0].open(); await opened;
  tts.beginUtterance(); tts.sendText("Premier.");
  const oldId = sockets[0].sent[0].context_id;
  const failed = jest.fn(); tts.onError = failed;
  sockets[0].close(); expect(failed).toHaveBeenCalledTimes(1);
  const reopened = tts.start(); sockets[1].open(); await reopened;
  tts.beginUtterance(); tts.sendText("Deuxieme.");
  const audio = jest.fn(); tts.onAudio = audio;
  sockets[0].message({ type: "chunk", context_id: oldId, data: "AAAA" });
  sockets[0].close();
  sockets[1].message({ type: "chunk", context_id: sockets[1].sent[0].context_id, data: "AQABAA==" });
  expect(audio.mock.calls).toEqual([["AQABAA=="]]);
  expect(failed).toHaveBeenCalledTimes(1);
  tts.close();
});

test("an error marked done cannot be reported as successful completion", async () => {
  const tts = new CartesiaStreamingTTS("fake-key", { voiceId: "test-voice" });
  const opened = tts.start(); sockets[0].open(); await opened;
  tts.beginUtterance(); tts.sendText("Bonjour.");
  const failed = jest.fn(); const done = jest.fn(); tts.onError = failed; tts.onFinal = done;
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    sockets[0].message({ type: "error", context_id: sockets[0].sent[0].context_id, done: true, error: "Test failure" });
    expect(failed).toHaveBeenCalledTimes(1); expect(done).not.toHaveBeenCalled();
  } finally { log.mockRestore(); tts.close(); }
});
