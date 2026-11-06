"""Stateless host reconciliation with per-message inverse patches (no schema copies per turn)."""
from __future__ import annotations
import copy, hashlib, re
from matrix_io import EngineError
from tisya_runtime import Runtime, digest
from reply_memory import accept_reply, materials
from material_text import funnel_packet


def inverse_patch(before,after,path=()):
    if before==after:return []
    if isinstance(before,dict) and isinstance(after,dict):
        out=[]
        for k in sorted(before.keys()|after.keys(),key=str):
            p=list(path)+( [k] )
            if k not in before:out.append({'op':'remove','path':p})
            elif k not in after:out.append({'op':'set','path':p,'value':copy.deepcopy(before[k])})
            else:out.extend(inverse_patch(before[k],after[k],p))
        return out
    if isinstance(before,list) and isinstance(after,list):
        common=0
        while common<min(len(before),len(after)) and before[common]==after[common]:common+=1
        if common==len(before):return [{'op':'truncate','path':list(path),'length':len(before)}]
        if len(before)==len(after):
            return [op for i in range(common,len(before)) for op in inverse_patch(before[i],after[i],list(path)+[i])]
        return [{'op':'splice','path':list(path),'index':common,'remove':len(after)-common,'items':copy.deepcopy(before[common:])}]
    return [{'op':'set','path':list(path),'value':copy.deepcopy(before)}]


def rewind_patch(state,ops):
    for op in reversed(ops):
        path=op['path'];parent=state
        for k in path[:-1]:parent=parent[k]
        if not path:
            if op['op']!='set':raise EngineError('SNAPSHOT_PATCH','Invalid root patch')
            state=copy.deepcopy(op['value']);continue
        key=path[-1]
        if op['op']=='remove':parent.pop(key,None)
        elif op['op']=='set':parent[key]=copy.deepcopy(op['value'])
        elif op['op']=='truncate':del parent[key][op['length']:]
        elif op['op']=='splice':parent[key][op['index']:op['index']+op['remove']]=copy.deepcopy(op['items'])
    return state


def reconcile(bundle,messages,scope=None):
    if not isinstance(bundle,dict) or not isinstance(bundle.get('state'),dict):raise EngineError('CHAT_BUNDLE','Import an engine state first')
    state=copy.deepcopy(bundle['state']);journal=copy.deepcopy(bundle.get('journal') or {'entries':[],'revision_by_uid':{}});entries=journal.setdefault('entries',[]);revisions=journal.setdefault('revision_by_uid',{})
    identities=[m.get('uid') for m in messages]
    if any(not isinstance(x,str) or not x for x in identities) or len(set(identities))!=len(identities):raise EngineError('MESSAGE_IDENTITY','Every host message needs a unique stable UID')
    scope=scope or journal.get('scope') or state.get('runtime',{}).get('scope',{});branch=scope.get('branch_ref','main')
    old_scope=journal.get('scope')
    if old_scope and old_scope!=scope:raise EngineError('CHAT_SCOPE_CHANGED','Import/fork explicitly to change a chat scope',previous=old_scope,requested=scope)
    journal['scope']=copy.deepcopy(scope);state.setdefault('runtime',{})['scope']=copy.deepcopy(scope)
    desired=[dict(m,signature=digest({'role':m.get('role'),'text':m.get('text',''),'uid':m['uid']})) for m in messages]
    baseline={m['uid']:m for m in journal.get('baseline_messages',[])}
    for entry in entries:
        if entry.get('baseline') and entry.get('signature') is None:
            bm=baseline.get(entry['uid'],{});entry['signature']=digest({'role':bm.get('role'),'text':bm.get('text',''),'uid':entry['uid']})
    common=0
    while common<min(len(entries),len(desired)) and entries[common]['uid']==desired[common]['uid'] and entries[common]['signature']==desired[common]['signature']:common+=1
    rewound=len(entries)-common
    for entry in reversed(entries[common:]):state=rewind_patch(state,entry['pre_turn_snapshot']['inverse_patch'])
    entries=entries[:common];journal['entries']=entries;reports=[];warnings=[]
    for m in desired[common:]:
        before=copy.deepcopy(state);e=Runtime(state);uid=m['uid'];revision=int(revisions.get(uid,0))+1;revisions[uid]=revision;result=None;turn_warnings=[]
        if uid in baseline:
            if m['signature']!=digest({'role':baseline[uid].get('role'),'text':baseline[uid].get('text',''),'uid':uid}):turn_warnings.append({'code':'BASELINE_HISTORY_CHANGED','message':'此楼属于导入前历史；没有当时状态快照，未重复结算其指令。需要时导入对应历史状态。'})
        elif m.get('role')=='assistant' and m.get('text','').strip():
            raw=m['text'];text=raw
            if not re.search(r'<(?:reply|cells)\b',raw,re.I):
                # Plain host replies still enter exact-source memory. No commands
                # are inferred from prose and the wrapper is explicitly recorded.
                text='<reply><body>'+raw+'</body></reply>';turn_warnings.append({'code':'HOST_BODY_WRAPPED','message':'宿主普通正文已加解析外壳；未从散文推断状态指令'})
            try:
                result=accept_reply(e,text,uid,revision,branch)
                if result['status']=='FAILED':turn_warnings.append(result['error'])
                else:
                    receipt=result.get('receipt',result);data=receipt.get('result',{});turn_warnings.extend(data.get('warnings',[]))
                    source=e.data['runtime']['sources'].get(data.get('source_key'))
                    if source is not None:source['host_message_sha256']=hashlib.sha256(raw.encode()).hexdigest();source['host_message_source_field']='reply_raw' if text==raw else 'body_raw'
            except Exception as exc:
                error=exc.as_dict() if isinstance(exc,EngineError) else {'code':'HOST_REPLY_ERROR','message':str(exc)}
                turn_warnings.append(error);e.data['runtime'].setdefault('host_rejected',{})[uid]={'text':raw,'sha256':hashlib.sha256(raw.encode()).hexdigest(),'revision':revision,'error':error}
                result={'status':'FAILED','error':error}
        # Clock selection is a read-side cache mutation. Capture it before the
        # inverse snapshot, including a newly created clock's selected ID.
        if e.data['runtime'].get('calendar') or e.rows('X_WORLD_CLOCKS'):
            try:e._clock()
            except EngineError as exc:turn_warnings.append({'code':'MATERIALS_CONFIG','message':'正文已保留；历法配置需要修复','error':exc.as_dict()})
        state=e.data
        for w in turn_warnings:warnings.append(dict(w,message_uid=uid,revision=revision))
        entry={'uid':uid,'signature':m['signature'],'role':m.get('role'),'revision':revision,'pre_turn_snapshot':{'format':'tisya.inverse-patch.v1','inverse_patch':inverse_patch(before,state)},'warnings':turn_warnings,'settlement_status':result.get('status') if result else 'CONTEXT_ONLY'}
        entries.append(entry);reports.append({'uid':uid,'revision':revision,'status':entry['settlement_status'],'warnings':turn_warnings})
    e=Runtime(state);material_error=None
    try:slots=materials(e,scope)
    except Exception as exc:
        material_error=exc.as_dict() if isinstance(exc,EngineError) else {'code':'MATERIALS_ERROR','message':str(exc)};slots={}
    all_warnings=[dict(w,message_uid=x['uid'],revision=x['revision']) for x in entries for w in x.get('warnings',[])]
    return {'ok':True,'bundle':{'format':'tisya.chat-bundle.v1','state':e.data,'journal':journal,**({'detached_journals':copy.deepcopy(bundle['detached_journals'])} if bundle.get('detached_journals') else {})},'materials':slots,'packet':funnel_packet(slots),'materials_error':material_error,'result':{'common_prefix':common,'rewound':rewound,'processed':len(reports),'turns':reports,'warnings':journal.get('notices',[])+all_warnings+([{'code':'MATERIALS_ERROR','message':'结算和正文已保存；材料组装失败，生成前需修复','error':material_error}] if material_error else []),'replayed_descendants':max(0,len(reports)-1) if rewound else 0}}
