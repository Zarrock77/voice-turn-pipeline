import { jest } from "@jest/globals";
import { VoiceTurnSession, DEFAULT_INPUT_FINALIZATION_TIMEOUT_MS } from "../src/voiceTurnSession.js";
import type { StreamingTTS } from "../src/speechTurn.js";
import type { StreamingSTT, FinalTranscriptInfo } from "../src/types.js";

class FakeTTS implements StreamingTTS {
  onAudio: (pcm: string) => void = () => {};
  onFinal: () => void = () => {};
  onError: (err: Error) => void = () => {};
  start = jest.fn(async () => {});
  beginUtterance = jest.fn();
  sendText = jest.fn();
  flush = jest.fn();
  close = jest.fn();
}

type PartialFinalInfo = { fromFinalize: boolean; end?: number | null };

class FakeSTT implements StreamingSTT {
  private finalHandler: (text: string, final: boolean, info: FinalTranscriptInfo) => void = () => {};
  set onFinal(fn: (text: string, final: boolean, info: FinalTranscriptInfo) => void) { this.finalHandler = fn; }
  // Test call sites usually omit `end`; default it to the current audio position,
  // mirroring what a real STT provider would report for "up to what I've sent so far".
  get onFinal(): (text: string, final: boolean, info: PartialFinalInfo) => void {
    return (text, final, info) => this.finalHandler(text, final, { end: this.audioSecondsSent, ...info });
  }
  onInterim = () => {}; onError = () => {}; onUtteranceEnd = () => {};
  sampleRate = 48000; audioSecondsSent = 0; finalAudioSeconds = 0;
  start = async () => {};
  sendAudio = jest.fn((b: Buffer) => { this.audioSecondsSent += b.length / 96000; });
  finalize = jest.fn(() => true);
  keepAlive = () => {}; close = () => {};
  reconfigure = async () => {};
}

const idle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

const record = (session: VoiceTurnSession, stt: FakeSTT, text: string) => {
  session.onClientAudio(Buffer.alloc(96000)); session.onClientCommit();
  stt.onFinal(text, true, { fromFinalize: true });
};

async function fixture(configure = true) {
  const events: Record<string, unknown>[] = [];
  const close = jest.fn();
  const stt = new FakeSTT();
  const tts = new FakeTTS();
  const onUtterance = jest.fn(async (_userText: string, onDelta: (d: string) => void) => {
    onDelta("Bonjour."); return "Bonjour.";
  });
  const onTurnComplete = jest.fn(async () => {});
  const session = new VoiceTurnSession({
    send: (e) => events.push(e),
    close,
    stt,
    ttsRoute: { persistent: true, instance: tts },
    onUtterance,
    onTurnComplete,
  });
  await session.start();
  if (configure) await session.onClientAudioConfig({ sample_rate: 48000 });
  return { session, events, close, stt, tts, onUtterance, onTurnComplete };
}

afterEach(() => { jest.useRealTimers(); });

test("a second utterance cannot replace the first context after text completes", async () => {
  const { session, events, stt, tts, onUtterance } = await fixture();
  try {
    record(session, stt, "Premiere demande"); await idle();
    expect(onUtterance).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.type === "text")).toBe(true);
    record(session, stt, "Deuxieme demande"); await idle();
    expect(onUtterance).toHaveBeenCalledTimes(1);
    expect(tts.beginUtterance).toHaveBeenCalledTimes(1);
    tts.onAudio(Buffer.alloc(4800).toString("base64"));
    tts.onFinal(); await idle();
    expect(onUtterance).toHaveBeenCalledTimes(2);
    expect(tts.beginUtterance).toHaveBeenCalledTimes(2);
    const firstEnd = events.findIndex(e => e.type === "audio_end");
    const starts = events.map((e, i) => e.type === "audio_start" ? i : -1).filter(i => i >= 0);
    expect(firstEnd).toBeLessThan(starts[1]);
    expect(events[starts[0]].request_id).not.toBe(events[starts[1]].request_id);
    tts.onFinal(); await idle();
  } finally { session.shutdown(); }
});

test("disconnect cancels active generation and discards pending requests", async () => {
  const { session, events, stt, tts, onUtterance } = await fixture();
  record(session, stt, "Premiere demande"); await idle();
  record(session, stt, "Deuxieme demande");
  const late = tts.onAudio;
  const count = events.length;
  session.shutdown();
  late(Buffer.alloc(4800).toString("base64")); await idle();
  expect(events).toHaveLength(count);
  expect(onUtterance).toHaveBeenCalledTimes(1);
  expect(tts.close).toHaveBeenCalled();
});

test("incident: transcript before COMMIT and an empty final boundary produces one reply", async () => {
  const { session, events, stt, onUtterance } = await fixture();
  try {
    session.onClientAudio(Buffer.alloc(96000));
    stt.onFinal("Objet secret", false, { fromFinalize: false });
    expect(onUtterance).not.toHaveBeenCalled();
    session.onClientCommit();
    stt.onFinal("", true, { fromFinalize: true }); await idle();
    expect(onUtterance).toHaveBeenCalledTimes(1);
    expect(onUtterance.mock.calls[0][0]).toBe("Objet secret");
    expect(events.filter(e => e.type === "user_transcript").map(e => e.data)).toEqual(["Objet secret"]);
    session.onClientCommit(); stt.onFinal("", true, { fromFinalize: true }); await idle();
    expect(onUtterance).toHaveBeenCalledTimes(1);
  } finally { session.shutdown(); }
});

test("COMMIT before multiple final segments waits for the trailing words", async () => {
  const { session, stt, onUtterance } = await fixture();
  try {
    session.onClientAudio(Buffer.alloc(96000)); session.onClientCommit();
    stt.onFinal("Un objet", false, { fromFinalize: false }); await idle();
    expect(onUtterance).not.toHaveBeenCalled();
    stt.onFinal("secret", false, { fromFinalize: true }); await idle();
    expect(onUtterance).toHaveBeenCalledTimes(1);
    expect(onUtterance.mock.calls[0][0]).toBe("Un objet secret");
  } finally { session.shutdown(); }
});

test("a pause while PTT is held does not split the recording", async () => {
  const { session, stt, onUtterance } = await fixture();
  try {
    session.onClientAudio(Buffer.alloc(48000));
    stt.onFinal("La premiere partie", true, { fromFinalize: false }); await idle();
    expect(onUtterance).not.toHaveBeenCalled();
    session.onClientAudio(Buffer.alloc(48000)); session.onClientCommit();
    stt.onFinal("et la suite", true, { fromFinalize: true }); await idle();
    expect(onUtterance.mock.calls[0][0]).toBe("La premiere partie et la suite");
  } finally { session.shutdown(); }
});

test("already finalized audio does not wait for an optional Finalize acknowledgement", async () => {
  const { session, stt, onUtterance } = await fixture();
  try {
    session.onClientAudio(Buffer.alloc(96000));
    stt.finalAudioSeconds = stt.audioSecondsSent;
    stt.onFinal("Tout est transcrit", false, { fromFinalize: false }); session.onClientCommit(); await idle();
    expect(stt.finalize).not.toHaveBeenCalled(); expect(onUtterance).toHaveBeenCalledTimes(1);
  } finally { session.shutdown(); }
});

test("an empty speech_final result covering the committed audio closes the turn", async () => {
  const { session, stt, onUtterance } = await fixture();
  try {
    session.onClientAudio(Buffer.alloc(96000));
    stt.onFinal("Objet secret", false, { fromFinalize: false }); session.onClientCommit();
    stt.finalAudioSeconds = stt.audioSecondsSent;
    stt.onFinal("", true, { fromFinalize: false }); await idle();
    expect(onUtterance).toHaveBeenCalledTimes(1);
  } finally { session.shutdown(); }
});

test("recordings arriving during finalization remain separate and ordered", async () => {
  const { session, stt, tts, onUtterance } = await fixture();
  try {
    session.onClientAudio(Buffer.alloc(96000)); session.onClientCommit();
    session.onClientAudio(Buffer.alloc(96000)); session.onClientCommit(); session.onClientCommit();
    expect(stt.sendAudio).toHaveBeenCalledTimes(1);
    stt.onFinal("Premier", true, { fromFinalize: true }); await idle();
    expect(stt.sendAudio).toHaveBeenCalledTimes(2);
    stt.onFinal("Deuxieme", true, { fromFinalize: true }); await idle();
    expect(onUtterance).toHaveBeenCalledTimes(1);
    tts.onFinal(); await idle(); expect(onUtterance).toHaveBeenCalledTimes(2);
    expect(onUtterance.mock.calls[1][0]).toContain("Deuxieme");
    expect(onUtterance.mock.calls[1][0]).not.toContain("Premier");
  } finally { session.shutdown(); }
});

test("missing finalization gives an error and reconnect, never a partial reply", async () => {
  jest.useFakeTimers();
  const { session, stt, events, close, onUtterance } = await fixture();
  session.onClientAudio(Buffer.alloc(96000)); stt.onFinal("Debut incomplet", false, { fromFinalize: false }); session.onClientCommit();
  await jest.advanceTimersByTimeAsync(DEFAULT_INPUT_FINALIZATION_TIMEOUT_MS);
  expect(onUtterance).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledWith(1011, "speech input failed");
  expect(events.some(e => e.type === "error")).toBe(true);
  stt.onFinal("trop tard", true, { fromFinalize: true }); await idle(); expect(onUtterance).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test("a delayed boundary from the previous turn cannot complete the next recording", async () => {
  const { session, stt, tts, onUtterance } = await fixture();
  try {
    session.onClientAudio(Buffer.alloc(96000)); session.onClientCommit();
    session.onClientAudio(Buffer.alloc(96000)); session.onClientCommit();
    stt.finalAudioSeconds = 1;
    stt.onFinal("Premier", true, { fromFinalize: false, end: 1 }); await idle();
    expect(stt.audioSecondsSent).toBe(2);
    stt.onFinal("", true, { fromFinalize: true, end: 1 });
    stt.onFinal("Deuxieme", true, { fromFinalize: true, end: 2 }); await idle();
    tts.onFinal(); await idle();
    expect(onUtterance).toHaveBeenCalledTimes(2);
    expect(onUtterance.mock.calls[1][0]).toContain("Deuxieme");
  } finally { session.shutdown(); }
});

test("disconnect cancels the pending finalization deadline", async () => {
  jest.useFakeTimers();
  const { session, close, onUtterance } = await fixture();
  session.onClientAudio(Buffer.alloc(96000)); session.onClientCommit(); session.shutdown();
  await jest.advanceTimersByTimeAsync(DEFAULT_INPUT_FINALIZATION_TIMEOUT_MS);
  expect(close).not.toHaveBeenCalled(); expect(onUtterance).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
});

test("COMMIT before audio_config finalizes only after buffered PCM was sent", async () => {
  const { session, stt, onUtterance } = await fixture(false);
  try {
    session.onClientAudio(Buffer.alloc(96000)); session.onClientCommit(); expect(stt.finalize).not.toHaveBeenCalled();
    await session.onClientAudioConfig({ sample_rate: 48000 }); expect(stt.sendAudio).toHaveBeenCalledTimes(1);
    expect(stt.finalize).toHaveBeenCalledTimes(1);
    stt.onFinal("Configure", true, { fromFinalize: true }); await idle(); expect(onUtterance).toHaveBeenCalledTimes(1);
  } finally { session.shutdown(); }
});

test("silence completes without sending an empty request to the reply callback", async () => {
  const { session, stt, events, onUtterance } = await fixture();
  try {
    session.onClientAudio(Buffer.alloc(96000)); session.onClientCommit(); stt.onFinal("", true, { fromFinalize: true }); await idle();
    expect(onUtterance).not.toHaveBeenCalled(); expect(events.some(e => e.type === "error")).toBe(true);
  } finally { session.shutdown(); }
});
