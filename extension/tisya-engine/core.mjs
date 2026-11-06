/* Host adapter independent of DOM. Event payload numbers are hints, never identities. */
export const NS='tisya_engine';
export const PROMPT_KEY='tisya_engine_materials';
export function makeUid(source=globalThis.crypto){
    if(source?.randomUUID)return source.randomUUID();
    if(!source?.getRandomValues)throw Error('浏览器缺少随机标识能力，请使用现代浏览器。');
    const b=new Uint8Array(16);source.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
    const h=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export function chatKey(ctx){
    if(!ctx.chatId)return null;
    return JSON.stringify([ctx.groupId?'group':'character',String(ctx.groupId??ctx.characterId??''),String(ctx.chatId)]);
}
export function ensureMessages(ctx,uid=makeUid){
    let changed=false;const used=new Set();
    for(const m of ctx.chat??[]){
        m.extra??={};let id=m.extra[NS]?.uid??m.swipe_info?.find(x=>x?.extra?.[NS]?.uid)?.extra?.[NS]?.uid;
        if(!id||used.has(id)){id=uid();m.extra[NS]={...(m.extra[NS]??{}),uid:id};changed=true;}
        if(m.extra[NS]?.uid!==id){m.extra[NS]={...(m.extra[NS]??{}),uid:id};changed=true;}
        for(const info of m.swipe_info??[]){if(!info)continue;info.extra??={};if(info.extra[NS]?.uid!==id){info.extra[NS]={...(info.extra[NS]??{}),uid:id};changed=true;}}
        used.add(id);
    }
    return changed;
}
export function captureMessages(ctx,{omitLastAssistant=false,excludeFrom=null}={}){
    let chat=ctx.chat??[];
    if(Number.isInteger(excludeFrom))chat=chat.slice(0,excludeFrom);
    if(omitLastAssistant&&chat.length&&!chat.at(-1).is_user&&!chat.at(-1).is_system)chat=chat.slice(0,-1);
    return chat.map(m=>({uid:m.extra[NS].uid,role:m.is_user?'user':m.is_system?'system':'assistant',text:String(m.mes??'')}));
}
export function signature(messages){return JSON.stringify(messages);}

export class Controller{
    constructor({getContext,storage,request,onUpdate=()=>{},uid=makeUid}){
        Object.assign(this,{getContext,storage,request,onUpdate,uid});this.owners=new Map();this.materials=new Map();this.packets=new Map();this.generating=new Map();
    }
    settings(){const c=this.getContext();return c.extensionSettings[NS]??={endpoint:'http://127.0.0.1:8765',mode:'macros'};}
    enabled(ctx=this.getContext()){return Boolean(ctx.chatMetadata?.[NS]?.enabled);}
    async identity(){
        const ctx=this.getContext(),key=chatKey(ctx);if(!key)throw Error('请先打开一个聊天。');
        const old=ctx.chatMetadata[NS];
        // Branch/fork metadata is copied by the host. A different host file gets
        // its own storage owner and a cloned bundle; it never writes its parent.
        if(!old||old.owner_chat_key!==key){
            const meta={...(old??{}),chat_uid:this.uid(),owner_chat_key:key,enabled:Boolean(old?.enabled)};
            ctx.chatMetadata[NS]=meta;
            if(old?.chat_uid){const parent=await this.storage.get(old.chat_uid);if(parent)await this.storage.set(meta.chat_uid,structuredClone(parent));}
            await ctx.saveMetadata();
        }
        return {ctx,key,id:ctx.chatMetadata[NS].chat_uid};
    }
    async attach(bundle){
        const {ctx,id}=await this.identity();const old=await this.storage.get(id);
        if(old)await this.storage.set(id+':backup:'+Date.now(),old);
        if(!bundle?.state?.schema||!bundle.state.tables)throw Error('文件不是引擎状态或完整聊天备份。');
        const copy=structuredClone(bundle);copy.journal??={entries:[],revision_by_uid:{}};
        copy.state.runtime??={};copy.state.runtime.scope??={};
        if(!copy.state.runtime.scope.owner_ref){
            const settings=this.settings();
            if(!settings.owner_ref){settings.owner_ref='contractor:'+this.uid();ctx.saveSettingsDebounced?.();}
            copy.state.runtime.scope.owner_ref=settings.owner_ref;
        }
        copy.journal.scope={...structuredClone(copy.state.runtime.scope),...(copy.journal.scope??{})};
        // Bind from the current end by default. Existing visible history is a
        // baseline context, not new payable commands. No historical re-settlement.
        ensureMessages(ctx,this.uid);
        const hostIds=new Set(captureMessages(ctx).map(m=>m.uid));
        const detached=Boolean(bundle.journal?.entries?.length&&!bundle.journal.entries.some(e=>hostIds.has(e.uid)));
        if(detached){copy.detached_journals??=[];copy.detached_journals.push(copy.journal);copy.journal={entries:[],revision_by_uid:{},scope:structuredClone(copy.journal.scope),notices:[{code:'IMPORTED_AS_BASELINE',message:'备份来自另一聊天：已保留当前状态和旧日志，新聊天从此状态继续。'}]};}
        if(!bundle.journal||detached){
            ensureMessages(ctx,this.uid);
            copy.journal.entries=captureMessages(ctx).map(m=>({uid:m.uid,signature:null,role:m.role,revision:0,baseline:true,pre_turn_snapshot:{inverse_patch:[]},warnings:[],settlement_status:'BASELINE'}));
            copy.journal.baseline_messages=captureMessages(ctx);
        }
        copy.local_revision=(old?.local_revision??0)+1;
        if(this.storage.commit){if(!await this.storage.commit(id,old?.local_revision??0,copy))throw Error('导入时此聊天已被另一窗口更新，请刷新后重试。');}
        else await this.storage.set(id,copy);ctx.chatMetadata[NS].enabled=true;await ctx.saveChat();await ctx.saveMetadata();
        this.onUpdate({status:'已绑定。现有历史作为导入基线，后续回复开始结算。',id});return copy;
    }
    async current(){const {id}=await this.identity();return this.storage.get(id);}
    async run(options={}){
        const {ctx,key,id}=await this.identity();if(!this.enabled(ctx))return null;
        const previous=this.owners.get(id)??Promise.resolve();
        // Only one chat's updates are ordered. Different owners remain independent.
        const task=previous.catch(()=>{}).then(async()=>{
            const live=this.getContext();if(chatKey(live)!==key)return null;
            const changed=ensureMessages(live,this.uid);if(changed)await live.saveChat();
            let bundle=await this.storage.get(id);if(!bundle)throw Error('此聊天尚未绑定引擎，请导入沙盒JSON或绑定空白引擎。');
            let messages=captureMessages(live,options),stamp=signature(messages);
            const response=await this.request('/api/plugin/reconcile',{bundle,messages,scope:bundle.journal?.scope??bundle.state.runtime?.scope});
            // A chat switch does not erase a completed old chat settlement. Keep
            // it under its captured owner; don't project old data into the new UI.
            const expected=bundle.local_revision??0;response.bundle.local_revision=expected+1;
            if(this.storage.commit){
                if(!await this.storage.commit(id,expected,response.bundle))throw Error('同一聊天刚被另一窗口更新。较新状态已保留，请刷新此聊天后重试。');
            }else{
                const current=await this.storage.get(id);if((current?.local_revision??0)!==expected)throw Error('同一聊天状态版本已变化，较新结果已保留。');
                await this.storage.set(id,response.bundle);
            }
            if(chatKey(this.getContext())!==key)return response;
            const fresh=captureMessages(this.getContext(),options);
            if(signature(fresh)!==stamp){this.onUpdate({status:'检测到请求期间聊天变化，正在按最新内容重算。',pending:true});return {stale:true};}
            this.materials.set(id,response.materials??{});this.packets.set(id,response.packet??'');this.onUpdate(response);return response;
        });
        this.owners.set(id,task);try{const result=await task;if(result?.stale)return this.run(options);return result;}finally{if(this.owners.get(id)===task)this.owners.delete(id);}
    }
    async beforeGeneration(type,abort){
        const c=this.getContext();if(!this.enabled(c)||type==='quiet'||type==='impersonate')return;
        const key=chatKey(c);this.generating.set(key,true);
        try{
            const result=await this.run({omitLastAssistant:['swipe','regenerate','continue'].includes(type)});
            if(result?.materials_error)throw Error('正文和结算已保存，但材料配置需要修复：'+result.materials_error.message);
            if(chatKey(this.getContext())!==key)throw Error('同步期间已切换聊天，请在目标聊天重新生成。');
            await this.inject();
        }catch(e){c.setExtensionPrompt?.(PROMPT_KEY,'',0,0,false,0);this.generating.delete(key);abort?.(true);throw e;}
    }
    async inject(){
        const ctx=this.getContext();if(!this.enabled(ctx)){ctx.setExtensionPrompt?.(PROMPT_KEY,'',0,0,false,0);return;}
        if(this.settings().mode==='packet')ctx.setExtensionPrompt(PROMPT_KEY,this.packets.get(ctx.chatMetadata?.[NS]?.chat_uid)??'',1,0,false,0);
        else ctx.setExtensionPrompt(PROMPT_KEY,'',0,0,false,0);
    }
    async event(name,...args){
        const ctx=this.getContext(),key=chatKey(ctx);
        if(name==='CHAT_CHANGED'){
            ctx.setExtensionPrompt?.(PROMPT_KEY,'',0,0,false,0);
            if(this.enabled(ctx)){await this.run();await this.inject();}return;
        }
        if(!this.enabled(ctx))return;
        if(name==='MESSAGE_RECEIVED'&&ctx.streamingProcessor&&!ctx.streamingProcessor.isFinished&&!ctx.streamingProcessor.isStopped)return;
        if(['GENERATION_STOPPED','GENERATION_ENDED','MESSAGE_RECEIVED'].includes(name))this.generating.delete(key);
        if(this.generating.get(key)&&!['GENERATION_STOPPED','GENERATION_ENDED','MESSAGE_RECEIVED'].includes(name))return;
        await this.run();await this.inject();
    }
    macro(name){const ctx=this.getContext(),id=ctx.chatMetadata?.[NS]?.chat_uid;return this.enabled(ctx)?this.materials.get(id)?.[name]??'':'';}
}

export function indexedStorage(indexedDB){
    const db=new Promise((resolve,reject)=>{const r=indexedDB.open('tisya-engine-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('chats');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    async function transact(mode,fn){const d=await db;return new Promise((resolve,reject)=>{const tx=d.transaction('chats',mode),s=tx.objectStore('chats');let value;const r=fn(s);r.onsuccess=()=>{value=r.result;};r.onerror=()=>reject(r.error);tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??Error('本地保存已中断'));});}
    async function commit(key,expected,value){
        const d=await db;
        return new Promise((resolve,reject)=>{
            const tx=d.transaction('chats','readwrite'),s=tx.objectStore('chats');let committed=false;
            const read=s.get(key);read.onsuccess=()=>{if((read.result?.local_revision??0)!==expected)return;s.put(value,key);committed=true;};
            tx.oncomplete=()=>resolve(committed);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??Error('状态保存已中断'));
        });
    }
    return {get:key=>transact('readonly',s=>s.get(key)),set:(key,v)=>transact('readwrite',s=>s.put(v,key)),commit};
}
