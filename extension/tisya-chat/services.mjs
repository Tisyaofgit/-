export const NS = 'tisya-chat';
export const copy = value => structuredClone(value);
export const scopeOf = ctx => {
  if(!ctx.chatId)return null;
  const binding=ctx.chatMetadata?.tisya_chat;
  if(binding?.integrity===ctx.chatMetadata?.integrity&&binding?.key)return binding.key;
  return JSON.stringify([ctx.groupId ? 'group' : 'character', ctx.groupId ?? ctx.characters[ctx.characterId]?.avatar, ctx.chatId]);
};
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Reconstructible values only. Never retain DOM nodes, messages or iframe handles.
export class ProjectionCache {
  constructor({maxEntries=160, maxBytes=8*1024*1024}={}) { Object.assign(this,{maxEntries,maxBytes}); this.rows=new Map(); this.bytes=0; this.hits=0; this.misses=0; }
  read(key, revision, build) {
    const old=this.rows.get(key);
    if(old?.revision===revision){this.hits++;this.rows.delete(key);this.rows.set(key,old);return old.value;}
    this.misses++;this.delete(key);
    const value=build(), bytes=(revision.length+JSON.stringify(value).length)*2;
    if(bytes<=this.maxBytes){this.rows.set(key,{revision,value,bytes});this.bytes+=bytes;while(this.rows.size>this.maxEntries||this.bytes>this.maxBytes)this.delete(this.rows.keys().next().value);}
    return value;
  }
  delete(key){const old=this.rows.get(key);if(old)this.bytes-=old.bytes;this.rows.delete(key);}
  clear(){this.rows.clear();this.bytes=0;}
  report(){return {entries:this.rows.size,bytes:this.bytes,hits:this.hits,misses:this.misses};}
}

export class Workspace {
  constructor(store,{maxHot=6,onError=()=>{},parentOf=()=>null}={}) { Object.assign(this,{store,maxHot,onError,parentOf});this.hot=new Map();this.loading=new Map();this.writes=new Map();this.pins=new Map();this.pending=new Map();this.dirty=new Set(); }
  pin(scope){this.pins.set(scope,(this.pins.get(scope)??0)+1);let released=false;return()=>{if(released)return;released=true;const count=this.pins.get(scope)-1;if(count)this.pins.set(scope,count);else this.pins.delete(scope);this.trim();};}
  async load(scope) {
    if(!scope)throw Error('请先打开会话。');
    if(this.hot.has(scope)){const row=this.hot.get(scope);this.hot.delete(scope);this.hot.set(scope,row);return row;}
    if(this.loading.has(scope))return this.loading.get(scope);
    const task=(async()=>{const raw=await this.store.read('workspaces',scope);const row=raw??{story:'',note:'',mode:'story',turns:[],phrases:[],narrative:null};
      const parent=!raw?this.parentOf(scope):null;
      if(parent&&parent!==scope){const source=await this.load(parent);row.narrative=copy(source.narrative);row.phrases=copy(source.phrases);row.inheritedFrom=parent;}
      this.hot.set(scope,row);if(parent&&parent!==scope)await this.save(scope);this.trim(scope);return row;})();
    this.loading.set(scope,task);try{return await task;}finally{this.loading.delete(scope);}
  }
  trim(keep){for(const key of this.hot.keys()){if(this.hot.size<=this.maxHot)break;if(key!==keep&&!this.writes.has(key)&&!this.pins.has(key)&&!this.dirty.has(key))this.hot.delete(key);}}
  scheduleSave(scope,delay=180){let pending=this.pending.get(scope);if(!pending){pending={release:this.pin(scope)};this.pending.set(scope,pending);}clearTimeout(pending.timer);pending.timer=setTimeout(()=>this.commitPending(scope).catch(()=>{}),delay);}
  async commitPending(scope){const pending=this.pending.get(scope);if(!pending)return;clearTimeout(pending.timer);this.pending.delete(scope);try{await this.save(scope);}finally{pending.release();}}
  // Only writes to one concrete workspace are ordered; independent workspaces run together.
  async save(scope) {
    const row=this.hot.get(scope);if(!row)throw Error('会话工作区尚未载入。');
    this.dirty.add(scope);const snapshot=copy(row), previous=this.writes.get(scope);
    const task=(previous?previous.catch(()=>{}):Promise.resolve()).then(()=>this.store.write('workspaces',scope,snapshot));
    this.writes.set(scope,task);try{await task;if(this.writes.get(scope)===task)this.dirty.delete(scope);}catch(error){this.onError(error);throw error;}finally{if(this.writes.get(scope)===task)this.writes.delete(scope);this.trim();}
  }
  async flush(){await Promise.all([...this.dirty].filter(key=>!this.pending.has(key)&&!this.writes.has(key)).map(key=>this.save(key)));await Promise.all([...this.pending.keys()].map(key=>this.commitPending(key)));await Promise.all([...this.writes.values()]);}
  report(){return {hot:this.hot.size,loading:this.loading.size,writes:this.writes.size,pending:this.pending.size,pinned:this.pins.size,dirty:this.dirty.size};}
}

export function nativeStore(api,crypto=globalThis.crypto){
  async function key(raw){return 'k'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
  return {
    async read(table,scope){const r=await api.tryGetJson({namespace:NS,table,key:await key(scope)});return r.found?r.value:null;},
    async write(table,scope,value){await api.setJson({namespace:NS,table,key:await key(scope),value});}
  };
}

export class Conversation {
  constructor({host,workspace,onChange=()=>{}}){Object.assign(this,{host,workspace,onChange});this.active=new Map();}
  async talk(scope){
    if(this.active.has(scope))throw Error('当前会话的场外回复仍在生成。');
    const release=this.workspace.pin(scope);this.active.set(scope,true);
    let record,row;
    try{
    row=await this.workspace.load(scope);const text=row.note.trim();if(!text)throw Error('先写下想对缇斯亚说的话。');
    record={id:crypto.randomUUID(),user:text,assistant:null,status:'running',at:new Date().toISOString()};row.turns.push(record);await this.workspace.save(scope);this.onChange(scope);
    const promise=this.host.talk(text,row.turns.filter(t=>t!==record&&t.status==='done'),{scope,onContext:context=>{record.context=context;}});
    const answer=await promise;if(typeof answer!=='string'||!answer.trim())throw Error('模型返回了空回复。');record.assistant=answer;record.status='done';if(row.note===text)row.note='';await this.workspace.save(scope);return record;
    }catch(error){if(record){record.status='failed';record.error=error.message;try{await this.workspace.save(scope);}catch(saveError){throw new AggregateError([error,saveError],`${error.message}；场外记录保存失败：${saveError.message}`);}}throw error;}
    finally{this.active.delete(scope);release();this.onChange(scope);}
  }
}
