import {copy} from './services.mjs';

export function composeCreativeRequest(snapshot,text,history=[],{mode='talk',target=null}={}){
  const systemPrompt=mode==='talk'
    ?'你是缇斯亚，与契约者讨论当前创作。当前为场外交流：根据所附当前资料回答问题、讨论人物与情节；不自动推进剧情，不生成变量或引擎结算指令。资料中的正文交付协议作为参考，当前交流按自然语言回应。保留你自己的判断。'
    :'你是缇斯亚，执行契约者对指定回复的修订。当前资料是创作依据。只输出指定范围的替换文本，不输出说明或外层代码围栏。整条修订遵循原回复协议；片段修订只输出该片段，其他内容由程序逐字保留。';
  const prompt=[{role:'user',content:'当前创作资料（带来源；未绑定的引擎不代表存在空白世界）：\n'+JSON.stringify(snapshot)}];
  if(mode==='talk')for(const turn of history){if(turn.status&&turn.status!=='done')continue;if(turn.assistant){prompt.push({role:'user',content:turn.user},{role:'assistant',content:turn.assistant});}}
  prompt.push({role:'user',content:mode==='talk'?text:'修订目标：\n'+JSON.stringify(target)+'\n修改要求：\n'+text});
  return {systemPrompt,prompt};
}

export function revisionTarget({scope,index,message,selection='',start=null,end=null}){
  if(!message||message.is_user||message.is_system)throw Error('请选择一条角色回复。');
  const source=String(message.mes??'');
  if(selection&&start===null){start=source.indexOf(selection);if(start<0||source.indexOf(selection,start+1)>=0)throw Error('选段与原文不能唯一对应，请在原文框中重新选择。');end=start+selection.length;}
  if(start===null){start=0;end=source.length;}
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>source.length)throw Error('选段范围无效。');
  return {scope,index,source,swipe:message.swipe_id??0,start,end,selected:source.slice(start,end)};
}
export function revisedSource(target,replacement){
  if(typeof replacement!=='string'||!replacement.trim())throw Error('模型返回了空修订，原回复未改变。');
  return target.source.slice(0,target.start)+replacement+target.source.slice(target.end);
}
export function assertRevisionTarget(target,scope,message){
  if(scope!==target.scope||!message||message.mes!==target.source||(message.swipe_id??0)!==target.swipe)throw Error('目标会话、楼层或候选已经变化；生成结果已保留在修订记录，未覆盖当前内容。');
}
export function candidateState(message,text,meta={}){
  const next=copy(message),old=next.swipe_id??0;
  next.swipes??=[next.mes];next.swipe_info??=[];
  while(next.swipe_info.length<next.swipes.length)next.swipe_info.push({send_date:next.send_date,extra:{}});
  next.swipes[old]=next.mes;
  next.swipe_info[old]={...(next.swipe_info[old]??{}),send_date:next.send_date,gen_started:next.gen_started,gen_finished:next.gen_finished,extra:copy(next.extra??{})};
  next.swipes.push(text);
  next.swipe_info.push({send_date:next.send_date,gen_started:meta.started,gen_finished:meta.finished,extra:{...copy(next.extra??{}),tisya_revision:meta}});
  next.swipe_id=next.swipes.length-1;
  return next;
}

export class Revision {
  constructor({host,workspace,onChange=()=>{}}){Object.assign(this,{host,workspace,onChange});}
  async run(target,note){
    const release=this.workspace.pin(target.scope);let row,record;
    try{
      row=await this.workspace.load(target.scope);
      record={id:crypto.randomUUID(),target:copy(target),note,status:'running',at:new Date().toISOString()};
      row.revisions??=[];row.revisions.push(record);
      await this.workspace.save(target.scope);this.onChange();
      record.replacement=await this.host.revise(target,note);
      record.result=revisedSource(target,record.replacement);
      // Keep model output even when the captured target changed during generation.
      record.status='generated';await this.workspace.save(target.scope);
      record.candidate=await this.host.applyRevision(target,record.result,{started:record.at,finished:new Date().toISOString(),note,start:target.start,end:target.end});
      record.status='done';await this.workspace.save(target.scope);return record;
    }catch(error){if(record){record.status=record.result?'unapplied':'failed';record.error=error.message;try{await this.workspace.save(target.scope);}catch(saveError){throw new AggregateError([error,saveError],`${error.message}；修订记录保存失败：${saveError.message}`);}}throw error;}
    finally{release();this.onChange();}
  }
}
