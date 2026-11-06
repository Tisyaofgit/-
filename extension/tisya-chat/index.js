import {Workspace,Conversation,scopeOf} from './services.mjs';
import {createHost} from './host.mjs';
import {projectReply,projectionCache} from './projection.mjs';
import {registerFrontend,frontendReport} from './frontend.mjs';
import {mountShell} from './ui.mjs';
import {extension_settings} from '/scripts/extensions.js';

// One renderer owns message frontends. Helper's script/MVU settings are untouched.
extension_settings.tavern_helper??={};
extension_settings.tavern_helper.render??={};
extension_settings.tavern_helper.render.enabled=false;
extension_settings.code_render??={};extension_settings.code_render.enabled=false;

let host,workspace,shell,registration,initialization,formatterInstalled=false,currentNarrative={},pendingDirection=null;
const errors=[];
function report(error){const prior=errors.at(-1);if(prior?.message===error.message){prior.repeats=(prior.repeats??1)+1;return;}errors.push({at:new Date().toISOString(),message:error.message,stack:error.stack});if(errors.length>80)errors.shift();console.error('[Tisya Chat]',error);globalThis.toastr?.error(error.message,'缇斯亚');}
function format(){
  if(formatterInstalled)return;
  const ctx=SillyTavern.getContext(),formatter=ctx.messageFormatter;
  if(!formatter?.addHook)throw Error('需要现行 MessageFormatter 接口；未启用旧渲染。');
  formatter.addHook((text,meta)=>meta.isUser||meta.isSystem||meta.isReasoning?text:projectReply(text,{key:scopeOf(SillyTavern.getContext())+':'+meta.messageId,streaming:!!SillyTavern.getContext().streamingProcessor&&!SillyTavern.getContext().streamingProcessor.isFinished}),{stage:formatter.stage.AFTER_REGEX,order:formatter.order.LATE});
  formatterInstalled=true;
}
export function registerChatSurface(){
  if(registration)return;
  format();registration=registerFrontend(globalThis.__TAURITAVERN__?.api?.chatSurface,{onError:report});
}
async function refreshNarrative(){currentNarrative=await shell.narrative();}
async function initialize(){
  host=await createHost();
  if(globalThis.__TAURITAVERN__.api.chatSurface?.protocolVersion!==1)throw Error('此宿主缺少 ChatSurface v1，请更新 TauriTavern 后再启用缇斯亚前端。');
  if(globalThis.__TAURITAVERN__.api.chatSurface?.isManagedOwnershipRequired()!==true){
    const {updateTauriTavernSettings}=await import('/tauri-bridge.js');
    await updateTauriTavernSettings({chat_virtualization_enabled:true});
    host.context().saveSettingsDebounced();location.reload();return;
  }
  if(!registration)throw Error('缇斯亚前端没有在宿主投影前注册，请完整重启宿主。');
  workspace=new Workspace(host.store,{onError:report,parentOf:scope=>host.workspaceParent(scope)});
  const conversation=new Conversation({host,workspace,onChange:()=>shell?.refresh().catch(report)});
  shell=await mountShell({host,workspace,conversation,onError:report});format();
  const res=await fetch(new URL('narrative-schema.json',import.meta.url));if(!res.ok)throw Error('叙事槽目录读取失败');
  const schema=await res.json();await refreshNarrative();host.beforeCreativeContext=refreshNarrative;
  for(const item of schema)host.context().macros.register(item.id,{handler:()=>currentNarrative[item.id]??item.content,description:item.label});
  host.on('CHAT_CHANGED',async()=>{pendingDirection=null;host.context().setExtensionPrompt('tisya_turn_direction','',1,0,false,0);await refreshNarrative();});
  host.on('GENERATION_AFTER_COMMANDS',async(type,options,dryRun)=>{
    if(dryRun||['quiet','impersonate'].includes(type))return;
    await refreshNarrative();
    const ctx=host.context(),scope=host.scope(),row=await workspace.load(scope);
    const previous=[...ctx.chat].reverse().find(m=>m.is_user);
    const note=['swipe','regenerate','continue'].includes(type)?previous?.extra?.tisya_direction??'':row.note;
    pendingDirection={scope,note,type};
    ctx.setExtensionPrompt('tisya_turn_direction',note?'[本轮契约者要求]\n'+note+'\n[/本轮契约者要求]':'',1,0,false,0);
  });
  host.on('MESSAGE_SENT',async(index)=>{
    const bound=pendingDirection,ctx=host.context();if(!bound||bound.scope!==host.scope()||!bound.note)return;
    const message=ctx.chat[index];message.extra??={};message.extra.tisya_direction=bound.note;await ctx.saveChat();
    const row=await workspace.load(bound.scope);if(row.note===bound.note)row.note='';await workspace.save(bound.scope);await shell.refresh();
  });
  for(const name of ['GENERATION_ENDED','GENERATION_STOPPED'])host.on(name,()=>{pendingDirection=null;host.context().setExtensionPrompt('tisya_turn_direction','',1,0,false,0);});
  host.context().saveSettingsDebounced();
  globalThis.TisyaChat={show:shell.show,captureContext:(text,options)=>host.captureCreativeContext(text,options),report:()=>({errors,cache:projectionCache.report(),workspace:workspace.report(),frontend:frontendReport(),host:host.capabilities()}),flush:()=>workspace.flush()};
}
function start(){if(!initialization)initialization=initialize().catch(error=>{report(error);const p=document.createElement('p');p.className='tisya-start-error';p.textContent='缇斯亚未启动：'+error.message;document.body.append(p);});return initialization;}
const ctx=globalThis.SillyTavern?.getContext();
if(ctx)ctx.eventSource.on(ctx.eventTypes.APP_READY,start);
