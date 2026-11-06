import test from 'node:test';
import assert from 'node:assert/strict';
import {Workspace,ProjectionCache,Conversation} from '../extension/tisya-chat/services.mjs';
import {parseReply,projectReply} from '../extension/tisya-chat/projection.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('native write conflict reproduced: unsequenced old snapshot arrives last',async()=>{let saved;await Promise.all([delay(25).then(()=>saved='old'),delay(1).then(()=>saved='new')]);assert.equal(saved,'old');});
test('same-workspace persistence publishes newest; independent workspaces overlap',async()=>{
 const disk=new Map();let running=0,max=0;
 const w=new Workspace({read:async(t,k)=>disk.get(k),write:async(t,k,v)=>{running++;max=Math.max(max,running);await delay(v.story==='old'?25:2);disk.set(k,v);running--;}});
 const a=await w.load('a'),b=await w.load('b');a.story='old';const p=w.save('a');a.story='new';const q=w.save('a');b.story='other';await Promise.all([p,q,w.save('b')]);assert.equal(disk.get('a').story,'new');assert.equal(disk.get('b').story,'other');assert.ok(max>=2);
});
test('workspace is cold-loaded once; evicted workspaces recover persisted drafts',async()=>{
 let reads=0;const disk=new Map();const w=new Workspace({read:async(t,k)=>{reads++;await delay(2);return disk.get(k);},write:async(t,k,v)=>disk.set(k,v)},{maxHot:2});
 const [a,b]=await Promise.all([w.load('a'),w.load('a')]);assert.equal(a,b);assert.equal(reads,1);a.story='stay';await w.save('a');await w.load('b');await w.load('c');assert.equal(w.report().hot,2);assert.equal((await w.load('a')).story,'stay');
});
test('storage errors do not return a previous or empty workspace',async()=>{const w=new Workspace({read:async()=>{throw Error('disk offline');}});await assert.rejects(w.load('a'),/disk offline/);assert.equal(w.hot.size,0);});
test('large conversation projections stay within bytes and entry bounds',()=>{const c=new ProjectionCache({maxEntries:50,maxBytes:100000});for(let i=0;i<2000;i++)c.read('msg'+i,'text'.repeat(100),()=>({body:'text'.repeat(200)}));assert.ok(c.report().entries<=50);assert.ok(c.report().bytes<=100000);let builds=0;c.read('last','a',()=>++builds);c.read('last','a',()=>++builds);c.read('last','b',()=>++builds);assert.equal(builds,2);});
test('latest onepass preserves frontend and action while native reply remains native',()=>{
 const code='```html\n<div id="x">panel</div><script>window.x=1</script>\n```';
 const source='<reply id="tisya-onepass-1"><body>正文\n\n第二段</body><extra>@POSITION:top\n'+code+'</extra><cells>@ACT:x</cells><vars>_.set(x,1)</vars><actions>观察|看向灯火|可能找到线索</actions></reply>';
 const p=parseReply(source);assert.equal(p.body,'正文\n\n第二段');assert.equal(p.position,'top');const html=projectReply(source);assert.ok(html.indexOf(code)<html.indexOf('正文'));assert.ok(html.includes('#tisya-action='));assert.ok(!html.split('原始回复')[0].includes('@ACT:x'));assert.ok(!html.split('原始回复')[0].includes('_.set(x,1)'));assert.equal(p.source,source);assert.equal(projectReply('plain message'),'plain message');assert.equal(parseReply('<reply id="old"><body>x</body></reply>').kind,'native');
});
test('malformed and unfinished replies preserve source visibly instead of old values',()=>{assert.ok(projectReply('<reply id="tisya-onepass-1"><body>partial').includes('partial'));assert.ok(projectReply('<reply id="tisya-onepass-1"></reply>').includes('缺少正文'));});
test('offstage answer returns to captured workspace; empty answer remains a visible failure',async()=>{
 const disk=new Map(),w=new Workspace({read:async(t,k)=>disk.get(k),write:async(t,k,v)=>disk.set(k,v)});const a=await w.load('a');a.note='hello';const c=new Conversation({workspace:w,host:{talk:async()=>{await delay(5);return 'answer';}}});const p=c.talk('a');await w.load('b');await p;assert.equal(a.turns[0].assistant,'answer');assert.equal((await w.load('b')).turns.length,0);a.note='again';c.host.talk=async()=>'';await assert.rejects(c.talk('a'),/空回复/);assert.equal(a.note,'again');assert.equal(a.turns[1].status,'failed');
});
test('active generation survives hot-cache eviction and rejects double submit',async()=>{
 const disk=new Map(),w=new Workspace({read:async(t,k)=>disk.get(k),write:async(t,k,v)=>disk.set(k,v)},{maxHot:1});
 (await w.load('a')).note='working';let answer;const c=new Conversation({workspace:w,host:{talk:()=>new Promise(r=>answer=r)}});const p=c.talk('a');await delay(1);await assert.rejects(c.talk('a'),/仍在生成/);for(let i=0;i<20;i++)await w.load('other'+i);assert.ok(w.hot.has('a'));answer('done');await p;assert.equal(disk.get('a').turns[0].assistant,'done');assert.equal(w.report().pinned,0);assert.ok(w.report().hot<=1);
});
test('independent debounced drafts survive rapid workspace switches and flush',async()=>{
 const disk=new Map(),w=new Workspace({read:async(t,k)=>disk.get(k),write:async(t,k,v)=>disk.set(k,v)},{maxHot:1});for(let i=0;i<12;i++){(await w.load('s'+i)).story='draft'+i;w.scheduleSave('s'+i,1000);}await w.flush();for(let i=0;i<12;i++)assert.equal(disk.get('s'+i).story,'draft'+i);assert.equal(w.report().pinned,0);assert.equal(w.report().pending,0);assert.ok(w.report().hot<=1);
});

test('failed persistence retains the newest draft until an explicit retry succeeds',async()=>{
 let fail=true;const disk=new Map();const w=new Workspace({read:async(t,k)=>disk.get(k),write:async(t,k,v)=>{if(fail)throw Error('write offline');disk.set(k,v);}},{maxHot:1});(await w.load('a')).story='unsaved latest';await assert.rejects(w.save('a'),/write offline/);for(let i=0;i<8;i++)await w.load('b'+i);assert.ok(w.hot.has('a'));assert.equal(w.report().dirty,1);fail=false;await w.flush();assert.equal(disk.get('a').story,'unsaved latest');assert.equal(w.report().dirty,0);
});

test('raw and partial reply diagnostics cannot start a second fenced frontend',()=>{
 const source='<reply id="tisya-onepass-1"><body>text</body><extra>```html\n<script>window.sideEffect=1</script>\n```</extra></reply>';const result=projectReply(source);const raw=result.split('原始回复')[1];assert.ok(raw.includes('&#96;&#96;&#96;html'));assert.ok(!raw.includes('```html'));assert.ok(raw.includes('&lt;script&gt;'));const partial=projectReply(source.slice(0,-8));assert.ok(partial.includes('tisya-raw-reply'));assert.ok(!partial.includes('```html'));
});
