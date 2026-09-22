const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Audio extends EventTarget {
  constructor() { super(); Object.assign(this, {currentTime: 83, duration: 300, playbackRate: 0.8, paused: false, ended: false, muted: false, volume: 1, src: 'https://example.test/audio.mp3', readyState: 4}); }
  emit(name) { this.dispatchEvent(new Event(name)); }
  pause() { this.paused = true; this.emit('pause'); }
  play() { this.paused = false; this.emit('play'); return Promise.resolve(); }
  load() { this.loads = (this.loads || 0) + 1; this.currentTime = 0; this.paused = true; this.emit('loadedmetadata'); this.emit('canplay'); }
  setAttribute() {}
}
function setup() {
  const timers = new Map(); let id = 0;
  const document = new EventTarget(); document.visibilityState = 'visible';
  const window = new EventTarget(); Object.assign(window, {setTimeout: (fn) => {timers.set(++id, fn); return id;}, clearTimeout: (i) => timers.delete(i)});
  const context = {window, document, console, URL, navigator: {}, setStatus() {}};
  if (fs.existsSync('JS/audio-recovery.js')) vm.runInNewContext(fs.readFileSync('JS/audio-recovery.js','utf8'), context);
  else {
    const old = fs.readFileSync('JS/player-app.js','utf8').split('  function attachAudioRetry(')[1].split('  function installFrameAudioRetry')[0];
    vm.runInNewContext('window.ListeningAudio = {attach: function attachAudioRetry(' + old.trim() + '};', context);
  }
  const audio = new Audio();
  const control = window.ListeningAudio.attach(audio, () => audio.src, {report() {}});
  return {audio, control, document, window, tick() {const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn());}};
}
test('network recovery retains position and speed', () => { const s=setup(); s.audio.emit('error'); s.tick(); assert.equal(s.audio.currentTime,83); assert.equal(s.audio.playbackRate,0.8); });
test('metadata does not reset a failing retry budget', () => { const s=setup(); for(let i=0;i<6;i++){s.audio.emit('error');s.tick();} assert.equal(s.audio.loads,3); });
test('background pauses playback; returning does not silently autoplay', () => { const s=setup(); s.document.visibilityState='hidden'; s.document.dispatchEvent(new Event('visibilitychange')); assert.equal(s.audio.paused,true); s.document.visibilityState='visible'; s.document.dispatchEvent(new Event('visibilitychange')); assert.equal(s.audio.paused,true); });
test('manual repair retains position, unmutes and resumes', () => { const s=setup(); s.audio.muted=true; s.audio.volume=0; s.control.recover(); assert.equal(s.audio.currentTime,83); assert.equal(s.audio.muted,false); assert.equal(s.audio.volume,1); assert.equal(s.audio.paused,false); });
test('source change cancels pending retry', () => { const s=setup(); s.audio.emit('error'); s.audio.src='https://example.test/part2.mp3'; s.tick(); assert.equal(s.audio.loads,undefined); });
test('user pause cancels autoplay during retry', () => {const s=setup(); s.audio.emit('error'); s.audio.pause(); s.tick(); assert.equal(s.audio.paused,true);});
test('a new suite part never restores the previous part position', () => {const s=setup();s.audio.src='https://example.test/part2.mp3';s.audio.currentTime=0;s.audio.emit('loadstart');s.audio.emit('error');s.tick();assert.equal(s.audio.currentTime,0);});
test('return handler only binds the anchor, never the audio recovery button',()=>{
 const source=fs.readFileSync('JS/player-app.js','utf8');
 assert.equal(source.includes('document.querySelector(".back-link")'),false);
 assert.equal((source.match(/document\.querySelector\("a\.back-link"\)/g)||[]).length,2);
});
