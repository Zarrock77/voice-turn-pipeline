import { jest } from "@jest/globals";
import { EventEmitter } from "node:events";

class Live extends EventEmitter {
  send=jest.fn();finish=jest.fn();getReadyState=()=>1;
}
const lives:Live[]=[];
const events={Open:'open',Error:'error',Transcript:'transcript',UtteranceEnd:'utterance-end'};
jest.unstable_mockModule('@deepgram/sdk',()=>({
  LiveTranscriptionEvents:events,
  createClient:()=>({listen:{live:()=>{
    const live=new Live();lives.push(live);queueMicrotask(()=>live.emit(events.Open));return live;
  }}}),
}));
const {DeepgramStreamingSTT}=await import('../src/deepgram.js');
const packet=(text:string,start=0,duration=1,flags={speech_final:false,from_finalize:false})=>({
  channel:{alternatives:[{transcript:text}]},is_final:true,start,duration,...flags,
});
beforeEach(()=>{lives.length=0;});

test('empty final results retain speech/finalization metadata',async()=>{
  const stt=new DeepgramStreamingSTT('fake');const final=jest.fn();stt.onFinal=final;await stt.start();
  lives[0].emit(events.Transcript,packet('',0,1,{speech_final:true,from_finalize:true}));
  expect(final).toHaveBeenCalledWith('',true,{fromFinalize:true,end:1});expect(stt.finalAudioSeconds).toBe(1);stt.close();
});

test('finalized coverage is distinct from audio submitted and interim results',async()=>{
  const stt=new DeepgramStreamingSTT('fake');await stt.start();stt.sendAudio(Buffer.alloc(96000));
  expect(stt.audioSecondsSent).toBe(1);expect(stt.finalAudioSeconds).toBe(0);
  lives[0].emit(events.Transcript,{...packet('provisoire'),is_final:false});expect(stt.finalAudioSeconds).toBe(0);
  lives[0].emit(events.Transcript,packet('final',0,0.8));expect(stt.finalAudioSeconds).toBe(0.8);
  lives[0].emit(events.Transcript,packet('',0.8,0.2));expect(stt.finalAudioSeconds).toBe(1);stt.close();
});

test('repeated words at the same segment position are appended once but new boundaries survive',async()=>{
  const stt=new DeepgramStreamingSTT('fake');const final=jest.fn();stt.onFinal=final;await stt.start();
  const first=packet('bonjour');lives[0].emit(events.Transcript,first);lives[0].emit(events.Transcript,first);
  const end=packet('bonjour',0,1,{speech_final:true,from_finalize:true});
  lives[0].emit(events.Transcript,end);lives[0].emit(events.Transcript,end);
  expect(final.mock.calls).toEqual([['bonjour',false,{fromFinalize:false,end:1}],['',true,{fromFinalize:true,end:1}]]);stt.close();
});

test('identical words spoken again at a new position are retained',async()=>{
  const stt=new DeepgramStreamingSTT('fake');const final=jest.fn();stt.onFinal=final;await stt.start();
  lives[0].emit(events.Transcript,packet('oui',0,1));lives[0].emit(events.Transcript,packet('oui',1,1));
  expect(final.mock.calls.map(c=>c[0])).toEqual(['oui','oui']);stt.close();
});

test('closed or superseded sockets cannot append late results',async()=>{
  const stt=new DeepgramStreamingSTT('fake');const final=jest.fn();stt.onFinal=final;await stt.start();
  stt.sendAudio(Buffer.alloc(96000));await stt.reconfigure({sampleRate:48000});expect(stt.audioSecondsSent).toBe(0);
  lives[0].emit(events.Transcript,packet('ancien'));expect(final).not.toHaveBeenCalled();
  stt.close();lives[1].emit(events.Transcript,packet('ferme'));expect(final).not.toHaveBeenCalled();
});

test('Finalize reports a closed transport instead of silently claiming success',async()=>{
  const stt=new DeepgramStreamingSTT('fake');expect(stt.finalize()).toBe(false);await stt.start();
  expect(stt.finalize()).toBe(true);expect(lives[0].send).toHaveBeenCalledWith(JSON.stringify({type:'Finalize'}));
  stt.close();expect(stt.finalize()).toBe(false);
});
