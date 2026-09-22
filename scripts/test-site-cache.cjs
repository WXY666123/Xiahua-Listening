const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function worker() {
  const handlers={}; const cache=new Map(); const deleted=[];
  const root='https://example.test/Xiahua-Listening/';
  const context={URL,AbortController,setTimeout,clearTimeout,fetch:async()=>{throw Error('offline');},
    self:{location:{href:root+'sw.js'},clients:{claim:async()=>{}},addEventListener:(n,f)=>handlers[n]=f},
    caches:{open:async()=>({addAll:async urls=>urls.forEach(u=>cache.set(u,{url:u})),match:async key=>cache.get(typeof key==='string'?key:key.url)}),keys:async()=>['unrelated-reading-cache','xiahua-shell-old'],delete:async k=>deleted.push(k)}};
  vm.runInNewContext(fs.readFileSync('sw.js','utf8'),context);
  return {root,handlers,cache,deleted};
}
test('offline return restores both root and index URLs, including query strings',async()=>{
  const s=worker(); let pending; s.handlers.install({waitUntil:p=>pending=p}); await pending;
  for(const suffix of ['', '?v=old', 'index.html', 'index.html?v=old']) {
    let result; s.handlers.fetch({request:{url:s.root+suffix,method:'GET',mode:'navigate'},respondWith:p=>result=p});
    assert.equal((await result).url,s.root);
  }
});
test('audio and other sites never enter shell cache handler',()=>{
  const s=worker(); for(const url of [s.root+'普通/test/audio.mp3','https://example.test/IELTS-practice/index.html']) {
    let intercepted=false; s.handlers.fetch({request:{url,method:'GET',mode:'navigate'},respondWith:()=>intercepted=true});assert.equal(intercepted,false);
  }
});
test('activation only removes obsolete listening shell caches',async()=>{
  const s=worker(); let pending; s.handlers.activate({waitUntil:p=>pending=p});await pending;assert.deepEqual(s.deleted,['xiahua-shell-old']);
});
test('precache contains every script needed by home and player',async()=>{
  const s=worker();let pending;s.handlers.install({waitUntil:p=>pending=p});await pending;
  for(const file of ['index.html','JS/player.html']) {
    const html=fs.readFileSync(file,'utf8');
    for(const [,src] of html.matchAll(/<script src="([^"]+)"/g)) assert.ok(s.cache.has(new URL(src,s.root+file).href),src);
  }
});
