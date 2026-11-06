import {scopeOf,nativeStore,copy} from './services.mjs';
import {composeCreativeRequest,assertRevisionTarget,candidateState} from './creative.mjs';
import {prepareWorkspaceBinding} from './workspace-binding.mjs';
export async function createHost(global=globalThis){
  const tt=global.__TAURITAVERN__;if(!tt?.api?.extension?.store)throw Error('需要提供 extension.store 的现行 TauriTavern；没有启动旧存储回退。');
  await tt.ready;
  const [script,personas,presets,bookmarks,openai,groups]=await Promise.all([import('/script.js'),import('/scripts/personas.js'),import('/scripts/preset-manager.js'),import('/scripts/bookmarks.js'),import('/scripts/openai.js'),import('/scripts/group-chats.js')]);
  const ctx=()=>global.SillyTavern.getContext();
  if(!ctx().messageFormatter?.addHook)throw Error('此宿主缺少现行消息格式化接口。');
  const host={
    context:ctx,scope:()=>scopeOf(ctx()),store:nativeStore(tt.api.extension.store),
    async prepareWorkspace(){
      return prepareWorkspaceBinding(ctx());
    },
    workspaceParent:key=>key===host.scope()?ctx().chatMetadata.tisya_chat?.parent:null,
    cards:()=>ctx().characters.map((c,id)=>({id,name:c.name,avatar:c.avatar})),
    groups:()=>ctx().groups,
    thumbnail:(type,file)=>ctx().getThumbnailUrl(type,file),
    async chats(card){const response=await fetch('/api/characters/chats',{method:'POST',headers:ctx().getRequestHeaders(),body:JSON.stringify({avatar_url:card.avatar})});if(!response.ok)throw Error(`会话读取失败 HTTP ${response.status}`);const data=await response.json();if(data.error)throw Error('宿主返回会话读取错误');return Object.values(data);},
    async open(card,file){await ctx().selectCharacterById(card.id);if(file)await ctx().openCharacterChat(file.replace(/\.jsonl$/,''));},
    async newChat(){await script.doNewChat();},
    async openGroup(id,file){await ctx().openGroupChat(id,file);},
    async newGroupChat(id){await groups.createNewGroupChat(id);},
    identity:()=>({name:ctx().name1,avatar:personas.user_avatar,description:ctx().powerUserSettings.persona_description}),
    identities:()=>Object.entries(ctx().powerUserSettings.personas).map(([id,name])=>({id,name,description:ctx().powerUserSettings.persona_descriptions[id]?.description??''})),
    async selectIdentity(id,lock){await personas.setUserAvatar(id);if(lock)await personas.setPersonaLockState(true,'chat');},
    presetManager:()=>presets.getPresetManager('openai'),
    currentPreset:()=>openai.getChatCompletionPreset(),
    async selectPreset(name){const p=host.presetManager();const id=p.findPreset(name);if(id===undefined)throw Error('预设不存在。');await p.selectPreset(id);},
    async savePreset(name,data){await host.presetManager().savePreset(name,data);},
    async captureCreativeContext(text,{endIndex=null}={}){
      await host.beforeCreativeContext?.();const scope=host.scope();if(!scope)throw Error('请先打开会话。');
      const c=ctx();if(c.groupId)await c.unshallowGroupMembers(c.groupId);else await c.unshallowCharacter(c.characterId);
      if(scope!==host.scope())throw Error('读取资料时会话已切换。');
      const group=c.groups.find(g=>String(g.id)===String(c.groupId));
      const actors=(group?group.members.map(a=>c.characters.find(x=>x.avatar===a)):[c.characters[c.characterId]]).filter(Boolean).map(x=>({name:x.name,avatar:x.avatar,description:x.description,personality:x.personality,scenario:x.scenario,examples:x.mes_example,system:x.data?.system_prompt,post_history:x.data?.post_history_instructions}));
      const history=c.chat.slice(0,endIndex===null?undefined:endIndex+1).map((m,index)=>({m,index})).filter(({m})=>!m.extra?.isExcluded).map(({m,index})=>({index,name:m.name,role:m.is_user?'user':m.is_system?'system':'assistant',text:m.mes}));
      const persona=host.identity();const fields=c.getCharacterCardFields();
      const world=await c.getWorldInfoPrompt([text,...history.map(x=>x.text).reverse()],c.maxContext,true,{personaDescription:persona.description,characterDescription:fields.description??'',characterPersonality:fields.personality??'',characterDepthPrompt:fields.charDepthPrompt??'',scenario:fields.scenario??'',creatorNotes:fields.creatorNotes??'',trigger:'quiet'});
      let engine={enabled:false};
      if(c.chatMetadata.tisya_engine?.enabled){if(!global.TisyaEngine?.captureContext)throw Error('当前聊天已启用引擎，但材料服务尚未就绪。');engine=await global.TisyaEngine.captureContext();}
      if(scope!==host.scope())throw Error('读取资料时会话已切换。');
      const preset=host.currentPreset(),order=openai.promptManager.getPromptOrderForCharacter(openai.promptManager.activeCharacter);
      const consumed=new Set();
      const contract=order.filter(x=>x.enabled).map(x=>preset.prompts.find(p=>p.identifier===x.identifier)).filter(p=>p&&!p.marker).map(p=>{for(const match of (p.content??'').matchAll(/\{\{(tisya_[a-z_]+)\}\}/g))consumed.add(match[1]);return {id:p.identifier,name:p.name,role:p.role,text:openai.promptManager.preparePrompt(p).content};});
      engine={...engine,materials:Object.fromEntries(Object.entries(engine.materials??{}).filter(([key])=>!consumed.has(key)))};delete engine.packet;
      return {scope,at:new Date().toISOString(),persona,actors,group:group?{id:group.id,name:group.name,members:group.members}:null,contract,world:{before:world.worldInfoBefore,after:world.worldInfoAfter,examples:world.worldInfoExamples,depth:world.worldInfoDepth,anBefore:world.anBefore,anAfter:world.anAfter,outlets:world.outletEntries,activation:world.worldInfoActivation?{...world.worldInfoActivation,entries:world.worldInfoActivation.entries.map(({content,...entry})=>entry)}:null},engine,history};
    },
    async talk(text,history,options={}){const snapshot=await host.captureCreativeContext(text);if(options.scope&&snapshot.scope!==options.scope)throw Error('场外请求的会话已切换。');options.onContext?.({at:snapshot.at,scope:snapshot.scope,messages:snapshot.history.length,actors:snapshot.actors.length,engine:snapshot.engine.enabled,worldEntries:snapshot.world.activation?.entries?.length??0,bytes:JSON.stringify(snapshot).length});return ctx().generateRaw({...composeCreativeRequest(snapshot,text,history),api:'openai',trimNames:false});},
    async revise(target,note){assertRevisionTarget(target,host.scope(),ctx().chat[target.index]);const snapshot=await host.captureCreativeContext(note,{endIndex:target.index});return ctx().generateRaw({...composeCreativeRequest(snapshot,note,[],{mode:'revision',target:{floor:target.index,original:target.source,selected:target.selected,start:target.start,end:target.end}}),api:'openai',trimNames:false});},
    async applyRevision(target,text,meta){assertRevisionTarget(target,host.scope(),ctx().chat[target.index]);await script.hydrateChatMessageSwipes(target.index);assertRevisionTarget(target,host.scope(),ctx().chat[target.index]);const next=candidateState(ctx().chat[target.index],text,meta);Object.assign(ctx().chat[target.index],next);script.syncSwipeToMes(target.index,next.swipe_id);ctx().updateMessageBlock(target.index,ctx().chat[target.index]);await script.updateSwipeCounter(target.index);await ctx().saveChat();await ctx().eventSource.emit(ctx().eventTypes.MESSAGE_SWIPED,target.index);return next.swipe_id;},
    async selectCandidate(index,swipeId){await script.hydrateChatMessageSwipes(index);const m=ctx().chat[index];if(!m||typeof m.swipes?.[swipeId]!=='string')throw Error('候选不存在。');script.syncSwipeToMes(index,swipeId);ctx().updateMessageBlock(index,m);await script.updateSwipeCounter(index);await ctx().saveChat();await ctx().eventSource.emit(ctx().eventTypes.MESSAGE_SWIPED,index);}
,
    async send(text){const input=document.querySelector('#send_textarea');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));return ctx().generate('normal');},
    async reroll(note){ctx().setExtensionPrompt('tisya_segment_revision',note,1,0,false,0);try{return await ctx().generate('swipe');}finally{ctx().setExtensionPrompt('tisya_segment_revision','',1,0,false,0);}},
    async branch(index){return bookmarks.branchChat(index);},
    stop:()=>ctx().stopGeneration(),
    variables(index){if(!global.TavernHelper?.getVariables)throw Error('酒馆助手变量接口尚未就绪。');return global.TavernHelper.getVariables({type:'message',message_id:index});},
    capabilities:()=>({helper:typeof global.TavernHelper?.getVariables==='function',mvu:typeof global.Mvu==='object',chatSurface:tt.api.chatSurface?.protocolVersion,formatter:!!ctx().messageFormatter?.addHook}),
    on(name,handler){const c=ctx(),event=c.eventTypes[name];if(!event)throw Error('宿主事件不可用：'+name);c.eventSource.on(event,handler);return()=>c.eventSource.removeListener(event,handler);}
  };return host;
}
