"""Model-friendly business appends. All writes run inside the caller's line transaction."""
import hashlib, json, re, uuid
from matrix_io import EngineError


def _ref(e,tid,value):
    if value in ('','~','?'):return None
    if value in e.rows(tid):return value
    matches=[rid for rid,r in e.rows(tid).items() if value in [r['values'].get(k) for k in ['short_code','name','title']]]
    if len(matches)==1:return matches[0]
    aliases=e.data['runtime'].get('business_aliases',{});key=tid+'|'+value
    if key in aliases:return aliases[key]
    raise EngineError('BUSINESS_REFERENCE','引用对象不存在或名称不唯一',table=tid,value=value)


def _entity(e,value):
    try:return _ref(e,'T_SYS_ENTITIES',value)
    except EngineError:
        rid=_ref(e,'T_CHAR_DOSSIER',value)
        if rid not in e.rows('T_SYS_ENTITIES'):
            e.new_record('T_SYS_ENTITIES',{'name':e.rows('T_CHAR_DOSSIER')[rid]['values'].get('name',rid),'kind':'character','origin_record_ref':{'table_id':'T_CHAR_DOSSIER','record_id':rid}},rid)
        return rid


def append_business(e,kind,raw,ctx=None):
    ctx=ctx or {};raw=raw if raw.startswith('{') else raw.replace('｜','|');parts=[p.strip() for p in raw.split('|')];tid={'EVENTS':'T_DYN_EVENTS','ANCHORS':'T_CHAR_ANCHORS','PACTS':'T_DYN_PACTS'}[kind]
    if raw.startswith('{'):
        payload=json.loads(raw);values=payload.get('values',payload);code=payload.get('record_id') or values.get('short_code') or hashlib.sha256(raw.encode()).hexdigest()[:12]
        values={k:v for k,v in values.items() if k not in {'record_id','table_id'}}
    elif kind=='EVENTS':
        m=re.match(r'([^\[：:|]+)(?:\[([^\]]*)\])?\s*[：:]\s*(.*)',parts[0],re.S)
        if not m:
            if len(parts)<3:raise EngineError('EVENT_INPUT','使用 e01[世界时间]：因果脊柱，或 e01 | 世界时间 | 因果脊柱')
            code,time,spine=parts[:3]
        else:code,time,spine=m[1].strip(),m[2] or '~',m[3]
        if len(parts)>1 and m:spine+=' | '+' | '.join(parts[1:])
        values={'short_code':code,'time_original_text':time,'spine_digest':spine,'source_entry_id':ctx.get('entry_id',''),'source_revision':ctx.get('revision',1),'source_hash':ctx.get('body_sha256','')}
        refs=re.search(r'(?:原文|依据)[:：]\s*(P\d+(?:\.\.P?\d+)?)',spine)
        if refs:values['source_paragraphs']=refs[1]
    elif kind=='ANCHORS':
        if len(parts)!=10:raise EngineError('ANCHOR_INPUT','十维锚点需要10列：ID|角色|源事件|动作|触发|防御|执念|软化条件|权重|演化',columns=len(parts))
        code,char,event,action,trigger,defense,motive,boundary,weight,evolution=parts
        try:weight=float(weight)
        except ValueError:raise EngineError('ANCHOR_WEIGHT','召回权重需要0..1数字')
        if not 0<=weight<=1:raise EngineError('ANCHOR_WEIGHT','召回权重需要0..1数字')
        if not any(f['key']=='recall_weight' for f in e.data['schema'][tid]['fields']):e.declare_field(tid,{'key':'recall_weight','label':'召回权重','type':'NUMBER'})
        values={'name':code,'char_ref':_ref(e,'T_CHAR_DOSSIER',char),'origin_event_ref':_ref(e,'T_DYN_EVENTS',event),'actions':action,'trigger_cues':trigger,'psychology':defense,'internal_motive':motive,'response_boundary':boundary,'recall_weight':weight,'validity':evolution}
    else:
        if len(parts)<5:raise EngineError('PACT_INPUT','使用 p01 | 双方(逗号/顿号分隔) | 内容 | 期限或代价 | 状态')
        code,parties,content,deadline,status=parts[:5];people=[p.strip() for p in re.split(r'[,，、/↔与]',parties) if p.strip()]
        if len(people)<2:raise EngineError('PACT_PARTIES','约定需要明确双方')
        values={'name':code,'party_a_ref':_entity(e,people[0]),'party_b_ref':_entity(e,people[1]),'content':content,'time_basis':deadline,'status':status}
        if len(people)>2:values['additional_parties']=[_entity(e,p) for p in people[2:]]
    scope=e.data['runtime'].get('scope',{});namespace='/'.join(str(scope.get(k,'')) for k in ['world_ref','session_ref','branch_ref'])
    rid=str(uuid.uuid5(uuid.NAMESPACE_URL,'tisya-business/'+namespace+'/'+tid+'/'+code))
    aliases=e.data['runtime'].setdefault('business_aliases',{});alias=tid+'|'+code
    if rid in e.rows(tid):
        # Updating existing append IDs is explicit, never silently overwrite a prior story fact.
        old=e.rows(tid)[rid]['values']
        if all(old.get(k)==v for k,v in values.items()):return {'table_id':tid,'record_id':rid,'short_code':code,'status':'REPLAY'}
        raise EngineError('BUSINESS_ID_CONFLICT','短号已用于其他内容，请使用新短号或显式改单元格',table=tid,short_code=code)
    if kind=='EVENTS' and ctx.get('entry_id'):
        values.update(source_entry_id=ctx['entry_id'],source_revision=ctx.get('revision',1),source_hash=ctx.get('body_sha256',''))
        if ctx.get('evidence'):values['source_paragraphs']=ctx['evidence']
    e.new_record(tid,values,rid);aliases[alias]=rid
    if ctx.get('source_key'):
        meta_id=str(uuid.uuid5(uuid.NAMESPACE_URL,tid+'#'+rid))
        if meta_id in e.rows('X_RECORD_META'):
            e.set(f'X_RECORD_META#{meta_id}.default_source_ref',ctx['source_key']+('#'+ctx['evidence'] if ctx.get('evidence') else ''))
            e.set(f'X_RECORD_META#{meta_id}.updated_turn_id',ctx.get('entry_id',''))

    return {'table_id':tid,'record_id':rid,'short_code':code,'values':values}


def preference(e,raw,ctx=None):
    from reply_memory import learn_preference
    from tisya_runtime import digest
    ctx=ctx or {};scope=e.data['runtime'].get('scope',{})
    if raw.startswith('{'):
        p=json.loads(raw);p.setdefault('alpha',0.2);p['confirmed']=False
        return learn_preference(e,operation_id='micro-pref:'+digest(p),**p)
    parts=[x.strip() for x in raw.replace('｜','|').split('|')];m=re.fullmatch(r'(.+?)\s*([+＋\-－]\s*\d+(?:\.\d+)?)',parts[0])
    if not m:raise EngineError('PREFERENCE_INPUT','使用 维度 +0.15 | 作用域 | 提示词')
    owner=scope.get('owner_ref')
    if not owner:raise EngineError('PREFERENCE_OWNER','先设置当前聊天owner_ref，避免替用户猜定偏好归属')
    dimension,delta=m[1].strip(),float(re.sub(r'\s+','',m[2]).replace('＋','+').replace('－','-'));label=parts[1] if len(parts)>1 else '本轮';directive=parts[2] if len(parts)>2 else dimension
    if label in {'本轮','turn','reroll_prefer','临时'}:chosen={'turn_ref':ctx.get('entry_id') or scope.get('turn_ref')}
    elif label in {'世界','world'}:chosen={'world_ref':scope.get('world_ref')}
    elif label in {'会话','session','聊天'}:chosen={k:scope.get(k) for k in ['world_ref','session_ref','branch_ref']}
    elif label in {'全局','global'}:chosen={}
    elif label.startswith(('角色:','角色：','subject:')):chosen={'subject_ref':label.split(label[2] if label.startswith('角色') else ':',1)[1]}
    else:raise EngineError('PREFERENCE_SCOPE','作用域不明确；使用 本轮/会话/世界/全局/角色:ID',scope=label)
    if any(v in (None,'') for v in chosen.values()):raise EngineError('PREFERENCE_SCOPE','作用域缺少当前标识',scope=chosen)
    old=0.5
    for r in e.rows('X_PREFERENCE_POLICIES').values():
        v=r['values']
        if v.get('owner_ref')==owner and v.get('dimension')==dimension and v.get('confirmed') is False and all(v.get(k)==n for k,n in chosen.items()):old=v.get('weight',0.5);break
    # Signed shorthand is a weight delta. Feed an inferred bounded observation to
    # EMA; report saturation rather than claiming the whole delta always applied.
    alpha=0.2;observation=min(1,max(0,old+delta/alpha));requested=min(1,max(0,old+delta))
    identity={'owner_ref':owner,'dimension':dimension,**chosen};rid=str(uuid.uuid5(uuid.NAMESPACE_URL,digest(identity|{'confirmation_lane':False})))
    if rid not in e.rows('X_PREFERENCE_POLICIES'):
        e.new_record('X_PREFERENCE_POLICIES',identity|{'weight':old,'alpha':alpha,'directive':directive,'confirmed':False},rid)
    result=learn_preference(e,owner,dimension,observation,alpha,directive,chosen,False,'micro-pref:'+digest([raw,ctx]));result.update(requested_delta=delta,applied_delta=result['weight']-old,requested_weight=requested)
    if abs(result['weight']-requested)>1e-9:
        result['warning']={'code':'PREFERENCE_EMA_SATURATED','message':'默认alpha=0.2下观测已钳制；实际增量见applied_delta'}
    return result
