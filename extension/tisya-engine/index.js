import {Controller,indexedStorage,NS,PROMPT_KEY} from './core.mjs';
const getContext=()=>SillyTavern.getContext();
let box,controller;
function status(message,bad=false){if(!box)return;const e=box.querySelector('.tisya-status');e.textContent=message;e.classList.toggle('tisya-error',bad);}
function update(r){
    if(r.status){status(r.status);return;}
    const result=r.result??{},warnings=result.warnings??[];
    status(`已同步；回退 ${result.rewound??0} 条，处理 ${result.processed??0} 条。`);
    const area=box.querySelector('.tisya-warnings');area.replaceChildren();
    for(const w of warnings){const li=document.createElement('div');li.className='tisya-warning';const floor=getContext().chat.findIndex(m=>m.extra?.[NS]?.uid===w.message_uid);li.textContent=`${floor>=0?'第'+(floor+1)+'楼':w.message_uid??''} ${w.line_number?'第'+w.line_number+'行 ':''}[${w.code??w.error?.code??'WARNING'}] ${w.message??''}${w.error?'；'+w.error.code+'：'+w.error.message:''}`;if(w.original)li.title=w.original;area.append(li);}
    box.querySelector('.tisya-materials').textContent=r.packet??'';
}
async function request(path,body){
    const endpoint=controller.settings().endpoint.replace(/\/$/,'');
    const u=new URL(endpoint);if(!['http:','https:'].includes(u.protocol))throw Error('引擎地址需要http或https。');
    const response=await fetch(endpoint+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    const r=await response.json();if(!response.ok||!r.ok)throw Error(`[${r.error?.code??response.status}] ${r.error?.message??'引擎请求失败'}`);return r;
}
async function action(fn){try{await fn();}catch(e){status(e.message,true);console.error('[Tisya]',e);globalThis.toastr?.error(e.message,'缇斯亚引擎');}}
function download(name,value){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function mount(){
    box=document.createElement('section');box.className='tisya-engine-settings';
    box.innerHTML=`<details><summary>缇斯亚 · 引擎与回合记忆</summary><p>连接同包 Python 伴随引擎；每个聊天独立保存。导入现有状态后，从下一条回复开始结算。</p><label>引擎地址<input class="text_pole tisya-endpoint" placeholder="http://127.0.0.1:8765"></label><label>材料方式<select class="text_pole tisya-mode"><option value="macros">原69槽预设宏</option><option value="packet">单次六阶材料注入</option></select></label><div class="tisya-buttons"><button class="menu_button tisya-connect">检查连接</button><button class="menu_button tisya-blank">绑定空白引擎</button><button class="menu_button tisya-import">导入状态/聊天备份</button><button class="menu_button tisya-sync">同步当前聊天</button><button class="menu_button tisya-export">导出完整备份</button><button class="menu_button tisya-state">导出状态给沙盒</button><button class="menu_button tisya-toggle">启用/暂停当前聊天</button></div><input class="tisya-file" type="file" accept=".json,application/json" hidden><p class="tisya-status" role="status">尚未连接。请先启动 plugin_server.py。</p><div class="tisya-warnings" aria-live="polite"></div><details><summary>本轮实际材料</summary><pre class="tisya-materials"></pre></details></details>`;
    const target=document.querySelector('#extensions_settings2')??document.querySelector('#extensions_settings');
    if(!target)throw Error('未找到酒馆扩展设置区。');target.append(box);
    const settings=controller.settings(),endpoint=box.querySelector('.tisya-endpoint'),mode=box.querySelector('.tisya-mode');endpoint.value=settings.endpoint;mode.value=settings.mode;
    endpoint.addEventListener('change',()=>{settings.endpoint=endpoint.value.trim();getContext().saveSettingsDebounced();});
    mode.addEventListener('change',()=>action(async()=>{settings.mode=mode.value;getContext().saveSettingsDebounced();await controller.inject();}));
    box.querySelector('.tisya-connect').onclick=()=>action(async()=>{const r=await request('/api/plugin/health');status(`连接正常：${r.version}，${r.tables} 张逻辑表。`);});
    box.querySelector('.tisya-blank').onclick=()=>action(async()=>{const r=await request('/api/blank');await controller.attach({state:r.state});await controller.run();});
    const file=box.querySelector('.tisya-file');box.querySelector('.tisya-import').onclick=()=>file.click();
    file.onchange=()=>action(async()=>{const f=file.files[0];if(!f)return;const raw=JSON.parse(await f.text());await controller.attach(raw.state?raw:{state:raw});file.value='';await controller.run();await controller.inject();});
    box.querySelector('.tisya-sync').onclick=()=>action(async()=>{await controller.run();await controller.inject();});
    box.querySelector('.tisya-export').onclick=()=>action(async()=>{const bundle=await controller.current();if(!bundle)throw Error('当前聊天还没有引擎。');download('tisya-chat-backup.json',bundle);});
    box.querySelector('.tisya-state').onclick=()=>action(async()=>{const bundle=await controller.current();if(!bundle)throw Error('当前聊天还没有引擎。');download('tisya-state.json',bundle.state);});
    box.querySelector('.tisya-toggle').onclick=()=>action(async()=>{const {ctx}=await controller.identity();ctx.chatMetadata[NS].enabled=!ctx.chatMetadata[NS].enabled;await ctx.saveMetadata();await controller.inject();status(ctx.chatMetadata[NS].enabled?'当前聊天已启用。':'当前聊天已暂停。');});
}
function registerMacros(){
    const ctx=getContext();const names=['tisya_contractor_wish',...['boundary_open','style_card','rule_material','world_context','faction_context','asset_context','location_context','current_state','offstage_state','pending_tasks','player_archive','persona_extensions','card_extensions','cardflow','display_material','cast_registry','focus_entities','present_entities','character_archives','habit_anchors','knowledge_material','secret_material','memory_archive','memory_summary','memory_excerpt','event_context','cell_prompts','calculation_result','task_analysis','external_evidence','task_material','tool_prompt','tool_calls','tool_result','boundary_close'].map(x=>'tisya_material_'+x)];
    for(const name of names){
        const handler=()=>controller.settings().mode==='macros'?controller.macro(name):'';
        ctx.macros.register(name,{handler,description:'缇斯亚实际引擎材料'});
    }
}
async function init(){
    controller=new Controller({getContext,storage:indexedStorage(indexedDB),request,onUpdate:update});mount();registerMacros();
    globalThis.TisyaEngine={async captureContext(){
        const ctx=getContext(),key=ctx.chatId;if(!controller.enabled())return {enabled:false};
        const response=await controller.run();
        if(response?.materials_error)throw Error('材料读取失败：'+response.materials_error.message);
        if(getContext().chatId!==key)throw Error('材料读取期间会话已切换。');
        await controller.inject();
        return {enabled:true,materials:structuredClone(response?.materials??{}),packet:response?.packet??'',warnings:structuredClone(response?.result?.warnings??[])};
    }};
    globalThis.tisyaEngineBeforeGenerate=async(_chat,_contextSize,abort,type)=>{
        try{await controller.beforeGeneration(type,abort);}catch(e){status('生成前同步失败：'+e.message,true);globalThis.toastr?.error(e.message,'缇斯亚引擎');throw e;}
    };
    const {eventSource,eventTypes}=getContext();
    for(const name of ['MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_SWIPED','MESSAGE_SWIPE_DELETED','GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED']){
        if(eventTypes[name])eventSource.on(eventTypes[name],(...args)=>action(()=>controller.event(name,...args)));
    }
    if(controller.enabled())await action(async()=>{await controller.run();await controller.inject();});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>action(init),{once:true});else action(init);
